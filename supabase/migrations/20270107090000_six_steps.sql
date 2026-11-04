-- 0127 · Six steps: how the doctor records a visit.
--
-- Frank (the owner): "Change how we handle and treat a patient, in these steps: 1. Complaint and
-- History; 2. Physical exam findings; 3. Differential diagnosis; 4. Paraclinical exams;
-- 5. Definitive diagnosis; 6. Treatment plan — the plan, and/or tasks for the nurse, sent to a
-- specific nurse or to all nurses: medical acts and drugs to give."
--
--   * 1 2 6  THE DOCTOR'S TEXTS: visit_section holds one text per visit and part: 'complaint' (the
--            chief complaint, the patient's words), 'hpi' (history of the present illness), 'exam'
--            (physical exam findings), 'plan' (treatment plan). save_visit_section writes, changes
--            or clears one (a reason after the visit is finished, under the edit window of 0104);
--            every change stays in the audit (record_history). They are records (0126): doctors
--            read them; someone else working on the open visit reads only what they wrote.
--   * 1      THE PATIENT'S PAST in step 1: visit_past_history. The past is private (0088/0126). A
--            clinic setting records.history_for_treating_doctor (default on, the manager's switch in
--            Settings › Patient flow): on, a DOCTOR working on the patient's OPEN visit sees the
--            summary of the earlier visits (complaint, definitive diagnoses, plan, medicines, tests
--            with results) and the allergies and long-term conditions; each opening is written to
--            the access log (via 'treating', what 'history'). Off, or anyone else: the request /
--            emergency flow of 0088 (history_via). Non-doctors never.
--   * 3 5    DIFFERENTIAL AND DEFINITIVE DIAGNOSES: condition.stage. Existing rows: provisional →
--            'differential', the rest 'definitive'. A differential is a possibility (never primary:
--            its type is kept 'secondary', so every "primary diagnosis" rule means a definitive one);
--            provisional mirrors it for the old readers. confirm_differential writes the definitive
--            diagnosis linked to it (differential_id), the differential stays in step 3 marked
--            confirmed. add_diagnosis takes the stage, and can put a definitive one not in the list
--            (found by the laboratory) in the differential list too, for the record.
--   * 4      Tests: unchanged (order_tests), shown in step 4 with their results.
--   * 6      NURSE ORDERS: nurse_order ('act': an injection, a dressing… with a treatment of the
--            catalogue so it is billed; 'drug': a medicine of the stock, its dose, route, how
--            often), for one nurse (assigned_to) or all nurses (null: the nursing desk), how many
--            times (doses_planned). The doctor gives them (is_doctor). The nurse records each time:
--            given (when, by whom; a drug is taken from the room store she holds and billed, as the
--            medicines given here) or not given with a reason; the order ends done, not done (the
--            nurse, with a reason) or cancelled (the doctor). Told by the bell (kinds nurse_order,
--            nurse_order_done), counted on the menu (nav_counts 'nurseOrders'), listed on the
--            nurse's Home (nurse_orders_for_me). The nurse's desk view shows her orders, never
--            steps 1–5. internal_task stays the free "task for the nurse" (a title and a time):
--            an order has a medicine, a dose, a store, a bill and several administrations, which
--            the task table does not hold.
--   * B      FINISH: a chief complaint, and a definitive primary diagnosis or the reason none was
--            found (0125). Open nurse orders do not stop it.
--   * C      REPORTS: report_diagnoses counts definitive diagnoses (p_stage 'differential' or 'all'
--            for the others); patients seen, the visits list and the patient file carry the chief
--            complaint; the long-term conditions and the first diagnosis of a visit are definitive.
--
-- Errcodes: 42501 not allowed (hints: not_doctor, not_manager, not_yours), 22023 bad input (hints:
-- reason_needed, item_needed, not_nurse, order_over, bad_time, already_confirmed), 23514 (hint:
-- complaint_needed), P0002 not found (hint: not_found), MS003 not enough in the store (room_short).

-- ---------------------------------------------------------------- 3 5 differential and definitive
alter table condition add column if not exists stage text not null default 'definitive';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'condition_stage_check') then
    alter table condition add constraint condition_stage_check check (stage in ('differential', 'definitive'));
  end if;
end
$$;
alter table condition add column if not exists differential_id uuid references condition (id);
comment on column condition.stage is
  'Step 3 differential (possible, not confirmed) or step 5 definitive (0127). provisional mirrors it.';
comment on column condition.differential_id is
  'A definitive diagnosis confirmed from the differential list: the differential it came from (0127).';

-- The existing provisional diagnoses become the differential list (written as they were: no
-- audit line, no "edited" mark).
alter table condition disable trigger user;
update condition set stage = 'differential', type = 'secondary' where provisional and stage <> 'differential';
alter table condition enable trigger user;

-- A differential is never primary nor linked; provisional follows the stage (the old readers). An
-- older writer that only says provisional (an earlier add_diagnosis / update_condition) moves the
-- stage with it.
create or replace function condition_stage_sync()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.provisional and new.stage = 'definitive' then
      new.stage := 'differential';
    end if;
  elsif new.stage is not distinct from old.stage and new.provisional is distinct from old.provisional then
    new.stage := case when new.provisional then 'differential' else 'definitive' end;
  end if;
  -- a differential made definitive without a type said: primary unless the visit has one
  if tg_op = 'UPDATE' and old.stage = 'differential' and new.stage = 'definitive'
     and new.type is not distinct from old.type then
    new.type := case when exists (select 1 from condition x where x.encounter_id = new.encounter_id and x.id <> new.id
                                  and x.type = 'primary' and x.stage = 'definitive' and x.deleted_at is null)
                     then 'secondary'::condition_type else 'primary'::condition_type end;
  end if;
  if new.stage = 'differential' then
    new.type := 'secondary';
    new.differential_id := null;
  end if;
  new.provisional := new.stage = 'differential';
  return new;
end
$$;
drop trigger if exists trg_condition_stage on condition;
create trigger trg_condition_stage before insert or update on condition
  for each row execute function condition_stage_sync();

-- ---------------------------------------------------------------- 1 2 6 the doctor's texts
create table if not exists visit_section (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  section text not null check (section in ('complaint', 'hpi', 'exam', 'plan')),
  text text not null,
  edit_reason text
);
create unique index if not exists visit_section_one_uq on visit_section (encounter_id, section)
  where deleted_at is null;
select install_common_triggers('visit_section');
comment on table visit_section is
  'The doctor''s texts of a visit (0127): chief complaint, history of the present illness, physical exam, treatment plan.';
alter table visit_section enable row level security;
revoke all on visit_section from anon, authenticated;

-- ---------------------------------------------------------------- 6 nurse orders
create table if not exists nurse_order (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  patient_id uuid not null references patient (id),
  kind text not null check (kind in ('act', 'drug')),
  text text not null,
  service_id uuid references service (id),
  item_id uuid references item (id),
  -- an act: how many of the treatment are charged each time; a drug: units of the medicine each time
  quantity numeric(10, 2) not null default 1 check (quantity > 0),
  dose text,
  route text,
  frequency text,
  doses_planned integer not null default 1 check (doses_planned between 1 and 60),
  -- null: all the nurses (the nursing desk)
  assigned_to uuid references profiles (id),
  status text not null default 'open' check (status in ('open', 'done', 'not_done', 'cancelled')),
  notes text,
  ended_at timestamptz,
  ended_by uuid references profiles (id),
  end_reason text,
  check (kind = 'act' or item_id is not null),
  check (kind = 'drug' or item_id is null)
);
create index if not exists nurse_order_encounter_idx on nurse_order (encounter_id);
create index if not exists nurse_order_open_idx on nurse_order (status, assigned_to) where deleted_at is null;
select install_common_triggers('nurse_order');
comment on table nurse_order is
  'Orders of the doctor to the nurses (0127): a medical act or a drug to give, for one nurse or all.';
alter table nurse_order enable row level security;
revoke all on nurse_order from anon, authenticated;

create table if not exists nurse_order_dose (
  like mmc_base including all,
  order_id uuid not null references nurse_order (id),
  n integer not null check (n >= 1),
  given boolean not null,
  at timestamptz not null default now(),
  by_id uuid references profiles (id) default auth.uid(),
  note text,
  location_id uuid references stock_location (id),
  charged boolean not null default false
);
create unique index if not exists nurse_order_dose_n_uq on nurse_order_dose (order_id, n) where deleted_at is null;
select install_common_triggers('nurse_order_dose');
comment on table nurse_order_dose is
  'Each time a nurse order is carried out (0127): given (when, by whom, from which store) or not given with the reason.';
