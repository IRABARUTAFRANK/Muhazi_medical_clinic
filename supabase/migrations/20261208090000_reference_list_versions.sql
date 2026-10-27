-- 0098 · The official medicine list, versioned; the insurers that follow it price from it.
--
-- The body in charge (RHIA / RSSB) publishes every six months the list of reimbursable medicines:
-- code, generic name, presentation, prescribing rule, selling unit, price and group. Frank (owner):
--   * the manager uploads each new list (Prices → Official medicine list); the old ones are kept;
--   * the list's price is the INSURERS' TARIFF; the clinic's cash price stays its own (Prices);
--   * an insurer that follows the official list (RSSB RAMA, MMI, Mutuelle de Santé) prices the
--     medicines from it with no data entry, the day the clinic starts working with it.
--
--   * reference_list: one row per uploaded list (name, effective_from, uploaded_by / _at, rows,
--     status current | past). medicine_reference_entry: the rows, keyed (list_id, code). The 0077
--     rows become the list 'RHIA June 2026' (effective 2026-06-01, current).
--   * medicine_reference is now a VIEW of the list in effect today (same columns as the 0077
--     table, plus list_id): Add stock, upsert_item, receive_delivery and every reader keep working.
--   * reference_list_at(date): the list in effect on that date (the latest effective_from not after
--     it; the same date: the last uploaded).
--   * import_reference_list(name, effective, rows, dry_run default true): the manager (or whoever
--     holds catalogue.write). Validates every row (code and generic name required, price a number
--     zero or more or empty, a code once); the preview compares with the current list: new,
--     changed prices [{code, generic, old, new}], removed [{code, generic}], unchanged, errors
--     [{row, code, message}]. dry_run false keeps the valid rows as the new current list from
--     the date (the previous one becomes past, kept), and flags the clinic's medicines whose code
--     left the list (item.reference_removed_at; cleared when a code comes back).
--   * reference_lists(): the lists for the Prices page (current first).
--   * payer.follows_reference_list (true for rssb_rama, mmi, cbhi, also when such an insurer is
--     added). price_for(service, item, payer, at): for such a payer without its own price for the
--     ITEM, the price of the item's code on the list in effect on that date, before the cash price.
--     Services unchanged; coverage % applies on that price as before.
--   * add_stock: a medicine picked from the list (new_item.code) is created with the list's code,
--     prescribing rule and group (it was given a MED- code before, which lost the link).
--
-- Errcodes: 42501 not allowed, 22023 bad input, P0002 not found.

-- ---------------------------------------------------------------- the lists
create table if not exists reference_list (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  effective_from date not null,
  uploaded_by uuid references profiles (id),
  uploaded_at timestamptz not null default now(),
  rows integer not null default 0,
  status text not null default 'current' check (status in ('current', 'past'))
);
create unique index if not exists reference_list_one_current on reference_list (status) where status = 'current';
alter table reference_list enable row level security;
drop policy if exists reference_list_read on reference_list;
create policy reference_list_read on reference_list for select to authenticated using (true);
revoke all on reference_list from anon, authenticated;
grant select on reference_list to authenticated;

-- the 0077 table becomes the rows of the lists
alter table medicine_reference rename to medicine_reference_entry;
alter table medicine_reference_entry add column if not exists list_id uuid references reference_list (id);
insert into reference_list (name, effective_from, uploaded_at, rows, status)
select 'RHIA June 2026', date '2026-06-01', coalesce(min(created_at), now()), count(*)::int, 'current'
from medicine_reference_entry;
update medicine_reference_entry set list_id = (select id from reference_list where name = 'RHIA June 2026')
where list_id is null;
alter table medicine_reference_entry alter column list_id set not null;
alter table medicine_reference_entry drop constraint if exists medicine_reference_pkey;
alter table medicine_reference_entry add primary key (list_id, code);
create index if not exists medicine_reference_entry_code_idx on medicine_reference_entry (code);
revoke all on medicine_reference_entry from anon, authenticated;
grant select on medicine_reference_entry to authenticated;

-- The list in effect on a date: the latest effective_from not after it (same date: last uploaded).
create or replace function reference_list_at(p_at date default current_date)
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from reference_list
  where effective_from <= coalesce(p_at, current_date)
  order by effective_from desc, uploaded_at desc
  limit 1
$$;

-- What every reader called medicine_reference: the list in effect today (before its first date:
-- the current one).
create or replace view medicine_reference with (security_invoker = true) as
  select e.code, e.generic, e.presentation, e.prescribing_rule, e.unit, e.price, e.atc_group, e.source,
         e.created_at, e.list_id
  from medicine_reference_entry e
  join (select coalesce(reference_list_at(current_date),
                        (select r.id from reference_list r where r.status = 'current')) as id) cur
    on cur.id = e.list_id;
