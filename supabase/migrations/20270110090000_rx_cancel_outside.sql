-- 0130 · Cancelling a medicine bought outside works for the doctor treating the patient; the
-- primary diagnosis is chosen by the database (the first definitive one of the visit).
--
-- Frank (owner):
-- 1. "Why is cancelling the medicine that we prescribed the patient to take out of the pharmacy
--    (outside pharmacy) not working?" The visit screen offers "Cancel this medicine" to the
--    prescriber AND to the doctor who has the patient now (the holder of the visit: the patient
--    taken from the queue, sent on by a colleague, back from the laboratory). cancel_prescription
--    (0091/0100) only let the prescriber, the manager, or a colleague after a formal hand-over
--    cancel; the doctor treating the patient now, or the one who sent the line outside ("Buy
--    outside", rx_set_supply already allows whoever treats the patient), was refused with "only
--    the doctor treating the patient (or the manager) can cancel it" while being exactly that
--    doctor. Now, as for prescribing and "Buy outside": the prescriber, the person who sent the
--    line to an outside pharmacy, a colleague after a hand-over, any doctor working on the open
--    visit, or the manager. A line still waiting at the pharmacy is cancelled as before.
-- 2. "In the Diagnosis remove the type and the thing that says Also in the differential list."
--    The visit no longer asks primary / secondary: the FIRST definitive diagnosis of the visit is
--    the primary one, the later ones are secondary; when the primary is removed (or turned back
--    into a possible diagnosis), the next oldest definitive one becomes primary, so finish_visit
--    and the reports keep finding it. add_visit_diagnosis / confirm_differential take no type
--    any more (null: worked out here); an older screen that still sends one is obeyed.

-- ---------------------------------------------------------------- the primary diagnosis
-- The visit has a standing definitive primary diagnosis, or the oldest standing definitive one
-- becomes it. Nothing happens on a visit with no definitive diagnosis.
create or replace function visit_primary_settle(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from condition c
             where c.encounter_id = p_encounter_id and c.deleted_at is null
               and c.stage = 'definitive' and c.type = 'primary') then
    return;
  end if;
  update condition set type = 'primary'
  where id = (select c.id from condition c
              where c.encounter_id = p_encounter_id and c.deleted_at is null and c.stage = 'definitive'
              order by c.created_at, c.id
              limit 1);
end
$$;

-- The type a new definitive diagnosis of the visit takes: primary when none stands yet.
create or replace function visit_next_dx_type(p_encounter_id uuid)
returns condition_type
language sql stable security definer set search_path = public
as $$
  select case when exists (select 1 from condition c
                           where c.encounter_id = p_encounter_id and c.deleted_at is null
                             and c.stage = 'definitive' and c.type = 'primary')
              then 'secondary'::condition_type else 'primary'::condition_type end
$$;

create or replace function add_visit_diagnosis(
  p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default null,
  p_stage text default 'definitive', p_also_differential boolean default false
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_dd uuid;
  v_stage text := coalesce(p_stage, 'definitive');
  v_icd text := nullif(upper(trim(coalesce(p_icd10, ''))), '');
  v_type condition_type;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if v_stage not in ('differential', 'definitive') then
    raise exception 'a diagnosis is differential or definitive' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  -- an HIV diagnosis (ICD-10 B20–B24) is written by the people allowed to see HIV results
  if coalesce(v_icd, '') ~ '^B2[0-4]' and not has_perm('sensitive.read') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  -- 0130: a possible diagnosis is never primary; a definitive one is primary when it is the first
  v_type := case when v_stage = 'differential' then 'secondary'::condition_type
                 when p_type is not null then p_type
                 else visit_next_dx_type(p_encounter_id) end;
  if v_stage = 'definitive' and p_also_differential then
    insert into condition (encounter_id, text, icd10_code, type, stage)
    values (p_encounter_id, trim(p_text), v_icd, 'secondary', 'differential')
    returning id into v_dd;
    perform note_visit_edit(p_encounter_id, 'create', 'condition', v_dd,
                            jsonb_build_object('text', trim(p_text), 'icd10', v_icd, 'stage', 'differential'));
  end if;
  insert into condition (encounter_id, text, icd10_code, type, stage, differential_id)
  values (p_encounter_id, trim(p_text), v_icd, v_type, v_stage, v_dd)
  returning id into v_id;
  perform note_visit_edit(p_encounter_id, 'create', 'condition', v_id,
                          jsonb_build_object('text', trim(p_text), 'icd10', v_icd,
                                             'type', v_type, 'stage', v_stage, 'differential', v_dd));
  return v_id;
end
$$;

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
  perform note_visit_edit(v_c.encounter_id, 'create', 'condition', v_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', v_type,
                                             'stage', 'definitive', 'differential', p_id));
  return v_id;
end
$$;

-- Removing the primary diagnosis: the next oldest definitive one becomes primary. A finished visit
-- refuses only when no definitive diagnosis would be left (it keeps a primary one).
create or replace function remove_condition(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_e encounter%rowtype;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select * into v_c from condition where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'diagnosis not found' using errcode = 'P0002';
  end if;
  select * into v_e from encounter where id = v_c.encounter_id;
  if not (is_manager() or v_c.created_by = auth.uid()) then
    raise exception 'only the clinician who wrote the diagnosis (or the manager) can change it' using errcode = '42501';
  end if;
  if not visit_open_or_editing(v_c.encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the diagnosis is removed' using errcode = '22023';
  end if;
  if v_e.status = 'closed' and v_c.type = 'primary'
     and v_e.type in ('opd', 'dental', 'procedure', 'observation')
     and not exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                     and x.deleted_at is null and (x.type = 'primary' or x.stage = 'definitive')) then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition set deleted_at = now(), edit_reason = trim(p_reason) where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'delete', 'condition', p_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', v_c.type,
                                             'reason', trim(p_reason)));
  perform visit_primary_settle(v_c.encounter_id);