alter table nurse_order_dose enable row level security;
revoke all on nurse_order_dose from anon, authenticated;

alter table stock_movement add column if not exists nurse_order_id uuid references nurse_order (id);

-- ---------------------------------------------------------------- the access log: the treating doctor
alter table record_access_entry drop constraint if exists record_access_entry_via_check;
alter table record_access_entry add constraint record_access_entry_via_check
  check (via in ('own', 'head', 'request', 'emergency', 'manager', 'treating'));
alter table record_access_entry drop constraint if exists record_access_entry_what_check;
alter table record_access_entry add constraint record_access_entry_what_check
  check (what in ('file', 'visit', 'results', 'journey', 'emergency', 'attachment', 'history'));

-- ---------------------------------------------------------------- the setting
-- The treating doctor sees the patient's past in step 1 (default: yes).
create or replace function history_for_treating_doctor()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'boolean' then (s.value #>> '{}')::boolean end
                   from setting s where s.key = 'records.history_for_treating_doctor'), true)
$$;

-- save_setting: the last definition (all.sql:61427) + 0127
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_hours numeric;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp', 'security.session', 'flow', 'stock.expiry_days', 'insurance.enabled', 'booking.colleague_accept', 'records.history_for_treating_doctor') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.session' then
    if not is_manager() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value -> 'hours') is distinct from 'number' then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
    v_hours := (p_value ->> 'hours')::numeric;
    if v_hours <> trunc(v_hours) or v_hours < 1 or v_hours > 12 then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.otp' then
    if jsonb_typeof(p_value -> 'trust_days') <> 'number'
       or (p_value ->> 'trust_days')::numeric < 0
       or (p_value ->> 'trust_days')::numeric > 90 then
      raise exception 'trust_days must be between 0 and 90' using errcode = '22023';
    end if;
  end if;
  if p_key = 'flow' and jsonb_typeof(p_value -> 'triage_first') <> 'boolean' then
    raise exception 'flow.triage_first must be true or false' using errcode = '22023';
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  if p_key = 'insurance.enabled' and jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception 'insurance.enabled must be true or false' using errcode = '22023';
  end if;
  if p_key = 'booking.colleague_accept' and jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception 'booking.colleague_accept must be true or false' using errcode = '22023';
  end if;
  if p_key = 'stock.expiry_days' then
    if jsonb_typeof(p_value) is distinct from 'number' then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
    if (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)
       or (p_value #>> '{}')::numeric < 1 or (p_value #>> '{}')::numeric > 365 then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
  end if;
  -- 0127: the treating doctor sees the patient's past in step 1 (the manager decides)
  if p_key = 'records.history_for_treating_doctor' then
    if not is_manager() then
      raise exception 'not allowed' using errcode = '42501', hint = 'not_manager';
    end if;
    if jsonb_typeof(p_value) is distinct from 'boolean' then
      raise exception 'records.history_for_treating_doctor must be true or false' using errcode = '22023';
    end if;
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

-- staff_settings: the last definition (all.sql:61495) + 0127
create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120),
    'trust_days', trust_days(),
    'triage_first', triage_first(),
    'session_hours', session_hours(),
    'insurance_enabled', insurance_enabled(),
    'colleague_accept', colleague_must_accept(),
    -- 0127: the treating doctor sees the patient's past in step 1
    'history_for_treating_doctor', history_for_treating_doctor(),
    'insurance_active', insurance_enabled()
      and exists (select 1 from payer where active and deleted_at is null and type <> 'cash')
  )
$$;


-- ---------------------------------------------------------------- helpers
-- The chief complaint of a visit, or null.
create or replace function visit_complaint(p_encounter_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select s.text from visit_section s
  where s.encounter_id = p_encounter_id and s.section = 'complaint' and s.deleted_at is null
  limit 1
$$;

-- The doctor's texts of a visit as { complaint: {...}, hpi: {...}, exam: {...}, plan: {...} }; with
-- p_only, only those that person wrote (the desk view).
create or replace function visit_sections_json(p_encounter_id uuid, p_only uuid default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_object_agg(s.section, jsonb_build_object(
      'id', s.id, 'text', s.text, 'at', s.created_at,
      'by', (select full_name from profiles where id = s.created_by), 'byId', s.created_by,
      'editedAt', case when s.version > 1 then s.updated_at end,
      'editedBy', case when s.version > 1 then (select full_name from profiles where id = s.updated_by) end,
      'editReason', s.edit_reason,
      'history', record_history('visit_section', s.id))), '{}'::jsonb)
  from visit_section s
  where s.encounter_id = p_encounter_id and s.deleted_at is null
    and (p_only is null or s.created_by = p_only)
$$;

-- An order for me: sent to me by name, or to all the nurses and I work at the nursing desk.
create or replace function nurse_order_mine(p_assigned_to uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null
    and (p_assigned_to = auth.uid() or (p_assigned_to is null and task_for_me('nurse')))
$$;

-- One nurse order with the times it was carried out.
create or replace function nurse_order_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', o.id, 'encounterId', o.encounter_id, 'kind', o.kind, 'text', o.text,
    'serviceId', o.service_id, 'service', (select s.name_en from service s where s.id = o.service_id),
    'itemId', o.item_id, 'item', case when o.item_id is not null then item_label(o.item_id) end,
    'quantity', o.quantity, 'dose', o.dose, 'route', o.route, 'frequency', o.frequency,
    'dosesPlanned', o.doses_planned,
    'given', (select count(*) from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null and d.given)::integer,
    'notGiven', (select count(*) from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null and not d.given)::integer,
    'assignedTo', o.assigned_to, 'assignedName', (select full_name from profiles where id = o.assigned_to),
    'status', o.status, 'notes', o.notes, 'at', o.created_at,
    'by', (select full_name from profiles where id = o.created_by), 'byId', o.created_by,
    'endedAt', o.ended_at, 'endedBy', (select full_name from profiles where id = o.ended_by), 'endReason', o.end_reason,
    'mine', nurse_order_mine(o.assigned_to),
    'doses', coalesce((select jsonb_agg(jsonb_build_object(
        'n', d.n, 'given', d.given, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id),
        'note', d.note, 'charged', d.charged,
        'store', (select l.name from stock_location l where l.id = d.location_id)) order by d.n)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null), '[]'::jsonb))
  from nurse_order o where o.id = p_id
$$;

-- The nurse orders of a visit: all of them (the doctor's record), or (p_desk) those for the
-- reader and those they gave.
create or replace function visit_nurse_orders(p_encounter_id uuid, p_desk boolean default false)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(nurse_order_json(o.id) order by o.created_at), '[]'::jsonb)
  from nurse_order o
  where o.encounter_id = p_encounter_id and o.deleted_at is null
    and (not p_desk or nurse_order_mine(o.assigned_to) or o.created_by = auth.uid())
$$;

