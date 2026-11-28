-- 0213 · The search bar at the top of every screen suggests as you type (Frank, 2026-11-28: "when
-- I am typing I may be able to see some such results ... I may be searching a patient or any other
-- feature, like the way Google does it or Gmail").
--
-- quick_search(p_query): one call, a few of each kind, each kind only for those who may see it:
--   patients   name, file number (also a part of it: "1200" finds MMC-001200), phone, ID   patient.read
--   visits     the visit number (V-2026-000789, or a part of it)                          patient.read
--   bills      the bill number (INV-…)                                       billing.read / payment.take
--   receipts   the receipt number (RCT-…)                                    billing.read / payment.take
--   bookings   the reference (MMC-2026-0013), the caller's name or phone      appointment.read / approve,
--                                                                             the manager, or one's own
--   staff      name, staff ID (MMC-S-0001), username                          the manager
--   items      medicine or supply: name, brand, code                          stock.read
-- The pages and features of the menu are suggested by the screen itself (no database).
-- At least 2 characters; numbers are searched by part only from 3 characters with a digit.

create or replace function quick_search(p_query text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_q text := trim(coalesce(p_query, ''));
  v_digits text;
  v_num boolean;
  v_like text;
  v_me uuid := auth.uid();
  v_out jsonb := '{}'::jsonb;
begin
  if v_me is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_q) < 2 then
    return v_out;
  end if;
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
  -- a number (or a part of one) is looked for from 3 characters with a digit in them
  v_num := length(v_q) >= 3 and v_digits <> '';
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  if has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('patients', coalesce((
      select jsonb_agg(x.j order by x.rank, x.name)
      from (
        select jsonb_build_object(
                 'id', p.id, 'fileNumber', p.file_number,
                 'name', p.surname || ' ' || p.given_names,
                 'sex', p.sex, 'birthDate', p.birth_date, 'phone', p.phone_1,
                 'openEncounterId', (select e.id from encounter e
                                     where e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
                                     order by e.arrived_at desc limit 1)) as j,
               case when upper(p.file_number) = upper(v_q) then 0
                    when (p.surname || ' ' || p.given_names) ilike v_q || '%'
                      or (p.given_names || ' ' || p.surname) ilike v_q || '%' then 1
                    else 2 end as rank,
               p.surname || ' ' || p.given_names as name
        from patient p
        where p.deleted_at is null and p.merged_into is null
          and (
            upper(p.file_number) = upper(v_q)
            or (v_num and p.file_number ilike v_like)
            or exists (select 1 from patient_alias a where a.patient_id = p.id and upper(a.file_number) = upper(v_q))
            or p.national_id = v_q
            or (p.id_number is not null and p.id_number = upper(regexp_replace(v_q, '[[:space:].-]', '', 'g')))
            or (length(v_digits) >= 4 and v_q !~ '[A-Za-z]'
                and regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%')
            or (p.surname || ' ' || p.given_names) ilike v_like
            or (p.given_names || ' ' || p.surname) ilike v_like
          )
        order by rank, name
        limit 6
      ) x), '[]'::jsonb));

    if v_num then
      v_out := v_out || jsonb_build_object('visits', coalesce((
        select jsonb_agg(x.j order by x.at desc)
        from (
          select jsonb_build_object(
                   'encounterId', e.id, 'reference', e.reference, 'status', e.status, 'at', e.arrived_at,
                   'patientId', p.id, 'name', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number) as j,
                 e.arrived_at as at
          from encounter e join patient p on p.id = e.patient_id
          where e.deleted_at is null and e.reference ilike v_like
          order by e.arrived_at desc
          limit 4
        ) x), '[]'::jsonb));
    end if;
  end if;

  if v_num and (has_perm('billing.read') or has_perm('payment.take') or is_manager()) then
    v_out := v_out || jsonb_build_object('bills', coalesce((
      select jsonb_agg(x.j order by x.at desc)
      from (
        select jsonb_build_object(
                 'encounterId', i.encounter_id, 'number', i.number, 'status', i.status, 'total', i.total,
                 'at', e.arrived_at, 'name', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number) as j,
               e.arrived_at as at
        from invoice i
        join encounter e on e.id = i.encounter_id and e.deleted_at is null
        join patient p on p.id = e.patient_id
        where i.number ilike v_like
        order by e.arrived_at desc
        limit 4
      ) x), '[]'::jsonb))
    || jsonb_build_object('receipts', coalesce((
      select jsonb_agg(x.j order by x.at desc)
      from (
        -- a counter sale's receipt (a buyer without a visit) too: its buyer's name, no visit
        select jsonb_build_object(
                 'encounterId', i.encounter_id, 'receiptNo', pa.receipt_no, 'amount', pa.amount,
                 'method', pa.method, 'at', pa.paid_at,
                 'name', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name),
                 'fileNumber', p.file_number, 'sale', cs.number) as j,
               pa.paid_at as at
        from payment pa
        left join invoice i on i.id = pa.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient p on p.id = e.patient_id
        left join counter_sale cs on cs.id = pa.counter_sale_id
        where pa.voided_at is null and pa.deleted_at is null and pa.receipt_no ilike v_like
          and (e.id is null or e.deleted_at is null)
        order by pa.paid_at desc
        limit 4
      ) x), '[]'::jsonb));
  end if;

  v_out := v_out || jsonb_build_object('bookings', coalesce((
    select jsonb_agg(x.j order by x.at desc nulls last)
    from (
      select jsonb_build_object(
               'id', a.id, 'reference', a.reference, 'status', a.status,
               'startsAt', a.starts_at, 'preferredAt', a.preferred_at,
               'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
               'phone', coalesce(p.phone_1, a.contact_phone),
               'doctor', pr.names) as j,
             coalesce(a.starts_at, a.preferred_at, a.created_at) as at
      from appointment a
      left join patient p on p.id = a.patient_id
      left join practitioner pr on pr.id = a.practitioner_id
      where a.deleted_at is null
        and (has_perm('appointment.read') or has_perm('appointment.approve') or is_manager()
             or pr.user_id = v_me)
        and (
          (v_num and a.reference ilike v_like)
          or a.contact_name ilike v_like
          or (length(v_digits) >= 4 and v_q !~ '[A-Za-z]'
              and regexp_replace(coalesce(a.contact_phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%')
        )
      order by coalesce(a.starts_at, a.preferred_at, a.created_at) desc nulls last
      limit 4
    ) x), '[]'::jsonb));

  if is_manager() then
    v_out := v_out || jsonb_build_object('staff', coalesce((
      select jsonb_agg(x.j order by x.name)
      from (
        select jsonb_build_object('id', pf.id, 'name', pf.full_name, 'staffId', pf.staff_id,
                                  'role', pf.role, 'active', pf.active) as j,
               pf.full_name as name
        from profiles pf
        where pf.full_name ilike v_like or pf.staff_id ilike v_like or pf.username ilike v_like
        order by pf.active desc, pf.full_name
        limit 4
      ) x), '[]'::jsonb));
  end if;

  if has_perm('stock.read') then
    v_out := v_out || jsonb_build_object('items', coalesce((
      select jsonb_agg(x.j order by x.name)
      from (
        select jsonb_build_object('id', it.id, 'name', item_label(it.id), 'code', it.code) as j,
               it.name_generic as name
        from item it
        where it.active
          and (it.name_generic ilike v_like or it.name_brand ilike v_like or it.code ilike v_like)
        order by it.name_generic
        limit 5
      ) x), '[]'::jsonb));
  end if;

  return v_out;
end
$$;

revoke all on function quick_search(text) from public, anon;
grant execute on function quick_search(text) to authenticated;
