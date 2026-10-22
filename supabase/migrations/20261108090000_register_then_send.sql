-- 0067 · Register first, then decide where the patient goes.
-- The file is made first; then whoever registered decides where the visit starts, from what the
-- patient comes for: the triage nurse, a desk (consultation, dental, minor surgery, nursing,
-- laboratory, ultrasound, pharmacy), one of the departments of that desk, or "I see this patient
-- myself" for the person who treats (the visit starts at their desk, already taken by them).
-- With "triage first" on, every visit starts at triage except an emergency or "myself" (the
-- person treating takes the measurements).
create or replace function begin_visit(
  p_patient_id uuid,
  p_station station default 'consultation',
  p_department_id uuid default null,
  p_note text default null,
  p_myself boolean default false,
  p_emergency boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_station station;
  v_enc uuid;
  v_q queue_entry%rowtype;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  if p_emergency and v_role in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  -- "myself": only those who treat at that desk (the manager anywhere)
  if p_myself and not (
       v_role = 'manager'
       or (v_role = 'doctor' and p_station in ('consultation', 'dental', 'theatre', 'ultrasound'))
       or (v_role = 'nurse' and p_station in ('triage', 'nursing', 'beds'))
       or (v_role = 'lab_tech' and p_station = 'laboratory')
       or (v_role = 'sonographer' and p_station = 'ultrasound')
       or (v_role = 'pharmacist' and p_station = 'pharmacy')) then
    raise exception 'you do not work at % : send the patient there instead', initcap(p_station::text)
      using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (
       select 1 from department d where d.id = p_department_id and d.deleted_at is null
         and station_role(p_station) = any (d.roles)) then
    raise exception 'that department does not work at %', initcap(p_station::text) using errcode = '22023';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;

  v_station := case
    when p_myself or p_emergency then p_station
    when triage_first() then 'triage'::station
    else p_station end;
  v_enc := open_encounter(p_patient_id, 'opd', v_station);

  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || v_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;

  select * into v_q from queue_entry
  where encounter_id = v_enc and station = v_station and finished_at is null and deleted_at is null
  order by created_at limit 1;
  -- what the patient comes for, and the department chosen (when the patient goes straight there)
  update queue_entry
  set referral_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), referral_note),
      department_id = case when v_station = p_station then coalesce(p_department_id, department_id) else department_id end,
      referred_by = auth.uid()
  where id = v_q.id;
  if p_myself then
    perform take_patient(v_q.id);
    -- nobody else needs the "new patient at your desk" notice
    delete from notification where kind = 'queue' and params ->> 'queue' = v_q.id::text;
  end if;

  return jsonb_build_object(
    'encounter_id', v_enc,
    'ticket_no', v_q.ticket_no,
    'station', v_station,
    'myself', p_myself,
    'department', (select name from department where id = p_department_id));
end
$$;

revoke all on function begin_visit(uuid, station, uuid, text, boolean, boolean) from public, anon;
grant execute on function begin_visit(uuid, station, uuid, text, boolean, boolean) to authenticated;
