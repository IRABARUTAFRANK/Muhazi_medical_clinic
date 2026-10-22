-- 0072 · The visit's bill loads again for everyone.
--
-- 0064 added "refunded" to visit_bill by reading the refund table directly. The view runs with
-- the reader's rights and nobody may read refund itself (only through the cash functions), so
-- every visit_bill read failed with "permission denied for table refund": the visit screen had
-- no bill, and "Add a treatment" stayed switched off (its list could not be opened).
-- The refunded amount now comes from a function, like the balance.

create or replace function invoice_refunded(p_invoice_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(r.amount), 0) from refund r where r.invoice_id = p_invoice_id and r.deleted_at is null
$$;

create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number,
         invoice_balance(i.id) as balance,
         (select coalesce(sum(p.amount), 0) from payment p where p.invoice_id = i.id and p.deleted_at is null) as paid,
         lp.paid_at as settled_at,
         lp.cashier as settled_by,
         invoice_refunded(i.id) as refunded
  from invoice i
  left join payer py on py.id = i.payer_id
  left join lateral (
    select p.paid_at, pr.full_name as cashier
    from payment p
    left join profiles pr on pr.id = p.cashier_id
    where p.invoice_id = i.id and p.deleted_at is null
    order by p.paid_at desc limit 1
  ) lp on true;

revoke all on function invoice_refunded(uuid) from public, anon;
grant execute on function invoice_refunded(uuid) to authenticated;
