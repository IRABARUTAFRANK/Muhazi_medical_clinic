-- 0079 · Five hours without activity signs you out; signing out asks for a new code.
--
-- Frank: the PIN-only lock screen that came back when a sleeping tab woke up did not follow
-- the sign-in the clinic agreed on, and after signing out it was too easy to come back in.
-- The rule is now one, counted from the LAST ACTIVITY, not from the sign-in:
--   * a tab stays signed in as long as it is used. After N hours WITHOUT ACTIVITY in it
--     (setting `security.session`, {"hours": 1..12}, default 5; only the manager changes it)
--     it signs out completely. The clock itself runs in the browser tab (the screen app);
--   * the browser key kept after the e-mailed code (trusted device, 0025) no longer lasts
--     days. It ends N hours after the code (trust_this_device) and, while the person keeps
--     working, the tab pushes the end forward (extend_this_device, now() + N hours). It only
--     lets another tab of the same browser sign in with staff ID + username + PIN while it
--     runs; using it (use_trusted_device) never pushes the end forward. Once nobody used it for
--     N hours, the next sign-in needs a new e-mailed code;
--   * signing out (menu, too many wrong PINs, inactivity) revokes this browser's key
--     (revoke_this_device), so the next sign-in always asks for a new e-mailed code;
--   * only a session opened by the e-mailed code makes a browser key (signed_in_with_code(),
--     read from the access token), and a revoked key is never brought back;
--   * every key made under the old 30-day rule ends with this migration.
-- Limit kept for later: the data itself (RLS) still accepts a session opened by the PIN alone,
-- and the hours of inactivity are counted in the browser, not by Supabase Auth.
-- trust_days() and the security.otp / security.lock settings stay for compatibility; they no
-- longer decide anything.

-- ---------------------------------------------------------------- hours of inactivity
create or replace function session_hours()
returns integer
language sql stable security definer set search_path = public
as $$
  select greatest(1, least(12, coalesce(
    ((select value from setting where key = 'security.session') ->> 'hours')::numeric::int, 5)))
$$;

-- ---------------------------------------------------------------- signed in with the code
-- True when this session was opened by the e-mailed code (or the sign-in link in that e-mail),
-- not by the PIN alone. Supabase Auth writes how the session was opened in the access token
-- (`amr`, kept when the token is refreshed); a PIN sign-in says 'password'.
create or replace function signed_in_with_code()
returns boolean
language sql stable set search_path = public
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end
    ) a
    where a ->> 'method' in ('otp', 'magiclink', 'email/signup', 'invite', 'recovery')
  )
$$;

-- ---------------------------------------------------------------- trusted device = active browser
-- Called right after a correct e-mailed code. Returns when this browser's key ends if nobody
-- uses it (now() + session_hours()). Only a session opened by the code makes a key: a PIN
-- alone gets null. A key ended by a sign-out (revoked) is never brought back: null, and the
-- browser makes a new key at the next code.
create or replace function trust_this_device(p_token text, p_label text default null)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_until timestamptz := now() + make_interval(hours => session_hours());
  v_hash text;
  v_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(coalesce(p_token, '')) < 32 or not signed_in_with_code() then
    return null;
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  insert into trusted_device (user_id, token_hash, label, created_at, expires_at, last_used_at)
  values (auth.uid(), v_hash, left(p_label, 120), now(), v_until, now())
  on conflict (token_hash) do update
    set label = excluded.label, created_at = now(), expires_at = excluded.expires_at,
        last_used_at = now()
    where trusted_device.user_id = excluded.user_id and trusted_device.revoked_at is null
  returning expires_at into v_end;
  return v_end;
end
$$;

-- Called after the PIN on a browser that holds a key. Returns the key's current end (no code
-- needed this time) or null (unknown, someone else's, revoked or expired: ask for a code).
-- It never pushes the end forward: only activity does (extend_this_device).
drop function if exists use_trusted_device(text);
create function use_trusted_device(p_token text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_end timestamptz;
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
  update trusted_device set last_used_at = now() where id = v_id;
  return v_end;
end
$$;

-- Called by a tab while the person is active (at most every few minutes): the key now ends
-- N hours from now. Only the owner's own key, and only while it still runs: an expired or
-- revoked key is never brought back (null; the next sign-in needs a code).
create or replace function extend_this_device(p_token text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_end timestamptz;
begin
  if auth.uid() is null then
    return null;
  end if;
  update trusted_device
     set expires_at = now() + make_interval(hours => session_hours()), last_used_at = now()
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and user_id = auth.uid() and revoked_at is null and expires_at > now()
  returning expires_at into v_end;
  return v_end;
end
$$;

-- Sign-out and inactivity: this browser's key no longer skips the code.
create or replace function revoke_this_device(p_token text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update trusted_device set revoked_at = now()
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and user_id = auth.uid() and revoked_at is null;
end
$$;

-- ---------------------------------------------------------------- settings
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_hours numeric;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp', 'security.session', 'flow') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.session' then
    if not is_manager() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value -> 'hours') is distinct from 'number' then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
    v_hours := (p_value ->> 'hours')::numeric;
    if v_hours <> trunc(v_hours) or v_hours < 1 or v_hours > 12 then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.otp' then
    if jsonb_typeof(p_value -> 'trust_days') <> 'number'
       or (p_value ->> 'trust_days')::numeric < 0
       or (p_value ->> 'trust_days')::numeric > 90 then
      raise exception 'trust_days must be between 0 and 90' using errcode = '22023';
    end if;
  end if;
  if p_key = 'flow' and jsonb_typeof(p_value -> 'triage_first') <> 'boolean' then
    raise exception 'flow.triage_first must be true or false' using errcode = '22023';
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120),
    'trust_days', trust_days(),
    'triage_first', triage_first(),
    'session_hours', session_hours()
  )
$$;

grant execute on function session_hours(), signed_in_with_code(), trust_this_device(text, text),
  use_trusted_device(text), extend_this_device(text), revoke_this_device(text),
  revoke_trusted_devices(boolean), save_setting(text, jsonb), staff_settings() to authenticated;
revoke execute on function session_hours(), signed_in_with_code(), trust_this_device(text, text),
  use_trusted_device(text), extend_this_device(text), revoke_this_device(text),
  revoke_trusted_devices(boolean), save_setting(text, jsonb), staff_settings() from anon, public;

-- ---------------------------------------------------------------- the keys made before this rule
-- They were made for up to 30 days (trust_days) and a tab still running the old screens would
-- use them with the PIN alone. They all end now: everyone types one new e-mailed code, and
-- from then on every key follows the hours of inactivity.
update trusted_device set revoked_at = now() where revoked_at is null;
