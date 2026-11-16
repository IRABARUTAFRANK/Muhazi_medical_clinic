-- 0172: every uploaded list joins the clinic's own treatments and medicines ("nothing separated").
--
-- Until now only a clinic-wide (Ministry) list of treatments added its lines to the clinic's
-- treatments, and only the RHIA official list offered medicines to stock or prescribe. Now:
--   * a list of treatments of any publisher (RSSB, an insurer) adds its lines to the clinic's
--     treatments too; a line priced in any column is live; a private patient pays the price of
--     the list that brought the treatment until the clinic sets its own (clinic_list_price);
--   * list_medicines(): the lines of every uploaded list of medicines the clinic does not hold
--     yet (and that are not on the RHIA list), for the Add stock and prescription pickers;
--   * add_stock accepts the code of such a line (the item keeps it: the list prices it) and
--     prescribe names a medicine bought outside from such a line.

-- the price of a line: the column asked, else the first priced column (an insurer's list)
create or replace function tariff_line_price(p_prices jsonb, p_col text)
returns numeric
language sql immutable
as $$
  select case
    when p_col is not null and jsonb_typeof(p_prices -> p_col) = 'number' then (p_prices ->> p_col)::numeric
    else (select (x.value #>> '{}')::numeric from jsonb_each(coalesce(p_prices, '{}'::jsonb)) x
          where jsonb_typeof(x.value) = 'number' limit 1)
  end
$$;
create or replace function tariff_line_priced(p_prices jsonb, p_col text)
returns boolean
language sql immutable
as $$
  select tariff_line_price(p_prices, p_col) is not null
$$;

-- ---------------------------------------------------------------- clinic_list_price (from 20270115090000_clinic_price_lists)
-- the clinic-wide lists first (by priority); then, for a treatment brought by another list (an
-- insurer's), that list's price: a private patient pays it until the clinic sets its own
create or replace function clinic_list_price(p_service_id uuid, p_item_id uuid, p_at date default current_date)
returns table (price numeric, book_id uuid, code text)
language sql stable security definer set search_path = public
as $$
  select x.price, x.book_id, x.code from (
    select round((l.prices ->> c.col)::numeric) as price, b.id as book_id, l.code, 0 as rank, b.priority, b.created_at
    from tariff_book b
    join tariff_version v on v.id = tariff_version_at(b.id, p_at)
    cross join lateral (select coalesce(v.private_column, b.private_column) as col) c
    join tariff_line l on l.version_id = v.id
      and l.code = tariff_line_code(b.id, p_service_id, p_item_id) and l.removed_at is null
    where b.scope = 'clinic' and b.deleted_at is null and c.col is not null
      and b.kind = case when p_service_id is not null then 'treatments' else 'medicines' end
      and (p_service_id is not null or p_item_id is not null)
      and jsonb_typeof(l.prices -> c.col) = 'number'
    union all
    select round(tariff_line_price(l.prices, coalesce(v.private_column, b.private_column, v.payer_column))),
           b.id, l.code, 1, b.priority, b.created_at
    from service s
    join tariff_book b on b.id = s.list_book_id and b.deleted_at is null and b.scope <> 'clinic'
    join tariff_version v on v.id = tariff_version_at(b.id, p_at)
    join tariff_line l on l.version_id = v.id and l.removed_at is null
      and l.code = tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code))
    where p_service_id is not null and s.id = p_service_id
      and tariff_line_priced(l.prices, coalesce(v.private_column, b.private_column, v.payer_column))
  ) x
  order by x.rank, x.priority, x.created_at
  limit 1
$$;

-- ---------------------------------------------------------------- clinic_list_prices (from 20270125090000_catalogue_fast)
-- the same for the whole catalogue at once (the Prices page): the clinic-wide lists first, then
-- for a treatment brought by another list, that list's price
create or replace function clinic_list_prices(p_at date default current_date)
returns table (service_id uuid, price numeric, book_id uuid)
language sql stable security definer set search_path = public
as $$
  with books as (
    select b.id as book_id, b.priority, b.created_at, v.id as version_id,
           coalesce(v.private_column, b.private_column) as col
    from tariff_book b
    join tariff_version v on v.id = tariff_version_at(b.id, p_at)
    where b.scope = 'clinic' and b.kind = 'treatments' and b.deleted_at is null
  ),
  lines as (
    select bk.book_id, bk.priority, bk.created_at, l.code, round((l.prices ->> bk.col)::numeric) as price
    from books bk
    join tariff_line l on l.version_id = bk.version_id and l.removed_at is null
    where bk.col is not null and jsonb_typeof(l.prices -> bk.col) = 'number'
  ),
  codes as (
    select s.id as service_id, bk.book_id,
           coalesce(k.code, k2.code, tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code))) as code
    from service s
    cross join books bk
    left join tariff_link k on k.book_id = bk.book_id and k.service_id = s.id
    left join lateral (
      select k2.code from tariff_link k2
      join tariff_book b2 on b2.id = k2.book_id and b2.scope = 'clinic' and b2.deleted_at is null
      where k2.book_id <> bk.book_id and k2.service_id = s.id
      order by b2.priority, b2.created_at
      limit 1
    ) k2 on true
    where s.deleted_at is null
  ),
  found as (
    select c.service_id, ln.price, ln.book_id, 0 as rank, ln.priority, ln.created_at
    from codes c
    join lines ln on ln.book_id = c.book_id and ln.code = c.code
    union all
    -- 0172: a treatment brought by an insurer's (or any other) list: that list's price
    select s.id, round(tariff_line_price(l.prices, coalesce(v.private_column, b.private_column, v.payer_column))),
           b.id, 1, b.priority, b.created_at
    from service s
    join tariff_book b on b.id = s.list_book_id and b.deleted_at is null and b.scope <> 'clinic'
    join tariff_version v on v.id = tariff_version_at(b.id, p_at)
    join tariff_line l on l.version_id = v.id and l.removed_at is null
      and l.code = tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code))
    where s.deleted_at is null
      and tariff_line_priced(l.prices, coalesce(v.private_column, b.private_column, v.payer_column))
  )
  select distinct on (f.service_id) f.service_id, f.price, f.book_id
  from found f
  order by f.service_id, f.rank, f.priority, f.created_at
