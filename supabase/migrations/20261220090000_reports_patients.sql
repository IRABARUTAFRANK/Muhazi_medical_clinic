-- 0110 · Report centre: the patients reports.
--
-- The owner: "The manager must be able to print all patients' names and other columns, filtered
-- as he wants, e.g. which patients visited the clinic in this period, and choose the columns."
-- The report centre (/app/reports) prints every report as a table; these functions give it the
-- rows of the three patients reports. Each checks the rights again (a report never shows more
-- than the screens do), works in Kigali days, and returns its rows as jsonb.
--
--   * A  PATIENTS WHO VISITED (report_patients_visited): one row per patient with a visit in the
--        period: identity (national ID masked except for the manager), address, insurer, first
--        and last visit, number of visits, the departments and desks visited, the doctors seen,
--        new or returning, the clinic's own fields (patient.fields; the private ones only to the
--        manager and the heads in charge of the patient), and, when asked (p_clinical), the
--        diagnoses of the visits whose record the reader may see.
--   * B  VISITS (report_visits): one row per visit: number, time, patient, age at the visit, sex,
--        type, route (the desks in order), doctor, triage colour, status (open / finished / left
--        before being seen), insurer, the money (billed, insurer and patient shares, paid,
--        balance: the manager and whoever reads the bills only) and, when asked, the primary
--        diagnosis.
--        A and B: the manager (the whole clinic or one department); a head or assistant head of a
--        department, their department's visits (analytics_scope, as Analytics and the patients'
--        documents); everyone else is refused. A diagnosis is given only for a visit the reader
--        may see (visit_view, 0088: the manager, the head in charge, the clinician who treated
--        it); an HIV diagnosis only with sensitive.read; every closed visit whose diagnosis is
--        given is written in the access log ('visit'), as the patients' documents do.
--   * C  NEW REGISTRATIONS (report_new_registrations): the files created in the period: identity,
--        address, ID document present, registered by and when, the required fields still missing
--        (patient_missing_with, 0108). The manager, the heads and assistants, and reception (the
--        receptionist role): identity only (level 1), no clinical data.
--   * D  report_patients_options(): the filters' choices (departments, doctors, services,
--        insurers, districts, who registered files) for whoever may run one of these reports.
--
-- Errcodes: 42501 not allowed (not signed in, not the manager / a head / reception).

-- ---------------------------------------------------------------- helpers
-- An ID number shown masked ("11••••••••••312"): the manager sees it whole.
create or replace function report_mask_id(p text)
returns text
language sql immutable
as $$
  select case when p is null or length(p) < 6 then p
              else left(p, 2) || repeat('•', length(p) - 5) || right(p, 3) end
$$;

-- The age band of the reports: under 5, 5–14, 15–24, 25–49, 50–64, 65 and over.
create or replace function report_age_band(p_age integer)
returns text
language sql immutable
as $$
  select case when p_age is null then null
              when p_age < 5 then 'u5' when p_age < 15 then '5-14' when p_age < 25 then '15-24'
              when p_age < 50 then '25-49' when p_age < 65 then '50-64' else '65+' end
$$;

