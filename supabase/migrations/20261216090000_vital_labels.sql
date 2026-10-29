-- 0106 · Custom measurements by name everywhere.
--
-- 0102 (vitals_custom) lets a nurse record a measurement of her own ("Other": a typed name and
-- unit, code custom_<slug>, observation.label). The patient file, the visit journey and the safety
-- summary now carry that label, so the screens and the printed report show "Fundal height" or the
-- typed name instead of the code.

-- patient_file (from 20261203090000_guide_fixes): + label on each vital.
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

-- visit_journey (from 20261210090000_outside_prescriptions): + label on each vital.
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb := '[]'::jsonb;
  v_dx jsonb := '[]'::jsonb;
  v_meds jsonb := '[]'::jsonb;
  v_tests jsonb := '[]'::jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_enc encounter%rowtype;
  v_view text;
  v_handovers jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  v_view := case when clinical_reader() then visit_view(p_encounter_id) end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', case when v_view is not null then q.referral_note end,
      'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  if v_view is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'code', o.code, 'label', o.label, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)
      ) order by o.effective_at), '[]'::jsonb) into v_vitals
    from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

    select coalesce(jsonb_agg(jsonb_build_object(
        'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)
      ) order by c.created_at), '[]'::jsonb) into v_dx
    from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'));

    select coalesce(jsonb_agg(jsonb_build_object(
        'item', rx_label(m), 'quantity', m.quantity, 'dose', m.dose,
        'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
        'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
        'by', (select full_name from profiles where id = m.created_by),
        'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'notGivenBy', (select full_name from profiles where id = m.not_given_by),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by)
      ) order by m.created_at), '[]'::jsonb) into v_meds
    from medication_request m
    where m.encounter_id = p_encounter_id and m.deleted_at is null;

    select coalesce(jsonb_agg(jsonb_build_object(
        'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
        'by', (select full_name from profiles where id = r.created_by),
        'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
      ) order by r.created_at), '[]'::jsonb) into v_tests
    from service_request r left join service s on s.id = r.service_id
    where r.encounter_id = p_encounter_id and r.deleted_at is null;

    if v_enc.status = 'closed' then
      perform log_record_access(v_enc.patient_id, p_encounter_id, v_view, 'journey');
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
      'total', round(l.quantity * l.unit_price), 'office', l.office, 'at', l.created_at,
      'by', (select full_name from profiles where id = l.entered_by)
    ) order by l.created_at), '[]'::jsonb) into v_charges
  from invoice_line l join invoice i on i.id = l.invoice_id
  where i.encounter_id = p_encounter_id and l.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'amount', p.amount, 'method', p.method, 'reference', p.reference, 'at', p.paid_at,
      'by', (select full_name from profiles where id = p.cashier_id)
    ) order by p.paid_at), '[]'::jsonb) into v_payments
  from payment p join invoice i on i.id = p.invoice_id
  where i.encounter_id = p_encounter_id and p.deleted_at is null;

  select jsonb_build_object('status', b.status, 'total', b.total, 'balance', b.balance, 'paid', b.paid,
                            'number', b.number, 'settledBy', b.settled_by, 'settledAt', b.settled_at)
  into v_bill from visit_bill b where b.encounter_id = p_encounter_id;

  -- who handed the patient over to whom (20261129090000_handover); the note and the reason are
  -- clinical: for the two colleagues and those who may see this visit's record
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'station', h.station, 'at', h.created_at, 'from', f.full_name, 'to', t.full_name,
      'note', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.note end,
      'status', h.status, 'answeredAt', h.answered_at,
      'answeredBy', (select full_name from profiles where id = h.answered_by),
      'reason', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.reason end
    ) order by h.created_at), '[]'::jsonb) into v_handovers
  from patient_handover h
  join profiles f on f.id = h.from_user
  join profiles t on t.id = h.to_user
  where h.encounter_id = p_encounter_id and h.deleted_at is null;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level,
    'triageReason', case when v_view is not null then v_enc.triage_reason end,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill, 'handovers', v_handovers,
    'private', v_view is null
  );
end
$$;

-- patient_safety_summary (from 20261210090000_outside_prescriptions): + label on the last vitals.
create or replace function patient_safety_summary(p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'allergies', p.allergies,
    'allergiesNone', coalesce(p.allergies_none, false) and p.allergies is null,
    'bloodGroup', p.blood_group,
    'alerts', p.notes,
    'flags', p.flags,
    -- long-lasting conditions: a chronic ICD-10 group, or the same diagnosis on two visits
    'chronic', coalesce((
      select jsonb_agg(jsonb_build_object('text', x.text, 'icd10', x.icd10_code, 'since', x.first_at, 'lastAt', x.created_at)
                       order by x.created_at desc)
      from (
        select distinct on (lower(c.text)) c.text, c.icd10_code, c.created_at,
               min(c.created_at) over (partition by lower(c.text)) as first_at
        from condition c join encounter e on e.id = c.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and c.deleted_at is null
          and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))
          and (coalesce(c.icd10_code, '') ~ '^(I1[0-5]|I25|I50|E0[3-5]|E1[0-4]|J4[45]|G40|N18|B18|B2[0-4]|F2[0-9]|F3[1-3])'
               or (select count(distinct c2.encounter_id) from condition c2
                   join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                   where e2.patient_id = p.id and c2.deleted_at is null and lower(c2.text) = lower(c.text)) >= 2)
        order by lower(c.text), c.created_at desc
      ) x), '[]'::jsonb),
    -- medicines of the open visit, and those still running (prescribed days not over)
    'medications', coalesce((
      select jsonb_agg(jsonb_build_object(
          'item', rx_label(m), 'dose', m.dose, 'frequency', m.frequency,
          'days', m.duration_days, 'at', m.created_at, 'outside', m.supply = 'outside',
          'until', case when m.duration_days is not null then m.created_at + make_interval(days => m.duration_days) end,
          'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)))
        order by m.created_at desc)
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.deleted_at is null
      where e.patient_id = p.id and m.deleted_at is null and m.cancelled_at is null
        and (m.not_given_at is null or m.supply = 'outside')
        and m.created_at > now() - interval '180 days'
        and (e.status = 'open' or m.created_at + make_interval(days => coalesce(m.duration_days, 0)) >= now())), '[]'::jsonb),
    'lastVitals', coalesce((
      select jsonb_agg(jsonb_build_object('code', v.code, 'label', v.label, 'value', v.value_num, 'unit', v.unit, 'at', v.effective_at,
                                          'by', (select full_name from profiles where id = v.performer_id))
                       order by v.code)
      from (
        select distinct on (o.code) o.code, o.label, o.value_num, o.unit, o.effective_at, o.performer_id
        from observation o join encounter e on e.id = o.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and o.deleted_at is null and o.code <> 'note' and o.value_num is not null
        order by o.code, o.effective_at desc
      ) v), '[]'::jsonb),
    'lastVisitAt', (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null)
  )
  from patient p where p.id = p_patient_id
$$;
