-- 0055 · A patient belongs where they were sent (a desk, a department or a named colleague):
-- everyone sees that the patient is in the clinic, only those holding them may work on them,
-- until they send the patient on. A doctor calls the next patient (reception, the nurses or a
-- colleague sends one); a clinician asks a colleague for help on a patient, and the colleague
-- who accepts may work on that patient too.

alter table queue_entry add column if not exists department_id uuid references department (id) on delete set null;

create table if not exists staff_call (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('next', 'help')),
  from_user uuid not null default auth.uid() references profiles (id) on delete cascade,
  station station,
  target text not null check (target in ('reception', 'nurse', 'person', 'doctors')),
  to_user uuid references profiles (id) on delete set null,
  encounter_id uuid references encounter (id),
  note text,
  status text not null default 'open'
    check (status in ('open', 'answered', 'accepted', 'declined', 'cancelled', 'done')),
  answered_by uuid references profiles (id) on delete set null,
  answered_at timestamptz,
  closed_at timestamptz
);
create index if not exists staff_call_open_idx on staff_call (status, created_at)
  where status in ('open', 'accepted');
-- Read and written through the functions below only.
alter table staff_call enable row level security;

-- Is this queue entry mine to work on? Sent to me (or to the doctor I cover), taken by me,
-- expected back by me, or still free at a desk of my role (and of my department, when it was
-- sent to a department). The manager oversees everything.
create or replace function queue_entry_for_me(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from queue_entry q
    join profiles me on me.id = auth.uid() and me.active
    left join lateral (select covering_for(me.id) as doc) cv on true
    where q.id = p_queue_id and q.deleted_at is null
      and (
        me.role = 'manager'
        or me.id = q.assigned_to or me.id = q.taken_by or me.id = q.return_to
        or (cv.doc is not null and (cv.doc = q.assigned_to or cv.doc = q.taken_by))
        or (q.assigned_to is null and q.taken_by is null
            and (station_role(q.station) = me.role
                 or (cv.doc is not null and station_role(q.station) = 'doctor'))
            and (q.department_id is null
                 or me.department_id = q.department_id
                 or exists (select 1 from staff_department sd
                            where sd.profile_id = me.id and sd.department_id = q.department_id)))
      )
  )
$$;

-- May the signed-in person work on this visit (write notes, diagnoses, orders, send on)?
create or replace function may_work_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager()
    or exists (select 1 from queue_entry q
               where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                 and queue_entry_for_me(q.id))
    -- a colleague who accepted to help on this patient
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status = 'accepted'
                 and c.answered_by = auth.uid())
    -- nobody holds the patient at a treating desk (e.g. now at the cashier): whoever treated
    -- them in this visit may still complete the record
    or (not exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer'))
        and exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.deleted_at is null
                      and (q.taken_by = auth.uid() or q.assigned_to = auth.uid())))
$$;

