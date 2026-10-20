-- 0037 · Doctors' own calendars (and who may see them) and treatments by department.
--
-- Calendars: each doctor (or sonographer) keeps one calendar, linked to their account: the
-- working hours of each weekday, the length of a booking slot, days off, a short note, and who
-- may see it: only themselves ('private'), the staff ('staff'), or the staff and the public
-- ('public'). The public site lists only public calendars of real, active accounts; the staff
-- home pages list staff and public ones. The manager may keep any doctor's calendar.
--
-- Departments: every treatment may belong to one department, so the manager adds the
-- services of each department with their price and follows what each department bills.

-- ---------------------------------------------------------------- calendars
alter table practitioner add column if not exists calendar_visibility text not null default 'public'
  check (calendar_visibility in ('private', 'staff', 'public'));
alter table practitioner add column if not exists days_off date[] not null default '{}';
alter table practitioner add column if not exists calendar_note text;
alter table practitioner add column if not exists department_id uuid references department (id);
create unique index if not exists practitioner_user_uq on practitioner (user_id)
  where user_id is not null and deleted_at is null;

-- Public calendars of real, active accounts only (sample practitioners stay off the site).
create or replace view public_practitioners as
  select pr.id, pr.code, pr.names, pr.title, pr.specialty, pr.categories, pr.languages,
         pr.working_hours, pr.slot_minutes, pr.days_off, pr.calendar_note
  from practitioner pr
  where pr.active and pr.deleted_at is null and pr.calendar_visibility = 'public'
    and pr.user_id is not null
    and exists (select 1 from profiles p where p.id = pr.user_id and p.active);
grant select on public_practitioners to anon, authenticated;

-- Working at this moment: the weekday's hours, unless that date is a day off.
create or replace function practitioner_is_working(p_practitioner_id uuid, p_at timestamptz)
returns boolean
language plpgsql stable
as $$
declare
  v_hours jsonb;
  v_off date[];
  v_day text;
  v_span jsonb;
  v_time time;
begin
  select working_hours, days_off into v_hours, v_off
  from practitioner where id = p_practitioner_id and active and deleted_at is null;
  if v_hours is null then
    return false;
  end if;
  if (p_at at time zone 'Africa/Kigali')::date = any (coalesce(v_off, '{}')) then
    return false;
  end if;
  v_day := extract(dow from p_at at time zone 'Africa/Kigali')::int::text;
  v_time := (p_at at time zone 'Africa/Kigali')::time;
  for v_span in select * from jsonb_array_elements(coalesce(v_hours -> v_day, '[]'::jsonb)) loop
    if v_time >= (v_span ->> 0)::time and v_time < (v_span ->> 1)::time then
      return true;
    end if;
  end loop;
  return false;
end
$$;

create or replace function calendar_json(pr practitioner)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', pr.id, 'userId', pr.user_id, 'code', pr.code, 'name', pr.names, 'title', pr.title,
    'specialty', pr.specialty, 'categories', to_jsonb(pr.categories), 'languages', pr.languages,
    'hours', pr.working_hours, 'slotMinutes', pr.slot_minutes, 'daysOff', to_jsonb(pr.days_off),
    'note', pr.calendar_note, 'visibility', pr.calendar_visibility,
    'department', (select d.name from department d
                   where d.deleted_at is null
                     and d.id = coalesce(pr.department_id, (select p.department_id from profiles p where p.id = pr.user_id))),
    'mine', pr.user_id = auth.uid(),
    'workingNow', practitioner_is_working(pr.id, now())
  )
$$;

-- Staff home pages: the calendars shared with the staff (or the public), plus one's own.
create or replace function staff_doctor_calendars()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(calendar_json(pr) order by pr.names), '[]'::jsonb)
  from practitioner pr
  join profiles p on p.id = pr.user_id and p.active
  where auth.uid() is not null and pr.active and pr.deleted_at is null
    and (pr.calendar_visibility in ('staff', 'public') or pr.user_id = auth.uid())
$$;

-- Who may keep a calendar: doctors and sonographers.
create or replace function calendar_role_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p_user and active and role in ('doctor', 'sonographer'))
$$;

-- The calendar of a person (default: me). Empty skeleton when none is saved yet.
create or replace function my_calendar(p_user uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_pr practitioner%rowtype;
  v_name text;
begin
  if auth.uid() is null or (v_user <> auth.uid() and not is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_pr from practitioner where user_id = v_user and deleted_at is null limit 1;
  if found then
    return calendar_json(v_pr) || jsonb_build_object('saved', true, 'canKeep', calendar_role_ok(v_user));
  end if;
  select full_name into v_name from profiles where id = v_user;
  return jsonb_build_object(
    'id', null, 'userId', v_user, 'name', v_name, 'title', null, 'categories', '[]'::jsonb,
    'languages', null, 'hours', '{}'::jsonb, 'slotMinutes', 30, 'daysOff', '[]'::jsonb,
    'note', null, 'visibility', 'staff', 'mine', v_user = auth.uid(), 'saved', false,
    'canKeep', calendar_role_ok(v_user)
  );
end
$$;

-- Manager: the doctors and sonographers who may have a calendar, with whether one is saved.
create or replace function calendar_people()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
    'visibility', pr.calendar_visibility, 'saved', pr.id is not null
  ) order by p.full_name), '[]'::jsonb)
  from profiles p
  left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
  where is_manager() and p.active and p.role in ('doctor', 'sonographer')