end
$$;

create or replace function remove_condition_none_found(p_id uuid, p_reason text, p_no_diagnosis text,
                                                       p_no_diagnosis_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_e encounter%rowtype;
  v_last boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select * into v_c from condition where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'diagnosis not found' using errcode = 'P0002';
  end if;
  select * into v_e from encounter where id = v_c.encounter_id;
  if not (is_manager() or v_c.created_by = auth.uid()) then
    raise exception 'only the clinician who wrote the diagnosis (or the manager) can change it' using errcode = '42501';
  end if;
  if not visit_open_or_editing(v_c.encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the diagnosis is removed' using errcode = '22023';
  end if;
  -- 0130: the last one only when no other definitive diagnosis would become primary
  v_last := v_c.type = 'primary'
            and not exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                            and x.deleted_at is null and (x.type = 'primary' or x.stage = 'definitive'));
  if v_e.status = 'closed' and v_last and p_no_diagnosis is null
     and v_e.type in ('opd', 'dental', 'procedure', 'observation') then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition set deleted_at = now(), edit_reason = trim(p_reason) where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'delete', 'condition', p_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', v_c.type,
                                             'reason', trim(p_reason)));
  perform visit_primary_settle(v_c.encounter_id);
  -- no primary diagnosis left: the reason none stands
  if v_last and p_no_diagnosis is not null then
    perform set_no_diagnosis(v_c.encounter_id, p_no_diagnosis, p_no_diagnosis_note);
  end if;
end
$$;

