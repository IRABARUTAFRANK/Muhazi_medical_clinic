-- 0170: the one who keeps the pharmacy stock, chosen by the manager.
--
-- The clinic has no pharmacist: room stores, and whoever the owner names to record the stock
-- and hand the medicines over. Until now the Pharmacy desk came only from a department giving
-- it. Now the manager marks an employee "keeps the pharmacy stock (acts as the pharmacist)" on
-- the staff form or the profile: profiles.is_pharmacist. desk_via gives that person the
-- Pharmacy desk whatever their role or departments (an explicit "no" on the desk still wins),
-- so they get the pharmacy home blocks and the whole Stock page, every action under their name.
-- 0171: dispense_prescription answers with the bill line's id, so the desk can set how the
-- insurer is charged for the medicine just given (change_charge_cover), chosen at that moment;
-- the one at the Pharmacy desk may do that on a pharmacy line (the cashier and the manager on any).

alter table profiles add column if not exists is_pharmacist boolean not null default false;

create or replace function set_pharmacy_keeper(p_profile uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update profiles set is_pharmacist = coalesce(p_on, false)
  where id = p_profile and deleted_at is null
  returning full_name into v_name;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_profile,
          jsonb_build_object('name', v_name, 'pharmacyKeeper', coalesce(p_on, false)));
end
$$;
revoke all on function set_pharmacy_keeper(uuid, boolean) from public, anon;
grant execute on function set_pharmacy_keeper(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- desk_via (from 20270121090000_doctor_here)
create or replace function desk_via(p_user uuid, p_desk text)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when not desk_key(p_desk) then null
    when ex.allowed = false then null
    -- 0170: marked by the manager as the one who keeps the pharmacy stock: the Pharmacy desk,
    -- whatever the role or the departments
    when p_desk = 'pharmacy' and p.is_pharmacist then 'keeper'
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

-- ---------------------------------------------------------------- staff_directory (from 20270121090000_doctor_here)
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
         p.is_manager,
         -- 0170: keeps the pharmacy stock
         p.is_pharmacist
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;

-- ---------------------------------------------------------------- staff_profile, my_placement (from 20270108090000_profession_manager)
create or replace function staff_profile(p_profile uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := coalesce(p_profile, auth.uid());
  v_mgr boolean := is_manager();
  v_p profiles%rowtype;
  v_h staff_hr%rowtype;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if auth.uid() is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not (v_mgr or v_id = auth.uid()) then
    raise exception 'not allowed: an employee sees only their own profile' using errcode = '42501';
  end if;
  select * into v_p from profiles where id = v_id and deleted_at is null;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform log_staff_profile_access(v_id);
  select * into v_h from staff_hr where profile_id = v_id and deleted_at is null;
  return jsonb_build_object(
    'id', v_p.id, 'fullName', v_p.full_name, 'username', v_p.username, 'staffId', v_p.staff_id,
    'role', v_p.role, 'specialty', v_p.specialty, 'station', v_p.station, 'dashboard', v_p.dashboard,
    'email', v_p.email, 'phone', v_p.phone, 'language', v_p.language,
    'active', v_p.active, 'deactivatedAt', v_p.deactivated_at,
    'createdAt', v_p.created_at, 'createdBy', (select full_name from profiles where id = v_p.created_by),
    'lastSignInAt', v_p.last_sign_in_at, 'mustChangePin', v_p.must_change_pin, 'pinChangedAt', v_p.pin_changed_at,
    'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body,
    -- 0126: a doctor (the role, or marked by the manager): sees patient records
    'isDoctor', v_p.role = 'doctor' or v_p.is_doctor, 'doctorMarked', v_p.is_doctor,
    -- 0128: also the clinic manager
    'isManager', v_p.is_manager,
    -- 0170: keeps the pharmacy stock (the Pharmacy desk follows)
    'isPharmacist', v_p.is_pharmacist,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'position', sd.position,
                                                                  'services', to_jsonb(sd.services), 'gives', to_jsonb(coalesce(d.services, '{}')))
                                              order by (sd.department_id = v_p.department_id) desc, d.name)
                             from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                             where sd.profile_id = v_id), '[]'::jsonb),
    'desks', to_jsonb(desks_of(v_id)),
    'hr', jsonb_build_object(
      'emergencyName', v_h.emergency_name, 'emergencyPhone', v_h.emergency_phone, 'address', v_h.address,
      'birthDate', v_h.birth_date, 'sex', v_h.sex, 'nationalId', v_h.national_id,
      'hiredOn', v_h.hired_on, 'contractType', v_h.contract_type, 'contractEnd', v_h.contract_end,
      'registrationExpiresOn', v_h.registration_expires_on,
      'updatedAt', case when v_h.id is not null then v_h.updated_at end,
      'updatedBy', (select full_name from profiles where id = coalesce(v_h.updated_by, v_h.created_by))),
    'access', jsonb_build_object(
      'permissions', (select coalesce(jsonb_agg(jsonb_build_object(
                          'key', k.p, 'allowed', staff_perm(v_id, k.p),
                          'byRole', exists (select 1 from role_permissions rp
                                            where (rp.role = v_p.role or (v_p.is_manager and rp.role = 'manager'))
                                              and rp.permission = k.p),
                          'exception', sp.profile_id is not null,
                          'setAt', sp.set_at, 'setBy', (select full_name from profiles where id = sp.set_by))
                          order by k.n), '[]'::jsonb)
                      from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
                                        'orders.write', 'appointment.approve', 'stock.write', 'records.approve',
                                        'stock.sell_walkin']) with ordinality as k(p, n)
                      left join staff_permission sp on sp.profile_id = v_id and sp.permission = k.p),
      'trustedDevices', (select count(*)::integer from trusted_device t
                         where t.user_id = v_id and t.revoked_at is null and t.expires_at > now()),
      'signIns', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'ok', a.reason is null or a.reason not like 'wrong PIN%',
                                                               'reason', a.reason) order by a.at desc)
                           from (select at, reason from audit_event
                                 where actor_id = v_id and action = 'login' and at > now() - interval '90 days'
                                 order by at desc limit 15) a), '[]'::jsonb),
      'failedSignIns30', (select count(*)::integer from audit_event
                          where actor_id = v_id and action = 'login' and reason like 'wrong PIN%'
                            and at > now() - interval '30 days')),
    'documents', (select jsonb_build_object(
                    'count', count(*)::integer,
                    'expired', count(*) filter (where d.expires_on < v_today)::integer,
                    'expiring', count(*) filter (where d.expires_on between v_today and v_today + 60)::integer)
                  from staff_document d where d.profile_id = v_id and d.deleted_at is null),
    'notes', case when v_mgr then coalesce((
               select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'body', n.body, 'notedOn', n.noted_on,
                                                   'at', n.created_at, 'by', (select full_name from profiles where id = n.created_by))
                                order by n.noted_on desc, n.created_at desc)
               from staff_note n where n.profile_id = v_id and n.deleted_at is null), '[]'::jsonb) end,
    'removedNotes', case when v_mgr then (select count(*)::integer from staff_note n
                                          where n.profile_id = v_id and n.deleted_at is not null) end,
    'canEdit', v_mgr,
    'self', v_id = auth.uid()
  );
