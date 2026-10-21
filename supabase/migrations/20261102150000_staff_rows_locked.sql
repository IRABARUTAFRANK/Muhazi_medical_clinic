-- 0058 · Staff accounts change only through the managed paths.
-- The first security migration let every employee update their own profiles row (any column)
-- through the API: anyone signed in could make themselves manager, re-activate themselves or
-- move to another desk. Nothing in the app writes profiles directly: the manager's changes go
-- through the manage-staff function (service role) and the security-definer RPCs
-- (save_my_prefs, mark_pin_changed, record_sign_in, update_profile, set_staff_departments…).

drop policy if exists profiles_update on profiles;
drop policy if exists profiles_insert on profiles;
revoke insert, update, delete on profiles from authenticated, anon;

-- Belt and braces: a direct write by a signed-in user (not through a security-definer function,
-- which runs as the owner) is refused even if a grant comes back one day.
create or replace function guard_profile_write()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'staff accounts are changed by the manager only' using errcode = '42501';
  end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists trg_guard_profile_write on profiles;
create trigger trg_guard_profile_write before insert or update or delete on profiles
  for each row execute function guard_profile_write();

-- The same for the per-role switches: only through set_role_permission (audited).
drop policy if exists role_permissions_write on role_permissions;
revoke insert, update, delete on role_permissions from authenticated, anon;

-- The signed-in person's current profile (role, desk, dashboard…), read again by open tabs every
-- minute so a change by the manager reaches them; refused once the account is deactivated.
create or replace function my_session_profile()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v profiles%rowtype;
begin
  select * into v from profiles where id = auth.uid();
  if not found or not v.active then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email
  );
end
$$;
revoke all on function my_session_profile() from public, anon;
grant execute on function my_session_profile() to authenticated;