-- Sending a patient on: those who may work on them, and reception for a patient nobody holds yet.
create or replace function may_route(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select may_work_on(p_encounter_id)
    or (current_role_key() = 'receptionist'
        and not exists (select 1 from queue_entry q
                        where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                          and (q.assigned_to is not null or q.taken_by is not null)
                          and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer')))
$$;

-- Who holds the patient now: "Dr. X", "Paediatrics · consultation", "Laboratory"…
create or replace function patient_holder(p_encounter_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select string_agg(distinct coalesce(pt.full_name, pa.full_name,
                                      d.name || ' · ' || initcap(q.station::text),
                                      initcap(q.station::text)), ', ')
  from queue_entry q
  left join profiles pa on pa.id = q.assigned_to
  left join profiles pt on pt.id = q.taken_by
  left join department d on d.id = q.department_id
  where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
$$;

create or replace function assert_may_work_on(p_encounter_id uuid, p_routing boolean default false)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  v_ok boolean := case when p_routing then may_route(p_encounter_id) else may_work_on(p_encounter_id) end;
begin
  if v_ok then
    return;
  end if;
  -- a missing or finished visit is reported by the caller
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    return;
  end if;
  raise exception 'this patient is with %: they must send the patient to you, or ask for your help',
    coalesce(patient_holder(p_encounter_id), 'another desk') using errcode = '42501';
end
$$;

-- For the visit screen: may I work here, who holds the patient, who helps.
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
      where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status in ('open', 'accepted')), '[]'::jsonb)
  )
  where exists (select 1 from profiles where id = auth.uid() and active)
$$;


create or replace function add_clinical_note(p_encounter_id uuid, p_text text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the note is empty' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into observation (encounter_id, code, value_text) values (p_encounter_id, 'note', trim(p_text))
  returning id into v_id;
  return v_id;
end
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
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
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

create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if coalesce(p_supply, 'pharmacy') not in ('pharmacy', 'room') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), coalesce(p_supply, 'pharmacy'),
          case when p_supply = 'room' then now() end, case when p_supply = 'room' then auth.uid() end)
  returning id into v_id;
  if p_supply = 'room' then
    -- Given here: on the bill at the medicine's price (if it has one); no pharmacy queue.
    begin
      perform add_charge(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('id', v_id, 'supply', coalesce(p_supply, 'pharmacy'), 'charged', v_charged);
end
$$;

create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text default null, p_priority integer default 3)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_group service_group;
  v_cat request_category;
  v_station station;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  select s.service_group,
         coalesce(c.order_station, case when s.service_group = 'imaging' then 'ultrasound'::station else 'laboratory'::station end)
  into v_group, v_station
  from service s left join service_category c on c.id = s.category_id
  where s.id = p_service_id and s.active and s.deleted_at is null;
  if v_group is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  v_cat := case when v_station = 'ultrasound' then 'imaging'::request_category else 'lab'::request_category end;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into service_request (encounter_id, category, service_id, reason, priority, station)
  values (p_encounter_id, v_cat, p_service_id, nullif(trim(coalesce(p_reason, '')), ''), least(5, greatest(1, p_priority)), v_station)
  returning id into v_id;
  perform add_charge(p_encounter_id, v_station, p_service_id, null, 1, null, null, null, null, 'service_request', v_id);
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_station and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, v_station, (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1), least(5, greatest(1, p_priority)));
  end if;
  return v_id;
end
$$;

create or replace function order_tests(
  p_encounter_id uuid,
  p_service_ids uuid[],
  p_reason text default null,
  p_from station default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_service uuid;
  v_ids uuid[] := '{}';
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'choose at least one test' using errcode = '22023';
  end if;
  foreach v_service in array p_service_ids loop
    v_ids := v_ids || order_test(p_encounter_id, v_service, p_reason, 3);
  end loop;
  -- Send the patient now: off the doctor's queue, onto the desks that do the orders, back after.
  if p_from is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = p_from and finished_at is null
      and p_from not in (select r.station from service_request r where r.id = any (v_ids));
    update queue_entry
    set referred_by = auth.uid(),
        referral_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), referral_note),
        return_station = p_from,
        return_to = auth.uid()
    where encounter_id = p_encounter_id and finished_at is null and deleted_at is null
      and station <> p_from
      and station in (select r.station from service_request r where r.id = any (v_ids));
  end if;
  return coalesce(array_length(v_ids, 1), 0);
end
$$;

create or replace function create_task(
  p_encounter_id uuid,
  p_title text,
  p_due_at timestamptz default null,
  p_detail text default null,
  p_assigned_role role_key default 'nurse'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_patient uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into internal_task (encounter_id, patient_id, assigned_role, due_at, title, detail)
  values (p_encounter_id, v_patient, p_assigned_role, p_due_at, trim(p_title), nullif(trim(coalesce(p_detail, '')), ''))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function send_from_triage(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from observation where encounter_id = p_encounter_id and deleted_at is null) then
    raise exception 'take the vitals first' using errcode = '22023';
  end if;
  update encounter set triage_level = p_triage, triage_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), triage_reason)
  where id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null and deleted_at is null;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next_station
                 and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

