-- 0176: the one who keeps the pharmacy stock has the pharmacist's rights.
--
-- The owner marked a doctor as the keeper (0170); the stock page opened, but the package and the
-- prices of a known medicine stayed locked on Add stock, because the price right
-- (item_price.write) and "Manage stock" (stock.write) are the pharmacist role's, and a doctor's
-- role has neither. Now the mark brings the pharmacist role's permissions with it, under the same
-- Who-may-do-what switches as the pharmacist role: the keeper prices, manages and sells like a
-- pharmacist would. An explicit exception on the person still wins.

-- ---------------------------------------------------------------- has_perm, staff_perm (from 20270121090000_doctor_here)
create or replace function has_perm(p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select true from profiles me
     join role_permissions rp on rp.role = 'manager' and rp.permission = p_permission
     where me.id = auth.uid() and me.active and me.is_manager),
    (select sp.allowed from staff_permission sp
     join profiles me on me.id = sp.profile_id and me.active
     where sp.profile_id = auth.uid() and sp.permission = p_permission),
    exists (select 1 from profiles p
            join role_permissions rp on rp.role = p.role or (rp.role = 'doctor' and doctor_here_any(p.id))
              -- 0176: the one who keeps the pharmacy stock acts as the pharmacist: that role's rights
              or (rp.role = 'pharmacist' and p.is_pharmacist)
            where p.id = auth.uid() and p.active and rp.permission = p_permission))
$$;

create or replace function staff_perm(p_user uuid, p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select true from profiles me
     join role_permissions rp on rp.role = 'manager' and rp.permission = p_permission
     where me.id = p_user and me.active and me.is_manager),
    (select sp.allowed from staff_permission sp where sp.profile_id = p_user and sp.permission = p_permission),
    exists (select 1 from profiles p
            join role_permissions rp on rp.role = p.role or (rp.role = 'doctor' and doctor_here_any(p.id))
              -- 0176: the one who keeps the pharmacy stock acts as the pharmacist: that role's rights
              or (rp.role = 'pharmacist' and p.is_pharmacist)
            where p.id = p_user and p.active and rp.permission = p_permission))
$$;
