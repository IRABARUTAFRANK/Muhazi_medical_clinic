-- 0029 — Patients without a national ID, "first free doctor" queues, notification management.

-- ---------------------------------------------------------------- patients without a national ID
-- A child, someone whose ID is not issued yet, or a foreign national: the file says why, and the
-- "files to complete" list stops asking for the number.
alter table patient add column if not exists no_national_id text
  check (no_national_id is null or no_national_id in ('child', 'not_issued', 'foreigner'));

create or replace function set_no_national_id(p_patient_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_reason is not null and p_reason not in ('child', 'not_issued', 'foreigner') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  update patient
  set no_national_id = p_reason,
      national_id = case when p_reason is null then national_id else null end
  where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function patient_missing(p patient)
returns text[]
language sql stable
as $$
  select array_remove(array[
    case when nullif(trim(coalesce(p.phone_1, '')), '') is null then 'phone' end,
    -- National ID from 16 years (or when the age is unknown), unless the file says why there is none.
    case when p.national_id is null and p.no_national_id is null
          and (p.birth_date is null or p.birth_date <= current_date - interval '16 years') then 'national_id' end,
    case when nullif(trim(coalesce(p.sector, '')), '') is null then 'address' end,
    case when p.birth_date is null then 'age' end
  ], null)
$$;

-- ---------------------------------------------------------------- first free doctor
-- Reception (or anyone sending a patient on) may put the patient in several desks' queues at once.
-- The entries share a pool; the first doctor who takes the patient removes the others.
alter table queue_entry add column if not exists pool_id uuid;
alter table queue_entry add column if not exists taken_by uuid references profiles (id) on delete set null;
create index if not exists queue_pool_idx on queue_entry (pool_id) where pool_id is not null;

create or replace function send_to_stations(
  p_encounter_id uuid,
  p_station station,
  p_next station[]
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_pool uuid;
  v_next station;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_next is null or cardinality(p_next) = 0 then
    raise exception 'choose where the patient goes' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  v_pool := case when cardinality(p_next) > 1 then gen_random_uuid() end;
  foreach v_next in array p_next loop
    if exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_next
               and finished_at is null and deleted_at is null) then
      update queue_entry set pool_id = coalesce(v_pool, pool_id)
      where encounter_id = p_encounter_id and station = v_next and finished_at is null;
    else
      insert into queue_entry (encounter_id, station, ticket_no, pool_id)
      values (p_encounter_id, v_next, coalesce(v_ticket, 'A-000'), v_pool);
    end if;
  end loop;
  return jsonb_build_object('pool', v_pool, 'stations', to_jsonb(p_next));
end
$$;

-- "I take this patient": starts the patient at this desk and, for a shared entry, takes the
-- patient out of the other desks' queues. Refused if another doctor was faster.
create or replace function take_patient(p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_by text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null;
  if not found then
    raise exception 'queue entry not found' using errcode = 'P0002';
  end if;
  -- Lock the whole pool so two doctors cannot take the same patient at the same moment.
  perform 1 from queue_entry
  where (pool_id is not null and pool_id = v_q.pool_id) or id = v_q.id
  for update;
  select * into v_q from queue_entry where id = p_queue_id;
  if v_q.finished_at is not null then
    select pr.full_name into v_by from queue_entry q join profiles pr on pr.id = q.taken_by
    where q.pool_id = v_q.pool_id and q.taken_by is not null limit 1;
    raise exception 'already taken by %', coalesce(v_by, 'another desk') using errcode = '23505';
  end if;
  if v_q.taken_by is not null and v_q.taken_by <> auth.uid() then
    select full_name into v_by from profiles where id = v_q.taken_by;
    raise exception 'already taken by %', coalesce(v_by, 'another doctor') using errcode = '23505';
  end if;
  update queue_entry
  set called_at = coalesce(called_at, now()), started_at = coalesce(started_at, now()),
      taken_by = auth.uid()
  where id = p_queue_id;
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> p_queue_id and finished_at is null;
  end if;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'station', v_q.station);
end
$$;

create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  where q.deleted_at is null and e.status = 'open';

-- ---------------------------------------------------------------- notification management
-- Each person may remove a notice from their own list (it stays for everyone else), see what
-- they sent with how many have read it, and the sender or the manager may delete a message.
alter table notification_read add column if not exists hidden_at timestamptz;

create or replace function my_notifications(p_limit integer default 30)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with mine as (
    select n.*, (r.user_id is not null) as is_read, sender.full_name as sender
    from notification n
    left join notification_read r on r.notification_id = n.id and r.user_id = auth.uid()
    left join profiles sender on sender.id = n.created_by
    where n.created_at > now() - interval '30 days' and notification_is_mine(n, auth.uid())
      and r.hidden_at is null
  )
  select jsonb_build_object(
    'unread', (select count(*) from mine where not is_read),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'at', created_at, 'kind', kind, 'params', params, 'title', title, 'body', body,
        'link', link, 'urgent', urgent, 'read', is_read, 'sender', sender
      ) order by created_at desc)
      from (select * from mine order by created_at desc limit greatest(1, least(p_limit, 200))) x
    ), '[]'::jsonb)
  )
$$;

create or replace function mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into notification_read (notification_id, user_id)
  select n.id, auth.uid() from notification n
  where (p_ids is null or n.id = any (p_ids))
    and n.created_at > now() - interval '30 days'
    and notification_is_mine(n, auth.uid())
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Unread → read when needed, then hidden from this person's list.
create or replace function hide_notifications(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into notification_read (notification_id, user_id, hidden_at)
  select n.id, auth.uid(), now() from notification n
  where n.id = any (p_ids) and notification_is_mine(n, auth.uid())
  on conflict (notification_id, user_id) do update set hidden_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

create or replace function my_sent_notifications(p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select n.created_at as at, jsonb_build_object(
      'id', n.id, 'at', n.created_at, 'title', n.title, 'body', n.body, 'urgent', n.urgent,
      'to', case when n.to_all then 'all'
                 when n.recipient_user is not null then 'user'
                 when n.recipient_department is not null then 'department'
                 else 'role' end,
      'target', coalesce(ru.full_name, d.name, n.recipient_role::text),
      'headsOnly', n.heads_only,
      'readBy', (select count(*) from notification_read r where r.notification_id = n.id)
    ) as j
    from notification n
    left join profiles ru on ru.id = n.recipient_user
    left join department d on d.id = n.recipient_department
    where n.kind = 'message' and (n.created_by = auth.uid() or is_manager())
      and n.created_at > now() - interval '90 days'
    order by n.created_at desc
    limit greatest(1, least(p_limit, 200))
  ) x
$$;

create or replace function delete_notification(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from notification
  where id = p_id and kind = 'message' and (created_by = auth.uid() or is_manager());
  if not found then
    raise exception 'message not found or not yours' using errcode = 'P0002';
  end if;
end
$$;

grant execute on function set_no_national_id(uuid, text), send_to_stations(uuid, station, station[]),
  take_patient(uuid), my_notifications(integer), mark_notifications_read(uuid[]),
  hide_notifications(uuid[]), my_sent_notifications(integer), delete_notification(uuid)
  to authenticated;
revoke execute on function set_no_national_id(uuid, text), send_to_stations(uuid, station, station[]),
  take_patient(uuid), my_notifications(integer), mark_notifications_read(uuid[]),
  hide_notifications(uuid[]), my_sent_notifications(integer), delete_notification(uuid)
  from anon, public;
