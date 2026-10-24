-- 0077 · The RHIA list is a reference list, not the clinic's medicines.
--
-- 0074 put the 1,446 medicines of the RHIA list (June 2026) straight into the clinic's
-- medicines. Frank: the list is what the body in charge publishes, for finding names and
-- details easily; the clinic's medicines are only those it keeps. Now:
--   * medicine_reference holds the list (code, generic name, presentation, prescribing rule,
--     selling unit, price, group);
--   * the clinic's medicines are those it adds: from the list (picked in a drop-down, its
--     details and price filled in, changed where the clinic works otherwise) or typed;
--   * the 0074 rows nothing has used yet leave the clinic's medicines (any already received,
--     prescribed or billed stays).

create table if not exists medicine_reference (
  code text primary key,
  generic text not null,
  presentation text,
  prescribing_rule text,
  unit text,
  price numeric(12, 0),
  atc_group text,
  source text not null default 'RHIA June 2026',
  created_at timestamptz not null default now()
);
alter table medicine_reference enable row level security;
drop policy if exists medicine_reference_read on medicine_reference;
create policy medicine_reference_read on medicine_reference for select to authenticated using (true);
revoke all on medicine_reference from anon;
grant select on medicine_reference to authenticated;

insert into medicine_reference (code, generic, presentation, prescribing_rule, unit, price, atc_group, source)
select i.code, i.name_generic, i.strength, i.prescribing_rule, i.selling_unit,
       (select pf.price from price_for(null, i.id, null) pf), i.atc_group, coalesce(i.source, 'RHIA June 2026')
from item i
where i.source = 'RHIA June 2026'
on conflict (code) do nothing;

-- the list rows nothing has used leave the clinic's medicines
delete from price_list_item p using item i
where p.item_id = i.id and i.source = 'RHIA June 2026'
  and not exists (select 1 from stock_movement m where m.item_id = i.id)
  and not exists (select 1 from batch b where b.item_id = i.id)
  and not exists (select 1 from medication_request r where r.item_id = i.id)
  and not exists (select 1 from medication_dispense d where d.item_id = i.id)
  and not exists (select 1 from invoice_line l where l.item_id = i.id);
delete from item i
where i.source = 'RHIA June 2026'
  and not exists (select 1 from stock_movement m where m.item_id = i.id)
  and not exists (select 1 from batch b where b.item_id = i.id)
  and not exists (select 1 from medication_request r where r.item_id = i.id)
  and not exists (select 1 from medication_dispense d where d.item_id = i.id)
  and not exists (select 1 from invoice_line l where l.item_id = i.id);

create or replace function upsert_item(
  p_id uuid,
  p_name text,
  p_price numeric,
  p_strength text default null,
  p_form text default null,
  p_unit text default null,
  p_active boolean default true,
  p_code text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_list uuid;
  v_code text := nullif(upper(trim(coalesce(p_code, ''))), '');
begin
  -- the manager, and the pharmacy for its medicines and their prices
  if not (has_perm('catalogue.write') or has_perm('item_price.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the medicine needs a name' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_id is null and v_code is not null then
    select id into v_id from item where code = v_code;
    if v_id is not null then
      update item set deleted_at = null where id = v_id;
    end if;
  end if;
  if v_id is null then
    if v_code is null then
      v_code := 'MED-' || lpad(next_number('item_code', 0)::text, 4, '0');
    end if;
    insert into item (code, name_generic, strength, form, unit, selling_unit, active)
    values (v_code, trim(p_name), nullif(trim(coalesce(p_strength, '')), ''), nullif(trim(coalesce(p_form, '')), ''),
            nullif(trim(coalesce(p_unit, '')), ''), nullif(trim(coalesce(p_unit, '')), ''), p_active)
    returning id into v_id;
  else
    update item
    set name_generic = trim(p_name), strength = nullif(trim(coalesce(p_strength, '')), ''),
        form = nullif(trim(coalesce(p_form, '')), ''), unit = nullif(trim(coalesce(p_unit, '')), ''),
        selling_unit = nullif(trim(coalesce(p_unit, '')), ''), active = p_active, code = coalesce(v_code, code)
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
  end if;
  update item i
  set prescribing_rule = coalesce(i.prescribing_rule, r.prescribing_rule),
      atc_group = coalesce(i.atc_group, r.atc_group),
      name_brand = coalesce(i.name_brand, r.presentation),
      source = coalesce(i.source, r.source)
  from medicine_reference r
  where i.id = v_id and r.code = i.code;
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, item_id, price) values (v_list, v_id, round(p_price))
  on conflict (price_list_id, item_id) where item_id is not null
  do update set price = excluded.price, deleted_at = null;
  return v_id;
end
$$;