-- ---------------------------------------------------------------- 1 2 6 writing the texts
-- Write, change or clear one of the doctor's texts of a visit (complaint, hpi, exam, plan). While
-- the visit is open whoever works on it; after it is finished, under the edit window, with a
-- reason (0104). A finished visit keeps its chief complaint.
create or replace function save_visit_section(p_encounter_id uuid, p_section text, p_text text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s visit_section%rowtype;
  v_text text := nullif(trim(coalesce(p_text, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_closed boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if coalesce(p_section, '') not in ('complaint', 'hpi', 'exam', 'plan') then
    raise exception 'unknown part of the visit record' using errcode = '22023';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if length(coalesce(v_text, '')) > 8000 then
    raise exception 'the text is too long' using errcode = '22023';
  end if;
  select e.status = 'closed' into v_closed from encounter e where e.id = p_encounter_id;
  select * into v_s from visit_section
  where encounter_id = p_encounter_id and section = p_section and deleted_at is null
  for update;
  if found and v_s.text is not distinct from v_text then
    return jsonb_build_object('section', p_section, 'text', v_text, 'changed', false);
  end if;
  if v_closed and (found or v_text is null) and length(coalesce(v_reason, '')) < 3 then
    raise exception 'say why the finished visit is changed' using errcode = '22023', hint = 'reason_needed';
  end if;
  if v_s.id is null then
    if v_text is null then
      return jsonb_build_object('section', p_section, 'text', null, 'changed', false);
    end if;
    insert into visit_section (encounter_id, section, text, edit_reason)
    values (p_encounter_id, p_section, v_text, case when v_closed then v_reason end)
    returning * into v_s;
    perform note_visit_edit(p_encounter_id, 'create', 'visit_section', v_s.id,
                            jsonb_build_object('section', p_section, 'text', v_text));
  elsif v_text is null then
    if v_closed and p_section = 'complaint' then
      raise exception 'a finished visit keeps its chief complaint: write the new one instead'
        using errcode = '23514', hint = 'complaint_needed';
    end if;
    update visit_section set deleted_at = now(), edit_reason = v_reason where id = v_s.id;
    perform note_visit_edit(p_encounter_id, 'delete', 'visit_section', v_s.id,
                            jsonb_build_object('section', p_section, 'reason', v_reason));
  else
    update visit_section set text = v_text, edit_reason = v_reason where id = v_s.id;
    perform note_visit_edit(p_encounter_id, 'update', 'visit_section', v_s.id,
                            jsonb_build_object('section', p_section, 'text', v_text, 'reason', v_reason));
  end if;
  return jsonb_build_object('section', p_section, 'text', v_text, 'changed', true);
end
$$;

-- ---------------------------------------------------------------- 3 5 diagnoses
-- A diagnosis: step 3 (p_stage 'differential') or step 5 ('definitive', the default). A
-- definitive diagnosis not in the differential list may be written there too
-- (p_also_differential), for the record.
create or replace function add_visit_diagnosis(
  p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default 'primary',
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
  if v_stage = 'definitive' and p_also_differential then
    insert into condition (encounter_id, text, icd10_code, type, stage)
    values (p_encounter_id, trim(p_text), v_icd, 'secondary', 'differential')
    returning id into v_dd;
    perform note_visit_edit(p_encounter_id, 'create', 'condition', v_dd,
                            jsonb_build_object('text', trim(p_text), 'icd10', v_icd, 'stage', 'differential'));
  end if;
  insert into condition (encounter_id, text, icd10_code, type, stage, differential_id)
  values (p_encounter_id, trim(p_text), v_icd, coalesce(p_type, 'primary'), v_stage, v_dd)
  returning id into v_id;
  perform note_visit_edit(p_encounter_id, 'create', 'condition', v_id,
                          jsonb_build_object('text', trim(p_text), 'icd10', v_icd,
                                             'type', p_type, 'stage', v_stage, 'differential', v_dd));
  return v_id;
end
$$;

-- The earlier way in (the same signature, kept for the old screens): provisional = differential.
create or replace function add_diagnosis(p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default 'primary', p_provisional boolean default false)
returns uuid
language sql security definer set search_path = public
as $$
  select add_visit_diagnosis(p_encounter_id, p_text, p_icd10, p_type,
                             case when p_provisional then 'differential' else 'definitive' end, false)
$$;

-- Confirm a differential diagnosis: the definitive one (step 5) is written, linked to it; the
-- differential stays in step 3, marked confirmed.
create or replace function confirm_differential(p_id uuid, p_type condition_type default 'primary')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_id uuid;
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
  insert into condition (encounter_id, text, icd10_code, type, stage, differential_id)
  values (v_c.encounter_id, v_c.text, v_c.icd10_code, coalesce(p_type, 'primary'), 'definitive', p_id)
  returning id into v_id;
  perform note_visit_edit(v_c.encounter_id, 'create', 'condition', v_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', p_type,
                                             'stage', 'definitive', 'differential', p_id));
  return v_id;
end
$$;

-- update_condition: the last definition (all.sql:47076) + 0127
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
                     and x.type = 'primary' and x.deleted_at is null) then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition
  set text = v_text, icd10_code = v_icd, type = v_type,
      stage = case when v_prov then 'differential' else 'definitive' end, edit_reason = trim(p_reason)
  where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'update', 'condition', p_id,
                          jsonb_build_object('text', v_text, 'icd10', v_icd, 'type', v_type, 'provisional', v_prov,
                                             'reason', trim(p_reason)));
  return jsonb_build_object('id', p_id, 'text', v_text, 'icd10', v_icd, 'type', v_type, 'provisional', v_prov);
end
$$;


-- ---------------------------------------------------------------- B finishing
-- finish_visit: the last definition (all.sql:60913) + 0127
create or replace function finish_visit(p_encounter_id uuid, p_no_diagnosis text default null,
                                        p_no_diagnosis_note text default null)
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
  if p_no_diagnosis is not null then
    perform set_no_diagnosis(p_encounter_id, p_no_diagnosis, p_no_diagnosis_note);
  end if;
  v_rx := exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m));
  v_next := case when v_rx then 'pharmacy' else 'cashier' end;
  -- the patient already waits there (the doctor sent them on before finishing): keep that place
  select * into v_keep from queue_entry
  where encounter_id = p_encounter_id and station = v_next and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  perform close_encounter(p_encounter_id);
  -- 0127: step 1 — the chief complaint is written before the visit is finished
  if exists (select 1 from encounter e where e.id = p_encounter_id
             and e.type in ('opd', 'dental', 'procedure', 'observation'))
     and visit_complaint(p_encounter_id) is null then
    raise exception 'write the chief complaint (step 1) before finishing the visit'
      using errcode = '23514', hint = 'complaint_needed';
  end if;
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


