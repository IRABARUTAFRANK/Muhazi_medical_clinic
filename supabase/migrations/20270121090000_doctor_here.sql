-- 0141 · A doctor in a department; what the ward adds; the ultrasound done by the doctor; the
-- bill for whoever treats the visit.
--
-- * "Works as the doctor here" (staff_department.doctor_here, set by the manager with
--   set_staff_doctor_here): the person has every doctor power at that department's desks — the
--   doctor's switches and desks there (desk_via, has_perm), the record as a doctor (is_doctor),
--   the orders to the nurses. Their profession stays what it is. Not for reception, the cashier
--   or the administrator; only in a department that treats patients.
-- * Reception, the cashier and the administrator never get "Add treatments to a bill", "Clinical
--   record" or "Request tests": the settings page refuses to switch them on.
-- * A nurse doing a doctor's order works on the patient (may_work_on): she may add what else
--   the patient needs. What the ward adds to the bill (acts, medicines) is in the record for the
--   doctor (visit_extras: by whom, whether it was ordered). A midwife counts as a nurse.
-- * An ultrasound done by the doctor (order_test p_doer: themselves or a doctor colleague): no
--   queue at the ultrasound desk, the charge on the bill, the findings written by that doctor
--   (record_result: the one it is assigned to; detail = the region examined…).
-- * The bill of a visit is for whoever treats it (any profession), the cashier, reception and
--   the manager (may_see_bill): the invoice policies, the patient's file, the visit's track.
--   A prescription is printed only by someone who may read the visit.
-- * my_permissions knows "Change a charge's cover" (0139).

-- ---------------------------------------------------------------- "Works as the doctor here"
alter table staff_department add column if not exists doctor_here boolean not null default false;
alter table staff_department add column if not exists doctor_here_by uuid references profiles (id);
alter table staff_department add column if not exists doctor_here_at timestamptz;

-- appointed the doctor of a department giving this desk (and doing it there)
create or replace function doctor_here_at(p_user uuid, p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from staff_department sd
                 join department d on d.id = sd.department_id and d.active and d.deleted_at is null
                 where sd.profile_id = p_user and sd.doctor_here
                   and p_desk = any (d.services) and p_desk = any (coalesce(sd.services, d.services)))
$$;

-- appointed the doctor of an active department (anywhere)
create or replace function doctor_here_any(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from staff_department sd
                 join department d on d.id = sd.department_id and d.active and d.deleted_at is null
                 where sd.profile_id = p_user and sd.doctor_here)
$$;

-- is_doctor (from 20270106090000_doctors_only_records): + the doctor of a department
create or replace function is_doctor(p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select p.active and p.deleted_at is null
                          and (p.role = 'doctor' or p.is_doctor or doctor_here_any(p.id))
                   from profiles p where p.id = p_user), false)
$$;

-- has_perm / staff_perm (from 20270108090000_profession_manager): the doctor of a department has
-- the doctor's switches too (the manager's exception for the person still wins)
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
            where p.id = p_user and p.active and rp.permission = p_permission))
$$;

-- the manager appoints (or stops) the doctor of a department
create or replace function set_staff_doctor_here(p_profile_id uuid, p_department_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_p profiles%rowtype;
  v_d department%rowtype;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_p from profiles where id = p_profile_id and deleted_at is null;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if coalesce(p_on, false) and v_p.role in ('receptionist', 'cashier', 'administrator') then
    raise exception 'reception, the cashier and the administrator do not treat patients'
      using errcode = '22023', hint = 'not_clinical';
  end if;
  select * into v_d from department where id = p_department_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if not exists (select 1 from staff_department sd where sd.profile_id = p_profile_id and sd.department_id = p_department_id) then
    raise exception 'place the person in % first', v_d.name using errcode = '22023', hint = 'not_placed';
  end if;
  if coalesce(p_on, false) and not (coalesce(v_d.services, '{}') && treating_desks()) then
    raise exception 'the department % treats no patient', v_d.name using errcode = '22023', hint = 'no_treating_desk';
  end if;
  update staff_department
  set doctor_here = coalesce(p_on, false),
      doctor_here_by = case when coalesce(p_on, false) then auth.uid() end,
      doctor_here_at = case when coalesce(p_on, false) then now() end
  where profile_id = p_profile_id and department_id = p_department_id
    and doctor_here is distinct from coalesce(p_on, false);
  if found then
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'settings', 'profiles', p_profile_id,
            jsonb_build_object('key', 'doctor_here', 'department', v_d.name, 'departmentId', v_d.id, 'on', coalesce(p_on, false)));
  end if;
end
$$;
revoke all on function set_staff_doctor_here(uuid, uuid, boolean), doctor_here_at(uuid, text), doctor_here_any(uuid) from public, anon;
grant execute on function set_staff_doctor_here(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- desk_via (from 20270108090000_profession_manager): the doctor of the department has the doctor's ceiling and switches at its desks
create or replace function desk_via(p_user uuid, p_desk text)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when not desk_key(p_desk) then null
    when ex.allowed = false then null
    -- the role's ceiling
    when not exists (select 1 from role_desk rd where (rd.role = p.role or (dh.here and rd.role = 'doctor')) and rd.desk = p_desk) then null
    when in_desk_department(p.id, p_desk)
         and (p_desk in ('laboratory', 'ultrasound', 'pharmacy') or coalesce(ex.allowed, rl.has)) then 'department'
    -- kept on day one by the rule of before (F)
    when coalesce(ex.allowed, rl.has)
         and exists (select 1 from staff_desk_keep k where k.profile_id = p.id and k.desk = p_desk) then 'kept'
    -- no department gives it: the role decides, as before
    when not desk_offered(p_desk) and coalesce(ex.allowed, rl.has)
         and desk_role_rule(p.role, p.station::text, p.specialty::text, p_desk) then 'role'
  end
  from profiles p
  cross join lateral (select doctor_here_at(p.id, p_desk) as here) dh
  cross join lateral (
    select exists (select 1 from role_permissions rp
                   where (rp.role = p.role or (p.is_manager and rp.role = 'manager') or (dh.here and rp.role = 'doctor'))
                     and rp.permission = desk_permission(p_desk)) as has
  ) rl
  left join staff_permission ex on ex.profile_id = p.id and ex.permission = desk_permission(p_desk)
  where p.id = p_user and p.active and p.deleted_at is null
$$;

-- ---------------------------------------------------------------- staff_directory (from 20270108090000_profession_manager): + doctorHere per department
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position,
                                                       'services', to_jsonb(sd.services), 'doctorHere', sd.doctor_here)
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments,
         p.registration_no, p.registration_body,
         desks_of(p.id) as desks, kept_desks_of(p.id) as kept_desks,
         -- 0126: marked a doctor by the manager (the role 'doctor' is one anyway)
         p.is_doctor,
         -- 0128: also the clinic manager
         p.is_manager
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;
revoke all on staff_directory from anon;
grant select on staff_directory to authenticated;

