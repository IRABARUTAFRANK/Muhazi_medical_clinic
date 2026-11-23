-- 0197 · No disease codes in what people read
--
-- Frank (testing outcomes, task 7): "in the medical reports or anywhere where this thing of ICD-10
-- is appearing please make sure that it does not appear there again anyhow because it is not needed
-- anywhere in the system."
--
-- The visit has not asked for a code since 0130 (a diagnosis is words). The web no longer shows
-- the word or a code anywhere; four functions still built sentences with an old code inside, or
-- counted by it. Each is taken from its latest definition, every other rule kept:
--
--   report_visit_diagnosis    "Malaria (B54)"            -> "Malaria"   (visits and files reports,
--                                                                        the patients' documents)
--   report_patients_seen      "B54 Malaria; I10 High BP" -> "Malaria; High BP"
--   analytics_staff_events    "B54 Malaria"              -> "Malaria"   (an employee's work, detail)
--   report_diagnoses_staged   one line per code, else per words -> one line per diagnosis as written
--                             (report_diagnoses calls it: nothing to change there)
--
-- Nothing is dropped: condition.icd10_code keeps what was typed before 0130, the functions that
-- return it as a separate value still do (the screens do not show it), and the rules that read it
-- stay (an HIV diagnosis is hidden from people without the right, the long-lasting conditions).
-- No right changes: the same checks at the top of each function. Runs again without harm
-- (create or replace only; the grants of the earlier files stay).

-- ---------------------------------------------------------------- report_visit_diagnosis (from 20270107090000_six_steps): the words only
create or replace function report_visit_diagnosis(p_encounter_id uuid, p_sensitive boolean)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    -- 0197: the diagnosis in words only (was: the words and the code in brackets)
    (select c.text
     from condition c
     where c.encounter_id = p_encounter_id and c.deleted_at is null and c.stage = 'definitive'
       and (p_sensitive or coalesce(c.icd10_code, '') !~ '^B2[0-4]')
     order by (c.type = 'primary') desc, c.created_at
     limit 1),
    (select no_diagnosis_marker(e.no_diagnosis_kind, e.no_diagnosis_note) from encounter e where e.id = p_encounter_id))
$$;

-- ---------------------------------------------------------------- report_patients_seen (from 20270107090000_six_steps): the diagnosis column in words only
create or replace function report_patients_seen(
  p_from date, p_to date, p_clinician uuid default null, p_department uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  -- 0126: the diagnosis column for doctors
  v_doc boolean := is_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  perform report_assert_clinical_reader();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with enc as (
      select e.id, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             e.no_diagnosis_kind, e.no_diagnosis_note
      from encounter e
      where e.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), seen as (
      select q.encounter_id, q.taken_by as clinician_id, min(coalesce(q.started_at, q.created_at)) as seen_at,
             (array_agg(q.station::text order by q.created_at))[1] as station
      from queue_entry q join enc on enc.id = q.encounter_id
      where q.deleted_at is null and q.taken_by is not null
        and q.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds', 'ultrasound')
      group by 1, 2
      union all
      select c.encounter_id, c.created_by, min(c.created_at), null
      from condition c join enc on enc.id = c.encounter_id
      where c.deleted_at is null and c.created_by is not null
        and not exists (select 1 from queue_entry q
                        where q.encounter_id = c.encounter_id and q.deleted_at is null and q.taken_by = c.created_by
                          and q.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds', 'ultrasound'))
      group by 1, 2
    ), r as (
      select s.*, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             e.no_diagnosis_kind, e.no_diagnosis_note,
             visit_departments(e.id) as depts
      from seen s join enc e on e.id = s.encounter_id
    )
    select jsonb_agg(jsonb_build_object(
        'encounterId', r.encounter_id, 'visitAt', r.arrived_at, 'seenAt', r.seen_at, 'reference', r.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number, 'sex', p.sex,
        'age', case when p.birth_date is not null
                    then extract(year from age((r.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end,
        'clinicianId', r.clinician_id, 'clinician', pr.full_name, 'clinicianRole', pr.role, 'desk', r.station,
        'department', (select string_agg(d.name, ', ' order by d.name) from department d where d.id = any (r.depts)),
        -- 0197: the diagnoses in words only (was: each one's code before its words)
        'diagnosis', case when v_doc then coalesce((select string_agg(c.text, '; '
                                        order by (c.type = 'primary') desc, c.created_at)
                      from condition c where c.encounter_id = r.encounter_id and c.deleted_at is null and c.stage = 'definitive'
                        and (v_sens or coalesce(c.icd10_code, '') !~ '^B2[0-4]')),
                      no_diagnosis_marker(r.no_diagnosis_kind, r.no_diagnosis_note)) end,
        -- 0127: the chief complaint (step 1), for doctors
        'complaint', case when v_doc then visit_complaint(r.encounter_id) end,
        'prescriptions', (select count(*) from medication_request m
                          where m.encounter_id = r.encounter_id and m.deleted_at is null and m.cancelled_at is null
                            and coalesce(m.prescriber_id, m.created_by) = r.clinician_id)::integer,
        'tests', (select count(*) from service_request x
                  where x.encounter_id = r.encounter_id and x.deleted_at is null
                    and x.requester_id = r.clinician_id)::integer,
        'outcome', case
            when exists (select 1 from queue_entry q2
                         where q2.encounter_id = r.encounter_id and q2.deleted_at is null
                           and q2.referred_by = r.clinician_id and q2.taken_by is distinct from r.clinician_id
                           and q2.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds')) then 'referred'
            when r.status = 'open' and r.clinical_done_at is null then 'open'
            when r.left_reason is not null
                 or (r.clinical_done_at is null and r.no_diagnosis_kind is null
                     and not exists (select 1 from condition c where c.encounter_id = r.encounter_id
                                     and c.deleted_at is null and c.type = 'primary')) then 'left'
            else 'finished' end
      ) order by r.arrived_at desc, p.surname, pr.full_name)
    from r
    join patient p on p.id = r.patient_id
    join profiles pr on pr.id = r.clinician_id
    where (v_mgr or r.clinician_id = v_me or r.depts && v_heads)
      and (p_clinician is null or r.clinician_id = p_clinician)
      and (p_department is null or p_department = any (r.depts))
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- analytics_staff_events (from 20261210090000_outside_prescriptions): a diagnosis reads in words only
create or replace function analytics_staff_events(p_start timestamptz, p_end timestamptz, p_money boolean)
returns table (user_id uuid, at timestamptz, kind text, encounter_id uuid, patient_id uuid, amount numeric, what text)
language sql stable security definer set search_path = public
as $$
  -- registered
  select x.created_by, x.created_at, 'registered', null::uuid, x.id, null::numeric, null::text
  from patient x
  where x.deleted_at is null and x.created_by is not null and x.created_at >= p_start and x.created_at < p_end
  union all
  -- vitals, one per visit
  select v.u, v.at, 'vitals', v.enc, e.patient_id, null, null
  from (select o.performer_id as u, o.encounter_id as enc, min(o.effective_at) as at
        from observation o
        where o.deleted_at is null and o.code <> 'note' and o.performer_id is not null
          and o.effective_at >= p_start and o.effective_at < p_end
        group by 1, 2) v
  join encounter e on e.id = v.enc
  union all
  -- patients seen: took the patient from a queue, or wrote on the visit
  select s.u, s.at, 'patientsSeen', s.enc, e.patient_id, null, e.reference
  from (select a.u, a.enc, min(a.at) as at
        from (
          select q.taken_by as u, q.encounter_id as enc, coalesce(q.started_at, q.finished_at, q.created_at) as at
          from queue_entry q where q.deleted_at is null and q.taken_by is not null
          union all
          select c.created_by, c.encounter_id, c.created_at from condition c where c.deleted_at is null
          union all
          select m.prescriber_id, m.encounter_id, m.created_at from medication_request m where m.deleted_at is null
          union all
          select r.requester_id, r.encounter_id, r.created_at from service_request r where r.deleted_at is null
          union all
          select o.performer_id, o.encounter_id, o.effective_at from observation o where o.deleted_at is null and o.code = 'note'
          union all
          select x.performer_id, x.encounter_id, coalesce(x.performed_at, x.created_at) from procedure x where x.deleted_at is null
        ) a
        where a.u is not null and a.enc is not null and a.at >= p_start and a.at < p_end
        group by 1, 2) s
  join encounter e on e.id = s.enc
  union all
  -- diagnoses
  -- 0197: in words only (was: the code before the words)
  select c.created_by, c.created_at, 'diagnoses', c.encounter_id, e.patient_id, null,
         trim(coalesce(c.text, ''))
  from condition c join encounter e on e.id = c.encounter_id
  where c.deleted_at is null and c.created_by is not null and c.created_at >= p_start and c.created_at < p_end
  union all
  -- prescriptions
  select m.prescriber_id, m.created_at, 'prescriptions', m.encounter_id, e.patient_id, null,
         coalesce(item_label(m.item_id), m.medicine_name) || coalesce(' · ' || nullif(m.dose, ''), '')
  from medication_request m join encounter e on e.id = m.encounter_id
  where m.deleted_at is null and m.prescriber_id is not null and m.created_at >= p_start and m.created_at < p_end
  union all
  -- test orders
  select r.requester_id, r.created_at, 'orders', r.encounter_id, e.patient_id, null, sv.name_en
  from service_request r join encounter e on e.id = r.encounter_id left join service sv on sv.id = r.service_id
  where r.deleted_at is null and r.requester_id is not null and r.created_at >= p_start and r.created_at < p_end
  union all
  -- results (verified, else typed)
  select coalesce(d.verified_by, d.created_by), coalesce(d.verified_at, d.created_at), 'results', r.encounter_id, e.patient_id, null, sv.name_en
  from diagnostic_report d
  join service_request r on r.id = d.service_request_id
  join encounter e on e.id = r.encounter_id
  left join service sv on sv.id = r.service_id
  where d.deleted_at is null and coalesce(d.verified_by, d.created_by) is not null
    and coalesce(d.verified_at, d.created_at) >= p_start and coalesce(d.verified_at, d.created_at) < p_end
  union all
  -- procedures
  select x.performer_id, coalesce(x.performed_at, x.created_at), 'procedures', x.encounter_id, e.patient_id, null, sv.name_en
  from procedure x join encounter e on e.id = x.encounter_id left join service sv on sv.id = x.service_id
  where x.deleted_at is null and x.performer_id is not null
    and coalesce(x.performed_at, x.created_at) >= p_start and coalesce(x.performed_at, x.created_at) < p_end
  union all
  -- medicines given: handed over at the pharmacy …
  select md.dispenser_id, md.created_at, 'medicinesGiven', md.encounter_id, e.patient_id, null,
         item_label(md.item_id) || ' × ' || trim_scale(md.quantity)::text
  from medication_dispense md left join encounter e on e.id = md.encounter_id
  where md.deleted_at is null and md.dispenser_id is not null and md.created_at >= p_start and md.created_at < p_end
  union all
  -- … and given from a room store (a pharmacy hand-over also sets given_by: it is counted above,
  -- through its medication_dispense row, so only requests without one come from here)
  select m.given_by, m.given_at, 'medicinesGiven', m.encounter_id, e.patient_id, null, coalesce(item_label(m.item_id), m.medicine_name)
  from medication_request m join encounter e on e.id = m.encounter_id
  where m.deleted_at is null and m.given_by is not null and m.given_at >= p_start and m.given_at < p_end
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
  union all
  -- charges
  select l.entered_by, l.created_at, 'charges', i.encounter_id, e.patient_id, round(l.unit_price * l.quantity), l.description
  from invoice_line l join invoice i on i.id = l.invoice_id left join encounter e on e.id = i.encounter_id
  where l.deleted_at is null and l.entered_by is not null and l.created_at >= p_start and l.created_at < p_end
  union all
  -- admissions
  select b.created_by, coalesce(b.admitted_at, b.created_at), 'admissions', b.encounter_id, e.patient_id, null, bd.name
  from bed_stay b join encounter e on e.id = b.encounter_id left join bed bd on bd.id = b.bed_id
  where b.deleted_at is null and b.created_by is not null
    and coalesce(b.admitted_at, b.created_at) >= p_start and coalesce(b.admitted_at, b.created_at) < p_end
  union all
  -- tasks done
  select k.done_by, k.done_at, 'tasksDone', k.encounter_id, k.patient_id, null, k.title
  from internal_task k
  where k.deleted_at is null and k.done_by is not null and k.done_at >= p_start and k.done_at < p_end
  union all
  select v.created_by, v.created_at, 'vaccinations', v.encounter_id, v.patient_id, null, v.vaccine
  from vaccination v
  where v.deleted_at is null and v.created_by is not null and v.created_at >= p_start and v.created_at < p_end
  union all
  -- an HIV test: never its result
  select h.created_by, coalesce(h.tested_at, h.created_at), 'hivTests', h.encounter_id, h.patient_id, null, null
  from hiv_test h
  where h.deleted_at is null and h.created_by is not null
    and coalesce(h.tested_at, h.created_at) >= p_start and coalesce(h.tested_at, h.created_at) < p_end
  union all
  select f.created_by, f.created_at, 'familyPlanning', f.encounter_id, f.patient_id, null, f.method
  from fp_event f
  where f.deleted_at is null and f.created_by is not null and f.created_at >= p_start and f.created_at < p_end
  union all
  -- money (the manager only)
  select y.cashier_id, y.paid_at, 'payments', i.encounter_id, e.patient_id, y.amount, y.method::text
  from payment y left join invoice i on i.id = y.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and y.deleted_at is null and y.cashier_id is not null and y.paid_at >= p_start and y.paid_at < p_end
  union all
  select rf.cashier_id, rf.refunded_at, 'refunds', i.encounter_id, e.patient_id, rf.amount, rf.reason
  from refund rf join invoice i on i.id = rf.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and rf.deleted_at is null and rf.cashier_id is not null and rf.refunded_at >= p_start and rf.refunded_at < p_end
  union all
  select y.voided_by, y.voided_at, 'voided', i.encounter_id, e.patient_id, y.amount, y.void_reason
  from payment y left join invoice i on i.id = y.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and y.voided_by is not null and y.voided_at >= p_start and y.voided_at < p_end
  union all
  select cs.handed_over_by, cs.handed_over_at, 'handovers', null, null, cs.total, cs.number
  from counter_sale cs
  where p_money and cs.deleted_at is null and cs.handed_over_by is not null
    and cs.handed_over_at >= p_start and cs.handed_over_at < p_end
$$;

-- ---------------------------------------------------------------- report_diagnoses_staged (from 20270212090000_diagnosis_ticks): one line per diagnosis as written
create or replace function report_diagnoses_staged(
  p_from date, p_to date, p_department uuid default null, p_doctor uuid default null,
  -- 0127: 'definitive' (the default), 'differential' or 'all'
  p_stage text default 'definitive'
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
begin
  perform report_assert_clinical();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with c as (
      select c.encounter_id, upper(nullif(trim(c.icd10_code), '')) as code, trim(c.text) as text, c.type,
             c.created_by, e.patient_id, e.arrived_at, p.sex::text as sex,
             case when p.birth_date is not null
                  then extract(year from age((e.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end
               as age,
             visit_departments(e.id) as depts,
             -- 0192: what the doctor decided. A definitive diagnosis is confirmed; a possible one is
             -- confirmed when he ticked it in step 5 (a standing definitive one points at it), not
             -- confirmed when he saved step 5 with it unticked, otherwise not decided: never the words
             c.stage,
             case when c.stage = 'definitive' then 'confirmed'
                  when exists (select 1 from condition x where x.differential_id = c.id and x.deleted_at is null)
                    then 'confirmed'
                  when exists (select 1 from diagnosis_not_confirmed n
                               where n.condition_id = c.id and n.deleted_at is null) then 'not_confirmed'
                  else 'not_decided' end as outcome
      from condition c
      join encounter e on e.id = c.encounter_id and e.deleted_at is null
      join patient p on p.id = e.patient_id
      where c.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
        and (coalesce(p_stage, 'definitive') = 'all' or c.stage = coalesce(p_stage, 'definitive'))
      -- 0125: a visit finished with no diagnosis found counts under its reason
      union all
      select e.id, null::text, no_diagnosis_marker(e.no_diagnosis_kind, null), 'primary'::condition_type,
             e.no_diagnosis_by, e.patient_id, e.arrived_at, p.sex::text,
             case when p.birth_date is not null
                  then extract(year from age((e.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end,
             visit_departments(e.id), null::text, null::text
      from encounter e
      join patient p on p.id = e.patient_id
      where e.deleted_at is null and e.no_diagnosis_kind is not null
        and coalesce(p_stage, 'definitive') <> 'differential'
        and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), v as (
      -- 0197: a diagnosis is its words: one line per diagnosis as written, whatever the capitals
      -- (was: one line per code, else per words; an old code no longer splits or joins lines)
      select c.*, lower(c.text) as k,
             exists (select 1 from condition c2 join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                     where e2.patient_id = c.patient_id and e2.arrived_at < c.arrived_at and c2.deleted_at is null
                       and c2.stage = 'definitive'
                       -- 0197: the same words on an earlier visit (was: the same code, else words)
                       and lower(trim(c2.text)) = lower(c.text)) as follow_up
      from c
      where (v_mgr or c.created_by = v_me or c.depts && v_heads)
        and (p_doctor is null or c.created_by = p_doctor)
        and (p_department is null or p_department = any (c.depts))
    ), s as (
      -- 0192: one state per diagnosis and visit: confirmed first, then not confirmed, then not decided
      select v.k, v.encounter_id,
             case when bool_or(v.outcome = 'confirmed') then 'confirmed'
                  when bool_or(v.outcome = 'not_confirmed') then 'not_confirmed'
                  when bool_or(v.outcome = 'not_decided') then 'not_decided' end as state
      from v group by v.k, v.encounter_id
    ), st as (
      select s.k, bool_or(s.state is not null) as stated,
             count(*) filter (where s.state = 'confirmed')::integer as conf,
             count(*) filter (where s.state = 'not_confirmed')::integer as not_conf,
             count(*) filter (where s.state = 'not_decided')::integer as not_dec
      from s group by s.k
    )
    select jsonb_agg(jsonb_build_object(
        'code', x.code, 'diagnosis', x.text, 'cases', x.cases, 'patients', x.patients,
        'newCases', x.new_cases, 'followUp', x.follow_up, 'primary', x.prim,
        'female', x.female, 'male', x.male, 'otherSex', x.cases - x.female - x.male,
        'age0to4', x.a0, 'age5to14', x.a5, 'age15to24', x.a15, 'age25to49', x.a25, 'age50plus', x.a50,
        'ageUnknown', x.au,
        -- 0192: the three add up to the cases of a diagnosis; a "no diagnosis" line has none
        'confirmed', case when st.stated then st.conf end,
        'notConfirmed', case when st.stated then st.not_conf end,
        'notDecided', case when st.stated then st.not_dec end
      ) order by x.cases desc, x.text)
    from (
      select v.k, min(v.code) as code, mode() within group (order by v.text) as text,
             count(distinct v.encounter_id)::integer as cases,
             count(distinct v.patient_id)::integer as patients,
             count(distinct v.encounter_id) filter (where not v.follow_up)::integer as new_cases,
             count(distinct v.encounter_id) filter (where v.follow_up)::integer as follow_up,
             count(distinct v.encounter_id) filter (where v.type = 'primary')::integer as prim,
             count(distinct v.encounter_id) filter (where v.sex = 'female')::integer as female,
             count(distinct v.encounter_id) filter (where v.sex = 'male')::integer as male,
             count(distinct v.encounter_id) filter (where v.age < 5)::integer as a0,
             count(distinct v.encounter_id) filter (where v.age between 5 and 14)::integer as a5,
             count(distinct v.encounter_id) filter (where v.age between 15 and 24)::integer as a15,
             count(distinct v.encounter_id) filter (where v.age between 25 and 49)::integer as a25,
             count(distinct v.encounter_id) filter (where v.age >= 50)::integer as a50,
             count(distinct v.encounter_id) filter (where v.age is null)::integer as au
      from v group by v.k
    ) x
    left join st on st.k = x.k
  ), '[]'::jsonb);
end
$$;
