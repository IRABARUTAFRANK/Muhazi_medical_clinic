-- 0158: a TV is set up by signing in, not by typing a link.
--
-- Until now the manager made a screen in Settings, got a long link once and someone typed or
-- pasted it into the TV's browser. Now: on the TV, open /display and sign in as staff (staff ID,
-- username, PIN, the e-mailed code), choose the screen, done. The server gives that TV its own
-- key (display_device, kept as a hash; the TV keeps the key in its browser) and the staff
-- session on the TV ends at once. Settings lists the TVs of each screen, with Disconnect.
--  * a managed feature, display.setup — "Set up a waiting-room TV" — the manager and reception
--    at first;
--  * display_board accepts a TV's key as well as the screen's own key (links already opened
--    keep working), and keeps when the TV was last seen;
--  * tv_setup_screens (what a signed-in person may choose), setup_display_device (makes the
--    key; creates a default "Waiting room" screen when the clinic has none), display_devices
--    and revoke_display_device (Settings).

create or replace function managed_permission(p text)
returns boolean
language sql immutable
as $$
  select p in ('payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
               'orders.write', 'appointment.approve', 'stock.write', 'records.approve', 'stock.sell_walkin',
               'charge.override', 'visit.leave_owing', 'display.setup')
$$;
insert into role_permissions (role, permission)
values ('manager', 'display.setup'), ('receptionist', 'display.setup')
on conflict do nothing;

create table if not exists display_device (
  id uuid primary key default gen_random_uuid(),
  screen_id uuid not null references display_screen (id),
  key_hash text not null unique,
  name text not null,
  set_up_by uuid,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid
);
comment on table display_device is 'A TV set up by signing in on it (0158): its key is kept as a SHA-256 only.';
create index if not exists display_device_screen_idx on display_device (screen_id, created_at desc);
alter table display_device enable row level security;
revoke all on display_device from anon, authenticated;

-- ---------------------------------------------------------------- display_board (from 20261230090000_waiting_screen_slides)
create or replace function display_board(p_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s display_screen%rowtype;
  v_hash text;
  v_dev uuid;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_desks text[];
  v_board jsonb;
  v_results jsonb;
  v_payload jsonb;
begin
  v_hash := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  -- the screen's own key (a link, before 0158), else the key of a TV set up by signing in
  select * into v_s from display_screen
  where key_hash = v_hash and active and revoked_at is null;
  if not found then
    select d.id into v_dev
    from display_device d
    join display_screen s on s.id = d.screen_id and s.active and s.revoked_at is null
    where d.key_hash = v_hash and d.revoked_at is null;
    if v_dev is not null then
      select s.* into v_s from display_screen s
      where s.id = (select screen_id from display_device where id = v_dev);
    end if;
    if v_dev is null then
      raise exception 'this screen key is not known or was revoked' using errcode = '42501', hint = 'screen_unknown';
    end if;
    update display_device set last_seen_at = now()
    where id = v_dev and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  end if;
  -- the desks shown: the ones chosen, else every desk with a patient now
  if cardinality(v_s.desks) > 0 then
    v_desks := v_s.desks;
  else
    select coalesce(array_agg(x.station::text order by x.station), '{}') into v_desks
    from (select distinct q.station
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          where q.deleted_at is null and q.finished_at is null) x;
  end if;
  select coalesce(jsonb_agg(d.j order by d.ord), '[]'::jsonb) into v_board
  from (
    select u.ord, jsonb_build_object(
      'station', u.s,
      'now', (
        select coalesce(jsonb_agg(n.j order by n.at desc), '[]'::jsonb)
        from (
          select coalesce(q.called_at, q.started_at) as at, jsonb_build_object(
                   'id', q.id, 'ticket', q.ticket_no,
                   'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
                   'room', pr.station, 'person', pr.full_name,
                   'calledAt', coalesce(q.called_at, q.started_at),
                   'started', q.started_at is not null
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
          left join profiles pr on pr.id = coalesce(q.taken_by, q.called_by, q.assigned_to)
          where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
            and coalesce(q.called_at, q.started_at) is not null
            and (coalesce(q.called_at, q.started_at) at time zone 'Africa/Kigali')::date = v_today
          order by coalesce(q.called_at, q.started_at) desc
          limit 4
        ) n
      ),
      'next', (
        select coalesce(jsonb_agg(x.j order by x.pri, x.at), '[]'::jsonb)
        from (
          select case when q.priority <= 2 then q.priority else 3 end as pri, q.created_at as at,
                 jsonb_build_object(
                   'id', q.id, 'ticket', q.ticket_no,
                   'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
                   'priority', least(q.priority, 3),
                   'person', pa.full_name, 'room', pa.station
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
          left join profiles pa on pa.id = q.assigned_to
          where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
            and q.called_at is null and q.started_at is null
          order by 1, 2
          limit 5
        ) x
      ),
      'waiting', (
        select count(*)
        from queue_entry q
        join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
        where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
          and q.called_at is null and q.started_at is null
      )
    ) as j
    from unnest(v_desks) with ordinality as u(s, ord)
  ) d;
  -- results verified in the last hour, one line per visit; never a sensitive (HIV) test
  select coalesce(jsonb_agg(r.j order by r.at desc), '[]'::jsonb) into v_results
  from (
    select max(d.verified_at) as at, jsonb_build_object(
             'id', e.id,
             'ticket', (select ticket_no from queue_entry where encounter_id = e.id order by created_at limit 1),
             'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
             'at', max(d.verified_at)
           ) as j
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    join encounter e on e.id = r.encounter_id and e.status = 'open' and e.deleted_at is null
    join patient p on p.id = e.patient_id
    where d.deleted_at is null and d.verified_at > now() - interval '60 minutes'
      and r.category in ('lab', 'imaging') and not sensitive_service(r.service_id)
    group by e.id, p.surname, p.given_names
  ) r;
  v_payload := jsonb_build_object(
    'name', v_s.name, 'desks', v_board, 'results', v_results, 'message', v_s.message,
    'chime', v_s.chime, 'languages', to_jsonb(v_s.languages), 'showNames', v_s.show_names,
    'voice', v_s.voice, 'voiceLang', v_s.voice_lang, 'voiceRepeat', v_s.voice_repeat, 'ticker', v_s.ticker,
    'clinic', coalesce((select value ->> 'name' from setting where key = 'clinic.profile'), 'Muhazi Medical Clinic')
  );
  return v_payload || jsonb_build_object(
    'version', ('x' || left(md5(v_payload::text), 7))::bit(28)::int,
    'now', now()
  );
end
$$;
revoke all on function display_board(text) from public;
grant execute on function display_board(text) to anon, authenticated;

-- The screens a signed-in person may put on this TV (name, desks, languages, how many TVs use it).
create or replace function tv_setup_screens()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when has_perm('display.setup') then coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'desks', to_jsonb(s.desks), 'languages', to_jsonb(s.languages),
      'devices', (select count(*)::int from display_device d where d.screen_id = s.id and d.revoked_at is null)
    ) order by s.created_at)
    from display_screen s where s.active and s.revoked_at is null
  ), '[]'::jsonb) else '[]'::jsonb end
