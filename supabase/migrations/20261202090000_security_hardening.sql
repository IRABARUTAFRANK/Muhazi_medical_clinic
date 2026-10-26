-- Security hardening after the full audit of 26 October 2026 (independent review of every
-- table, view, policy and function; each finding reproduced before fixing).
--
--  1. The audit log's monthly partitions had no row-level security and the default table rights:
--     any signed-in staff member could read (whole patient rows are copied into before/after),
--     change, delete or forge audit rows. Partitions: no rights, RLS on (reading goes through the
--     parent table's policy); new partitions the same; no direct writes to audit_event at all;
--     log_access() is no longer callable from the API.
--  2. Views: no write rights for anyone through the API. public_payers and public_service_lines
--     could be written by visitors (the website key) and public_practitioners/public_booked_slots
--     by any staff member, because a simple view is updatable as its owner (skipping RLS).
--  3. Tables: the app writes only through the checked functions, so the API roles lose insert,
--     update, delete and truncate on every table (and on tables created later). This closes direct
--     edits that skipped the functions' rules (allergies cleared, a cash count's variance hidden,
--     a past prescription changed to gain access to the visit).
--  4. home_summary's results list: only what the reader may see (a doctor: the tests they asked
--     for; the manager; others: open orders they may read and visits they may see), HIV tests only
--     with sensitive.read. Before, every non-doctor role saw every recent result.
--  5. Read policies that ignored the privacy levels: bill lines and bills for the clinical roles,
--     nurse tasks, handover notes now follow visit_view().
--  6. visit_routing: the referral note only for clinical readers who may see the visit.
--  7. desk_orders: only for people who use that desk.
--  8. A prescription's author cannot be changed; "treated this visit" counts the prescriber.
--  9. A deactivated account, or one given a new PIN by the manager, loses its approved sign-ins at
--     once (the 0081 gate then refuses every request of the old sign-in).

-- 1. The audit log --------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as t
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'audit_event' and p.relnamespace = 'public'::regnamespace
  loop
    execute format('revoke all on %s from anon, authenticated', r.t);
    execute format('alter table %s enable row level security', r.t);
  end loop;
end
$$;
revoke insert, update, delete, truncate on audit_event from anon, authenticated;

create or replace function ensure_audit_partitions(p_months integer default 12)
returns void
language plpgsql
as $$
declare
  m date := date_trunc('month', now())::date;
  i integer;
  v_name text;
begin
  for i in 0 .. p_months - 1 loop
    v_name := 'audit_event_' || to_char(m + make_interval(months => i), 'YYYY_MM');
    execute format(
      'create table if not exists %I partition of audit_event for values from (%L) to (%L)',
      v_name,
      m + make_interval(months => i),
      m + make_interval(months => i + 1)
    );
    -- read only through the parent table's policy; never written from the API (security hardening)
    execute format('revoke all on %I from anon, authenticated', v_name);
    execute format('alter table %I enable row level security', v_name);
  end loop;
end
$$;

do $$
begin
  if to_regprocedure('log_access(text,uuid,audit_action,text)') is not null then
    execute 'revoke execute on function log_access(text, uuid, audit_action, text) from public, anon, authenticated';
  end if;
end
$$;

-- 2. Views: read only from the API -----------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', r.relname);
  end loop;
end
$$;

-- 3. Tables: written only through the checked functions -------------------------------------------
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;

