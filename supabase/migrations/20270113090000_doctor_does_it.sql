-- 0133 · The doctor may do himself what he gives to the nurses.
--
-- Frank (owner): "Sometimes doctors do what they task the nurse … when the doctor is to do them by
-- himself he does it then, or if he tasks the nurse she does it like that."
--   * "For whom" has a third choice, Me (I do it myself): the task or the order is the doctor's own
--     (assigned_to = him); nobody is told; he ticks it Done / gives each time on the visit.
--   * An order or a task sent to the nurses may still be done by the doctor who gave it (the nurse
--     is busy): he records it given himself, like the nurse (each time given, billed the same way).
--   * A drug he gives himself comes from his own room store when he holds one with the medicine,
--     else from the nurses' room store (type nursing) that has it; the stock movement carries his
--     name. A nurse gives from her stores as before.
-- complete_task already let the giver tick his task; nurse_order_for_work now lets him too.

-- create_task_for (from 0132): the doctor may name himself.
create or replace function create_task_for(
  p_encounter_id uuid,
  p_title text,
  p_due_at timestamptz default null,
  p_detail text default null,
  p_assigned_to uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_patient uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_assigned_to is not null and p_assigned_to <> auth.uid() and not is_nurse_role(p_assigned_to) then
    raise exception 'send it to a nurse, or to all the nurses' using errcode = '22023', hint = 'not_nurse';
  end if;
  insert into internal_task (encounter_id, patient_id, assigned_role, assigned_to, due_at, title, detail)
  values (p_encounter_id, v_patient,
          case when p_assigned_to is null then 'nurse'::role_key end,
          p_assigned_to, p_due_at, trim(p_title), nullif(trim(coalesce(p_detail, '')), ''))
  returning id into v_id;
  return v_id;
end
$$;

-- create_nurse_order (from 0132): the doctor may name himself; then nobody is told.
create or replace function create_nurse_order(
  p_encounter_id uuid, p_kind text, p_text text default null, p_service_id uuid default null,
  p_item_id uuid default null, p_quantity numeric default 1, p_dose text default null,
  p_route text default null, p_frequency text default null, p_doses integer default 1,
  p_assigned_to uuid default null, p_notes text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_text text := nullif(trim(coalesce(p_text, '')), '');
  v_id uuid;
  v_params jsonb;
  v_link text;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_doctor() then
    raise exception 'not allowed: the doctor gives the orders to the nurses' using errcode = '42501', hint = 'not_doctor';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found or v_e.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if coalesce(p_kind, '') not in ('act', 'drug') then
    raise exception 'say whether it is a medical act or a drug to give' using errcode = '22023';
  end if;
  if p_doses is null or p_doses < 1 or p_doses > 60 then
    raise exception 'the number of times is between 1 and 60' using errcode = '22023';
  end if;
  if coalesce(p_quantity, 1) <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_kind = 'drug' then
    if p_item_id is null or not exists (select 1 from item i where i.id = p_item_id and i.active and i.deleted_at is null) then
      raise exception 'choose the medicine from the stock' using errcode = '22023', hint = 'item_needed';
    end if;
    v_text := coalesce(v_text, item_label(p_item_id));
  else
    if p_service_id is not null
       and not exists (select 1 from service s where s.id = p_service_id and s.active and s.deleted_at is null) then
      raise exception 'unknown service' using errcode = '22023';
    end if;
    v_text := coalesce(v_text, (select s.name_en from service s where s.id = p_service_id));
  end if;
  if length(coalesce(v_text, '')) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  if p_assigned_to is not null and p_assigned_to <> auth.uid() and not is_nurse_role(p_assigned_to) then
    raise exception 'send it to a nurse, or to all the nurses' using errcode = '22023', hint = 'not_nurse';
  end if;
  insert into nurse_order (encounter_id, patient_id, kind, text, service_id, item_id, quantity, dose, route,
                           frequency, doses_planned, assigned_to, notes)
  values (p_encounter_id, v_e.patient_id, p_kind, v_text,
          case when p_kind = 'act' then p_service_id end, case when p_kind = 'drug' then p_item_id end,
          coalesce(p_quantity, 1), nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_doses, p_assigned_to, nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  -- the nurses are told: the one named, else every employee whose role is Nurse (0132)
  v_link := '/app/visit?encounter=' || p_encounter_id;
  v_params := jsonb_build_object('orderId', v_id, 'kind', p_kind, 'title', v_text, 'times', p_doses,
                                 'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_e.patient_id),
                                 'by', (select full_name from profiles where id = auth.uid()));
  if p_assigned_to = auth.uid() then
    null; -- "Me, I do it myself": nobody to tell (0133)
  elsif p_assigned_to is not null then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('nurse_order', v_params, v_link, p_assigned_to, auth.uid());
  else
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'nurse_order', v_params, v_link, p.id, auth.uid()
    from profiles p
    where p.id <> auth.uid() and is_nurse_role(p.id);
  end if;
  return nurse_order_json(v_id);
end
$$;

-- notify_task (from 0132): no notice for a task the doctor keeps for himself.
create or replace function notify_task()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_link text := case when new.encounter_id is not null then '/app/visit?encounter=' || new.encounter_id
                      else '/app?focus=task:' || new.id end;
  v_params jsonb;
begin
  -- "Me, I do it myself" (0133): nobody to tell
  if new.assigned_to is not null and new.assigned_to = auth.uid() then
    return new;
  end if;
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = new.patient_id;
  v_params := jsonb_build_object('title', new.title, 'name', v_name, 'due', new.due_at, 'task', new.id);
  if new.assigned_to is null and new.assigned_role = 'nurse' then
    -- "All the nurses": every employee whose role is Nurse (0132)
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'task', v_params, v_link, p.id, auth.uid()
    from profiles p
    where is_nurse_role(p.id);
  else
    insert into notification (kind, params, link, recipient_role, recipient_user, created_by)
    values ('task', v_params, v_link,
            case when new.assigned_to is null then new.assigned_role end,
            new.assigned_to,
            auth.uid());
  end if;
  return new;
end
$$;

-- nurse_order_for_work (from 20270107090000_six_steps): + the doctor who gave the order.
create or replace function nurse_order_for_work(p_id uuid)
returns nurse_order
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_o from nurse_order where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  -- the nurse it is for, the doctor who gave it (he does it himself, 0133), or the manager
  if not (nurse_order_mine(v_o.assigned_to) or v_o.created_by = auth.uid() or is_manager()) then
    raise exception 'not allowed: this order is for another nurse' using errcode = '42501', hint = 'not_yours';
  end if;
  if v_o.status <> 'open' then
    raise exception 'this order is already over' using errcode = '22023', hint = 'order_over';
  end if;
  if not exists (select 1 from encounter e where e.id = v_o.encounter_id and e.status = 'open' and e.deleted_at is null) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  return v_o;
end
$$;

-- give_nurse_order (from 20270107090000_six_steps): the doctor giving his own order gives from his
-- room store, else the nurses' room store.
create or replace function give_nurse_order(
  p_order_id uuid, p_note text default null, p_at timestamptz default null, p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_at timestamptz := coalesce(p_at, now());
  v_n integer;
  v_qty integer;
  v_loc uuid;
  v_charged boolean := false;
begin
  v_o := nurse_order_for_work(p_order_id);
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '24 hours' then
    raise exception 'the time given is not possible' using errcode = '22023', hint = 'bad_time';
  end if;
  v_n := (select count(*) from nurse_order_dose where order_id = v_o.id and deleted_at is null) + 1;
  if v_o.kind = 'drug' then
    v_qty := ceil(v_o.quantity)::integer;
    if v_o.created_by = auth.uid() and p_location_id is null and not is_nurse_role(auth.uid()) then
      -- the doctor gives his own order himself (0133): his own room store when he holds one with
      -- the medicine, else the nurses' room store that has it
      begin
        v_loc := room_store_for(auth.uid(), v_o.item_id, v_qty, null, 'nursing');
      exception when sqlstate '42501' then
        v_loc := null;
      end;
      if v_loc is null then
        select l.id into v_loc
        from stock_location l
        where l.deleted_at is null and l.active and l.type = 'nursing'
          and usable_stock(v_o.item_id, l.id) >= v_qty
        order by l.created_at
        limit 1;
      end if;
    else
      v_loc := room_store_for(auth.uid(), v_o.item_id, v_qty, p_location_id, 'nursing');
    end if;
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in the store you give from'
        using errcode = 'MS003', hint = 'room_short';
    end if;
    perform give_from_store(v_o.item_id, v_loc, v_qty, null, 'nurse order: given');
    update stock_movement set nurse_order_id = v_o.id
    where medication_request_id is null and nurse_order_id is null and item_id = v_o.item_id
      and from_location_id = v_loc and type = 'consumption' and created_at = now();
    begin
      perform add_charge_internal(v_o.encounter_id, 'nursing', null, v_o.item_id, v_o.quantity,
                                  null, null, auth.uid(), null, 'nurse_order', v_o.id);
      v_charged := true;
    exception when sqlstate 'P0002' or sqlstate 'MS001' then
      v_charged := false;
    end;
  elsif v_o.service_id is not null then
    begin
      perform add_charge_internal(v_o.encounter_id, 'nursing', v_o.service_id, null, v_o.quantity,
                                  null, null, auth.uid(), null, 'nurse_order', v_o.id);
      v_charged := true;
    exception when sqlstate 'P0002' or sqlstate 'MS001' then
      v_charged := false;
    end;
  end if;
  insert into nurse_order_dose (order_id, n, given, at, by_id, note, location_id, charged)
  values (v_o.id, v_n, true, v_at, auth.uid(), nullif(trim(coalesce(p_note, '')), ''), v_loc, v_charged);
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id) || jsonb_build_object('charged', v_charged);
end
$$;
