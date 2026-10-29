-- 0113 · The lab worklist's "Done" tab follows the period chosen (Today · This week · This month ·
-- All time · Custom), as every other list of results; before, it gave today's only.
--
-- lab_worklist(p_scope, p_from, p_to): 'open' as before (the days are not read); 'done' gives the
-- results given (verified, or written) between p_from and p_to, both days included, Kigali time.
-- Without days: today, as before (lab_worklist('done') keeps working).
--
-- The rows, rights and order are those of 20261203090000_guide_fixes. The old one-argument
-- function is dropped so that a call with one argument has a single match.

drop function if exists lab_worklist(text);

create or replace function lab_worklist(p_scope text default 'open', p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'corrected', d.corrected_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category in (select unnest(my_test_categories())) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      -- HIV tests: the people allowed to see them, and the desk that runs them (the laboratory and
      -- ultrasound staff do their work whatever their rights)
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(s.id))
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     between coalesce(p_from, (now() at time zone 'Africa/Kigali')::date)
                         and coalesce(p_to, p_from, (now() at time zone 'Africa/Kigali')::date)
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

grant execute on function lab_worklist(text, date, date) to authenticated;
revoke execute on function lab_worklist(text, date, date) from anon, public;