-- ---------------------------------------------------------------- is_nurse_role (from 20270112090000_nurses_by_role): a midwife counts as a nurse
create or replace function is_nurse_role(p_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles p
                 where p.id = p_id and p.active and p.deleted_at is null and p.role in ('nurse', 'midwife'))
$$;

-- ---------------------------------------------------------------- my_permissions (from 20261219090000_room_store_walkin): + charge.override (0139)
create or replace function my_permissions()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
                    'orders.write', 'appointment.approve', 'stock.write', 'records.approve',
                    'stock.sell_walkin', 'charge.override']) as p
  where has_perm(p)
$$;

-- ---------------------------------------------------------------- the switches reception, the cashier and the administrator never get
create or replace function clinical_only_permission(p_permission text)
returns boolean
language sql immutable
as $$
  select p_permission in ('clinical.write', 'charge.write', 'orders.write', 'charge.manual')
$$;

-- ---------------------------------------------------------------- set_role_permission (from 20261101150000_who_may_do_what): never a treating switch for reception, the cashier, the administrator
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
  if p_allowed and p_role in ('receptionist', 'cashier', 'administrator') and clinical_only_permission(p_permission) then
    raise exception 'reception, the cashier and the administrator do not treat patients'
      using errcode = '22023', hint = 'not_clinical';
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

-- ---------------------------------------------------------------- set_staff_permission (from 20270108090000_profession_manager): the same for one person
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
  if p_allowed and clinical_only_permission(p_permission)
     and exists (select 1 from profiles where id = p_profile_id and role in ('receptionist', 'cashier', 'administrator')) then
    raise exception 'reception, the cashier and the administrator do not treat patients'
      using errcode = '22023', hint = 'not_clinical';
  end if;
  if exists (select 1 from profiles where id = p_profile_id and is_manager) then
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

-- ---------------------------------------------------------------- the ultrasound a doctor does: who it is assigned to; the findings in detail
alter table service_request add column if not exists assigned_to uuid references profiles (id);
alter table diagnostic_report add column if not exists detail jsonb;

-- ---------------------------------------------------------------- may_work_on (from 20270108090000_profession_manager): + a nurse order for me, an ultrasound assigned to me
create or replace function may_work_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from queue_entry q
               where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                 and queue_entry_for_me(q.id))
    -- a task on this visit for me or the people it is for (the doctor asked the nurse for an injection…)
    or exists (select 1 from internal_task k
               where k.encounter_id = p_encounter_id and k.done_at is null and k.deleted_at is null
                 and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role)))
    -- an order of the doctor on this visit for me (or for all the nurses): the nurse carrying it
    -- out may add what else the patient needs (0141)
    or exists (select 1 from nurse_order o
               where o.encounter_id = p_encounter_id and o.status = 'open' and o.deleted_at is null
                 and nurse_order_mine(o.assigned_to))
    -- an ultrasound of this visit assigned to me (0141)
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.assigned_to = auth.uid()
                 and r.status not in ('verified', 'cancelled'))
    -- a colleague who accepted to help on this patient
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status = 'accepted'
                 and c.answered_by = auth.uid())
    -- nobody holds the patient at a treating desk (e.g. now at the cashier): whoever treated
    -- them in this visit may still complete the record
    or (not exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer'))
        and exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.deleted_at is null
                      and (q.taken_by = auth.uid() or q.assigned_to = auth.uid())))
$$;

-- ---------------------------------------------------------------- visit_working_on (from 20270106090000_doctors_only_records): + an ultrasound assigned to the person
create or replace function visit_working_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null
    and exists (select 1 from encounter e where e.id = p_encounter_id and e.status = 'open' and e.deleted_at is null)
    and (may_work_on(p_encounter_id) or took_part(p_encounter_id)
         -- the visit waits, not yet taken, at a desk this person uses (they may take the patient)
         or exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and q.taken_by is null and (q.assigned_to is null or q.assigned_to = auth.uid())
                      and q.station <> 'reception' and may_use_any_desk(station_desks(q.station)))
         -- a test of the visit is open at their laboratory or ultrasound desk
         or exists (select 1 from service_request r
                    where r.encounter_id = p_encounter_id and r.deleted_at is null
                      and r.status not in ('verified', 'cancelled')
                      and may_use_desk(request_desk(r.station, r.category)))
         -- an ultrasound of the visit assigned to this person (0141)
         or exists (select 1 from service_request r
                    where r.encounter_id = p_encounter_id and r.deleted_at is null and r.assigned_to = auth.uid())
         -- a medicine of the visit waits at the pharmacy
         or (may_use_desk('pharmacy')
             and exists (select 1 from medication_request m
                         where m.encounter_id = p_encounter_id and m.deleted_at is null and rx_pending(m))))
$$;

