-- Fixes found while writing the system guide (26 October 2026): the rules the screens relied on
-- but the database did not enforce, and a few leaks.
--
--  1. staff_login_email gave anyone the e-mail of a staff member from the staff ID and username
--     alone (the lookup was callable by visitors). It now needs the PIN too, checked against the
--     Auth password hash, with the same limit as staff-otp (5 wrong PINs in 15 minutes).
--  2. home_summary listed the open bills (names, balances) to every role: now only for the people
--     who take payments, and the manager.
--  3. HIV tests were hidden only in the home results inbox: now also in visit_clinical's test list
--     for readers without sensitive.read, and in the laboratory worklist for anyone who has neither
--     that right nor the desk that runs the test (the laboratory and ultrasound staff keep their
--     work); add_diagnosis refuses an HIV code (ICD-10 B20–B24) to people without the right.
--  4. dashboard_summary showed a head of department "Who did what" and the sign-ins of the whole
--     clinic: now their own department's people only (the manager still sees everyone).
--  5. A second PIN reset while the first was still pending left the old sign-ins alive: every new
--     temporary PIN ends them; a manager cannot give themself a temporary PIN.
--  6. decline_appointment did not check the calendar's owner (accept_appointment did).
--  7. mark_result_reviewed let any clinician mark any result seen: now the requester, the colleague
--     who took the patient over, or the manager.
--  8. record_vitals accepts the same limits as the form (an impossible value is a typing mistake).
--  9. merge_patients also moves the duplicate's files and record-access rows; the two patient
--     searches find a patient by a file number recorded at a merge.
-- 10. The "file added to a test" notice follows the patient to the colleague who took them over.
-- 11. patient_file tells the edit form which private extra fields already have a value
--     (`extra_filled`), so an empty one can be filled and a filled one locked.
-- (The beds limit stays at 200; set_bed_count already refuses with errcode 22023.)

-- 1. The sign-in e-mail lookup needs the PIN ------------------------------------------------------
-- The PIN is the Supabase Auth password; its bcrypt hash is compared here (pgcrypto's crypt, which
-- lives in the extensions schema on Supabase). A wrong PIN is written to the audit log like the
-- ones staff-otp and the lock screen record, so the three share one limit.
drop function if exists staff_login_email(text, text);
create or replace function staff_login_email(p_staff_id text, p_username text, p_pin text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_email text;
  v_hash text;
begin
  select p.id, p.email into v_id, v_email
  from profiles p
  where p.staff_id = upper(trim(p_staff_id)) and p.username = lower(trim(p_username)) and p.active;
  if not found or coalesce(p_pin, '') !~ '^[0-9]{6}$' then
    return null;
  end if;
  -- too many wrong PINs lately: no answer, so the PIN cannot be guessed here either
  if (select count(*) from audit_event a
      where a.actor_id = v_id and a.action = 'login' and a.reason like 'wrong PIN%'
        and a.at > now() - interval '15 minutes') >= 5 then
    return null;
  end if;
  select u.encrypted_password into v_hash from auth.users u where u.id = v_id;
  if v_hash is null or v_hash not like '$2%' or crypt(p_pin, v_hash) <> v_hash then
    insert into audit_event (actor_id, action, entity, entity_id, reason)
    values (v_id, 'login', 'profiles', v_id, 'wrong PIN (lookup)');
    return null;
  end if;
  return v_email;
end
$$;
revoke all on function staff_login_email(text, text, text) from public;
grant execute on function staff_login_email(text, text, text) to anon, authenticated;

-- 2. Open bills only for the people who take payments ---------------------------------------------
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
  v_bills jsonb := '[]'::jsonb;
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

  -- open bills: visits with something charged and a patient balance, for the people who take
  -- payments and the manager (the other roles have no business with names and balances)
  if has_perm('payment.take') or is_manager() then
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
  end if;

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
    and (has_perm('sensitive.read') or not sensitive_service(s.id));

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

-- 3. HIV tests and diagnoses only for the people allowed to see them ------------------------------
-- The one rule the home inbox used (name or code says HIV), for every list.
create or replace function sensitive_service(p_service_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from service s
    where s.id = p_service_id
      and (coalesce(s.name_en, '') ilike '%hiv%' or coalesce(s.code, '') ilike '%hiv%')
  )
$$;
revoke all on function sensitive_service(uuid) from public, anon, authenticated;

create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_view text;
  v_patient uuid;
  v_closed boolean;
  v_safe boolean;
begin
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  if not clinical_reader() then
    return null;
  end if;
  select e.patient_id, e.status = 'closed' into v_patient, v_closed
  from encounter e where e.id = p_encounter_id and e.deleted_at is null;
  if v_patient is null then
    return null;
  end if;
  v_view := visit_view(p_encounter_id);
  if v_view is null then
    v_safe := patient_level(v_patient) <> 'identity';
    return jsonb_build_object(
      'diagnoses', '[]'::jsonb, 'notes', '[]'::jsonb, 'prescriptions', '[]'::jsonb, 'orders', '[]'::jsonb,
      'patient', (select jsonb_build_object('id', p.id,
                    'allergies', case when v_safe then p.allergies end,
                    'bloodGroup', case when v_safe then p.blood_group end,
                    'notes', case when v_safe then p.notes end,
                    'flags', case when v_safe then p.flags else '{}'::jsonb end)
                  || case when v_safe then doc_patient(p.id, p_encounter_id)
                          else doc_patient(p.id, p_encounter_id) - 'allergies' - 'allergiesNone' - 'bloodGroup'
                               - 'weightKg' - 'weightAt' end
                  from patient p where p.id = v_patient),
      'visit', doc_visit(p_encounter_id),
      'private', true,
      'view', null,
      'access', patient_access(v_patient));
  end if;
  if v_closed then
    perform log_record_access(v_patient, p_encounter_id, v_view, 'visit');
  end if;
  return jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    -- HIV tests (like the diagnoses above) only for the people allowed to see them
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (has_perm('sensitive.read') or not sensitive_service(s.id))), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', v_view
  );
