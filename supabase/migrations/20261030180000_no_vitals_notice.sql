-- 0046 · Nurses are told about every new patient whose vitals are not taken yet.
--
-- When reception (or any desk) starts a visit and sends the patient straight to a doctor, the
-- nurses had no notice: only a patient queued at triage reached them. Now the first queue entry
-- of a visit without vitals sends the nurses a "vitals not taken yet" notice, linked to the
-- vitals screen. It disappears as soon as anyone records the vitals, or when the visit closes.
-- Skipped when the patient is queued at triage / nursing (the nurses' own queue notice says it)
-- and when a nurse registered the patient (she goes straight to the measurements).

create or replace function notify_no_vitals()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if exists (select 1 from queue_entry q where q.encounter_id = new.encounter_id and q.id <> new.id) then
    return new;
  end if;
  if new.station in ('triage', 'nursing', 'beds') or coalesce(current_role_key()::text, '') = 'nurse' then
    return new;
  end if;
  if exists (select 1 from observation o where o.encounter_id = new.encounter_id and o.deleted_at is null
             and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')) then
    return new;
  end if;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  insert into notification (kind, params, link, recipient_role, created_by)
  values ('no_vitals',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'encounter', new.encounter_id),
          '/app/vitals?encounter=' || new.encounter_id,
          'nurse', auth.uid());
  return new;
end
$$;
drop trigger if exists queue_entry_no_vitals on queue_entry;
create trigger queue_entry_no_vitals after insert on queue_entry
  for each row execute function notify_no_vitals();

-- Vitals recorded by anyone, or the visit closed: the notice is no longer needed.
create or replace function clear_no_vitals()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_table_name = 'observation' then
    if new.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac') then
      delete from notification where kind = 'no_vitals' and params ->> 'encounter' = new.encounter_id::text;
    end if;
  elsif new.status = 'closed' then
    delete from notification where kind = 'no_vitals' and params ->> 'encounter' = new.id::text;
  end if;
  return new;
end
$$;
drop trigger if exists observation_clear_no_vitals on observation;
create trigger observation_clear_no_vitals after insert on observation
  for each row execute function clear_no_vitals();
drop trigger if exists encounter_clear_no_vitals on encounter;
create trigger encounter_clear_no_vitals after update of status on encounter
  for each row execute function clear_no_vitals();
