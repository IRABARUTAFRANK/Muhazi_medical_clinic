-- 0144: letting a patient go with money due.
--
-- Until now only the manager could end a visit while money was still owed (with the reason).
-- The owner wants his desks to do it too: the visit closes, the bill is posted and what is owed
-- stays on the patient as a debt (the cashier's "Still owed from finished visits", the patient's
-- file "Owes …", reception at the next arrival). So:
--  * a managed feature, visit.leave_owing — "Let a patient go with money due" — switched per role
--    and per person like the others; the manager, the cashier, reception and the doctors at first;
--  * end_visit accepts it (the reason is still required), never for the administrator, and writes
--    the audit event (who let the patient go, how much, why).

create or replace function managed_permission(p text)
returns boolean
language sql immutable
as $$
  select p in ('payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
               'orders.write', 'appointment.approve', 'stock.write', 'records.approve', 'stock.sell_walkin',
               'charge.override', 'visit.leave_owing')
$$;
insert into role_permissions (role, permission)
values ('manager', 'visit.leave_owing'), ('cashier', 'visit.leave_owing'),
       ('receptionist', 'visit.leave_owing'), ('doctor', 'visit.leave_owing')
on conflict do nothing;

-- ---------------------------------------------------------------- end_visit (from 20270108090000_profession_manager)
create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
  v_role text;
  v_patient uuid;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if v_patient is null then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    select role::text into v_role from profiles where id = auth.uid();
    -- 0144: the manager, or whoever holds "Let a patient go with money due" (never the administrator)
    if not (is_manager() or (has_perm('visit.leave_owing') and coalesce(v_role, '') <> 'administrator')) then
      raise exception 'money is still due (% RWF): take the payment first, or someone allowed may let the patient go with a debt', round(v_due)
        using errcode = '23514', hint = 'leave_owing';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'money is still due (% RWF): say why the patient left without paying', round(v_due)
        using errcode = '22023', hint = 'leave_reason';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  -- the bill gets its number and the insurer's claim; what the patient owes stays on the unpaid list
  perform post_drafts_of_visit(p_encounter_id);
  if v_due > 0 then
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'update', 'encounter', p_encounter_id,
            jsonb_build_object('key', 'left_owing', 'patient_id', v_patient, 'due', round(v_due),
                               'reason', nullif(trim(coalesce(p_reason, '')), '')));
  end if;
  return jsonb_build_object('due', v_due);
end
$$;

-- ---------------------------------------------------------------- find_patients_at_reception
-- find_patients (20261218090000_reception_and_fields) + balance_due: what the patient still owes
-- on finished visits, so reception sees it at the next arrival ("Owes … — collect at the
-- cashier"). Its own name: a function's return type cannot change, and the older definition is
-- re-run by the checks.
create or replace function find_patients_at_reception(p_query text, p_limit integer default 10)
returns table (
  id uuid, file_number text, surname text, given_names text, sex sex, birth_date date,
  phone_1 text, has_open_visit boolean, balance_due numeric
)
language sql stable security definer set search_path = public
as $$
  with q as (select trim(coalesce(p_query, '')) as text)
  select p.id, p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         exists (select 1 from encounter e where e.patient_id = p.id and e.status = 'open') as has_open_visit,
         coalesce((select sum(invoice_balance(i.id)) from invoice i
                   join encounter e on e.id = i.encounter_id
                   where e.patient_id = p.id and e.status = 'closed' and i.status = 'posted'), 0) as balance_due
  from patient p, q
  where has_perm('patient.read')
    and p.deleted_at is null and p.merged_into is null and length(q.text) >= 2
    and (
      upper(p.file_number) = upper(q.text)
      -- a file number of a duplicate merged into this one
      or exists (select 1 from patient_alias a where a.patient_id = p.id and upper(a.file_number) = upper(q.text))
      or p.national_id = q.text
      or (length(regexp_replace(q.text, '[^0-9]', '', 'g')) = 16
          and p.national_id = regexp_replace(q.text, '[^0-9]', '', 'g') and q.text !~ '[A-Za-z]')
      or (p.id_number is not null and p.id_number = upper(regexp_replace(q.text, '[[:space:].-]', '', 'g')))
      or regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%'
         and length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4
      or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
      or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%'
    )
  order by p.surname, p.given_names
  limit greatest(1, least(p_limit, 50))
$$;
revoke all on function find_patients_at_reception(text, integer) from public, anon;
grant execute on function find_patients_at_reception(text, integer) to authenticated;