-- 4. home_summary (from 20261126090000_departments_decide_desks): the results list follows the
--    privacy levels.
create or replace function home_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_practitioner uuid := (select id from practitioner where user_id = auth.uid() and active limit 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_appts jsonb;
  v_inquiries jsonb;
  v_mine jsonb;
  v_to_accept jsonb;
  v_bills jsonb;
  v_paid jsonb;
  v_beds jsonb;
  v_tasks jsonb;
  v_results jsonb;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- today's booked patients (reception, doctors)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'doctor', coalesce(pr.names, ''), 'station', coalesce(a.category, ''),
      'status', case when a.status in ('arrived', 'in_progress', 'completed') then 'arrived'
                     when a.starts_at < now() then 'late' else 'due' end,
      'mine', (a.practitioner_id = v_practitioner),
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.arrived_at desc limit 1)
    ) order by a.starts_at), '[]'::jsonb) into v_appts
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
    and (a.starts_at at time zone 'Africa/Kigali')::date between v_from and v_to;

  -- public inquiries waiting for reception
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
      'category', a.category, 'doctor', pr.names, 'channel', a.contact_channel,
      'when', case when a.starts_at is null then null else to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI') end,
      'note', a.reason
    ) order by a.created_at), '[]'::jsonb) into v_inquiries
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status = 'inquiry';

  -- approved bookings this practitioner still has to accept
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'when', to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI'), 'note', a.reason,
      'category', a.category, 'startsAt', a.starts_at
    ) order by a.starts_at), '[]'::jsonb) into v_to_accept
  from appointment a
  left join patient p on p.id = a.patient_id
  where a.deleted_at is null and a.status = 'approved' and a.practitioner_id = v_practitioner
    and a.starts_at > now() - interval '1 day';

  -- open bills: visits with something charged and a patient balance (cashier)
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', i.encounter_id, 'name', p.surname || ' ' || p.given_names, 'file', p.file_number,
      'ticket', (select ticket_no from queue_entry q where q.encounter_id = i.encounter_id order by q.created_at limit 1),
      'station', (select station from queue_entry q where q.encounter_id = i.encounter_id and q.finished_at is null order by q.created_at desc limit 1),
      'amount', i.patient_share, 'balance', invoice_balance(i.id), 'status', i.status
    ) order by i.updated_at desc), '[]'::jsonb) into v_bills
  from invoice i
  join encounter e on e.id = i.encounter_id
  join patient p on p.id = e.patient_id
  where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0;

  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0)) into v_paid
  from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to;

  -- beds
  select coalesce(jsonb_agg(jsonb_build_object(
      'n', b.sort_order, 'name', b.name, 'state', b.status,
      'who', (select p.surname || ' ' || left(p.given_names, 1) || '.' from bed_stay s join encounter e on e.id = s.encounter_id join patient p on p.id = e.patient_id
              where s.bed_id = b.id and s.discharged_at is null limit 1)
    ) order by b.sort_order, b.name), '[]'::jsonb) into v_beds
  from bed b where b.deleted_at is null;

  -- tasks for my role or me
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'time', to_char(k.due_at at time zone 'Africa/Kigali', 'HH24:MI'), 'title', k.title,
      'detail', coalesce(k.detail, ''), 'overdue', (k.due_at < now()),
      'patient', (select p.surname || ' ' || p.given_names from patient p where p.id = k.patient_id)
    ) order by k.due_at), '[]'::jsonb) into v_tasks
  from internal_task k
  where k.deleted_at is null and k.done_at is null and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role));

  -- lab / imaging results of the last two days: a doctor's own requests; the manager; others only
  -- results of visits they may see (privacy levels); HIV tests only with sensitive.read
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'encounterId', sr.encounter_id, 'test', s.name_en,
      'name', p.surname || ' ' || p.given_names, 'impression', coalesce(r.impression, r.findings, ''),
      'verified', (r.verified_at is not null), 'at', to_char(r.updated_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'reviewed', (r.reviewed_at is not null), 'corrected', (r.corrected_at is not null)
    ) order by (r.reviewed_at is null) desc, r.updated_at desc), '[]'::jsonb) into v_results
  from diagnostic_report r
  join service_request sr on sr.id = r.service_request_id
  join service s on s.id = sr.service_id
  join encounter e on e.id = sr.encounter_id
  join patient p on p.id = e.patient_id
  where r.deleted_at is null
    and (r.updated_at > now() - interval '2 days' or (r.reviewed_at is null and r.updated_at > now() - interval '7 days'))
    and (
      -- after a handover the results follow the patient to the colleague who took them
      (v_role = 'doctor' and result_recipient(sr.encounter_id, sr.requester_id) = auth.uid())
      or is_manager()
      or (v_role is distinct from 'doctor' and has_perm('orders.read')
          and visit_view(sr.encounter_id) is not null)
    )
    and (has_perm('sensitive.read')
         or not (coalesce(s.name_en, '') ilike '%hiv%' or coalesce(s.code, '') ilike '%hiv%'));

  return jsonb_build_object(
    'role', v_role,
    -- the patients this person took and finished today (a doctor's "Seen")
    'seenToday', (select count(distinct q.encounter_id) from queue_entry q
                  where q.taken_by = auth.uid() and q.deleted_at is null and q.finished_at is not null
                    and (q.finished_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'appointments', v_appts,
    'inquiries', v_inquiries,
    'toAccept', v_to_accept,
    'openBills', v_bills,
    'paidToday', v_paid,
    'beds', v_beds,
    'tasks', v_tasks,
    'results', v_results
  );
end
$$;

-- 5. Read policies that follow the privacy levels ---------------------------------------------------
drop policy if exists invoice_line_select_clinical on invoice_line;
create policy invoice_line_select_clinical on invoice_line for select to authenticated
  using (has_perm('charge.write')
         and exists (select 1 from invoice i where i.id = invoice_line.invoice_id
                     and visit_view(i.encounter_id) is not null));
drop policy if exists invoice_select_clinical on invoice;
create policy invoice_select_clinical on invoice for select to authenticated
  using (has_perm('charge.write') and visit_view(encounter_id) is not null);

drop policy if exists internal_task_select on internal_task;
create policy internal_task_select on internal_task for select to authenticated
  using (has_perm('queue.read')
         and (encounter_id is null or assigned_to = auth.uid() or task_for_me(assigned_role)
              or visit_view(encounter_id) is not null));

drop policy if exists patient_handover_read on patient_handover;
create policy patient_handover_read on patient_handover for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid() or is_manager()
         or visit_view(encounter_id) is not null);

-- 6. visit_routing (from 20261102120000_desks_connected): the referral note is clinical
create or replace function visit_routing(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'queueId', q.id, 'station', q.station, 'since', q.created_at,
      'assignedTo', q.assigned_to, 'assignedName', a.full_name,
      'referredBy', q.referred_by, 'referredName', r.full_name,
      'note', case when has_perm('clinical.read') and visit_view(q.encounter_id) is not null
                   then q.referral_note end,
      'returnStation', q.return_station, 'returnTo', q.return_to, 'returnName', b.full_name,
      'takenBy', q.taken_by, 'takenName', t.full_name, 'canWork', queue_entry_for_me(q.id)
    ) order by q.created_at), '[]'::jsonb)
  from queue_entry q
  left join profiles a on a.id = q.assigned_to
  left join profiles r on r.id = q.referred_by
  left join profiles b on b.id = q.return_to
  left join profiles t on t.id = q.taken_by
  where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
    and has_perm('queue.read')
