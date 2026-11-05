-- 0135 · Clinic-wide price lists (Ministry of Health), insurers' own tariffs, and lists read in any
-- format.
--
-- Frank (owner), after 0134: "There are two ways of setting treatments and medicines in the clinic:
-- the treatments and prices the clinic manager creates, and the lists of treatments and of
-- medicines published by an agency — the Ministry of Health or an insurance — that are uploaded and
-- edited. An insurer like MMI publishes a list whose prices are the ones it calculates its coverage
-- on; a list may also say that something is not covered. Not all documents have the same format.
-- Keep two separate uploads: treatments, and medicines and products (an insurer may give a tariff
-- of treatments but not of medicines). When the MoH gives out a tariff it must be used in the whole
-- clinic (ours is a general clinic), but the clinic may sell some treatments at a different price,
-- so we must be able to edit them. A patient without insurance is private: he uses the MoH lists
-- together with ours, with no separation. A patient on an insurance uses the official tariff of
-- that insurance for treatments and for medicines." Then: "Now code; make sure I can enter into a
-- list of medicines or treatments and change things."
--
--   * tariff_book.scope: 'clinic' (the Ministry of Health: the whole clinic), 'insurer' (one
--     insurer's own tariff: payer_id), 'reference' (another publisher; insurers choose to follow
--     it). tariff_book.private_column: the column a private patient pays on a clinic-wide list
--     ("Privates (Non insured)", "General Clinics"); tariff_book.priority: the order of the
--     clinic-wide lists (the first with the line prices it).
--   * The price of a private patient (price_source_for with no payer, 'cash'): the clinic's own
--     price (price_list with no payer) when it set one; else the clinic-wide lists, in their order,
--     in their private column. Every reader of the cash price (the bill, the Prices page, the
--     pharmacy, the visit) now sees the MoH price of a treatment the clinic did not price itself.
--     An insurer without a price of its own still falls back on that price with its rule.
--   * A clinic-wide list of treatments, when kept, makes every line a treatment of the clinic
--     (service.list_book_id: made from that list; tariff_code: the line's code): one list of
--     treatments for the doctors, no separation. Its category comes from the line's section
--     (Dentistry → the dental category, the lab sections and RLTC codes → the laboratory category,
--     Imaging → imaging, Nursing → nursing, Minor surgery / procedures → procedures, Consultation
--     → consultation; anything else → Other). The manager edits it like any treatment (names,
--     category, department, hidden, the clinic's own price). A clinic-wide list of medicines prices
--     the clinic's medicines by their code (the clinic's medicines stay those it stocks).
--   * use_list_prices(book, ids): the clinic's own prices of those treatments / medicines go, the
--     list's price applies (all of them on the list when ids is null).
--   * An insurer's own list (scope 'insurer') is followed by that insurer at once, first, in the
--     column chosen ("its price column"); its instructions are its exceptions unless said otherwise.
--   * tariff_link: a line of a list that names a clinic treatment or medicine by another code or by
--     its name only (an insurer's list without codes): the import links the lines it finds by
--     name; the manager links the others by hand (link_tariff_line / unlink_tariff_line). A
--     clinic-wide list links a treatment through its tariff_code (the national code).
--   * import_tariff (same arguments; p_book carries scope, payerId, privateColumn, payerColumn,
--     priority): a line without a code is found by its name on the clinic-wide lists, then among
--     the clinic's treatments / medicines, else it gets a code of its own ("L-…") and is listed to
--     link by hand. The check also says how many treatments a clinic-wide list adds to the clinic
--     (by category) and which of the clinic's own prices differ from the list's.
--   * tariff_books, tariff_lines: the scope, the private column, the order, the clinic's
--     treatments / medicines of each line with their own price; save_tariff_book_settings.
--
-- Errcodes: 42501 not allowed, 22023 bad input, P0002 not found.

-- ---------------------------------------------------------------- the kind of list
alter table tariff_book add column if not exists scope text not null default 'reference';
alter table tariff_book drop constraint if exists tariff_book_scope_check;
alter table tariff_book add constraint tariff_book_scope_check check (scope in ('clinic', 'insurer', 'reference'));
alter table tariff_book add column if not exists private_column text;
alter table tariff_book add column if not exists priority integer not null default 100;
update tariff_book set scope = 'insurer' where payer_id is not null and scope = 'reference';
comment on column tariff_book.scope is
  'clinic: the Ministry of Health''s list, for the whole clinic (private patients pay its private_column); insurer: one insurer''s own tariff (payer_id); reference: another publisher''s list insurers may follow.';

-- each version keeps the column private patients pay and the column its insurer pays: a file
-- re-issued with a reworded header does not break the version still in effect
alter table tariff_version add column if not exists private_column text;
alter table tariff_version add column if not exists payer_column text;
update tariff_version v set private_column = b.private_column
from tariff_book b where b.id = v.book_id and v.private_column is null and b.private_column is not null
  and v.columns @> jsonb_build_array(jsonb_build_object('key', b.private_column));

alter table service add column if not exists list_book_id uuid references tariff_book (id);
comment on column service.list_book_id is 'The clinic-wide price list this treatment was made from (null: created by the clinic).';

create table if not exists tariff_link (
  book_id uuid not null references tariff_book (id),
  code text not null,
  service_id uuid references service (id),
  item_id uuid references item (id),
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  check ((service_id is null) <> (item_id is null))
);
create unique index if not exists tariff_link_service_uq on tariff_link (book_id, service_id) where service_id is not null;
create unique index if not exists tariff_link_item_uq on tariff_link (book_id, item_id) where item_id is not null;
create index if not exists tariff_link_code_idx on tariff_link (book_id, code);
alter table tariff_link enable row level security;
drop policy if exists tariff_link_read on tariff_link;
create policy tariff_link_read on tariff_link for select to authenticated using (true);
revoke all on tariff_link from anon, authenticated;
grant select on tariff_link to authenticated;

-- ---------------------------------------------------------------- the code of a clinic thing on a list
-- tariff_line_code: the code a treatment or medicine has on one list: the line it is linked to on
-- that list, else the line it is linked to on a clinic-wide list (the national code), else its list
-- code (treatment) or its code (medicine).
create or replace function tariff_line_code(p_book uuid, p_service_id uuid, p_item_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select k.code from tariff_link k
     where k.book_id = p_book
       and ((p_service_id is not null and k.service_id = p_service_id)
         or (p_item_id is not null and k.item_id = p_item_id))
     limit 1),
    (select k.code from tariff_link k
     join tariff_book b on b.id = k.book_id and b.scope = 'clinic' and b.deleted_at is null
     where k.book_id <> p_book
       and ((p_service_id is not null and k.service_id = p_service_id)
         or (p_item_id is not null and k.item_id = p_item_id))
     order by b.priority, b.created_at
     limit 1),
    tariff_code_of(p_service_id, p_item_id))
$$;

-- tariff_price_for (from 20270114090000_published_price_lists): the line is found through
-- tariff_line_code (a link of that list first).
create or replace function tariff_price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, book_id uuid, code text, note text)
language sql stable security definer set search_path = public
as $$
  select round((l.prices ->> c.col)::numeric), pt.book_id, l.code, l.note
  from payer_tariff pt
  join tariff_book b on b.id = pt.book_id and b.deleted_at is null
    and b.kind = case when p_service_id is not null then 'treatments' else 'medicines' end
  join tariff_version v on v.id = tariff_version_at(pt.book_id, p_at)
  -- an insurer's own list: the column of that version; any other list: the column it chose
  cross join lateral (select coalesce(case when b.scope = 'insurer' and b.payer_id = pt.payer_id then v.payer_column end,
                                      pt.column_key) as col) c
  join tariff_line l on l.version_id = v.id
    and l.code = tariff_line_code(pt.book_id, p_service_id, p_item_id) and l.removed_at is null
  where pt.payer_id = p_payer_id and p_payer_id is not null
    and jsonb_typeof(l.prices -> c.col) = 'number'
  order by pt.priority, pt.created_at
  limit 1
$$;

-- clinic_list_price: what the clinic-wide lists say a private patient pays for a treatment or a
-- medicine on a date: the first list (by its order) whose version in effect has the line with a
-- price in its private column.
create or replace function clinic_list_price(p_service_id uuid, p_item_id uuid, p_at date default current_date)
returns table (price numeric, book_id uuid, code text)
language sql stable security definer set search_path = public
as $$
  select round((l.prices ->> c.col)::numeric), b.id, l.code
  from tariff_book b
  join tariff_version v on v.id = tariff_version_at(b.id, p_at)
  cross join lateral (select coalesce(v.private_column, b.private_column) as col) c
  join tariff_line l on l.version_id = v.id
    and l.code = tariff_line_code(b.id, p_service_id, p_item_id) and l.removed_at is null
  where b.scope = 'clinic' and b.deleted_at is null and c.col is not null
    and b.kind = case when p_service_id is not null then 'treatments' else 'medicines' end
    and (p_service_id is not null or p_item_id is not null)
    and jsonb_typeof(l.prices -> c.col) = 'number'
  order by b.priority, b.created_at
  limit 1
$$;

-- ---------------------------------------------------------------- the price and where it comes from
-- price_source_for (from 20270114090000_published_price_lists): + the insurer's exception is found
-- by the line's code on any list it follows (a link); + the cash price falls back on the clinic-wide
-- lists when the clinic set no price of its own (source 'cash' either way).
create or replace function price_source_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, source text, list_payer_id uuid, fallback boolean)
language plpgsql stable
as $$
declare
  v_cover text;
  v_ex_price numeric;
  v_price numeric;
  v_source text;
  v_payer uuid;
  v_fallback boolean := false;
  v_code text := tariff_code_of(p_service_id, p_item_id);
