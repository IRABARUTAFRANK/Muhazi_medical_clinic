-- 0129 · A new service of a department is ticked by the manager, person by person.
--
-- Frank (owner): when a department starts giving another service, he chooses who in it does that
-- service; nobody gets it by default. 0128 ticked it for every member of the department; now the
-- department only offers it, and the Employees form's "Does here" ticks decide who works there.

create or replace function upsert_department(
  p_id uuid,
  p_name text,
  p_description text,
  p_roles role_key[],
  p_services text[] default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_before text[];
  v_bad text;
  v_new text[];
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  -- the services of 0071, and reception (0085)
  select s into v_bad from unnest(coalesce(p_services, '{}')) s where not desk_key(s) limit 1;
  if v_bad is not null then
    raise exception 'unknown service %', v_bad using errcode = '22023';
  end if;
  -- the desks no department gives yet: once this one does, only departments decide them
  select array_agg(s) into v_new from unnest(coalesce(p_services, '{}')) s where not desk_offered(s);
  if v_id is null then
    insert into department (name, description, roles, services)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_roles, '{}'),
            coalesce(p_services, '{}'))
    returning id into v_id;
  else
    select services into v_before from department where id = v_id and deleted_at is null;
    update department set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
                          roles = coalesce(p_roles, '{}'), services = coalesce(p_services, services)
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002';
    end if;
    -- 0129: a service the department starts giving is NOT ticked for anyone: the manager ticks
    -- it, person by person, on the Employees form (Does here)
    -- Heads follow the department's name on their dashboard.
    update profiles set head_of = trim(p_name)
    where id in (select profile_id from staff_department where department_id = v_id and position = 'head');
  end if;
  -- a desk now given for the first time: the people who work there as usual are placed in it when
  -- nothing else changes for them; the manager is told who lost it (F)
  if exists (select 1 from unnest(coalesce(v_new, '{}')) s where desk_offered(s)) then
    perform place_staff_for_desks(false, v_new);
  end if;
  return v_id;
end
$$;
