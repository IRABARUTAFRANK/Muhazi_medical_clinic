-- 0025 · Trusted devices: the e-mailed code once per device, not at every sign-in.
--
-- The clinic's mail goes through a Gmail account (≈ 500 messages per rolling 24 h, and our
-- own cap of 60 per hour). A code at every sign-in wastes that budget and staff time. After a
-- correct code the person may trust the browser: it keeps a random key; the database keeps
-- only its SHA-256 fingerprint. Next time staff ID + username + PIN are enough on that device
-- until the trust expires. The manager sets how long (setting `security.otp`, trust_days:
-- 0 = a code at every sign-in) and can make every device ask for a code again.

create table if not exists trusted_device (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists trusted_device_user_idx on trusted_device (user_id) where revoked_at is null;
alter table trusted_device enable row level security;
-- No policies: only the functions below (security definer) touch this table.

create or replace function trust_days()
returns integer
language sql stable security definer set search_path = public
as $$
  select coalesce(((select value from setting where key = 'security.otp') ->> 'trust_days')::int, 30)
$$;

-- Called right after a correct e-mailed code. Returns when the trust ends (null = not trusted).
create or replace function trust_this_device(p_token text, p_label text default null)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_days integer := trust_days();
  v_until timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_days <= 0 or length(coalesce(p_token, '')) < 32 then
    return null;
  end if;
  v_until := now() + make_interval(days => v_days);
  insert into trusted_device (user_id, token_hash, label, expires_at, last_used_at)
  values (auth.uid(), encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), left(p_label, 120), v_until, now());
  return v_until;
end
$$;

-- Called after the PIN on a device that holds a key. True = no code needed this time.
create or replace function use_trusted_device(p_token text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or trust_days() <= 0 then
    return false;
  end if;
  select id into v_id from trusted_device
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and user_id = auth.uid() and revoked_at is null and expires_at > now();
  if v_id is null then
    return false;
  end if;
  update trusted_device set last_used_at = now() where id = v_id;
  return true;
end
$$;

-- Everyone (manager) or yourself: every trusted device asks for a code again.
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
  update trusted_device set revoked_at = now()
  where revoked_at is null and (p_all or user_id = auth.uid());
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Settings: allow security.otp ({ trust_days: 0..90 }); expose trust_days to staff screens.
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
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
    'trust_days', trust_days()
  )
$$;

grant execute on function trust_days(), trust_this_device(text, text), use_trusted_device(text),
  revoke_trusted_devices(boolean) to authenticated;
revoke execute on function trust_days(), trust_this_device(text, text), use_trusted_device(text),
  revoke_trusted_devices(boolean) from anon;