$$;

-- ---------------------------------------------------------------- list_medicines
-- the lines of every uploaded list of medicines (current version) the clinic does not hold yet,
-- and that the RHIA list does not already offer: one row per code, the first list by priority
create or replace function list_medicines()
returns table (code text, name text, detail text, unit text, price numeric, list_name text, book_id uuid)
language sql stable security definer set search_path = public
as $$
  select distinct on (l.code) l.code, l.name, l.detail, l.unit,
         tariff_line_price(l.prices, coalesce(v.private_column, b.private_column, v.payer_column)),
         b.name, b.id
  from tariff_book b
  join tariff_version v on v.id = tariff_version_at(b.id, current_date)
  join tariff_line l on l.version_id = v.id and l.removed_at is null
  where auth.uid() is not null and b.kind = 'medicines' and b.deleted_at is null
    and not exists (select 1 from medicine_reference r where r.code = l.code)
    and not exists (select 1 from item i where i.deleted_at is null and i.active and tariff_code_norm(i.code) = l.code)
    and not exists (select 1 from tariff_link k join item i on i.id = k.item_id and i.deleted_at is null
                    where k.book_id = b.id and k.code = l.code)
  order by l.code, b.priority, b.created_at
$$;
revoke all on function list_medicines() from public, anon;
grant execute on function list_medicines() to authenticated;

-- ---------------------------------------------------------------- tariff_make_services (from 20270118090000_price_list_speed)
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
  v_old uuid;
