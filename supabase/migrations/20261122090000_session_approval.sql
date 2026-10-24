-- 0081 · The e-mailed code is checked by the database, not only by the screens.
--
-- Two reviews found that the e-mailed sign-in code was enforced by the web app alone: anyone who
-- knew a staff ID, username and PIN could open a session with the PIN (Supabase Auth, password)
-- and read or write everything the role allows through the API, never typing the code. The
-- "signed out after N hours without activity" rule (0079) was also counted in the browser only.
-- Now the server decides:
--   * approved_session: one row per Supabase Auth session (the access token's `session_id`).
--     A session is approved ONLY
--       - by the e-mailed code or the sign-in link: record_sign_in, called by the app right after
--         them, approves the session when the access token says it was opened that way within
--         the last 15 minutes (`amr` method otp / magiclink / email/signup / invite / recovery
--         with a recent `timestamp`, see code_just_typed()). Supabase Auth names them so
--         (internal/models/factor.go); a PIN-only session says 'password' and is never approved;
--         an old code session (a refresh token left on a shared computer) is never approved later;
--       - by another tab of the same browser: use_trusted_device(key) approves the session
--         (via 'device') when the browser key made after a code is valid.
--     Nothing else approves. An ended or idle session is never approved again.
--   * session_ok(): the caller's current session is approved, not ended, and was active within
--     session_hours() hours (last_seen_at, plus 10 minutes of grace: the browser notes activity
--     more often than it tells the server). The app reports activity with touch_session() (at
--     most every 5 minutes); an expired session is ended ('idle') and never brought back. Every
--     sign-out calls end_session() before leaving.
--   * check_request(): run by PostgREST before EVERY API request (db_pre_request). Visitors
--     (anon) and the server (service_role) pass; a signed-in person passes only with session_ok(),
--     except the few sign-in / sign-out calls the app makes before the approval or after the end
--     (the list is in check_request below). Refusals use SQLSTATE PT401 (HTTP 401) with
--       hint 'code_required'  'sign-in not approved: sign in again with the e-mailed code'
--       hint 'ended'          'signed out: sign in again with the e-mailed code'
--       hint 'idle'           'signed out after N hours without activity'
--     The web app signs the tab out on these and explains it on the login page.
--   * The manage-staff Edge Function refuses a caller whose session_status() is not ok.
--   * The security.* settings (this switch, the hours) can no longer be written through the API
--     directly: only save_setting (which checks the role and writes the audit row) or the SQL
--     editor change them.
--
-- ROLLOUT (in this order):
--   1. deploy the web app built with this change (it works with the database before 0081 too);
--   2. pnpm db:apply (this migration). Every session open at that moment is unapproved: everyone
--      is signed out once with "for your security, sign in again with the e-mailed code";
--   3. sign in once with a code and check in the browser that the work screens open.
-- EMERGENCY (kill switch): if nobody can work because of this rule, run in the SQL editor
--   update setting set value = '{"on": false}' where key = 'security.enforce_code';
-- and every request passes again as before (turn it back on with '{"on": true}'). Taking the gate
-- out completely: alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
-- Limits kept: Realtime and Storage do not go through PostgREST (the app uses neither today).
-- Supabase Auth's own endpoints do not either: someone who knows the PIN can still change the
-- PIN without the code (updateUser), though no data opens without the code. Secure e-mail change
-- must stay on and phone sign-in off (scripts/supabase-configure.mjs pins both).

-- ---------------------------------------------------------------- kill switch
insert into setting (key, value) values ('security.enforce_code', '{"on": true}'::jsonb)
on conflict (key) do nothing;

create or replace function enforce_code_on()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(((select value from setting where key = 'security.enforce_code') ->> 'on')::boolean, true)
$$;

-- The security.* settings are written only by save_setting (security definer: it runs as the
-- owner, checks the role and writes the audit row) or from the SQL editor, never directly
-- through the API (PATCH /setting). Otherwise anyone with settings.write could switch the code
-- off for everyone, silently.
create or replace function setting_guard()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (coalesce(new.key, '') like 'security.%' or coalesce(old.key, '') like 'security.%') then
    raise exception 'security settings are changed from the settings screen only'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists setting_guard on setting;
create trigger setting_guard before insert or update or delete on setting
  for each row execute function setting_guard();

-- ---------------------------------------------------------------- approved sign-ins
create table if not exists approved_session (
  session_id uuid primary key,
  user_id uuid not null,
  via text not null check (via in ('code', 'device')),
  approved_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text
);
create index if not exists approved_session_user_idx on approved_session (user_id);
alter table approved_session enable row level security;
-- No policies: only the functions below (security definer) touch this table.
revoke all on approved_session from anon, authenticated;

-- The access token's session (`session_id`), or null when it is missing or not a uuid.
create or replace function current_session_id()
returns uuid
language plpgsql stable set search_path = public
as $$
declare
  v text := auth.jwt() ->> 'session_id';
begin
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return null;
end
$$;

-- True when this session was opened by the e-mailed code (or the link) in the last 15 minutes:
-- the `amr` entry's `timestamp` (seconds) is when the code was typed, and a refreshed token
-- keeps it. The app calls record_sign_in right after the code, so 15 minutes is plenty.
create or replace function code_just_typed()
returns boolean
language sql stable set search_path = public
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end
    ) a
    where a ->> 'method' in ('otp', 'magiclink', 'email/signup', 'invite', 'recovery')
      and jsonb_typeof(a -> 'timestamp') = 'number'
      and (a ->> 'timestamp')::numeric > extract(epoch from now()) - 900
  )