revoke all on medicine_reference from anon;
grant select on medicine_reference to authenticated;

-- ---------------------------------------------------------------- items and insurers
alter table item add column if not exists reference_removed_at timestamptz;
comment on column item.reference_removed_at is
  'Set when an uploaded official list no longer has this code (no insurer list price); cleared when it returns.';

alter table payer add column if not exists follows_reference_list boolean not null default false;
comment on column payer.follows_reference_list is
  'The insurer prices medicines from the official list (RHIA) when it has no own price for the item.';
update payer set follows_reference_list = true
where type in ('rssb_rama', 'mmi', 'cbhi') and not follows_reference_list;

-- an insurer of these kinds added later follows the list from the start (switched off on the insurer)
create or replace function payer_follows_reference_default()
returns trigger
language plpgsql
as $$
begin
  if new.type in ('rssb_rama', 'mmi', 'cbhi') then
    new.follows_reference_list := true;
  end if;
  return new;
end
$$;
drop trigger if exists trg_payer_follows_reference on payer;
create trigger trg_payer_follows_reference before insert on payer
  for each row execute function payer_follows_reference_default();

-- guard_item (from 20261124090000_stores_and_stock): the list flag changes only with an upload.
create or replace function guard_item()
returns trigger
language plpgsql
as $$
begin
  -- the checked (security definer) functions run as their owner, not as the API roles
  if current_user::text not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a medicine is deleted with the Delete button (the manager)' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       new.deleted_at is distinct from old.deleted_at or new.active is distinct from old.active
       or new.reorder_level is distinct from old.reorder_level or new.max_level is distinct from old.max_level
       or new.code is distinct from old.code or new.pack_size is distinct from old.pack_size
       or new.reference_removed_at is distinct from old.reference_removed_at) then
    raise exception 'deleting, switching off, the code, the box size and the stock levels change only through their screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------- price_for
-- price_for (from 20261015180200_catalogue): an insurer that follows the official list and has no
-- own price for the ITEM takes the price of the item's code on the list in effect on p_at.
create or replace function price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, list_payer_id uuid, fallback boolean)
language plpgsql stable
as $$
begin
  if p_payer_id is not null then
    return query
      select pli.price, pl.payer_id, false
      from price_list pl
      join price_list_item pli on pli.price_list_id = pl.id
      where pl.payer_id = p_payer_id
        and pl.deleted_at is null and pli.deleted_at is null
        and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
        and ((p_service_id is not null and pli.service_id = p_service_id)
          or (p_item_id is not null and pli.item_id = p_item_id))
      order by pl.effective_from desc
      limit 1;
    if found then
      return;
    end if;
    if p_item_id is not null and exists (select 1 from payer py where py.id = p_payer_id and py.follows_reference_list) then
      return query
        select e.price, p_payer_id, false
        from item i
        join medicine_reference_entry e on e.code = i.code and e.list_id = reference_list_at(p_at)
        where i.id = p_item_id and e.price is not null
        limit 1;
      if found then
        return;
      end if;
    end if;
  end if;
  return query
    select pli.price, null::uuid, (p_payer_id is not null)
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null
      and pl.deleted_at is null and pli.deleted_at is null
      and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
      and ((p_service_id is not null and pli.service_id = p_service_id)
        or (p_item_id is not null and pli.item_id = p_item_id))
    order by pl.effective_from desc
    limit 1;
end
$$;

-- ---------------------------------------------------------------- the lists for the Prices page
create or replace function reference_lists()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'effectiveFrom', r.effective_from, 'rows', r.rows,
    'uploadedAt', r.uploaded_at, 'uploadedBy', p.full_name, 'status', r.status,
    'inEffect', r.id = reference_list_at(current_date))
    order by (r.status = 'current') desc, r.effective_from desc, r.uploaded_at desc), '[]'::jsonb)
  from reference_list r
  left join profiles p on p.id = r.uploaded_by
  where has_perm('catalogue.read')
$$;