$$;
revoke all on function tv_setup_screens() from public, anon;
grant execute on function tv_setup_screens() to authenticated;

-- This TV gets its own key for the screen (shown to the TV once, kept hashed). Without a screen
-- in the clinic yet, a default "Waiting room" one (every desk, the three languages) is made.
create or replace function setup_display_device(p_screen uuid, p_name text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_screen uuid := p_screen;
  v_screen_name text;
  v_key text;
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if not has_perm('display.setup') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_screen is null then
    select id into v_screen from display_screen
    where active and revoked_at is null order by created_at limit 1;
    if v_screen is null then
      insert into display_screen (name, key_hash, desks, languages)
      values ('Waiting room', encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
              '{}', '{rw,en,fr}')
      returning id into v_screen;
    end if;
  end if;
  select name into v_screen_name from display_screen
  where id = v_screen and active and revoked_at is null;
  if v_screen_name is null then
    raise exception 'this screen is not known or was revoked' using errcode = 'P0002', hint = 'screen_unknown';
  end if;
  if v_name is null then
    v_name := 'TV ' || to_char(now() at time zone 'Africa/Kigali', 'DD/MM HH24:MI');
  end if;
  if length(v_name) > 60 then
    raise exception 'give the TV a shorter name' using errcode = '22023', hint = 'device_name';
  end if;
  v_key := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into display_device (screen_id, key_hash, name, set_up_by)
  values (v_screen, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), v_name, auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'display_device', v_id,
          jsonb_build_object('screen', v_screen, 'screenName', v_screen_name, 'name', v_name));
  return jsonb_build_object('id', v_id, 'key', v_key, 'screenId', v_screen, 'screenName', v_screen_name, 'name', v_name);
end
$$;
revoke all on function setup_display_device(uuid, text) from public, anon;
grant execute on function setup_display_device(uuid, text) to authenticated;

-- Settings: the TVs of every screen (set up by whom and when, last seen, disconnected).
create or replace function display_devices()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'screenId', d.screen_id, 'name', d.name,
      'setUpBy', (select full_name from profiles where id = d.set_up_by),
      'createdAt', d.created_at, 'lastSeenAt', d.last_seen_at, 'revokedAt', d.revoked_at
    ) order by (d.revoked_at is null) desc, d.created_at desc)
    from display_device d
  ), '[]'::jsonb);
end
$$;
revoke all on function display_devices() from public, anon;
grant execute on function display_devices() to authenticated;

create or replace function revoke_display_device(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update display_device set revoked_at = now(), revoked_by = auth.uid()
  where id = p_id and revoked_at is null
  returning name into v_name;
  if not found then
    raise exception 'this TV is not known or was already disconnected' using errcode = 'P0002', hint = 'device_unknown';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'display_device', p_id, jsonb_build_object('name', v_name, 'disconnected', true));
end
$$;
revoke all on function revoke_display_device(uuid) from public, anon;
grant execute on function revoke_display_device(uuid) to authenticated;
