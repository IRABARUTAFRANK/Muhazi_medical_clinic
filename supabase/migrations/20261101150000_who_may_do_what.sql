-- 0054 · The manager decides who may do what.
--
-- Some clinics let reception take payments, others only the cashier; a nurse may be allowed to
-- add treatments in one clinic and not in another. The manager now switches the main features
-- on or off for each role (Settings → Who may do what), and can make an exception for one
-- employee (allowed although their role is not, or not allowed although it is) — for example
-- while the person is not in charge. Every change is recorded in the history.
--
-- New permissions: payment.take (was fixed to cashier + reception) and visit.start (start a
-- visit: Register, new patient, a booked patient's arrival). Vital signs now depend only on
-- vitals.write. Managers keep everything and cannot be locked out.

create table if not exists staff_permission (
  profile_id uuid not null references profiles (id) on delete cascade,
  permission text not null,
  allowed boolean not null,
  set_by uuid default auth.uid(),
  set_at timestamptz not null default now(),
  primary key (profile_id, permission)
);
alter table staff_permission enable row level security;
drop policy if exists staff_permission_select on staff_permission;
create policy staff_permission_select on staff_permission for select to authenticated
  using (profile_id = auth.uid() or is_manager());
revoke all on staff_permission from anon;
grant select on staff_permission to authenticated;

insert into role_permissions (role, permission) values
  ('cashier', 'payment.take'), ('receptionist', 'payment.take'),
  ('receptionist', 'visit.start'), ('nurse', 'visit.start'), ('doctor', 'visit.start'),
  ('manager', 'visit.start'), ('manager', 'vitals.write')
on conflict do nothing;

create or replace function has_perm(p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- An exception set by the manager for this employee wins (allowed or not); else the role.
  select coalesce((
    select sp.allowed from staff_permission sp
    join profiles me on me.id = sp.profile_id and me.active
    where sp.profile_id = auth.uid() and sp.permission = p_permission
  ), exists (
    select 1
    from profiles p
    join role_permissions rp on rp.role = p.role
    where p.id = auth.uid() and p.active and rp.permission = p_permission
  ) or (
    p_permission not like 'sensitive.%' and exists (
      select 1
      from clinician_cover c
      join profiles d on d.id = c.doctor_id
      join role_permissions rp on rp.role = d.role
      join profiles me on me.id = c.nurse_id and me.active
      where c.nurse_id = auth.uid() and c.ended_at is null
        and now() >= c.starts_at and now() < c.ends_at
        and rp.permission = p_permission
    )
  ))
$$;

create or replace function start_visit(
  p_patient_id uuid,
  p_emergency boolean default false,
  p_station station default 'consultation',
  p_type encounter_type default 'opd'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_station station := case when p_emergency then p_station when triage_first() then 'triage'::station else p_station end;
  v_enc uuid;
  v_ticket text;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  -- An emergency is treated on the spot, so only staff who treat may register one.
  if p_emergency and current_role_key() in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;
  v_enc := open_encounter(p_patient_id, p_type, v_station);
  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || p_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;
  select ticket_no into v_ticket from queue_entry where encounter_id = v_enc order by created_at desc limit 1;
  return jsonb_build_object('encounter_id', v_enc, 'ticket_no', v_ticket, 'station', v_station);
end
$$;

create or replace function take_payment(
  p_encounter_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_balance numeric;
  v_number text;
  v_closed boolean := false;
begin
  if not has_perm('payment.take') then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be more than zero' using errcode = '22023';
  end if;
  perform recompute_invoice((select id from invoice where encounter_id = p_encounter_id));
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'credited' then
    raise exception 'this bill was credited' using errcode = '23514';
  end if;
  v_balance := invoice_balance(v_invoice.id);
  if p_amount > v_balance + 0.5 then
    raise exception 'the amount exceeds the balance due (%)', v_balance using errcode = '22023';
  end if;
  perform record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 then
    if v_invoice.status = 'draft' then
      v_number := post_invoice(v_invoice.id);
    else
      select number into v_number from invoice where id = v_invoice.id;
    end if;
    -- Paid: off the cashier's queue in every case.
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
    -- The doctor had finished and nothing else is waiting: the visit is over.
    update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid()
    where id = p_encounter_id and status = 'open' and clinical_done_at is not null
      and not exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id
                      and q.finished_at is null and q.deleted_at is null);
    v_closed := found;
  else
    select number into v_number from invoice where id = v_invoice.id;
  end if;
  return jsonb_build_object('balance', v_balance, 'number', v_number, 'closed', v_closed,
                            'status', (select status from invoice where id = v_invoice.id));
end
$$;

create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not has_perm('vitals.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'enter at least one measurement' using errcode = '22023';
  end if;

  if v_by <> auth.uid() then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'create', 'observation', p_encounter_id,
            jsonb_build_object('measured_by', v_by, 'measured_at', v_at, 'count', v_count),
            'vitals entered on behalf of the person who measured');
  end if;

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- ---------------------------------------------------------------- the manager's controls
create or replace function managed_permission(p text)
returns boolean
language sql immutable
as $$
  select p in ('payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write', 'orders.write', 'appointment.approve', 'stock.write')
$$;

-- What each role may do, and the exceptions per employee (Settings → Who may do what).
create or replace function permission_matrix()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when is_manager() then jsonb_build_object(
    'roles', coalesce((select jsonb_object_agg(r.role, r.perms) from (
        select rp.role::text as role, jsonb_agg(rp.permission order by rp.permission) as perms
        from role_permissions rp where managed_permission(rp.permission) group by rp.role) r), '{}'::jsonb),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object(
        'profileId', sp.profile_id, 'name', p.full_name, 'role', p.role, 'permission', sp.permission,
        'allowed', sp.allowed, 'at', sp.set_at) order by p.full_name, sp.permission)
      from staff_permission sp join profiles p on p.id = sp.profile_id), '[]'::jsonb)
  ) end