$$;

-- Why the current session may (not) work: 'ok', 'code_required' (never approved), 'ended'
-- (signed out) or 'idle' (no activity for session_hours() hours, plus 10 minutes of grace).
create or replace function session_reason()
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when s.session_id is null then 'code_required'
    when s.ended_at is not null then case when s.ended_reason = 'idle' then 'idle' else 'ended' end
    when s.last_seen_at <= now() - make_interval(hours => session_hours()) - interval '10 minutes'
      then 'idle'
    else 'ok'
  end
  from (select 1) one
  left join approved_session s
    on s.session_id = current_session_id() and s.user_id = auth.uid() and auth.uid() is not null
$$;

create or replace function session_ok()
returns boolean
language sql stable security definer set search_path = public
as $$
  select session_reason() = 'ok'
$$;

-- For the screens and the manage-staff function: may this session work, and why not.
create or replace function session_status()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'ok', r.reason = 'ok' or not enforce_code_on(),
    'reason', r.reason,
    'enforced', enforce_code_on(),
    'hours', session_hours(),
    'via', s.via,
    'last_seen_at', s.last_seen_at
  )
  from (select session_reason() as reason) r
  left join approved_session s
    on s.session_id = current_session_id() and s.user_id = auth.uid()
$$;

-- ---------------------------------------------------------------- activity and sign-out
-- The person is active (the app calls it at most every 5 minutes). True: the session counts
-- N hours from now. False: not approved, signed out, or already past the hours (then it is
-- ended as 'idle' and never brought back). With the kill switch off it always says true, so
-- the screens never sign anyone out because of this rule.
create or replace function touch_session()
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_sid uuid := current_session_id();
begin
  if auth.uid() is null or v_sid is null then
    return not enforce_code_on();
  end if;
  update approved_session set last_seen_at = now()
   where session_id = v_sid and user_id = auth.uid() and ended_at is null
     and last_seen_at > now() - make_interval(hours => session_hours()) - interval '10 minutes';
  if found then
    return true;
  end if;
  update approved_session set ended_at = now(), ended_reason = 'idle'
   where session_id = v_sid and user_id = auth.uid() and ended_at is null;
  return not enforce_code_on();
end
$$;

-- Every sign-out (menu, wrong PINs, inactivity, another tab): this session no longer works.
create or replace function end_session(p_reason text default 'signed out')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_sid uuid := current_session_id();
begin
  if auth.uid() is null or v_sid is null then
    return;
  end if;
  update approved_session
     set ended_at = now(), ended_reason = left(coalesce(nullif(trim(p_reason), ''), 'signed out'), 40)
   where session_id = v_sid and user_id = auth.uid() and ended_at is null;
end
$$;

-- First sign-in with the manager's temporary PIN: the screen asks whether a new PIN is due
-- before the e-mailed code (replaces a direct read of profiles, refused before the approval).
create or replace function my_must_change_pin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select must_change_pin from profiles where id = auth.uid() and active), false)
$$;

-- ---------------------------------------------------------------- mark_pin_changed (0042) + approval
-- Before the code it is allowed only for the first PIN (the manager's temporary PIN is being
-- replaced); every change is written in the history.
create or replace function mark_pin_changed()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_first boolean;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_first := my_must_change_pin();
  if enforce_code_on() and not session_ok() and not v_first then
    raise exception 'sign-in not approved: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = 'code_required';
  end if;
  update profiles set must_change_pin = false, pin_changed_at = now() where id = auth.uid();
  delete from staff_temp_pin where user_id = auth.uid();
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'update', 'profiles', auth.uid(),
          case when v_first then 'PIN changed (first sign-in)' else 'PIN changed' end);
end
$$;

-- ---------------------------------------------------------------- record_sign_in (0026) + approval
-- After the e-mailed code (or the sign-in link) the session is approved here. A PIN-only session
-- is refused unless a browser key already approved it (use_trusted_device, another tab).
create or replace function record_sign_in(p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v profiles%rowtype;
  v_sid uuid := current_session_id();
  v_code boolean := code_just_typed();
  v_reason text;
begin
  if not v_code and enforce_code_on() and session_reason() <> 'ok' then
    raise exception 'sign-in not approved: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = 'code_required';
  end if;
  update profiles set last_sign_in_at = now()
  where id = auth.uid() and active
  returning * into v;
  if not found then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  if v_code and v_sid is not null then
    -- A session signed out before is never approved again.
    insert into approved_session (session_id, user_id, via)
    values (v_sid, auth.uid(), 'code')
    on conflict (session_id) do nothing;
  end if;
  -- A code session that was signed out (or went idle) stays out.
  v_reason := session_reason();
  if v_sid is not null and enforce_code_on() and v_reason <> 'ok' then
    raise exception 'sign-in not approved: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = v_reason;
  end if;
  -- Old rows go only once Supabase Auth itself forgot the session (it can never come back).
  if to_regclass('auth.sessions') is not null then
    begin
      execute 'delete from approved_session a
                where coalesce(a.ended_at, a.last_seen_at) < now() - interval ''30 days''
                  and not exists (select 1 from auth.sessions s where s.id = a.session_id)';
    exception when others then
      null; -- housekeeping only: never blocks a sign-in
    end;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'login', 'profiles', auth.uid(), p_device);
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email
  );
