-- 0044 · Three payment methods; the cashier takes money, never adds treatments; tests that bring
-- the patient back; the doctor hears when the nurse has done the task.
--
-- Payments: only cash, MTN MoMo and Airtel Money are accepted from now on (card, bank, insurer,
-- credit and deposit stay in the enum so older rows remain readable).
--
-- Cashier: no longer holds charge.write. Treatments, medicines and tests are added by those who
-- treat (doctors, nurses, lab, pharmacy); the cashier only takes the payment.
--
-- Tests: a doctor who has not found the disease yet orders one or several tests at once (no
-- diagnosis needed) and sends the patient to the laboratory / ultrasound. When the last result of
-- that desk is written, the patient is put back in the ordering doctor's queue automatically,
-- with "Results ready" so the doctor can give the final treatment.

-- ---------------------------------------------------------------- payment methods
alter table payment drop constraint if exists payment_method_accepted;
alter table payment
  add constraint payment_method_accepted
  check (method in ('cash', 'momo', 'airtel')) not valid;

-- ---------------------------------------------------------------- cashier: payments only
delete from role_permissions where role = 'cashier' and permission = 'charge.write';

-- ---------------------------------------------------------------- several tests, patient comes back
create or replace function order_tests(
  p_encounter_id uuid,
  p_service_ids uuid[],
  p_reason text default null,
  p_from station default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_service uuid;
  v_n integer := 0;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'choose at least one test' using errcode = '22023';
  end if;
  foreach v_service in array p_service_ids loop
    perform order_test(p_encounter_id, v_service, p_reason, 3);
    v_n := v_n + 1;
  end loop;
  -- Send the patient now: off the doctor's queue, onto the test desks, back to this doctor after.
  if p_from is not null and p_from not in ('laboratory', 'ultrasound') then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = p_from and finished_at is null;
    update queue_entry
    set referred_by = auth.uid(),
        referral_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), referral_note),
        return_station = p_from,
        return_to = auth.uid()
    where encounter_id = p_encounter_id and station in ('laboratory', 'ultrasound')
      and finished_at is null and deleted_at is null;
  end if;
  return v_n;
end
$$;

create or replace function record_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_verify boolean default true
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_station station;
  v_q queue_entry%rowtype;
  v_tests text;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  insert into diagnostic_report (service_request_id, findings, impression, verified_by, verified_at)
  values (p_request_id, nullif(trim(coalesce(p_findings, '')), ''), nullif(trim(coalesce(p_impression, '')), ''),
          case when p_verify then auth.uid() end, case when p_verify then now() end)
  on conflict (service_request_id) do update
  set findings = excluded.findings, impression = excluded.impression,
      verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_at = now();
  update service_request set status = case when p_verify then 'verified'::request_status else 'resulted'::request_status end
  where id = p_request_id;
  -- Tell the doctor who ordered it.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor who sent them.
  v_station := case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end;
  if not exists (select 1 from service_request r
                 where r.encounter_id = v_req.encounter_id and r.category = v_req.category
                   and r.deleted_at is null and r.status not in ('resulted', 'verified', 'cancelled')) then
    select * into v_q from queue_entry
    where encounter_id = v_req.encounter_id and station = v_station and finished_at is null and deleted_at is null
    order by created_at desc limit 1;
    if found and v_q.return_station is not null then
      update queue_entry set finished_at = now() where id = v_q.id;
      if not exists (select 1 from queue_entry where encounter_id = v_req.encounter_id
                     and station = v_q.return_station and finished_at is null and deleted_at is null) then
        select string_agg(s.name_en, ', ' order by r.created_at) into v_tests
        from service_request r join service s on s.id = r.service_id
        where r.encounter_id = v_req.encounter_id and r.category = v_req.category and r.deleted_at is null
          and r.status in ('resulted', 'verified');
        insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
        values (v_req.encounter_id, v_q.return_station, v_q.ticket_no, v_q.priority, v_q.return_to, auth.uid(),
                'Results ready: ' || coalesce(v_tests, v_test, ''));
      end if;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- task done → the doctor is told
create or replace function complete_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_task internal_task%rowtype;
  v_name text;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update internal_task set done_at = now(), done_by = auth.uid()
  where id = p_task_id and deleted_at is null and done_at is null
  returning * into v_task;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
  if v_task.created_by is not null and v_task.created_by is distinct from auth.uid() then
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_task.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('task_done',
            jsonb_build_object('title', v_task.title, 'name', v_name,
                               'by', (select full_name from profiles where id = auth.uid())),
            case when v_task.encounter_id is not null then '/app/visit?encounter=' || v_task.encounter_id end,
            v_task.created_by, auth.uid());
  end if;
end
$$;

grant execute on function order_tests(uuid, uuid[], text, station) to authenticated;
revoke execute on function order_tests(uuid, uuid[], text, station) from anon, public;