-- ---------------------------------------------------------------- the upload
create or replace function import_reference_list(
  p_name text,
  p_effective date,
  p_rows jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_cur reference_list%rowtype;
  v_r jsonb;
  v_n integer;
  v_row integer;
  v_code text;
  v_generic text;
  v_price_txt text;
  v_err text;
  v_errors jsonb := '[]'::jsonb;
  v_valid integer;
  v_new integer;
  v_unchanged integer;
  v_changed jsonb;
  v_removed jsonb;
  v_list uuid;
  v_flagged integer := 0;
  v_back integer := 0;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'the list has no rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'the list has too many rows' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'give the list a name' using errcode = '22023';
  end if;
  if p_effective is null then
    raise exception 'give the date the list starts' using errcode = '22023';
  end if;
  select * into v_cur from reference_list where status = 'current';
  if found and p_effective < v_cur.effective_from then
    raise exception 'the new list cannot start before the current one' using errcode = '22023';
  end if;

  create temp table if not exists _ref_import (
    code text primary key,
    generic text not null,
    presentation text,
    prescribing_rule text,
    unit text,
    price numeric(12, 0),
    atc_group text
  ) on commit drop;
  truncate _ref_import;

  for v_r, v_n in select x.value, x.ordinality from jsonb_array_elements(p_rows) with ordinality as x loop
    v_err := null;
    v_row := v_n;
    if jsonb_typeof(v_r) <> 'object' then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', v_row, 'code', 'not_a_row',
        'message', 'not a row of the list'));
      continue;
    end if;
    if coalesce(v_r ->> 'row', '') ~ '^\d{1,7}$' then
      v_row := (v_r ->> 'row')::integer;
    end if;
    v_code := upper(regexp_replace(coalesce(v_r ->> 'code', ''), '\s+', '', 'g'));
    v_generic := nullif(regexp_replace(trim(coalesce(v_r ->> 'generic', '')), '\s+', ' ', 'g'), '');
    v_price_txt := nullif(replace(trim(coalesce(v_r ->> 'price', '')), ',', ''), '');
    if v_code = '' then
      v_err := 'no_code';
    elsif length(v_code) > 40 then
      v_err := 'bad_code';
    elsif v_generic is null then
      v_err := 'no_generic';
    elsif v_price_txt is not null and v_price_txt !~ '^\d{1,10}(\.\d+)?$' then
      v_err := 'bad_price';
    elsif exists (select 1 from _ref_import where code = v_code) then
      v_err := 'duplicate';
    end if;
    if v_err is not null then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', v_row, 'code', v_err,
        'value', case when v_err in ('bad_price') then v_r ->> 'price' when v_err = 'no_generic' then v_code
                      else v_r ->> 'code' end,
        'message', case v_err
          when 'no_code' then 'the code is missing'
          when 'bad_code' then 'the code is too long'
          when 'no_generic' then 'the generic name is missing'
          when 'bad_price' then 'the price is not a number zero or more'
          else 'this code is already on an earlier row' end));
      continue;
    end if;
    insert into _ref_import (code, generic, presentation, prescribing_rule, unit, price, atc_group)
    values (v_code, left(v_generic, 300),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'presentation', '')), '\s+', ' ', 'g'), ''), 300),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'prescribing_rule', v_r ->> 'rule', '')), '\s+', ' ', 'g'), ''), 120),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'unit', '')), '\s+', ' ', 'g'), ''), 60),
            round(v_price_txt::numeric),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'atc_group', v_r ->> 'group', '')), '\s+', ' ', 'g'), ''), 200));
  end loop;

  select count(*)::int into v_valid from _ref_import;
  select count(*)::int into v_new from _ref_import n
  where not exists (select 1 from medicine_reference_entry e where e.list_id = v_cur.id and e.code = n.code);
  select count(*)::int into v_unchanged from _ref_import n
  join medicine_reference_entry e on e.list_id = v_cur.id and e.code = n.code
  where e.price is not distinct from n.price;
  select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'generic', n.generic, 'presentation', n.presentation,
           'old', e.price, 'new', n.price,
           'inClinic', exists (select 1 from item i where i.code = n.code and i.deleted_at is null))
           order by n.generic, n.code), '[]'::jsonb)
  into v_changed
  from _ref_import n
  join medicine_reference_entry e on e.list_id = v_cur.id and e.code = n.code
  where e.price is distinct from n.price;
  select coalesce(jsonb_agg(jsonb_build_object('code', e.code, 'generic', e.generic, 'presentation', e.presentation,
           'inClinic', exists (select 1 from item i where i.code = e.code and i.deleted_at is null))
           order by e.generic, e.code), '[]'::jsonb)
  into v_removed
  from medicine_reference_entry e
  where e.list_id = v_cur.id and not exists (select 1 from _ref_import n where n.code = e.code);

  if not p_dry_run then
    if v_valid = 0 then
      raise exception 'no row of the list can be used' using errcode = '22023';
    end if;
    update reference_list set status = 'past' where status = 'current';
    insert into reference_list (name, effective_from, uploaded_by, rows, status)
    values (v_name, p_effective, auth.uid(), v_valid, 'current')
    returning id into v_list;
    insert into medicine_reference_entry (list_id, code, generic, presentation, prescribing_rule, unit, price, atc_group, source)
    select v_list, code, generic, presentation, prescribing_rule, unit, price, atc_group, v_name from _ref_import;
    -- the clinic's medicines: back on the list, or left it
    update item i set reference_removed_at = null
    where i.reference_removed_at is not null and exists (select 1 from _ref_import n where n.code = i.code);
    get diagnostics v_back = row_count;
    update item i set reference_removed_at = now()
    where i.deleted_at is null and i.reference_removed_at is null
      and exists (select 1 from medicine_reference_entry e where e.list_id = v_cur.id and e.code = i.code)
      and not exists (select 1 from _ref_import n where n.code = i.code);
    get diagnostics v_flagged = row_count;
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'create', 'reference_list', v_list,
            jsonb_build_object('name', v_name, 'effectiveFrom', p_effective, 'rows', v_valid,
                               'replaced', v_cur.name, 'changed', jsonb_array_length(v_changed),
                               'removed', jsonb_array_length(v_removed), 'itemsFlagged', v_flagged));
  end if;
  truncate _ref_import;

  return jsonb_build_object(
    'dryRun', p_dry_run, 'id', v_list, 'name', v_name, 'effectiveFrom', p_effective,
    'total', jsonb_array_length(p_rows), 'rows', v_valid,
    'new', v_new, 'changed', v_changed, 'removed', v_removed, 'unchanged', v_unchanged, 'errors', v_errors,
    'current', case when v_cur.id is null then null
                    else jsonb_build_object('name', v_cur.name, 'effectiveFrom', v_cur.effective_from, 'rows', v_cur.rows) end,
    'itemsFlagged', v_flagged, 'itemsBack', v_back);
