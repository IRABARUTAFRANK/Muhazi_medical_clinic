-- 0119 · Vital signs: the nurse sends the patient to a person, and the manager manages the
-- measurements from Settings.
--
-- * Send to a person. The vitals form said only the desk ("Send to: Consultation"). It now also
--   offers the people who work at that desk, as the registration's "Where does … go?" card does:
--   record_vitals_to and send_from_triage_to take p_to_user (record_vitals and send_from_triage
--   stay, for nobody in particular: a second overload would make the old calls ambiguous). The person must be active and work at that desk; the queue entry is assigned to them
--   (queue_entry.assigned_to), so the "Next patient" offer and the waiting-room screen name them,
--   and the queue notice goes to that person instead of everyone at the desk (the queue trigger
--   does that from assigned_to). station_staff(p_station) lists who works at a desk now, with
--   how many patients each has (the same shape as service_staff).
-- * The measurements managed in Settings. vital_type carries a name, a kind (number or text),
--   an optional range and a retirement date. The manager adds a measurement (code custom_<slug>
--   from the name, a duplicate refused), renames a custom one (and its unit, kind, range),
--   retires a custom one not in the default set, and shows it again. A retired measurement
--   leaves Settings, the vitals form and "Add a measurement"; whatever was recorded with it
--   stays readable (nothing is erased). The built-in ones (BP, pulse, temperature…) cannot be
--   changed or retired, only left out of the default set as before. A custom measurement typed
--   on a patient ("Other") joins the catalogue by itself, so the manager can manage it too.
--   Every change is audited.
--
-- Functions: vital_types(), save_vital_type(…), retire_vital_type(code), restore_vital_type(code),
-- vitals_setting() (the catalogue without the retired ones), record_vitals_to(… p_to_user),
-- send_from_triage_to(… p_to_user), station_staff(station), view visit_measurements (+ value_text).

-- ---------------------------------------------------------------- 1. the catalogue carries more
alter table vital_type add column if not exists name text;
alter table vital_type add column if not exists kind text not null default 'number';
alter table vital_type add column if not exists retired_at timestamptz;
alter table vital_type add column if not exists retired_by uuid;
alter table vital_type add column if not exists created_by uuid;
alter table vital_type add column if not exists created_at timestamptz not null default now();
-- a custom measurement may have no range
alter table vital_type alter column min_value drop not null;
alter table vital_type alter column max_value drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vital_type_kind_check') then
    alter table vital_type add constraint vital_type_kind_check check (kind in ('number', 'text'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vital_type_name_check') then
    alter table vital_type add constraint vital_type_name_check
      check (name is null or (length(name) between 1 and 60));
  end if;
end $$;
comment on column vital_type.name is 'The name of a custom measurement as the manager wrote it (a built-in one is translated on the screens).';
comment on column vital_type.kind is 'number: a figure checked against the range; text: free words (a blood group, a note).';
comment on column vital_type.retired_at is 'Retired by the manager: hidden from Settings and the forms; what was recorded with it stays.';

-- the custom measurements already typed on patients ("Other") join the catalogue, by their last name and unit
insert into vital_type (code, name, unit, min_value, max_value, sort)
select distinct on (o.code) o.code, left(o.label, 60), coalesce(o.unit, ''), null, null, 500
from observation o
where o.code like 'custom\_%' and o.label is not null and o.deleted_at is null
order by o.code, o.effective_at desc
on conflict (code) do nothing;

/** The code of a custom measurement from its name: "Blood ketones" → custom_blood_ketones (as the web does). */
create or replace function vital_type_code(p_name text)
returns text
language sql immutable
as $$
  select 'custom_' || coalesce(nullif(left(trim(both '_' from regexp_replace(
    translate(lower(p_name), 'àáâäãåāçčèéêëēìíîïīñòóôöõøùúûüūýÿžš', 'aaaaaaacceeeeeiiiiinoooooouuuuuyyzs'),
    '[^a-z0-9]+', '_', 'g')), 40), ''), 'other')
$$;

-- ---------------------------------------------------------------- 2. reading the catalogue
/** Every measurement, retired ones included, with their flags (Settings › Vital signs). */
create or replace function vital_types()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', code, 'name', name, 'unit', unit, 'kind', kind, 'min', min_value, 'max', max_value,
      'custom', code like 'custom\_%', 'retired', retired_at is not null, 'retiredAt', retired_at)
    order by sort, code), '[]'::jsonb)
  from vital_type
  where exists (select 1 from profiles where id = auth.uid() and active)