-- ---------------------------------------------------------------- 6 nurse orders
-- The doctor gives an order to the nurses: a medical act (a treatment of the catalogue is billed
-- each time it is done) or a drug of the stock to give (dose, route, how often, how many times),
-- for one nurse or all of them. The nurses are told.
create or replace function create_nurse_order(
  p_encounter_id uuid, p_kind text, p_text text default null, p_service_id uuid default null,
  p_item_id uuid default null, p_quantity numeric default 1, p_dose text default null,
  p_route text default null, p_frequency text default null, p_doses integer default 1,
  p_assigned_to uuid default null, p_notes text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_text text := nullif(trim(coalesce(p_text, '')), '');
  v_id uuid;
  v_params jsonb;
  v_link text;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_doctor() then
    raise exception 'not allowed: the doctor gives the orders to the nurses' using errcode = '42501', hint = 'not_doctor';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found or v_e.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if coalesce(p_kind, '') not in ('act', 'drug') then
    raise exception 'say whether it is a medical act or a drug to give' using errcode = '22023';
  end if;
  if p_doses is null or p_doses < 1 or p_doses > 60 then
    raise exception 'the number of times is between 1 and 60' using errcode = '22023';
  end if;
  if coalesce(p_quantity, 1) <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_kind = 'drug' then
    if p_item_id is null or not exists (select 1 from item i where i.id = p_item_id and i.active and i.deleted_at is null) then
      raise exception 'choose the medicine from the stock' using errcode = '22023', hint = 'item_needed';
    end if;
    v_text := coalesce(v_text, item_label(p_item_id));
  else
    if p_service_id is not null
       and not exists (select 1 from service s where s.id = p_service_id and s.active and s.deleted_at is null) then
      raise exception 'unknown service' using errcode = '22023';
    end if;
    v_text := coalesce(v_text, (select s.name_en from service s where s.id = p_service_id));
  end if;
  if length(coalesce(v_text, '')) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not exists (
       select 1 from profiles p where p.id = p_assigned_to and p.active and p.deleted_at is null
         and (p.role = 'nurse' or desk_via(p.id, 'nursing') is not null)) then
    raise exception 'send it to a nurse, or to all the nurses' using errcode = '22023', hint = 'not_nurse';
  end if;
  insert into nurse_order (encounter_id, patient_id, kind, text, service_id, item_id, quantity, dose, route,
                           frequency, doses_planned, assigned_to, notes)
  values (p_encounter_id, v_e.patient_id, p_kind, v_text,
          case when p_kind = 'act' then p_service_id end, case when p_kind = 'drug' then p_item_id end,
          coalesce(p_quantity, 1), nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_doses, p_assigned_to, nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  -- the nurses are told: the one named, else everyone at the nursing desk (else the role)
  v_link := '/app/visit?encounter=' || p_encounter_id;
  v_params := jsonb_build_object('orderId', v_id, 'kind', p_kind, 'title', v_text, 'times', p_doses,
                                 'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_e.patient_id),
                                 'by', (select full_name from profiles where id = auth.uid()));
  if p_assigned_to is not null then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('nurse_order', v_params, v_link, p_assigned_to, auth.uid());
  elsif desk_offered('nursing') then
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'nurse_order', v_params, v_link, p.id, auth.uid()
    from profiles p
    where p.active and p.deleted_at is null and p.role <> 'manager' and p.id <> auth.uid()
      and desk_via(p.id, 'nursing') is not null;
  else
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('nurse_order', v_params, v_link, 'nurse', auth.uid());
  end if;
  return nurse_order_json(v_id);
end
$$;

-- Tell the doctor who gave the order (a time not given, the order over).
create or replace function nurse_order_tell(p_id uuid, p_what text, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
begin
  select * into v_o from nurse_order where id = p_id;
  if v_o.created_by is null or v_o.created_by = auth.uid() then
    return;
  end if;
  insert into notification (kind, params, link, recipient_user, created_by)
  values ('nurse_order_done',
          jsonb_build_object('orderId', v_o.id, 'title', v_o.text, 'what', p_what, 'reason', p_reason,
                             'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_o.patient_id),
                             'by', (select full_name from profiles where id = auth.uid())),
          '/app/visit?encounter=' || v_o.encounter_id, v_o.created_by, auth.uid());
end
$$;

-- The checks of a nurse carrying out an order; returns it locked.
create or replace function nurse_order_for_work(p_id uuid)
returns nurse_order
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_o from nurse_order where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not (nurse_order_mine(v_o.assigned_to) or is_manager()) then
    raise exception 'not allowed: this order is for another nurse' using errcode = '42501', hint = 'not_yours';
  end if;
  if v_o.status <> 'open' then
    raise exception 'this order is already over' using errcode = '22023', hint = 'order_over';
  end if;
  if not exists (select 1 from encounter e where e.id = v_o.encounter_id and e.status = 'open' and e.deleted_at is null) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  return v_o;
end
$$;

-- The order is over once every time is recorded: done when something was given, else not done.
create or replace function nurse_order_close_if_complete(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_n integer;
  v_given integer;
begin
  select * into v_o from nurse_order where id = p_id;
  select count(*), count(*) filter (where given) into v_n, v_given
  from nurse_order_dose where order_id = p_id and deleted_at is null;
  if v_n >= v_o.doses_planned then
    update nurse_order
    set status = case when v_given > 0 then 'done' else 'not_done' end, ended_at = now(), ended_by = auth.uid()
    where id = p_id;
    perform nurse_order_tell(p_id, case when v_given > 0 then 'done' else 'not_done' end);
  end if;
end
$$;

-- The nurse records one time given (now, or when it was given within the last day): a drug is
-- taken from a room store she holds (her own first; MS003 when it has not enough) and billed at
-- the medicine's price, an act billed at its treatment's price, as the medicines given here; a
-- closed bill or a missing price leaves it unbilled (said: charged false), never unrecorded.
create or replace function give_nurse_order(
  p_order_id uuid, p_note text default null, p_at timestamptz default null, p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_at timestamptz := coalesce(p_at, now());
  v_n integer;
  v_qty integer;
  v_loc uuid;
  v_charged boolean := false;
begin
  v_o := nurse_order_for_work(p_order_id);
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '24 hours' then
    raise exception 'the time given is not possible' using errcode = '22023', hint = 'bad_time';
  end if;
  v_n := (select count(*) from nurse_order_dose where order_id = v_o.id and deleted_at is null) + 1;
  if v_o.kind = 'drug' then
    v_qty := ceil(v_o.quantity)::integer;
    v_loc := room_store_for(auth.uid(), v_o.item_id, v_qty, p_location_id, 'nursing');
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in the store you give from'
        using errcode = 'MS003', hint = 'room_short';
    end if;
    perform give_from_store(v_o.item_id, v_loc, v_qty, null, 'nurse order: given');
    update stock_movement set nurse_order_id = v_o.id
    where medication_request_id is null and nurse_order_id is null and item_id = v_o.item_id
      and from_location_id = v_loc and type = 'consumption' and created_at = now();
    begin
      perform add_charge_internal(v_o.encounter_id, 'nursing', null, v_o.item_id, v_o.quantity,
                                  null, null, auth.uid(), null, 'nurse_order', v_o.id);
      v_charged := true;
    exception when sqlstate 'P0002' or sqlstate 'MS001' then
      v_charged := false;
    end;
  elsif v_o.service_id is not null then
    begin
      perform add_charge_internal(v_o.encounter_id, 'nursing', v_o.service_id, null, v_o.quantity,
                                  null, null, auth.uid(), null, 'nurse_order', v_o.id);
      v_charged := true;
    exception when sqlstate 'P0002' or sqlstate 'MS001' then
      v_charged := false;
    end;
  end if;
  insert into nurse_order_dose (order_id, n, given, at, by_id, note, location_id, charged)
  values (v_o.id, v_n, true, v_at, auth.uid(), nullif(trim(coalesce(p_note, '')), ''), v_loc, v_charged);
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id) || jsonb_build_object('charged', v_charged);
end
$$;

-- One time not given, with the reason (the patient refused, vomited…): counted, the doctor told.
create or replace function skip_nurse_dose(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_n integer;
begin
  v_o := nurse_order_for_work(p_order_id);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  v_n := (select count(*) from nurse_order_dose where order_id = v_o.id and deleted_at is null) + 1;
  insert into nurse_order_dose (order_id, n, given, note)
  values (v_o.id, v_n, false, trim(p_reason));
  perform nurse_order_tell(v_o.id, 'not_given', trim(p_reason));
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id);
end
$$;

-- The order stops, with the reason: the doctor who gave it (or the manager) cancels it; the nurse
-- says the rest will not be done.
create or replace function stop_nurse_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_status text;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_o from nurse_order where id = p_order_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_o.status <> 'open' then
    raise exception 'this order is already over' using errcode = '22023', hint = 'order_over';
  end if;
  if v_o.created_by = auth.uid() or is_manager() then
    v_status := 'cancelled';
  elsif nurse_order_mine(v_o.assigned_to) then
    v_status := 'not_done';
  else
    raise exception 'not allowed: this order is for another nurse' using errcode = '42501', hint = 'not_yours';
  end if;
  update nurse_order set status = v_status, ended_at = now(), ended_by = auth.uid(), end_reason = trim(p_reason)
  where id = p_order_id;
  if v_status = 'not_done' then
    perform nurse_order_tell(p_order_id, 'not_done', trim(p_reason));
  elsif v_o.assigned_to is not null and v_o.assigned_to <> auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('nurse_order_done',
            jsonb_build_object('orderId', v_o.id, 'title', v_o.text, 'what', 'cancelled', 'reason', trim(p_reason),
                               'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_o.patient_id),
                               'by', (select full_name from profiles where id = auth.uid())),
            '/app/visit?encounter=' || v_o.encounter_id, v_o.assigned_to, auth.uid());
  end if;
  return nurse_order_json(p_order_id);
end
$$;

-- The nurse's Home: the open orders for me on the open visits, oldest first.
create or replace function nurse_orders_for_me()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(nurse_order_json(o.id) || jsonb_build_object(
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number, 'patientId', p.id,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
                 order by q.created_at limit 1))
    order by o.created_at), '[]'::jsonb)
  from nurse_order o
  join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
  join patient p on p.id = o.patient_id
  where o.deleted_at is null and o.status = 'open' and has_perm('clinical.write')
    and nurse_order_mine(o.assigned_to)
$$;

-- The nurses an order may be sent to by name (the doctor's form): the nurses, and whoever works
-- at the nursing desk; never the manager.
create or replace function order_nurses()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name), '[]'::jsonb)
  from profiles p
  where auth.uid() is not null and has_perm('clinical.write')
    and p.active and p.deleted_at is null and p.role <> 'manager'
    and (p.role = 'nurse' or desk_via(p.id, 'nursing') is not null)
$$;

-- ---------------------------------------------------------------- 1 the patient's past
-- The summary of the patient's earlier visits for step 1. A doctor with access (0088: the manager,
-- a head in charge, an approved request, an emergency) sees it; with the setting on, so does a
-- doctor working on the patient's open visit ('treating'). Each opening goes to the access log.
-- Otherwise: allowed false and why (not_doctor, setting_off, not_treating), with the request flow.
create or replace function visit_past_history(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_via text;
  v_count integer;
  v_on boolean := history_for_treating_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  -- how many earlier visits: the list of visits is not a record (0126)
  select count(*) into v_count from encounter e
  where e.patient_id = v_e.patient_id and e.id <> v_e.id and e.deleted_at is null and e.arrived_at < v_e.arrived_at;
  if not is_doctor() or not clinical_reader() then
    return jsonb_build_object('allowed', false, 'reason', 'not_doctor', 'count', v_count, 'setting', v_on);
  end if;
  v_via := history_via(v_e.patient_id);
  if v_via is null then
    if v_on and v_e.status = 'open' and visit_working_on(v_e.id) then
      v_via := 'treating';
    else
      return jsonb_build_object('allowed', false, 'count', v_count, 'setting', v_on,
                                'reason', case when not v_on then 'setting_off' else 'not_treating' end,
                                'access', patient_access(v_e.patient_id));
    end if;
  end if;
  if v_count > 0 then
    perform log_record_access(v_e.patient_id, null, v_via, 'history');
  end if;
  return jsonb_build_object(
    'allowed', true, 'via', v_via, 'count', v_count, 'setting', v_on,
    'safety', (select jsonb_build_object('allergies', s -> 'allergies', 'allergiesNone', s -> 'allergiesNone',
                                         'alerts', s -> 'alerts', 'chronic', s -> 'chronic')
               from patient_safety_summary(v_e.patient_id) s),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', e.id, 'reference', e.reference, 'at', e.arrived_at, 'status', e.status, 'service', e.service,
          'department', (select d.name from queue_entry q join department d on d.id = q.department_id
                         where q.encounter_id = e.id and q.deleted_at is null order by q.created_at desc limit 1),
          'desks', (select coalesce(jsonb_agg(distinct q.station::text), '[]'::jsonb) from queue_entry q
                    where q.encounter_id = e.id and q.deleted_at is null
                      and q.station not in ('reception', 'cashier', 'pharmacy')),
          'doctor', (select pr.full_name from profiles pr where pr.id = coalesce(
                       (select c.created_by from condition c where c.encounter_id = e.id and c.deleted_at is null
                        order by (c.stage = 'definitive') desc, c.created_at limit 1),
                       (select q.taken_by from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
                          and q.taken_by is not null and station_desks(q.station) && treating_desks()
                        order by q.created_at limit 1))),
          'complaint', visit_complaint(e.id),
          'plan', (select s.text from visit_section s where s.encounter_id = e.id and s.section = 'plan' and s.deleted_at is null),
          'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('text', c.text, 'icd10', c.icd10_code, 'type', c.type)
                                                  order by (c.type = 'primary') desc, c.created_at)
                                 from condition c where c.encounter_id = e.id and c.deleted_at is null
                                   and c.stage = 'definitive'
                                   and (v_sens or coalesce(c.icd10_code, '') !~ '^B2[0-4]')), '[]'::jsonb),
          'noDiagnosis', case when e.no_diagnosis_kind is not null
                              then jsonb_build_object('kind', e.no_diagnosis_kind, 'note', e.no_diagnosis_note) end,
          'medicines', coalesce((select jsonb_agg(jsonb_build_object('item', rx_label(m), 'dose', m.dose,
                                   'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity,
                                   'supply', m.supply) order by m.created_at)
                                 from medication_request m where m.encounter_id = e.id and m.deleted_at is null
                                   and m.cancelled_at is null), '[]'::jsonb),
          'nurseOrders', coalesce((select jsonb_agg(jsonb_build_object('kind', o.kind, 'text', o.text, 'status', o.status,
                                     'dose', o.dose, 'frequency', o.frequency, 'planned', o.doses_planned,
                                     'given', (select count(*) from nurse_order_dose d where d.order_id = o.id
                                               and d.deleted_at is null and d.given)) order by o.created_at)
                                   from nurse_order o where o.encounter_id = e.id and o.deleted_at is null), '[]'::jsonb),
          'tests', coalesce((select jsonb_agg(jsonb_build_object('test', s.name_en, 'status', r.status,
                               'findings', d.findings, 'impression', d.impression,
                               'verified', d.verified_at is not null) order by r.created_at)
                             from service_request r join service s on s.id = r.service_id
                             left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
                             where r.encounter_id = e.id and r.deleted_at is null
                               and (v_sens or not sensitive_service(s.id))), '[]'::jsonb)
        ) order by e.arrived_at desc)
      from (select * from encounter e0
            where e0.patient_id = v_e.patient_id and e0.id <> v_e.id and e0.deleted_at is null
              and e0.arrived_at < v_e.arrived_at
            order by e0.arrived_at desc limit 30) e), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- the record and the desk part