-- As 0127; a primary turned back into a possible diagnosis hands "primary" to the next one.
create or replace function update_condition(p_id uuid, p_text text default null, p_icd10 text default null, p_type condition_type default null, p_provisional boolean default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_e encounter%rowtype;
  v_text text;
  v_icd text;
  v_type condition_type;
  v_prov boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select * into v_c from condition where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'diagnosis not found' using errcode = 'P0002';
  end if;
  select * into v_e from encounter where id = v_c.encounter_id;
  if not (is_manager() or v_c.created_by = auth.uid()) then
    raise exception 'only the clinician who wrote the diagnosis (or the manager) can change it' using errcode = '42501';
  end if;
  if not visit_open_or_editing(v_c.encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the diagnosis is changed' using errcode = '22023';
  end if;
  v_text := trim(coalesce(p_text, v_c.text));
  if length(v_text) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  v_icd := case when p_icd10 is null then v_c.icd10_code else nullif(upper(trim(p_icd10)), '') end;
  if coalesce(v_icd, '') ~ '^B2[0-4]' and not has_perm('sensitive.read') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  v_prov := coalesce(p_provisional, v_c.provisional);
  -- 0127: a differential (provisional) is never primary
  v_type := case when v_prov then 'secondary'::condition_type
                 when p_type is not null then p_type
                 -- a differential made definitive: primary unless the visit has one already
                 when v_c.stage = 'differential' then
                   case when exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                                     and x.type = 'primary' and x.stage = 'definitive' and x.deleted_at is null)
                        then 'secondary'::condition_type else 'primary'::condition_type end
                 else v_c.type end;
  if v_text = v_c.text and v_icd is not distinct from v_c.icd10_code and v_type = v_c.type and v_prov = v_c.provisional then
    raise exception 'nothing changed' using errcode = '22023';
  end if;
  -- a finished visit keeps a primary diagnosis (the rule for closing still holds)
  if v_e.status = 'closed' and v_c.type = 'primary' and v_type <> 'primary'
     and v_e.type in ('opd', 'dental', 'procedure', 'observation')
     and not exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                     and x.deleted_at is null and (x.type = 'primary' or x.stage = 'definitive')) then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition
  set text = v_text, icd10_code = v_icd, type = v_type,
      stage = case when v_prov then 'differential' else 'definitive' end, edit_reason = trim(p_reason)
  where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'update', 'condition', p_id,
                          jsonb_build_object('text', v_text, 'icd10', v_icd, 'type', v_type, 'provisional', v_prov,
                                             'reason', trim(p_reason)));
  perform visit_primary_settle(v_c.encounter_id);
  return jsonb_build_object('id', p_id, 'text', v_text, 'icd10', v_icd,
                            'type', (select type from condition where id = p_id), 'provisional', v_prov);
end
$$;

-- ---------------------------------------------------------------- cancelling a medicine
create or replace function cancel_prescription(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
  v_waiting boolean;
  v_open boolean;
  v_writer uuid;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is cancelled' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  v_writer := coalesce(v_m.prescriber_id, v_m.created_by);
  select e.status = 'open' into v_open from encounter e where e.id = v_m.encounter_id and e.deleted_at is null;
  -- 0130: as prescribing and "Buy outside": the prescriber, the one who sent it outside, the
  -- colleague after a hand-over, a doctor working on the open visit (the one who has the patient
  -- now), or the manager
  if not (is_manager()
          or (has_perm('clinical.write')
              and (v_writer = auth.uid()
                   or (v_m.supply = 'outside' and v_m.supply_set_by = auth.uid())
                   -- the patient was handed over: the colleague who took them now decides
                   or (may_work_on(v_m.encounter_id)
                       and result_recipient(v_m.encounter_id, v_writer) = auth.uid())
                   or (coalesce(v_open, false) and is_doctor() and may_work_on(v_m.encounter_id))))) then
    raise exception 'only the doctor treating the patient (or the manager) can cancel it' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  v_waiting := rx_pending(v_m);
  if not (v_waiting or (v_m.supply = 'outside' and v_m.cancelled_at is null)) then
    raise exception 'this medicine is no longer waiting at the pharmacy (handed over, not given or cancelled)'
      using errcode = 'P0002';
  end if;
  update medication_request
  set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_m.id;
  if v_waiting then
    -- the pharmacy is told the line left its list
    v_item := rx_label(v_m);
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('rx_cancelled',
            jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                               'by', (select full_name from profiles where id = auth.uid())),
            '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
    -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
    perform after_pharmacy(v_m.encounter_id);
  end if;
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'pending', v_left,
                            'balance', invoice_balance((select id from invoice where encounter_id = v_m.encounter_id)));
end
$$;

-- ---------------------------------------------------------------- rights
revoke all on function visit_primary_settle(uuid), visit_next_dx_type(uuid) from public, anon, authenticated;
revoke all on function add_visit_diagnosis(uuid, text, text, condition_type, text, boolean),
  confirm_differential(uuid, condition_type), remove_condition(uuid, text),
  remove_condition_none_found(uuid, text, text, text),
  update_condition(uuid, text, text, condition_type, boolean, text), cancel_prescription(uuid, text)
  from public, anon;
grant execute on function add_visit_diagnosis(uuid, text, text, condition_type, text, boolean),
  confirm_differential(uuid, condition_type), remove_condition(uuid, text),
  remove_condition_none_found(uuid, text, text, text),
  update_condition(uuid, text, text, condition_type, boolean, text), cancel_prescription(uuid, text)
  to authenticated;
