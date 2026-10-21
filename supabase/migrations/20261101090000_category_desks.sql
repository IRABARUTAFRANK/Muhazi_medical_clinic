-- 0052 · How a category's treatments are handled is set by the clinic.
--
-- Instead of four fixed service types, each category says how its treatments are handled:
--   · charged on the visit (the clinician adds it to the bill), or
--   · ordered by the doctor and done at a desk the manager chooses — Laboratory, Ultrasound,
--     Nursing, Dental, Minor surgery or Consultation: the patient is queued there, that desk
--     writes the result into the file, and the patient returns to the ordering doctor.
-- service_category.order_station holds the desk (null = charged on the visit); kind stays for
-- compatibility (lab = laboratory, imaging = ultrasound, treatment = anything else, bed = beds).
-- Every order now records its desk (service_request.station); the laboratory worklist and its
-- figures only show orders done at the laboratory / ultrasound.

alter table service_category add column if not exists order_station station;
update service_category set order_station = 'laboratory' where kind = 'lab' and order_station is null;
update service_category set order_station = 'ultrasound' where kind = 'imaging' and order_station is null;

alter table service_request add column if not exists station station;
update service_request set station = case when category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end
where station is null;

-- ---------------------------------------------------------------- categories
drop function if exists save_category(uuid, text, text, text, category_kind);
create or replace function save_category(
  p_id uuid,
  p_name_en text,
  p_name_kin text default null,
  p_name_fr text default null,
  p_kind category_kind default 'treatment',
  p_order_station station default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_old category_kind;
  v_old_station station;
  v_station station := p_order_station;
  v_kind category_kind;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'give the category a name' using errcode = '22023';
  end if;
  if exists (select 1 from service_category where lower(name_en) = lower(trim(p_name_en))
             and deleted_at is null and id is distinct from p_id) then
    raise exception 'a category with this name already exists' using errcode = '23505';
  end if;
  -- an older caller names the kind only
  if v_station is null and p_kind = 'lab' then v_station := 'laboratory'; end if;
  if v_station is null and p_kind = 'imaging' then v_station := 'ultrasound'; end if;
  if v_station is not null and v_station not in ('laboratory', 'ultrasound', 'nursing', 'dental', 'theatre', 'consultation') then
    raise exception 'this desk cannot carry out orders' using errcode = '22023';
  end if;
  v_kind := case when p_kind = 'bed' then 'bed'::category_kind
                 when v_station = 'laboratory' then 'lab'::category_kind
                 when v_station = 'ultrasound' then 'imaging'::category_kind
                 else 'treatment'::category_kind end;
  if v_kind = 'bed' then v_station := null; end if;
  if v_id is null then
    if v_kind = 'bed' then
      raise exception 'bed stays have their own built-in category' using errcode = '22023';
    end if;
    insert into service_category (name_en, name_kin, name_fr, kind, order_station)
    values (trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''),
            v_kind, v_station)
    returning id into v_id;
  else
    select kind, order_station into v_old, v_old_station from service_category where id = v_id and deleted_at is null;
    if not found then
      raise exception 'category not found' using errcode = 'P0002';
    end if;
    if (v_old = 'bed') <> (v_kind = 'bed') then
      raise exception 'the bed category keeps its kind' using errcode = '22023';
    end if;
    update service_category
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), kind = v_kind, order_station = v_station
    where id = v_id;
    if v_old <> v_kind then
      update service set category_id = category_id where category_id = v_id;
    end if;
  end if;
  return v_id;
end
$$;
revoke all on function save_category(uuid, text, text, text, category_kind, station) from public, anon;
grant execute on function save_category(uuid, text, text, text, category_kind, station) to authenticated;