begin
  select coalesce(v.private_column, b.private_column), v.id = tariff_version_at(b.id, current_date)
  into v_col, v_live
  from tariff_version v join tariff_book b on b.id = v.book_id
  where v.id = p_version;
  -- the planner learns how many treatments there are (thousands may have just been made)
  analyze service;
  -- the treatments hidden with a list taken away (they had been used): this list takes them over
  with cand as materialized (
    select s.id, tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) as code
    from service s
    where s.deleted_at is null and s.list_book_id is not null and s.list_book_id <> p_book
      and exists (select 1 from tariff_book ob where ob.id = s.list_book_id and ob.deleted_at is not null)
  )
  update service s
  set list_book_id = p_book,
      active = coalesce(v_live, false) and tariff_line_priced(l.prices, v_col),
      updated_at = now()
  from cand c
  join tariff_line l on l.version_id = p_version and l.code = c.code and l.removed_at is null
  where s.id = c.id;
  for r in
    select l.* from tariff_line l
    where l.version_id = p_version and l.removed_at is null and not tariff_line_in_clinic(p_book, l.code)
    order by l.row nulls last, l.code
  loop
    v_cat := tariff_category_for(r.section, r.code);
    select case when c.kind in ('lab', 'imaging', 'bed') then c.kind::text::service_group
                else coalesce(c.base_group, 'other'::service_group) end
    into v_grp from service_category c where c.id = v_cat;
    -- a treatment deleted with its list comes back (the same code, its old bills)
    select s.id into v_old
    from service s
    where s.deleted_at is not null
      and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = r.code
      and exists (select 1 from tariff_book ob where ob.id = s.list_book_id and ob.deleted_at is not null)
    order by s.updated_at desc
    limit 1;
    if v_old is not null then
      update service
      set deleted_at = null, name_en = left(r.name, 200), service_group = coalesce(v_grp, 'other'::service_group),
          category_id = v_cat, tariff_code = r.code, list_book_id = p_book,
          active = coalesce(v_live, false) and tariff_line_priced(r.prices, v_col),
          updated_at = now()
      where id = v_old;
      v_n := v_n + 1;
      continue;
    end if;
    v_code := left(r.code, 40);
    if exists (select 1 from service s where s.code = v_code) then
      v_code := left(r.code, 33) || '-' || upper(substr(md5(p_book::text || r.code), 1, 6));
    end if;
    insert into service (code, name_en, service_group, category_id, tariff_code, list_book_id, active)
    values (v_code, left(r.name, 200), coalesce(v_grp, 'other'::service_group), v_cat, r.code, p_book,
            coalesce(v_live, false) and tariff_line_priced(r.prices, v_col));
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- import_tariff (from 20270124090000_list_lines_missing)
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
    -- 0145: "-" = no column, the clinic sets its own cash prices (the treatments made stay
    -- inactive until they are priced); an existing list without a column keeps that
    if v_private = '-' or (v_private is null and p_book_id is not null and (p_book ->> 'privateColumn') is null) then
      v_private := null;
    elsif v_private is null or not v_private = any (v_keys) then
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
  analyze _tl_import;
  -- and how many treatments / medicines the clinic has (thousands may have just been made)
  if v_kind = 'treatments' then
    analyze service;
  else
    analyze item;
  end if;
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
    from (
      -- by code (one join: fast whatever the planner thinks of the tables), or linked on this list
      select n2.code, s2.id from _tl_import n2
      join service s2 on s2.deleted_at is null
        and tariff_code_norm(coalesce(nullif(s2.tariff_code, ''), s2.code)) = n2.code
      union
      select k.code, k.service_id from tariff_link k
      join _tl_import n2 on n2.code = k.code
      where k.book_id = v_book.id and k.service_id is not null
    ) m
    join _tl_import n on n.code = m.code
    join service s on s.id = m.id and s.deleted_at is null;

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
    from (
      select n2.code, i2.id from _tl_import n2
      join item i2 on i2.deleted_at is null and tariff_code_norm(i2.code) = n2.code
      union
      select k.code, k.item_id from tariff_link k
      join _tl_import n2 on n2.code = k.code
      where k.book_id = v_book.id and k.item_id is not null
    ) m
    join _tl_import n on n.code = m.code
    join item i on i.id = m.id and i.deleted_at is null;

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
  if v_scope = 'clinic' then
    with own as (
      select 'service'::text as kind, s.id, s.name_en as name, n.code, (n.prices ->> v_private)::numeric as list,
             (select pli.price from price_list pl join price_list_item pli on pli.price_list_id = pl.id
              where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null
                and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
                and pli.service_id = s.id
              order by pl.effective_from desc, pl.created_at desc limit 1) as own
      from (
        select n2.code, s2.id from _tl_import n2
        join service s2 on s2.deleted_at is null
          and tariff_code_norm(coalesce(nullif(s2.tariff_code, ''), s2.code)) = n2.code
        union
        select k.code, k.service_id from _tl_link k where k.service_id is not null
        union
        select k.code, k.service_id from tariff_link k
        join _tl_import n2 on n2.code = k.code
        where k.book_id = v_book.id and k.service_id is not null
      ) m
      join _tl_import n on n.code = m.code
      join service s on s.id = m.id and s.deleted_at is null
      where v_kind = 'treatments'
      union all
      select 'item', i.id, i.name_generic || coalesce(' ' || i.strength, ''), n.code, (n.prices ->> v_private)::numeric,
             (select pli.price from price_list pl join price_list_item pli on pli.price_list_id = pl.id
              where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null
                and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
                and pli.item_id = i.id
              order by pl.effective_from desc, pl.created_at desc limit 1)
      from (
        select n2.code, i2.id from _tl_import n2
        join item i2 on i2.deleted_at is null and tariff_code_norm(i2.code) = n2.code
        union
        select k.code, k.item_id from _tl_link k where k.item_id is not null
        union
        select k.code, k.item_id from tariff_link k
        join _tl_import n2 on n2.code = k.code
        where k.book_id = v_book.id and k.item_id is not null
      ) m
      join _tl_import n on n.code = m.code
      join item i on i.id = m.id and i.deleted_at is null
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
    -- a list of treatments, whoever publishes it (0172: an insurer's too): every line not yet a
    -- treatment of the clinic becomes one
    if v_kind = 'treatments' then
      v_created := tariff_make_services(v_book.id, v_version);
      perform notify_unpriced_treatments(v_book.id);
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

-- ---------------------------------------------------------------- add_stock (from 20261217090000_packaging_and_charging)
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
  v_list_detail text;
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
  v_pack integer;
  v_mode text;
  v_pack_price numeric;
  v_pack_unit text;
  v_pack_cost numeric;
  v_unit text;
  v_size integer;
  v_cur record;
  v_packaging boolean;
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
      v_packaging := false;
      v_ref := null;
      v_item := nullif(v_line ->> 'item_id', '')::uuid;
      v_new := case when jsonb_typeof(v_line -> 'new_item') = 'object' then v_line -> 'new_item' end;
      v_sell := nullif(v_line ->> 'sell_price', '')::numeric;
      -- 0102: the pieces in one pack, when the line was counted in boxes
      v_pack := nullif(v_line ->> 'pack_size', '')::integer;
      if v_pack is not null and v_pack < 1 then
        raise exception 'units per box: 1 or more' using errcode = '22023';
      end if;
      if v_sell is not null and v_sell < 0 then
        raise exception 'the price must be zero or more' using errcode = '22023';
      end if;
      -- 0107: the line may say the package and how it is sold (sale_mode: piece, pack or both),
      -- the pack price and the pack word; and the cost of one pack instead of one piece
      v_mode := nullif(trim(coalesce(v_line ->> 'sale_mode', '')), '');
      v_pack_price := nullif(v_line ->> 'pack_price', '')::numeric;
      v_pack_unit := nullif(trim(coalesce(v_line ->> 'pack_unit', '')), '');
      v_pack_cost := nullif(v_line ->> 'pack_cost', '')::numeric;
      v_unit := nullif(trim(coalesce(v_line ->> 'unit', '')), '');
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
            -- 0172: a medicine of an uploaded price list (the Ministry's, RSSB's, an insurer's):
            -- the item takes the line's code, so that list prices it
            select l.detail into v_list_detail
            from tariff_book b
            join tariff_version v on v.id = tariff_version_at(b.id, current_date)
            join tariff_line l on l.version_id = v.id and l.removed_at is null and l.code = tariff_code_norm(v_code)
            where b.kind = 'medicines' and b.deleted_at is null
            order by b.priority, b.created_at
            limit 1;
            if not found then
              raise exception 'this medicine is on no list' using errcode = 'P0002';
            end if;
          end if;
          select id into v_item from item where code = v_code;
          if v_item is not null then
            update item set deleted_at = null, active = true where id = v_item and (deleted_at is not null or not active);
          end if;
          -- 0102: the list's "B/20" is the pack size, unless the line says it
          v_pack := coalesce(v_pack, pack_size_in(v_ref.presentation));
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
          insert into item (code, name_generic, strength, form, unit, selling_unit, active, kind, pack_size)
          values (coalesce(v_code, case when v_kind = 'supply' then 'SUP-' else 'MED-' end
                    || lpad(next_number('item_code', 0)::text, 4, '0')),
                  v_name, v_strength, nullif(trim(coalesce(v_new ->> 'form', '')), ''),
                  nullif(trim(coalesce(v_new ->> 'unit', '')), ''), nullif(trim(coalesce(v_new ->> 'unit', '')), ''),
                  true, v_kind, v_pack)
          returning id into v_item;
          if v_code is not null then
            update item set prescribing_rule = v_ref.prescribing_rule, atc_group = v_ref.atc_group,
                            name_brand = coalesce(v_ref.presentation, v_list_detail), source = coalesce(v_ref.source, source)
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
      -- 0107: the package and how it is sold, said on the line: a new item takes them; an item
      -- already known changes only for a person with the price right (else they are left as they
      -- are and the line says so)
      if v_mode is not null then
        select i.pack_size, i.sale_mode, i.pack_price, i.pack_unit, i.selling_unit,
               (select pf.price from price_for(null, i.id, null) pf) as price
        into v_cur from item i where i.id = v_item;
        if v_created
           or coalesce(case when coalesce(v_pack, 1) >= 2 then v_pack end, 0)
                is distinct from coalesce(case when coalesce(v_cur.pack_size, 1) >= 2 then v_cur.pack_size end, 0)
           or v_mode is distinct from v_cur.sale_mode
           or (v_mode <> 'piece' and round(v_pack_price) is distinct from v_cur.pack_price)
           or (v_mode <> 'pack' and v_sell is not null and round(v_sell) is distinct from v_cur.price)
           or (v_pack_unit is not null and coalesce(v_pack, 1) >= 2 and v_pack_unit is distinct from v_cur.pack_unit)
           or (v_unit is not null and v_unit is distinct from v_cur.selling_unit) then
          if v_created or v_price_right then
            perform apply_item_packaging(v_item, v_pack, v_mode,
                                         case when v_mode = 'pack' then null else coalesce(v_sell, v_cur.price) end,
                                         v_pack_price, v_unit, v_pack_unit);
            v_updated := true;
            v_packaging := true;
          else
            v_ignored := true;
          end if;
        end if;
        -- the price was said with the package
        v_sell := null;
      end if;
      -- an item without a pack size takes the one the line was counted with
      if v_pack is not null then
        update item set pack_size = v_pack where id = v_item and pack_size is null;
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
      -- 0107: the cost of one pack: the cost of one piece is that / the pieces in one pack
      v_size := (select case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end from item i where i.id = v_item);
      if v_pack_cost is not null then
        if v_pack_cost < 0 then
          raise exception 'the cost per unit must be zero or more' using errcode = '22023';
        end if;
        if v_size is null then
          raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
        end if;
        v_cost := v_pack_cost / v_size;
      end if;
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
      v_line_cost := case when v_pack_cost is not null then round(v_pack_cost * v_units / v_size, 2)
                          else round(round(v_cost, 2) * v_units, 2) end;
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      select v_id, v_item, b.id, b.batch_no, b.expiry,
             case when v_pack_cost is not null and v_units % v_size = 0 then 'box' else 'unit' end,
             case when v_pack_cost is not null and v_units % v_size = 0 then v_units / v_size else v_units end,
             case when v_pack_cost is not null and v_units % v_size = 0 then v_size else 1 end,
             v_units, round(v_cost, 2), case when v_pack_cost is not null then round(v_pack_cost, 2) end, v_line_cost
      from batch b where b.id = v_batch;
      v_total := v_total + v_line_cost;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item, 'batch_id', v_batch, 'quantity', v_units, 'line_cost', v_line_cost,
        'created', v_created, 'price_updated', v_updated, 'price_ignored', v_ignored,
        'pack_size', (select pack_size from item where id = v_item),
        'sale_mode', (select sale_mode from item where id = v_item), 'packaging_updated', v_packaging));
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

-- ---------------------------------------------------------------- prescribe (from 20261212090000_visit_edit_lock)
create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null, p_location_id uuid default null,
  p_medicine_name text default null, p_reference_code text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
  v_loc uuid;
  v_taken boolean := false;
  v_qty integer;
  v_supply text := coalesce(p_supply, 'pharmacy');
  v_code text := nullif(trim(coalesce(p_reference_code, '')), '');
  v_name text;
  v_generic text;
  v_rule text;
  v_warn jsonb := '[]'::jsonb;
  v_closed boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if v_supply not in ('pharmacy', 'room', 'outside') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select e.status = 'closed' into v_closed from encounter e where e.id = p_encounter_id;
  if v_closed and v_supply <> 'outside' then
    raise exception 'the visit is finished: a medicine added now can only be bought outside' using errcode = '22023';
  end if;
  if p_item_id is null then
    -- not a clinic medicine: only for an outside pharmacy, named (or taken from the official list)
    if v_supply <> 'outside' then
      raise exception 'this medicine is not sold at the clinic: it can only be bought outside' using errcode = '22023';
    end if;
    if v_code is not null then
      select r.generic, r.prescribing_rule into v_generic, v_rule from medicine_reference r where r.code = v_code;
      if not found then
        -- 0172: a line of an uploaded medicines list
        select l.name || coalesce(' ' || l.detail, '') into v_generic
        from tariff_book b
        join tariff_version v on v.id = tariff_version_at(b.id, current_date)
        join tariff_line l on l.version_id = v.id and l.removed_at is null and l.code = tariff_code_norm(v_code)
        where b.kind = 'medicines' and b.deleted_at is null
        order by b.priority, b.created_at
        limit 1;
        if not found then
          raise exception 'medicine not found' using errcode = 'P0002';
        end if;
      end if;
      v_warn := coalesce(rx_rule_warnings(v_rule, auth.uid()), '[]'::jsonb);
    end if;
    v_name := coalesce(nullif(trim(coalesce(p_medicine_name, '')), ''), v_generic);
    if v_name is null then
      raise exception 'write the name of the medicine to buy outside' using errcode = '22023';
    end if;
  else
    if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
    v_warn := coalesce(rx_warnings(p_item_id, auth.uid()), '[]'::jsonb);
    if v_supply = 'outside' then
      -- the print keeps its name even if the catalogue changes
      v_name := item_label(p_item_id);
      v_code := coalesce(v_code, (select i.code from item i where i.id = p_item_id
                                    and exists (select 1 from medicine_reference r where r.code = i.code)));
    else
      v_code := null;
    end if;
  end if;
  if v_supply = 'room' then
    -- Given here: only from a store that holds enough unexpired units; never given without stock.
    v_qty := ceil(p_quantity)::integer;
    v_loc := room_store_for(auth.uid(), p_item_id, v_qty, p_location_id, p_station);
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in %: prescribe it for the pharmacy instead',
        case when p_location_id is null then 'a store you may give from' else 'that store' end
        using errcode = 'MS003', hint = 'room_short';
    end if;
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by, medicine_name, reference_code,
                                  supply_set_at, supply_set_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), v_supply,
          case when v_supply = 'room' then now() end, case when v_supply = 'room' then auth.uid() end,
          v_name, v_code, now(), auth.uid())
  returning id into v_id;
  if v_supply = 'room' then
    perform give_from_store(p_item_id, v_loc, v_qty, v_id, 'given in the room');
    v_taken := true;
    -- on the bill at the medicine's price (no price: given free); a closed bill refuses (MS001)
    begin
      perform add_charge_internal(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif v_supply = 'pharmacy'
        and not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy'
                        and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  -- 'outside': nothing charged, nothing taken, nothing queued
  perform note_visit_edit(p_encounter_id, 'create', 'medication_request', v_id,
                          jsonb_build_object('item', v_name, 'itemId', p_item_id, 'quantity', p_quantity, 'supply', v_supply));
  return jsonb_build_object('id', v_id, 'supply', v_supply, 'charged', v_charged,
                            'stockTaken', v_taken, 'locationId', v_loc, 'medicineName', v_name,
                            'warnings', v_warn);
end
$$;