begin
  if p_payer_id is not null then
    -- the insurer's exception on this line (its code, or the code it is linked to on a list the
    -- insurer follows)
    select e.cover, e.price into v_cover, v_ex_price
    from tariff_exception e
    where e.payer_id = p_payer_id
      and (e.code = v_code
        or e.code in (select k.code from tariff_link k
                      join payer_tariff pt on pt.book_id = k.book_id and pt.payer_id = p_payer_id
                      where (p_service_id is not null and k.service_id = p_service_id)
                         or (p_item_id is not null and k.item_id = p_item_id)))
    order by (e.code = v_code) desc
    limit 1;

    select pli.price into v_price
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id = p_payer_id
      and pl.deleted_at is null and pli.deleted_at is null
      and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
      and ((p_service_id is not null and pli.service_id = p_service_id)
        or (p_item_id is not null and pli.item_id = p_item_id))
    order by pl.effective_from desc, pl.created_at desc
    limit 1;
    if v_price is not null then
      v_source := 'tariff';
    elsif v_ex_price is not null then
      v_price := v_ex_price;
      v_source := 'reference';
    else
      select tp.price into v_price from tariff_price_for(p_service_id, p_item_id, p_payer_id, p_at) tp;
      if v_price is not null then
        v_source := 'reference';
      elsif p_item_id is not null and exists (select 1 from payer py where py.id = p_payer_id and py.follows_reference_list) then
        select e.price into v_price
        from item i
        join medicine_reference_entry e on e.code = i.code and e.list_id = reference_list_at(p_at)
        where i.id = p_item_id and e.price is not null
        limit 1;
        if v_price is not null then
          v_source := 'reference';
        end if;
      end if;
    end if;
    if v_price is not null then
      v_payer := p_payer_id;
    end if;
  end if;
  if v_price is null then
    -- the clinic's own price, else the clinic-wide lists (the Ministry of Health's)
    select pli.price into v_price
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null
      and pl.deleted_at is null and pli.deleted_at is null
      and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
      and ((p_service_id is not null and pli.service_id = p_service_id)
        or (p_item_id is not null and pli.item_id = p_item_id))
    order by pl.effective_from desc, pl.created_at desc
    limit 1;
    if v_price is null then
      select cl.price into v_price from clinic_list_price(p_service_id, p_item_id, p_at) cl;
    end if;
    if v_price is null then
      return;
    end if;
    v_source := 'cash';
    v_payer := null;
    v_fallback := p_payer_id is not null;
  end if;
  if v_cover = 'not_covered' then
    v_source := 'excluded';
  elsif v_cover = 'preauth' then
    v_source := 'preauth';
  end if;
  return query select v_price, v_source, v_payer, v_fallback;
end
$$;


-- ---------------------------------------------------------------- the clinic's own price
-- own_cash_price: the price the clinic set itself (the cash price list), null when it follows the
-- clinic-wide list (or has no price).
create or replace function own_cash_price(p_service_id uuid, p_item_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select pli.price
  from price_list pl
  join price_list_item pli on pli.price_list_id = pl.id
  where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null
    and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
    and ((p_service_id is not null and pli.service_id = p_service_id)
      or (p_item_id is not null and pli.item_id = p_item_id))
  order by pl.effective_from desc, pl.created_at desc
  limit 1
$$;

-- cash_follows_list: a price equal to the clinic-wide list's private price (or no price at all) is
-- the list's, not the clinic's own: the clinic's own cash price rows go and the line keeps following
-- the list (a new version of the list changes it). Answers true when the line follows the list; false
-- when there is no list price for it or the price differs (the caller then keeps the clinic's price).
create or replace function cash_follows_list(p_service_id uuid, p_item_id uuid, p_price numeric)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_list numeric;
begin
  select cl.price into v_list from clinic_list_price(p_service_id, p_item_id) cl;
  if v_list is null then
    return false;
  end if;
  if p_price is not null and round(p_price) <> v_list then
    return false;
  end if;
  update price_list_item pli set deleted_at = now(), updated_at = now()
  from price_list pl
  where pli.price_list_id = pl.id and pl.payer_id is null and pli.deleted_at is null
    and ((p_service_id is not null and pli.service_id = p_service_id)
      or (p_item_id is not null and pli.item_id = p_item_id));
  return true;
end
$$;

-- set_cash_price (from 20261207090000_pharmacy_simplified): a price equal to the clinic-wide list's
-- is not written as the clinic's own (packaging, add stock, the pack price keep following the list).
create or replace function set_cash_price(p_item_id uuid, p_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
begin
  if cash_follows_list(null, p_item_id, p_price) then
    return;
  end if;
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, item_id, price) values (v_list, p_item_id, round(p_price))
  on conflict (price_list_id, item_id) where item_id is not null
  do update set price = excluded.price, deleted_at = null;
end
$$;

-- upsert_service (from 20261017180000_treatments_discounts_coverage): p_cash_price null = "use the
-- list price" (a treatment on a clinic-wide list); a price equal to the list's is the list's (hiding
-- or renaming a treatment does not freeze the Ministry's price as the clinic's own).
create or replace function upsert_service(
  p_id uuid,
  p_name_en text,
  p_group service_group,
  p_cash_price numeric,
  p_name_kin text default null,
  p_name_fr text default null,
  p_max_discount_pct numeric default 0,
  p_allow_manual boolean default false,
  p_active boolean default true,
  p_code text default null,
  p_booking_category text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_list uuid;
  v_code text := nullif(upper(trim(coalesce(p_code, ''))), '');
  v_cat text := nullif(trim(coalesce(p_booking_category, '')), '');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'the treatment needs a name' using errcode = '22023';
  end if;
  if p_cash_price is not null and p_cash_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := 'TRT-' || lpad(next_number('service_code', 0)::text, 4, '0');
    end if;
    insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price, max_discount_pct, active, booking_category)
    values (v_code, trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''),
            p_group, p_allow_manual, coalesce(p_max_discount_pct, 0), p_active, v_cat)
    returning id into v_id;
  else
    update service
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), service_group = p_group,
        allow_manual_price = p_allow_manual, max_discount_pct = coalesce(p_max_discount_pct, 0), active = p_active,
        code = coalesce(v_code, code), booking_category = v_cat
    where id = v_id;
    if not found then
      raise exception 'treatment not found' using errcode = 'P0002';
    end if;
  end if;

  if cash_follows_list(v_id, null, p_cash_price) then
    return v_id;
  end if;
  if p_cash_price is null then
    -- an existing treatment saved without a price (hidden, shown, renamed): its price stays
    if p_id is not null then
      return v_id;
    end if;
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, service_id, price) values (v_list, v_id, round(p_cash_price))
  on conflict (price_list_id, service_id) where service_id is not null
  do update set price = excluded.price, deleted_at = null;
  return v_id;
end
$$;

-- upsert_item (from 20261118090000_medicine_reference): p_price null = "use the list price" (a
-- medicine on a clinic-wide list); a price equal to the list's is the list's.
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
  if p_price is not null and p_price < 0 then
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
  if cash_follows_list(null, v_id, p_price) then
    return v_id;
  end if;
  if p_price is null then
    -- an existing medicine saved without a price: its price stays
    if p_id is not null then
      return v_id;
    end if;
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
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

-- ---------------------------------------------------------------- the lines become treatments
-- tariff_category_for: the category of a treatment made from a line, by the line's section (and the
-- lab code RLTC-): laboratory, imaging, dental, nursing, procedures, consultation, else Other. The
-- starting categories are found by their group, as the category trigger does.
create or replace function tariff_category_for(p_section text, p_code text)
returns uuid
language sql stable security definer set search_path = public
as $$
  with g as (
    select case
      when upper(coalesce(p_code, '')) like 'RLTC-%'
        or coalesce(p_section, '') ~* 'lab|bacterio|biochem|chemistr|h(a)?emato|serolog|immuno|molecul|parasit|patholog|microbio'
        then 'lab'
      when coalesce(p_section, '') ~* 'imaging|ultrasound|ultra-sound|echo|radiolog|x-?ray|scan' then 'imaging'
      when coalesce(p_section, '') ~* 'dent|oral' then 'dental'
      when coalesce(p_section, '') ~* 'nurs' then 'nursing'
      when coalesce(p_section, '') ~* 'surg|procedure|ob[ /-]*gyn|gyn(a)?ecol|obstet|\yent\y|dermat|emergency|critical' then 'procedure'
      when coalesce(p_section, '') ~* 'consult|mental|psych' then 'consultation'
      else 'other'
    end::service_group as grp
  )
  select coalesce(
    (select c.id from service_category c, g where c.base_group = g.grp and c.deleted_at is null order by c.sort limit 1),
    (select c.id from service_category c where c.base_group = 'other' and c.deleted_at is null order by c.sort limit 1))
$$;

-- tariff_line_in_clinic: a line of a clinic-wide list is already a treatment of the clinic (by its
-- list code or its own code, hidden or taken away by the manager included: it is not made again).
create or replace function tariff_line_in_clinic(p_book uuid, p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from service s where tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = p_code)
      or exists (select 1 from tariff_link k where k.book_id = p_book and k.code = p_code and k.service_id is not null)
$$;