-- ---------------------------------------------------------------- treated (from 20270107090000_six_steps): + a nurse who carried out an order, the doctor who did the scan
create or replace function treated(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user is not null and (
    exists (select 1 from queue_entry q
            where q.encounter_id = p_encounter_id and q.deleted_at is null and q.taken_by = p_user
              and station_desks(q.station) && treating_desks())
    or exists (select 1 from condition c
               where c.encounter_id = p_encounter_id and c.deleted_at is null and c.created_by = p_user)
    or exists (select 1 from observation o
               where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code = 'note'
                 and coalesce(o.performer_id, o.created_by) = p_user)
    or exists (select 1 from medication_request m
               where m.encounter_id = p_encounter_id and m.deleted_at is null
                 and (m.prescriber_id = p_user or (m.prescriber_id is null and m.created_by = p_user)))
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.requester_id = p_user)
    or exists (select 1 from service_request r
               join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
               where r.encounter_id = p_encounter_id and r.category = 'imaging'
                 and (d.created_by = p_user or d.verified_by = p_user))
    or exists (select 1 from procedure pr
               where pr.encounter_id = p_encounter_id and pr.deleted_at is null and pr.performer_id = p_user)
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.answered_by = p_user
                 and c.status in ('accepted', 'done'))
    -- 0127: wrote a text of the visit, or gave an order to the nurses
    or exists (select 1 from visit_section s
               where s.encounter_id = p_encounter_id and s.deleted_at is null and s.created_by = p_user)
    or exists (select 1 from nurse_order o
               where o.encounter_id = p_encounter_id and o.deleted_at is null and o.created_by = p_user)
    -- 0141: carried out an order of the doctor, or did the ultrasound assigned to them
    or exists (select 1 from nurse_order_dose d join nurse_order o on o.id = d.order_id
               where o.encounter_id = p_encounter_id and d.deleted_at is null and d.by_id = p_user)
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.assigned_to = p_user
                 and r.status in ('resulted', 'verified'))
  )
$$;