$$;

create or replace function set_role_permission(p_role role_key, p_permission text, p_allowed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not managed_permission(p_permission) then
    raise exception 'this feature cannot be switched here' using errcode = '22023';
  end if;
  if p_role = 'manager' then
    raise exception 'the manager keeps every feature' using errcode = '22023';
  end if;
  if p_allowed then
    insert into role_permissions (role, permission) values (p_role, p_permission) on conflict do nothing;
  else
    delete from role_permissions where role = p_role and permission = p_permission;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null,
          jsonb_build_object('key', 'permissions', 'role', p_role, 'permission', p_permission, 'allowed', p_allowed));
end
$$;

-- An exception for one employee: true = allowed, false = not allowed, null = as their role.
create or replace function set_staff_permission(p_profile_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not managed_permission(p_permission) then
    raise exception 'this feature cannot be switched here' using errcode = '22023';
  end if;
  if exists (select 1 from profiles where id = p_profile_id and role = 'manager') then
    raise exception 'the manager keeps every feature' using errcode = '22023';
  end if;
  if p_allowed is null then
    delete from staff_permission where profile_id = p_profile_id and permission = p_permission;
  else
    insert into staff_permission (profile_id, permission, allowed) values (p_profile_id, p_permission, p_allowed)
    on conflict (profile_id, permission) do update set allowed = excluded.allowed, set_by = auth.uid(), set_at = now();
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_profile_id,
          jsonb_build_object('key', 'permission_exception', 'permission', p_permission, 'allowed', p_allowed));
end
$$;

-- What the signed-in person may do among the managed features (the app hides what is not).
create or replace function my_permissions()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write', 'orders.write', 'appointment.approve', 'stock.write']) as p
  where has_perm(p)
$$;

revoke all on function permission_matrix(), set_role_permission(role_key, text, boolean),
  set_staff_permission(uuid, text, boolean), my_permissions() from public, anon;
grant execute on function permission_matrix(), set_role_permission(role_key, text, boolean),
  set_staff_permission(uuid, text, boolean), my_permissions() to authenticated;
