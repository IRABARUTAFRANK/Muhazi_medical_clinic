-- 0020 · First measurements, taken by the nurse, entered by whoever has the device.
--
-- Clinic practice: a patient arriving goes first to the nurse, who takes blood pressure,
-- temperature, weight… When the nurse has no device at hand, she writes the figures on paper
-- and the receptionist or the doctor types them in later. So a measurement now records:
--   * performer_id  — who measured (the nurse), chosen on the form;
--   * effective_at  — when it was measured (from the paper), not when it was typed;
--   * created_by    — who typed it (automatic).
-- Receptionists get the narrow permission `vitals.write` (vital signs only, no other clinical
-- record). Entering vitals for a visit already past triage (the doctor, later) only adds the
-- measurements; it does not move the patient in the queue.

insert into role_permissions (role, permission)
values ('receptionist', 'vitals.write'), ('nurse', 'vitals.write'), ('doctor', 'vitals.write'),
       ('manager', 'vitals.write')
on conflict do nothing;

-- Staff who take measurements, for the "Measured by" list (readable by anyone who enters vitals).
create or replace function vitals_takers()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'staffId', p.staff_id, 'role', p.role)
                            order by (p.role <> 'nurse'), p.full_name), '[]'::jsonb)
  from profiles p
  where p.active and p.role in ('nurse', 'doctor', 'manager')
    and (has_perm('vitals.write') or has_perm('clinical.write'))
$$;

drop function if exists record_vitals(uuid, jsonb, triage_level, station, text);

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
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
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

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
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

-- Who measured and who typed it, next to each value on the visit screen.
create or replace view visit_vitals with (security_invoker = true) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by
  from observation o
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
  order by o.encounter_id, o.code, o.effective_at desc;

grant execute on function vitals_takers(),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz) to authenticated;
revoke execute on function vitals_takers(),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz) from anon;