-- ---------------------------------------------------------------- may_see_bill: whoever treats the visit, the cashier, reception, the manager
create or replace function may_see_bill(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and (
    is_manager() or has_perm('billing.read') or has_perm('payment.take')
    -- treating it now, or treated it, whatever the profession (a nurse, the lab, the pharmacy…)
    or ((has_perm('charge.write') or has_perm('clinical.write') or has_perm('orders.write') or has_perm('stock.dispense'))
        and (visit_working_on(p_encounter_id) or took_part(p_encounter_id)))
    -- a doctor who may read the visit
    or visit_view(p_encounter_id) is not null)
$$;
revoke all on function may_see_bill(uuid) from public, anon;
grant execute on function may_see_bill(uuid) to authenticated;

drop policy if exists invoice_select_clinical on invoice;
create policy invoice_select_clinical on invoice for select to authenticated
  using (may_see_bill(encounter_id));
drop policy if exists invoice_line_select_clinical on invoice_line;
create policy invoice_line_select_clinical on invoice_line for select to authenticated
  using (exists (select 1 from invoice i where i.id = invoice_line.invoice_id and may_see_bill(i.encounter_id)));

-- ---------------------------------------------------------------- patient_file (from 20270107090000_six_steps): the bills only for those who may see them
create or replace function patient_file(p_patient_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_patient jsonb;
  v_visits jsonb;
  v_vitals jsonb;
  v_conditions jsonb;
  v_bills jsonb;
  v_doc jsonb;
  v_reader boolean := clinical_reader();
  v_via text;
  v_treating uuid;
  v_level text;
  v_past_seen boolean;
  v_views jsonb;
  v_extra_filled jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select to_jsonb(p) - 'photo_blob_id' - 'merged_into' - 'guardian_patient_id' into v_patient
  from patient p where p.id = p_patient_id and p.deleted_at is null;
  if v_patient is null then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
  -- worked out once for the whole file (the visits' loop reuses them)
  v_via := history_via(p_patient_id);
  v_treating := treating_visit(p_patient_id);
  v_level := case when v_via is not null then 'full' when v_treating is not null then 'summary' else 'identity' end;

  -- how each visit may be seen (null: private)
  select coalesce(jsonb_object_agg(e.id::text, s.view) filter (where s.view is not null), '{}'::jsonb),
         coalesce(bool_or(s.view is not null and e.status = 'closed'), false)
  into v_views, v_past_seen
  from encounter e
  cross join lateral (select case when v_reader then visit_view_with(e.id, v_via, true) end as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'reference', e.reference, 'arrivedAt', e.arrived_at, 'status', e.status, 'type', e.type,
      'triage', e.triage_level,
      'triageReason', case when s.view is not null then e.triage_reason end,
      'practitioner', (select names from practitioner where id = e.practitioner_id),
      'stations', (select coalesce(jsonb_agg(distinct q.station::text), '[]'::jsonb) from queue_entry q where q.encounter_id = e.id and q.deleted_at is null),
      'currentStation', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null and q.deleted_at is null order by q.created_at desc limit 1),
      'diagnosis', case when s.view is not null then
        (select c.text from condition c where c.encounter_id = e.id and c.type = 'primary' and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read')) order by c.created_at desc limit 1) end,
      -- 0127: the chief complaint (step 1); the diagnosis above is the definitive primary one
      'complaint', case when s.view is not null then visit_complaint(e.id) end,
      -- 0141: the money of a visit for whoever treats it, the cashier, reception, the manager
      'total', case when may_see_bill(e.id) then (select i.total from invoice i where i.encounter_id = e.id) end,
      'balance', case when may_see_bill(e.id) then (select invoice_balance(i.id) from invoice i where i.encounter_id = e.id) end,
      'billStatus', case when may_see_bill(e.id) then (select i.status from invoice i where i.encounter_id = e.id) end,
      'closedAt', e.closed_at,
      'private', s.view is null,
      'view', s.view
    ) order by e.arrived_at desc), '[]'::jsonb) into v_visits
  from encounter e cross join lateral (select v_views ->> e.id::text as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', o.encounter_id, 'code', o.code, 'label', o.label, 'value', o.value_num, 'text', o.value_text,
      'unit', o.unit, 'at', o.effective_at, 'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at desc), '[]'::jsonb) into v_vitals
  -- the visits one may see; whoever types the nurse's sheet (vitals.write) also sees what is
  -- recorded on the open visit (0019), never a past one
  from observation o
  where o.deleted_at is null and o.code <> 'note'
    and (v_views ? o.encounter_id::text
         or (has_perm('vitals.write')
             and o.encounter_id in (select e.id from encounter e
                                    where e.patient_id = p_patient_id and e.status = 'open' and e.deleted_at is null)));

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'encounterId', c.encounter_id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type,
      'provisional', c.provisional, 'stage', c.stage, 'at', c.created_at, 'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at desc), '[]'::jsonb) into v_conditions
  from condition c
  where v_views ? c.encounter_id::text and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'));

  select coalesce(jsonb_agg(jsonb_build_object(
      'invoiceId', i.id, 'encounterId', i.encounter_id, 'number', i.number, 'status', i.status,
      'total', i.total, 'patientShare', i.patient_share, 'insurerShare', i.insurer_share,
      'balance', invoice_balance(i.id), 'payer', (select name from payer where id = i.payer_id),
      'at', i.created_at
    ) order by i.created_at desc), '[]'::jsonb) into v_bills
  from invoice i join encounter e on e.id = i.encounter_id
  where e.patient_id = p_patient_id and i.deleted_at is null and may_see_bill(e.id);

  -- the private extra fields that have a value (the keys only; the form locks them)
  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_extra_filled
  from unnest(private_extra_keys()) k
  where nullif(trim(coalesce(v_patient -> 'extra' ->> k, '')), '') is not null;

  v_doc := doc_patient(p_patient_id, null);
  if v_level = 'identity' then
    v_patient := v_patient || jsonb_build_object('allergies', null, 'allergies_none', null,
                                                 'blood_group', null, 'notes', null,
                                                 -- the manager's "medical" extra fields go too
                                                 'extra', coalesce(v_patient -> 'extra', '{}'::jsonb) - private_extra_keys(),
                                                 -- the safety marks go; "VIP" is not one
                                                 'flags', jsonb_strip_nulls(jsonb_build_object('vip', v_patient -> 'flags' -> 'vip')));
    v_doc := v_doc - 'allergies' - 'allergiesNone' - 'bloodGroup' - 'weightKg' - 'weightAt';
  end if;

  if v_past_seen then
    perform log_record_access(p_patient_id, null, coalesce(v_via, 'own'), 'file');
  end if;

  return jsonb_build_object('patient', v_patient, 'visits', v_visits, 'vitals', v_vitals,
                            'conditions', v_conditions, 'bills', v_bills,
                            'document', v_doc,
                            'safetyHidden', v_level = 'identity',
                            'extra_filled', v_extra_filled,
                            'summary', case when v_level <> 'identity' then patient_safety_summary(p_patient_id) end,
                            'access', patient_access_with(p_patient_id, v_via, v_treating));
end
$$;

-- ---------------------------------------------------------------- visit_journey (from 20270106090000_doctors_only_records): the same on the visit's track
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb := '[]'::jsonb;
  v_dx jsonb := '[]'::jsonb;
  v_meds jsonb := '[]'::jsonb;
  v_tests jsonb := '[]'::jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_enc encounter%rowtype;
  v_view text;
  v_handovers jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  v_view := case when clinical_reader() then visit_view(p_encounter_id) end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', case when v_view is not null then q.referral_note end,
      'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  if v_view is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'code', o.code, 'label', o.label, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)
      ) order by o.effective_at), '[]'::jsonb) into v_vitals
    from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

    select coalesce(jsonb_agg(jsonb_build_object(
        'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)
      ) order by c.created_at), '[]'::jsonb) into v_dx
    from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'));

    select coalesce(jsonb_agg(jsonb_build_object(
        'item', rx_label(m), 'quantity', m.quantity, 'dose', m.dose,
        'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
        'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
        'by', (select full_name from profiles where id = m.created_by),
        'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'notGivenBy', (select full_name from profiles where id = m.not_given_by),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by)
      ) order by m.created_at), '[]'::jsonb) into v_meds
    from medication_request m
    where m.encounter_id = p_encounter_id and m.deleted_at is null;

    select coalesce(jsonb_agg(jsonb_build_object(
        'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
        'by', (select full_name from profiles where id = r.created_by),
        'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
      ) order by r.created_at), '[]'::jsonb) into v_tests
    from service_request r left join service s on s.id = r.service_id
    where r.encounter_id = p_encounter_id and r.deleted_at is null
      and (has_perm('sensitive.read') or not sensitive_service(r.service_id));

    if v_enc.status = 'closed' then
      perform log_record_access(v_enc.patient_id, p_encounter_id, v_view, 'journey');
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
      'total', round(l.quantity * l.unit_price), 'office', l.office, 'at', l.created_at,
      'by', (select full_name from profiles where id = l.entered_by)
    ) order by l.created_at), '[]'::jsonb) into v_charges
  from invoice_line l join invoice i on i.id = l.invoice_id
  where i.encounter_id = p_encounter_id and l.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'amount', p.amount, 'method', p.method, 'reference', p.reference, 'at', p.paid_at,
      'by', (select full_name from profiles where id = p.cashier_id)
    ) order by p.paid_at), '[]'::jsonb) into v_payments
  from payment p join invoice i on i.id = p.invoice_id
  where i.encounter_id = p_encounter_id and p.deleted_at is null;

  select jsonb_build_object('status', b.status, 'total', b.total, 'balance', b.balance, 'paid', b.paid,
                            'number', b.number, 'settledBy', b.settled_by, 'settledAt', b.settled_at)
  into v_bill from visit_bill b where b.encounter_id = p_encounter_id;

  -- 0141: the money of the visit for whoever treats it, the cashier, reception, the manager
  if not may_see_bill(p_encounter_id) then
    v_charges := '[]'::jsonb;
    v_payments := '[]'::jsonb;
    v_bill := null;
  end if;

  -- who handed the patient over to whom (20261129090000_handover); the note and the reason are
  -- clinical: for the two colleagues and those who may see this visit's record
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'station', h.station, 'at', h.created_at, 'from', f.full_name, 'to', t.full_name,
      'note', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.note end,
      'status', h.status, 'answeredAt', h.answered_at,
      'answeredBy', (select full_name from profiles where id = h.answered_by),
      'reason', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.reason end
    ) order by h.created_at), '[]'::jsonb) into v_handovers
  from patient_handover h
  join profiles f on f.id = h.from_user
  join profiles t on t.id = h.to_user
  where h.encounter_id = p_encounter_id and h.deleted_at is null;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level,
    'triageReason', case when v_view is not null then v_enc.triage_reason end,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill, 'handovers', v_handovers,
    'private', v_view is null
  );