create or replace function finish_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform assert_may_work_on(p_encounter_id);
  perform close_encounter(p_encounter_id);
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    -- Treatment is over; the visit stays open only until the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    update queue_entry set finished_at = now() where encounter_id = p_encounter_id and station <> 'cashier' and finished_at is null;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
    end if;
  end if;
end
$$;

create or replace function finish_station(p_encounter_id uuid, p_station station, p_next station default 'cashier')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id, true);
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  if p_next is not null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no) values (p_encounter_id, p_next, coalesce(v_ticket, 'A-000'));
    end if;
  end if;
end
$$;

create or replace function send_to_stations(
  p_encounter_id uuid,
  p_station station,
  p_next station[]
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_pool uuid;
  v_next station;
  v_name text;
  v_triage text;
  v_role role_key;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id, true);
  if p_next is null or cardinality(p_next) = 0 then
    raise exception 'choose where the patient goes' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  v_pool := case when cardinality(p_next) > 1 then gen_random_uuid() end;
  foreach v_next in array p_next loop
    if exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_next
               and finished_at is null and deleted_at is null) then
      update queue_entry set pool_id = coalesce(v_pool, pool_id)
      where encounter_id = p_encounter_id and station = v_next and finished_at is null;
    else
      insert into queue_entry (encounter_id, station, ticket_no, pool_id)
      values (p_encounter_id, v_next, coalesce(v_ticket, 'A-000'), v_pool);
    end if;
  end loop;
  -- One notice per role for the whole pool ("waiting for the first free doctor: …").
  if v_pool is not null then
    select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
    from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
    for v_role in select distinct station_role(s) from unnest(p_next) as s loop
      insert into notification (kind, params, link, urgent, recipient_role, created_by)
      values ('queue_pool',
              jsonb_build_object('ticket', coalesce(v_ticket, 'A-000'), 'name', v_name,
                                 'stations', to_jsonb(p_next), 'triage', v_triage, 'pool', v_pool),
              '/app/visit?encounter=' || p_encounter_id,
              coalesce(v_triage, '') = 'red',
              v_role,
              auth.uid());
    end loop;
  end if;
  return jsonb_build_object('pool', v_pool, 'stations', to_jsonb(p_next));
end
$$;

create or replace function add_charge(
  p_encounter_id uuid,
  p_office station,
  p_service_id uuid default null,
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_manual_price numeric default null,
  p_manual_reason text default null,
  p_performed_by uuid default null,
  p_entered_for uuid default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_discount_pct numeric default 0,
  p_discount_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_plan uuid;
  v_group service_group;
  v_desc text;
  v_price numeric;
  v_unit numeric;
  v_fallback boolean;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
  v_max_discount numeric := 0;
  v_discount numeric := coalesce(p_discount_pct, 0);
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- typed in by a person (automatic charges carry their source)
  if p_source_type is null then
    perform assert_may_work_on(p_encounter_id);
  end if;
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;

  if p_service_id is not null then
    select s.name_en, s.service_group, s.allow_manual_price, s.max_discount_pct
    into v_desc, v_group, v_allow_manual, v_max_discount
    from service s where s.id = p_service_id and s.active;
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false, 0
    into v_desc, v_group, v_allow_manual, v_max_discount
    from item i where i.id = p_item_id and i.active;
    v_origin := 'pharmacy';
  end if;
  if v_desc is null then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;

  if p_manual_price is not null then
    if not (v_allow_manual or has_perm('charge.manual')) then
      raise exception 'a typed price is not allowed for this service' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_manual_reason, '')), '') is null then
      raise exception 'a reason is required for a typed price' using errcode = '22023';
    end if;
    v_price := p_manual_price;
    v_origin := 'manual';
  else
    select pf.price, pf.fallback into v_price, v_fallback
    from price_for(p_service_id, p_item_id, v_invoice.payer_id) pf;
    if v_price is null then
      raise exception 'no price found for this service/item' using errcode = 'P0002';
    end if;
  end if;

  -- Discount: within the treatment's allowance, or the manager; always with a reason.
  if v_discount < 0 or v_discount > 100 then
    raise exception 'discount must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_discount > 0 then
    if v_discount > v_max_discount and not is_manager() then
      raise exception 'the discount on this treatment may not exceed %%%', v_max_discount using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_discount_reason, '')), '') is null then
      raise exception 'a reason is required for a discount' using errcode = '22023';
    end if;
  end if;
  v_unit := round(v_price * (100 - v_discount) / 100);

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  v_line_total := round(v_unit * p_quantity);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
    discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
    source_type, source_id, price_origin, manual_reason
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, p_quantity, v_unit, v_price, v_discount,
    nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
    p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
    v_origin, p_manual_reason
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