-- tariff_make_services: every line of a version of a clinic-wide list of treatments that is not yet
-- a treatment of the clinic becomes one (its name, its code as list code, its category by section;
-- active; no department: everyone sees it; no booking category: not on the public site; no price of
-- the clinic: it follows the list). Answers how many were made.
create or replace function tariff_make_services(p_book uuid, p_version uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer := 0;
  r record;
  v_code text;
  v_cat uuid;
  v_grp service_group;
  v_col text;
  v_live boolean;
begin
  select coalesce(v.private_column, b.private_column), v.id = tariff_version_at(b.id, current_date)
  into v_col, v_live
  from tariff_version v join tariff_book b on b.id = v.book_id
  where v.id = p_version;
  for r in
    select l.* from tariff_line l
    where l.version_id = p_version and l.removed_at is null and not tariff_line_in_clinic(p_book, l.code)
    order by l.row nulls last, l.code
  loop
    v_cat := tariff_category_for(r.section, r.code);
    select case when c.kind in ('lab', 'imaging', 'bed') then c.kind::text::service_group
                else coalesce(c.base_group, 'other'::service_group) end
    into v_grp from service_category c where c.id = v_cat;
    v_code := left(r.code, 40);
    if exists (select 1 from service s where s.code = v_code) then
      v_code := left(r.code, 33) || '-' || upper(substr(md5(p_book::text || r.code), 1, 6));
    end if;
    insert into service (code, name_en, service_group, category_id, tariff_code, list_book_id, active)
    values (v_code, left(r.name, 200), coalesce(v_grp, 'other'::service_group), v_cat, r.code, p_book,
            coalesce(v_live, false) and v_col is not null and jsonb_typeof(r.prices -> v_col) = 'number');
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- the Prices page sees both prices
-- catalogue_services (from 20261101090000_category_desks): + the treatment's list code, the price the
-- clinic-wide lists give it, the clinic's own price (null: it follows the list) and that list.
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name,
         coalesce((select array_agg(sd.department_id order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_ids,
         coalesce((select array_agg(dd.name order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_names,
         s.category_id,
         coalesce(c.order_station,
                  case s.service_group when 'lab' then 'laboratory'::station when 'imaging' then 'ultrasound'::station end)
           as order_station,
         s.tariff_code,
         lp.price as list_price,
         own_cash_price(s.id, null) as own_price,
         lp.book_id as list_id,
         (select b.name from tariff_book b where b.id = lp.book_id) as list_name
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  left join service_category c on c.id = s.category_id
  left join lateral (select cl.price, cl.book_id from clinic_list_price(s.id, null) cl) lp on true
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

-- items_catalogue (from 20261115090000_medicines_list_pharmacy): + the price the clinic-wide lists
-- give the medicine, the clinic's own price and that list.
create or replace view items_catalogue with (security_invoker = true) as
  select i.id, i.code, i.name_generic, i.name_brand, i.strength, i.form, i.unit, i.selling_unit, i.controlled, i.active,
         (select pf.price from price_for(null, i.id, null) pf) as cash_price,
         i.atc_group, i.prescribing_rule,
         lp.price as list_price,
         own_cash_price(null, i.id) as own_price,
         lp.book_id as list_id,
         (select b.name from tariff_book b where b.id = lp.book_id) as list_name
  from item i
  left join lateral (select cl.price, cl.book_id from clinic_list_price(null, i.id) cl) lp on true
  where i.deleted_at is null;
revoke all on items_catalogue from anon;
grant select on items_catalogue to authenticated;

-- ---------------------------------------------------------------- back to the list's price
-- use_list_prices: the clinic's own prices of the treatments / medicines on a clinic-wide list (those
-- ids, or all of them) go: they take the list's price again. Answers how many.
create or replace function use_list_prices(p_book uuid, p_ids uuid[] default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_ver uuid;
  v_n integer := 0;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_book from tariff_book where id = p_book and deleted_at is null;
  if not found or v_book.scope <> 'clinic' then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  v_ver := tariff_version_at(p_book, current_date);
  v_book.private_column := coalesce((select v.private_column from tariff_version v where v.id = v_ver), v_book.private_column);
  update price_list_item pli set deleted_at = now(), updated_at = now()
  from price_list pl
  where pli.price_list_id = pl.id and pl.payer_id is null and pli.deleted_at is null
    and (
      (v_book.kind = 'treatments' and pli.service_id is not null
        and (p_ids is null or pli.service_id = any (p_ids))
        and exists (select 1 from tariff_line l where l.version_id = v_ver and l.removed_at is null
                      and jsonb_typeof(l.prices -> v_book.private_column) = 'number'
                      and l.code = tariff_line_code(p_book, pli.service_id, null)))
      or (v_book.kind = 'medicines' and pli.item_id is not null
        and (p_ids is null or pli.item_id = any (p_ids))
        and exists (select 1 from tariff_line l where l.version_id = v_ver and l.removed_at is null
                      and jsonb_typeof(l.prices -> v_book.private_column) = 'number'
                      and l.code = tariff_line_code(p_book, null, pli.item_id))));
  get diagnostics v_n = row_count;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'tariff_book', p_book,
          jsonb_build_object('list', v_book.name, 'useListPrices', v_n, 'only', p_ids));
  return v_n;
end
$$;

-- ---------------------------------------------------------------- a line linked by hand
-- link_tariff_line: this line of the list is that treatment / medicine of the clinic (an insurer's
-- list without codes, a name written otherwise). On a clinic-wide list a treatment takes the line's
-- code as its list code; otherwise the link belongs to the list.
create or replace function link_tariff_line(p_book uuid, p_code text, p_service_id uuid, p_item_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_code text := tariff_code_norm(p_code);
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_book from tariff_book where id = p_book and deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  if v_code is null or length(v_code) > 40 then
    raise exception 'give the line a code' using errcode = '22023';
  end if;
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  if (p_service_id is not null and (v_book.kind <> 'treatments'
        or not exists (select 1 from service where id = p_service_id and deleted_at is null)))
     or (p_item_id is not null and (v_book.kind <> 'medicines'
        or not exists (select 1 from item where id = p_item_id and deleted_at is null))) then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;
  if v_book.scope = 'clinic' and p_service_id is not null then
    update service set tariff_code = v_code, updated_at = now() where id = p_service_id;
    delete from tariff_link where book_id = p_book and service_id = p_service_id;
    -- the treatment made from this line is the same act as the one linked: it goes (kept in the
    -- history; not made again)
    update service s set active = false, deleted_at = now(), updated_at = now()
    where s.list_book_id = p_book and s.id <> p_service_id and s.deleted_at is null
      and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = v_code;
  elsif p_service_id is not null then
    insert into tariff_link (book_id, code, service_id, created_by) values (p_book, v_code, p_service_id, auth.uid())
    on conflict (book_id, service_id) where service_id is not null do update set code = excluded.code;
  else
    insert into tariff_link (book_id, code, item_id, created_by) values (p_book, v_code, p_item_id, auth.uid())
    on conflict (book_id, item_id) where item_id is not null do update set code = excluded.code;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'tariff_link', p_book,
          jsonb_build_object('list', v_book.name, 'code', v_code, 'serviceId', p_service_id, 'itemId', p_item_id));
end
$$;

-- unlink_tariff_line: the link goes (a clinic-wide list: the treatment's list code goes too, unless
-- the treatment was made from that list).
create or replace function unlink_tariff_line(p_book uuid, p_service_id uuid, p_item_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_book from tariff_book where id = p_book and deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  delete from tariff_link
  where book_id = p_book
    and ((p_service_id is not null and service_id = p_service_id) or (p_item_id is not null and item_id = p_item_id));
  if v_book.scope = 'clinic' and p_service_id is not null then
    update service set tariff_code = null, updated_at = now()
    where id = p_service_id and list_book_id is distinct from p_book and tariff_code is not null;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'tariff_link', p_book,
          jsonb_build_object('list', v_book.name, 'unlinked', true, 'serviceId', p_service_id, 'itemId', p_item_id));
end
$$;

-- save_tariff_book_settings: a clinic-wide list's private column and order; an insurer's own list's
-- column (the column that insurer pays).
create or replace function save_tariff_book_settings(
  p_id uuid,
  p_private_column text default null,
  p_priority integer default null,
  p_payer_column text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_cols jsonb;
  v_private text := nullif(lower(trim(coalesce(p_private_column, ''))), '');
  v_payer_col text := nullif(lower(trim(coalesce(p_payer_column, ''))), '');
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_book from tariff_book where id = p_id and deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  select v.columns into v_cols from tariff_version v where v.book_id = p_id and v.status = 'current';
  if v_book.scope = 'clinic' then
    if v_private is not null and not coalesce(v_cols, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('key', v_private)) then
      raise exception 'this price column is not in the list' using errcode = '22023';
    end if;
    if p_priority is not null and (p_priority < 0 or p_priority > 9999) then
      raise exception 'the order is a number from 0 to 9999' using errcode = '22023';
    end if;
    update tariff_book
    set private_column = coalesce(v_private, private_column), priority = coalesce(p_priority, priority)
    where id = p_id;
    if v_private is not null then
      update tariff_version set private_column = v_private
      where book_id = p_id and columns @> jsonb_build_array(jsonb_build_object('key', v_private));
    end if;
  elsif v_book.scope = 'insurer' and v_payer_col is not null then
    if not coalesce(v_cols, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('key', v_payer_col)) then
      raise exception 'this price column is not in the list' using errcode = '22023';
    end if;
    insert into payer_tariff (payer_id, book_id, column_key, priority, created_by)
    values (v_book.payer_id, p_id, v_payer_col, 0, auth.uid())
    on conflict (payer_id, book_id) do update set column_key = excluded.column_key;
    update tariff_version set payer_column = v_payer_col
    where book_id = p_id and columns @> jsonb_build_array(jsonb_build_object('key', v_payer_col));
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'tariff_book', p_id,
          jsonb_build_object('privateColumn', v_book.private_column, 'priority', v_book.priority),
          jsonb_build_object('privateColumn', v_private, 'priority', p_priority, 'payerColumn', v_payer_col));
end
$$;


-- ---------------------------------------------------------------- the upload and its check
-- import_tariff (from 20270114090000_published_price_lists): a new list (p_book {name, publisher,
-- kind, scope clinic | insurer | reference, payerId, privateColumn, payerColumn, priority}) or a new
-- version of a list (p_book_id; p_book may carry privateColumn / payerColumn for it). A line without
-- a code is found by its name (the clinic-wide lists, then the clinic's treatments / medicines),
-- else it gets a code of its own ("L-…") and is listed to link by hand. A clinic-wide list of
-- treatments makes every line a treatment of the clinic; an insurer's own list is followed by that
-- insurer, first, in its column. Lines found by name are linked (a clinic-wide list of treatments:
-- the treatment's list code). p_columns [{key, label}] are the price columns of the file; p_lines
-- [{row, code, name, detail, section, altCode, unit, note, prices: {key: number | text | null}}].
-- p_instructions_payer: the instructions (note) of the file are this insurer's: they become its
-- exceptions on this list (a typed exception is kept). The dry run stores nothing; the real run
-- keeps the valid lines as the version in use from p_from (the previous one is kept, past),
-- links the clinic's treatments found by name and writes the exceptions.
create or replace function import_tariff(
  p_book_id uuid,
  p_book jsonb,
  p_name text,
  p_from date,
  p_columns jsonb,
  p_lines jsonb,
  p_instructions_payer uuid default null,
  p_file_name text default null,
  p_notes text default null,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_bname text;
  v_publisher text;
  v_kind text;
  v_bpayer uuid;
  v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_cur tariff_version%rowtype;
  v_col jsonb;
  v_keys text[] := '{}';
  v_cols jsonb := '[]'::jsonb;
  v_key text;
  v_label text;
  v_r jsonb;
  v_n integer;
  v_row integer;
  v_code text;
  v_lname text;
  v_err text;
  v_errors jsonb := '[]'::jsonb;
  v_n_errors integer := 0;
  v_warnings jsonb := '[]'::jsonb;
  v_n_warnings integer := 0;
  v_prices jsonb;
  v_val jsonb;
  v_txt text;
  v_p numeric;
  v_any boolean;
  v_valid integer;
  v_new jsonb := '[]'::jsonb;
  v_n_new integer := 0;
  v_changed jsonb := '[]'::jsonb;
  v_n_changed integer := 0;
  v_n_changes integer := 0;
  v_removed jsonb := '[]'::jsonb;
  v_n_removed integer := 0;
  v_unchanged integer := 0;
  v_renamed jsonb := '[]'::jsonb;
  v_edited jsonb := '[]'::jsonb;
  v_cols_added jsonb := '[]'::jsonb;
  v_cols_gone jsonb := '[]'::jsonb;
  v_by_code jsonb := '[]'::jsonb;
  v_by_name jsonb := '[]'::jsonb;
  v_gone_clinic jsonb := '[]'::jsonb;
  v_followers jsonb := '[]'::jsonb;
  v_ex_removed jsonb := '[]'::jsonb;
  v_own jsonb := '[]'::jsonb;
  v_ex_prices jsonb := '[]'::jsonb;
  v_instr jsonb := null;
  v_instr_lines jsonb := '[]'::jsonb;
  v_ipayer payer%rowtype;
  v_kept_typed integer := 0;
  v_dropped integer := 0;
  v_version uuid;
  v_linked integer := 0;
  v_summary jsonb;
  v_cap constant integer := 500;
  v_scope text;
  v_private text;
  v_payer_col text;
  v_priority integer;
  v_found text;
  v_found_n integer;
  v_by text;
  v_name_list integer := 0;
  v_name_clinic integer := 0;
  v_not_found jsonb := '[]'::jsonb;
  v_n_not_found integer := 0;
  v_to_create integer := 0;
  v_to_create_cat jsonb := '[]'::jsonb;
  v_created integer := 0;
  v_own_clinic jsonb := '[]'::jsonb;
  v_n_own_clinic integer := 0;
  v_svc uuid;
  v_itm uuid;
  v_k integer := 0;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'the list has no rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 20000 then
    raise exception 'the list has too many rows' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'give the list a name' using errcode = '22023';
  end if;
  if p_from is null then
    raise exception 'give the date the list starts' using errcode = '22023';
  end if;

  -- the list: an existing one (a new version) or a new one
  if p_book_id is not null then
    select * into v_book from tariff_book where id = p_book_id and deleted_at is null;
    if not found then
      raise exception 'price list not found' using errcode = 'P0002';
    end if;
    select * into v_cur from tariff_version where book_id = v_book.id and status = 'current';
    if v_cur.id is not null and p_from < v_cur.effective_from then
      raise exception 'the new version cannot start before the one in use' using errcode = '22023';
    end if;
    v_kind := v_book.kind;
    v_scope := v_book.scope;
    v_bpayer := v_book.payer_id;
    v_private := coalesce(nullif(p_book ->> 'privateColumn', ''), v_book.private_column);
    v_payer_col := nullif(p_book ->> 'payerColumn', '');
    if v_scope = 'insurer' and v_payer_col is null then
      select pt.column_key into v_payer_col from payer_tariff pt
      where pt.book_id = v_book.id and pt.payer_id = v_book.payer_id;
    end if;
    v_priority := v_book.priority;
  else
    v_bname := nullif(regexp_replace(trim(coalesce(p_book ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_publisher := nullif(regexp_replace(trim(coalesce(p_book ->> 'publisher', '')), '\s+', ' ', 'g'), '');
    v_kind := p_book ->> 'kind';
    if v_bname is null or length(v_bname) > 120 then
      raise exception 'give the price list a name' using errcode = '22023';
    end if;
    if v_publisher is null or length(v_publisher) > 80 then
      raise exception 'say who publishes the list' using errcode = '22023';
    end if;
    if v_kind is null or v_kind not in ('treatments', 'medicines') then
      raise exception 'say whether the list is of treatments or of medicines' using errcode = '22023';
    end if;
    if exists (select 1 from tariff_book b where lower(b.name) = lower(v_bname) and b.deleted_at is null) then
      raise exception 'a price list with this name already exists' using errcode = '22023';
    end if;
    if coalesce(p_book ->> 'payerId', '') <> '' then
      if (p_book ->> 'payerId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'insurer not found' using errcode = 'P0002';
      end if;
      v_bpayer := (p_book ->> 'payerId')::uuid;
      if not exists (select 1 from payer where id = v_bpayer and deleted_at is null and type <> 'cash') then
        raise exception 'insurer not found' using errcode = 'P0002';
      end if;
    end if;
    v_scope := coalesce(nullif(p_book ->> 'scope', ''), case when v_bpayer is not null then 'insurer' else 'reference' end);
    if v_scope not in ('clinic', 'insurer', 'reference') then
      raise exception 'say whose list it is' using errcode = '22023';
    end if;
    if v_scope = 'insurer' and v_bpayer is null then
      raise exception 'choose the insurer whose list it is' using errcode = '22023';
    end if;
    if v_scope <> 'insurer' then
      v_bpayer := null;
    end if;
    v_private := nullif(p_book ->> 'privateColumn', '');
    v_payer_col := nullif(p_book ->> 'payerColumn', '');
    v_priority := case when coalesce(p_book ->> 'priority', '') ~ '^\d{1,4}$' then (p_book ->> 'priority')::integer
                       else (select coalesce(max(b.priority), 0) + 10 from tariff_book b
                             where b.scope = 'clinic' and b.kind = v_kind and b.deleted_at is null) end;
  end if;

  -- the price columns
  if p_columns is null or jsonb_typeof(p_columns) <> 'array' or jsonb_array_length(p_columns) = 0
     or jsonb_array_length(p_columns) > 12 then
    raise exception 'the list has no price column' using errcode = '22023';
  end if;
  for v_col in select x.value from jsonb_array_elements(p_columns) x loop
    v_key := lower(trim(coalesce(v_col ->> 'key', '')));
    v_label := nullif(regexp_replace(trim(coalesce(v_col ->> 'label', '')), '\s+', ' ', 'g'), '');
    if v_key !~ '^[a-z0-9_]{1,40}$' or v_label is null or length(v_label) > 80 or v_key = any (v_keys) then
      raise exception 'a price column has no name, or the same name twice' using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
    v_cols := v_cols || jsonb_build_array(jsonb_build_object('key', v_key, 'label', v_label));
  end loop;

  -- the column private patients pay (a clinic-wide list), the insurer's column (its own list)
  if v_scope = 'clinic' then
    v_private := lower(v_private);
    if v_private is null or not v_private = any (v_keys) then
      raise exception 'choose the column private patients pay' using errcode = '22023';
    end if;
  elsif v_scope = 'insurer' then
    v_payer_col := lower(coalesce(v_payer_col, case when array_length(v_keys, 1) = 1 then v_keys[1] end));
    if v_payer_col is null or not v_payer_col = any (v_keys) then
      raise exception 'choose the insurer''s price column' using errcode = '22023';
    end if;
  end if;

  -- whose instructions
  if p_instructions_payer is not null then
    select * into v_ipayer from payer where id = p_instructions_payer and deleted_at is null and type <> 'cash';
    if not found then
      raise exception 'insurer not found' using errcode = 'P0002';
    end if;
  end if;

  create temp table if not exists _tl_import (
    code text primary key,
    row integer,
    name text not null,
    norm text,
    detail text,
    section text,
    alt_code text,
    unit text,
    prices jsonb not null,
    note text,
    svc_id uuid,
    itm_id uuid
  ) on commit drop;
  truncate _tl_import;
  create temp table if not exists _tl_link (
    service_id uuid,
    item_id uuid,
    code text not null
  ) on commit drop;
  truncate _tl_link;
  create temp table if not exists _tl_names (
    norm text not null,
    code text,
    svc uuid,
    itm uuid,
    src text not null
  ) on commit drop;
  truncate _tl_names;
  if exists (select 1 from jsonb_array_elements(p_lines) x
             where jsonb_typeof(x.value) = 'object' and tariff_code_norm(x.value ->> 'code') is null) then
    -- the clinic-wide lists' names (one code each)
    insert into _tl_names (norm, code, src)
    select tariff_norm(l.name), min(l.code), 'list'
    from tariff_line l
    join tariff_version tv on tv.id = l.version_id and tv.status = 'current'
    join tariff_book b on b.id = tv.book_id and b.scope = 'clinic' and b.kind = v_kind and b.deleted_at is null
    where l.removed_at is null and b.id is distinct from v_book.id and tariff_norm(l.name) is not null
    group by 1
    having count(distinct l.code) = 1;
    -- the clinic's treatments / medicines by their names (one each)
    if v_kind = 'treatments' then
      insert into _tl_names (norm, code, svc, src)
      select x.norm, min(tariff_code_of(x.id, null)), min(x.id::text)::uuid, 'clinic'
      from (select s.id, tariff_norm(s.name_en) as norm from service s where s.deleted_at is null
            union
            select s.id, tariff_norm(s.name_fr) from service s where s.deleted_at is null and s.name_fr is not null) x
      where x.norm is not null
      group by x.norm
      having count(distinct x.id) = 1;
    else
      insert into _tl_names (norm, code, itm, src)
      select x.norm, min(tariff_code_norm(i.code)), min(x.id::text)::uuid, 'clinic'
      from (select i.id, tariff_norm(i.name_generic || coalesce(' ' || i.strength, '')) as norm
            from item i where i.deleted_at is null
            union
            select i.id, tariff_norm(i.name_generic) from item i where i.deleted_at is null) x
      join item i on i.id = x.id
      where x.norm is not null
      group by x.norm
      having count(distinct x.id) = 1;
    end if;
    create index if not exists _tl_names_norm on _tl_names (norm, src);
  end if;

  for v_r, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    v_err := null;
    v_row := v_n;
    if jsonb_typeof(v_r) <> 'object' then
      v_n_errors := v_n_errors + 1;
      if jsonb_array_length(v_errors) < v_cap then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', v_row, 'code', 'not_a_row', 'value', null));
      end if;
      continue;
    end if;
    if coalesce(v_r ->> 'row', '') ~ '^\d{1,7}$' then
      v_row := (v_r ->> 'row')::integer;
    end if;
    v_code := tariff_code_norm(v_r ->> 'code');
    v_lname := nullif(regexp_replace(trim(coalesce(v_r ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_by := null;
    v_svc := null;
    v_itm := null;
    if v_code is null and v_lname is not null then
      -- no code: found by its name on the clinic-wide lists, then among the clinic's treatments /
      -- medicines (tied to it); else a code of its own made of its name, detail, unit and section
      -- (two strengths of one medicine stay two lines), to link by hand
      select t.code into v_found from _tl_names t where t.norm = tariff_norm(v_lname) and t.src = 'list';
      if v_found is not null then
        v_code := v_found;
        v_by := 'list';
      else
        select t.code, t.svc, t.itm into v_found, v_svc, v_itm
        from _tl_names t where t.norm = tariff_norm(v_lname) and t.src = 'clinic';
        if v_found is not null then
          v_code := v_found;
          v_by := 'clinic';
        else
          v_code := 'L-' || upper(substr(md5(concat_ws('|', coalesce(tariff_norm(v_lname), v_lname),
                                                       tariff_norm(v_r ->> 'detail'), tariff_norm(v_r ->> 'unit'),
                                                       tariff_norm(v_r ->> 'section'))), 1, 8));
          v_by := 'none';
        end if;
      end if;
    end if;
    if v_code is null then
      v_err := 'no_code';
    elsif length(v_code) > 40 then
      v_err := 'bad_code';
    elsif v_lname is null then
      v_err := 'no_name';
    elsif exists (select 1 from _tl_import where code = v_code) then
      v_err := 'duplicate';
    end if;
    if v_err is not null then
      v_n_errors := v_n_errors + 1;
      if jsonb_array_length(v_errors) < v_cap then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', v_row, 'code', v_err,
          'value', case when v_err = 'no_name' then v_code else left(v_r ->> 'code', 60) end,
          'name', left(v_lname, 120)));
      end if;
      continue;
    end if;
    -- the prices: a number zero or more (rounded to the franc), empty, or a warning
    v_prices := '{}'::jsonb;
    v_any := false;
    foreach v_key in array v_keys loop
      v_val := (v_r -> 'prices') -> v_key;
      v_p := null;
      if v_val is not null and jsonb_typeof(v_val) <> 'null' then
        v_txt := case when jsonb_typeof(v_val) = 'number' then v_val::text
                      else nullif(regexp_replace(trim(v_val #>> '{}'), '[\s,]', '', 'g'), '') end;
        if v_txt is null then
          null;
        elsif v_txt ~ '^\d{1,10}(\.\d+)?$' then
          v_p := round(v_txt::numeric);
          v_any := true;
          if v_p = 0 then
            v_n_warnings := v_n_warnings + 1;
            if jsonb_array_length(v_warnings) < v_cap then
              v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('row', v_row, 'code', 'zero_price',
                'line', v_code, 'name', left(v_lname, 120), 'column', v_key, 'value', '0'));
            end if;
          end if;
        else
          v_n_warnings := v_n_warnings + 1;
          if jsonb_array_length(v_warnings) < v_cap then
            v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('row', v_row, 'code', 'bad_price',
              'line', v_code, 'name', left(v_lname, 120), 'column', v_key, 'value', left(v_val #>> '{}', 60)));
          end if;
        end if;
      end if;
      v_prices := v_prices || jsonb_build_object(v_key, v_p);
    end loop;
    if not v_any then
      v_n_warnings := v_n_warnings + 1;
      if jsonb_array_length(v_warnings) < v_cap then
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('row', v_row, 'code', 'no_price',
          'line', v_code, 'name', left(v_lname, 120), 'column', null, 'value', null));
      end if;
    end if;
    insert into _tl_import (code, row, name, norm, detail, section, alt_code, unit, prices, note, svc_id, itm_id)
    values (v_code, v_row, left(v_lname, 300), tariff_norm(v_lname),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'detail', '')), '\s+', ' ', 'g'), ''), 300),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'section', '')), '\s+', ' ', 'g'), ''), 200),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'altCode', '')), '\s+', ' ', 'g'), ''), 60),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'unit', '')), '\s+', ' ', 'g'), ''), 60),
            v_prices,
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'note', '')), '\s+', ' ', 'g'), ''), 500),
            v_svc, v_itm);
    if v_by = 'list' then
      v_name_list := v_name_list + 1;
    elsif v_by = 'clinic' then
      v_name_clinic := v_name_clinic + 1;
    elsif v_by = 'none' then
      v_n_not_found := v_n_not_found + 1;
      if jsonb_array_length(v_not_found) < v_cap then
        v_not_found := v_not_found || jsonb_build_array(jsonb_build_object('row', v_row, 'name', left(v_lname, 120), 'code', v_code));
      end if;
    end if;
  end loop;
  select count(*)::int into v_valid from _tl_import;

  -- ---- against the version in use
  if v_cur.id is not null then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'prices', n.prices)
                                             order by n.name, n.code) filter (where n.rn <= v_cap), '[]'::jsonb)
    into v_n_new, v_new
    from (select n.*, row_number() over (order by n.name, n.code) as rn
          from _tl_import n
          where not exists (select 1 from tariff_line e where e.version_id = v_cur.id and e.code = n.code
                              and e.removed_at is null)) n;

    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('code', e.code, 'name', e.name,
             'inClinic', case v_kind
               when 'treatments' then exists (select 1 from service s where s.deleted_at is null
                                               and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = e.code)
               else exists (select 1 from item i where i.deleted_at is null and tariff_code_norm(i.code) = e.code) end)
             order by e.name, e.code) filter (where e.rn <= v_cap), '[]'::jsonb)
    into v_n_removed, v_removed
    from (select e.*, row_number() over (order by e.name, e.code) as rn
          from tariff_line e
          where e.version_id = v_cur.id and e.removed_at is null
            and not exists (select 1 from _tl_import n where n.code = e.code)) e;

    with c as (
      select n.code, n.name, k.key, k.label, k.ord,
             (e.prices ->> k.key)::numeric as old, (n.prices ->> k.key)::numeric as new
      from _tl_import n
      join tariff_line e on e.version_id = v_cur.id and e.code = n.code and e.removed_at is null
      cross join lateral (select x.value ->> 'key' as key, x.value ->> 'label' as label, x.ordinality as ord
                          from jsonb_array_elements(v_cols) with ordinality x) k
      where v_cur.columns @> jsonb_build_array(jsonb_build_object('key', k.key))
        and (e.prices ->> k.key) is distinct from (n.prices ->> k.key)
    ), r as (
      select c.*, row_number() over (order by c.name, c.code, c.ord) as rn from c
    )
    select count(distinct r.code)::int, count(*)::int,
           coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name, 'column', r.key, 'label', r.label,
                                                 'old', r.old, 'new', r.new)
                              order by r.name, r.code, r.ord) filter (where r.rn <= 1000), '[]'::jsonb)
    into v_n_changed, v_n_changes, v_changed
    from r;

    select count(*)::int into v_unchanged
    from _tl_import n
    join tariff_line e on e.version_id = v_cur.id and e.code = n.code and e.removed_at is null
    where not exists (
      select 1 from jsonb_array_elements(v_cols) x
      where v_cur.columns @> jsonb_build_array(jsonb_build_object('key', x.value ->> 'key'))
        and (e.prices ->> (x.value ->> 'key')) is distinct from (n.prices ->> (x.value ->> 'key')));

    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'old', e.name, 'new', n.name) order by n.name), '[]'::jsonb)
    into v_renamed
    from (select n.*, row_number() over (order by n.name) as rn from _tl_import n) n
    join tariff_line e on e.version_id = v_cur.id and e.code = n.code and e.removed_at is null
    where tariff_norm(e.name) is distinct from n.norm;
    if jsonb_array_length(v_renamed) > v_cap then
      v_renamed := (select jsonb_agg(x.value) from jsonb_array_elements(v_renamed) with ordinality x where x.ordinality <= v_cap);
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('code', e.code, 'name', e.name, 'editedAt', e.edited_at,
                                                 'editedBy', pr.full_name, 'added', coalesce((e.original ->> 'added')::boolean, false))
                              order by e.name), '[]'::jsonb)
    into v_edited
    from tariff_line e
    left join profiles pr on pr.id = e.edited_by
    where e.version_id = v_cur.id and (e.edited_at is not null or e.removed_at is not null);

    select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_cols_added
    from jsonb_array_elements(v_cols) x
    where not v_cur.columns @> jsonb_build_array(jsonb_build_object('key', x.value ->> 'key'));
    select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_cols_gone
    from jsonb_array_elements(v_cur.columns) x
    where not (x.value ->> 'key') = any (v_keys);
  else
    v_n_new := v_valid;
  end if;

  -- ---- the clinic's treatments or medicines on the list
  if v_kind = 'treatments' then
    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'id', s.id, 'clinicName', s.name_en,
                                                 'active', s.active) order by n.name), '[]'::jsonb)
    into v_by_code
    from _tl_import n
    join service s on s.deleted_at is null
      and (tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = n.code
        or exists (select 1 from tariff_link k where k.book_id = v_book.id and k.service_id = s.id and k.code = n.code));

    -- by name: a treatment with no list code, not already on the list by its own code, whose name
    -- is the name of exactly one line no other treatment has
    insert into _tl_link (service_id, code)
    with sn as (
      select s.id, tariff_norm(s.name_en) as norm from service s
      where s.deleted_at is null and (v_scope <> 'clinic' or coalesce(s.tariff_code, '') = '')
      union
      select s.id, tariff_norm(s.name_fr) from service s
      where s.deleted_at is null and s.name_fr is not null and (v_scope <> 'clinic' or coalesce(s.tariff_code, '') = '')
    ), cand as (
      select sn.id, n.code
      from sn
      join _tl_import n on n.norm is not null and n.norm = sn.norm
      where not exists (select 1 from _tl_import m where m.code = tariff_code_of(sn.id, null))
        and not exists (select 1 from tariff_link k where k.book_id = v_book.id and k.service_id = sn.id)
    )
    select c.id, min(c.code)
    from cand c
    where (select count(distinct c2.code) from cand c2 where c2.id = c.id) = 1
      and (select count(distinct c3.id) from cand c3 where c3.code = c.code) = 1
      and not exists (select 1 from service s2 where s2.deleted_at is null
                        and tariff_code_norm(coalesce(nullif(s2.tariff_code, ''), s2.code)) = c.code)
      and not exists (select 1 from tariff_link k where k.book_id = v_book.id and k.code = c.code and k.service_id is not null)
    group by c.id;

    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'id', s.id, 'clinicName', s.name_en,
                                                 'active', s.active) order by n.name), '[]'::jsonb)
    into v_by_name
    from _tl_link k
    join service s on s.id = k.service_id
    join _tl_import n on n.code = k.code;

    select coalesce(jsonb_agg(jsonb_build_object('code', tariff_code_norm(s.tariff_code), 'id', s.id,
                                                 'clinicName', s.name_en) order by s.name_en), '[]'::jsonb)
    into v_gone_clinic
    from service s
    where s.deleted_at is null and coalesce(s.tariff_code, '') <> ''
      and not exists (select 1 from _tl_import n where n.code = tariff_code_norm(s.tariff_code))
      and v_cur.id is not null
      and exists (select 1 from tariff_line e where e.version_id = v_cur.id and e.removed_at is null
                    and e.code = tariff_code_norm(s.tariff_code));
  else
    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'id', i.id,
                                                 'clinicName', i.name_generic || coalesce(' ' || i.strength, ''),
                                                 'active', i.active) order by n.name), '[]'::jsonb)
    into v_by_code
    from _tl_import n
    join item i on i.deleted_at is null
      and (tariff_code_norm(i.code) = n.code
        or exists (select 1 from tariff_link k where k.book_id = v_book.id and k.item_id = i.id and k.code = n.code));

    -- by name: a medicine not on the list by its code, whose name (with its strength) is the name of
    -- exactly one line no other medicine has
    insert into _tl_link (item_id, code)
    with cand as (
      select i.id, n.code
      from item i
      join _tl_import n on n.norm is not null
        and (n.norm = tariff_norm(i.name_generic || coalesce(' ' || i.strength, '')))
      where i.deleted_at is null
        and not exists (select 1 from _tl_import m where m.code = tariff_code_norm(i.code))
        and not exists (select 1 from tariff_link k where k.book_id = v_book.id and k.item_id = i.id)
    )
    select c.id, min(c.code)
    from cand c
    where (select count(distinct c2.code) from cand c2 where c2.id = c.id) = 1
      and (select count(distinct c3.id) from cand c3 where c3.code = c.code) = 1
    group by c.id;

    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'id', i.id,
                                                 'clinicName', i.name_generic || coalesce(' ' || i.strength, ''),
                                                 'active', i.active) order by n.name), '[]'::jsonb)
    into v_by_name
    from _tl_link k
    join item i on i.id = k.item_id
    join _tl_import n on n.code = k.code;

    if v_cur.id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'id', i.id,
                                                   'clinicName', i.name_generic || coalesce(' ' || i.strength, ''))
                                order by i.name_generic), '[]'::jsonb)
      into v_gone_clinic
      from item i
      where i.deleted_at is null
        and exists (select 1 from tariff_line e where e.version_id = v_cur.id and e.code = tariff_code_norm(i.code)
                      and e.removed_at is null)
        and not exists (select 1 from _tl_import n where n.code = tariff_code_norm(i.code));
    end if;
  end if;

  -- ---- a clinic-wide list: the treatments it adds to the clinic, the clinic's own prices that differ
  if v_scope = 'clinic' then
    if v_kind = 'treatments' then
      select count(*)::int,
             coalesce((select jsonb_agg(jsonb_build_object('category', x.category, 'count', x.n) order by x.n desc, x.category)
                       from (select coalesce(c.name_en, 'Other') as category, count(*)::int as n
                             from _tl_import n2
                             left join service_category c on c.id = tariff_category_for(n2.section, n2.code)
                             where not tariff_line_in_clinic(v_book.id, n2.code)
                               and not exists (select 1 from _tl_link k where k.code = n2.code and k.service_id is not null)
                             group by 1) x), '[]'::jsonb)
      into v_to_create, v_to_create_cat
      from _tl_import n
      where not tariff_line_in_clinic(v_book.id, n.code)
        and not exists (select 1 from _tl_link k where k.code = n.code and k.service_id is not null);
    end if;

    with own as (
      select 'service'::text as kind, s.id, s.name_en as name, n.code, (n.prices ->> v_private)::numeric as list,
             (select pli.price from price_list pl join price_list_item pli on pli.price_list_id = pl.id
              where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null
                and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
                and pli.service_id = s.id
              order by pl.effective_from desc, pl.created_at desc limit 1) as own
      from _tl_import n
      join service s on s.deleted_at is null
        and (tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = n.code
          or exists (select 1 from _tl_link k where k.service_id = s.id and k.code = n.code)
          or exists (select 1 from tariff_link k where k.book_id = v_book.id and k.service_id = s.id and k.code = n.code))
      where v_kind = 'treatments'
      union all
      select 'item', i.id, i.name_generic || coalesce(' ' || i.strength, ''), n.code, (n.prices ->> v_private)::numeric,
             (select pli.price from price_list pl join price_list_item pli on pli.price_list_id = pl.id
              where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null
                and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
                and pli.item_id = i.id
              order by pl.effective_from desc, pl.created_at desc limit 1)
      from _tl_import n
      join item i on i.deleted_at is null
        and (tariff_code_norm(i.code) = n.code
          or exists (select 1 from _tl_link k where k.item_id = i.id and k.code = n.code)
          or exists (select 1 from tariff_link k where k.book_id = v_book.id and k.item_id = i.id and k.code = n.code))
      where v_kind = 'medicines'
    ), diff as (
      select o.*, row_number() over (order by o.name) as rn from own o
      where o.own is not null and o.own is distinct from o.list
    )
    select count(*)::int,
           coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'name', d.name, 'code', d.code,
                                                 'own', d.own, 'list', d.list) order by d.name)
                    filter (where d.rn <= v_cap), '[]'::jsonb)
    into v_n_own_clinic, v_own_clinic
    from diff d;
  end if;

  -- ---- the insurers that follow the list: their column, their exceptions, their own prices
  if v_book.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('payerId', py.id, 'payer', py.name, 'column', pt.column_key,
             'label', (select x.value ->> 'label' from jsonb_array_elements(v_cols) x where x.value ->> 'key' = pt.column_key),
             'found', pt.column_key = any (v_keys)) order by py.name), '[]'::jsonb)
    into v_followers
    from payer_tariff pt
    join payer py on py.id = pt.payer_id and py.deleted_at is null
    where pt.book_id = v_book.id;

    -- exceptions on lines that left the list
    if v_cur.id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'code', e.code, 'name', l.name, 'cover', e.cover,
                                                   'price', e.price, 'note', e.note) order by py.name, l.name), '[]'::jsonb)
      into v_ex_removed
      from tariff_exception e
      join payer py on py.id = e.payer_id
      join tariff_line l on l.version_id = v_cur.id and l.code = e.code
      where (e.book_id = v_book.id or exists (select 1 from payer_tariff pt where pt.book_id = v_book.id and pt.payer_id = e.payer_id))
        and not exists (select 1 from _tl_import n where n.code = e.code);
    end if;

    -- an insurer's exception price that is not the new list's price in its column
    select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'code', n.code, 'name', n.name, 'own', e.price,
                                                 'list', (n.prices ->> pt.column_key)::numeric) order by py.name, n.name), '[]'::jsonb)
    into v_ex_prices
    from tariff_exception e
    join payer_tariff pt on pt.payer_id = e.payer_id and pt.book_id = v_book.id
    join payer py on py.id = e.payer_id
    join _tl_import n on n.code = e.code
    where e.price is not null and e.price is distinct from (n.prices ->> pt.column_key)::numeric;

    -- an insurer's own price (its uploaded tariff, 0115) on the day the version starts that is not
    -- the new list's price in its column
    with own as (
      select pt.payer_id, pt.column_key, n.code, n.name, n.prices, pf.price
      from payer_tariff pt
      join _tl_import n on true
      join lateral (
        select s.id as service_id, null::uuid as item_id from service s
        where v_kind = 'treatments' and s.deleted_at is null
          and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = n.code
        union all
        select null::uuid, i.id from item i
        where v_kind = 'medicines' and i.deleted_at is null and tariff_code_norm(i.code) = n.code
      ) c on true
      join lateral (
        select pli.price from price_list pl
        join price_list_item pli on pli.price_list_id = pl.id
        where pl.payer_id = pt.payer_id and pl.deleted_at is null and pli.deleted_at is null
          and pl.effective_from <= p_from and (pl.effective_to is null or pl.effective_to >= p_from)
          and ((c.service_id is not null and pli.service_id = c.service_id) or (c.item_id is not null and pli.item_id = c.item_id))
        order by pl.effective_from desc, pl.created_at desc limit 1
      ) pf on true
      where pt.book_id = v_book.id
    )
    select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'code', o.code, 'name', o.name, 'own', o.price,
                                                 'list', (o.prices ->> o.column_key)::numeric) order by py.name, o.name), '[]'::jsonb)
    into v_own
    from (select o.*, row_number() over (order by o.name) as rn from own o
          where o.price is distinct from (o.prices ->> o.column_key)::numeric) o
    join payer py on py.id = o.payer_id
    where o.rn <= v_cap;
  end if;

  -- ---- the instructions, read as the chosen insurer's exceptions
  if p_instructions_payer is not null then
    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'note', n.note,
                                                 'cover', tariff_cover_of(n.note),
                                                 'typed', e.source = 'typed') order by n.name)
                    filter (where n.rn <= v_cap), '[]'::jsonb),
           (count(*) filter (where e.source = 'typed'))::int
    into v_instr_lines, v_kept_typed
    from (select n.*, row_number() over (order by n.name) as rn from _tl_import n where n.note is not null) n
    left join tariff_exception e on e.payer_id = p_instructions_payer and e.code = n.code;

    select count(*)::int into v_dropped
    from tariff_exception e
    where e.payer_id = p_instructions_payer and e.source = 'upload'
      and (e.book_id = v_book.id or v_book.id is null)
      and not exists (select 1 from _tl_import n where n.code = e.code and n.note is not null);
    if v_book.id is null then
      v_dropped := 0;
    end if;

    v_instr := jsonb_build_object(
      'payerId', v_ipayer.id, 'payer', v_ipayer.name,
      'notCovered', (select count(*)::int from _tl_import n where n.note is not null and tariff_cover_of(n.note) = 'not_covered'),
      'preauth', (select count(*)::int from _tl_import n where n.note is not null and tariff_cover_of(n.note) = 'preauth'),
      'notes', (select count(*)::int from _tl_import n where n.note is not null and tariff_cover_of(n.note) = 'covered'),
      'keptTyped', v_kept_typed, 'dropped', v_dropped, 'lines', v_instr_lines,
      'follows', v_book.id is not null and exists (select 1 from payer_tariff pt where pt.book_id = v_book.id
                                                     and pt.payer_id = p_instructions_payer));
  end if;

  v_summary := jsonb_build_object(
    'total', jsonb_array_length(p_lines), 'rows', v_valid, 'new', v_n_new, 'changedLines', v_n_changed,
    'changes', v_n_changes, 'removed', v_n_removed, 'unchanged', v_unchanged, 'errors', v_n_errors,
    'warnings', v_n_warnings, 'byCode', jsonb_array_length(v_by_code), 'byName', jsonb_array_length(v_by_name),
    'scope', v_scope, 'privateColumn', v_private, 'toCreate', v_to_create, 'ownPrices', v_n_own_clinic,
    'namesFromList', v_name_list, 'namesFromClinic', v_name_clinic, 'namesNotFound', v_n_not_found,
    'instructions', case when v_instr is null then null
                         else v_instr - 'lines' - 'payerId' end,
    'previous', case when v_cur.id is null then null
                     else jsonb_build_object('name', v_cur.name, 'effectiveFrom', v_cur.effective_from, 'rows', v_cur.rows) end);

  if not p_dry_run then
    if v_valid = 0 then
      raise exception 'no row of the list can be used' using errcode = '22023';
    end if;
    if v_book.id is null then
      insert into tariff_book (name, publisher, kind, payer_id, created_by, scope, private_column, priority)
      values (v_bname, v_publisher, v_kind, v_bpayer, auth.uid(), v_scope,
              case when v_scope = 'clinic' then v_private end, coalesce(v_priority, 100))
      returning * into v_book;
      insert into audit_event (actor_id, action, entity, entity_id, after)
      values (auth.uid(), 'create', 'tariff_book', v_book.id,
              jsonb_build_object('name', v_bname, 'publisher', v_publisher, 'kind', v_kind, 'scope', v_scope,
                                 'privateColumn', v_private));
    elsif v_scope = 'clinic' and v_book.private_column is distinct from v_private then
      update tariff_book set private_column = v_private where id = v_book.id;
    end if;
    -- an insurer's own list: that insurer follows it, first, in its column
    if v_scope = 'insurer' and p_book_id is null then
      insert into payer_tariff (payer_id, book_id, column_key, priority, created_by)
      values (v_book.payer_id, v_book.id, v_payer_col, 0, auth.uid())
      on conflict (payer_id, book_id) do update set column_key = excluded.column_key;
    elsif v_scope = 'insurer' then
      -- the insurer may have stopped following it: that stays
      update payer_tariff set column_key = v_payer_col where payer_id = v_book.payer_id and book_id = v_book.id;
    end if;
    update tariff_version set status = 'past' where book_id = v_book.id and status = 'current';
    insert into tariff_version (book_id, name, effective_from, columns, uploaded_by, file_name, rows, notes, summary,
                                instructions_payer_id, status, private_column, payer_column)
    values (v_book.id, v_name, p_from, v_cols, auth.uid(),
            left(nullif(trim(coalesce(p_file_name, '')), ''), 200), v_valid,
            left(nullif(trim(coalesce(p_notes, '')), ''), 4000), v_summary, p_instructions_payer, 'current',
            case when v_scope = 'clinic' then v_private end, case when v_scope = 'insurer' then v_payer_col end)
    returning id into v_version;
    insert into tariff_line (version_id, code, name, detail, section, alt_code, unit, prices, note, row)
    select v_version, code, name, detail, section, alt_code, unit, prices, note, row from _tl_import;
    -- what was found by name is linked: a clinic-wide list of treatments gives the treatment its
    -- list code; any other list keeps a link of its own
    if v_scope = 'clinic' then
      update service s set tariff_code = k.code, updated_at = now()
      from _tl_link k where s.id = k.service_id;
      get diagnostics v_linked = row_count;
      insert into tariff_link (book_id, code, item_id, created_by)
      select v_book.id, k.code, k.item_id, auth.uid() from _tl_link k where k.item_id is not null
      on conflict do nothing;
      get diagnostics v_k = row_count;
      v_linked := v_linked + v_k;
    else
      insert into tariff_link (book_id, code, service_id, item_id, created_by)
      select v_book.id, k.code, k.service_id, k.item_id, auth.uid() from _tl_link k
      on conflict do nothing;
      get diagnostics v_linked = row_count;
      -- a line without a code found among the clinic's is tied to that treatment / medicine itself
      -- (its price stays when the treatment later takes a Ministry code)
      insert into tariff_link (book_id, code, service_id, item_id, created_by)
      select v_book.id, n.code, n.svc_id, n.itm_id, auth.uid() from _tl_import n
      where n.svc_id is not null or n.itm_id is not null
      on conflict do nothing;
    end if;
    -- a clinic-wide list of treatments: every line not yet a treatment of the clinic becomes one
    if v_scope = 'clinic' and v_kind = 'treatments' then
      v_created := tariff_make_services(v_book.id, v_version);
    end if;
    -- the instructions: the insurer's exceptions on this list (its typed ones are kept)
    if p_instructions_payer is not null then
      delete from tariff_exception e
      where e.payer_id = p_instructions_payer and e.source = 'upload' and e.book_id = v_book.id
        and not exists (select 1 from _tl_import n where n.code = e.code and n.note is not null);
      insert into tariff_exception (payer_id, code, book_id, cover, note, source, version_id, updated_by, updated_at)
      select p_instructions_payer, n.code, v_book.id, tariff_cover_of(n.note), n.note, 'upload', v_version, auth.uid(), now()
      from _tl_import n
      where n.note is not null
      on conflict (payer_id, code) do update
        set cover = excluded.cover, note = excluded.note, book_id = excluded.book_id, version_id = excluded.version_id,
            updated_by = excluded.updated_by, updated_at = now()
        where tariff_exception.source = 'upload';
    end if;
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'create', 'tariff_version', v_version,
            jsonb_build_object('list', v_book.name, 'name', v_name, 'effectiveFrom', p_from, 'rows', v_valid,
                               'replaced', v_cur.name, 'changedLines', v_n_changed, 'removed', v_n_removed,
                               'new', v_n_new, 'linkedByName', v_linked, 'instructionsOf', v_ipayer.name));
  end if;
  truncate _tl_import;
  truncate _tl_link;

  return jsonb_build_object(
    'dryRun', p_dry_run, 'bookId', v_book.id, 'versionId', v_version,
    'book', jsonb_build_object('name', coalesce(v_book.name, v_bname), 'publisher', coalesce(v_book.publisher, v_publisher),
                               'kind', v_kind, 'isNew', p_book_id is null, 'scope', v_scope,
                               'privateColumn', v_private, 'payerColumn', v_payer_col,
                               'payer', (select py.name from payer py where py.id = v_bpayer)),
    'name', v_name, 'effectiveFrom', p_from, 'columns', v_cols,
    'total', jsonb_array_length(p_lines), 'rows', v_valid,
    'new', v_n_new, 'newLines', v_new,
    'changedLines', v_n_changed, 'changes', v_n_changes, 'changed', v_changed,
    'removed', v_n_removed, 'removedLines', v_removed,
    'unchanged', v_unchanged, 'renamed', v_renamed, 'edited', v_edited,
    'columnsAdded', v_cols_added, 'columnsGone', v_cols_gone,
    'errors', v_errors, 'errorCount', v_n_errors, 'warnings', v_warnings, 'warningCount', v_n_warnings,
    'clinic', jsonb_build_object('byCode', v_by_code, 'byName', v_by_name, 'gone', v_gone_clinic, 'linked', v_linked,
                                 'toCreate', v_to_create, 'toCreateByCategory', v_to_create_cat, 'created', v_created,
                                 'ownPrices', v_own_clinic, 'ownPriceCount', v_n_own_clinic),
    'names', jsonb_build_object('byList', v_name_list, 'byClinic', v_name_clinic, 'notFound', v_not_found,
                                'notFoundCount', v_n_not_found),
    'followers', v_followers,
    'checks', jsonb_build_object('exceptionsOnRemoved', v_ex_removed, 'ownPrices', v_own, 'exceptionPrices', v_ex_prices),
    'instructions', v_instr,
    'current', case when v_cur.id is null then null
                    else jsonb_build_object('name', v_cur.name, 'effectiveFrom', v_cur.effective_from, 'rows', v_cur.rows) end);