end
$$;

-- ---------------------------------------------------------------- prescription_number (from 20261125090000_document_details): printed only by someone who may read the visit
create or replace function prescription_number(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_lines uuid[];
  v_doc prescription_doc%rowtype;
  v_new boolean := false;
  v_year integer := extract(year from (now() at time zone 'Africa/Kigali'))::integer;
  v_prescriber uuid;
begin
  -- 0141: the pharmacy; else someone who may read this visit (its doctor, the ward on it)
  if not ((has_perm('prescription.read') and not is_doctor() and not has_perm('clinical.write'))
          or is_manager() or visit_view(p_encounter_id) is not null
          or visit_desk_view(p_encounter_id) is not null or took_part(p_encounter_id)) then
    raise exception 'not allowed: this visit''s record is not yours to read' using errcode = '42501', hint = 'no_record';
  end if;
  -- one number at a time per visit (two printers at once get the same one)
  perform 1 from encounter where id = p_encounter_id and deleted_at is null for update;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into v_lines
  from medication_request m
  where m.encounter_id = p_encounter_id and m.deleted_at is null and m.cancelled_at is null;
  if cardinality(v_lines) = 0 then
    raise exception 'nothing is prescribed for this visit' using errcode = '22023', hint = 'no_lines';
  end if;
  select * into v_doc from prescription_doc
  where encounter_id = p_encounter_id order by issued_at desc, number desc limit 1;
  if v_doc.id is null or not (v_lines <@ v_doc.line_ids) then
    insert into prescription_doc (number, encounter_id, line_ids, issued_by)
    values ('RX-' || v_year || '-' || lpad(next_number('prescription', v_year)::text, 6, '0'),
            p_encounter_id, v_lines, auth.uid())
    returning * into v_doc;
    v_new := true;
  end if;
  select coalesce(m.prescriber_id, m.created_by) into v_prescriber
  from medication_request m
  where m.id = any (v_lines)
  order by (m.supply = 'room'), m.created_at
  limit 1;
  return jsonb_build_object(
    'number', v_doc.number, 'issuedAt', v_doc.issued_at, 'issuedById', v_doc.issued_by,
    'issuedBy', (select full_name from profiles where id = v_doc.issued_by),
    'lineIds', to_jsonb(v_doc.line_ids), 'isNew', v_new,
    'prescriber', doc_person(v_prescriber));
end
$$;

-- ---------------------------------------------------------------- visit_extras: what was added to the bill by someone other than a doctor
create or replace function visit_extras(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id, 'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
      'kind', case when l.item_id is not null then 'medicine' else 'act' end,
      'at', l.created_at, 'byId', l.entered_by,
      'by', (select full_name from profiles where id = l.entered_by),
      'byRole', (select pr.role from profiles pr where pr.id = l.entered_by),
      'office', l.office,
      -- ordered by the doctor: a nurse order of this visit for the same treatment or medicine
      'ordered', exists (select 1 from nurse_order o
                         where o.encounter_id = p_encounter_id and o.deleted_at is null and o.status <> 'cancelled'
                           and ((l.service_id is not null and o.service_id = l.service_id)
                             or (l.item_id is not null and o.item_id = l.item_id)))
    ) order by l.created_at)
  from invoice_line l
  join invoice i on i.id = l.invoice_id and i.deleted_at is null
  where i.encounter_id = p_encounter_id and l.deleted_at is null
    and coalesce(l.source_type, '') not in ('service_request', 'bed_stay', 'nurse_order')
    and l.entered_by is not null and not is_doctor(l.entered_by)), '[]'::jsonb)
$$;
revoke all on function visit_extras(uuid) from public, anon;

-- ---------------------------------------------------------------- visit_clinical (from 20270107090000_six_steps): + extras, the doctor who does a scan, the findings in detail
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_view text;
  v_patient uuid;
  v_closed boolean;
  v_safe boolean;
begin
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  if not clinical_reader() then
    return null;
  end if;
  select e.patient_id, e.status = 'closed' into v_patient, v_closed
  from encounter e where e.id = p_encounter_id and e.deleted_at is null;
  if v_patient is null then
    return null;
  end if;
  v_view := visit_view(p_encounter_id);
  if v_view is null then
    -- 0126: someone who is not a doctor and works on the open visit: the desk's part
    if visit_desk_view(p_encounter_id) is not null then
      return visit_clinical_desk(p_encounter_id);
    end if;
    v_safe := patient_level(v_patient) <> 'identity';
    return jsonb_build_object(
      'diagnoses', '[]'::jsonb, 'notes', '[]'::jsonb, 'prescriptions', '[]'::jsonb, 'orders', '[]'::jsonb,
      'patient', (select jsonb_build_object('id', p.id,
                    'allergies', case when v_safe then p.allergies end,
                    'bloodGroup', case when v_safe then p.blood_group end,
                    'notes', case when v_safe then p.notes end,
                    'flags', case when v_safe then p.flags else '{}'::jsonb end)
                  || case when v_safe then doc_patient(p.id, p_encounter_id)
                          else doc_patient(p.id, p_encounter_id) - 'allergies' - 'allergiesNone' - 'bloodGroup'
                               - 'weightKg' - 'weightAt' end
                  from patient p where p.id = v_patient),
      'visit', doc_visit(p_encounter_id),
      'private', true,
      'view', null,
      'access', patient_access(v_patient),
      -- 0126: the record is for doctors
      'forDoctors', not is_doctor());
  end if;
  if v_closed then
    perform log_record_access(v_patient, p_encounter_id, v_view, 'visit');
  end if;
  return jsonb_build_object(
    -- removed diagnoses stay, marked (removedAt), so the record shows what was written and withdrawn
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'stage', c.stage, 'differentialId', c.differential_id, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by), 'byId', c.created_by,
        'editedAt', case when c.deleted_at is null and c.edit_reason is not null then c.updated_at end,
        'editedBy', case when c.deleted_at is null and c.edit_reason is not null then (select full_name from profiles where id = c.updated_by) end,
        'editReason', case when c.deleted_at is null then c.edit_reason end,
        'removedAt', c.deleted_at,
        'removedBy', case when c.deleted_at is not null then (select full_name from profiles where id = c.updated_by) end,
        'removeReason', case when c.deleted_at is not null then c.edit_reason end,
        'history', record_history('condition', c.id)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id), 'byId', coalesce(o.performer_id, o.created_by),
        'editedAt', case when o.edit_reason is not null then o.updated_at end,
        'editedBy', case when o.edit_reason is not null then (select full_name from profiles where id = o.updated_by) end,
        'editReason', o.edit_reason,
        'history', record_history('observation', o.id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', rx_label(m), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'itemId', m.item_id, 'referenceCode', m.reference_code, 'quantityGiven', coalesce(m.quantity_given, 0),
        'supplySetAt', m.supply_set_at, 'supplySetBy', (select full_name from profiles where id = m.supply_set_by),
        'supplyReason', m.supply_reason,
        -- 0104: the remainder of a partly given line sent outside points at the original (split_from)
        'splitFrom', m.split_from,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    -- HIV tests (like the diagnoses above) only for the people allowed to see them
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false), 'doerId', r.assigned_to, 'doer', (select full_name from profiles where id = r.assigned_to),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'detail', d.detail, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (has_perm('sensitive.read') or not sensitive_service(s.id))), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', v_view,
    -- 0104: the lock of a finished visit and the reader's edit window
    'editLock', visit_edit_status(p_encounter_id),
    -- 0127: the doctor's texts (steps 1, 2, 6) and the orders to the nurses
    'sections', visit_sections_json(p_encounter_id, null),
    'nurseOrders', visit_nurse_orders(p_encounter_id, false),
    -- 0141: what the ward added to the bill (acts, medicines), for the doctor
    'extras', visit_extras(p_encounter_id),
    'hasComplaint', visit_complaint(p_encounter_id) is not null
  );