-- ---------------------------------------------------------------- the catalogue: where an order goes
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name,
         coalesce((select array_agg(sd.department_id order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_ids,
         coalesce((select array_agg(dd.name order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_names,
         s.category_id,
         coalesce(c.order_station,
                  case s.service_group when 'lab' then 'laboratory'::station when 'imaging' then 'ultrasound'::station end)
           as order_station
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  left join service_category c on c.id = s.category_id
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

-- ---------------------------------------------------------------- ordering: to the category's desk
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

create or replace function record_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_verify boolean default true
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_station station;
  v_q queue_entry%rowtype;
  v_tests text;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- Lab / ultrasound results: lab staff and clinicians who order; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too.
  if not (has_perm('orders.write')
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  insert into diagnostic_report (service_request_id, findings, impression, verified_by, verified_at)
  values (p_request_id, nullif(trim(coalesce(p_findings, '')), ''), nullif(trim(coalesce(p_impression, '')), ''),
          case when p_verify then auth.uid() end, case when p_verify then now() end)
  on conflict (service_request_id) do update
  set findings = excluded.findings, impression = excluded.impression,
      verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_at = now();
  update service_request set status = case when p_verify then 'verified'::request_status else 'resulted'::request_status end
  where id = p_request_id;
  -- Tell the doctor who ordered it.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor who sent them.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  if not exists (select 1 from service_request r
                 where r.encounter_id = v_req.encounter_id and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = v_station
                   and r.deleted_at is null and r.status not in ('resulted', 'verified', 'cancelled')) then
    select * into v_q from queue_entry
    where encounter_id = v_req.encounter_id and station = v_station and finished_at is null and deleted_at is null
    order by created_at desc limit 1;
    if found and v_q.return_station is not null then
      update queue_entry set finished_at = now() where id = v_q.id;
      if not exists (select 1 from queue_entry where encounter_id = v_req.encounter_id
                     and station = v_q.return_station and finished_at is null and deleted_at is null) then
        select string_agg(s.name_en, ', ' order by r.created_at) into v_tests
        from service_request r join service s on s.id = r.service_id
        where r.encounter_id = v_req.encounter_id and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = v_station and r.deleted_at is null
          and r.status in ('resulted', 'verified');
        insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
        values (v_req.encounter_id, v_q.return_station, v_q.ticket_no, v_q.priority, v_q.return_to, auth.uid(),
                'Results ready: ' || coalesce(v_tests, v_test, ''));
      end if;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- laboratory: only its own orders
create or replace function lab_worklist(p_scope text default 'open')
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, jsonb_build_object(
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
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by))
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category = any (my_test_categories()) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

create or replace function lab_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (select (now() at time zone 'Africa/Kigali')::date as d),
  mine as (
    select r.*, d.verified_at, d.updated_at as result_at
    from service_request r
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.category = any (my_test_categories()) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound') and has_perm('orders.read')
  )
  select jsonb_build_object(
    'waiting', (select count(*) from mine where status = 'ordered'),
    'inProcess', (select count(*) from mine where status in ('collected', 'in_process')),
    'toVerify', (select count(*) from mine where status = 'resulted'),
    'doneToday', (select count(*) from mine, today
                  where status = 'verified' and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'urgent', (select count(*) from mine where status not in ('verified', 'cancelled') and priority <= 2),
    'orderedToday', (select count(*) from mine, today where (created_at at time zone 'Africa/Kigali')::date = today.d),
    'turnaroundMin', (select coalesce(round(avg(extract(epoch from verified_at - created_at) / 60)), 0)
                      from mine, today
                      where verified_at is not null and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'byTest', coalesce((
      select jsonb_agg(jsonb_build_object('test', t.name, 'count', t.n) order by t.n desc)
      from (select s.name_en as name, count(*) as n
            from mine m join service s on s.id = m.service_id, today
            where (m.created_at at time zone 'Africa/Kigali')::date = today.d
            group by s.name_en order by count(*) desc limit 8) t
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- the visit: each order's desk
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when has_perm('clinical.read') then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by)) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id)
  ) else null end
$$;
