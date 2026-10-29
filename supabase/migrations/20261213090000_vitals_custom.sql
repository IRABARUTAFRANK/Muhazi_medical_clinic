-- 0102 Vital signs the clinic chooses: a catalogue of measurements with units and limits, custom
-- measurements with a typed name, a default set (and order) the manager picks in Settings, and a
-- measurement removed from a visit with a reason (kept, in the audit).
--
-- * vital_type: the catalogue (the nine of before plus blood glucose in mmol/L and mg/dL, pain
--   score, head circumference, urine output, Glasgow coma score, fundal height, fetal heart rate).
--   BMI is computed on the screens from weight and height, never stored.
-- * observation.label: the typed name of a custom measurement (code 'custom_<slug>');
--   observation.remove_reason / removed_by: a measurement removed with remove_vital.
-- * record_vitals accepts a number as before, or {"value", "unit", "label"} per code; the limits
--   of the catalogue are checked here as the form checks them.
-- * remove_vital(p_id, p_reason): soft removal, audited.
-- * vitals_setting() / save_vitals_setting(p_codes): the clinic's default set, setting 'vitals.default'.
-- * visit_vitals: every measurement of the catalogue and the custom ones, with id and label.

-- ---------------------------------------------------------------- 1. the catalogue
create table if not exists vital_type (
  code text primary key,
  unit text not null,
  min_value numeric not null,
  max_value numeric not null,
  sort smallint not null default 100,
  check (min_value < max_value)
);
comment on table vital_type is 'The measurements the vital signs form knows: unit and the values a living patient can have.';
insert into vital_type (code, unit, min_value, max_value, sort) values
  ('bp_sys', 'mmHg', 40, 300, 10),
  ('bp_dia', 'mmHg', 20, 200, 20),
  ('pulse', 'bpm', 20, 250, 30),
  ('temp', '°C', 30, 44, 40),
  ('resp', '/min', 4, 100, 50),
  ('spo2', '%', 40, 100, 60),
  ('weight', 'kg', 0.3, 350, 70),
  ('height', 'cm', 20, 250, 80),
  ('muac', 'cm', 5, 60, 90),
  ('glucose_mmol', 'mmol/L', 0.5, 60, 100),
  ('glucose_mgdl', 'mg/dL', 10, 1100, 110),
  ('pain', '/10', 0, 10, 120),
  ('head_circ', 'cm', 20, 70, 130),
  ('urine_output', 'mL', 0, 10000, 140),
  ('gcs', '/15', 3, 15, 150),
  ('fundal_height', 'cm', 5, 60, 160),
  ('fhr', 'bpm', 60, 240, 170)
on conflict (code) do update set unit = excluded.unit, min_value = excluded.min_value,
  max_value = excluded.max_value, sort = excluded.sort;
alter table vital_type enable row level security;
drop policy if exists vital_type_read on vital_type;
create policy vital_type_read on vital_type for select to authenticated using (true);
revoke all on vital_type from anon;
grant select on vital_type to authenticated;

alter table observation add column if not exists label text;
alter table observation add column if not exists remove_reason text;
alter table observation add column if not exists removed_by uuid;

-- ---------------------------------------------------------------- 2. the default set
/** The measurements the nurse sees by default, in order ('bmi' = the computed body mass index). */
create or replace function vitals_setting()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'codes', coalesce((select value -> 'codes' from setting where key = 'vitals.default'),
                      '["bp_sys","bp_dia","pulse","temp","resp","spo2","weight","height","muac"]'::jsonb),
    'catalogue', (select jsonb_agg(jsonb_build_object('code', code, 'unit', unit, 'min', min_value, 'max', max_value)
                                   order by sort) from vital_type)
  )
$$;

