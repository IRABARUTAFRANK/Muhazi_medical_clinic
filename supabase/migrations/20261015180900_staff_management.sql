-- Muhazi Medical Clinic System — 0010 employee accounts and sign-in security
-- The clinic manager owns every staff account: creates it, hands over the username and a
-- first PIN, resets PINs, deactivates leavers. Accounts live in Supabase Auth; this file adds the
-- profile fields and the database side of those flows. The Auth side (create user, set
-- password, ban) runs in the `manage-staff` Edge Function with the service role.
-- Source: doc §1.4 (roles), §5.11 (users, roles, devices), §5.12 (security and audit).

alter table profiles
  add column must_change_pin boolean not null default true,
  add column pin_changed_at timestamptz,
  add column last_sign_in_at timestamptz,
  add column deactivated_at timestamptz,
  add column created_by uuid,
  add column phone text,
  add column notes text;

comment on column profiles.must_change_pin is 'True until the employee replaces the PIN the manager handed over.';

-- Profile from the Auth user's metadata (set by manage-staff or seed-staff).
create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into profiles (id, username, full_name, role, station, dashboard, head_of, language,
                        must_change_pin, created_by, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data ->> 'role')::role_key, 'receptionist'),
    new.raw_user_meta_data ->> 'station',
    new.raw_user_meta_data ->> 'dashboard',
    new.raw_user_meta_data ->> 'head_of',
    coalesce((new.raw_user_meta_data ->> 'language')::lang, 'kin'),
    coalesce((new.raw_user_meta_data ->> 'must_change_pin')::boolean, true),
    nullif(new.raw_user_meta_data ->> 'created_by', '')::uuid,
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;
  return new;
end
$$;

-- ---------------------------------------------------------------- sign-in
-- Called by the app right after Supabase Auth accepted the PIN. Refuses deactivated accounts,
-- stamps the last sign-in and writes the login audit event (doc §5.12).
create or replace function record_sign_in(p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v profiles%rowtype;
begin
  update profiles set last_sign_in_at = now()
  where id = auth.uid() and active
  returning * into v;
  if not found then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'login', 'profiles', auth.uid(), p_device);
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin
  );
end
$$;

-- After the employee replaced the handed-over PIN (auth.updateUser in the app).
create or replace function mark_pin_changed()
returns void
language sql security definer set search_path = public
as $$
  update profiles set must_change_pin = false, pin_changed_at = now() where id = auth.uid()
$$;

-- ---------------------------------------------------------------- manager actions (database side)
create or replace function set_profile_active(p_user uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_user = auth.uid() and not p_active then
    raise exception 'you cannot deactivate your own account' using errcode = '22023';
  end if;
  update profiles
  set active = p_active, deactivated_at = case when p_active then null else now() end
  where id = p_user;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_user, jsonb_build_object('active', p_active));
end
$$;

create or replace function update_profile(
  p_user uuid,
  p_full_name text,
  p_role role_key,
  p_station text default null,
  p_dashboard text default null,
  p_head_of text default null,
  p_language lang default 'kin',
  p_phone text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_managers integer;
begin
  if not is_manager() then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_dashboard is not null and p_dashboard not in ('manager', 'head') then
    raise exception 'dashboard must be manager, head or empty' using errcode = '22023';
  end if;
  -- never leave the clinic without an active manager
  if p_role <> 'manager' then
    select count(*) into v_managers from profiles where role = 'manager' and active and id <> p_user;
    if v_managers = 0 and exists (select 1 from profiles where id = p_user and role = 'manager') then
      raise exception 'the clinic must keep at least one active manager' using errcode = '22023';
    end if;
  end if;
  update profiles
  set full_name = p_full_name, role = p_role, station = p_station, dashboard = p_dashboard,
      head_of = p_head_of, language = p_language, phone = p_phone
  where id = p_user;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_user,
          jsonb_build_object('role', p_role, 'station', p_station, 'dashboard', p_dashboard));
end
$$;

-- Manager's directory (RLS of profiles applies through security_invoker).
create view staff_directory with (security_invoker = true) as
  select id, username, full_name, role, station, dashboard, head_of, language, phone,
         active, must_change_pin, last_sign_in_at, pin_changed_at, deactivated_at, created_at
  from profiles;

revoke all on staff_directory from anon;
grant select on staff_directory to authenticated;
grant execute on function record_sign_in(text), mark_pin_changed(), set_profile_active(uuid, boolean),
  update_profile(uuid, text, role_key, text, text, text, lang, text) to authenticated;
revoke execute on function record_sign_in(text), mark_pin_changed(), set_profile_active(uuid, boolean),
  update_profile(uuid, text, role_key, text, text, text, lang, text) from anon;