create or replace function take_patient(p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_by text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null;
  if not found then
    raise exception 'queue entry not found' using errcode = 'P0002';
  end if;
  -- Lock the whole pool so two doctors cannot take the same patient at the same moment.
  perform 1 from queue_entry
  where (pool_id is not null and pool_id = v_q.pool_id) or id = v_q.id
  for update;
  select * into v_q from queue_entry where id = p_queue_id;
  if v_q.finished_at is not null then
    select pr.full_name into v_by from queue_entry q join profiles pr on pr.id = q.taken_by
    where q.pool_id = v_q.pool_id and q.taken_by is not null limit 1;
    raise exception 'already taken by %', coalesce(v_by, 'another desk') using errcode = '23505';
  end if;
  if v_q.taken_by is not null and v_q.taken_by <> auth.uid() then
    select full_name into v_by from profiles where id = v_q.taken_by;
    raise exception 'already taken by %', coalesce(v_by, 'another doctor') using errcode = '23505';
  end if;
  if not queue_entry_for_me(p_queue_id) then
    raise exception 'this patient was sent to %', coalesce(patient_holder(v_q.encounter_id), 'another desk')
      using errcode = '42501';
  end if;
  update queue_entry
  set called_at = coalesce(called_at, now()), started_at = coalesce(started_at, now()),
      taken_by = auth.uid()
  where id = p_queue_id;
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> p_queue_id and finished_at is null;
  end if;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'station', v_q.station);
end
$$;