-- visit_clinical: the last definition (all.sql:62955) + 0127
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
        'history', record_history('condition', c.id)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))), '[]'::jsonb),
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
    'view', v_view,
    -- 0104: the lock of a finished visit and the reader's edit window
    'editLock', visit_edit_status(p_encounter_id),
    -- 0127: the doctor's texts (steps 1, 2, 6) and the orders to the nurses
    'sections', visit_sections_json(p_encounter_id, null),
    'nurseOrders', visit_nurse_orders(p_encounter_id, false),
    'hasComplaint', visit_complaint(p_encounter_id) is not null
  );
end
$$;

-- visit_clinical_desk: the last definition (all.sql:62631) + 0127
create or replace function visit_clinical_desk(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_pharmacy boolean := works_at_desk('pharmacy');
  v_treat boolean := exists (select 1 from unnest(treating_desks()) d(desk) where works_at_desk(d.desk));
  v_sens boolean := has_perm('sensitive.read');
begin
  return jsonb_build_object(
    -- what the person wrote themselves (removed ones stay, marked)
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'stage', c.stage, 'differentialId', c.differential_id, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by), 'byId', c.created_by,
        'editedAt', case when c.deleted_at is null and c.edit_reason is not null then c.updated_at end,
        'editedBy', case when c.deleted_at is null and c.edit_reason is not null then (select full_name from profiles where id = c.updated_by) end,
        'editReason', case when c.deleted_at is null then c.edit_reason end,
        'removedAt', c.deleted_at,
        'removedBy', case when c.deleted_at is not null then (select full_name from profiles where id = c.updated_by) end,
        'removeReason', case when c.deleted_at is not null then c.edit_reason end,
        'history', '[]'::jsonb) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.created_by = v_me), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id), 'byId', coalesce(o.performer_id, o.created_by),
        'editedAt', case when o.edit_reason is not null then o.updated_at end,
        'editedBy', case when o.edit_reason is not null then (select full_name from profiles where id = o.updated_by) end,
        'editReason', o.edit_reason,
        'history', '[]'::jsonb) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null
        and coalesce(o.performer_id, o.created_by) = v_me), '[]'::jsonb),
    -- the medicines: the person's own; the pharmacy's to hand over; a treating desk's given in the room
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
        'splitFrom', m.split_from,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null
        and (coalesce(m.prescriber_id, m.created_by) = v_me or v_pharmacy or (v_treat and m.supply = 'room'))), '[]'::jsonb),
    -- the tests the person's desk runs, with their reason and result; the tests they asked for
    -- themselves without the result (an HIV test: the desk running it, or sensitive.read)
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status,
        'reason', case when k.runs or r.requester_id = v_me then r.reason end, 'at', r.created_at, 'mine', coalesce(r.requester_id = v_me, false),
        'result', case when k.runs then (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null) end) order by r.created_at)
      from service_request r
      join service s on s.id = r.service_id
      cross join lateral (
        select works_at_desk(request_desk(r.station, r.category))
               or (coalesce(r.station::text, 'laboratory') not in ('laboratory', 'ultrasound')
                   and has_perm('clinical.write')
                   and exists (select 1 from unnest(station_desks(r.station)) sd(desk) where works_at_desk(sd.desk))) as runs
      ) k
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (k.runs or (r.requester_id = v_me and (v_sens or not sensitive_service(s.id))))), '[]'::jsonb),
    -- the safety summary of the patient: allergies, blood group, alerts
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', 'desk',
    -- the rest of the record is for doctors
    'forDoctors', true,
    'desk', jsonb_build_object('pharmacy', v_pharmacy, 'treating', v_treat,
                               'laboratory', works_at_desk('laboratory'), 'ultrasound', works_at_desk('ultrasound')),
    -- what finishing the visit needs to know, without the words
    'hasPrimaryDiagnosis', exists (select 1 from condition c
                                   where c.encounter_id = p_encounter_id and c.deleted_at is null and c.type = 'primary'),
    'hasNoDiagnosis', exists (select 1 from encounter e where e.id = p_encounter_id and e.no_diagnosis_kind is not null),
    'editLock', visit_edit_status(p_encounter_id),
    -- 0127: what the person wrote of the doctor's texts, the orders for them; finishing needs to
    -- know there is a chief complaint, without its words
    'sections', visit_sections_json(p_encounter_id, v_me),
    'nurseOrders', visit_nurse_orders(p_encounter_id, true),
    'hasComplaint', visit_complaint(p_encounter_id) is not null
  );
