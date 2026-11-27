-- 0206 · A bed stay reaching its expected days: the people in charge are asked (Frank, 2026-11-27:
-- "when the expected time that we set that he will last in the bed approaches, when it's near to
-- end the system must give a notification asking the one in charge, the nurse and the doctors, if
-- they extend the patient's stay or if they say goodbye to him").
--
-- A stay given with its days expected (keep_in_bed / set_bed_days, 0197) is billed one bed day per
-- calendar day. On its LAST expected day the doctor in charge and the nurses get one notice: extend
-- the stay, or end it before the next day goes on the bill. Each day past the expected days, one
-- more notice. The days changed (extended): the new last day is told again. The days count from the
-- visit's first day in a bed (a move to another bed starts a new stay that keeps the days expected,
-- 0197), so a move neither restarts the count nor repeats a notice. The database has no clock:
-- bed_stay_alerts() is run by the screens (as bed_days_catch_up), at most every few minutes, and
-- each notice is written once per visit (bed_stay_told).

create table if not exists bed_stay_told (
  encounter_id uuid not null references encounter (id),
  stay_id uuid not null references bed_stay (id),
  kind text not null check (kind in ('last', 'over')),
  for_day date not null,
  told_at timestamptz not null default now(),
  primary key (encounter_id, kind, for_day)
);
alter table bed_stay_told enable row level security;
revoke all on bed_stay_told from anon, authenticated;
comment on table bed_stay_told is
  'The notices of a bed stay reaching its expected days, each written once (0206).';

-- The people in charge of a stay: who gave the bed, the visit's doctor, the clinicians who took the
-- patient at a doctor's desk, and every nurse (as for the other bed notices). Active people only.
create or replace function bed_stay_in_charge(p_stay_id uuid)
returns table (id uuid)
language sql stable security definer set search_path = public
as $$
  select distinct p.id
  from (
    select s.given_by as id from bed_stay s where s.id = p_stay_id
    union
    select pr.user_id from bed_stay s
    join encounter e on e.id = s.encounter_id
    join practitioner pr on pr.id = e.practitioner_id
    where s.id = p_stay_id
    union
    select q.taken_by from bed_stay s
    join queue_entry q on q.encounter_id = s.encounter_id and q.deleted_at is null and q.taken_by is not null
                       and q.station in ('consultation', 'dental', 'physio', 'theatre')
    where s.id = p_stay_id
    union
    select pf.id from profiles pf where is_nurse_role(pf.id)
  ) x
  join profiles p on p.id = x.id and p.active
  where x.id is not null
$$;

-- The stays on their last expected day, or past it, told once each (the last day once; each day
-- past once). Answers how many notices were written.
create or replace function bed_stay_alerts()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_today date := kigali_day(now());
  v_n integer := 0;
  v_rows integer;
  r record;
  v_kind text;
  v_for date;
begin
  if auth.uid() is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for r in
    select s.id, s.encounter_id, s.expected_days, f.first_day,
           f.first_day + s.expected_days - 1 as last_day,
           (select b.name from bed b where b.id = s.bed_id) as bed,
           (select p.surname || ' ' || p.given_names from patient p where p.id = e.patient_id) as name
    from bed_stay s
    join encounter e on e.id = s.encounter_id and e.status = 'open' and e.deleted_at is null
    cross join lateral (
      select min(kigali_day(o.admitted_at)) as first_day from bed_stay o
      where o.encounter_id = s.encounter_id and o.by_day and o.deleted_at is null
    ) f
    where s.by_day and s.discharged_at is null and s.deleted_at is null and s.expected_days is not null
  loop
    if v_today = r.last_day then
      v_kind := 'last';
      v_for := r.last_day;
    elsif v_today > r.last_day then
      v_kind := 'over';
      v_for := v_today;
    else
      continue;
    end if;
    insert into bed_stay_told (encounter_id, stay_id, kind, for_day)
    values (r.encounter_id, r.id, v_kind, v_for) on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      continue;
    end if;
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'bed_stay_ending',
           jsonb_build_object('what', v_kind, 'stayId', r.id, 'encounterId', r.encounter_id, 'bed', r.bed,
                              'name', r.name, 'days', r.expected_days, 'since', r.first_day,
                              'lastDay', r.last_day, 'over', greatest(0, v_today - r.last_day)),
           '/app/visit?encounter=' || r.encounter_id, x.id, null
    from bed_stay_in_charge(r.id) x;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

revoke all on function bed_stay_in_charge(uuid) from public, anon, authenticated;
revoke all on function bed_stay_alerts() from public, anon;
grant execute on function bed_stay_alerts() to authenticated;