end
$$;


-- ---------------------------------------------------------------- reading the lists
-- tariff_books (from 20270114090000_published_price_lists): + whose list it is (scope, the insurer),
-- the private column and the order of a clinic-wide list, how many of the clinic's treatments /
-- medicines on it have a price of the clinic's own (linked: through links too).
create or replace function tariff_books()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'publisher', b.publisher, 'kind', b.kind, 'payerId', b.payer_id, 'payer', bp.name,
      'scope', b.scope, 'privateColumn', b.private_column, 'priority', b.priority,
      'createdAt', b.created_at,
      'versions', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'name', v.name, 'effectiveFrom', v.effective_from, 'rows', v.rows, 'status', v.status,
            'columns', v.columns, 'uploadedAt', v.uploaded_at, 'uploadedBy', pr.full_name, 'fileName', v.file_name,
            'notes', v.notes, 'summary', v.summary, 'instructionsPayer', ip.name,
            'inEffect', v.id = tariff_version_at(b.id, current_date),
            'edited', (select count(*)::int from tariff_line l where l.version_id = v.id and l.edited_at is not null
                         and l.removed_at is null),
            'removedLines', (select count(*)::int from tariff_line l where l.version_id = v.id and l.removed_at is not null)
          ) order by v.effective_from desc, v.uploaded_at desc), '[]'::jsonb)
        from tariff_version v
        left join profiles pr on pr.id = v.uploaded_by
        left join payer ip on ip.id = v.instructions_payer_id
        where v.book_id = b.id),
      'followers', (
        select coalesce(jsonb_agg(jsonb_build_object('payerId', pt.payer_id, 'payer', py.name, 'column', pt.column_key,
                                                     'priority', pt.priority) order by py.name), '[]'::jsonb)
        from payer_tariff pt join payer py on py.id = pt.payer_id and py.deleted_at is null
        where pt.book_id = b.id),
      'exceptions', (select count(*)::int from tariff_exception e where e.book_id = b.id),
      'linked', on_list.n,
      'ownPriced', on_list.own
    ) order by b.kind desc, case b.scope when 'clinic' then 0 when 'insurer' then 1 else 2 end, b.priority, b.name), '[]'::jsonb)
  from tariff_book b
  left join payer bp on bp.id = b.payer_id
  left join lateral (
    select count(*)::int as n, count(*) filter (where x.own is not null)::int as own
    from (
      select own_cash_price(s.id, null) as own
      from service s
      join tariff_line l on l.code = tariff_line_code(b.id, s.id, null) and l.removed_at is null
      join tariff_version v on v.id = l.version_id and v.book_id = b.id and v.status = 'current'
      where b.kind = 'treatments' and s.deleted_at is null and s.active
      union all
      select own_cash_price(null, i.id)
      from item i
      join tariff_line l on l.code = tariff_line_code(b.id, null, i.id) and l.removed_at is null
      join tariff_version v on v.id = l.version_id and v.book_id = b.id and v.status = 'current'
      where b.kind = 'medicines' and i.deleted_at is null and i.active
    ) x
  ) on_list on true
  where b.deleted_at is null and auth.uid() is not null
