-- Muhazi Medical Clinic System — 0013 the manager can do everything
-- The clinic manager runs the whole clinic: registration, triage, consultation, orders,
-- prescriptions, dispensing, billing, stock, settings. Every permission any role holds is
-- granted to the manager, except `sensitive.*` (HIV testing, doc §2.3): that stays with the
-- nurses and doctors who perform the test, and the manager may be given it explicitly later.

insert into role_permissions (role, permission)
select 'manager', p.permission
from (select distinct permission from role_permissions) p
where p.permission not like 'sensitive.%'
on conflict do nothing;

-- Settings the manager edits from the Clinic settings screen (profile, opening hours).
-- `setting` already has RLS: settings.read / settings.write (manager only for writes).
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;
grant execute on function save_setting(text, jsonb) to authenticated;
revoke execute on function save_setting(text, jsonb) from anon;
