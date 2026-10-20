-- 0045 · A paid patient leaves "In the clinic"; staff can say a patient has left.
--
-- Before: when the doctor finished a visit with money still due, the visit was reopened and the
-- patient queued at the cashier; paying closed the cashier queue entry only when the bill was
-- still a draft, and the visit itself stayed open for ever. A patient sent to the cashier after
-- paying (nothing due) also stayed there, with no way to remove them.
--
-- Now: finish_visit marks the clinical work as done (clinical_done_at); once the bill is settled
-- the cashier entry closes in every case and, if the doctor had finished, the visit closes too.
-- end_visit(): "the patient has left" from any desk — closes the visit and every queue entry; if
-- money is still due only the manager may do it, with a reason (kept on the visit).

alter table encounter add column if not exists clinical_done_at timestamptz;
alter table encounter add column if not exists left_reason text;

create or replace function finish_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform close_encounter(p_encounter_id);
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    -- Treatment is over; the visit stays open only until the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    update queue_entry set finished_at = now() where encounter_id = p_encounter_id and station <> 'cashier' and finished_at is null;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
    end if;
  end if;
end
$$;

create or replace function take_payment(
  p_encounter_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_balance numeric;
  v_number text;
  v_closed boolean := false;
begin
  if not has_perm('billing.write') or current_role_key() not in ('cashier', 'receptionist') then
    raise exception 'only the cashier (or reception) records payments' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be more than zero' using errcode = '22023';
  end if;
  perform recompute_invoice((select id from invoice where encounter_id = p_encounter_id));
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'credited' then
    raise exception 'this bill was credited' using errcode = '23514';
  end if;
  v_balance := invoice_balance(v_invoice.id);
  if p_amount > v_balance + 0.5 then
    raise exception 'the amount exceeds the balance due (%)', v_balance using errcode = '22023';
  end if;
  perform record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 then
    if v_invoice.status = 'draft' then
      v_number := post_invoice(v_invoice.id);
    else
      select number into v_number from invoice where id = v_invoice.id;
    end if;
    -- Paid: off the cashier's queue in every case.
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
    -- The doctor had finished and nothing else is waiting: the visit is over.
    update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid()
    where id = p_encounter_id and status = 'open' and clinical_done_at is not null
      and not exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id
                      and q.finished_at is null and q.deleted_at is null);
    v_closed := found;
  else
    select number into v_number from invoice where id = v_invoice.id;
  end if;
  return jsonb_build_object('balance', v_balance, 'number', v_number, 'closed', v_closed,
                            'status', (select status from invoice where id = v_invoice.id));
end
$$;

-- "The patient has left": close the visit from any desk.
create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    if current_role_key() <> 'manager' then
      raise exception 'money is still due (% RWF): take the payment first, or ask the manager', round(v_due)
        using errcode = '23514';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'say why the patient left without paying' using errcode = '22023';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  return jsonb_build_object('due', v_due);
end
$$;

grant execute on function end_visit(uuid, text) to authenticated;
revoke execute on function end_visit(uuid, text) from anon, public;

-- Leftovers: visits already paid in full whose patient only waits at the cashier leave the
-- cashier, and paid visits no longer waiting anywhere are closed (they blocked a new visit).
update queue_entry q set finished_at = now()
where q.station = 'cashier' and q.finished_at is null and q.deleted_at is null
  and exists (select 1 from invoice i where i.encounter_id = q.encounter_id and i.status = 'posted'
              and invoice_balance(i.id) <= 0);
update encounter e set status = 'closed', closed_at = now()
where e.status = 'open'
  and exists (select 1 from invoice i where i.encounter_id = e.id and i.status = 'posted'
              and invoice_balance(i.id) <= 0)
  and not exists (select 1 from queue_entry q where q.encounter_id = e.id
                  and q.finished_at is null and q.deleted_at is null);