$$;

create or replace function save_calendar(
  p_user uuid,
  p_hours jsonb,
  p_slot_minutes integer,
  p_visibility text,
  p_days_off date[] default '{}',
  p_note text default null,
  p_title text default null,
  p_categories text[] default '{}',
  p_languages text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_id uuid;
  v_name text;
  v_staff text;
  v_key text;
  v_span jsonb;
  v_hours jsonb := coalesce(p_hours, '{}'::jsonb);
begin
  if auth.uid() is null or (v_user <> auth.uid() and not is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not calendar_role_ok(v_user) then
    raise exception 'only doctors and sonographers keep a calendar' using errcode = '22023';
  end if;
  if coalesce(p_visibility, '') not in ('private', 'staff', 'public') then
    raise exception 'choose who may see the calendar' using errcode = '22023';
  end if;
  if p_slot_minutes is null or p_slot_minutes not between 5 and 240 then
    raise exception 'the booking slot must be between 5 and 240 minutes' using errcode = '22023';
  end if;
  if jsonb_typeof(v_hours) <> 'object' then
    raise exception 'working hours are not valid' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_hours) loop
    if v_key not in ('0', '1', '2', '3', '4', '5', '6') or jsonb_typeof(v_hours -> v_key) <> 'array' then
      raise exception 'working hours are not valid' using errcode = '22023';
    end if;
    for v_span in select * from jsonb_array_elements(v_hours -> v_key) loop
      if (v_span ->> 0) !~ '^[0-2][0-9]:[0-5][0-9]$' or (v_span ->> 1) !~ '^[0-2][0-9]:[0-5][0-9]$'
         or (v_span ->> 0)::time >= (v_span ->> 1)::time then
        raise exception 'each working period must start before it ends' using errcode = '22023';
      end if;
    end loop;
  end loop;

  select full_name, staff_id into v_name, v_staff from profiles where id = v_user;
  select id into v_id from practitioner where user_id = v_user and deleted_at is null limit 1;
  if v_id is null then
    insert into practitioner (code, user_id, names, title, slot_minutes, working_hours, categories,
                              languages, calendar_visibility, days_off, calendar_note, active)
    values (lower(coalesce(v_staff, 'dr-' || left(v_user::text, 8))), v_user, v_name,
            nullif(trim(coalesce(p_title, '')), ''), p_slot_minutes, v_hours, coalesce(p_categories, '{}'),
            nullif(trim(coalesce(p_languages, '')), ''), p_visibility, coalesce(p_days_off, '{}'),
            nullif(trim(coalesce(p_note, '')), ''), true)
    returning id into v_id;
  else
    update practitioner
    set names = coalesce(v_name, names), title = nullif(trim(coalesce(p_title, '')), ''),
        slot_minutes = p_slot_minutes, working_hours = v_hours, categories = coalesce(p_categories, '{}'),
        languages = nullif(trim(coalesce(p_languages, '')), ''), calendar_visibility = p_visibility,
        days_off = coalesce(p_days_off, '{}'), calendar_note = nullif(trim(coalesce(p_note, '')), ''),
        active = true
    where id = v_id;
  end if;
  return v_id;
end
$$;

revoke all on function calendar_json(practitioner), staff_doctor_calendars(), calendar_role_ok(uuid),
  my_calendar(uuid), calendar_people(),
  save_calendar(uuid, jsonb, integer, text, date[], text, text, text[], text) from public, anon;
grant execute on function staff_doctor_calendars(), my_calendar(uuid), calendar_people(),
  save_calendar(uuid, jsonb, integer, text, date[], text, text, text[], text) to authenticated;

-- ---------------------------------------------------------------- treatments by department
alter table service add column if not exists department_id uuid references department (id);
create index if not exists service_department_idx on service (department_id) where deleted_at is null;

create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

create or replace function set_service_department(p_service_id uuid, p_department_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null
     and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = p_department_id where id = p_service_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
end
$$;

-- What each treatment was billed between two days (count and amount), for the department view.
create or replace function service_billing(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_object_agg(x.service_id::text, jsonb_build_object('count', x.n, 'amount', x.amount)), '{}'::jsonb)
  from (
    select l.service_id, count(*)::integer as n, sum(round(l.quantity * l.unit_price))::numeric as amount
    from invoice_line l
    join invoice i on i.id = l.invoice_id and i.status <> 'credited'
    where has_perm('catalogue.write') and l.deleted_at is null and l.service_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.service_id
  ) x
$$;

revoke all on function set_service_department(uuid, uuid), service_billing(date, date) from public, anon;
grant execute on function set_service_department(uuid, uuid), service_billing(date, date) to authenticated;