$$;

-- 7. desk_orders (from 20261125090000_document_details): only for people who use that desk
create or replace function desk_orders(p_station station)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.station = p_station and p_station not in ('laboratory', 'ultrasound')
      and r.status not in ('verified', 'cancelled')
      and (has_perm('clinical.read') or has_perm('orders.read'))
      and (is_manager() or may_use_any_desk(station_desks(p_station)))
  ) x
$$;

-- 8. A prescription's author stays; "treated this visit" counts the prescriber -----------------------
create or replace function guard_medication_request()
returns trigger
language plpgsql
as $$
begin
  -- the checked (security definer) functions run as their owner, not as the API roles
  if current_user::text not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    raise exception 'prescriptions are written with the prescription form only' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a prescription is not deleted: the doctor cancels it' using errcode = '42501';
  end if;
  if new.given_at is distinct from old.given_at or new.given_by is distinct from old.given_by
     or new.not_given_at is distinct from old.not_given_at or new.not_given_by is distinct from old.not_given_by
     or new.not_given_reason is distinct from old.not_given_reason
     or new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason
     or new.supply is distinct from old.supply or new.quantity is distinct from old.quantity
     or new.item_id is distinct from old.item_id or new.encounter_id is distinct from old.encounter_id
     or new.prescriber_id is distinct from old.prescriber_id or new.deleted_at is distinct from old.deleted_at
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'handing over, not given, cancelling and the medicine or quantity change only through the pharmacy and prescription screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function treated(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user is not null and (
    exists (select 1 from queue_entry q
            where q.encounter_id = p_encounter_id and q.deleted_at is null and q.taken_by = p_user
              and station_desks(q.station) && treating_desks())
    or exists (select 1 from condition c
               where c.encounter_id = p_encounter_id and c.deleted_at is null and c.created_by = p_user)
    or exists (select 1 from observation o
               where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code = 'note'
                 and coalesce(o.performer_id, o.created_by) = p_user)
    or exists (select 1 from medication_request m
               where m.encounter_id = p_encounter_id and m.deleted_at is null
                 and (m.prescriber_id = p_user or (m.prescriber_id is null and m.created_by = p_user)))
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.requester_id = p_user)
    or exists (select 1 from service_request r
               join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
               where r.encounter_id = p_encounter_id and r.category = 'imaging'
                 and (d.created_by = p_user or d.verified_by = p_user))
    or exists (select 1 from procedure pr
               where pr.encounter_id = p_encounter_id and pr.deleted_at is null and pr.performer_id = p_user)
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.answered_by = p_user
                 and c.status in ('accepted', 'done'))
  )
$$;

-- 9. Deactivated, or given a new PIN: the approved sign-ins end at once -----------------------------
create or replace function end_sign_ins_on_account_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (old.active and not new.active)
     or (new.must_change_pin and not coalesce(old.must_change_pin, false)) then
    update approved_session
       set ended_at = now(),
           ended_reason = case when not new.active then 'deactivated' else 'new PIN' end
     where user_id = new.id and ended_at is null;
  end if;
  return new;
end
$$;
revoke all on function end_sign_ins_on_account_change() from public, anon, authenticated;
drop trigger if exists end_sign_ins_on_account_change on profiles;
create trigger end_sign_ins_on_account_change
  after update of active, must_change_pin on profiles
  for each row execute function end_sign_ins_on_account_change();

