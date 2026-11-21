-- 0192 · Step 5: the doctor ticks the possible diagnoses that are confirmed (one, several or none),
-- writes any other one, and saves once; "Confirmed", "Not confirmed" and "Not decided" are always the
-- doctor's own saved act, never something the system works out from the words.
--
-- Frank (owner): "In the patient file when a doctor is taking care of aptient and in the part of
-- differential diagnosis and definitive diagnosis when adoctor identied differential diagnosis and
-- after he identies the definitive diagnosis he must be able to see the differential diagnosis and
-- tocks them as aconmfirmed diagnossi the aptient had or one of the one that where identified and if
-- there are more than two it must also be possible or if there is none he must eb able to add any
-- other definitive diagnosis and he is bale to send it and save it so that when making areport and
-- identifying that conmfimred or not it must eb athign which was done by us not done by the syetm in
-- away which is noit understandable."
--
-- What this file does, in plain words:
--   * save_definitive_diagnoses(): step 5 in one save, all or nothing. The doctor sends the possible
--     diagnoses (step 3) he ticked as confirmed, the ones he left unticked, and the other diagnoses
--     he typed. A ticked one gets its definitive diagnosis linked to it (confirm_differential, as
--     before 0192); an unticked one is written down as "not confirmed" with his name and the time;
--     a typed one is a new definitive diagnosis. The first definitive diagnosis of the visit is still
--     the main (primary) one (0130).
--   * The three states of a possible diagnosis:
--       Confirmed      a standing definitive diagnosis points at it (condition.differential_id):
--                      the doctor ticked it (or pressed the older Confirm of step 3);
--       Not confirmed  the doctor saved step 5 with it unticked (a diagnosis_not_confirmed row);
--       Not decided    nobody saved step 5 for it yet (an open visit, one written after the save,
--                      and every possible diagnosis of before 0192). Nothing is filled in for old
--                      visits: the system never decides it, and never by the words.
--   * A typed diagnosis with the words of a possible one the doctor can see is refused: "tick it
--     instead", or "already confirmed" when it is. An HIV line (B20–B24) hidden from him is never
--     named in that refusal.
--   * A "not confirmed" one ticked later is confirmed and its mark is taken back (soft delete: the
--     change log keeps both). A confirmed one is taken back by removing its definitive diagnosis
--     with a reason, as before: it reads "Not decided" again.
--   * visit_clinical, patient_file and the Diagnoses report (report_diagnoses_staged) say the state;
--     the report counts Confirmed, Not confirmed and Not decided beside the cases.

-- ---------------------------------------------------------------- the "not confirmed" marks
create table if not exists diagnosis_not_confirmed (
  like mmc_base including all,
  condition_id uuid not null references condition (id),
  encounter_id uuid not null references encounter (id)
);
create unique index if not exists diagnosis_not_confirmed_one_uq on diagnosis_not_confirmed (condition_id)
  where deleted_at is null;
create index if not exists diagnosis_not_confirmed_encounter_idx on diagnosis_not_confirmed (encounter_id);
select install_common_triggers('diagnosis_not_confirmed');
comment on table diagnosis_not_confirmed is
  'A possible diagnosis (step 3) the doctor left unticked when he saved step 5 (0192): created_by and created_at say who decided it and when; deleted_at (updated_by) when it was ticked later. No words here: they stay on the condition row.';
alter table diagnosis_not_confirmed enable row level security;
revoke all on diagnosis_not_confirmed from anon, authenticated;

-- ---------------------------------------------------------------- "is it confirmed?"
create index if not exists condition_differential_idx on condition (differential_id)
  where differential_id is not null;
comment on column condition.differential_id is
  'The possible diagnosis this definitive one confirms: the doctor ticked it (0127, 0192). Confirmed means this link, never the same words.';