end
$$;

-- ---------------------------------------------------------------- visit_clinical_desk (from 20270107090000_six_steps): the same for the desk's part
create or replace function visit_clinical_desk(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_pharmacy boolean := works_at_desk('pharmacy');
  v_treat boolean := exists (select 1 from unnest(treating_desks()) d(desk) where works_at_desk(d.desk));
  v_sens boolean := has_perm('sensitive.read');
begin
  return jsonb_build_object(
    -- what the person wrote themselves (removed ones stay, marked)
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'stage', c.stage, 'differentialId', c.differential_id, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by), 'byId', c.created_by,
        'editedAt', case when c.deleted_at is null and c.edit_reason is not null then c.updated_at end,
        'editedBy', case when c.deleted_at is null and c.edit_reason is not null then (select full_name from profiles where id = c.updated_by) end,
        'editReason', case when c.deleted_at is null then c.edit_reason end,
        'removedAt', c.deleted_at,
        'removedBy', case when c.deleted_at is not null then (select full_name from profiles where id = c.updated_by) end,
        'removeReason', case when c.deleted_at is not null then c.edit_reason end,
        'history', '[]'::jsonb) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.created_by = v_me), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id), 'byId', coalesce(o.performer_id, o.created_by),
        'editedAt', case when o.edit_reason is not null then o.updated_at end,
        'editedBy', case when o.edit_reason is not null then (select full_name from profiles where id = o.updated_by) end,
        'editReason', o.edit_reason,
        'history', '[]'::jsonb) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null
        and coalesce(o.performer_id, o.created_by) = v_me), '[]'::jsonb),
    -- the medicines: the person's own; the pharmacy's to hand over; a treating desk's given in the room
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', rx_label(m), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'itemId', m.item_id, 'referenceCode', m.reference_code, 'quantityGiven', coalesce(m.quantity_given, 0),
        'supplySetAt', m.supply_set_at, 'supplySetBy', (select full_name from profiles where id = m.supply_set_by),
        'supplyReason', m.supply_reason,
        'splitFrom', m.split_from,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null
        and (coalesce(m.prescriber_id, m.created_by) = v_me or v_pharmacy or (v_treat and m.supply = 'room'))), '[]'::jsonb),
    -- the tests the person's desk runs, with their reason and result; the tests they asked for
    -- themselves without the result (an HIV test: the desk running it, or sensitive.read)
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status,
        'reason', case when k.runs or r.requester_id = v_me then r.reason end, 'at', r.created_at, 'mine', coalesce(r.requester_id = v_me, false), 'doerId', r.assigned_to, 'doer', (select full_name from profiles where id = r.assigned_to),
        'result', case when k.runs then (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'detail', d.detail, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null) end) order by r.created_at)
      from service_request r
      join service s on s.id = r.service_id
      cross join lateral (
        select coalesce(r.assigned_to = v_me, false) or works_at_desk(request_desk(r.station, r.category))
               or (coalesce(r.station::text, 'laboratory') not in ('laboratory', 'ultrasound')
                   and has_perm('clinical.write')
                   and exists (select 1 from unnest(station_desks(r.station)) sd(desk) where works_at_desk(sd.desk))) as runs
      ) k
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (k.runs or (r.requester_id = v_me and (v_sens or not sensitive_service(s.id))))), '[]'::jsonb),
    -- the safety summary of the patient: allergies, blood group, alerts
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', 'desk',
    -- the rest of the record is for doctors
    'forDoctors', true,
    'desk', jsonb_build_object('pharmacy', v_pharmacy, 'treating', v_treat,
                               'laboratory', works_at_desk('laboratory'), 'ultrasound', works_at_desk('ultrasound')),
    -- what finishing the visit needs to know, without the words
    'hasPrimaryDiagnosis', exists (select 1 from condition c
                                   where c.encounter_id = p_encounter_id and c.deleted_at is null and c.type = 'primary'),
    'hasNoDiagnosis', exists (select 1 from encounter e where e.id = p_encounter_id and e.no_diagnosis_kind is not null),
    'editLock', visit_edit_status(p_encounter_id),
    -- 0127: what the person wrote of the doctor's texts, the orders for them; finishing needs to
    -- know there is a chief complaint, without its words
    'sections', visit_sections_json(p_encounter_id, v_me),
    'nurseOrders', visit_nurse_orders(p_encounter_id, true),
    'extras', visit_extras(p_encounter_id),
    'hasComplaint', visit_complaint(p_encounter_id) is not null
  );
