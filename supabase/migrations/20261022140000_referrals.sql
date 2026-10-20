-- 0034 — Referrals between doctors, departments and the laboratory.
-- A doctor (or anyone who sends patients on) can hand a patient to another desk, optionally to a
-- named colleague, with a reason, and ask for the patient to come back afterwards (e.g. to the
-- lab for a test, then back to the same doctor with the result). The receiver is told why, sees
-- who referred, and sends the patient back with one action.

alter table queue_entry add column if not exists assigned_to uuid references profiles (id) on delete set null;
alter table queue_entry add column if not exists referred_by uuid references profiles (id) on delete set null;
alter table queue_entry add column if not exists referral_note text;
alter table queue_entry add column if not exists return_station station;
alter table queue_entry add column if not exists return_to uuid references profiles (id) on delete set null;

-- Colleagues a patient can be handed to (active staff; no contact details).
create or replace function colleagues()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'station', p.station,
      'department', d.name, 'staffId', p.staff_id
    ) order by p.full_name), '[]'::jsonb)
  from profiles p
  left join department d on d.id = p.department_id
  where p.active and has_perm('queue.read')
$$;

create or replace function refer_patient(
  p_encounter_id uuid,
  p_from station,
  p_to station,
  p_to_user uuid default null,
  p_note text default null,
  p_return boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_id uuid;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_to_user is not null and not exists (select 1 from profiles where id = p_to_user and active) then
    raise exception 'that colleague is not an active employee' using errcode = '22023';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_from and finished_at is null;
  -- Already waiting at that desk: update the waiting entry instead of adding a second one.
  update queue_entry
  set assigned_to = p_to_user, referred_by = auth.uid(),
      referral_note = nullif(trim(coalesce(p_note, '')), ''),
      return_station = case when p_return then p_from end,
      return_to = case when p_return then auth.uid() end
  where encounter_id = p_encounter_id and station = p_to and finished_at is null and deleted_at is null
  returning id into v_id;
  if v_id is null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    insert into queue_entry (encounter_id, station, ticket_no, assigned_to, referred_by, referral_note,
                             return_station, return_to)
    values (p_encounter_id, p_to, coalesce(v_ticket, 'A-000'), p_to_user, auth.uid(),
            nullif(trim(coalesce(p_note, '')), ''),
            case when p_return then p_from end,
            case when p_return then auth.uid() end)
    returning id into v_id;
  end if;
  return jsonb_build_object('queueId', v_id, 'station', p_to);
end
$$;

-- Where the patient is now, who referred them and whether they must go back (for the visit screen).
create or replace function visit_routing(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'queueId', q.id, 'station', q.station, 'since', q.created_at,
      'assignedTo', q.assigned_to, 'assignedName', a.full_name,
      'referredBy', q.referred_by, 'referredName', r.full_name, 'note', q.referral_note,
      'returnStation', q.return_station, 'returnTo', q.return_to, 'returnName', b.full_name
    ) order by q.created_at), '[]'::jsonb)
  from queue_entry q
  left join profiles a on a.id = q.assigned_to
  left join profiles r on r.id = q.referred_by
  left join profiles b on b.id = q.return_to
  where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
    and has_perm('queue.read')
$$;

-- Queue notices: a referral tells the colleague (or the desk's role) who referred and why.
create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
  v_by text;
begin
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  if new.referred_by is not null then
    select full_name into v_by from profiles where id = new.referred_by;
    insert into notification (kind, params, link, urgent, recipient_user, recipient_role, created_by)
    values ('referral',
            jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                               'by', v_by, 'note', new.referral_note, 'queue', new.id,
                               'back', new.return_station is not null),
            '/app/visit?encounter=' || new.encounter_id,
            coalesce(v_triage, '') = 'red' or new.priority = 1,
            new.assigned_to,
            case when new.assigned_to is null then station_role(new.station) end,
            auth.uid());
    return new;
  end if;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'triage', v_triage, 'queue', new.id),
          '/app/visit?encounter=' || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;

-- An existing waiting entry turned into a referral (update) also tells the receiver.
create or replace function notify_referral_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.referred_by is not null and new.finished_at is null
     and (old.referred_by is distinct from new.referred_by or old.assigned_to is distinct from new.assigned_to
          or old.referral_note is distinct from new.referral_note) then
    perform notify_queue_entry_row(new);
  end if;
  return new;
end
$$;

create or replace function notify_queue_entry_row(q queue_entry)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_by text;
begin
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = q.encounter_id;
  select full_name into v_by from profiles where id = q.referred_by;
  delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = q.id::text;
  insert into notification (kind, params, link, recipient_user, recipient_role, created_by)
  values ('referral',
          jsonb_build_object('ticket', q.ticket_no, 'name', v_name, 'station', q.station, 'by', v_by,
                             'note', q.referral_note, 'queue', q.id, 'back', q.return_station is not null),
          '/app/visit?encounter=' || q.encounter_id,
          q.assigned_to,
          case when q.assigned_to is null then station_role(q.station) end,
          auth.uid());
end
$$;
drop trigger if exists trg_notify_referral_update on queue_entry;
create trigger trg_notify_referral_update after update on queue_entry
  for each row execute function notify_referral_update();

create or replace function clear_queue_notice()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.finished_at is not null and old.finished_at is null then
    delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = new.id::text;
  end if;
  if new.pool_id is not null and new.started_at is not null and old.started_at is null then
    delete from notification where kind = 'queue_pool' and params ->> 'pool' = new.pool_id::text;
  end if;
  return new;
end
$$;

create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  where q.deleted_at is null and e.status = 'open';

grant execute on function colleagues(), refer_patient(uuid, station, station, uuid, text, boolean),
  visit_routing(uuid) to authenticated;
revoke execute on function colleagues(), refer_patient(uuid, station, station, uuid, text, boolean),
  visit_routing(uuid), notify_referral_update(), notify_queue_entry_row(queue_entry) from anon, public;