-- 10. A visit that ends without the cashier's settle step still posts its bill (number, and the
--     insurer's claim). Before, finish_visit with nothing left to pay and end_visit ("left without
--     paying") closed the visit with the bill still a draft: no invoice number, no claim.
create or replace function post_drafts_of_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in
    select i.id from invoice i
    where i.encounter_id = p_encounter_id and i.status = 'draft' and i.deleted_at is null
      and exists (select 1 from invoice_line l where l.invoice_id = i.id and l.deleted_at is null)
  loop
    perform post_invoice_now(v_id);
  end loop;
end
$$;
revoke all on function post_drafts_of_visit(uuid) from public, anon, authenticated;

-- finish_visit (from 20261115090000_medicines_list_pharmacy) + the bill posted when the visit closes
create or replace function finish_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_rx boolean;
  v_due boolean;
  v_ticket text;
  v_next station;
  v_keep queue_entry%rowtype;
begin
  perform assert_may_work_on(p_encounter_id);
  v_rx := exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m));
  v_next := case when v_rx then 'pharmacy' else 'cashier' end;
  -- the patient already waits there (the doctor sent them on before finishing): keep that place
  select * into v_keep from queue_entry
  where encounter_id = p_encounter_id and station = v_next and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  perform close_encounter(p_encounter_id);
  v_due := exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0);
  if v_rx or v_due then
    -- Treatment is over; the visit stays open until the medicines are handed over and the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    if v_keep.id is not null then
      update queue_entry set finished_at = null,
             referral_note = coalesce(referral_note, case when v_rx then 'Medicines to hand over' end)
      where id = v_keep.id
      returning * into v_keep;
      perform notify_queue_entry_row(v_keep);
      return;
    end if;
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    -- medicines first (their price joins the bill), then the cashier
    if v_rx then
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'pharmacy', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines to hand over');
    else
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'));
    end if;
  else
    -- nothing left to hand over or to pay: the visit is closed, its bill posted (insurer's claim)
    perform post_drafts_of_visit(p_encounter_id);
  end if;
end
$$;

-- end_visit (from 20261106090000_desks_wave8) + the bill posted when the visit closes
create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    if current_role_key() <> 'manager' then
      raise exception 'money is still due (% RWF): take the payment first, or ask the manager', round(v_due)
        using errcode = '23514';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'money is still due (% RWF): say why the patient left without paying', round(v_due)
        using errcode = '22023';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  -- the bill gets its number and the insurer's claim; what the patient owes stays on the unpaid list
  perform post_drafts_of_visit(p_encounter_id);
  return jsonb_build_object('due', v_due);
end
$$;

-- 11. visit_access (from 20261129090000_handover): the handover note only for the two colleagues
--     and clinicians who may see this visit
create or replace function visit_access(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'canWork', may_work_on(p_encounter_id),
    'canRoute', may_route(p_encounter_id),
    'holder', patient_holder(p_encounter_id),
    'helping', exists (select 1 from staff_call c
                       where c.encounter_id = p_encounter_id and c.kind = 'help'
                         and c.status = 'accepted' and c.answered_by = auth.uid()),
    'help', coalesce((
      select jsonb_agg(jsonb_build_object(
               'callId', c.id, 'status', c.status, 'asker', a.full_name,
               'helper', coalesce(h.full_name, t.full_name), 'mine', c.from_user = auth.uid(),
               'helperIsMe', c.answered_by = auth.uid(),
               'note', c.note) order by c.created_at)
      from staff_call c
      join profiles a on a.id = c.from_user
      left join profiles h on h.id = c.answered_by
      left join profiles t on t.id = c.to_user
      where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status in ('open', 'accepted')), '[]'::jsonb),
    -- 0088: I have the patient at a treating desk and may hand them over
    'canHandOver', handover_held_queue(p_encounter_id, auth.uid()) is not null and has_perm('clinical.write'),
    -- 0088: the handover waiting for an answer on this visit (to me, from me, or clinicians who
    -- may see this visit: the note is clinical)
    'handover', (
      select handover_json(h) || jsonb_build_object('mine', h.from_user = auth.uid(), 'forMe', h.to_user = auth.uid())
      from patient_handover h
      where h.encounter_id = p_encounter_id and h.status = 'pending' and h.deleted_at is null
        and (h.from_user = auth.uid() or h.to_user = auth.uid()
             or (has_perm('clinical.read') and visit_view(p_encounter_id) is not null))
      order by h.created_at desc limit 1)
  )
  where exists (select 1 from profiles where id = auth.uid() and active)
$$;

-- 12. A medicine returned on a bill not yet posted but already paid: the cashier is told there is money to give back.
-- (from 20261126090000_departments_decide_desks)
create or replace function return_medicine(p_medication_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_d medication_dispense%rowtype;
  v_inv invoice%rowtype;
  v_mv record;
  v_back integer := 0;
  v_patient numeric := 0;
  v_insurer numeric := 0;
  v_total numeric := 0;
  v_lines jsonb;
  v_cn uuid;
  v_year integer := extract(year from now())::integer;
  v_balance numeric;
  v_name text;
  v_item text;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine comes back' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  select * into v_d from medication_dispense
  where medication_request_id = v_m.id and deleted_at is null order by created_at desc limit 1;
  if not found then
    raise exception 'this medicine was not handed over by the pharmacy' using errcode = 'P0002';
  end if;
  if not is_manager()
     and (v_d.created_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
    raise exception 'a hand-over of another day is undone by the manager' using errcode = '42501';
  end if;
  select * into v_inv from invoice where encounter_id = v_m.encounter_id;
  -- On a posted bill the return is money (a credit note, a smaller insurer claim): the person's
  -- own right, which a department or cover never gives.
  if v_inv.id is not null and v_inv.status <> 'draft'
     and not (is_manager() or staff_perm(auth.uid(), 'stock.dispense') or has_perm('billing.write')) then
    raise exception 'a medicine on a posted bill is taken back by the pharmacist or the manager'
      using errcode = '42501';
  end if;
  -- the units go back where they came from
  for v_mv in
    select item_id, batch_id, from_location_id, quantity from stock_movement
    where dispense_id = v_d.id and type = 'dispense' and deleted_at is null
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, dispense_id, medication_request_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return', trim(p_reason), v_d.id, v_m.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  update medication_dispense set deleted_at = now() where id = v_d.id;

  if v_inv.id is null or v_inv.status = 'draft' then
    -- the bill is still open: the line leaves it, and the medicine waits at the pharmacy again
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
    where source_type = 'medication_dispense' and source_id = v_d.id and deleted_at is null;
    if v_inv.id is not null then
      perform recompute_invoice(v_inv.id);
    end if;
    update medication_request set given_at = null, given_by = null where id = v_m.id;
    if exists (select 1 from encounter where id = v_m.encounter_id and status = 'open')
       and not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                       and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (v_m.encounter_id, 'pharmacy',
              (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
    end if;
    v_balance := case when v_inv.id is not null then invoice_balance(v_inv.id) else 0 end;
    if v_balance < 0 then
      -- the bill was already paid: money to give back, the cashier is told
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
      insert into notification (kind, params, link, recipient_stations, created_by)
      values ('refund_due', jsonb_build_object('name', v_name, 'item', v_item, 'amount', -v_balance,
                                               'reason', trim(p_reason)),
              '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
    end if;
    return jsonb_build_object('units', v_back, 'mode', 'bill', 'creditNoteId', null, 'credit', 0,
                              'balance', v_balance);
  end if;

  -- The bill is posted: its lines never change. A credit note gives the line back: the patient's
  -- share lowers what they owe (or is money to give back at the cashier); the insurer's share
  -- leaves an open claim.
  select coalesce(sum(l.patient_share), 0), coalesce(sum(l.insurer_share), 0),
         coalesce(sum(round(l.unit_price * l.quantity)), 0),
         coalesce(jsonb_agg(jsonb_build_object('lineId', l.id, 'description', l.description, 'quantity', l.quantity,
                                               'unitPrice', l.unit_price, 'patientShare', l.patient_share,
                                               'insurerShare', l.insurer_share)), '[]'::jsonb)
  into v_patient, v_insurer, v_total, v_lines
  from invoice_line l
  where l.invoice_id = v_inv.id and l.source_type = 'medication_dispense' and l.source_id = v_d.id
    and l.deleted_at is null;
  if v_total > 0 then
    insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                             source_type, source_id)
    values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
            v_lines, v_total, 'returned: ' || trim(p_reason), auth.uid(), v_patient, v_insurer,
            'medication_dispense', v_d.id)
    returning id into v_cn;
    if v_insurer > 0 then
      update claim set amount = greatest(0, amount - v_insurer)
      where invoice_id = v_inv.id and status = 'open' and batch_id is null;
    end if;
  end if;
  -- the line is done: returned (it does not wait at the pharmacy again)
  update medication_request
  set given_at = null, given_by = null, not_given_at = now(), not_given_by = auth.uid(),
      not_given_reason = 'returned: ' || trim(p_reason)
  where id = v_m.id;
  v_balance := invoice_balance(v_inv.id);
  if v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', v_item, 'amount', -v_balance,
                                             'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
  end if;
  return jsonb_build_object('units', v_back, 'mode', 'credit', 'creditNoteId', v_cn, 'credit', v_patient,
                            'balance', v_balance);
end
$$;

-- 13. Putting back a medicine given here on a paid, not yet posted bill: the cashier is told too.
-- (from 20261124090000_stores_and_stock)
create or replace function undo_given_here(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_inv invoice%rowtype;
  v_mv record;
  v_back integer := 0;
  v_patient numeric := 0;
  v_insurer numeric := 0;
  v_total numeric := 0;
  v_lines jsonb;
  v_cn uuid;
  v_year integer := extract(year from now())::integer;
  v_balance numeric;
  v_mode text := 'bill';
  v_name text;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is put back' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.not_given_at is not null or v_m.cancelled_at is not null then
    raise exception 'this medicine was already put back' using errcode = '23505';
  end if;
  if v_m.supply <> 'room' or v_m.given_at is null then
    raise exception 'only a medicine given here is put back here' using errcode = '22023';
  end if;
  if not is_manager() then
    if v_m.given_by is distinct from auth.uid() then
      raise exception 'only the person who gave it (or the manager) puts it back' using errcode = '42501';
    end if;
    if (v_m.given_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
      raise exception 'a medicine given on another day is put back by the manager' using errcode = '42501';
    end if;
  end if;
  -- the units go back into the store they came from
  for v_mv in
    select item_id, batch_id, from_location_id, sum(quantity)::integer as quantity from stock_movement
    where medication_request_id = v_m.id and type = 'consumption' and from_location_id is not null and deleted_at is null
    group by item_id, batch_id, from_location_id
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, medication_request_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return',
            'put back: ' || trim(p_reason), v_m.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  select * into v_inv from invoice where encounter_id = v_m.encounter_id;
  if v_inv.id is null or v_inv.status = 'draft' then
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
    where source_type = 'medication_request' and source_id = v_m.id and deleted_at is null;
    if v_inv.id is not null then
      perform recompute_invoice(v_inv.id);
    end if;
  else
    v_mode := 'credit';
    select coalesce(sum(l.patient_share), 0), coalesce(sum(l.insurer_share), 0),
           coalesce(sum(round(l.unit_price * l.quantity)), 0),
           coalesce(jsonb_agg(jsonb_build_object('lineId', l.id, 'description', l.description, 'quantity', l.quantity,
                                                 'unitPrice', l.unit_price, 'patientShare', l.patient_share,
                                                 'insurerShare', l.insurer_share)), '[]'::jsonb)
    into v_patient, v_insurer, v_total, v_lines
    from invoice_line l
    where l.invoice_id = v_inv.id and l.source_type = 'medication_request' and l.source_id = v_m.id
      and l.deleted_at is null;
    if v_total > 0 then
      insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                               source_type, source_id)
      values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
              v_lines, v_total, 'returned: ' || trim(p_reason), auth.uid(), v_patient, v_insurer,
              'medication_request', v_m.id)
      returning id into v_cn;
      if v_insurer > 0 then
        update claim set amount = greatest(0, amount - v_insurer)
        where invoice_id = v_inv.id and status = 'open' and batch_id is null;
      end if;
    end if;
  end if;
  update medication_request
  set given_at = null, given_by = null, not_given_at = now(), not_given_by = auth.uid(),
      not_given_reason = 'returned: ' || trim(p_reason)
  where id = v_m.id;
  v_balance := case when v_inv.id is not null then invoice_balance(v_inv.id) else 0 end;
  if v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', item_label(v_m.item_id), 'amount', -v_balance,
                                             'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
  end if;
  return jsonb_build_object('units', v_back, 'mode', v_mode, 'creditNoteId', v_cn,
                            'credit', case when v_mode = 'credit' then v_patient else 0 end, 'balance', v_balance);
end
$$;

-- 14. After a handover the colleague who took the patient may cancel a medicine still waiting at the pharmacy.
-- (from 20261126090000_departments_decide_desks)
create or replace function cancel_prescription(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is cancelled' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if not (is_manager()
          or (has_perm('clinical.write')
              and (coalesce(v_m.prescriber_id, v_m.created_by) = auth.uid()
                   -- the patient was handed over: the colleague who took them now decides
                   or (may_work_on(v_m.encounter_id)
                       and result_recipient(v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by)) = auth.uid())))) then
    raise exception 'only the doctor treating the patient (or the manager) can cancel it' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  if not rx_pending(v_m) then
    raise exception 'this medicine is no longer waiting at the pharmacy (handed over, not given or cancelled)'
      using errcode = 'P0002';
  end if;
  update medication_request
  set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_m.id;
  -- the pharmacy is told the line left its list
  select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('rx_cancelled',
          jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                             'by', (select full_name from profiles where id = auth.uid())),
          '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
  -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
  perform after_pharmacy(v_m.encounter_id);
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'pending', v_left,
                            'balance', invoice_balance((select id from invoice where encounter_id = v_m.encounter_id)));
end
$$;

-- 15. "My orders" follows a handed-over patient to the colleague who took them.
-- (from 20261119090000_audit_fixes)
create or replace function my_orders(p_days integer default 7, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select r.created_at as at, jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'test', s.name_en,
      'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      'status', r.status, 'priority', r.priority, 'reason', r.reason, 'orderedAt', r.created_at,
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'visitOpen', e.status = 'open') as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and result_recipient(r.encounter_id, r.requester_id) = auth.uid()
      and case when p_from is not null
            then (r.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)
            else r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) end
    order by r.created_at desc
    limit 500
  ) x
