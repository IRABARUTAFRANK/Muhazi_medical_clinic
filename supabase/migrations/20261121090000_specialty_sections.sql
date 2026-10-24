-- 0080 · The specialty adds where a doctor works, when nothing else says it.
--
-- Frank: the role is just "Doctor"; what the doctor is expert in goes in "Specialty or title"
-- (Dentist, Surgeon, General practitioner …), and the departments decide the services and the
-- patients that reach them.
--
-- Who works in a section stays as in 0071: the services of the person's calendar and departments,
-- whatever their role. Only the fallback changes (a doctor with no service set, or a section
-- nobody is set for yet): the usual desk of a doctor still follows the desk name (station), as
-- before, and the specialty adds its section:
--   * the desk name, as in 0071: "Dental …" → Dental, "Theatre …" → Minor surgery and
--     Circumcision, "Ultrasound …" → Ultrasound, any other desk (or none) → Consultation;
--   * the specialty adds: dentist / dental → Dental; surgeon, anaesthetist, circumcision → Minor
--     surgery and Circumcision; sonographer, radiologist, ultrasound → Ultrasound; general
--     practitioner and the other medical specialties (paediatrician, gynaecologist, internal
--     medicine, eyes, ENT …) → Consultation.
-- The specialty only adds, it never takes a section away: the app still opens a doctor's queue at
-- the desk the desk name says (Consultation when it names none), and that doctor must be able to
-- take those patients. So a dentist with no department and no desk name takes Consultation and
-- Dental patients; at the desk "Dental 1" Dental only. A department with services decides
-- instead, whatever the specialty. Other roles keep their usual desk.

-- ---------------------------------------------------------------- the usual desk, with the specialty
create or replace function role_serves(p_role role_key, p_station text, p_service text, p_specialty text)
returns boolean
language sql immutable
as $$
  select case p_role
    when 'doctor' then
      -- the desk name, as in 0071
      (p_service = 'dental' and x.desk ~ 'dent')
      or (p_service in ('surgery', 'circ') and x.desk ~ '(theat|surg|circ)')
      or (p_service = 'ultrasound' and x.desk ~ '(ultra|echo)')
      or (p_service = 'consultation' and x.desk !~ '(dent|theat|surg|ultra|echo)')
      -- the specialty adds its section
      or coalesce(p_service = x.section, false)
      or (coalesce(x.section, '') = 'surgery' and p_service = 'circ')
    when 'sonographer' then p_service = 'ultrasound'
    when 'nurse' then p_service in ('nursing', 'fp', 'hiv', 'triage')
    when 'lab_tech' then p_service = 'laboratory'
    when 'pharmacist' then p_service = 'pharmacy'
    else false
  end
  from (
    select case
      when s ~ '(\mdent|amenyo|orthodon|stomato)' then 'dental'
      when s ~ '(ultra|\m[ée]cho|sonog|radiol|imaging|imagerie|mucyuma)' then 'ultrasound'
      when s ~ '(surg|chirurg|kubaga|theat|th[ée][aâ]tre|\mcirc|gusiramura|anaesth|anesth)' then 'surgery'
      when s ~ ('(g[ée]n[ée]ral|\mgp\M|family|famille|physician|m[ée]decin|internal|interne|'
                || 'paediat|p[ée]diat|gyn|obst|ophtal|ophthal|\ment\M|\morl\M|cardio|derma|'
                || 'neuro|psychiat|urolog|gastro|pneumo|endocrin|rheumat|rhumat|muganga)') then 'consultation'
    end as section, t.desk
    from (select lower(trim(coalesce(p_specialty, ''))) as s, lower(coalesce(p_station, '')) as desk) t
  ) x
$$;

-- Without a specialty (the rule of 0071, kept for anything that still calls it).
create or replace function role_serves(p_role role_key, p_station text, p_service text)
returns boolean
language sql immutable
as $$
  select role_serves(p_role, p_station, p_service, null::text)
$$;
-- a pure rule, closed to visitors like the other functions (staff_serves calls it as its owner)
revoke all on function role_serves(role_key, text, text, text) from public, anon;
grant execute on function role_serves(role_key, text, text, text) to authenticated;

-- ---------------------------------------------------------------- who works in a section
-- As in 0071; the role's usual desk now also reads the specialty.
create or replace function staff_serves(p_user uuid, p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    cross join lateral (select staff_services(p.id) as mine) s
    where p.id = p_user and p.active
      and p.role in ('doctor', 'nurse', 'sonographer', 'lab_tech', 'pharmacist')
      and (
        -- the section the person is set in, whatever their role
        p_service = any (s.mine)
        -- nothing set for the person, or nobody set for this section: the role's usual desk
        or ((cardinality(s.mine) = 0 or not service_has_staff(p_service))
            and role_serves(p.role, p.station, p_service, p.specialty))
      )
  )
$$;
revoke all on function staff_serves(uuid, text) from public, anon;
grant execute on function staff_serves(uuid, text) to authenticated;