-- ---------------------------------------------------------------- confirm_differential (from 20270110090000_rx_cancel_outside): + the "not confirmed" taken back
create or replace function confirm_differential(p_id uuid, p_type condition_type default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_id uuid;
  v_type condition_type;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select * into v_c from condition where id = p_id and deleted_at is null for update;
  if not found or v_c.stage <> 'differential' then
    raise exception 'diagnosis not found' using errcode = 'P0002';
  end if;
  perform assert_may_work_on(v_c.encounter_id);
  if not visit_open_or_editing(v_c.encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if coalesce(v_c.icd10_code, '') ~ '^B2[0-4]' and not has_perm('sensitive.read') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if exists (select 1 from condition x where x.differential_id = p_id and x.deleted_at is null) then
    raise exception 'this diagnosis is already confirmed' using errcode = '22023', hint = 'already_confirmed';
  end if;
  v_type := coalesce(p_type, visit_next_dx_type(v_c.encounter_id));
  insert into condition (encounter_id, text, icd10_code, type, stage, differential_id)
  values (v_c.encounter_id, v_c.text, v_c.icd10_code, v_type, 'definitive', p_id)
  returning id into v_id;
  -- 0192: ticked now (in step 5, or an older screen's Confirm): a standing "not confirmed" of this
  -- possible diagnosis is taken back (the change log keeps who saved it and who took it back)
  update diagnosis_not_confirmed set deleted_at = now() where condition_id = p_id and deleted_at is null;
  perform note_visit_edit(v_c.encounter_id, 'create', 'condition', v_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', v_type,
                                             'stage', 'definitive', 'differential', p_id));
  return v_id;
end
$$;

-- ---------------------------------------------------------------- step 5 in one save
-- p_confirm: the possible diagnoses ticked (in the order sent: the first is the main diagnosis when
-- none stands yet); p_not_confirmed: those left unticked; p_other: the diagnoses typed. Every check
-- runs before anything is written, and one refusal saves nothing. Sending nothing is not refused.
-- Answers {definitive: the new definitive diagnoses, notConfirmed: the possible ones newly marked}.
create or replace function save_definitive_diagnoses(
  p_encounter_id uuid, p_confirm uuid[] default '{}', p_not_confirmed uuid[] default '{}',
  p_other text[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_confirm uuid[];
  v_not uuid[];
  v_other text[];
  v_found integer := 0;
  v_ids uuid[] := '{}';
  v_marked uuid[] := '{}';
  v_id uuid;
  v_mark uuid;
  v_text text;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- 0126: the record is the doctor's
  if not is_doctor() then
    raise exception 'not allowed: patient records are for doctors' using errcode = '42501', hint = 'not_doctor';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  perform 1 from encounter where id = p_encounter_id and deleted_at is null for update;
  if not found or not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;

  -- each list once, in the order sent; the typed words trimmed, single-spaced, once per spelling
  select coalesce(array_agg(x.id order by x.n), '{}') into v_confirm
  from (select u.id, min(u.n) as n from unnest(coalesce(p_confirm, '{}'::uuid[])) with ordinality u(id, n)
        where u.id is not null group by u.id) x;
  select coalesce(array_agg(x.id order by x.n), '{}') into v_not
  from (select u.id, min(u.n) as n from unnest(coalesce(p_not_confirmed, '{}'::uuid[])) with ordinality u(id, n)
        where u.id is not null group by u.id) x;
  select coalesce(array_agg(x.t order by x.n), '{}') into v_other
  from (select distinct on (lower(s.t)) s.t, s.n
        from (select trim(regexp_replace(u.t, '\s+', ' ', 'g')) as t, u.n
              from unnest(coalesce(p_other, '{}'::text[])) with ordinality u(t, n)) s
        where coalesce(s.t, '') <> ''
        order by lower(s.t), s.n) x;

  if v_confirm && v_not then
    raise exception 'a possible diagnosis is confirmed or not confirmed, not both' using errcode = '22023';
  end if;
  -- the possible diagnoses sent: standing, of this visit (locked while they are decided)
  for v_id in select c.id from condition c
              where c.id = any (v_confirm || v_not) and c.deleted_at is null
                and c.stage = 'differential' and c.encounter_id = p_encounter_id
              order by c.created_at, c.id
              for update
  loop
    v_found := v_found + 1;
  end loop;
  if v_found <> cardinality(v_confirm || v_not) then
    raise exception 'diagnosis not found' using errcode = 'P0002';
  end if;
  -- an HIV diagnosis (ICD-10 B20–B24) is decided by the people allowed to see HIV results
  if not has_perm('sensitive.read')
     and exists (select 1 from condition c where c.id = any (v_confirm || v_not)
                   and coalesce(c.icd10_code, '') ~ '^B2[0-4]') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  -- a confirmed one stays confirmed (it is taken back by removing its definitive diagnosis)
  if exists (select 1 from condition x where x.differential_id = any (v_confirm || v_not) and x.deleted_at is null) then
    raise exception 'this diagnosis is already confirmed' using errcode = '22023', hint = 'already_confirmed';
  end if;
  -- the words of a possible diagnosis of the visit are ticked, not typed again. Only the lines the
  -- doctor sees count: an HIV one (B20–B24) is hidden from someone without the right, so it is
  -- neither named to him nor in his way. A line not decided or not confirmed: tick it instead;
  -- a line already confirmed: it is confirmed already (nothing to tick).
  if exists (select 1 from condition c cross join unnest(v_other) o(t)
             where c.encounter_id = p_encounter_id and c.deleted_at is null and c.stage = 'differential'
               and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))
               and lower(trim(regexp_replace(c.text, '\s+', ' ', 'g'))) = lower(o.t)
               and not exists (select 1 from condition x where x.differential_id = c.id and x.deleted_at is null)) then
    raise exception 'this diagnosis is in the list of possible diagnoses: tick it instead' using errcode = '22023';
  end if;
  if exists (select 1 from condition c cross join unnest(v_other) o(t)
             where c.encounter_id = p_encounter_id and c.deleted_at is null and c.stage = 'differential'
               and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))
               and lower(trim(regexp_replace(c.text, '\s+', ' ', 'g'))) = lower(o.t)) then
    raise exception 'this diagnosis is already confirmed' using errcode = '22023', hint = 'already_confirmed';
  end if;

  -- the unticked ones: "not confirmed", by this doctor, now (one already marked stays as it is)
  foreach v_id in array v_not loop
    if not exists (select 1 from diagnosis_not_confirmed n where n.condition_id = v_id and n.deleted_at is null) then
      insert into diagnosis_not_confirmed (condition_id, encounter_id) values (v_id, p_encounter_id)
      returning id into v_mark;
      perform note_visit_edit(p_encounter_id, 'create', 'diagnosis_not_confirmed', v_mark,
                              jsonb_build_object('differential', v_id));
      v_marked := v_marked || v_id;
    end if;
  end loop;
  -- the ticked ones, in the order sent: each its definitive diagnosis, linked (0127, 0130)
  foreach v_id in array v_confirm loop
    v_ids := v_ids || confirm_differential(v_id, null::condition_type);
  end loop;
  -- the typed ones: new definitive diagnoses
  foreach v_text in array v_other loop
    v_ids := v_ids || add_visit_diagnosis(p_encounter_id, v_text, null, null::condition_type, 'definitive', false);
  end loop;
  return jsonb_build_object('definitive', to_jsonb(v_ids), 'notConfirmed', to_jsonb(v_marked));