$$;

-- tariff_lines (from 20270114090000_published_price_lists): + each line's clinic treatments /
-- medicines through the list's links too, with their own price (null: they follow the list).
create or replace function tariff_lines(
  p_version uuid,
  p_search text default null,
  p_payer uuid default null,
  p_section text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_kind text;
  v_book uuid;
  v_scope text;
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_norm text := tariff_norm(p_search);
  v_total integer;
  v_lines jsonb;
  v_sections jsonb;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select b.kind, b.id, b.scope into v_kind, v_book, v_scope from tariff_version v join tariff_book b on b.id = v.book_id
  where v.id = p_version and b.deleted_at is null;
  if v_kind is null then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(s.section order by s.section), '[]'::jsonb) into v_sections
  from (select distinct l.section from tariff_line l where l.version_id = p_version and l.section is not null) s;

  with hit as (
    select l.* from tariff_line l
    where l.version_id = p_version
      and (p_section is null or l.section = p_section)
      and (v_q is null or l.code ilike '%' || v_q || '%' or tariff_norm(l.name) like '%' || coalesce(v_norm, '') || '%'
           or coalesce(l.alt_code, '') ilike '%' || v_q || '%')
  ), page as (
    select h.* from hit h
    order by h.removed_at is not null, h.row nulls last, h.code
    limit greatest(least(coalesce(p_limit, 200), 1000), 1) offset greatest(coalesce(p_offset, 0), 0)
  )
  select (select count(*)::int from hit),
         coalesce(jsonb_agg(jsonb_build_object(
           'code', p.code, 'name', p.name, 'detail', p.detail, 'section', p.section, 'altCode', p.alt_code,
           'unit', p.unit, 'prices', p.prices, 'note', p.note, 'row', p.row,
           'edited', p.edited_at is not null, 'editedAt', p.edited_at, 'editedBy', pr.full_name,
           'original', p.original, 'removed', p.removed_at is not null,
           'clinic', case v_kind
             when 'treatments' then (
               select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', 'service', 'name', s.name_en,
                                                            'active', s.active,
                                                            -- by hand or by name (a clinic-wide list: the
                                                            -- treatment's list code), not made from this list
                                                            'linked', k.service_id is not null
                                                              or (v_scope = 'clinic' and coalesce(s.tariff_code, '') <> ''
                                                                  and s.list_book_id is distinct from v_book),
                                                            'ownPrice', own_cash_price(s.id, null))), '[]'::jsonb)
               from service s
               left join tariff_link k on k.book_id = v_book and k.service_id = s.id
               where s.deleted_at is null
                 and ((k.service_id is null and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = p.code)
                   or k.code = p.code))
             else (
               select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', 'item',
                                                            'name', i.name_generic || coalesce(' ' || i.strength, ''),
                                                            'active', i.active,
                                                            'linked', k.item_id is not null,
                                                            'ownPrice', own_cash_price(null, i.id))), '[]'::jsonb)
               from item i
               left join tariff_link k on k.book_id = v_book and k.item_id = i.id
               where i.deleted_at is null
                 and ((k.item_id is null and tariff_code_norm(i.code) = p.code) or k.code = p.code)) end,
           'exception', (select jsonb_build_object('cover', e.cover, 'price', e.price, 'note', e.note, 'source', e.source)
                         from tariff_exception e where e.payer_id = p_payer and e.code = p.code)
         ) order by p.removed_at is not null, p.row nulls last, p.code), '[]'::jsonb)
  into v_total, v_lines
  from page p
  left join profiles pr on pr.id = p.edited_by;

  return jsonb_build_object('versionId', p_version, 'kind', v_kind, 'total', coalesce(v_total, 0),
                            'sections', v_sections, 'lines', v_lines);
