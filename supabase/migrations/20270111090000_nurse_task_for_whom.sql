-- 0131 · A task for the nurse goes to all the nurses or to one nurse by name.
--
-- Frank (owner): "On the side where we task the nurse or ask the nurse to do something, when we
-- send that task we must be able to see the part where we choose either everyone with the role
-- nurse or a specific nurse."
--
-- The step-6 orders (0127 create_nurse_order) already had "For whom"; the "Task for the nurse"
-- card (create_task) always went to every nurse. create_task_for takes the nurse:
--   * no nurse named: as before, assigned_role 'nurse' (every nurse, or whoever works at the
--     nursing desk when a department gives nursing care), all of them told;
--   * a nurse named: assigned_to = that nurse and assigned_role null, so the lists, counts and
--     "may work on this patient" rules (assigned_to = me or task_for_me(role)) show it to that
--     nurse only (and the manager); notify_task tells that nurse only.
-- The nurse named must be one the order form offers (order_nurses: a nurse, or someone working
-- at the nursing desk; never the manager).
-- visit_tasks and open_tasks also say whom the task is for ('forName', null = all the nurses).
-- A new name, not a new create_task argument: older steps call create_task with five arguments.

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
  if p_assigned_to is not null and not exists (
       select 1 from profiles p where p.id = p_assigned_to and p.active and p.deleted_at is null
         and p.role <> 'manager'
         and (p.role = 'nurse' or desk_via(p.id, 'nursing') is not null)) then
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

-- visit_tasks (from 20261030120000_cashier_tests_tasks / 0063): + whom the task is for.
create or replace function visit_tasks(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name,
      'mine', k.created_by = auth.uid(),
      'forName', fo.full_name,
      'forMe', k.assigned_to = auth.uid()
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  left join profiles pr on pr.id = k.created_by
  left join profiles fo on fo.id = k.assigned_to
  where k.encounter_id = p_encounter_id and k.deleted_at is null and k.done_at is null
    and (has_perm('clinical.read') or has_perm('vitals.write'))
$$;

-- open_tasks (from 20261104090000_desks_last_items): + whom the task is for.
create or replace function open_tasks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name,
      'forName', fo.full_name,
      'forMe', k.assigned_to = auth.uid()
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  -- a finished visit's task is over too
  left join encounter e on e.id = k.encounter_id
  left join profiles pr on pr.id = k.created_by
  left join profiles fo on fo.id = k.assigned_to
  where k.deleted_at is null and k.done_at is null and (k.encounter_id is null or e.status = 'open')
    and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role) or is_manager())
$$;

-- ---------------------------------------------------------------- rights
revoke all on function create_task_for(uuid, text, timestamptz, text, uuid) from public, anon;
grant execute on function create_task_for(uuid, text, timestamptz, text, uuid) to authenticated;