drop function if exists refer_patient(uuid, station, station, uuid, text, boolean);
create or replace function refer_patient(
  p_encounter_id uuid,
  p_from station,
  p_to station,
  p_to_user uuid default null,
  p_note text default null,
  p_return boolean default false,
  p_department uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_id uuid;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform assert_may_work_on(p_encounter_id, true);
  if p_department is not null and not exists (select 1 from department where id = p_department and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  -- A doctor who is covered by a nurse right now: the patient goes to the nurse.
  if p_to_user is not null then
    p_to_user := coalesce((select c.nurse_id from clinician_cover c
                           where c.doctor_id = p_to_user and c.ended_at is null
                             and now() >= c.starts_at and now() < c.ends_at
                           order by c.starts_at desc limit 1), p_to_user);
  end if;
  if p_to_user is not null and not exists (select 1 from profiles where id = p_to_user and active) then
    raise exception 'that colleague is not an active employee' using errcode = '22023';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_from and finished_at is null;
  -- Already waiting at that desk: update the waiting entry instead of adding a second one.
  update queue_entry
  set assigned_to = p_to_user, department_id = p_department, referred_by = auth.uid(),
      referral_note = nullif(trim(coalesce(p_note, '')), ''),
      return_station = case when p_return then p_from end,
      return_to = case when p_return then auth.uid() end
  where encounter_id = p_encounter_id and station = p_to and finished_at is null and deleted_at is null
  returning id into v_id;
  if v_id is null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    insert into queue_entry (encounter_id, station, ticket_no, assigned_to, department_id, referred_by, referral_note,
                             return_station, return_to)
    values (p_encounter_id, p_to, coalesce(v_ticket, 'A-000'), p_to_user, p_department, auth.uid(),
            nullif(trim(coalesce(p_note, '')), ''),
            case when p_return then p_from end,
            case when p_return then auth.uid() end)
    returning id into v_id;
  end if;
  return jsonb_build_object('queueId', v_id, 'station', p_to);
end
$$;

create or replace function notify_queue_entry_row(q queue_entry)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_by text;
begin
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = q.encounter_id;
  select full_name into v_by from profiles where id = q.referred_by;
  delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = q.id::text;
  insert into notification (kind, params, link, recipient_user, recipient_role, recipient_department, created_by)
  values ('referral',
          jsonb_build_object('ticket', q.ticket_no, 'name', v_name, 'station', q.station, 'by', v_by,
                             'note', q.referral_note, 'queue', q.id, 'back', q.return_station is not null),
          '/app/visit?encounter=' || q.encounter_id,
          q.assigned_to,
          case when q.assigned_to is null and q.department_id is null then station_role(q.station) end,
          case when q.assigned_to is null then q.department_id end,
          auth.uid());
end
$$;

create or replace function notify_referral_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.referred_by is not null and new.finished_at is null
     and (old.referred_by is distinct from new.referred_by or old.assigned_to is distinct from new.assigned_to
          or old.referral_note is distinct from new.referral_note
          or old.department_id is distinct from new.department_id) then
    perform notify_queue_entry_row(new);
  end if;
  return new;
end
$$;

create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station,
         v.effective_at as vitals_at, v.measured_by as vitals_by,
         q.department_id, dep.name as department_name, queue_entry_for_me(q.id) as can_work
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join department dep on dep.id = q.department_id
  left join lateral (
    select o.effective_at, pm.full_name as measured_by
    from observation o
    left join profiles pm on pm.id = o.performer_id
    where o.encounter_id = q.encounter_id and o.deleted_at is null
      and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')
    order by o.effective_at desc limit 1
  ) v on true
  where q.deleted_at is null and e.status = 'open';


-- A doctor (or any desk) calls the next patient: from reception, from the nurses or from one
-- colleague. A new call replaces the caller's call still waiting.
create or replace function call_next(
  p_station station,
  p_target text,
  p_to_user uuid default null,
  p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_by text;
begin
  select full_name into v_by from profiles where id = auth.uid() and active;
  if v_by is null or not has_perm('queue.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_target not in ('reception', 'nurse', 'person') then
    raise exception 'call reception, the nurses or a colleague' using errcode = '22023';
  end if;
  if p_target = 'person' and (p_to_user is null or p_to_user = auth.uid()
      or not exists (select 1 from profiles where id = p_to_user and active)) then
    raise exception 'choose an active colleague' using errcode = '22023';
  end if;
  perform cancel_my_next_calls();
  insert into staff_call (kind, station, target, to_user, note)
  values ('next', p_station, p_target, case when p_target = 'person' then p_to_user end,
          nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  insert into notification (kind, params, link, recipient_user, recipient_role, urgent, created_by)
  values ('call_next', jsonb_build_object('call', v_id, 'by', v_by, 'station', p_station, 'note', nullif(trim(coalesce(p_note, '')), '')),
          '/app', case when p_target = 'person' then p_to_user end,
          case p_target when 'reception' then 'receptionist'::role_key when 'nurse' then 'nurse'::role_key end,
          false, auth.uid());
  return v_id;
end
$$;

create or replace function cancel_my_next_calls()
returns void
language sql security definer set search_path = public
as $$
  delete from notification where kind = 'call_next' and params ->> 'call' in (
    select id::text from staff_call where from_user = auth.uid() and kind = 'next' and status = 'open');
  update staff_call set status = 'cancelled', closed_at = now()
  where from_user = auth.uid() and kind = 'next' and status = 'open';
$$;

-- Reception (or the nurse, or the colleague called) sends a waiting patient to the caller.
create or replace function answer_call(p_call_id uuid, p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c staff_call%rowtype;
  v_q queue_entry%rowtype;
  v_me role_key := current_role_key();
  v_id uuid;
begin
  select * into v_c from staff_call where id = p_call_id and kind = 'next' for update;
  if not found or v_c.status <> 'open' then
    raise exception 'this call was already answered or cancelled' using errcode = '23505';
  end if;
  if not (v_me = 'manager'
          or (v_c.target = 'reception' and v_me = 'receptionist')
          or (v_c.target = 'nurse' and v_me = 'nurse')
          or (v_c.target = 'person' and v_c.to_user = auth.uid())) then
    raise exception 'this call is not for you' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null and finished_at is null for update;
  if not found or not exists (select 1 from encounter where id = v_q.encounter_id and status = 'open') then
    raise exception 'that patient is no longer waiting' using errcode = 'P0002';
  end if;
  if v_q.taken_by is not null or (v_q.assigned_to is not null and v_q.assigned_to <> v_c.from_user) then
    raise exception 'that patient is already with %', coalesce(patient_holder(v_q.encounter_id), 'someone')
      using errcode = '23505';
  end if;
  if v_q.station = coalesce(v_c.station, v_q.station) then
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where id = v_q.id returning id into v_id;
  else
    -- waiting at another desk (e.g. triage done): they leave it for the caller's desk
    update queue_entry set finished_at = now() where id = v_q.id;
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where encounter_id = v_q.encounter_id and station = v_c.station and finished_at is null and deleted_at is null
    returning id into v_id;
    if v_id is null then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by)
      values (v_q.encounter_id, v_c.station, v_q.ticket_no, v_q.priority, v_c.from_user, auth.uid())
      returning id into v_id;
    end if;
  end if;
  -- a patient shared between several desks leaves the others
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> v_q.id and id <> v_id and finished_at is null;
  end if;
  update staff_call
  set status = 'answered', answered_by = auth.uid(), answered_at = now(), closed_at = now(),
      encounter_id = v_q.encounter_id
  where id = p_call_id;
  delete from notification where kind = 'call_next' and params ->> 'call' = p_call_id::text;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'queueId', v_id);
end
$$;

create or replace function cancel_call(p_call_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update staff_call
  set status = case when kind = 'help' and status = 'accepted' then 'done' else 'cancelled' end,
      closed_at = now()
  where id = p_call_id and status in ('open', 'accepted')
    and (from_user = auth.uid() or (kind = 'help' and answered_by = auth.uid()));
  if not found then
    raise exception 'nothing to end' using errcode = 'P0002';
  end if;
  delete from notification where kind in ('call_next', 'help') and params ->> 'call' = p_call_id::text;
end
$$;

-- Ask a colleague (or every doctor) for help on a patient one holds.
create or replace function ask_help(p_encounter_id uuid, p_to_user uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_by text;
  v_name text;
  v_ticket text;
begin
  select full_name into v_by from profiles where id = auth.uid() and active;
  if v_by is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if p_to_user is not null and (p_to_user = auth.uid()
      or not exists (select 1 from profiles where id = p_to_user and active)) then
    raise exception 'choose an active colleague' using errcode = '22023';
  end if;
  insert into staff_call (kind, target, to_user, encounter_id, note)
  values ('help', case when p_to_user is null then 'doctors' else 'person' end, p_to_user, p_encounter_id,
          nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  insert into notification (kind, params, link, recipient_user, recipient_role, urgent, created_by)
  values ('help', jsonb_build_object('call', v_id, 'by', v_by, 'name', v_name, 'ticket', v_ticket,
                                     'note', nullif(trim(coalesce(p_note, '')), '')),
          '/app/visit?encounter=' || p_encounter_id, p_to_user,
          case when p_to_user is null then 'doctor'::role_key end, true, auth.uid());
  return v_id;
end
$$;

create or replace function respond_help(p_call_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_c staff_call%rowtype;
  v_by text;
  v_name text;
begin
  select * into v_c from staff_call where id = p_call_id and kind = 'help' for update;
  if not found or v_c.status <> 'open' then
    raise exception 'this request was already answered or withdrawn' using errcode = '23505';
  end if;
  if not ((v_c.target = 'person' and v_c.to_user = auth.uid())
          or (v_c.target = 'doctors' and current_role_key() = 'doctor' and v_c.from_user <> auth.uid())) then
    raise exception 'this request is not for you' using errcode = '42501';
  end if;
  if not p_accept and v_c.target <> 'person' then
    raise exception 'a request to every doctor is left for another doctor' using errcode = '22023';
  end if;
  update staff_call
  set status = case when p_accept then 'accepted' else 'declined' end,
      answered_by = auth.uid(), answered_at = now(),
      closed_at = case when p_accept then null else now() end
  where id = p_call_id;
  delete from notification where kind = 'help' and params ->> 'call' = p_call_id::text;
  select full_name into v_by from profiles where id = auth.uid();
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_c.encounter_id;
  insert into notification (kind, params, link, recipient_user, created_by)
  values ('help_answer', jsonb_build_object('call', p_call_id, 'by', v_by, 'name', v_name, 'accepted', p_accept),
          '/app/visit?encounter=' || v_c.encounter_id, v_c.from_user, auth.uid());
end
$$;

-- My calls: for me to answer, mine waiting, the patients I help on.
create or replace function my_calls()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with me as (select id, role from profiles where id = auth.uid() and active),
  calls as (
    select c.*, f.full_name as from_name, t.full_name as to_name, h.full_name as answered_name,
           p.surname || ' ' || p.given_names as patient_name,
           (select q.ticket_no from queue_entry q where q.encounter_id = c.encounter_id order by q.created_at limit 1) as ticket
    from staff_call c
    join profiles f on f.id = c.from_user
    left join profiles t on t.id = c.to_user
    left join profiles h on h.id = c.answered_by
    left join encounter e on e.id = c.encounter_id
    left join patient p on p.id = e.patient_id
    where (c.status = 'open' and c.created_at > now() - interval '12 hours')
       or (c.status = 'accepted' and coalesce(e.status::text, 'open') = 'open')
       or (c.status = 'answered' and c.answered_at > now() - interval '30 minutes')
  ),
  j as (
    select c.*, jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'target', c.target, 'station', c.station, 'note', c.note,
      'status', c.status, 'at', c.created_at, 'fromId', c.from_user, 'fromName', c.from_name,
      'toName', c.to_name, 'answeredName', c.answered_name, 'answeredAt', c.answered_at,
      'encounterId', c.encounter_id, 'patientName', c.patient_name, 'ticket', c.ticket) as row
    from calls c
  )
  select jsonb_build_object(
    'incoming', coalesce((select jsonb_agg(j.row order by j.created_at) from j, me
      where j.status = 'open' and j.from_user <> me.id and (
        (j.target = 'reception' and me.role = 'receptionist')
        or (j.target = 'nurse' and me.role = 'nurse')
        or (j.target = 'person' and j.to_user = me.id)
        or (j.target = 'doctors' and me.role = 'doctor'))), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(j.row order by j.created_at desc) from j, me
      where j.from_user = me.id), '[]'::jsonb),
    'helping', coalesce((select jsonb_agg(j.row order by j.created_at) from j, me
      where j.kind = 'help' and j.status = 'accepted' and j.answered_by = me.id), '[]'::jsonb)
  )
  from me
$$;

revoke all on function queue_entry_for_me(uuid), may_work_on(uuid), may_route(uuid), patient_holder(uuid),
  assert_may_work_on(uuid, boolean), visit_access(uuid),
  refer_patient(uuid, station, station, uuid, text, boolean, uuid),
  call_next(station, text, uuid, text), cancel_my_next_calls(), answer_call(uuid, uuid), cancel_call(uuid),
  ask_help(uuid, uuid, text), respond_help(uuid, boolean), my_calls() from public, anon;
grant execute on function queue_entry_for_me(uuid), may_work_on(uuid), may_route(uuid), patient_holder(uuid),
  assert_may_work_on(uuid, boolean), visit_access(uuid),
  refer_patient(uuid, station, station, uuid, text, boolean, uuid),
  call_next(station, text, uuid, text), cancel_my_next_calls(), answer_call(uuid, uuid), cancel_call(uuid),
  ask_help(uuid, uuid, text), respond_help(uuid, boolean), my_calls() to authenticated;