end
$$;


-- ---------------------------------------------------------------- who took part, who treated
-- took_part: the last definition (all.sql:38162) + 0127
create or replace function took_part(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user is not null and (
    exists (select 1 from queue_entry q
            where q.encounter_id = p_encounter_id and q.deleted_at is null and q.taken_by = p_user
              and q.station not in ('reception', 'cashier'))
    or exists (select 1 from condition c
               where c.encounter_id = p_encounter_id and c.deleted_at is null and c.created_by = p_user)
    or exists (select 1 from observation o
               where o.encounter_id = p_encounter_id and o.deleted_at is null
                 and (o.performer_id = p_user or o.created_by = p_user))
    or exists (select 1 from medication_request m
               where m.encounter_id = p_encounter_id and m.deleted_at is null
                 and coalesce(m.prescriber_id, m.created_by) = p_user)
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.requester_id = p_user)
    or exists (select 1 from service_request r
               join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
               where r.encounter_id = p_encounter_id and (d.created_by = p_user or d.verified_by = p_user))
    or exists (select 1 from procedure pr
               where pr.encounter_id = p_encounter_id and pr.deleted_at is null and pr.performer_id = p_user)
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.answered_by = p_user
                 and c.status in ('accepted', 'done'))
    -- 0127: wrote a text of the visit, gave an order to the nurses, or carried one out
    or exists (select 1 from visit_section s
               where s.encounter_id = p_encounter_id and s.deleted_at is null
                 and (s.created_by = p_user or s.updated_by = p_user))
    or exists (select 1 from nurse_order o
               where o.encounter_id = p_encounter_id and o.deleted_at is null and o.created_by = p_user)
    or exists (select 1 from nurse_order_dose d join nurse_order o on o.id = d.order_id
               where o.encounter_id = p_encounter_id and d.deleted_at is null and d.by_id = p_user)
  )
$$;

-- treated: the last definition (all.sql:40674) + 0127
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
    -- 0127: wrote a text of the visit, or gave an order to the nurses
    or exists (select 1 from visit_section s
               where s.encounter_id = p_encounter_id and s.deleted_at is null and s.created_by = p_user)
    or exists (select 1 from nurse_order o
               where o.encounter_id = p_encounter_id and o.deleted_at is null and o.created_by = p_user)
  )
$$;

-- audit_redacted_entity: the last definition (all.sql:62784) + 0127
create or replace function audit_redacted_entity(p_entity text)
returns boolean
language sql immutable
as $$
  select p_entity in ('condition', 'observation', 'service_request', 'diagnostic_report', 'procedure',
                      'medication_request', 'medication_dispense', 'prescription_doc', 'vaccination', 'fp_event',
                      'hiv_test', 'document', 'patient_file_doc', 'report_correction', 'record_access_request',
                      'record_access_entry', 'internal_task', 'encounter', 'queue_entry', 'patient',
                      'patient_handover', 'visit_section', 'nurse_order', 'nurse_order_dose')
$$;

-- audit_redact: the last definition (all.sql:62796) + 0127
create or replace function audit_redact(p_entity text, p jsonb)
returns jsonb
language sql immutable
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' or not audit_redacted_entity(p_entity) then p
    else p - array['text', 'icd10_code', 'value_text', 'findings', 'impression', 'reason', 'instructions',
                   'note', 'notes', 'detail', 'title', 'triage_reason', 'referral_note', 'no_diagnosis_kind',
                   'no_diagnosis_note', 'correction_reason', 'edit_reason', 'old_findings', 'old_impression',
                   'allergies', 'allergies_none', 'blood_group', 'answer_note', 'review_note',
                   'not_given_reason', 'cancel_reason', 'supply_reason', 'dose', 'frequency', 'route',
                   'result', 'conclusion', 'extra', 'flags', 'outcome', 'summary', 'end_reason']
  end
$$;


-- ---------------------------------------------------------------- C reports and lists
-- report_visit_diagnosis: the last definition (all.sql:61047) + 0127
create or replace function report_visit_diagnosis(p_encounter_id uuid, p_sensitive boolean)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select c.text || coalesce(' (' || c.icd10_code || ')', '')
     from condition c
     where c.encounter_id = p_encounter_id and c.deleted_at is null and c.stage = 'definitive'
       and (p_sensitive or coalesce(c.icd10_code, '') !~ '^B2[0-4]')
     order by (c.type = 'primary') desc, c.created_at
     limit 1),
    (select no_diagnosis_marker(e.no_diagnosis_kind, e.no_diagnosis_note) from encounter e where e.id = p_encounter_id))
$$;

-- patient_safety_summary: the last definition (all.sql:62899) + 0127
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
        where e.patient_id = p.id and c.deleted_at is null and c.stage = 'definitive'
          and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or (has_perm('sensitive.read') and is_doctor()))
          and (coalesce(c.icd10_code, '') ~ '^(I1[0-5]|I25|I50|E0[3-5]|E1[0-4]|J4[45]|G40|N18|B18|B2[0-4]|F2[0-9]|F3[1-3])'
               or (select count(distinct c2.encounter_id) from condition c2
                   join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                   where e2.patient_id = p.id and c2.deleted_at is null and c2.stage = 'definitive' and lower(c2.text) = lower(c.text)) >= 2)
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

-- report_diagnoses: the last definition (all.sql:61591) + 0127
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
             visit_departments(e.id) as depts
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
             visit_departments(e.id)
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
    )
    select jsonb_agg(jsonb_build_object(
        'code', x.code, 'diagnosis', x.text, 'cases', x.cases, 'patients', x.patients,
        'newCases', x.new_cases, 'followUp', x.follow_up, 'primary', x.prim,
        'female', x.female, 'male', x.male, 'otherSex', x.cases - x.female - x.male,
        'age0to4', x.a0, 'age5to14', x.a5, 'age15to24', x.a15, 'age25to49', x.a25, 'age50plus', x.a50,
        'ageUnknown', x.au
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
  ), '[]'::jsonb);
end
$$;