end
$$;

-- ---------------------------------------------------------------- order_test (from 20261212090000_visit_edit_lock): + p_doer, the doctor who does the ultrasound
create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text, p_priority integer, p_doer uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_group service_group;
  v_cat request_category;
  v_station station;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks() || array['laboratory', 'ultrasound'], 'ordering tests');
  perform assert_may_work_on(p_encounter_id);
  select s.service_group,
         coalesce(c.order_station, case when s.service_group = 'imaging' then 'ultrasound'::station else 'laboratory'::station end)
  into v_group, v_station
  from service s left join service_category c on c.id = s.category_id
  where s.id = p_service_id and s.active and s.deleted_at is null;
  if v_group is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  v_cat := case when v_station = 'ultrasound' then 'imaging'::request_category else 'lab'::request_category end;
  -- 0141: an ultrasound done by a doctor (themselves or a colleague): no queue at the desk
  if p_doer is not null then
    if v_cat <> 'imaging' then
      raise exception 'only an ultrasound is done by the doctor' using errcode = '22023', hint = 'not_imaging';
    end if;
    if not is_doctor(p_doer) then
      raise exception 'choose a doctor to do the ultrasound' using errcode = '22023', hint = 'not_doctor';
    end if;
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into service_request (encounter_id, category, service_id, reason, priority, station, assigned_to, status)
  values (p_encounter_id, v_cat, p_service_id, nullif(trim(coalesce(p_reason, '')), ''), least(5, greatest(1, p_priority)), v_station,
          p_doer, case when p_doer is null then 'ordered'::request_status else 'in_process'::request_status end)
  returning id into v_id;
  perform add_charge_internal(p_encounter_id, v_station, p_service_id, null, 1, null, null, null, null, 'service_request', v_id);
  if p_doer is not null and p_doer <> auth.uid() then
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('scan_request',
            jsonb_build_object('test', (select s.name_en from service s where s.id = p_service_id),
                               'name', (select p.surname || ' ' || p.given_names from patient p join encounter e on e.patient_id = p.id where e.id = p_encounter_id),
                               'by', (select full_name from profiles where id = auth.uid()),
                               'reason', nullif(trim(coalesce(p_reason, '')), '')),
            '/app/visit?encounter=' || p_encounter_id, p_doer, p_priority <= 2, auth.uid());
  end if;
  if p_doer is null and not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_station and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, v_station, (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1), least(5, greatest(1, p_priority)));
  end if;
  perform note_visit_edit(p_encounter_id, 'create', 'service_request', v_id,
                          jsonb_build_object('serviceId', p_service_id, 'station', v_station));
  return v_id;
end
$$;
-- the call of before 0141 (the desk does it)
create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text default null, p_priority integer default 3)
returns uuid
language sql security definer set search_path = public
as $$
  select order_test(p_encounter_id, p_service_id, p_reason, coalesce(p_priority, 3), null::uuid)
$$;
revoke all on function order_test(uuid, uuid, text, integer, uuid), order_test(uuid, uuid, text, integer) from public, anon;
grant execute on function order_test(uuid, uuid, text, integer, uuid), order_test(uuid, uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------- order_tests (from 20261126090000_departments_decide_desks): + p_doer
drop function if exists order_tests(uuid, uuid[], text, station);
create or replace function order_tests(
  p_encounter_id uuid,
  p_service_ids uuid[],
  p_reason text,
  p_from station,
  p_priority integer,
  p_doer uuid
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_service uuid;
  v_ids uuid[] := '{}';
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks() || array['laboratory', 'ultrasound'], 'ordering tests');
  perform assert_may_work_on(p_encounter_id);
  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'choose at least one test' using errcode = '22023';
  end if;
  foreach v_service in array p_service_ids loop
    -- urgent orders (1–2) go to the top of the lab's list
    v_ids := v_ids || order_test(p_encounter_id, v_service, p_reason, greatest(1, least(coalesce(p_priority, 3), 5)), p_doer);
  end loop;
  -- Send the patient now: off the doctor's queue, onto the desks that do the orders, back after.
  if p_from is not null and p_doer is null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = p_from and finished_at is null
      and p_from not in (select r.station from service_request r where r.id = any (v_ids));
    update queue_entry
    set referred_by = auth.uid(),
        referral_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), referral_note),
        return_station = p_from,
        return_to = auth.uid()
    where encounter_id = p_encounter_id and finished_at is null and deleted_at is null
      and station <> p_from
      and station in (select r.station from service_request r where r.id = any (v_ids));
  end if;
  return coalesce(array_length(v_ids, 1), 0);
end
$$;
-- the call of before 0141
create or replace function order_tests(p_encounter_id uuid, p_service_ids uuid[], p_reason text default null, p_from station default null, p_priority integer default 3)
returns integer
language sql security definer set search_path = public
as $$
  select order_tests(p_encounter_id, p_service_ids, p_reason, p_from, p_priority, null::uuid)
$$;
revoke all on function order_tests(uuid, uuid[], text, station, integer, uuid), order_tests(uuid, uuid[], text, station, integer) from public, anon;
grant execute on function order_tests(uuid, uuid[], text, station, integer, uuid), order_tests(uuid, uuid[], text, station, integer) to authenticated;