end
$$;

-- ---------------------------------------------------------------- visit_clinical (from 20270121090000_doctor_here): + notConfirmedAt/By/ById of a possible diagnosis
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
    -- 0126: someone who is not a doctor and works on the open visit: the desk's part
    if visit_desk_view(p_encounter_id) is not null then
      return visit_clinical_desk(p_encounter_id);
    end if;
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
      'access', patient_access(v_patient),
      -- 0126: the record is for doctors
      'forDoctors', not is_doctor());
  end if;
  if v_closed then
    perform log_record_access(v_patient, p_encounter_id, v_view, 'visit');
  end if;
  return jsonb_build_object(
    -- removed diagnoses stay, marked (removedAt), so the record shows what was written and withdrawn
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'stage', c.stage, 'differentialId', c.differential_id, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by), 'byId', c.created_by,
        'editedAt', case when c.deleted_at is null and c.edit_reason is not null then c.updated_at end,
        'editedBy', case when c.deleted_at is null and c.edit_reason is not null then (select full_name from profiles where id = c.updated_by) end,
        'editReason', case when c.deleted_at is null then c.edit_reason end,
        'removedAt', c.deleted_at,
        'removedBy', case when c.deleted_at is not null then (select full_name from profiles where id = c.updated_by) end,
        'removeReason', case when c.deleted_at is not null then c.edit_reason end,
        'history', record_history('condition', c.id),
        -- 0192: a possible diagnosis the doctor saved unticked in step 5 ("not confirmed"): by whom, when
        'notConfirmedAt', n.created_at,
        'notConfirmedBy', (select full_name from profiles where id = n.created_by),
        'notConfirmedById', n.created_by) order by c.created_at)
      from condition c
      left join lateral (select x.created_at, x.created_by from diagnosis_not_confirmed x
                         where x.condition_id = c.id and x.deleted_at is null
                         order by x.created_at desc limit 1) n on c.stage = 'differential'
      where c.encounter_id = p_encounter_id and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id), 'byId', coalesce(o.performer_id, o.created_by),
        'editedAt', case when o.edit_reason is not null then o.updated_at end,
        'editedBy', case when o.edit_reason is not null then (select full_name from profiles where id = o.updated_by) end,
        'editReason', o.edit_reason,
        'history', record_history('observation', o.id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', rx_label(m), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'itemId', m.item_id, 'referenceCode', m.reference_code, 'quantityGiven', coalesce(m.quantity_given, 0),
        'supplySetAt', m.supply_set_at, 'supplySetBy', (select full_name from profiles where id = m.supply_set_by),
        'supplyReason', m.supply_reason,
        -- 0104: the remainder of a partly given line sent outside points at the original (split_from)
        'splitFrom', m.split_from,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    -- HIV tests (like the diagnoses above) only for the people allowed to see them
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false), 'doerId', r.assigned_to, 'doer', (select full_name from profiles where id = r.assigned_to),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'detail', d.detail, 'verified', d.verified_at is not null,
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
    'view', v_view,
    -- 0104: the lock of a finished visit and the reader's edit window
    'editLock', visit_edit_status(p_encounter_id),
    -- 0127: the doctor's texts (steps 1, 2, 6) and the orders to the nurses
    'sections', visit_sections_json(p_encounter_id, null),
    'nurseOrders', visit_nurse_orders(p_encounter_id, false),
    -- 0141: what the ward added to the bill (acts, medicines), for the doctor
    'extras', visit_extras(p_encounter_id),
    'hasComplaint', visit_complaint(p_encounter_id) is not null
  );