end
$$;

create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'departmentId', d.id,
    'specialty', p.specialty, 'station', p.station, 'isManager', p.is_manager, 'isPharmacist', p.is_pharmacist,
    'registrationNo', p.registration_no, 'registrationBody', p.registration_body,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position,
                                                                 'services', to_jsonb(sd.services))
                                              order by (sd.department_id = p.department_id) desc, dd.name)
                             from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                             where sd.profile_id = p.id), '[]'::jsonb)
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;

-- ---------------------------------------------------------------- dispense_prescription (from 20261217090000_packaging_and_charging)
create or replace function dispense_prescription(
  p_medication_request_id uuid, p_location_id uuid default null, p_quantity integer default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_line uuid;
  v_m medication_request%rowtype;
  v_loc uuid;
  v_dispense uuid;
  v_charged boolean := false;
  v_whole integer;
  v_left integer;
  v_give integer;
  v_charge numeric;
  v_done boolean;
  v_to uuid;
  v_name text;
  v_mode text;
  v_size integer;
  v_most integer;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.supply = 'outside' then
    raise exception 'this medicine is bought at an outside pharmacy: the clinic does not give it' using errcode = '23505';
  end if;
  if v_m.cancelled_at is not null then
    raise exception 'the doctor cancelled this medicine' using errcode = '23505';
  end if;
  v_whole := ceil(v_m.quantity)::integer;
  v_left := v_whole - coalesce(v_m.quantity_given, 0);
  if v_m.given_at is not null or v_left <= 0
     or (coalesce(v_m.quantity_given, 0) = 0 and exists (
           select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null)) then
    raise exception 'already dispensed' using errcode = '23505';
  end if;
  if v_m.not_given_at is not null then
    raise exception 'this medicine was marked as not given' using errcode = '23505';
  end if;
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  -- 0107: a medicine sold only by the whole pack is given in whole packs: the last pack may
  -- take the quantity above what remains (10 prescribed, packs of 8: 16 may be given)
  select i.sale_mode, case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end into v_mode, v_size
  from item i where i.id = v_m.item_id;
  v_most := case when v_mode = 'pack' and v_size is not null then ceil(v_left::numeric / v_size)::integer * v_size
                 else v_left end;
  if p_quantity is not null and p_quantity > v_most then
    raise exception 'only % left to give of this medicine', v_left using errcode = '22023', hint = 'more_than_remaining';
  end if;
  -- The prescription is final once the doctor has finished (or sent the patient on). A sale written
  -- by the pharmacist themself is not held.
  if coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() and doctor_holds(v_m.encounter_id) then
    raise exception 'the doctor is still seeing this patient: hand the medicines over when the doctor has finished'
      using errcode = 'MS002', hint = 'doctor_holds';
  end if;
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                   and active and deleted_at is null) then
      raise exception 'choose an open pharmacy store' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  else
    v_loc := main_pharmacy();
  end if;
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  v_give := coalesce(p_quantity, v_left);
  perform assert_whole_packs(v_m.item_id, v_give);
  v_done := v_give >= v_left;
  v_dispense := dispense_fefo(v_m.encounter_id, v_m.item_id, v_give, v_loc, v_m.id, null);
  -- the bill charges what is given; the last part charges what remains of the prescribed quantity
  -- (whole packs only: what is given, whole packs)
  v_charge := case when v_mode = 'pack' and v_size is not null then v_give
                   when v_done then v_m.quantity - coalesce(v_m.quantity_given, 0) else v_give end;
  -- no price: handed over free (charged = false); no open bill: refused (MS001)
  begin
    v_line := add_charge_internal(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_charge,
                       null, null, null, null, 'medication_dispense', v_dispense);
    v_charged := true;
  exception when sqlstate 'P0002' then
    v_charged := false;
  end;
  update medication_request
  set quantity_given = coalesce(quantity_given, 0) + v_give,
      given_at = case when v_done then now() end,
      given_by = case when v_done then auth.uid() end
  where id = v_m.id;
  -- part given: the prescriber is told what was given and what remains
  if not v_done then
    v_to := coalesce(v_m.prescriber_id, v_m.created_by);
    if v_to is not null and v_to is distinct from auth.uid() then
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('rx_part_given',
              jsonb_build_object('item', item_label(v_m.item_id), 'name', v_name,
                                 'given', coalesce(v_m.quantity_given, 0) + v_give, 'remaining', v_left - v_give,
                                 'quantity', v_whole, 'requestId', v_m.id),
              '/app/visit?encounter=' || v_m.encounter_id, v_to, auth.uid());
    end if;
  end if;
  -- the last line handed over: on to the cashier (money due) or the visit closes
  perform after_pharmacy(v_m.encounter_id);
  perform stock_alert_run();
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged, 'locationId', v_loc,
                            'lineId', v_line,
                            'given', v_give, 'givenTotal', coalesce(v_m.quantity_given, 0) + v_give,
                            'remaining', greatest(v_left - v_give, 0), 'quantity', v_whole);
