-- 0132 · "The nurses" are the employees whose role is Nurse.
--
-- Frank (owner), on the "Which nurse" list of a task: "they give me all this list of nurses while I
-- know they are doctors; I want that the one with the role of nurse be the one to select from."
-- The list (order_nurses, 0127) took every employee allowed at the nursing desk: a doctor placed in
-- a department that gives nursing care, with nursing ticked, was listed as a nurse. Now:
--   * Which nurse (tasks and step-6 orders) lists only active employees whose role is Nurse;
--   * create_task_for / create_nurse_order accept only such a person ("send it to a nurse");
--   * "All the nurses" tells every active employee whose role is Nurse (no longer every doctor or
--     assistant who may use the nursing desk).
-- Who may SEE and do the nurses' work is unchanged (the nursing desk, 0128 department services):
-- untick "nursing" on a doctor's department placement to take them off the nurses' lists.

-- An active, not deleted employee whose role is Nurse.
create or replace function is_nurse_role(p_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles p
                 where p.id = p_id and p.active and p.deleted_at is null and p.role = 'nurse')
$$;

-- order_nurses (from 20270107090000_six_steps): the nurses a task or an order may be sent to by name.
create or replace function order_nurses()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name), '[]'::jsonb)
  from profiles p
  where auth.uid() is not null and has_perm('clinical.write') and is_nurse_role(p.id)
$$;

-- create_task_for (from 20270111090000_nurse_task_for_whom): the nurse named has the role Nurse.
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
  if p_assigned_to is not null and not is_nurse_role(p_assigned_to) then
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

-- create_nurse_order (from 20270107090000_six_steps): the nurse named has the role Nurse; "all the
-- nurses" are told by role.
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
  if p_assigned_to is not null and not is_nurse_role(p_assigned_to) then
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
  if p_assigned_to is not null then
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

-- notify_task (from 20261206090000_notice_targets): "All the nurses" = the employees whose role is Nurse.
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

-- ---------------------------------------------------------------- rights
revoke all on function is_nurse_role(uuid) from public, anon, authenticated;