-- The diagnoses report as before (four arguments): the definitive diagnoses.
create or replace function report_diagnoses(
  p_from date, p_to date, p_department uuid default null, p_doctor uuid default null
)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select report_diagnoses_staged(p_from, p_to, p_department, p_doctor, 'definitive')
$$;
-- report_patients_seen: the last definition (all.sql:63801) + 0127
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
        'diagnosis', case when v_doc then coalesce((select string_agg(coalesce(c.icd10_code || ' ', '') || c.text, '; '
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

-- visits_in_period: the last definition (all.sql:63567) + 0127
create or replace function visits_in_period(
  p_from date default null,
  p_to date default null,
  p_department uuid default null,
  p_doctor uuid default null,
  p_service text default null,
  p_insurer uuid default null,
  p_closed_only boolean default false,
  p_search text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_result jsonb;
  v_rows jsonb;
  v_options jsonb;
  -- 0126: the diagnosis column for doctors
  v_doc boolean := is_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with base as (
  select e.id, e.reference, e.arrived_at, e.closed_at, e.status::text as status, e.service,
         p.id as patient_id, p.surname || ' ' || p.given_names as patient, p.file_number,
         d.id as department_id, d.name as department,
         doc.id as doctor_id, doc.full_name as doctor,
         c.text as diagnosis, c.icd10_code as icd10,
         ins.id as insurer_id, ins.name as insurer
  from encounter e
  join patient p on p.id = e.patient_id
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
    select c1.text, c1.icd10_code from condition c1
    where c1.encounter_id = e.id and c1.deleted_at is null and c1.stage = 'definitive'
    order by (c1.type = 'primary') desc, c1.created_at limit 1
  ) c on true
  left join lateral (
    select py.id, py.name from coverage cv
    join payer py on py.id = cv.payer_id and py.type <> 'cash'
    where cv.id = coalesce((select i.coverage_id from invoice i where i.encounter_id = e.id and i.deleted_at is null limit 1),
                           e.coverage_id)
  ) ins on true
  where e.deleted_at is null
    and (e.arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to
    and (s.s_department is null or exists (
      select 1 from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
        and (q.department_id = s.s_department or q.station = any (s.s_stations))))
  )
  select jsonb_build_object(
    'options', jsonb_build_object(
      'departments', coalesce((select jsonb_agg(jsonb_build_object('id', x.department_id, 'name', x.department) order by x.department)
                               from (select distinct department_id, department from base where department_id is not null) x), '[]'::jsonb),
      'doctors', coalesce((select jsonb_agg(jsonb_build_object('id', x.doctor_id, 'name', x.doctor) order by x.doctor)
                           from (select distinct doctor_id, doctor from base where doctor_id is not null) x), '[]'::jsonb),
      'services', coalesce((select jsonb_agg(x.service order by x.service)
                            from (select distinct service from base where service is not null) x), '[]'::jsonb),
      'insurers', coalesce((select jsonb_agg(jsonb_build_object('id', x.insurer_id, 'name', x.insurer) order by x.insurer)
                            from (select distinct insurer_id, insurer from base where insurer_id is not null) x), '[]'::jsonb)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'reference', b.reference, 'at', b.arrived_at, 'closedAt', b.closed_at, 'status', b.status,
        'service', b.service,
        'patient', jsonb_build_object('id', b.patient_id, 'name', b.patient, 'fileNumber', b.file_number),
        'doctor', case when b.doctor_id is null then null else jsonb_build_object('id', b.doctor_id, 'name', b.doctor) end,
        'department', case when b.department_id is null then null else jsonb_build_object('id', b.department_id, 'name', b.department) end,
        'diagnosis', case when v_doc and (v_sens or coalesce(b.icd10, '') !~ '^B2[0-4]') then b.diagnosis end,
        'icd10', case when v_doc and (v_sens or coalesce(b.icd10, '') !~ '^B2[0-4]') then b.icd10 end,
        'insurer', b.insurer,
        -- 0127: the chief complaint (step 1), for doctors
        'complaint', case when v_doc then visit_complaint(b.id) end
      ) order by b.arrived_at, b.id)
      from (select * from base b
            where (p_doctor is null or b.doctor_id = p_doctor)
              and (p_service is null or b.service = p_service)
              and (p_insurer is null or b.insurer_id = p_insurer)
              and (not p_closed_only or b.status = 'closed')
              and (v_q is null or b.patient ilike '%' || v_q || '%' or b.file_number ilike '%' || v_q || '%'
                   or coalesce(b.reference, '') ilike '%' || v_q || '%' or (v_doc and (v_sens or coalesce(b.icd10, '') !~ '^B2[0-4]')
                       and coalesce(b.diagnosis, '') ilike '%' || v_q || '%'))
            order by b.arrived_at, b.id
            limit 2000) b), '[]'::jsonb))
  into v_result;
  v_options := v_result -> 'options';
  v_rows := v_result -> 'rows';

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', s.s_manager,
    'department', s.s_department,
    'count', jsonb_array_length(v_rows),
    'closed', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'closed'),
    'open', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'open'),
    'options', v_options,
    'visits', v_rows);
end
$$;

-- patient_file: the last definition (all.sql:49818) + 0127
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
      'provisional', c.provisional, 'stage', c.stage, 'at', c.created_at, 'by', (select full_name from profiles where id = c.created_by)
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


-- ---------------------------------------------------------------- the menu count
-- nav_counts: the last definition (all.sql:64322) + 0127
create or replace function nav_counts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_desks text[] := my_desk_list();
  v_station station;
  -- a doctor's or nurse's desk: consultation, dental, nursing, triage…
  v_treat boolean;
  v_pharmacy boolean;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_e integer;