end
$$;

-- ---------------------------------------------------------------- change_charge_cover (from 20270119090000_insured_patients)
create or replace function change_charge_cover(p_line uuid, p_mode text, p_value numeric default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_line invoice_line%rowtype;
  v_inv invoice%rowtype;
  v_reason text := left(nullif(regexp_replace(trim(coalesce(p_reason, '')), '\s+', ' ', 'g'), ''), 300);
  v_plan uuid;
  v_rule text;
  v_group service_group;
  v_day date;
  v_src text;
  v_ins_price numeric;
  v_cash numeric;
  v_pct numeric;
  v_list numeric;
  v_unit numeric;
  v_total numeric;
  v_disc numeric;
begin
  if p_mode is null or p_mode not in ('insurer', 'not_covered', 'private', 'price', 'coverage') then
    raise exception 'say how the line is charged' using errcode = '22023';
  end if;
  select * into v_line from invoice_line where id = p_line and deleted_at is null for update;
  if not found then
    raise exception 'charge not found' using errcode = 'P0002';
  end if;
  -- 0171: the one at the Pharmacy desk sets how the insurer is charged for a medicine as it is given
  if not (has_perm('charge.override') or is_manager()
          or (v_line.office = 'pharmacy' and may_use_desk('pharmacy'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_inv from invoice where id = v_line.invoice_id;
  if v_inv.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;
  if v_inv.payer_id is null then
    raise exception 'this visit has no insurer' using errcode = '22023';
  end if;
  if p_mode <> 'insurer' and v_reason is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  if p_mode = 'price' and (p_value is null or p_value < 0 or p_value > 9999999999) then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if p_mode = 'coverage' and (p_value is null or p_value < 0 or p_value > 100) then
    raise exception 'the coverage must be between 0 and 100' using errcode = '22023';
  end if;

  select plan_id into v_plan from coverage where id = v_inv.coverage_id;
  select not_listed_rule into v_rule from payer where id = v_inv.payer_id;
  select service_group into v_group from service where id = v_line.service_id;
  v_day := (v_line.created_at at time zone 'Africa/Kigali')::date;
  select ps.price, ps.source into v_ins_price, v_src
  from price_source_for(v_line.service_id, v_line.item_id, v_inv.payer_id, v_day) ps;
  v_disc := coalesce(v_line.discount_pct, 0);

  -- the insurer's rule for the line (as when it was added)
  v_pct := case
    when v_line.price_origin <> 'manual' and v_src = 'excluded' then 0
    when v_rule = 'not_covered' and v_line.price_origin <> 'manual' and v_src = 'cash' then 0
    else coalesce(coverage_pct_for(v_plan, coalesce(v_group, 'pharmacy'::service_group)), 0)
  end;
  -- the insurer's price (a typed price and a whole-pack line keep theirs; a discount stays)
  v_list := v_line.list_price;
  v_unit := v_line.unit_price;
  if v_line.price_origin <> 'manual' and v_line.pack_size is null and v_ins_price is not null then
    v_list := v_ins_price;
    v_unit := round(v_ins_price * (100 - v_disc) / 100);
  end if;

  if p_mode = 'not_covered' then
    v_pct := 0;
  elsif p_mode = 'private' then
    -- as a private patient: the clinic's price, the patient pays it all
    v_pct := 0;
    if v_line.price_origin <> 'manual' and v_line.pack_size is null then
      select pf.price into v_cash from price_for(v_line.service_id, v_line.item_id, null, v_day) pf;
      if v_cash is not null then
        v_list := v_cash;
        v_unit := round(v_cash * (100 - v_disc) / 100);
      end if;
    end if;
  elsif p_mode = 'price' then
    v_unit := round(p_value);
  elsif p_mode = 'coverage' then
    v_pct := p_value;
  end if;

  v_total := round(v_unit * v_line.quantity);
  update invoice_line
  set list_price = v_list, unit_price = v_unit, coverage_pct = v_pct,
      insurer_share = round(v_total * v_pct / 100),
      patient_share = v_total - round(v_total * v_pct / 100),
      cover_mode = nullif(p_mode, 'insurer'),
      cover_reason = case when p_mode = 'insurer' then null else v_reason end,
      cover_by = case when p_mode = 'insurer' then null else auth.uid() end,
      cover_at = case when p_mode = 'insurer' then null else now() end
  where id = p_line;
  perform recompute_invoice(v_inv.id);
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'invoice_line', p_line,
          jsonb_build_object('mode', coalesce(v_line.cover_mode, 'insurer'), 'unitPrice', v_line.unit_price,
                             'coverage', v_line.coverage_pct),
          jsonb_build_object('mode', p_mode, 'unitPrice', v_unit, 'coverage', v_pct, 'reason', v_reason));
  return jsonb_build_object('mode', p_mode, 'unitPrice', v_unit, 'coverage', v_pct,
                            'insurerShare', round(v_total * v_pct / 100),
                            'patientShare', v_total - round(v_total * v_pct / 100));
end
$$;