$$;

-- 16. The head's department dashboard: the desks come from the department's services (as everywhere since 0085), by role only for a department without services.
-- (from 20261127090000_analytics)
create or replace function department_summary(p_department_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_dept department%rowtype;
  v_days integer := greatest(1, p_to - p_from + 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
  v_stations station[];
  v_members jsonb;
  v_queue jsonb;
  v_tiles jsonb;
  v_services jsonb;
begin
  if not (is_manager() or exists (
    select 1 from staff_department sd join profiles p on p.id = sd.profile_id
    where sd.profile_id = auth.uid() and sd.department_id = p_department_id
      and sd.position in ('head', 'assistant') and p.active)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_dept from department where id = p_department_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(s), '{}') into v_stations
  from unnest(enum_range(null::station)) s
  where (cardinality(coalesce(v_dept.services, '{}')) > 0 and station_desks(s) && v_dept.services)
     or (cardinality(coalesce(v_dept.services, '{}')) = 0 and station_role(s) = any (v_dept.roles));

  -- the people of the department and what each did in the period
  with ev as (
    select ev.user_id, ev.kind
    from analytics_staff_events(p_from::timestamp at time zone 'Africa/Kigali',
                                (p_to + 1)::timestamp at time zone 'Africa/Kigali', false) ev
    where ev.user_id in (select sd.profile_id from staff_department sd where sd.department_id = p_department_id)
      and ev.kind in ('patientsSeen', 'registered', 'vitals', 'results', 'medicinesGiven', 'tasksDone')
  ),
  a as (
    select ev.user_id,
           count(*) filter (where kind = 'patientsSeen') as patients,
           count(*) filter (where kind = 'registered') as registrations,
           count(*) filter (where kind = 'vitals') as vitals,
           count(*) filter (where kind = 'results') as results,
           count(*) filter (where kind = 'medicinesGiven') as dispensed,
           count(*) filter (where kind = 'tasksDone') as tasks_done
    from ev group by ev.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'position', sd.position, 'station', p.station,
      'lastSignIn', p.last_sign_in_at, 'active', p.active,
      'patients', coalesce(a.patients, 0),
      'registrations', coalesce(a.registrations, 0),
      'vitals', coalesce(a.vitals, 0),
      'results', coalesce(a.results, 0),
      'dispensed', coalesce(a.dispensed, 0),
      'payments', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = p.id
                   and (y.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'tasksDone', coalesce(a.tasks_done, 0),
      'busyNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.taken_by = p.id and q.deleted_at is null and q.finished_at is null and e.status = 'open')
    ) order by case sd.position when 'head' then 0 when 'assistant' then 1 else 2 end, p.full_name), '[]'::jsonb)
  into v_members
  from staff_department sd join profiles p on p.id = sd.profile_id
  left join a on a.user_id = p.id
  where sd.department_id = p_department_id;

  -- the department's desks right now
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'longest', w.longest, 'forgotten', w.forgotten) order by w.station), '[]'::jsonb)
  into v_queue
  from queue_now(v_stations) w;

  select jsonb_build_object(
    'patients', (select count(distinct q.encounter_id) from queue_entry q
                 where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                   and (q.finished_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'patientsPrev', (select count(distinct q.encounter_id) from queue_entry q
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                       and (q.finished_at at time zone 'Africa/Kigali')::date between p_from - v_days and p_from - 1),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                     and q.started_at is null and e.status = 'open' and q.created_at >= v_midnight),
    'forgottenNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                       and q.started_at is null and e.status = 'open' and q.created_at < v_midnight),
    'ordersOpen', (select count(*) from service_request r join encounter e on e.id = r.encounter_id
                   where r.deleted_at is null and e.status = 'open'
                     and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = any (v_stations)
                     and r.status not in ('resulted', 'verified', 'cancelled')),
    'ordersNotDone', (select count(*) from service_request r
                      where r.deleted_at is null and r.status = 'cancelled'
                        and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = any (v_stations)
                        and (r.updated_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'tasksOpen', (select count(*) from internal_task k join encounter e on e.id = k.encounter_id
                  where k.deleted_at is null and k.done_at is null and e.status = 'open'
                    and k.assigned_role = any (v_dept.roles)),
    'members', jsonb_array_length(v_members),
    'signedInToday', (select count(*) from staff_department sd join profiles p on p.id = sd.profile_id
                      where sd.department_id = p_department_id
                        and (p.last_sign_in_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_tiles;

  -- the department's treatments done in the period (count only)
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n) order by x.n desc), '[]'::jsonb) into v_services
  from (
    select l.description as name, count(*) as n
    from invoice_line l
    join service_department sv on sv.service_id = l.service_id and sv.department_id = p_department_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description order by count(*) desc limit 10
  ) x;

  return jsonb_build_object('department', jsonb_build_object('id', v_dept.id, 'name', v_dept.name, 'roles', v_dept.roles),
                            'stations', to_jsonb(v_stations), 'tiles', v_tiles, 'members', v_members,
                            'queue', v_queue, 'services', v_services);
end
$$;

-- 17. Sending a patient to a department: the department must give that desk (its services), by role only for a department without services.
-- (from 20261126090000_departments_decide_desks)
create or replace function begin_visit(
  p_patient_id uuid,
  p_station station default 'consultation',
  p_department_id uuid default null,
  p_note text default null,
  p_myself boolean default false,
  p_emergency boolean default false,
  p_service text default null,
  p_assigned_to uuid default null,
  p_triage_to uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_desk station := coalesce(case when not p_myself then service_station(p_service) end, p_station);
  v_station station;
  v_enc uuid;
  v_q queue_entry%rowtype;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  -- A visit is started at reception. "I take the patient myself" is decided below (the person's
  -- own desk); an emergency by the people who treat, wherever reception is given.
  if not (p_myself or p_emergency) then
    perform assert_desk(array['reception'], 'starting visits');
  elsif p_emergency and not p_myself then
    perform assert_desk(array['reception', 'triage'] || treating_desks(), 'emergency visits');
  end if;
  if p_emergency and v_role in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if p_service is not null and service_station(p_service) is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  if p_myself and not (
       v_role = 'manager'
       or (v_role = 'doctor' and v_desk in ('consultation', 'dental', 'theatre', 'ultrasound'))
       or (v_role = 'nurse' and v_desk in ('triage', 'nursing', 'beds'))
       or (v_role = 'lab_tech' and v_desk = 'laboratory')
       or (v_role = 'sonographer' and v_desk = 'ultrasound')
       or (v_role = 'pharmacist' and v_desk = 'pharmacy')
       -- or a department of theirs gives that desk (a nurse of the Laboratory …)
       or exists (select 1 from unnest(station_desks(v_desk)) as d(desk)
                  where in_desk_department(auth.uid(), d.desk) and may_use_desk(d.desk))) then
    raise exception 'you do not work at % : send the patient there instead', initcap(v_desk::text)
      using errcode = '42501';
  end if;
  if p_assigned_to is not null and (p_service is null or not staff_serves(p_assigned_to, p_service)) then
    raise exception 'that person does not give this service' using errcode = '22023';
  end if;
  if p_triage_to is not null and not staff_serves(p_triage_to, 'triage') then
    raise exception 'that person does not work at triage' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (
       select 1 from department d where d.id = p_department_id and d.deleted_at is null
         and ((cardinality(coalesce(d.services, '{}')) > 0 and station_desks(v_desk) && d.services)
              or (cardinality(coalesce(d.services, '{}')) = 0 and station_role(v_desk) = any (d.roles)))) then
    raise exception 'that department does not work at %', initcap(v_desk::text) using errcode = '22023';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;

  v_station := case
    when p_myself or p_emergency then v_desk
    when triage_first() then 'triage'::station
    else v_desk end;
  perform set_config('mmc.visit_open', 'on', true);
  v_enc := open_encounter(p_patient_id, 'opd', v_station);
  perform set_config('mmc.visit_open', '', true);
  -- the service and the person chosen stay with the visit (used after triage)
  update encounter
  set service = p_service, intended_to = case when p_myself then auth.uid() else p_assigned_to end,
      practitioner_id = case
        when p_assigned_to is not null and exists (select 1 from profiles where id = p_assigned_to and role = 'doctor')
        then ensure_practitioner(p_assigned_to) else practitioner_id end
  where id = v_enc;

  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || v_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;

  select * into v_q from queue_entry
  where encounter_id = v_enc and station = v_station and finished_at is null and deleted_at is null
  order by created_at limit 1;
  update queue_entry
  set referral_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), referral_note),
      service = p_service,
      department_id = case when v_station = v_desk and p_assigned_to is null then coalesce(p_department_id, department_id) else department_id end,
      assigned_to = case
        when v_station = 'triage' and not p_myself then coalesce(p_triage_to, assigned_to)
        when v_station = v_desk and not p_myself then coalesce(p_assigned_to, assigned_to)
        else assigned_to end,
      referred_by = auth.uid()
  where id = v_q.id
  returning * into v_q;
  if p_myself then
    perform take_patient(v_q.id);
    delete from notification where kind = 'queue' and params ->> 'queue' = v_q.id::text;
  elsif v_q.assigned_to is not null then
    -- the person chosen is told (instead of everyone at the desk)
    perform notify_queue_entry_row(v_q);
  end if;

  return jsonb_build_object(
    'encounter_id', v_enc,
    'ticket_no', v_q.ticket_no,
    'station', v_station,
    'myself', p_myself,
    'assigned', (select full_name from profiles where id = v_q.assigned_to),
    'department', (select name from department where id = p_department_id));
end
$$;