$$;

/** The default set, in order, and the catalogue the forms offer (the retired ones left out). */
create or replace function vitals_setting()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'codes', coalesce((select value -> 'codes' from setting where key = 'vitals.default'),
                      '["bp_sys","bp_dia","pulse","temp","resp","spo2","weight","height","muac"]'::jsonb),
    'catalogue', coalesce((select jsonb_agg(jsonb_build_object(
                      'code', code, 'name', name, 'unit', unit, 'kind', kind, 'min', min_value, 'max', max_value,
                      'custom', code like 'custom\_%')
                    order by sort, code) from vital_type where retired_at is null), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- 3. the manager manages them
/**
 * Add (p_code null: the code comes from the name) or change a custom measurement: its name,
 * unit, kind (number or text) and the values a number may take (optional; outside them the form
 * refuses the figure as a typing mistake). A built-in measurement is not changed here.
 */
create or replace function save_vital_type(
  p_code text,
  p_name text,
  p_unit text,
  p_kind text default 'number',
  p_min numeric default null,
  p_max numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_unit text := trim(coalesce(p_unit, ''));
  v_kind text := coalesce(nullif(trim(coalesce(p_kind, '')), ''), 'number');
  v_min numeric := p_min;
  v_max numeric := p_max;
  v_code text := p_code;
  v_old vital_type%rowtype;
  v_row vital_type%rowtype;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name is null or length(v_name) > 60 then
    raise exception 'write the name of the measurement' using errcode = '22023', hint = 'vital_name';
  end if;
  if length(v_unit) > 20 then
    raise exception 'the unit is 20 characters at most' using errcode = '22023', hint = 'vital_name';
  end if;
  if v_kind not in ('number', 'text') then
    raise exception 'a measurement is a number or a text' using errcode = '22023', hint = 'vital_kind';
  end if;
  if v_kind = 'text' then
    v_min := null;
    v_max := null;
  end if;
  if v_min is not null and v_max is not null and v_min >= v_max then
    raise exception 'the range must go from a smaller to a larger number' using errcode = '22023', hint = 'vital_range_order';
  end if;
  if v_code is null then
    v_code := vital_type_code(v_name);
    select * into v_old from vital_type where code = v_code;
    if found and v_old.retired_at is not null then
      raise exception 'a measurement with this name is retired: show it again instead' using errcode = '23505', hint = 'vital_exists_retired';
    elsif found then
      raise exception 'a measurement with this name already exists' using errcode = '23505', hint = 'vital_exists';
    end if;
    insert into vital_type (code, name, unit, kind, min_value, max_value, sort, created_by)
    values (v_code, v_name, v_unit, v_kind, v_min, v_max, 500, auth.uid())
    returning * into v_row;
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'create', 'vital_type', null,
            jsonb_build_object('code', v_code, 'name', v_name, 'unit', v_unit, 'kind', v_kind, 'min', v_min, 'max', v_max));
  else
    select * into v_old from vital_type where code = v_code;
    if not found then
      raise exception 'unknown measurement %', v_code using errcode = '22023', hint = 'vital_unknown';
    end if;
    if v_code not like 'custom\_%' then
      raise exception 'a built-in measurement cannot be changed' using errcode = '22023', hint = 'vital_builtin';
    end if;
    if v_old.retired_at is not null then
      raise exception 'this measurement is retired: show it again first' using errcode = '22023', hint = 'vital_retired';
    end if;
    update vital_type
       set name = v_name, unit = v_unit, kind = v_kind, min_value = v_min, max_value = v_max
     where code = v_code
    returning * into v_row;
    insert into audit_event (actor_id, action, entity, entity_id, before, after)
    values (auth.uid(), 'update', 'vital_type', null,
            jsonb_build_object('code', v_code, 'name', v_old.name, 'unit', v_old.unit, 'kind', v_old.kind, 'min', v_old.min_value, 'max', v_old.max_value),
            jsonb_build_object('code', v_code, 'name', v_name, 'unit', v_unit, 'kind', v_kind, 'min', v_min, 'max', v_max));
  end if;
  return jsonb_build_object('code', v_row.code, 'name', v_row.name, 'unit', v_row.unit, 'kind', v_row.kind,
                            'min', v_row.min_value, 'max', v_row.max_value, 'custom', true, 'retired', false);
end
$$;

/**
 * A custom measurement retired: gone from Settings, the vitals form and "Add a measurement";
 * everything recorded with it stays readable. Refused while it is in the default set (untick it
 * first) and for a built-in one.
 */
create or replace function retire_vital_type(p_code text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row vital_type%rowtype;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_row from vital_type where code = p_code;
  if not found then
    raise exception 'unknown measurement %', coalesce(p_code, '?') using errcode = '22023', hint = 'vital_unknown';
  end if;
  if p_code not like 'custom\_%' then
    raise exception 'a built-in measurement cannot be retired: leave it out of the default set instead' using errcode = '22023', hint = 'vital_builtin';
  end if;
  if v_row.retired_at is not null then
    raise exception 'this measurement is already retired' using errcode = '22023', hint = 'vital_retired';
  end if;
  if exists (select 1 from setting s, jsonb_array_elements_text(s.value -> 'codes') c
             where s.key = 'vitals.default' and c = p_code) then
    raise exception 'this measurement is in the default set: untick it there first' using errcode = '22023', hint = 'vital_in_default';
  end if;
  update vital_type set retired_at = now(), retired_by = auth.uid() where code = p_code;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'vital_type', null,
          jsonb_build_object('code', p_code, 'name', v_row.name, 'unit', v_row.unit),
          jsonb_build_object('code', p_code, 'retired', true));
end
$$;

/** "Show again": a retired measurement back in the catalogue. */
create or replace function restore_vital_type(p_code text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row vital_type%rowtype;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_row from vital_type where code = p_code;
  if not found then
    raise exception 'unknown measurement %', coalesce(p_code, '?') using errcode = '22023', hint = 'vital_unknown';
  end if;
  if v_row.retired_at is null then
    raise exception 'this measurement is not retired' using errcode = '22023', hint = 'vital_not_retired';
  end if;
  update vital_type set retired_at = null, retired_by = null where code = p_code;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'vital_type', null,
          jsonb_build_object('code', p_code, 'retired', true),
          jsonb_build_object('code', p_code, 'name', v_row.name, 'unit', v_row.unit, 'retired', false));
end
$$;

-- ---------------------------------------------------------------- 4. who works at a desk
/**
 * Who works at this desk now, with how many patients each has (the vitals form's "Anyone at
 * Consultation / Dr …"): the same shape as service_staff, for a desk rather than a service
 * (Nursing is nursing, family planning and HIV; Theatre is surgery and circumcision).
 */
create or replace function station_staff(p_station station)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'service', (station_desks(p_station))[1],
    'station', p_station,
    'sectionWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                       where q.deleted_at is null and q.station = p_station and q.finished_at is null
                         and q.started_at is null and q.assigned_to is null and e.status = 'open'),
    'staff', coalesce((
      select jsonb_agg(x.j order by (x.j ->> 'workingNow') = 'true' desc, (x.j ->> 'onDuty') = 'true' desc,
                                    (x.j ->> 'waiting')::int + (x.j ->> 'seeing')::int, x.j ->> 'name')
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.full_name, 'role', p.role, 'station', p.station,
          'departments', (select string_agg(d.name, ', ' order by d.name) from staff_department sd
                          join department d on d.id = sd.department_id and d.deleted_at is null
                          where sd.profile_id = p.id),
          'specialty', pr.title,
          'workingNow', case when pr.id is null or pr.working_hours = '{}'::jsonb then null
                             else practitioner_is_working(pr.id, now()) end,
          'onDuty', (p.last_sign_in_at at time zone 'Africa/Kigali')::date = v_today,
          'waiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.assigned_to = p.id and q.finished_at is null
                        and q.started_at is null and e.status = 'open'),
          'seeing', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.taken_by = p.id and q.finished_at is null
                       and e.status = 'open')
        ) as j
        from profiles p
        left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
        where p.active and p.role in ('doctor', 'nurse', 'sonographer', 'lab_tech', 'pharmacist')
          and serves_station(p.id, p_station)
      ) x
    ), '[]'::jsonb)
  );