create or replace function save_vitals_setting(p_codes jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  v_n integer := 0;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 or jsonb_array_length(p_codes) > 40 then
    raise exception 'the default set is a list of measurements' using errcode = '22023', hint = 'vital_unknown';
  end if;
  for v_code in select value #>> '{}' from jsonb_array_elements(p_codes) loop
    if v_code <> 'bmi' and not exists (select 1 from vital_type where code = v_code) then
      raise exception 'unknown measurement %', coalesce(v_code, '?') using errcode = '22023', hint = 'vital_unknown';
    end if;
    v_n := v_n + 1;
  end loop;
  if (select count(distinct value #>> '{}') from jsonb_array_elements(p_codes)) <> v_n then
    raise exception 'unknown measurement %', 'twice' using errcode = '22023', hint = 'vital_unknown';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values ('vitals.default', jsonb_build_object('codes', p_codes), auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = excluded.changed_by, changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', 'vitals.default', 'codes', p_codes));
end
$$;
revoke all on function vitals_setting(), save_vitals_setting(jsonb) from public, anon;
grant execute on function vitals_setting(), save_vitals_setting(jsonb) to authenticated;

-- ---------------------------------------------------------------- 3. record_vitals
-- (from 20261203090000_guide_fixes) a number per code as before, or {"value","unit","label"};
-- the catalogue's limits; custom measurements ('custom_<slug>') with their typed name.
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
  v_raw jsonb;
  v_val numeric;
  v_unit text;
  v_label text;
  v_type vital_type%rowtype;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
begin
  if not has_perm('vitals.write') then
    raise exception 'you may not record vital signs (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  -- open, or finished and inside the person's edit window (20261212 visit_edit_lock)
  select arrived_at into v_arrived from encounter
  where id = p_encounter_id and deleted_at is null and (status = 'open' or visit_edit_active(id));
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

  for v_key, v_raw in select key, value from jsonb_each(coalesce(p_vitals, '{}'::jsonb)) loop
    v_unit := null;
    v_label := null;
    if jsonb_typeof(v_raw) = 'object' then
      v_val := nullif(trim(v_raw ->> 'value'), '')::numeric;
      v_unit := nullif(trim(v_raw ->> 'unit'), '');
      v_label := nullif(trim(v_raw ->> 'label'), '');
    else
      v_val := nullif(trim(v_raw #>> '{}'), '')::numeric;
    end if;
    if v_val is null then
      continue;
    end if;
    select * into v_type from vital_type where code = v_key;
    if found then
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
        else
          if v_val not between v_type.min_value and v_type.max_value then
            raise exception 'the measurement % must be between % and % %', v_key, v_type.min_value, v_type.max_value, v_type.unit
              using errcode = '22023', hint = 'vital_range';
          end if;
      end case;
      v_unit := v_type.unit;
      v_label := null;
    elsif v_key ~ '^custom_[a-z0-9_]{1,40}$' then
      -- a custom measurement: its typed name, its unit as typed (or none)
      if v_label is null or length(v_label) > 60 then
        raise exception 'write the name of the measurement' using errcode = '22023', hint = 'vital_name';
      end if;
      if v_unit is not null and length(v_unit) > 20 then
        raise exception 'the unit is 20 characters at most' using errcode = '22023', hint = 'vital_name';
      end if;
      if abs(v_val) > 1000000 then
        raise exception 'the measurement % must be between % and % %', v_key, -1000000, 1000000, coalesce(v_unit, '')
          using errcode = '22023', hint = 'vital_range';
      end if;
    else
      raise exception 'unknown measurement %', v_key using errcode = '22023', hint = 'vital_unknown';
    end if;
    insert into observation (encounter_id, code, value_num, unit, label, performer_id, effective_at)
    values (p_encounter_id, v_key, v_val, v_unit, v_label, v_by, v_at);
    v_count := v_count + 1;
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
  perform note_visit_edit(p_encounter_id, 'create', 'observation', p_encounter_id,
                          jsonb_build_object('vitals', p_vitals, 'measured_by', v_by, 'measured_at', v_at));

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

-- ---------------------------------------------------------------- 4. remove_vital
/**
 * A measurement taken off a visit's vital signs (a wrong line, the wrong patient): the row stays
 * with who removed it and why, and the audit keeps the value. Anyone who records vital signs on
 * an open visit; the manager on any visit.
 */
create or replace function remove_vital(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row observation%rowtype;
  v_status text;
begin
  if not (has_perm('vitals.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'write the reason first' using errcode = '22023', hint = 'reason_needed';
  end if;
  select * into v_row from observation where id = p_id and code <> 'note';
  if not found then
    raise exception 'measurement not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'this measurement was already removed' using errcode = '22023', hint = 'already_removed';
  end if;
  select status::text into v_status from encounter where id = v_row.encounter_id and deleted_at is null;
  -- open, or finished and inside the person's edit window (20261212); the manager always
  if v_status is distinct from 'open' and not visit_edit_active(v_row.encounter_id) and not is_manager() then
    raise exception 'the visit is closed' using errcode = '42501', hint = 'visit_closed';
  end if;
  update observation
     set deleted_at = now(), removed_by = auth.uid(), remove_reason = trim(p_reason),
         updated_at = now(), updated_by = auth.uid()
   where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after, reason)
  values (auth.uid(), 'delete', 'observation', p_id,
          jsonb_build_object('encounter_id', v_row.encounter_id, 'code', v_row.code, 'value', v_row.value_num,
                             'unit', v_row.unit, 'label', v_row.label, 'measured_at', v_row.effective_at,
                             'measured_by', v_row.performer_id),
          jsonb_build_object('removed', true), trim(p_reason));
  perform note_visit_edit(v_row.encounter_id, 'delete', 'observation', p_id,
                          jsonb_build_object('code', v_row.code, 'value', v_row.value_num, 'reason', trim(p_reason)));
end
$$;
revoke all on function remove_vital(uuid, text) from public, anon;
grant execute on function remove_vital(uuid, text) to authenticated;

-- ---------------------------------------------------------------- 5. visit_vitals
-- (from 20261130090000_patient_privacy) every measurement, not only the nine; with id and label.
create or replace view visit_vitals with (security_invoker = false) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by,
         o.id, o.label
  from observation o
  join encounter e on e.id = o.encounter_id and e.deleted_at is null
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
    and o.code <> 'note' and o.value_num is not null
    and (has_perm('clinical.read') or has_perm('vitals.write'))
    and (e.status = 'open' or visit_view(o.encounter_id) is not null)
  order by o.encounter_id, o.code, o.effective_at desc;
revoke all on visit_vitals from anon;
grant select on visit_vitals to authenticated;