end
$$;

-- ---------------------------------------------------------------- add stock
-- add_stock (from 20261207090000_pharmacy_simplified): a medicine of the list keeps the list's code.
create or replace function add_stock(p_lines jsonb, p_location_id uuid default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_main uuid := main_pharmacy();
  v_loc uuid;
  v_id uuid;
  v_number text;
  v_line jsonb;
  v_n integer;
  v_item uuid;
  v_new jsonb;
  v_kind text;
  v_name text;
  v_strength text;
  v_code text;
  v_ref medicine_reference%rowtype;
  v_created boolean;
  v_qty numeric;
  v_units integer;
  v_cost numeric;
  v_sell numeric;
  v_price numeric;
  v_expiry date;
  v_batch uuid;
  v_line_cost numeric;
  v_updated boolean;
  v_ignored boolean;
  v_price_right boolean := has_perm('item_price.write') or has_perm('catalogue.write');
  v_out jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_state text;
  v_msg text;
  v_hint text;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_loc := coalesce(p_location_id, v_main);
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  if v_loc is distinct from v_main and not is_manager() then
    raise exception 'stock is added into the main pharmacy (another store: the manager)' using errcode = '42501';
  end if;
  if not exists (select 1 from stock_location where id = v_loc and deleted_at is null and type::text <> 'transit') then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  v_number := day_number('GRN', 'goods-receipt');
  insert into goods_receipt (supplier_id, received_on, note, number, reference, delivered_on, location_id, supplier_name)
  values (null, now(), nullif(trim(coalesce(p_note, '')), ''), v_number, null,
          (now() at time zone 'Africa/Kigali')::date, v_loc, null)
  returning id into v_id;

  for v_line, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      v_created := false;
      v_updated := false;
      v_ignored := false;
      v_item := nullif(v_line ->> 'item_id', '')::uuid;
      v_new := case when jsonb_typeof(v_line -> 'new_item') = 'object' then v_line -> 'new_item' end;
      v_sell := nullif(v_line ->> 'sell_price', '')::numeric;
      if v_sell is not null and v_sell < 0 then
        raise exception 'the price must be zero or more' using errcode = '22023';
      end if;
      if v_item is null and v_new is not null then
        v_kind := coalesce(nullif(v_new ->> 'kind', ''), 'medicine');
        if v_kind not in ('medicine', 'supply') then
          raise exception 'a new item is a medicine or a supply' using errcode = '22023';
        end if;
        v_name := trim(coalesce(v_new ->> 'name', ''));
        v_strength := nullif(trim(coalesce(v_new ->> 'strength', '')), '');
        if length(v_name) < 2 then
          raise exception 'the medicine needs a name' using errcode = '22023';
        end if;
        -- 0098: picked from the official list: the item carries the list's code (its insurer
        -- price and its prescribing rule follow the list)
        v_code := nullif(upper(trim(coalesce(v_new ->> 'code', ''))), '');
        if v_code is not null then
          select * into v_ref from medicine_reference where code = v_code;
          if not found then
            raise exception 'this medicine is not on the reference list' using errcode = 'P0002';
          end if;
          select id into v_item from item where code = v_code;
          if v_item is not null then
            update item set deleted_at = null, active = true where id = v_item and (deleted_at is not null or not active);
          end if;
        end if;
        -- the same name (and strength) already on the list: that item
        if v_item is null then
          select id into v_item from item
          where deleted_at is null and lower(name_generic) = lower(v_name)
            and lower(coalesce(strength, '')) = lower(coalesce(v_strength, ''))
          order by active desc, created_at
          limit 1;
        end if;
        if v_item is null then
          insert into item (code, name_generic, strength, form, unit, selling_unit, active, kind)
          values (coalesce(v_code, case when v_kind = 'supply' then 'SUP-' else 'MED-' end
                    || lpad(next_number('item_code', 0)::text, 4, '0')),
                  v_name, v_strength, nullif(trim(coalesce(v_new ->> 'form', '')), ''),
                  nullif(trim(coalesce(v_new ->> 'unit', '')), ''), nullif(trim(coalesce(v_new ->> 'unit', '')), ''),
                  true, v_kind)
          returning id into v_item;
          if v_code is not null then
            update item set prescribing_rule = v_ref.prescribing_rule, atc_group = v_ref.atc_group,
                            name_brand = v_ref.presentation, source = v_ref.source
            where id = v_item;
          end if;
          v_created := true;
        end if;
      end if;
      if v_item is null then
        raise exception 'choose the medicine' using errcode = '22023';
      end if;
      if not exists (select 1 from item where id = v_item and deleted_at is null) then
        raise exception 'medicine not found' using errcode = 'P0002';
      end if;
      v_qty := nullif(v_line ->> 'quantity', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'quantity must be more than zero' using errcode = '22023';
      end if;
      if v_qty <> round(v_qty) then
        raise exception 'the quantity must come to whole units' using errcode = '22023';
      end if;
      v_units := v_qty::integer;
      v_cost := nullif(v_line ->> 'unit_cost', '')::numeric;
      if v_cost is null or v_cost < 0 then
        raise exception 'the cost per unit must be zero or more' using errcode = '22023';
      end if;
      v_expiry := nullif(v_line ->> 'expiry', '')::date;
      -- the selling price: a new item (or one without a price) takes it; a different price needs the right
      if v_sell is not null then
        select pf.price into v_price from price_for(null, v_item, null) pf;
        if v_price is null or v_created then
          perform set_cash_price(v_item, v_sell);
          v_updated := true;
        elsif round(v_sell) <> v_price then
          if v_price_right then
            perform set_cash_price(v_item, v_sell);
            v_updated := true;
          else
            v_ignored := true;
          end if;
        end if;
      end if;
      v_batch := receive_batch(v_item, v_loc, v_units, v_cost, v_line ->> 'batch_no', v_expiry, null, null, v_id);
      v_line_cost := round(round(v_cost, 2) * v_units, 2);
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      select v_id, v_item, b.id, b.batch_no, b.expiry, 'unit', v_units, 1, v_units, round(v_cost, 2), null, v_line_cost
      from batch b where b.id = v_batch;
      v_total := v_total + v_line_cost;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item, 'batch_id', v_batch, 'quantity', v_units, 'line_cost', v_line_cost,
        'created', v_created, 'price_updated', v_updated, 'price_ignored', v_ignored));
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
      raise exception 'line %: %', v_n, v_msg using errcode = v_state, hint = coalesce(nullif(v_hint, ''), 'line');
    end;
  end loop;
  update goods_receipt set total_cost = v_total where id = v_id;
  perform stock_alert_run();
  return jsonb_build_object('lines', v_out, 'total_cost', v_total, 'id', v_id, 'number', v_number, 'location_id', v_loc);
end
$$;

-- ---------------------------------------------------------------- grants
-- (functions replaced with the same arguments keep their grants)
revoke all on function reference_list_at(date), reference_lists(), import_reference_list(text, date, jsonb, boolean)
  from public, anon;
grant execute on function reference_list_at(date), reference_lists(), import_reference_list(text, date, jsonb, boolean)
  to authenticated;
revoke all on function payer_follows_reference_default() from public, anon, authenticated;