end
$$;

-- ---------------------------------------------------------------- patient_file (from 20270121090000_doctor_here): + differentialId and notConfirmed of each diagnosis
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
      -- 0127: the chief complaint (step 1); the diagnosis above is the definitive primary one
      'complaint', case when s.view is not null then visit_complaint(e.id) end,
      -- 0141: the money of a visit for whoever treats it, the cashier, reception, the manager
      'total', case when may_see_bill(e.id) then (select i.total from invoice i where i.encounter_id = e.id) end,
      'balance', case when may_see_bill(e.id) then (select invoice_balance(i.id) from invoice i where i.encounter_id = e.id) end,
      'billStatus', case when may_see_bill(e.id) then (select i.status from invoice i where i.encounter_id = e.id) end,
      'closedAt', e.closed_at,
      'private', s.view is null,
      'view', s.view
    ) order by e.arrived_at desc), '[]'::jsonb) into v_visits
  from encounter e cross join lateral (select v_views ->> e.id::text as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', o.encounter_id, 'code', o.code, 'label', o.label, 'value', o.value_num, 'text', o.value_text,
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
      'provisional', c.provisional, 'stage', c.stage, 'at', c.created_at, 'by', (select full_name from profiles where id = c.created_by),
      -- 0192: the possible diagnosis a definitive one confirms (ticked in step 5); a possible one the
      -- doctor saved unticked ("not confirmed")
      'differentialId', c.differential_id,
      'notConfirmed', c.stage = 'differential' and exists (select 1 from diagnosis_not_confirmed n
                                                         where n.condition_id = c.id and n.deleted_at is null)
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
  where e.patient_id = p_patient_id and i.deleted_at is null and may_see_bill(e.id);

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

-- ---------------------------------------------------------------- report_diagnoses_staged (from 20270107090000_six_steps): + confirmed / not confirmed / not decided
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
      select c.*, coalesce(c.code, lower(c.text)) as k,
             exists (select 1 from condition c2 join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                     where e2.patient_id = c.patient_id and e2.arrived_at < c.arrived_at and c2.deleted_at is null
                       and c2.stage = 'definitive'
                       and coalesce(upper(nullif(trim(c2.icd10_code), '')), lower(trim(c2.text)))
                           = coalesce(c.code, lower(c.text))) as follow_up
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

-- ---------------------------------------------------------------- the change log: the decisions are clinical
-- activity_group (from 20261031180000_audit_departments) + diagnosis_not_confirmed
create or replace function activity_group(p_entity text, p_action audit_action)
returns text
language sql immutable
as $$
  select case
    when p_action = 'login' then 'signin'
    when p_entity in ('patient', 'encounter', 'appointment', 'coverage') then 'patients'
    when p_entity = 'observation' then 'vitals'
    when p_entity = 'queue_entry' then 'queue'
    when p_entity in ('invoice', 'invoice_line', 'payment', 'credit_note', 'day_close', 'claim') then 'billing'
    when p_entity in ('condition', 'medication_request', 'service_request', 'procedure',
                      'diagnostic_report', 'internal_task', 'vaccination', 'medication_dispense',
                      'hiv_test', 'fp_event', 'diagnosis_not_confirmed') then 'clinical'
    when p_entity in ('bed', 'bed_stay') then 'beds'
    when p_entity in ('profiles', 'setting', 'department', 'service', 'service_category', 'payer', 'plan',
                      'price_list', 'price_list_item', 'practitioner') or p_action = 'settings' then 'admin'
    else 'other'
  end
$$;

-- audit_redacted_entity (from 20270107090000_six_steps) + diagnosis_not_confirmed: hidden from a reader
-- who is not a doctor, like the diagnoses themselves
create or replace function audit_redacted_entity(p_entity text)
returns boolean
language sql immutable
as $$
  select p_entity in ('condition', 'observation', 'service_request', 'diagnostic_report', 'procedure',
                      'medication_request', 'medication_dispense', 'prescription_doc', 'vaccination', 'fp_event',
                      'hiv_test', 'document', 'patient_file_doc', 'report_correction', 'record_access_request',
                      'record_access_entry', 'internal_task', 'encounter', 'queue_entry', 'patient',
                      'patient_handover', 'visit_section', 'nurse_order', 'nurse_order_dose',
                      'diagnosis_not_confirmed')
$$;

-- ---------------------------------------------------------------- rights
revoke all on function save_definitive_diagnoses(uuid, uuid[], uuid[], text[]) from public, anon;
grant execute on function save_definitive_diagnoses(uuid, uuid[], uuid[], text[]) to authenticated;