-- The visits of a period the reader may count, with what the reports print about each: status,
-- department, doctor, insurer, the desks in order, first visit ever. analytics_scope refuses
-- everyone but the manager and the heads (and assistants) of a department, and limits a head to
-- their department. Visit filters (p_f): department, desk, doctor, service, insurer, status.
create or replace function report_visit_set(p_from date, p_to date, p_f jsonb)
returns table (
  encounter_id uuid,
  reference text,
  arrived_at timestamptz,
  closed_at timestamptz,
  status text,
  visit_type text,
  triage text,
  service text,
  patient_id uuid,
  department_id uuid,
  department text,
  doctor_id uuid,
  doctor text,
  insurer_id uuid,
  insurer text,
  stations text[],
  first_visit boolean
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  s record;
  v_dep uuid := nullif(p_f ->> 'department', '')::uuid;
  v_desk text := nullif(p_f ->> 'desk', '');
  v_doctor uuid := nullif(p_f ->> 'doctor', '')::uuid;
  v_service text := nullif(p_f ->> 'service', '');
  v_insurer uuid := nullif(p_f ->> 'insurer', '')::uuid;
  v_status text := nullif(p_f ->> 'status', '');
begin
  select * into s from analytics_scope(v_dep);
  return query
  with base as (
    select e.id as encounter_id, e.reference, e.arrived_at, e.closed_at,
           case when e.status = 'open' then 'open'
                when visit_was_seen(e.id) then 'finished'
                else 'left_unseen' end as status,
           e.type::text as visit_type, e.triage_level::text as triage, e.service, e.patient_id,
           d.id as department_id, d.name as department,
           doc.id as doctor_id, doc.full_name as doctor,
           ins.id as insurer_id, ins.name as insurer,
           coalesce((select array_agg(x.station::text order by x.first_at)
                     from (select q.station, min(q.created_at) as first_at from queue_entry q
                           where q.encounter_id = e.id and q.deleted_at is null
                           group by q.station) x), '{}'::text[]) as stations,
           not exists (select 1 from encounter e0
                       where e0.patient_id = e.patient_id and e0.deleted_at is null
                         and e0.arrived_at < e.arrived_at) as first_visit
    from encounter e
    left join lateral (
      select q.department_id from queue_entry q
      where q.encounter_id = e.id and q.deleted_at is null and q.department_id is not null
      order by q.created_at desc limit 1
    ) qd on true
    left join department d on d.id = qd.department_id
    left join lateral (
      select pr.id, pr.full_name from profiles pr
      where pr.id = coalesce(
        (select c0.created_by from condition c0 where c0.encounter_id = e.id and c0.deleted_at is null
         order by c0.created_at limit 1),
        (select q.taken_by from queue_entry q
         where q.encounter_id = e.id and q.deleted_at is null and q.taken_by is not null
           and q.station not in ('reception', 'triage', 'cashier', 'pharmacy')
         order by coalesce(q.started_at, q.created_at) limit 1))
    ) doc on true
    left join lateral (
      select py.id, py.name from coverage cv
      join payer py on py.id = cv.payer_id and py.type <> 'cash'
      where cv.id = coalesce((select i.coverage_id from invoice i where i.encounter_id = e.id and i.deleted_at is null limit 1),
                             e.coverage_id)
    ) ins on true
    where e.deleted_at is null
      and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (s.s_department is null or exists (
        select 1 from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
          and (q.department_id = s.s_department or q.station = any (s.s_stations))))
  )
  select b.encounter_id, b.reference, b.arrived_at, b.closed_at, b.status, b.visit_type, b.triage,
         b.service, b.patient_id, b.department_id, b.department, b.doctor_id, b.doctor,
         b.insurer_id, b.insurer, b.stations, b.first_visit
  from base b
  where (v_desk is null or v_desk = any (b.stations))
    and (v_doctor is null or b.doctor_id = v_doctor)
    and (v_service is null or b.service = v_service)
    and (v_insurer is null or b.insurer_id = v_insurer)
    and (v_status is null or b.status = v_status);
end
$$;
revoke all on function report_visit_set(date, date, jsonb) from public, anon, authenticated;

-- The primary diagnosis of a visit as the reader may see it (null: none, or not theirs to see).
create or replace function report_visit_diagnosis(p_encounter_id uuid, p_sensitive boolean)
returns text
language sql stable security definer set search_path = public
as $$
  select c.text || coalesce(' (' || c.icd10_code || ')', '')
  from condition c
  where c.encounter_id = p_encounter_id and c.deleted_at is null
    and (p_sensitive or coalesce(c.icd10_code, '') !~ '^B2[0-4]')
  order by (c.type = 'primary') desc, c.created_at
  limit 1
$$;
revoke all on function report_visit_diagnosis(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- A patients who visited
create or replace function report_patients_visited(
  p_from date default null,
  p_to date default null,
  p_filters jsonb default '{}'::jsonb,
  p_clinical boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_manager boolean := is_manager();
  v_sex text := nullif(v_f ->> 'sex', '');
  v_band text := nullif(v_f ->> 'ageBand', '');
  v_kind text := nullif(v_f ->> 'kind', '');
  v_district text := nullif(trim(coalesce(v_f ->> 'district', '')), '');
  v_q text := nullif(trim(coalesce(v_f ->> 'search', '')), '');
  v_sensitive boolean := has_perm('sensitive.read');
  v_private text[] := private_extra_keys();
  v_rows jsonb;
  v_count integer;
  r record;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with v as (
    select x.*,
           -- how the reader sees the visit's record (asked only for the diagnoses)
           case when p_clinical then visit_view(x.encounter_id) end as via
    from report_visit_set(v_from, v_to, v_f) x
  ),
  per as (
    select v.patient_id,
           min(v.arrived_at) as first_at, max(v.arrived_at) as last_at,
           count(distinct v.encounter_id)::int as visits,
           bool_or(v.first_visit) as is_new,
           array_remove(array_agg(distinct v.department), null) as departments,
           array_remove(array_agg(distinct s.station), null) as desks,
           array_remove(array_agg(distinct v.doctor), null) as doctors,
           (array_agg(v.insurer order by v.arrived_at desc) filter (where v.insurer is not null))[1] as insurer,
           case when p_clinical then
             array_remove(array_agg(distinct case when v.via is not null
                                                  then report_visit_diagnosis(v.encounter_id, v_sensitive) end), null)
           end as diagnoses
    from v
    left join lateral unnest(v.stations) as s(station) on true
    group by v.patient_id
  ),
  pt as (
    select p.*, per.first_at, per.last_at, per.visits, per.is_new, per.departments, per.desks,
           per.doctors, per.insurer, per.diagnoses,
           extract(year from age(v_to, p.birth_date))::int as age_years
    from per join patient p on p.id = per.patient_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'patientId', pt.id,
      'fileNumber', pt.file_number,
      'surname', pt.surname,
      'givenNames', pt.given_names,
      'sex', pt.sex::text,
      'age', pt.age_years,
      'ageBand', report_age_band(pt.age_years),
      'birthDate', pt.birth_date,
      'phone', pt.phone_1,
      'phone2', pt.phone_2,
      'nationalId', case when v_manager then coalesce(pt.national_id, pt.id_number)
                         else report_mask_id(coalesce(pt.national_id, pt.id_number)) end,
      'province', pt.province,
      'district', pt.district,
      'sector', pt.sector,
      'cell', pt.cell,
      'village', pt.village,
      'insurer', pt.insurer,
      'firstVisit', pt.first_at,
      'lastVisit', pt.last_at,
      'visits', pt.visits,
      'isNew', pt.is_new,
      'departments', to_jsonb(pt.departments),
      'desks', to_jsonb(pt.desks),
      'doctors', to_jsonb(pt.doctors),
      'diagnoses', case when p_clinical then to_jsonb(coalesce(pt.diagnoses, '{}'::text[])) end,
      -- the clinic's own fields; the private ones to the manager and the heads in charge only
      'extra', case
        when v_manager then coalesce(pt.extra, '{}'::jsonb)
        when p_clinical and history_via(pt.id) is not null then coalesce(pt.extra, '{}'::jsonb)
        else coalesce(pt.extra, '{}'::jsonb) - v_private end
    ) order by lower(pt.surname), lower(pt.given_names), pt.file_number), '[]'::jsonb),
    count(*)::int
  into v_rows, v_count
  from (
    select * from pt
    where (v_sex is null or pt.sex::text = v_sex)
      and (v_band is null or report_age_band(pt.age_years) = v_band)
      and (v_kind is null or (v_kind = 'new') = pt.is_new)
      and (v_district is null or lower(coalesce(pt.district, '')) = lower(v_district))
      and (v_q is null or (pt.surname || ' ' || pt.given_names) ilike '%' || v_q || '%'
           or (pt.given_names || ' ' || pt.surname) ilike '%' || v_q || '%'
           or coalesce(pt.file_number, '') ilike '%' || v_q || '%'
           or coalesce(pt.phone_1, '') ilike '%' || v_q || '%')
    order by lower(pt.surname), lower(pt.given_names), pt.file_number
    limit 5000
  ) pt;

  -- the diagnoses of past visits were read: one line per visit in the access log (0088)
  if p_clinical then
    for r in
      select x.patient_id, x.encounter_id, visit_view(x.encounter_id) as via
      from report_visit_set(v_from, v_to, v_f) x
      where x.status <> 'open'
        and x.patient_id in (select (j ->> 'patientId')::uuid from jsonb_array_elements(v_rows) j)
        and exists (select 1 from condition c where c.encounter_id = x.encounter_id and c.deleted_at is null)
    loop
      if r.via is not null then
        perform log_record_access(r.patient_id, r.encounter_id, r.via, 'visit');
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', v_manager,
    'count', v_count,
    'truncated', v_count >= 5000,
    'rows', v_rows);