end
$$;

/** The person the patient is sent to must be active and work at that desk. */
create or replace function assert_works_at(p_user uuid, p_station station)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_user is null then
    return;
  end if;
  if not exists (select 1 from profiles where id = p_user and active) or not serves_station(p_user, p_station) then
    raise exception 'that person does not work at %', initcap(p_station::text) using errcode = '22023', hint = 'not_at_desk';
  end if;
end
$$;

-- ---------------------------------------------------------------- 5. record_vitals_to: + p_to_user, managed custom measurements, text ones
-- (the body of record_vitals from 20261218090000_reception_and_fields, under a new name: a second
-- record_vitals with one more argument would make the old call ambiguous; the old name stays
-- below as a wrapper, so the seven-argument call still works)
create or replace function record_vitals_to(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null,
  p_to_user uuid default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_raw jsonb;
  v_val numeric;
  v_text text;
  v_unit text;
  v_label text;
  v_type vital_type%rowtype;
  v_known boolean;
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
  -- the person chosen at the next desk (0119) must work there
  if v_at_triage and p_next_station is not null then
    perform assert_works_at(p_to_user, p_next_station);
  end if;
  -- Without clinical rights the person typing says who measured: the nurse whose paper sheet it
  -- is, or themselves (0108: reception may measure too; "Me" is sent as their own id).
  if not has_perm('clinical.write') and p_measured_by is null then
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
    v_text := null;
    v_val := null;
    -- the catalogue (a retired measurement counts as unknown: typed by name, it is "Other" again)
    select * into v_type from vital_type where code = v_key and retired_at is null;
    v_known := found;
    if v_known and v_type.kind = 'text' then
      -- words, not a figure (a blood group, a remark)
      v_text := nullif(trim(coalesce(v_raw ->> 'text', v_raw ->> 'value',
                                     case when jsonb_typeof(v_raw) = 'string' then v_raw #>> '{}' end)), '');
      if v_text is null then
        continue;
      end if;
      if length(v_text) > 200 then
        raise exception 'the measurement % is 200 characters at most', v_key using errcode = '22023', hint = 'vital_text';
      end if;
      v_unit := nullif(v_type.unit, '');
      v_label := v_type.name;
    else
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
      if v_known then
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
            -- a custom measurement without a range takes any figure
            if v_type.min_value is not null and v_type.max_value is not null
               and v_val not between v_type.min_value and v_type.max_value then
              raise exception 'the measurement % must be between % and % %', v_key, v_type.min_value, v_type.max_value, v_type.unit
                using errcode = '22023', hint = 'vital_range';
            end if;
            if abs(v_val) > 1000000 then
              raise exception 'the measurement % must be between % and % %', v_key, -1000000, 1000000, coalesce(v_type.unit, '')
                using errcode = '22023', hint = 'vital_range';
            end if;
        end case;
        v_unit := nullif(v_type.unit, '');
        -- a custom measurement of the catalogue carries the manager's name for it
        v_label := case when v_key like 'custom\_%' then v_type.name end;
      elsif v_key ~ '^custom_[a-z0-9_]{1,40}$' then
        -- a custom measurement typed by name ("Other"): its name, its unit as typed (or none)
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
        -- it joins the catalogue, so the manager can put it in the default set, rename or retire it
        -- (a retired one stays retired: the row exists)
        insert into vital_type (code, name, unit, min_value, max_value, sort, created_by)
        values (v_key, v_label, coalesce(v_unit, ''), null, null, 500, auth.uid())
        on conflict (code) do nothing;
      else
        raise exception 'unknown measurement %', v_key using errcode = '22023', hint = 'vital_unknown';
      end if;
    end if;
    insert into observation (encounter_id, code, value_num, value_text, unit, label, performer_id, effective_at)
    values (p_encounter_id, v_key, v_val, v_text, v_unit, v_label, v_by, v_at);
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

  -- At triage: close the triage turn and send the patient on, to the person chosen when one is
  -- (the queue notice then goes to them). Later (e.g. the doctor typing the nurse's paper sheet):
  -- measurements only, the patient stays where they are.
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end,
            p_to_user);
  end if;
  return v_ticket;
end
$$;

-- the old name and arguments: the same, for nobody in particular
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
language sql security definer set search_path = public
as $$
  select record_vitals_to(p_encounter_id, p_vitals, p_triage, p_next_station, p_reason, p_measured_by, p_measured_at, null)
$$;

-- ---------------------------------------------------------------- 6. send_from_triage_to: + p_to_user
-- (the body of send_from_triage from 20261128090000_switches_enforced, under a new name for the
-- same reason; the old name stays as a wrapper, so the four-argument call still works)
create or replace function send_from_triage_to(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null,
  p_to_user uuid default null
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
  if not has_perm('vitals.write') then
    raise exception 'you may not record vital signs (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  perform assert_desk(array['triage'], 'triage');
  perform assert_may_work_on(p_encounter_id, true);
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from observation where encounter_id = p_encounter_id and deleted_at is null) then
    raise exception 'take the vitals first' using errcode = '22023';
  end if;
  -- the person chosen at the next desk (0119) must work there
  perform assert_works_at(p_to_user, p_next_station);
  update encounter set triage_level = p_triage, triage_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), triage_reason)
  where id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null and deleted_at is null;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next_station
                 and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to)
    values (p_encounter_id, p_next_station, v_ticket,
            case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end,
            p_to_user);
  elsif p_to_user is not null then
    -- already waiting there: now for that person
    update queue_entry set assigned_to = p_to_user
    where encounter_id = p_encounter_id and station = p_next_station
      and finished_at is null and started_at is null and deleted_at is null;
  end if;
  return v_ticket;
end
$$;

-- the old name and arguments: the same, for nobody in particular
create or replace function send_from_triage(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language sql security definer set search_path = public
as $$
  select send_from_triage_to(p_encounter_id, p_triage, p_next_station, p_reason, null)
$$;

-- ---------------------------------------------------------------- 7. visit_measurements: visit_vitals with the words of a text measurement
-- (visit_vitals of 20261213090000_vitals_custom keeps its columns; a view cannot gain one without
-- breaking a re-run of that migration. The screens read this one and fall back to visit_vitals
-- on an older database.)
create or replace view visit_measurements with (security_invoker = false) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by,
         o.id, o.label, o.value_text
  from observation o
  join encounter e on e.id = o.encounter_id and e.deleted_at is null
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
    and o.code <> 'note' and (o.value_num is not null or o.value_text is not null)
    and (has_perm('clinical.read') or has_perm('vitals.write'))
    and (e.status = 'open' or visit_view(o.encounter_id) is not null)
  order by o.encounter_id, o.code, o.effective_at desc;
revoke all on visit_measurements from anon;
grant select on visit_measurements to authenticated;

-- ---------------------------------------------------------------- 8. who may call what
revoke all on function vital_type_code(text), assert_works_at(uuid, station) from public, anon, authenticated;
revoke all on function vital_types(), vitals_setting(),
  save_vital_type(text, text, text, text, numeric, numeric), retire_vital_type(text), restore_vital_type(text),
  station_staff(station),
  record_vitals_to(uuid, jsonb, triage_level, station, text, uuid, timestamptz, uuid),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz),
  send_from_triage_to(uuid, triage_level, station, text, uuid),
  send_from_triage(uuid, triage_level, station, text)
  from public, anon;
grant execute on function vital_types(), vitals_setting(),
  save_vital_type(text, text, text, text, numeric, numeric), retire_vital_type(text), restore_vital_type(text),
  station_staff(station),
  record_vitals_to(uuid, jsonb, triage_level, station, text, uuid, timestamptz, uuid),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz),
  send_from_triage_to(uuid, triage_level, station, text, uuid),
  send_from_triage(uuid, triage_level, station, text)
  to authenticated;