end
$$;

-- ---------------------------------------------------------------- the lines of a clinic-wide list and its treatments
-- save_tariff_line, remove_tariff_line, save_tariff_book (from 20270114090000_published_price_lists):
-- the treatments made from a clinic-wide list of treatments follow its lines.
-- ---------------------------------------------------------------- changing a list by hand
-- save_tariff_line: one line of the version in use, changed (its name, prices, instruction…; the
-- line as uploaded is kept the first time) or added (p_new). Prices: {column key: number | null}
-- for the columns of the version.
create or replace function save_tariff_line(
  p_version uuid,
  p_code text,
  p_name text,
  p_prices jsonb,
  p_note text default null,
  p_section text default null,
  p_unit text default null,
  p_detail text default null,
  p_new boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ver tariff_version%rowtype;
  v_code text := tariff_code_norm(p_code);
  v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_old tariff_line%rowtype;
  v_prices jsonb := '{}'::jsonb;
  v_col jsonb;
  v_key text;
  v_val jsonb;
  v_txt text;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select v.* into v_ver from tariff_version v join tariff_book b on b.id = v.book_id
  where v.id = p_version and b.deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  if v_ver.status <> 'current' then
    raise exception 'only the version in use can be changed' using errcode = '22023';
  end if;
  if v_code is null or length(v_code) > 40 then
    raise exception 'give the line a code' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 300 then
    raise exception 'give the line a name' using errcode = '22023';
  end if;
  if p_prices is not null and jsonb_typeof(p_prices) <> 'object' then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  for v_col in select x.value from jsonb_array_elements(v_ver.columns) x loop
    v_key := v_col ->> 'key';
    v_val := coalesce(p_prices, '{}'::jsonb) -> v_key;
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      v_prices := v_prices || jsonb_build_object(v_key, null);
      continue;
    end if;
    v_txt := case when jsonb_typeof(v_val) = 'number' then v_val::text
                  else nullif(regexp_replace(trim(v_val #>> '{}'), '[\s,]', '', 'g'), '') end;
    if v_txt is null then
      v_prices := v_prices || jsonb_build_object(v_key, null);
    elsif v_txt !~ '^\d{1,10}(\.\d+)?$' then
      raise exception 'the price must be zero or more' using errcode = '22023';
    else
      v_prices := v_prices || jsonb_build_object(v_key, round(v_txt::numeric));
    end if;
  end loop;

  select * into v_old from tariff_line where version_id = p_version and code = v_code;
  if coalesce(p_new, false) then
    if v_old.code is not null then
      raise exception 'this code is already on the list' using errcode = '22023';
    end if;
    insert into tariff_line (version_id, code, name, detail, section, unit, prices, note, original, edited_by, edited_at)
    values (p_version, v_code, v_name,
            left(nullif(trim(coalesce(p_detail, '')), ''), 300), left(nullif(trim(coalesce(p_section, '')), ''), 200),
            left(nullif(trim(coalesce(p_unit, '')), ''), 60), v_prices, left(nullif(trim(coalesce(p_note, '')), ''), 500),
            '{"added": true}'::jsonb, auth.uid(), now());
    update tariff_version set rows = rows + 1 where id = p_version;
    -- a line added to a clinic-wide list of treatments becomes a treatment of the clinic
    if exists (select 1 from tariff_book b where b.id = v_ver.book_id and b.scope = 'clinic' and b.kind = 'treatments') then
      perform tariff_make_services(v_ver.book_id, p_version);
    end if;
  else
    if v_old.code is null then
      raise exception 'line not found' using errcode = 'P0002';
    end if;
    update tariff_line
    set name = v_name,
        detail = left(nullif(trim(coalesce(p_detail, '')), ''), 300),
        section = left(nullif(trim(coalesce(p_section, '')), ''), 200),
        unit = left(nullif(trim(coalesce(p_unit, '')), ''), 60),
        prices = v_prices,
        note = left(nullif(trim(coalesce(p_note, '')), ''), 500),
        original = coalesce(original, jsonb_build_object('name', v_old.name, 'prices', v_old.prices, 'note', v_old.note,
                                                         'section', v_old.section, 'unit', v_old.unit, 'detail', v_old.detail)),
        edited_by = auth.uid(), edited_at = now()
    where version_id = p_version and code = v_code;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), (case when coalesce(p_new, false) then 'create' else 'update' end)::audit_action, 'tariff_line', p_version,
          case when v_old.code is null then null
               else jsonb_build_object('code', v_code, 'name', v_old.name, 'prices', v_old.prices, 'note', v_old.note) end,
          jsonb_build_object('code', v_code, 'name', v_name, 'prices', v_prices, 'note', nullif(trim(coalesce(p_note, '')), '')));
  return jsonb_build_object('code', v_code, 'name', v_name, 'prices', v_prices);
end
$$;

-- remove_tariff_line: a line of the version in use leaves it (kept, marked, can come back with
-- p_restore). A line typed by hand (never uploaded) is deleted.
create or replace function remove_tariff_line(p_version uuid, p_code text, p_restore boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ver tariff_version%rowtype;
  v_code text := tariff_code_norm(p_code);
  v_line tariff_line%rowtype;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select v.* into v_ver from tariff_version v join tariff_book b on b.id = v.book_id
  where v.id = p_version and b.deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  if v_ver.status <> 'current' then
    raise exception 'only the version in use can be changed' using errcode = '22023';
  end if;
  select * into v_line from tariff_line where version_id = p_version and code = v_code;
  if not found then
    raise exception 'line not found' using errcode = 'P0002';
  end if;
  if not coalesce(p_restore, false) and coalesce((v_line.original ->> 'added')::boolean, false) then
    delete from tariff_line where version_id = p_version and code = v_code;
    update tariff_version set rows = greatest(rows - 1, 0) where id = p_version;
  else
    update tariff_line
    set removed_at = case when coalesce(p_restore, false) then null else now() end,
        edited_by = auth.uid(), edited_at = now()
    where version_id = p_version and code = v_code;
  end if;
  -- a clinic-wide list: the treatments made from this line are hidden while it is out (unless the
  -- clinic priced them), shown again when it is back
  update service s set active = coalesce(p_restore, false), updated_at = now()
  where s.list_book_id = v_ver.book_id and s.deleted_at is null
    and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = v_code
    and (coalesce(p_restore, false) or own_cash_price(s.id, null) is null);
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'tariff_line', p_version,
          jsonb_build_object('code', v_code, 'name', v_line.name,
                             'removed', not coalesce(p_restore, false)));
end
$$;

-- save_tariff_book: rename a list or say who publishes it; p_delete takes it away (only when no
-- insurer follows it any more).
create or replace function save_tariff_book(p_id uuid, p_name text, p_publisher text, p_delete boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_publisher text := nullif(regexp_replace(trim(coalesce(p_publisher, '')), '\s+', ' ', 'g'), '');
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_book from tariff_book where id = p_id and deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  if coalesce(p_delete, false) then
    if exists (select 1 from payer_tariff where book_id = p_id) then
      raise exception 'insurers follow this list: stop them first' using errcode = '22023';
    end if;
    update tariff_book set deleted_at = now() where id = p_id;
    -- the treatments made from it and priced only by it are hidden
    update service s set active = false, updated_at = now()
    where s.list_book_id = p_id and s.deleted_at is null and s.active and own_cash_price(s.id, null) is null;
    insert into audit_event (actor_id, action, entity, entity_id, before)
    values (auth.uid(), 'delete', 'tariff_book', p_id, jsonb_build_object('name', v_book.name));
    return;
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'give the price list a name' using errcode = '22023';
  end if;
  if v_publisher is null or length(v_publisher) > 80 then
    raise exception 'say who publishes the list' using errcode = '22023';
  end if;
  if exists (select 1 from tariff_book b where lower(b.name) = lower(v_name) and b.deleted_at is null and b.id <> p_id) then
    raise exception 'a price list with this name already exists' using errcode = '22023';
  end if;
  update tariff_book set name = v_name, publisher = v_publisher where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'tariff_book', p_id,
          jsonb_build_object('name', v_book.name, 'publisher', v_book.publisher),
          jsonb_build_object('name', v_name, 'publisher', v_publisher));
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function
  tariff_line_code(uuid, uuid, uuid), clinic_list_price(uuid, uuid, date), own_cash_price(uuid, uuid),
  tariff_category_for(text, text), tariff_line_in_clinic(uuid, text),
  use_list_prices(uuid, uuid[]), link_tariff_line(uuid, text, uuid, uuid), unlink_tariff_line(uuid, uuid, uuid),
  save_tariff_book_settings(uuid, text, integer, text)
  from public, anon;
grant execute on function
  tariff_line_code(uuid, uuid, uuid), clinic_list_price(uuid, uuid, date), own_cash_price(uuid, uuid),
  tariff_category_for(text, text), tariff_line_in_clinic(uuid, text),
  use_list_prices(uuid, uuid[]), link_tariff_line(uuid, text, uuid, uuid), unlink_tariff_line(uuid, uuid, uuid),
  save_tariff_book_settings(uuid, text, integer, text)
  to authenticated;
-- internal: called only by the functions above (security definer)
revoke all on function cash_follows_list(uuid, uuid, numeric), tariff_make_services(uuid, uuid) from public, anon, authenticated;
