-- 0095 · Record-access requests: by default only the manager answers.
--
-- Frank: the manager (the owner) answers the requests to see a patient's past records. A head of
-- department does not answer them by position any more. The manager can give that right in
-- Settings → Who may do what: the new feature "Answer record-access requests" (records.approve),
-- switched on for a role or given to one person as an exception (0054 mechanism). It has no
-- default role; the manager keeps it, as every feature.
--
-- What follows the rule: who answers (answer_record_access, hint 'not_approver' kept), who is
-- told of a new request and of an emergency access (record_access_approvers), the "pending"
-- list and canAnswer (record_access_requests → may_answer_access), the 'approvers' count a
-- requester is shown (patient_access). The heads keep what they had otherwise: the full history
-- of their department's patients (history_via 'head') and "who looked" on the patient file.

-- ---------------------------------------------------------------- the feature
create or replace function managed_permission(p text)
returns boolean
language sql immutable
as $$
  select p in ('payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
               'orders.write', 'appointment.approve', 'stock.write', 'records.approve')
$$;

-- The manager has it (my_permissions lists it for the manager); no other role by default.
insert into role_permissions (role, permission) values ('manager', 'records.approve')
on conflict do nothing;

create or replace function my_permissions()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
                    'orders.write', 'appointment.approve', 'stock.write', 'records.approve']) as p
  where has_perm(p)
$$;

-- ---------------------------------------------------------------- who answers
-- Who answers a request about the patient (and is told of a new request or an emergency access):
-- the managers and everyone the manager allowed to answer (the role's switch or an exception).
-- The patient no longer matters; the argument stays for the callers.
create or replace function record_access_approvers(p_patient_id uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct p.id), '{}')
  from profiles p
  where p.active and p.deleted_at is null
    and (p.role = 'manager' or staff_perm(p.id, 'records.approve'))
$$;

-- May the signed-in person answer requests about the patient?
create or replace function may_answer_access(p_patient_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager() or has_perm('records.approve')
$$;

-- B: the first approver to answer approves or refuses (a refusal says why). The requester is told.
create or replace function answer_record_access(p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_req record_access_request%rowtype;
  v_name text;
  v_me text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_req from record_access_request where id = p_request_id for update;
  if not found or v_req.kind <> 'request' then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.requested_by = auth.uid() or not may_answer_access(v_req.patient_id) then
    raise exception 'not allowed: the manager answers, or whoever the manager allowed to answer record-access requests'
      using errcode = '42501', hint = 'not_approver';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request was already answered (%)', v_req.status
      using errcode = '22023', hint = 'already_answered',
            detail = coalesce((select full_name from profiles where id = v_req.answered_by), '');
  end if;
  if p_approve is null then
    raise exception 'approve or refuse' using errcode = '22023';
  end if;
  if not p_approve and (v_note is null or length(v_note) < 3) then
    raise exception 'say why the request is refused' using errcode = '22023', hint = 'reason_needed';
  end if;
  if p_approve and not exists (select 1 from encounter e where e.id = v_req.encounter_id and e.status = 'open' and e.deleted_at is null) then
    raise exception 'the visit is closed: the access would end at once' using errcode = '22023', hint = 'visit_closed';
  end if;
  update record_access_request
  set status = case when p_approve then 'approved' else 'refused' end,
      answered_by = auth.uid(), answered_at = now(), answer_note = v_note
  where id = p_request_id
  returning * into v_req;
  -- the other approvers no longer need to answer
  delete from notification where kind = 'access_request' and (params ->> 'requestId') = p_request_id::text;
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_req.patient_id;
  select full_name into v_me from profiles where id = auth.uid();
  insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
  values ('access_answer',
          jsonb_build_object('requestId', v_req.id, 'patientId', v_req.patient_id, 'name', v_name,
                             'approved', p_approve, 'by', v_me, 'reason', v_note),
          case when p_approve then 'Access to past records approved' else 'Access to past records refused' end,
          v_me || case when p_approve then ' approved your request to see the past records of '
                       else ' refused your request to see the past records of ' end
            || v_name || coalesce(': ' || v_note, '') || '.',
          '/app/patient?id=' || v_req.patient_id, false, v_req.requested_by, auth.uid());
  return jsonb_build_object('id', v_req.id, 'status', v_req.status);
end
$$;

-- The patient file's "Who looked" stays with the manager and the heads in charge (it followed
-- may_answer_access before; a head keeps it although they no longer answer requests).
create or replace function patient_access_log(p_patient_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (is_manager() or coalesce(auth.uid() = any (heads_in_charge(p_patient_id)), false)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(access_entry_json(x) order by x.at desc)
    from (select a.* from record_access_entry a where a.patient_id = p_patient_id
          order by a.at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x), '[]'::jsonb);
end
$$;

comment on table record_access_request is
  'Requests to see a patient''s past records (and emergency accesses), answered by the manager or whoever the manager allowed to (records.approve, 0095).';

-- ---------------------------------------------------------------- grants
revoke all on function record_access_approvers(uuid), may_answer_access(uuid) from public, anon, authenticated;
revoke all on function answer_record_access(uuid, boolean, text), patient_access_log(uuid, integer), my_permissions()
  from public, anon;
grant execute on function answer_record_access(uuid, boolean, text), patient_access_log(uuid, integer), my_permissions()
  to authenticated;