end
$$;

create or replace function lab_worklist(p_scope text default 'open')
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
      'corrected', d.corrected_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category in (select unnest(my_test_categories())) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      -- HIV tests: the people allowed to see them, and the desk that runs them (the laboratory and
      -- ultrasound staff do their work whatever their rights)
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(s.id))
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

create or replace function add_diagnosis(p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default 'primary', p_provisional boolean default false)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  -- an HIV diagnosis (ICD-10 B20–B24) is written by the people allowed to see HIV results
  if upper(trim(coalesce(p_icd10, ''))) ~ '^B2[0-4]' and not has_perm('sensitive.read') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into condition (encounter_id, text, icd10_code, type, provisional)
  values (p_encounter_id, trim(p_text), nullif(upper(trim(coalesce(p_icd10, ''))), ''), p_type, p_provisional)
  returning id into v_id;
  return v_id;
end
$$;

-- 4. A head's dashboard: their own department's people --------------------------------------------
create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  -- a head or assistant: the people of the departments they lead (null: the manager, everyone)
  v_members uuid[];
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
  v_tiles jsonb;
  v_rev30 jsonb;
  v_rev_period jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_manager then
    select coalesce(array_agg(distinct m.profile_id), '{}') into v_members
    from staff_department m
    join staff_department h on h.department_id = m.department_id
    join department d on d.id = m.department_id and d.deleted_at is null
    where h.profile_id = auth.uid() and h.position in ('head', 'assistant');
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    -- patients who joined a queue today and are not taken yet (one patient sent to several desks counts once)
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                     and q.created_at >= v_midnight),
    -- still open from an earlier day: forgotten in a queue (please close)
    'forgottenNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                       and q.created_at < v_midnight),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'refunded', case when v_manager then (select coalesce(sum(amount), 0) from refund where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'debts', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                                       where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'debtsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                                          where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today: collected, refunded and net
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0),
                                               'refunds', coalesce(r.amount, 0),
                                               'net', coalesce(s.amount, 0) - coalesce(r.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp at time zone 'Africa/Kigali'
    group by 1
  ) s on s.day = d::date
  left join (
    select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from refund where deleted_at is null and refunded_at >= (v_today - 29)::timestamp at time zone 'Africa/Kigali'
    group by 1
  ) r on r.day = d::date;

  -- the same for the chosen period (up to 92 days; longer: see Analytics)
  if v_days <= 92 then
    select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0),
                                                 'refunds', coalesce(r.amount, 0),
                                                 'net', coalesce(s.amount, 0) - coalesce(r.amount, 0)) order by d), '[]'::jsonb)
    into v_rev_period
    from generate_series(p_from, p_to, interval '1 day') d
    left join (
      select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
      from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1
    ) s on s.day = d::date
    left join (
      select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
      from refund where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1
    ) r on r.day = d::date;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'categoryId', g.cat_id, 'name', g.name, 'nameKin', g.kin,
                                                'nameFr', g.fr, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    -- by the clinic's own categories; medicines (no service) count as pharmacy
    select coalesce(c.base_group::text, case when s.id is null then 'pharmacy' else 'other' end) as grp,
           c.id as cat_id, c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    left join service_category c on c.id = s.category_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by c.id, 1, 3, 4, 5
  ) g;

  -- the queues right now (no average: see Analytics → Waiting times)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'longest', w.longest, 'forgotten', w.forgotten) order by w.station), '[]'::jsonb)
  into v_wait
  from queue_now(null) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability): the same counts as Analytics → Who did what; a head sees the
  -- people of their own department only
  with ev as (
    select * from analytics_staff_events(p_from::timestamp at time zone 'Africa/Kigali',
                                         (p_to + 1)::timestamp at time zone 'Africa/Kigali', v_manager)
  ),
  a as (
    select ev.user_id,
           count(*) filter (where kind = 'registered') as registrations,
           count(*) filter (where kind = 'vitals') as vitals,
           count(*) filter (where kind = 'charges') as charges,
           count(*) filter (where kind = 'patientsSeen') as patients,
           count(*) filter (where kind = 'results') as results,
           count(*) filter (where kind = 'medicinesGiven') as dispensed,
           count(*) filter (where kind = 'payments') as payments,
           coalesce(sum(amount) filter (where kind = 'payments'), 0) as collected
    from ev group by ev.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'active', p.active and p.deleted_at is null,
      'registrations', coalesce(a.registrations, 0), 'vitals', coalesce(a.vitals, 0), 'charges', coalesce(a.charges, 0),
      'patients', coalesce(a.patients, 0), 'results', coalesce(a.results, 0), 'dispensed', coalesce(a.dispensed, 0),
      'payments', case when v_manager then coalesce(a.payments, 0) end,
      'collected', case when v_manager then coalesce(a.collected, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(a.registrations, 0) + coalesce(a.vitals, 0) + coalesce(a.charges, 0) + coalesce(a.payments, 0)
                + coalesce(a.patients, 0) + coalesce(a.results, 0) + coalesce(a.dispensed, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join a on a.user_id = p.id
  where (v_members is null or p.id = any (v_members))
    and ((p.active and p.deleted_at is null)
         or (a.user_id is not null and (a.registrations + a.vitals + a.charges + a.patients + a.results + a.dispensed + a.payments) > 0));

  -- stock: the item's id and full name (with strength)
  select coalesce(jsonb_agg(jsonb_build_object('id', r.item_id, 'name', item_label(r.item_id), 'onHand', r.on_hand, 'min', r.reorder_level)
                            order by (r.on_hand::numeric / greatest(r.reorder_level, 1)), item_label(r.item_id)), '[]'::jsonb) into v_reorder
  from items_below_reorder r;

  select jsonb_build_object(
    'expired', count(distinct s.item_id) filter (where s.expiry < v_today),
    'd30', count(distinct s.item_id) filter (where s.expiry >= v_today and s.expiry <= v_today + 30),
    'd60', count(distinct s.item_id) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(distinct s.item_id) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select item_id, batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null
        group by item_id, batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', (select count(*) from appointment where deleted_at is null and status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  -- sign-ins of the last 24 hours (a head: their department's people)
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event
        where action = 'login' and at > now() - interval '1 day'
          and (v_members is null or actor_id = any (v_members))
        order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    -- money for the manager only (heads of department see the activity, not the money)
    'tiles', v_tiles,
    'revenue30d', case when v_manager then v_rev30 else '[]'::jsonb end,
    'revenuePeriod', case when v_manager then v_rev_period end,
    'collections', case when v_manager then v_collections else '[]'::jsonb end,
    'receivables', case when v_manager then v_receivables else '[]'::jsonb end,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

-- 5. Every temporary PIN ends the open sign-ins; nobody resets their own -------------------------
-- The profiles trigger (0091) fires only when "PIN change pending" turns on; a second reset while
-- it is still on changes only the temporary PIN row, so that row ends the sign-ins too.
create or replace function temp_pin_set()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.set_by is not null and new.set_by = new.user_id then
    raise exception 'a manager does not reset their own PIN' using errcode = '42501', hint = 'not_permitted';
  end if;
  if tg_op = 'INSERT' or new.pin is distinct from old.pin then
    update approved_session
       set ended_at = now(), ended_reason = 'new PIN'
     where user_id = new.user_id and ended_at is null;
  end if;
  return new;
end
$$;
revoke all on function temp_pin_set() from public, anon, authenticated;
drop trigger if exists temp_pin_set on staff_temp_pin;
create trigger temp_pin_set
  before insert or update on staff_temp_pin
  for each row execute function temp_pin_set();

-- 6. Declining a booking: the calendar's owner (or the manager), as for accepting ------------------
create or replace function decline_appointment(p_appointment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_a appointment%rowtype;
begin
  if not (has_perm('appointment.accept') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_a from appointment where id = p_appointment_id and deleted_at is null for update;
  if not found or v_a.status <> 'approved' then
    raise exception 'appointment not found or not approved' using errcode = 'P0002';
  end if;
  if not is_manager()
     and not exists (select 1 from practitioner where id = v_a.practitioner_id and user_id = auth.uid()) then
    raise exception 'only the doctor of this calendar declines the booking' using errcode = '42501';
  end if;
  update appointment set status = 'declined', cancel_reason = p_reason
  where id = p_appointment_id;
end
$$;

-- 7. "Seen": the requester, the colleague who took the patient over, or the manager ---------------
create or replace function mark_result_reviewed(p_report_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
begin
  if not (has_perm('clinical.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select r.* into v_req
  from diagnostic_report d
  join service_request r on r.id = d.service_request_id
  where d.id = p_report_id and d.deleted_at is null;
  if not found then
    raise exception 'result not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not is_manager()
     and auth.uid() not in (v_req.requester_id, result_recipient(v_req.encounter_id, v_req.requester_id)) then
    raise exception 'only the doctor who asked for the test, or who took the patient over, marks the result seen'
      using errcode = '42501';
  end if;
  update diagnostic_report set reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_report_id and deleted_at is null and reviewed_at is null;
end
$$;

-- 8. Vital signs: the form's limits, in the database too -----------------------------------------
create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not has_perm('vitals.write') then
    raise exception 'you may not record vital signs (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  -- At triage: the people of a department that does triage (when none does, as before).
  if v_at_triage then
    perform assert_desk(array['triage'], 'triage');
  end if;
  -- Sending on from triage is for whoever may work on the patient (as with "Send on"): reception
  -- that sent the patient to triage, or a nurse other than the one named, records only.
  if v_at_triage and p_next_station is not null and not may_route(p_encounter_id) then
    if current_role_key() = 'receptionist' then
      raise exception 'this patient is with %: record the measurements without choosing where they go next; the nurse there sends them on',
        coalesce(patient_holder(p_encounter_id), 'triage') using errcode = '42501';
    end if;
    perform assert_may_work_on(p_encounter_id, true);
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  -- the person named as having measured must be allowed to record vital signs themselves
  if v_by <> auth.uid() and not staff_perm(v_by, 'vitals.write') then
    raise exception 'the person named as "measured by" is not allowed to take vital signs'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      -- the same limits as the form (newborn to adult, critically ill included): outside them it
      -- is a typing mistake
      case v_key
        when 'bp_sys' then
          if v_val not between 40 and 300 then
            raise exception 'the systolic blood pressure must be between 40 and 300 mmHg' using errcode = '22023';
          end if;
        when 'bp_dia' then
          if v_val not between 20 and 200 then
            raise exception 'the diastolic blood pressure must be between 20 and 200 mmHg' using errcode = '22023';
          end if;
        when 'pulse' then
          if v_val not between 20 and 250 then
            raise exception 'the pulse must be between 20 and 250 per minute' using errcode = '22023';
          end if;
        when 'temp' then
          if v_val not between 30 and 44 then
            raise exception 'the temperature must be between 30 and 44 °C' using errcode = '22023';
          end if;
        when 'resp' then
          if v_val not between 4 and 100 then
            raise exception 'the breathing rate must be between 4 and 100 per minute' using errcode = '22023';
          end if;
        when 'spo2' then
          if v_val not between 40 and 100 then
            raise exception 'the oxygen saturation must be between 40 and 100 %%' using errcode = '22023';
          end if;
        when 'weight' then
          if v_val not between 0.3 and 350 then
            raise exception 'the weight must be between 0.3 and 350 kg' using errcode = '22023';
          end if;
        when 'height' then
          if v_val not between 20 and 250 then
            raise exception 'the height must be between 20 and 250 cm' using errcode = '22023';
          end if;
        when 'muac' then
          if v_val not between 5 and 60 then
            raise exception 'the arm circumference must be between 5 and 60 cm' using errcode = '22023';
          end if;
        else null;
      end case;
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'enter at least one measurement' using errcode = '22023';
  end if;

  if v_by <> auth.uid() then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'create', 'observation', p_encounter_id,
            jsonb_build_object('measured_by', v_by, 'measured_at', v_at, 'count', v_count),
            'vitals entered on behalf of the person who measured');
  end if;

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
    -- the colour reorders the places where the patient waits (red first)
    update queue_entry set priority = case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end
    where encounter_id = p_encounter_id and finished_at is null and started_at is null and deleted_at is null;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- 9. Merging: files and record-access rows move too; the old number finds the patient -------------
create or replace function merge_patients(p_keep uuid, p_merge uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_old_number text;
  v_table text;
  v_moved integer := 0;
  v_n integer;
begin
  if not is_manager() then
    raise exception 'only the manager can merge patient files' using errcode = '42501';
  end if;
  if p_keep is null or p_merge is null or p_keep = p_merge then
    raise exception 'choose two different files' using errcode = '22023';
  end if;
  if not exists (select 1 from patient where id = p_keep and deleted_at is null and merged_into is null) then
    raise exception 'the file to keep was not found' using errcode = 'P0002';
  end if;
  select file_number into v_old_number from patient where id = p_merge and deleted_at is null and merged_into is null;
  if not found then
    raise exception 'the duplicate file was not found or is already merged' using errcode = 'P0002';
  end if;
  if exists (select 1 from encounter where patient_id = p_keep and status = 'open')
     and exists (select 1 from encounter where patient_id = p_merge and status = 'open') then
    raise exception 'both files have a visit open: close one first' using errcode = '23514';
  end if;
  foreach v_table in array array['appointment', 'encounter', 'vaccination', 'fp_event', 'hiv_test',
                                  'document', 'message', 'internal_task', 'coverage',
                                  'patient_file_doc', 'record_access_request', 'record_access_entry'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = v_table and column_name = 'patient_id') then
      execute format('update %I set patient_id = $1 where patient_id = $2', v_table) using p_keep, p_merge;
      get diagnostics v_n = row_count;
      v_moved := v_moved + v_n;
    end if;
  end loop;
  update patient set guardian_patient_id = p_keep where guardian_patient_id = p_merge;
  update coverage set principal_patient_id = p_keep where principal_patient_id = p_merge;
  insert into patient_alias (file_number, patient_id) values (v_old_number, p_keep)
  on conflict (file_number) do update set patient_id = p_keep;
  update patient_alias set patient_id = p_keep where patient_id = p_merge;
  update patient set merged_into = p_keep, updated_at = now() where id = p_merge;
  insert into audit_event (actor_id, action, entity, entity_id, after, reason)
  values (auth.uid(), 'update', 'patient', p_keep,
          jsonb_build_object('merged', p_merge, 'fileNumber', v_old_number, 'moved', v_moved), 'files merged');
  return jsonb_build_object('moved', v_moved, 'oldNumber', v_old_number);
end
$$;

create or replace function find_patients(p_query text, p_limit integer default 10)
returns table (
  id uuid, file_number text, surname text, given_names text, sex sex, birth_date date,
  phone_1 text, has_open_visit boolean
)
language sql stable security definer set search_path = public
as $$
  with q as (select trim(coalesce(p_query, '')) as text)
  select p.id, p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         exists (select 1 from encounter e where e.patient_id = p.id and e.status = 'open') as has_open_visit
  from patient p, q
  where has_perm('patient.read')
    and p.deleted_at is null and p.merged_into is null and length(q.text) >= 2
    and (
      upper(p.file_number) = upper(q.text)
      -- a file number of a duplicate merged into this one
      or exists (select 1 from patient_alias a where a.patient_id = p.id and upper(a.file_number) = upper(q.text))
      or p.national_id = q.text
      or regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%'
         and length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4
      or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
      or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%'
    )
  order by p.surname, p.given_names
  limit greatest(1, least(p_limit, 50))
$$;

create or replace function patients_list(p_query text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as text),
  base as (
    select p.*,
           (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null) as last_visit_at,
           (select count(*) from encounter e where e.patient_id = p.id and e.deleted_at is null) as visits,
           (select e.id from encounter e where e.patient_id = p.id and e.status = 'open' and e.deleted_at is null order by e.arrived_at desc limit 1) as open_encounter_id,
           (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where e.patient_id = p.id and i.deleted_at is null and i.status <> 'credited') as balance_due
    from patient p, q
    where has_perm('patient.read') and p.deleted_at is null and p.merged_into is null
      and (q.text is null
        or upper(p.file_number) = upper(q.text)
        -- a file number of a duplicate merged into this one
        or exists (select 1 from patient_alias a where a.patient_id = p.id and upper(a.file_number) = upper(q.text))
        or p.national_id = q.text
        or (length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4 and regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%')
        or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
        or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'fileNumber', b.file_number, 'surname', b.surname, 'givenNames', b.given_names,
        'sex', b.sex, 'birthDate', b.birth_date, 'phone', b.phone_1, 'sector', b.sector,
        'registeredAt', b.created_at, 'lastVisitAt', b.last_visit_at, 'visits', b.visits,
        'openEncounterId', b.open_encounter_id, 'balanceDue', b.balance_due,
        -- 0088: the safety marks for the people who read clinical records only ("VIP" for all)
        'flags', case when clinical_reader() then b.flags
                      else jsonb_strip_nulls(jsonb_build_object('vip', b.flags -> 'vip')) end,
        'hasAllergies', case when clinical_reader() then b.allergies is not null else false end
      ) order by coalesce(b.last_visit_at, b.created_at) desc)
      from (select * from base order by coalesce(last_visit_at, created_at) desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) b), '[]'::jsonb)
  )
$$;

-- 10. "File added to a test": told to whoever has the patient now ---------------------------------
create or replace function attach_file(
  p_encounter_id uuid,
  p_path text,
  p_kind text,
  p_title text,
  p_mime text,
  p_size integer,
  p_service_request_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_ext text := lower(substring(coalesce(p_path, '') from '\.([a-zA-Z]+)$'));
  v_obj_found boolean := false;
  v_obj_size bigint;
  v_obj_mime text;
  v_f patient_file_doc%rowtype;
  v_req service_request%rowtype;
  v_to uuid;
  v_name text;
  v_file text;
  v_me text;
  v_test text;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_e.status <> 'open' then
    raise exception 'files are added while the visit is open' using errcode = '22023', hint = 'file_visit_closed';
  end if;
  if coalesce(p_kind, '') not in ('ultrasound', 'lab', 'scan', 'referral', 'photo', 'other') then
    raise exception 'unknown kind of file' using errcode = '22023', hint = 'file_kind';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 or length(trim(p_title)) > 200 then
    raise exception 'give the file a title' using errcode = '22023', hint = 'title_needed';
  end if;
  if not file_mime_ok(p_mime) then
    raise exception 'only photos (JPEG, PNG, WebP) and PDF files' using errcode = '22023', hint = 'file_type';
  end if;
  if p_size is null or p_size <= 0 or p_size > file_max_bytes() then
    raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
  end if;
  if file_path_encounter(p_path) is distinct from p_encounter_id
     or split_part(p_path, '/', 1) <> v_e.patient_id::text
     or not file_ext_ok(p_mime, v_ext) then
    raise exception 'the file is not stored where this visit''s files go' using errcode = '22023', hint = 'file_path';
  end if;
  if p_service_request_id is not null then
    select * into v_req from service_request
    where id = p_service_request_id and encounter_id = p_encounter_id and deleted_at is null;
    if not found or v_req.status = 'cancelled' then
      raise exception 'this test is not one of the visit' using errcode = '22023', hint = 'wrong_test';
    end if;
  end if;
  if not may_attach_file(p_encounter_id, p_service_request_id) then
    raise exception 'not allowed: only the people working on the visit add files'
      using errcode = '42501', hint = 'not_on_visit';
  end if;
  -- On Supabase: the file must be in the bucket, with the size and type said.
  if to_regclass('storage.objects') is not null then
    execute 'select true, (metadata ->> ''size'')::bigint, metadata ->> ''mimetype''
             from storage.objects where bucket_id = ''patient-files'' and name = $1'
      into v_obj_found, v_obj_size, v_obj_mime using p_path;
    if not coalesce(v_obj_found, false) then
      raise exception 'the file did not arrive: send it again' using errcode = '22023', hint = 'not_uploaded';
    end if;
    if v_obj_size is not null and v_obj_size > file_max_bytes() then
      raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
    end if;
    if v_obj_mime is not null and not file_mime_ok(v_obj_mime) then
      raise exception 'only photos (JPEG, PNG, WebP) and PDF files' using errcode = '22023', hint = 'file_type';
    end if;
  end if;
  insert into patient_file_doc (patient_id, encounter_id, service_request_id, kind, title, note,
                                storage_path, mime_type, size_bytes, uploaded_by)
  values (v_e.patient_id, p_encounter_id, p_service_request_id, p_kind, trim(p_title),
          nullif(trim(coalesce(p_note, '')), ''), p_path, p_mime,
          coalesce(v_obj_size::integer, p_size), auth.uid())
  returning * into v_f;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'patient_file_doc', v_f.id,
          jsonb_build_object('patient', v_f.patient_id, 'encounter', v_f.encounter_id, 'kind', v_f.kind,
                             'title', v_f.title, 'mime', v_f.mime_type, 'size', v_f.size_bytes));
  -- the laboratory or ultrasound added a file to a test: its requester is told, or the colleague
  -- who took the patient over since (as the result notices do)
  if v_req.id is not null and v_req.requester_id is not null then
    v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
  end if;
  if v_to is not null and v_to <> auth.uid() then
    select p.surname || ' ' || p.given_names, p.file_number into v_name, v_file
    from patient p where p.id = v_e.patient_id;
    select full_name into v_me from profiles where id = auth.uid();
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
    values ('file_attached',
            jsonb_build_object('fileId', v_f.id, 'patientId', v_e.patient_id, 'encounterId', v_e.id,
                               'name', v_name, 'file', v_file, 'by', v_me, 'title', v_f.title,
                               'kind', v_f.kind, 'test', v_test),
            'File added to a test',
            coalesce(v_me, '') || ' added "' || v_f.title || '" to ' || coalesce(v_test, 'a test') || ' of ' || coalesce(v_name, ''),
            '/app/visit?encounter=' || v_e.id, false, v_to, auth.uid());
  end if;
  return file_doc_json(v_f, 'visit');
end
$$;

-- 11. patient_file says which private extra fields are filled -------------------------------------
-- At the identity level the "medical" extra fields leave the file (0088), so the edit form could
-- not tell an empty one (reception may fill it) from a filled one (locked): `extra_filled` lists
-- the private keys that have a value, without the values.
create or replace function patient_file(p_patient_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_patient jsonb;
  v_visits jsonb;
  v_vitals jsonb;
  v_conditions jsonb;
  v_bills jsonb;
  v_doc jsonb;
  v_reader boolean := clinical_reader();
  v_via text;
  v_treating uuid;
  v_level text;
  v_past_seen boolean;
  v_views jsonb;
  v_extra_filled jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select to_jsonb(p) - 'photo_blob_id' - 'merged_into' - 'guardian_patient_id' into v_patient
  from patient p where p.id = p_patient_id and p.deleted_at is null;
  if v_patient is null then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
  -- worked out once for the whole file (the visits' loop reuses them)
  v_via := history_via(p_patient_id);
  v_treating := treating_visit(p_patient_id);
  v_level := case when v_via is not null then 'full' when v_treating is not null then 'summary' else 'identity' end;

  -- how each visit may be seen (null: private)
  select coalesce(jsonb_object_agg(e.id::text, s.view) filter (where s.view is not null), '{}'::jsonb),
         coalesce(bool_or(s.view is not null and e.status = 'closed'), false)
  into v_views, v_past_seen
  from encounter e
  cross join lateral (select case when v_reader then visit_view_with(e.id, v_via, true) end as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'reference', e.reference, 'arrivedAt', e.arrived_at, 'status', e.status, 'type', e.type,
      'triage', e.triage_level,
      'triageReason', case when s.view is not null then e.triage_reason end,
      'practitioner', (select names from practitioner where id = e.practitioner_id),
      'stations', (select coalesce(jsonb_agg(distinct q.station::text), '[]'::jsonb) from queue_entry q where q.encounter_id = e.id and q.deleted_at is null),
      'currentStation', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null and q.deleted_at is null order by q.created_at desc limit 1),
      'diagnosis', case when s.view is not null then
        (select c.text from condition c where c.encounter_id = e.id and c.type = 'primary' and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read')) order by c.created_at desc limit 1) end,
      'total', (select i.total from invoice i where i.encounter_id = e.id),
      'balance', (select invoice_balance(i.id) from invoice i where i.encounter_id = e.id),
      'billStatus', (select i.status from invoice i where i.encounter_id = e.id),
      'closedAt', e.closed_at,
      'private', s.view is null,
      'view', s.view
    ) order by e.arrived_at desc), '[]'::jsonb) into v_visits
  from encounter e cross join lateral (select v_views ->> e.id::text as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', o.encounter_id, 'code', o.code, 'value', o.value_num, 'text', o.value_text,
      'unit', o.unit, 'at', o.effective_at, 'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at desc), '[]'::jsonb) into v_vitals
  -- the visits one may see; whoever types the nurse's sheet (vitals.write) also sees what is
  -- recorded on the open visit (0019), never a past one
  from observation o
  where o.deleted_at is null and o.code <> 'note'
    and (v_views ? o.encounter_id::text
         or (has_perm('vitals.write')
             and o.encounter_id in (select e.id from encounter e
                                    where e.patient_id = p_patient_id and e.status = 'open' and e.deleted_at is null)));

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'encounterId', c.encounter_id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type,
      'provisional', c.provisional, 'at', c.created_at, 'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at desc), '[]'::jsonb) into v_conditions
  from condition c
  where v_views ? c.encounter_id::text and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'));

  select coalesce(jsonb_agg(jsonb_build_object(
      'invoiceId', i.id, 'encounterId', i.encounter_id, 'number', i.number, 'status', i.status,
      'total', i.total, 'patientShare', i.patient_share, 'insurerShare', i.insurer_share,
      'balance', invoice_balance(i.id), 'payer', (select name from payer where id = i.payer_id),
      'at', i.created_at
    ) order by i.created_at desc), '[]'::jsonb) into v_bills
  from invoice i join encounter e on e.id = i.encounter_id
  where e.patient_id = p_patient_id and i.deleted_at is null;

  -- the private extra fields that have a value (the keys only; the form locks them)
  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_extra_filled
  from unnest(private_extra_keys()) k
  where nullif(trim(coalesce(v_patient -> 'extra' ->> k, '')), '') is not null;

  v_doc := doc_patient(p_patient_id, null);
  if v_level = 'identity' then
    v_patient := v_patient || jsonb_build_object('allergies', null, 'allergies_none', null,
                                                 'blood_group', null, 'notes', null,
                                                 -- the manager's "medical" extra fields go too
                                                 'extra', coalesce(v_patient -> 'extra', '{}'::jsonb) - private_extra_keys(),
                                                 -- the safety marks go; "VIP" is not one
                                                 'flags', jsonb_strip_nulls(jsonb_build_object('vip', v_patient -> 'flags' -> 'vip')));
    v_doc := v_doc - 'allergies' - 'allergiesNone' - 'bloodGroup' - 'weightKg' - 'weightAt';
  end if;

  if v_past_seen then
    perform log_record_access(p_patient_id, null, coalesce(v_via, 'own'), 'file');
  end if;

  return jsonb_build_object('patient', v_patient, 'visits', v_visits, 'vitals', v_vitals,
                            'conditions', v_conditions, 'bills', v_bills,
                            'document', v_doc,
                            'safetyHidden', v_level = 'identity',
                            'extra_filled', v_extra_filled,
                            'summary', case when v_level <> 'identity' then patient_safety_summary(p_patient_id) end,
                            'access', patient_access_with(p_patient_id, v_via, v_treating));
end
$$;
