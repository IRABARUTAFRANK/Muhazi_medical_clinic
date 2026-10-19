-- 0023 · Nurse first, reception completes the file.
--
-- Clinic practice: the patient meets the nurse first; she registers what she can (name, sex,
-- age) and takes the measurements; reception then completes what the nurse cannot (phone,
-- national ID, address) before the patient sees the doctor. Either one can register.
--   * patient_missing(): which administrative details a file still lacks;
--   * files_to_complete(): patients in the clinic now (or registered in the last two days)
--     whose file is incomplete, with where they are, for reception's list.

create or replace function patient_missing(p patient)
returns text[]
language sql stable
as $$
  select array_remove(array[
    case when nullif(trim(coalesce(p.phone_1, '')), '') is null then 'phone' end,
    -- National ID from 16 years (or when the age is unknown).
    case when p.national_id is null
          and (p.birth_date is null or p.birth_date <= current_date - interval '16 years') then 'national_id' end,
    case when nullif(trim(coalesce(p.sector, '')), '') is null then 'address' end,
    case when p.birth_date is null then 'age' end
  ], null)
$$;

create or replace function files_to_complete()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.in_clinic desc, x.at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'patientId', p.id,
             'fileNumber', p.file_number,
             'name', p.surname || ' ' || p.given_names,
             'sex', p.sex,
             'birthDate', p.birth_date,
             'missing', to_jsonb(patient_missing(p)),
             'registeredBy', rb.full_name,
             'registeredAt', p.created_at,
             'encounterId', e.id,
             'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = e.id order by q.created_at limit 1),
             'station', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null
                         and q.deleted_at is null order by q.created_at desc limit 1)
           ) as j,
           (e.id is not null) as in_clinic,
           coalesce(e.arrived_at, p.created_at) as at
    from patient p
    left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
    left join profiles rb on rb.id = p.created_by
    where has_perm('patient.read') and p.deleted_at is null and p.merged_into is null
      and cardinality(patient_missing(p)) > 0
      and (e.id is not null or p.created_at > now() - interval '2 days')
  ) x
$$;

grant execute on function patient_missing(patient), files_to_complete() to authenticated;
revoke execute on function patient_missing(patient), files_to_complete() from anon;