end
$$;

-- ---------------------------------------------------------------- use_trusted_device (0079) + approval
-- Called after the PIN on a browser that holds a key. Returns the key's current end (no code
-- needed this time; this session is now approved, via 'device') or null (unknown, someone
-- else's, revoked or expired key, or a session that already ended: ask for a code).
-- It never pushes the key's end forward: only activity does (extend_this_device).
create or replace function use_trusted_device(p_token text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_end timestamptz;
  v_sid uuid := current_session_id();
  v_reason text;
begin
  if auth.uid() is null then
    return null;
  end if;
  select id, expires_at into v_id, v_end from trusted_device
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and user_id = auth.uid() and revoked_at is null and expires_at > now();
  if v_id is null then
    return null;
  end if;
  if v_sid is not null then
    insert into approved_session (session_id, user_id, via)
    values (v_sid, auth.uid(), 'device')
    on conflict (session_id) do nothing;
    v_reason := session_reason();
    if v_reason <> 'ok' then
      -- signed out or idle: never brought back by a key
      update approved_session set ended_at = now(), ended_reason = 'idle'
       where session_id = v_sid and user_id = auth.uid() and ended_at is null;
      return null;
    end if;
  end if;
  update trusted_device set last_used_at = now() where id = v_id;
  return v_end;
end
$$;

-- ---------------------------------------------------------------- revoke_trusted_devices (0025)
-- "Every browser of everyone" (manager) needs an approved, current session: never the PIN alone,
-- never a session that already ended.
create or replace function revoke_trusted_devices(p_all boolean default false)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_all and not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_all and enforce_code_on() and not session_ok() then
    raise exception 'sign-in not approved: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = 'code_required';
  end if;
  update trusted_device set revoked_at = now()
  where revoked_at is null and (p_all or user_id = auth.uid());
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- the gate (PostgREST pre-request)
-- Runs as the caller (not security definer): current_user is the request's role.
create or replace function check_request()
returns void
language plpgsql stable set search_path = public
as $$
declare
  v_reason text;
begin
  if current_user is distinct from 'authenticated' then
    return; -- anon (visitors, public forms) and service_role (Edge Functions) are not touched
  end if;
  if not enforce_code_on() then
    return; -- kill switch
  end if;
  -- The only calls the app makes before the approval or after the end: sign-in (record_sign_in,
  -- use_trusted_device), the first PIN (my_must_change_pin, mark_pin_changed), activity and
  -- sign-out (touch_session, end_session, revoke_this_device, session_status). Each of them
  -- checks for itself what it may do; none of them reads or changes clinic data.
  if coalesce(current_setting('request.path', true), '') ~
     '^(/rest/v1)?/rpc/(record_sign_in|use_trusted_device|my_must_change_pin|mark_pin_changed|touch_session|end_session|revoke_this_device|session_status)/?$'
  then
    return;
  end if;
  v_reason := session_reason();
  if v_reason = 'ok' then
    return;
  end if;
  if v_reason = 'idle' then
    raise exception 'signed out after % hours without activity', session_hours()
      using errcode = 'PT401', hint = 'idle';
  end if;
  if v_reason = 'ended' then
    raise exception 'signed out: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = 'ended';
  end if;
  raise exception 'sign-in not approved: sign in again with the e-mailed code'
    using errcode = 'PT401', hint = 'code_required';
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function enforce_code_on(), current_session_id(), code_just_typed(), session_reason(),
  session_ok(), session_status(), touch_session(), end_session(text), my_must_change_pin(),
  mark_pin_changed(), record_sign_in(text), use_trusted_device(text),
  revoke_trusted_devices(boolean) from public, anon;
grant execute on function enforce_code_on(), current_session_id(), code_just_typed(), session_reason(),
  session_ok(), session_status(), touch_session(), end_session(text), my_must_change_pin(),
  mark_pin_changed(), record_sign_in(text), use_trusted_device(text),
  revoke_trusted_devices(boolean) to authenticated;
revoke all on function setting_guard() from public, anon, authenticated;
grant execute on function check_request() to anon, authenticated, service_role;

-- ---------------------------------------------------------------- turn the gate on
-- PostgREST reads db_pre_request from the authenticator role (Supabase). PGlite (db:check) has
-- no such role: skipped there.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.check_request''';
    perform pg_notify('pgrst', 'reload config');
  end if;
end
$$;