begin
  if v_me is null or v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_start := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_today + 1)::timestamp) at time zone 'Africa/Kigali';
  v_station := my_home_station();
  v_treat := not v_manager and v_role not in ('receptionist', 'cashier')
             and v_desks && (treating_desks() || array['triage']);
  v_pharmacy := not v_manager and 'pharmacy' = any (v_desks);

  -- MY QUEUE and THE PATIENTS AT MY DESKS (the rule of my_summary's "Waiting for me"): an entry
  -- that joined the queue today is today's; an older one still open is from an earlier day.
  if v_treat and has_perm('queue.read') and has_perm('patient.read') then
    with mine as (
      select q.encounter_id, q.started_at, (q.created_at >= v_start) as is_today
      from queue_entry q
      join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
      where q.deleted_at is null and q.finished_at is null
        and (q.assigned_to = v_me
             or q.taken_by = v_me
             or exists (select 1 from patient_handover h
                        where h.queue_id = q.id and h.status = 'pending' and h.to_user = v_me
                          and h.deleted_at is null)
             or (q.assigned_to is null and q.taken_by is null
                 and (serves_station(v_me, q.station, coalesce(q.service, e.service))
                      or q.station = v_station)
                 and (q.department_id is null
                      or exists (select 1 from profiles me where me.id = v_me and me.department_id = q.department_id)
                      or exists (select 1 from staff_department sd
                                 where sd.profile_id = v_me and sd.department_id = q.department_id))))
    ),
    -- a patient with an entry of today is today's, even when an older one is still open
    visits as (select encounter_id, bool_or(is_today) as is_today from mine group by encounter_id)
    select jsonb_build_object(
             'queue', (select count(*) from mine where started_at is null and is_today),
             'queueEarlier', (select count(*) from mine where started_at is null and not is_today),
             'inClinic', (select count(*) from visits where is_today),
             'inClinicEarlier', (select count(*) from visits where not is_today))
    into v_out;
  elsif (v_manager or v_role = 'receptionist') and has_perm('patient.read') then
    select jsonb_build_object(
             'inClinic', count(*) filter (where e.arrived_at >= v_start),
             'inClinicEarlier', count(*) filter (where e.arrived_at < v_start))
    into v_out
    from encounter e where e.status = 'open' and e.deleted_at is null;
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if not v_manager
     and ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'surgery', 'circ']) d(desk)
                     where desk_via(v_me, d.desk) = 'department')) then
    -- given today and not seen; given on one of the 6 days before and still not seen: earlier
    select count(*) filter (where d.updated_at >= v_start),
           count(*) filter (where d.updated_at < v_start)
    into v_n, v_e
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    where d.deleted_at is null and d.reviewed_at is null
      and r.status in ('resulted', 'verified')
      and d.updated_at > now() - interval '7 days'
      -- cheap first: my own request, or a visit handed over to me
      and (r.requester_id = v_me
           or exists (select 1 from patient_handover h where h.encounter_id = r.encounter_id
                      and h.to_user = v_me and h.status = 'taken' and h.deleted_at is null))
      and result_recipient(r.encounter_id, r.requester_id) = v_me;
    -- 0126: results are records: counted for doctors
    if is_doctor() then
      v_out := v_out || jsonb_build_object('results', v_n, 'resultsEarlier', v_e);
    end if;

    -- written today and still waiting at the pharmacy; written earlier: apart
    select count(*) filter (where m.created_at >= v_start),
           count(*) filter (where m.created_at < v_start)
    into v_n, v_e
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open' and e.deleted_at is null
    where coalesce(m.prescriber_id, m.created_by) = v_me and rx_pending(m);
    v_out := v_out || jsonb_build_object('prescriptions', v_n, 'prescriptionsEarlier', v_e);
  end if;

  -- MY BOOKINGS STILL TO SEE, today to 3 weeks ahead (whoever keeps a calendar; 0124, 0125)
  if has_perm('appointment.accept') or v_manager then
    select count(*) into v_n
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_me and pr.deleted_at is null
    where a.deleted_at is null
      -- still to be seen: booked, confirmed or arrived; once the visit is taken (in progress) or
      -- done it leaves the count, one by one
      and a.status in ('approved', 'confirmed', 'arrived')
      and a.starts_at >= v_start and a.starts_at < v_start + interval '22 days';
    if v_n > 0 or exists (select 1 from practitioner pr where pr.user_id = v_me and pr.deleted_at is null) then
      v_out := v_out || jsonb_build_object('myBookings', v_n);
    end if;
  end if;

  -- TODAY'S BOOKINGS + THE REQUESTS THAT CAME TODAY (reception's Bookings page); requests still
  -- unanswered from an earlier day: apart
  if v_manager or v_role = 'receptionist' or has_perm('appointment.approve') then
    -- still to come in: booked or confirmed for today (an arrival leaves the count), and the
    -- requests of today still to answer
    select count(*) filter (where (a.status in ('approved', 'confirmed')
                                   and a.starts_at >= v_start and a.starts_at < v_end)
                                  or (a.status = 'inquiry' and a.created_at >= v_start)),
           count(*) filter (where a.status = 'inquiry' and a.created_at < v_start)
    into v_n, v_e
    from appointment a
    where a.deleted_at is null;
    v_out := v_out || jsonb_build_object('bookings', v_n, 'bookingsEarlier', v_e);
  end if;

  -- THE LABORATORY / ULTRASOUND WORKLIST (the rule of lab_worklist, open): asked today; earlier
  if not v_manager and v_desks && array['laboratory', 'ultrasound'] and has_perm('orders.read') then
    select count(*) filter (where r.created_at >= v_start),
           count(*) filter (where r.created_at < v_start)
    into v_n, v_e
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    where r.deleted_at is null
      and r.status not in ('verified', 'cancelled')
      and r.category = any (my_test_categories())
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station
                                   else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(r.service_id));
    v_out := v_out || jsonb_build_object('worklist', v_n, 'worklistEarlier', v_e);
  end if;

  -- THE PHARMACY: patients with medicines written today to hand over + walk-in sales of today
  -- paid and not handed over; a patient whose medicines all date from an earlier day, and older
  -- walk-in sales: apart
  if v_pharmacy then
    with pending as (
      select m.encounter_id, bool_or(m.created_at >= v_start) as is_today
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.status = 'open'
      where rx_pending(m)
      group by m.encounter_id
    ), sales as (
      select (s.created_at >= v_start) as is_today
      from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and not is_room_type(l.type)
    )
    select (select count(*) from pending where is_today) + (select count(*) from sales where is_today),
           (select count(*) from pending where not is_today) + (select count(*) from sales where not is_today)
    into v_n, v_e;
    v_out := v_out || jsonb_build_object('pharmacy', v_n, 'pharmacyEarlier', v_e);
  elsif not v_manager and exists (
      select 1 from stock_location l
      where l.active and l.deleted_at is null and is_room_type(l.type) and holds_store(v_me, l.id)) then
    -- A ROOM STORE (a doctor's office, the ward): delivery notes sent today to confirm + walk-in
    -- sales of today to give; older ones apart
    with w as (
      select (t.sent_at >= v_start) as is_today from stock_transfer t
      where t.deleted_at is null and t.status = 'in_transit' and t.direction = 'to_room'
        and holds_store(v_me, t.to_location_id)
      union all
      select (s.created_at >= v_start) from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and is_room_type(l.type)
        and holds_store(v_me, s.location_id)
    )
    select count(*) filter (where is_today), count(*) filter (where not is_today) into v_n, v_e from w;
    v_out := v_out || jsonb_build_object('stock', v_n, 'stockEarlier', v_e);
  end if;

  -- MONEY: bills opened today with something still to pay (open visits), walk-in sales of today
  -- waiting to be paid; older ones apart
  if v_manager or v_role = 'cashier' or has_perm('payment.take') then
    select count(*) filter (where i.created_at >= v_start),
           count(*) filter (where i.created_at < v_start)
    into v_n, v_e
    from invoice i join encounter e on e.id = i.encounter_id
    where i.deleted_at is null and i.status = 'draft' and e.status = 'open'
      and invoice_balance(i.id) > 0;
    v_out := v_out || jsonb_build_object('bills', v_n, 'billsEarlier', v_e);
  end if;
  if not v_manager and (v_role = 'cashier' or has_perm('payment.take')) then
    select count(*) filter (where s.created_at >= v_start),
           count(*) filter (where s.created_at < v_start)
    into v_n, v_e
    from counter_sale s where s.deleted_at is null and s.status = 'open';
    v_out := v_out || jsonb_build_object('payments', v_n, 'paymentsEarlier', v_e);
  end if;

  -- RECORD ACCESS: requests waiting for an answer (record_access_requests 'pending'); not day-bound
  -- 0126: doctors only; the requests this doctor may answer
  if is_doctor() then
    v_n := (select count(*) from record_access_request r
            join encounter e on e.id = r.encounter_id and e.status = 'open'
            where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
              and r.created_at > now() - interval '90 days'
              and may_answer_request(r.patient_id, r.requested_by))
           + case when v_manager then
               (select count(*) from record_access_request r
                where r.kind = 'emergency' and r.reviewed_at is null
                  and r.created_at > now() - interval '90 days')
             else 0 end;
    if v_n > 0 or v_manager or has_perm('records.approve') then
      v_out := v_out || jsonb_build_object('recordAccess', v_n);
    end if;
  end if;

  -- STAFF DOCUMENTS expiring within 60 days, or expired (staff_documents_expiring); not day-bound
  if v_manager then
    v_out := v_out || jsonb_build_object('documents',
      (select count(*) from staff_document d
       join profiles p on p.id = d.profile_id and p.active
       where d.deleted_at is null and d.kind in ('licence', 'contract')
         and d.expires_on is not null and d.expires_on <= staff_doc_today() + 60));
  end if;

  -- FILES TO COMPLETE (reception): today's only (0123), as the list opens
  if v_role = 'receptionist' and has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('filesToComplete',
      (with s as (select patient_builtins() as b, patient_fields() as f)
       select count(distinct p.id)
       from patient p
       cross join s
       left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
       where p.deleted_at is null and p.merged_into is null
         and (coalesce(e.arrived_at, p.created_at) at time zone 'Africa/Kigali')::date
             = (now() at time zone 'Africa/Kigali')::date
         and cardinality(patient_missing_with(p, s.b, s.f)) > 0));
  end if;

  -- 0127: THE ORDERS OF THE DOCTORS TO CARRY OUT (the nurse's Home): mine by name, and those for
  -- all the nurses when I work at the nursing desk; given today, given earlier
  if not v_manager and has_perm('clinical.write') then
    select count(*) filter (where o.created_at >= v_start), count(*) filter (where o.created_at < v_start)
    into v_n, v_e
    from nurse_order o
    join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
    where o.deleted_at is null and o.status = 'open' and nurse_order_mine(o.assigned_to);
    if v_n + v_e > 0 or task_for_me('nurse') then
      v_out := v_out || jsonb_build_object('nurseOrders', v_n, 'nurseOrdersEarlier', v_e);
    end if;
  end if;

  -- an "earlier" count only when there is something from an earlier day
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from jsonb_each(v_out) x(k, v)
  where not (k like '%Earlier' and v = '0'::jsonb);

  return v_out;
end
$$;


-- ---------------------------------------------------------------- rights
revoke all on function condition_stage_sync(), visit_complaint(uuid), visit_sections_json(uuid, uuid),
  nurse_order_json(uuid), visit_nurse_orders(uuid, boolean), nurse_order_tell(uuid, text, text),
  nurse_order_for_work(uuid), nurse_order_close_if_complete(uuid)
  from public, anon, authenticated;
revoke all on function save_visit_section(uuid, text, text, text), confirm_differential(uuid, condition_type),
  add_visit_diagnosis(uuid, text, text, condition_type, text, boolean),
  create_nurse_order(uuid, text, text, uuid, uuid, numeric, text, text, text, integer, uuid, text),
  give_nurse_order(uuid, text, timestamptz, uuid), skip_nurse_dose(uuid, text), stop_nurse_order(uuid, text),
  nurse_orders_for_me(), visit_past_history(uuid), history_for_treating_doctor(), nurse_order_mine(uuid),
  report_diagnoses_staged(date, date, uuid, uuid, text), order_nurses()
  from public, anon;
grant execute on function save_visit_section(uuid, text, text, text), confirm_differential(uuid, condition_type),
  add_visit_diagnosis(uuid, text, text, condition_type, text, boolean),
  create_nurse_order(uuid, text, text, uuid, uuid, numeric, text, text, text, integer, uuid, text),
  give_nurse_order(uuid, text, timestamptz, uuid), skip_nurse_dose(uuid, text), stop_nurse_order(uuid, text),
  nurse_orders_for_me(), visit_past_history(uuid), history_for_treating_doctor(), nurse_order_mine(uuid),
  report_diagnoses_staged(date, date, uuid, uuid, text), order_nurses()
  to authenticated;