-- ---------------------------------------------------------------- record_result (from 20270106090000_doctors_only_records): the doctor it is assigned to; the findings in detail
create or replace function record_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_verify boolean,
  p_detail jsonb
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_station station;
  v_q queue_entry%rowtype;
  v_tests text;
  v_to uuid;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- Lab / ultrasound results: the laboratory or ultrasound desk; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too. Never the clinician who asked for
  -- the test (0104).
  -- 0141: the doctor the ultrasound is assigned to writes its findings
  if not (coalesce(v_req.assigned_to = auth.uid(), false) or (may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_req.status = 'cancelled' then
    raise exception 'this test was marked "not done": order it again if it is done after all' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  if exists (select 1 from diagnostic_report where service_request_id = p_request_id
             and deleted_at is null and verified_at is not null) then
    raise exception 'this result is verified: correct it, giving the reason' using errcode = '22023';
  end if;
  insert into diagnostic_report (service_request_id, findings, impression, detail, verified_by, verified_at)
  values (p_request_id, nullif(trim(coalesce(p_findings, '')), ''), nullif(trim(coalesce(p_impression, '')), ''),
          case when jsonb_typeof(p_detail) = 'object' then p_detail end,
          case when p_verify then auth.uid() end, case when p_verify then now() end)
  on conflict (service_request_id) do update
  set findings = excluded.findings, impression = excluded.impression, detail = excluded.detail,
      verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_at = now();
  update service_request set status = case when p_verify then 'verified'::request_status else 'resulted'::request_status end
  where id = p_request_id;
  -- Tell the doctor who ordered it (0088: or the colleague they handed the patient over to).
  v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
  if v_to is not null and v_to is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', case when is_doctor(v_to) then nullif(trim(coalesce(p_impression, '')), '') end,
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_to, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  perform after_desk_tests(v_req.encounter_id, v_station, v_req.requester_id);
end
$$;
-- the call of before 0141
create or replace function record_result(p_request_id uuid, p_findings text, p_impression text, p_verify boolean default true)
returns void
language sql security definer set search_path = public
as $$
  select record_result(p_request_id, p_findings, p_impression, coalesce(p_verify, true), null::jsonb)
$$;
revoke all on function record_result(uuid, text, text, boolean, jsonb), record_result(uuid, text, text, boolean) from public, anon;
grant execute on function record_result(uuid, text, text, boolean, jsonb), record_result(uuid, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------- correct_result (from 20270106090000_doctors_only_records): the doctor it is assigned to
create or replace function correct_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_rep diagnostic_report%rowtype;
  v_test text;
  v_name text;
  v_to uuid;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- the manager, the desk of the test, or the clinical staff of a desk that did it itself;
  -- never the clinician who asked for the test (0104)
  if not (is_manager() or coalesce(v_req.assigned_to = auth.uid(), false) or (may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the result is corrected' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  select * into v_rep from diagnostic_report where service_request_id = p_request_id and deleted_at is null for update;
  if not found or v_rep.verified_at is null then
    raise exception 'only a verified result is corrected; edit the result instead' using errcode = '22023';
  end if;
  insert into report_correction (report_id, old_findings, old_impression, old_verified_by, old_verified_at, reason)
  values (v_rep.id, v_rep.findings, v_rep.impression, v_rep.verified_by, v_rep.verified_at, trim(p_reason));
  perform set_config('mmc.correcting_report', v_rep.id::text, true);
  update diagnostic_report
  set findings = nullif(trim(coalesce(p_findings, '')), ''), impression = nullif(trim(coalesce(p_impression, '')), ''),
      verified_by = auth.uid(), verified_at = now(), corrected_at = now(), correction_reason = trim(p_reason),
      updated_at = now()
  where id = v_rep.id;
  perform set_config('mmc.correcting_report', '', true);
  -- The doctor who ordered the test is told the result changed (0088: or the colleague they
  -- handed the patient over to).
  v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
  if v_to is not null and v_to is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', case when is_doctor(v_to) then nullif(trim(coalesce(p_impression, '')), '') end,
                               'verified', true, 'corrected', true, 'reason', case when is_doctor(v_to) then trim(p_reason) end),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_to, true, auth.uid());
  end if;
end
$$;

-- ---------------------------------------------------------------- set_request_status (from 20261129090000_handover): the doctor it is assigned to
create or replace function set_request_status(p_id uuid, p_status request_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_line uuid;
  v_invoice uuid;
  v_to uuid;
begin
  select * into v_req from service_request where id = p_id;
  -- the lab and imaging (orders.write); an order done at another desk (Nursing, Dental…): the
  -- clinical staff of that desk too
  if not (coalesce(v_req.assigned_to = auth.uid(), false) or (may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('collected', 'in_process', 'cancelled') then
    raise exception 'use record_result for results' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required to cancel a test' using errcode = '22023';
  end if;
  update service_request
  set status = p_status,
      reason = case when p_status = 'cancelled' then coalesce(reason || ' · ', '') || 'cancelled: ' || trim(p_reason) else reason end
  where id = p_id and deleted_at is null and status not in ('verified', 'cancelled');
  if not found then
    raise exception 'test not found or already finished' using errcode = 'P0002';
  end if;
  -- sample taken / analysing: the patient is being seen at that desk
  if p_status in ('collected', 'in_process') then
    update queue_entry q set started_at = coalesce(q.started_at, now()), called_at = coalesce(q.called_at, now()),
                             taken_by = coalesce(q.taken_by, auth.uid())
    where q.encounter_id = v_req.encounter_id and q.finished_at is null and q.deleted_at is null
      and q.station = coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  end if;
  if p_status = 'cancelled' then
    select * into v_req from service_request where id = p_id;
    -- not done, not paid: its charge leaves the bill while the bill is open
    update invoice_line l
    set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: test not done: ' || trim(p_reason)
    from invoice i
    where l.source_type = 'service_request' and l.source_id = p_id and l.deleted_at is null
      and i.id = l.invoice_id and i.status = 'draft'
    returning l.id, l.invoice_id into v_line, v_invoice;
    if v_invoice is not null then
      perform recompute_invoice(v_invoice);
    end if;
    -- the doctor who ordered it is told (0088: or the colleague they handed the patient over to)
    v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
    if v_to is not null and v_to is distinct from auth.uid() then
      select s.name_en into v_test from service s where s.id = v_req.service_id;
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('test_cancelled', jsonb_build_object('test', v_test, 'name', v_name, 'reason', trim(p_reason)),
              '/app/visit?encounter=' || v_req.encounter_id, v_to, auth.uid());
    end if;
    perform after_desk_tests(v_req.encounter_id,
      coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      v_req.requester_id);
  end if;
end
$$;