end
$$;
revoke all on function report_patients_visited(date, date, jsonb, boolean) from public, anon;
grant execute on function report_patients_visited(date, date, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------- B visits
create or replace function report_visits(
  p_from date default null,
  p_to date default null,
  p_filters jsonb default '{}'::jsonb,
  p_clinical boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_manager boolean := is_manager();
  v_money boolean := is_manager() or has_perm('billing.read');
  v_sex text := nullif(v_f ->> 'sex', '');
  v_band text := nullif(v_f ->> 'ageBand', '');
  v_kind text := nullif(v_f ->> 'kind', '');
  v_district text := nullif(trim(coalesce(v_f ->> 'district', '')), '');
  v_q text := nullif(trim(coalesce(v_f ->> 'search', '')), '');
  v_sensitive boolean := has_perm('sensitive.read');
  v_rows jsonb;
  v_count integer;
  r record;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with v as (
    select x.*, p.surname || ' ' || p.given_names as patient, p.file_number, p.sex::text as sex,
           p.district, p.phone_1,
           extract(year from age((x.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::int as age_years,
           case when p_clinical then visit_view(x.encounter_id) end as via,
           i.id as invoice_id, i.total, i.insurer_share, i.patient_share
    from report_visit_set(v_from, v_to, v_f) x
    join patient p on p.id = x.patient_id
    left join invoice i on i.encounter_id = x.encounter_id and i.deleted_at is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.encounter_id,
      'reference', v.reference,
      'at', v.arrived_at,
      'closedAt', v.closed_at,
      'status', v.status,
      'type', v.visit_type,
      'service', v.service,
      'triage', v.triage,
      'patientId', v.patient_id,
      'patient', v.patient,
      'fileNumber', v.file_number,
      'sex', v.sex,
      'age', v.age_years,
      'ageBand', report_age_band(v.age_years),
      'district', v.district,
      'route', to_jsonb(v.stations),
      'department', v.department,
      'doctor', v.doctor,
      'insurer', v.insurer,
      'isNew', v.first_visit,
      'diagnosis', case when p_clinical and v.via is not null
                        then report_visit_diagnosis(v.encounter_id, v_sensitive) end,
      'billed', case when v_money then coalesce(v.total, 0) end,
      'insurerShare', case when v_money then coalesce(v.insurer_share, 0) end,
      'patientShare', case when v_money then coalesce(v.patient_share, 0) end,
      'paid', case when v_money then
          coalesce((select sum(pa.amount) from payment pa where pa.invoice_id = v.invoice_id and pa.deleted_at is null), 0)
          - coalesce((select sum(rf.amount) from refund rf where rf.invoice_id = v.invoice_id and rf.deleted_at is null), 0) end,
      'balance', case when v_money then coalesce(invoice_balance(v.invoice_id), 0) end
    ) order by v.arrived_at, v.encounter_id), '[]'::jsonb),
    count(*)::int
  into v_rows, v_count
  from (
    select * from v
    where (v_sex is null or v.sex = v_sex)
      and (v_band is null or report_age_band(v.age_years) = v_band)
      and (v_kind is null or (v_kind = 'new') = v.first_visit)
      and (v_district is null or lower(coalesce(v.district, '')) = lower(v_district))
      and (v_q is null or v.patient ilike '%' || v_q || '%'
           or coalesce(v.file_number, '') ilike '%' || v_q || '%'
           or coalesce(v.reference, '') ilike '%' || v_q || '%'
           or coalesce(v.phone_1, '') ilike '%' || v_q || '%')
    order by v.arrived_at, v.encounter_id
    limit 5000
  ) v;

  -- the diagnoses of past visits were read: one line per visit in the access log (0088)
  if p_clinical then
    for r in
      select x.patient_id, x.encounter_id, visit_view(x.encounter_id) as via
      from report_visit_set(v_from, v_to, v_f) x
      where x.status <> 'open'
        and x.encounter_id in (select (j ->> 'id')::uuid from jsonb_array_elements(v_rows) j
                               where j ->> 'diagnosis' is not null)
    loop
      if r.via is not null then
        perform log_record_access(r.patient_id, r.encounter_id, r.via, 'visit');
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', v_manager,
    'money', v_money,
    'count', v_count,
    'truncated', v_count >= 5000,
    'rows', v_rows);
end
$$;
revoke all on function report_visits(date, date, jsonb, boolean) from public, anon;
grant execute on function report_visits(date, date, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------- C new registrations
-- May run the registrations report: the manager, a head or assistant of a department, reception.
create or replace function report_registrations_reader()
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and (
    is_manager()
    or current_role_key() = 'receptionist'
    or exists (select 1 from staff_department sd
               join department d on d.id = sd.department_id and d.deleted_at is null
               join profiles p on p.id = sd.profile_id and p.active
               where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant')))
$$;
revoke all on function report_registrations_reader() from public, anon, authenticated;

create or replace function report_new_registrations(
  p_from date default null,
  p_to date default null,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_manager boolean := is_manager();
  v_by uuid := nullif(v_f ->> 'registeredBy', '')::uuid;
  v_missing boolean := coalesce((v_f ->> 'missingOnly')::boolean, false);
  v_sex text := nullif(v_f ->> 'sex', '');
  v_q text := nullif(trim(coalesce(v_f ->> 'search', '')), '');
  v_rows jsonb;
  v_count integer;
begin
  if not report_registrations_reader() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with st as (select patient_builtins() as b, patient_fields() as f),
  x as (
    select p.*, rb.full_name as registered_by,
           extract(year from age(v_to, p.birth_date))::int as age_years,
           patient_missing_with(p, st.b, st.f) as missing,
           patient_has_id(p) as has_id
    from patient p
    cross join st
    left join profiles rb on rb.id = p.created_by
    where p.deleted_at is null and p.merged_into is null
      and (p.created_at at time zone 'Africa/Kigali')::date between v_from and v_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'patientId', x.id,
      'fileNumber', x.file_number,
      'surname', x.surname,
      'givenNames', x.given_names,
      'sex', x.sex::text,
      'age', x.age_years,
      'birthDate', x.birth_date,
      'phone', x.phone_1,
      'district', x.district,
      'sector', x.sector,
      'cell', x.cell,
      'village', x.village,
      'hasId', x.has_id,
      'idType', x.id_type,
      'registeredById', x.created_by,
      'registeredBy', x.registered_by,
      'registeredAt', x.created_at,
      'missing', to_jsonb(x.missing)
    ) order by x.created_at, x.file_number), '[]'::jsonb),
    count(*)::int
  into v_rows, v_count
  from (
    select * from x
    where (v_by is null or x.created_by = v_by)
      and (not v_missing or cardinality(x.missing) > 0)
      and (v_sex is null or x.sex::text = v_sex)
      and (v_q is null or (x.surname || ' ' || x.given_names) ilike '%' || v_q || '%'
           or coalesce(x.file_number, '') ilike '%' || v_q || '%'
           or coalesce(x.phone_1, '') ilike '%' || v_q || '%')
    order by x.created_at, x.file_number
    limit 5000
  ) x;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', v_manager,
    'count', v_count,
    'truncated', v_count >= 5000,
    'rows', v_rows);
end
$$;
revoke all on function report_new_registrations(date, date, jsonb) from public, anon;
grant execute on function report_new_registrations(date, date, jsonb) to authenticated;

-- ---------------------------------------------------------------- D the filters' choices
create or replace function report_patients_options()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
begin
  if not report_registrations_reader() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    -- the manager: every department (a closed one still has its past visits), the active first;
    -- a head: their own (as analytics_scope reads them)
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name)
                       order by d.active desc, d.sort_order, d.name)
      from department d
      where d.deleted_at is null
        and case when v_manager then true
                 else exists (select 1 from staff_department sd
                              where sd.department_id = d.id and sd.profile_id = auth.uid()
                                and sd.position in ('head', 'assistant')) end), '[]'::jsonb),
    'doctors', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name)
      from profiles p
      where p.active and p.deleted_at is null and p.role in ('doctor', 'sonographer')), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(x.service order by x.service)
      from (select distinct e.service from encounter e
            where e.service is not null and e.deleted_at is null) x), '[]'::jsonb),
    'insurers', coalesce((
      select jsonb_agg(jsonb_build_object('id', py.id, 'name', py.name) order by py.name)
      from payer py where py.type <> 'cash' and py.deleted_at is null), '[]'::jsonb),
    'districts', coalesce((
      select jsonb_agg(x.district order by x.district)
      from (select distinct initcap(trim(p.district)) as district from patient p
            where nullif(trim(coalesce(p.district, '')), '') is not null and p.deleted_at is null) x), '[]'::jsonb),
    'registrars', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name) order by pr.full_name)
      from profiles pr
      where pr.id in (select distinct p.created_by from patient p where p.created_by is not null)), '[]'::jsonb));
end
$$;
revoke all on function report_patients_options() from public, anon;
grant execute on function report_patients_options() to authenticated;
