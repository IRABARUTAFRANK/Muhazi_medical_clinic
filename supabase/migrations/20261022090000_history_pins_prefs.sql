-- 0031 — Activity history, visible temporary PINs, preferences on every device, tidy queue notices.

-- ---------------------------------------------------------------- temporary PIN, visible to the manager
-- The first PIN the manager hands over (or a reset PIN) stays readable by managers until the
-- employee replaces it; then it is deleted. Only managers can read it; only the server writes it.
create table if not exists staff_temp_pin (
  user_id uuid primary key references profiles (id) on delete cascade,
  pin text not null check (pin ~ '^[0-9]{6}$'),
  set_at timestamptz not null default now(),
  set_by uuid references profiles (id) on delete set null
);
alter table staff_temp_pin enable row level security;
drop policy if exists staff_temp_pin_read on staff_temp_pin;
create policy staff_temp_pin_read on staff_temp_pin for select to authenticated using (is_manager());
revoke insert, update, delete on staff_temp_pin from authenticated, anon;

create or replace function mark_pin_changed()
returns void
language sql security definer set search_path = public
as $$
  update profiles set must_change_pin = false, pin_changed_at = now() where id = auth.uid();
  delete from staff_temp_pin where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------- preferences that follow the person
-- Text size, theme and language are saved on the profile, so every device the person signs in on
-- looks the same.
alter table profiles add column if not exists prefs jsonb not null default '{}'::jsonb;

create or replace function my_prefs()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(prefs, '{}'::jsonb) from profiles where id = auth.uid()
$$;

create or replace function save_my_prefs(p_prefs jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prefs) <> 'object' or length(p_prefs::text) > 2000 then
    raise exception 'invalid preferences' using errcode = '22023';
  end if;
  update profiles set prefs = coalesce(prefs, '{}'::jsonb) || p_prefs where id = auth.uid();
end
$$;

-- ---------------------------------------------------------------- queue notices: one per pool, removed when done
create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
begin
  -- A patient sent to several desks at once is announced once by send_to_stations().
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
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

-- When the patient leaves a desk (or a doctor takes a shared patient), the "waiting" notice is
-- no longer news: it is removed from everyone's list.
create or replace function clear_queue_notice()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.finished_at is not null and old.finished_at is null then
    delete from notification where kind = 'queue' and params ->> 'queue' = new.id::text;
  end if;
  if new.pool_id is not null and new.started_at is not null and old.started_at is null then
    delete from notification where kind = 'queue_pool' and params ->> 'pool' = new.pool_id::text;
  end if;
  return new;
end
$$;
drop trigger if exists trg_clear_queue_notice on queue_entry;
create trigger trg_clear_queue_notice after update on queue_entry
  for each row execute function clear_queue_notice();

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
  v_name text;
  v_triage text;
  v_role role_key;
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
  -- One notice per role for the whole pool ("waiting for the first free doctor: …").
  if v_pool is not null then
    select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
    from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
    for v_role in select distinct station_role(s) from unnest(p_next) as s loop
      insert into notification (kind, params, link, urgent, recipient_role, created_by)
      values ('queue_pool',
              jsonb_build_object('ticket', coalesce(v_ticket, 'A-000'), 'name', v_name,
                                 'stations', to_jsonb(p_next), 'triage', v_triage, 'pool', v_pool),
              '/app/visit?encounter=' || p_encounter_id,
              coalesce(v_triage, '') = 'red',
              v_role,
              auth.uid());
    end loop;
  end if;
  return jsonb_build_object('pool', v_pool, 'stations', to_jsonb(p_next));
end
$$;

-- ---------------------------------------------------------------- activity history
-- Every change to the clinic's records is already written to audit_event by a trigger (who, when,
-- what, before / after), plus sign-ins and staff / settings changes. This reads it for the
-- manager, newest first, with the person, a group for filtering and a short readable detail.
create or replace function activity_group(p_entity text, p_action audit_action)
returns text
language sql immutable
as $$
  select case
    when p_action = 'login' then 'signin'
    when p_entity in ('patient', 'encounter', 'appointment', 'coverage') then 'patients'
    when p_entity = 'observation' then 'vitals'
    when p_entity = 'queue_entry' then 'queue'
    when p_entity in ('invoice', 'invoice_line', 'payment', 'credit_note', 'day_close', 'claim') then 'billing'
    when p_entity in ('condition', 'medication_request', 'service_request', 'procedure',
                      'diagnostic_report', 'internal_task', 'vaccination', 'medication_dispense',
                      'hiv_test', 'fp_event') then 'clinical'
    when p_entity in ('bed', 'bed_stay') then 'beds'
    when p_entity in ('profiles', 'setting', 'department', 'service', 'payer', 'plan', 'price_list',
                      'price_list_item', 'practitioner') or p_action = 'settings' then 'admin'
    else 'other'
  end
$$;

create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
begin
  if not is_manager() then
    raise exception 'only the manager can read the activity history' using errcode = '42501';
  end if;
  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
  )
  select count(*) into v_total from ev;

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev.id,
      'at', ev.at,
      'action', ev.action,
      'entity', ev.entity,
      'group', ev.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'patient', coalesce(
        case when ev.entity = 'patient' then (ev.row ->> 'surname') || ' ' || (ev.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names),
      'detail', case ev.entity
        when 'observation' then (ev.row ->> 'code') || ' ' || coalesce(ev.row ->> 'value_num', ev.row ->> 'value_text', '')
        when 'invoice_line' then (ev.row ->> 'description') || ' · ' ||
             round(coalesce((ev.row ->> 'unit_price')::numeric, 0) * coalesce((ev.row ->> 'quantity')::numeric, 1))
        when 'payment' then (ev.row ->> 'method') || ' · ' || (ev.row ->> 'amount')
        when 'queue_entry' then (ev.row ->> 'ticket_no') || ' · ' || (ev.row ->> 'station') ||
             case when ev.action = 'update' and ev.after ->> 'finished_at' is not null
                       and ev.before ->> 'finished_at' is null then ' · done'
                  when ev.action = 'update' and ev.after ->> 'started_at' is not null
                       and ev.before ->> 'started_at' is null then ' · taken'
                  else '' end
        when 'encounter' then coalesce(ev.row ->> 'status', '')
        when 'bed_stay' then coalesce(ev.row ->> 'planned_nights', '') || ' night(s)'
        when 'profiles' then coalesce(ev.after ->> 'manage_staff', ev.row ->> 'username', '')
        else coalesce(ev.row ->> 'name', ev.row ->> 'title', ev.row ->> 'description',
                      ev.row ->> 'name_en', ev.row ->> 'code', ev.reason, '')
      end,
      'reason', ev.reason
    ) order by ev.at desc), '[]'::jsonb)
  into v_items
  from ev
  left join profiles pr on pr.id = ev.actor_id
  left join encounter en on en.id = case when ev.entity = 'encounter' then ev.entity_id
                                         else nullif(ev.row ->> 'encounter_id', '')::uuid end
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;

grant execute on function my_prefs(), save_my_prefs(jsonb), activity_history(timestamptz, timestamptz, uuid, text, integer, integer),
  send_to_stations(uuid, station, station[]) to authenticated;
revoke execute on function my_prefs(), save_my_prefs(jsonb), activity_history(timestamptz, timestamptz, uuid, text, integer, integer),
  send_to_stations(uuid, station, station[]), clear_queue_notice(), activity_group(text, audit_action) from anon, public;
grant execute on function activity_group(text, audit_action) to authenticated;
