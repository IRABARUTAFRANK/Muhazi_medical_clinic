-- 0134 · Published price lists: the tariffs of treatments and of medicines that the Ministry of
-- Health, RSSB / RHIA and the insurers publish, each with its versions and price columns, the
-- insurers that follow them, and each insurer's exceptions.
--
-- Frank (owner): "Sometimes MoH gives out the list of medicines and products and we need to upload
-- the list of those products and their prices. The insurance companies give out their lists in two
-- parts, one for medicines and products and one for treatments. MoH or RSSB publishes a list of
-- treatments or of medicines with prices set; some insurers follow it with an exception (a MoH
-- list, but Eden Care does not follow that tariff). Make it flexible so that parts can be edited
-- when needed. On all tariffs check: there may be exceptions and price changes."
--
-- The three files of November 2026: the MoH tariff for private facilities 2025-2027 (treatments
-- RHIC-…, lab tests RLTC-…; six prices: RAMA/MMI, private insurances, non-insured privates, East
-- Africa, Africans, rest of the world); the MoH dental & physiotherapy tariff (three prices:
-- general clinics, polyclinics, hospitals) with Eden Care's instructions ("NC: not covered by Eden
-- Care unless special pre-authorisation", "maximum 2 teeth a day"…); the RSSB list of the
-- medicines it reimburses in private facilities (June 2026, a PDF; its codes are the RHIA codes).
--
--   * tariff_book: a published list (name, publisher, kind treatments | medicines, the insurer
--     that publishes it when it is one). tariff_version: each upload (name, from, its price
--     columns [{key, label}], the file's notes, what the check found, current | past).
--     tariff_line: the lines of a version (code, name, detail, section, other code, unit, a price
--     per column, the publisher's instruction; edited by hand: who, when and the line as uploaded).
--   * payer_tariff: the lists an insurer follows and the price column that is its own (RSSB RAMA:
--     "RAMA; MMI", Eden Care: "Polyclinic"…), in an order (the first list with the line prices it).
--   * tariff_exception: one insurer, one code: not covered, covered only with its approval
--     (pre-authorisation), its own price, a note. Typed by hand, or read from the instruction
--     column of an uploaded file said to be that insurer's (NC / not reimbursable / included in
--     another act → not covered; approval / pre-auth → with its approval; anything else → a note).
--     A typed exception is never overwritten by an upload.
--   * service.tariff_code: the code a clinic treatment has on the published lists (RHIC-CONS-001);
--     a medicine's is its own code (the RHIA code). An upload links a treatment whose name is the
--     name of exactly one line.
--   * price_source_for: the insurer's own price list (0115) → its exception price → the lists it
--     follows (the version in effect on the day, its column) → the official medicine list (0098)
--     → the cash price. Two new sources: 'excluded' (the exception says not covered: no insurer
--     share) and 'preauth' (covered once the person confirms the insurer approved: an added
--     treatment or a hand-over is refused with hint insurer_preauth until confirmed through
--     add_charge_confirmed / dispense_prescription_confirmed). add_charge_internal,
--     set_visit_payer, insurer_tariff_rows and pharmacy_queue split the line accordingly.
--   * import_tariff(…, dry_run): the upload and its check. Against the version in use: the new
--     lines, the lines gone, every price change per column, the names changed, the lines edited by
--     hand before. In the file: the rows left out (no code, no name, a code twice) and the prices
--     that are not numbers, are zero or are missing. The clinic: its treatments and medicines found
--     on the list (by code, by name: linked) and those no longer on it. The insurers: those that
--     follow the list (and a column the new file no longer has), their exceptions on lines gone,
--     their own prices and exception prices that differ from the new list's; the instructions read
--     as the chosen insurer's exceptions.
--   * tariff_books(), tariff_lines(version, search, payer, section, limit, offset),
--     save_tariff_line, remove_tariff_line, set_payer_tariff, save_tariff_exception,
--     link_tariff_service, save_tariff_book. The manager or whoever holds catalogue.write changes;
--     any signed-in staff member reads.
--
-- Errcodes: 42501 not allowed, 22023 bad input, P0002 not found, MS004 + hint insurer_preauth.

-- ---------------------------------------------------------------- the lists
create table if not exists tariff_book (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  publisher text not null,
  kind text not null check (kind in ('treatments', 'medicines')),
  payer_id uuid references payer (id),
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists tariff_book_name_uq on tariff_book (lower(name)) where deleted_at is null;

create table if not exists tariff_version (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references tariff_book (id),
  name text not null,
  effective_from date not null,
  columns jsonb not null default '[]'::jsonb,
  uploaded_by uuid references profiles (id),
  uploaded_at timestamptz not null default now(),
  file_name text,
  rows integer not null default 0,
  notes text,
  summary jsonb not null default '{}'::jsonb,
  instructions_payer_id uuid references payer (id),
  status text not null default 'current' check (status in ('current', 'past'))
);
create unique index if not exists tariff_version_one_current on tariff_version (book_id) where status = 'current';
create index if not exists tariff_version_book_idx on tariff_version (book_id, effective_from desc);
comment on column tariff_version.columns is
  'The price columns of the file, in order: [{"key": "rama_mmi", "label": "RAMA; MMI"}, …].';

create table if not exists tariff_line (
  version_id uuid not null references tariff_version (id) on delete cascade,
  code text not null,
  name text not null,
  detail text,
  section text,
  alt_code text,
  unit text,
  prices jsonb not null default '{}'::jsonb,
  note text,
  row integer,
  original jsonb,
  edited_by uuid references profiles (id),
  edited_at timestamptz,
  removed_at timestamptz,
  primary key (version_id, code)
);
create index if not exists tariff_line_code_idx on tariff_line (code);
comment on column tariff_line.prices is 'A price per column key of the version: {"rama_mmi": 72457, …}; null = none.';
comment on column tariff_line.original is 'The line as uploaded, kept the first time it is edited by hand ({"added": true}: typed).';

create table if not exists payer_tariff (
  payer_id uuid not null references payer (id),
  book_id uuid not null references tariff_book (id),
  column_key text not null,
  priority integer not null default 100,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  primary key (payer_id, book_id)
);

create table if not exists tariff_exception (
  payer_id uuid not null references payer (id),
  code text not null,
  book_id uuid references tariff_book (id),
  cover text not null default 'covered' check (cover in ('covered', 'not_covered', 'preauth')),
  price numeric(12, 0) check (price is null or price >= 0),
  note text,
  source text not null default 'typed' check (source in ('typed', 'upload')),
  version_id uuid references tariff_version (id) on delete set null,
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now(),
  primary key (payer_id, code)
);

alter table service add column if not exists tariff_code text;
create index if not exists service_tariff_code_idx on service (upper(tariff_code)) where tariff_code is not null;

do $$
declare
  t text;
begin
  foreach t in array array['tariff_book', 'tariff_version', 'tariff_line', 'payer_tariff', 'tariff_exception'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- small helpers
-- "Extraction of decidous tooth " → "extraction of decidous tooth" (names compared without case,
-- accents or punctuation).
create or replace function tariff_norm(p text)
returns text
language sql immutable
as $$
  select nullif(trim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g')), '')
$$;

-- " rhic-dent 001" → "RHIC-DENT001": a code as the lists keep it.
create or replace function tariff_code_norm(p text)
returns text
language sql immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '')
$$;

-- An instruction of an insurer read as its cover: NC / not reimbursable / not covered / included
-- in another act → not_covered; approval / pre-authorisation → preauth; anything else → covered
-- (the instruction stays as a note).
create or replace function tariff_cover_of(p_note text)
returns text
language sql immutable
as $$
  select case
    when p_note is null or trim(p_note) = '' then 'covered'
    when p_note ~* '^\s*n\.?\s*c\.?\s*($|[^a-z])'
      or p_note ~* 'not\s+(re-?\s*)?imburs|not\s+covered|non\s+(couvert|rembours)|excluded|included\s+in'
      then 'not_covered'
    when p_note ~* 'pre-?\s*auth|approval|prior\s+auth|accord\s+pr' then 'preauth'
    else 'covered'
  end
$$;

-- The code of a clinic treatment on the lists (its list code, else its own code), or of a medicine.
create or replace function tariff_code_of(p_service_id uuid, p_item_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when p_service_id is not null then
      (select tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) from service s where s.id = p_service_id)
    when p_item_id is not null then (select tariff_code_norm(i.code) from item i where i.id = p_item_id)
  end
$$;

-- The version of a list in effect on a date: the latest that starts on or before it (the same
-- date: the last uploaded). None before the first one starts.
create or replace function tariff_version_at(p_book uuid, p_at date default current_date)
returns uuid
language sql stable security definer set search_path = public
as $$
  select v.id from tariff_version v
  where v.book_id = p_book and v.effective_from <= coalesce(p_at, current_date)
  order by v.effective_from desc, v.uploaded_at desc
  limit 1
$$;

-- What the lists an insurer follows say for a treatment or a medicine on a date: the first list
-- (by the insurer's order) whose version in effect has the line with a price in the insurer's
-- column. Treatments are priced from lists of treatments, medicines and products from lists of
-- medicines.
create or replace function tariff_price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, book_id uuid, code text, note text)
language sql stable security definer set search_path = public
as $$
  select round((l.prices ->> pt.column_key)::numeric), pt.book_id, l.code, l.note
  from payer_tariff pt
  join tariff_book b on b.id = pt.book_id and b.deleted_at is null
    and b.kind = case when p_service_id is not null then 'treatments' else 'medicines' end
  join tariff_line l on l.version_id = tariff_version_at(pt.book_id, p_at)
    and l.code = tariff_code_of(p_service_id, p_item_id) and l.removed_at is null
  where pt.payer_id = p_payer_id and p_payer_id is not null
    and jsonb_typeof(l.prices -> pt.column_key) = 'number'
  order by pt.priority, pt.created_at
  limit 1
$$;

-- ---------------------------------------------------------------- the price and where it comes from
-- price_source_for (from 20261225090000_insurer_tariffs): the insurer's own price list, then its
-- exception price, then the lists it follows, then the official medicine list (medicines, an
-- insurer that follows it), then the cash price. The insurer's exception on the line's code turns
-- the source into 'excluded' (not covered) or 'preauth' (covered with its approval) whatever the
-- price. Same arguments and columns: price_for and every reader keep working.
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
begin
  if p_payer_id is not null then
    -- 0134: the insurer's exception on this line (by its code on the lists)
    select e.cover, e.price into v_cover, v_ex_price
    from tariff_exception e
    where e.payer_id = p_payer_id and e.code = tariff_code_of(p_service_id, p_item_id);

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

-- ---------------------------------------------------------------- the upload and its check
-- import_tariff: a new list (p_book {name, publisher, kind, payerId}) or a new version of a list
-- (p_book_id). p_columns [{key, label}] are the price columns of the file; p_lines
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

  -- whose instructions
  if p_instructions_payer is not null then
    select * into v_ipayer from payer where id = p_instructions_payer and deleted_at is null and type <> 'cash';
    if not found then
      raise exception 'insurer not found' using errcode = 'P0002';
    end if;
  end if;

  create temp table if not exists _tariff_import (
    code text primary key,
    row integer,
    name text not null,
    norm text,
    detail text,
    section text,
    alt_code text,
    unit text,
    prices jsonb not null,
    note text
  ) on commit drop;
  truncate _tariff_import;
  create temp table if not exists _tariff_link (
    service_id uuid primary key,
    code text not null
  ) on commit drop;
  truncate _tariff_link;

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
    if v_code is null then
      v_err := 'no_code';
    elsif length(v_code) > 40 then
      v_err := 'bad_code';
    elsif v_lname is null then
      v_err := 'no_name';
    elsif exists (select 1 from _tariff_import where code = v_code) then
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
    insert into _tariff_import (code, row, name, norm, detail, section, alt_code, unit, prices, note)
    values (v_code, v_row, left(v_lname, 300), tariff_norm(v_lname),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'detail', '')), '\s+', ' ', 'g'), ''), 300),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'section', '')), '\s+', ' ', 'g'), ''), 200),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'altCode', '')), '\s+', ' ', 'g'), ''), 60),
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'unit', '')), '\s+', ' ', 'g'), ''), 60),
            v_prices,
            left(nullif(regexp_replace(trim(coalesce(v_r ->> 'note', '')), '\s+', ' ', 'g'), ''), 500));
  end loop;
  select count(*)::int into v_valid from _tariff_import;

  -- ---- against the version in use
  if v_cur.id is not null then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'prices', n.prices)
                                             order by n.name, n.code) filter (where n.rn <= v_cap), '[]'::jsonb)
    into v_n_new, v_new
    from (select n.*, row_number() over (order by n.name, n.code) as rn
          from _tariff_import n
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
            and not exists (select 1 from _tariff_import n where n.code = e.code)) e;

    with c as (
      select n.code, n.name, k.key, k.label, k.ord,
             (e.prices ->> k.key)::numeric as old, (n.prices ->> k.key)::numeric as new
      from _tariff_import n
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
    from _tariff_import n
    join tariff_line e on e.version_id = v_cur.id and e.code = n.code and e.removed_at is null
    where not exists (
      select 1 from jsonb_array_elements(v_cols) x
      where v_cur.columns @> jsonb_build_array(jsonb_build_object('key', x.value ->> 'key'))
        and (e.prices ->> (x.value ->> 'key')) is distinct from (n.prices ->> (x.value ->> 'key')));

    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'old', e.name, 'new', n.name) order by n.name), '[]'::jsonb)
    into v_renamed
    from (select n.*, row_number() over (order by n.name) as rn from _tariff_import n) n
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
    from _tariff_import n
    join service s on s.deleted_at is null and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = n.code;

    -- by name: a treatment with no list code, not already on the list by its own code, whose name
    -- is the name of exactly one line no other treatment has
    insert into _tariff_link (service_id, code)
    with cand as (
      select s.id, n.code
      from service s
      join _tariff_import n on n.norm is not null and (n.norm = tariff_norm(s.name_en) or n.norm = tariff_norm(s.name_fr))
      where s.deleted_at is null and coalesce(s.tariff_code, '') = ''
        and not exists (select 1 from _tariff_import m where m.code = tariff_code_norm(s.code))
    )
    select c.id, min(c.code)
    from cand c
    where (select count(distinct c2.code) from cand c2 where c2.id = c.id) = 1
      and (select count(distinct c3.id) from cand c3 where c3.code = c.code) = 1
      and not exists (select 1 from service s2 where s2.deleted_at is null
                        and tariff_code_norm(coalesce(nullif(s2.tariff_code, ''), s2.code)) = c.code)
    group by c.id;

    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'id', s.id, 'clinicName', s.name_en,
                                                 'active', s.active) order by n.name), '[]'::jsonb)
    into v_by_name
    from _tariff_link k
    join service s on s.id = k.service_id
    join _tariff_import n on n.code = k.code;

    select coalesce(jsonb_agg(jsonb_build_object('code', tariff_code_norm(s.tariff_code), 'id', s.id,
                                                 'clinicName', s.name_en) order by s.name_en), '[]'::jsonb)
    into v_gone_clinic
    from service s
    where s.deleted_at is null and coalesce(s.tariff_code, '') <> ''
      and not exists (select 1 from _tariff_import n where n.code = tariff_code_norm(s.tariff_code))
      and (v_cur.id is null or exists (select 1 from tariff_line e where e.version_id = v_cur.id
                                         and e.code = tariff_code_norm(s.tariff_code)));
  else
    select coalesce(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.name, 'id', i.id,
                                                 'clinicName', i.name_generic || coalesce(' ' || i.strength, ''),
                                                 'active', i.active) order by n.name), '[]'::jsonb)
    into v_by_code
    from _tariff_import n
    join item i on i.deleted_at is null and tariff_code_norm(i.code) = n.code;

    if v_cur.id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'id', i.id,
                                                   'clinicName', i.name_generic || coalesce(' ' || i.strength, ''))
                                order by i.name_generic), '[]'::jsonb)
      into v_gone_clinic
      from item i
      where i.deleted_at is null
        and exists (select 1 from tariff_line e where e.version_id = v_cur.id and e.code = tariff_code_norm(i.code)
                      and e.removed_at is null)
        and not exists (select 1 from _tariff_import n where n.code = tariff_code_norm(i.code));
    end if;
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
        and not exists (select 1 from _tariff_import n where n.code = e.code);
    end if;

    -- an insurer's exception price that is not the new list's price in its column
    select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'code', n.code, 'name', n.name, 'own', e.price,
                                                 'list', (n.prices ->> pt.column_key)::numeric) order by py.name, n.name), '[]'::jsonb)
    into v_ex_prices
    from tariff_exception e
    join payer_tariff pt on pt.payer_id = e.payer_id and pt.book_id = v_book.id
    join payer py on py.id = e.payer_id
    join _tariff_import n on n.code = e.code
    where e.price is not null and e.price is distinct from (n.prices ->> pt.column_key)::numeric;

    -- an insurer's own price (its uploaded tariff, 0115) on the day the version starts that is not
    -- the new list's price in its column
    with own as (
      select pt.payer_id, pt.column_key, n.code, n.name, n.prices, pf.price
      from payer_tariff pt
      join _tariff_import n on true
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
    from (select n.*, row_number() over (order by n.name) as rn from _tariff_import n where n.note is not null) n
    left join tariff_exception e on e.payer_id = p_instructions_payer and e.code = n.code;

    select count(*)::int into v_dropped
    from tariff_exception e
    where e.payer_id = p_instructions_payer and e.source = 'upload'
      and (e.book_id = v_book.id or v_book.id is null)
      and not exists (select 1 from _tariff_import n where n.code = e.code and n.note is not null);
    if v_book.id is null then
      v_dropped := 0;
    end if;

    v_instr := jsonb_build_object(
      'payerId', v_ipayer.id, 'payer', v_ipayer.name,
      'notCovered', (select count(*)::int from _tariff_import n where n.note is not null and tariff_cover_of(n.note) = 'not_covered'),
      'preauth', (select count(*)::int from _tariff_import n where n.note is not null and tariff_cover_of(n.note) = 'preauth'),
      'notes', (select count(*)::int from _tariff_import n where n.note is not null and tariff_cover_of(n.note) = 'covered'),
      'keptTyped', v_kept_typed, 'dropped', v_dropped, 'lines', v_instr_lines,
      'follows', v_book.id is not null and exists (select 1 from payer_tariff pt where pt.book_id = v_book.id
                                                     and pt.payer_id = p_instructions_payer));
  end if;

  v_summary := jsonb_build_object(
    'total', jsonb_array_length(p_lines), 'rows', v_valid, 'new', v_n_new, 'changedLines', v_n_changed,
    'changes', v_n_changes, 'removed', v_n_removed, 'unchanged', v_unchanged, 'errors', v_n_errors,
    'warnings', v_n_warnings, 'byCode', jsonb_array_length(v_by_code), 'byName', jsonb_array_length(v_by_name),
    'instructions', case when v_instr is null then null
                         else v_instr - 'lines' - 'payerId' end,
    'previous', case when v_cur.id is null then null
                     else jsonb_build_object('name', v_cur.name, 'effectiveFrom', v_cur.effective_from, 'rows', v_cur.rows) end);

  if not p_dry_run then
    if v_valid = 0 then
      raise exception 'no row of the list can be used' using errcode = '22023';
    end if;
    if v_book.id is null then
      insert into tariff_book (name, publisher, kind, payer_id, created_by)
      values (v_bname, v_publisher, v_kind, v_bpayer, auth.uid())
      returning * into v_book;
      insert into audit_event (actor_id, action, entity, entity_id, after)
      values (auth.uid(), 'create', 'tariff_book', v_book.id,
              jsonb_build_object('name', v_bname, 'publisher', v_publisher, 'kind', v_kind));
    end if;
    update tariff_version set status = 'past' where book_id = v_book.id and status = 'current';
    insert into tariff_version (book_id, name, effective_from, columns, uploaded_by, file_name, rows, notes, summary,
                                instructions_payer_id, status)
    values (v_book.id, v_name, p_from, v_cols, auth.uid(),
            left(nullif(trim(coalesce(p_file_name, '')), ''), 200), v_valid,
            left(nullif(trim(coalesce(p_notes, '')), ''), 4000), v_summary, p_instructions_payer, 'current')
    returning id into v_version;
    insert into tariff_line (version_id, code, name, detail, section, alt_code, unit, prices, note, row)
    select v_version, code, name, detail, section, alt_code, unit, prices, note, row from _tariff_import;
    -- the clinic's treatments found by name now carry the list's code
    update service s set tariff_code = k.code, updated_at = now()
    from _tariff_link k where s.id = k.service_id;
    get diagnostics v_linked = row_count;
    -- the instructions: the insurer's exceptions on this list (its typed ones are kept)
    if p_instructions_payer is not null then
      delete from tariff_exception e
      where e.payer_id = p_instructions_payer and e.source = 'upload' and e.book_id = v_book.id
        and not exists (select 1 from _tariff_import n where n.code = e.code and n.note is not null);
      insert into tariff_exception (payer_id, code, book_id, cover, note, source, version_id, updated_by, updated_at)
      select p_instructions_payer, n.code, v_book.id, tariff_cover_of(n.note), n.note, 'upload', v_version, auth.uid(), now()
      from _tariff_import n
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
  truncate _tariff_import;
  truncate _tariff_link;

  return jsonb_build_object(
    'dryRun', p_dry_run, 'bookId', v_book.id, 'versionId', v_version,
    'book', jsonb_build_object('name', coalesce(v_book.name, v_bname), 'publisher', coalesce(v_book.publisher, v_publisher),
                               'kind', v_kind, 'isNew', p_book_id is null),
    'name', v_name, 'effectiveFrom', p_from, 'columns', v_cols,
    'total', jsonb_array_length(p_lines), 'rows', v_valid,
    'new', v_n_new, 'newLines', v_new,
    'changedLines', v_n_changed, 'changes', v_n_changes, 'changed', v_changed,
    'removed', v_n_removed, 'removedLines', v_removed,
    'unchanged', v_unchanged, 'renamed', v_renamed, 'edited', v_edited,
    'columnsAdded', v_cols_added, 'columnsGone', v_cols_gone,
    'errors', v_errors, 'errorCount', v_n_errors, 'warnings', v_warnings, 'warningCount', v_n_warnings,
    'clinic', jsonb_build_object('byCode', v_by_code, 'byName', v_by_name, 'gone', v_gone_clinic, 'linked', v_linked),
    'followers', v_followers,
    'checks', jsonb_build_object('exceptionsOnRemoved', v_ex_removed, 'ownPrices', v_own, 'exceptionPrices', v_ex_prices),
    'instructions', v_instr,
    'current', case when v_cur.id is null then null
                    else jsonb_build_object('name', v_cur.name, 'effectiveFrom', v_cur.effective_from, 'rows', v_cur.rows) end);
end
$$;

-- ---------------------------------------------------------------- reading the lists
-- tariff_books: every published list with its versions (the one in effect today marked), the
-- insurers that follow it (their column, their order), its exceptions and how many of the clinic's
-- treatments or medicines are on the version in use.
create or replace function tariff_books()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'publisher', b.publisher, 'kind', b.kind, 'payerId', b.payer_id, 'payer', bp.name,
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
      'linked', case b.kind
        when 'treatments' then (
          select count(*)::int from service s
          join tariff_line l on l.code = tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) and l.removed_at is null
          join tariff_version v on v.id = l.version_id and v.book_id = b.id and v.status = 'current'
          where s.deleted_at is null and s.active)
        else (
          select count(*)::int from item i
          join tariff_line l on l.code = tariff_code_norm(i.code) and l.removed_at is null
          join tariff_version v on v.id = l.version_id and v.book_id = b.id and v.status = 'current'
          where i.deleted_at is null and i.active) end
    ) order by b.kind desc, b.name), '[]'::jsonb)
  from tariff_book b
  left join payer bp on bp.id = b.payer_id
  where b.deleted_at is null and auth.uid() is not null
$$;

-- tariff_lines: the lines of one version, searched by code or name (and a section), a page at a
-- time; each with the clinic's treatments or medicines that carry its code and, for p_payer, that
-- insurer's exception.
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
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_norm text := tariff_norm(p_search);
  v_total integer;
  v_lines jsonb;
  v_sections jsonb;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select b.kind into v_kind from tariff_version v join tariff_book b on b.id = v.book_id
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
               select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name_en, 'active', s.active,
                                                            'linked', coalesce(s.tariff_code, '') <> '')), '[]'::jsonb)
               from service s where s.deleted_at is null
                 and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = p.code)
             else (
               select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
                                                            'active', i.active, 'linked', true)), '[]'::jsonb)
               from item i where i.deleted_at is null and tariff_code_norm(i.code) = p.code) end,
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

-- ---------------------------------------------------------------- the insurers and the lists
-- set_payer_tariff: the insurer follows the list and pays the prices of one of its columns
-- (p_column null: it stops following it). p_priority: its place among the insurer's lists (the
-- first with the line prices it); a new one goes last.
create or replace function set_payer_tariff(p_payer uuid, p_book uuid, p_column text, p_priority integer default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_book tariff_book%rowtype;
  v_cols jsonb;
  v_key text := nullif(lower(trim(coalesce(p_column, ''))), '');
  v_prio integer;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  select * into v_book from tariff_book where id = p_book and deleted_at is null;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  if v_key is null then
    delete from payer_tariff where payer_id = p_payer and book_id = p_book;
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'delete', 'payer_tariff', p_book, jsonb_build_object('payer', v_payer.code, 'list', v_book.name));
    return;
  end if;
  select v.columns into v_cols from tariff_version v where v.book_id = p_book and v.status = 'current';
  if v_cols is null or not v_cols @> jsonb_build_array(jsonb_build_object('key', v_key)) then
    raise exception 'this price column is not in the list' using errcode = '22023';
  end if;
  v_prio := coalesce(p_priority,
                     (select pt.priority from payer_tariff pt where pt.payer_id = p_payer and pt.book_id = p_book),
                     (select coalesce(max(pt.priority), 0) + 10 from payer_tariff pt where pt.payer_id = p_payer));
  insert into payer_tariff (payer_id, book_id, column_key, priority, created_by)
  values (p_payer, p_book, v_key, v_prio, auth.uid())
  on conflict (payer_id, book_id) do update set column_key = excluded.column_key, priority = excluded.priority;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'payer_tariff', p_book,
          jsonb_build_object('payer', v_payer.code, 'list', v_book.name, 'column', v_key, 'priority', v_prio));
end
$$;

-- save_tariff_exception: one insurer's exception on one code: its cover (covered, not_covered,
-- preauth), its own price, a note. Covered with no price and no note: the exception is taken away.
-- Typed by hand: an upload of the insurer's instructions never overwrites it.
create or replace function save_tariff_exception(
  p_payer uuid,
  p_code text,
  p_cover text,
  p_price numeric default null,
  p_note text default null,
  p_book uuid default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_code text := tariff_code_norm(p_code);
  v_cover text := coalesce(nullif(trim(coalesce(p_cover, '')), ''), 'covered');
  v_note text := left(nullif(regexp_replace(trim(coalesce(p_note, '')), '\s+', ' ', 'g'), ''), 500);
  v_old tariff_exception%rowtype;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  if v_code is null or length(v_code) > 40 then
    raise exception 'give the line a code' using errcode = '22023';
  end if;
  if v_cover not in ('covered', 'not_covered', 'preauth') then
    raise exception 'say whether the insurer covers it' using errcode = '22023';
  end if;
  if p_price is not null and (p_price < 0 or p_price > 9999999999) then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if p_book is not null and not exists (select 1 from tariff_book where id = p_book and deleted_at is null) then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;
  select * into v_old from tariff_exception where payer_id = p_payer and code = v_code;
  if v_cover = 'covered' and p_price is null and v_note is null then
    delete from tariff_exception where payer_id = p_payer and code = v_code;
  else
    insert into tariff_exception (payer_id, code, book_id, cover, price, note, source, updated_by, updated_at)
    values (p_payer, v_code, coalesce(p_book, v_old.book_id), v_cover, round(p_price), v_note, 'typed', auth.uid(), now())
    on conflict (payer_id, code) do update
      set book_id = coalesce(excluded.book_id, tariff_exception.book_id), cover = excluded.cover, price = excluded.price,
          note = excluded.note, source = 'typed', updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'tariff_exception', p_book,
          case when v_old.code is null then null
               else jsonb_build_object('cover', v_old.cover, 'price', v_old.price, 'note', v_old.note) end,
          jsonb_build_object('payer', v_payer.code, 'code', v_code, 'cover', v_cover, 'price', round(p_price), 'note', v_note));
end
$$;

-- link_tariff_service: the code a clinic treatment has on the published lists (null: none; the
-- treatment's own code then counts).
create or replace function link_tariff_service(p_service uuid, p_code text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_svc service%rowtype;
  v_code text := tariff_code_norm(p_code);
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_svc from service where id = p_service and deleted_at is null;
  if not found then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;
  if v_code is not null and length(v_code) > 40 then
    raise exception 'give the line a code' using errcode = '22023';
  end if;
  update service set tariff_code = v_code, updated_at = now() where id = p_service;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'service', p_service,
          jsonb_build_object('tariffCode', v_svc.tariff_code), jsonb_build_object('tariffCode', v_code));
end
$$;

-- ---------------------------------------------------------------- the bill follows the exceptions
-- add_charge_internal (from 20261225090000_insurer_tariffs): + the insurer's exception (source
-- 'excluded': coverage 0; 'preauth': refused with hint insurer_preauth until confirmed). Same
-- arguments.
create or replace function add_charge_internal(
  p_encounter_id uuid,
  p_office station,
  p_service_id uuid default null,
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_manual_price numeric default null,
  p_manual_reason text default null,
  p_performed_by uuid default null,
  p_entered_for uuid default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_discount_pct numeric default 0,
  p_discount_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_plan uuid;
  v_group service_group;
  v_desc text;
  v_price numeric;
  v_unit numeric;
  v_fallback boolean;
  v_source text;
  v_rule text;
  v_payer_type payer_type;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
  v_max_discount numeric := 0;
  v_discount numeric := coalesce(p_discount_pct, 0);
  v_qty numeric := p_quantity;
  v_pack integer;
  v_pk record;
  v_cash boolean;
  v_pack_list numeric;
begin
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    -- its own code: a missing price (P0002) may be handed over free, a closed bill never
    raise exception 'no open bill for this visit: the bill was already closed' using errcode = 'MS001', hint = 'no_open_bill';
  end if;

  if p_service_id is not null then
    select s.name_en, s.service_group, s.allow_manual_price, s.max_discount_pct
    into v_desc, v_group, v_allow_manual, v_max_discount
    from service s where s.id = p_service_id and (s.active or p_source_type = 'bed_stay');
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false, 0
    into v_desc, v_group, v_allow_manual, v_max_discount
    from item i where i.id = p_item_id and i.active;
    v_origin := 'pharmacy';
  end if;
  if v_desc is null then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;

  if p_manual_price is not null then
    if not (v_allow_manual or p_source_type = 'bed_stay' or has_perm('charge.manual')) then
      raise exception 'a typed price is not allowed for this service' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_manual_reason, '')), '') is null then
      raise exception 'a reason is required for a typed price' using errcode = '22023';
    end if;
    v_price := p_manual_price;
    v_origin := 'manual';
  else
    select pf.price, pf.fallback, pf.source into v_price, v_fallback, v_source
    from price_source_for(p_service_id, p_item_id, v_invoice.payer_id) pf;
    if v_price is null then
      raise exception 'no price found for this service/item' using errcode = 'P0002';
    end if;
  end if;

  -- Discount: within the treatment's allowance, or the manager; always with a reason.
  if v_discount < 0 or v_discount > 100 then
    raise exception 'discount must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_discount > 0 then
    if v_discount > v_max_discount and not is_manager() then
      raise exception 'the discount on this treatment may not exceed %%%', v_max_discount using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_discount_reason, '')), '') is null then
      raise exception 'a reason is required for a discount' using errcode = '22023';
    end if;
  end if;
  v_unit := round(v_price * (100 - v_discount) / 100);

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  -- 0115: the insurer has no price of its own for this line (its list or the official list)
  if v_invoice.payer_id is not null and p_manual_price is null and v_source = 'cash' then
    select py.not_listed_rule, py.type into v_rule, v_payer_type from payer py where py.id = v_invoice.payer_id;
    if v_payer_type is distinct from 'cash' then
      if v_rule = 'not_covered' then
        v_pct := 0;
      elsif v_rule = 'ask' and coalesce(current_setting('mmc.confirm_insurer', true), '') <> 'on'
            and (p_source_type is null or p_source_type = 'medication_dispense') then
        raise exception 'this is not on the insurer''s list: confirm the cash price with the insurer first'
          using errcode = 'MS004', hint = 'ask_insurer';
      end if;
    end if;
  end if;
  -- 0134: the insurer's exception on this line: not covered (the patient pays it all), or covered
  -- only with the insurer's approval (an added treatment or a hand-over is refused with hint
  -- insurer_preauth until the person confirms the approval; an order, a bed night or a medicine
  -- given in the room is charged with the coverage, as the work is already done)
  if v_invoice.payer_id is not null and p_manual_price is null and v_source in ('excluded', 'preauth') then
    if v_source = 'excluded' then
      v_pct := 0;
    elsif coalesce(current_setting('mmc.confirm_insurer', true), '') <> 'on'
          and (p_source_type is null or p_source_type = 'medication_dispense') then
      raise exception 'the insurer covers this only with its approval: confirm it has approved'
        using errcode = 'MS004', hint = 'insurer_preauth';
    end if;
  end if;

  -- 0107: a medicine is priced by how it is sold (price_quantity): by the piece, by the whole
  -- pack only (a quantity that is not whole packs is refused), or both (the whole packs at the
  -- pack price, the pieces left at the piece price). A cash-priced line (no insurer, or the
  -- insurer has no own price) only: an insurer's own price stays per piece. The whole packs are
  -- written as their own line ("… · B/8", quantity = packs, unit price = the pack price,
  -- pack_size = pieces in one); the pieces left as a second line at the piece price.
  if p_item_id is not null and p_manual_price is null then
    v_cash := v_invoice.payer_id is null or coalesce(v_fallback, false);
    select * into v_pk from price_quantity(p_item_id, p_quantity, v_unit, v_cash, v_discount);
    if not v_pk.ok then
      perform assert_whole_packs(p_item_id, p_quantity);
    end if;
    if v_pk.packs > 0 then
      select i.pack_price into v_pack_list from item i where i.id = p_item_id;
      v_line_total := v_pk.packs * v_pk.pack_price;
      v_insurer := round(v_line_total * v_pct / 100);
      insert into invoice_line (
        invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
        discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
        source_type, source_id, price_origin, manual_reason, pack_size
      ) values (
        v_invoice.id, null, p_item_id, v_desc || ' · B/' || v_pk.pack_size, v_pk.packs, v_pk.pack_price,
        coalesce(v_pack_list, v_pk.pack_price), v_discount,
        nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
        p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
        v_origin, null, v_pk.pack_size
      ) returning id into v_line_id;
      if v_pk.pieces > 0 then
        v_line_total := round(v_unit * v_pk.pieces);
        v_insurer := round(v_line_total * v_pct / 100);
        insert into invoice_line (
          invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
          discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
          source_type, source_id, price_origin, manual_reason, pack_size
        ) values (
          v_invoice.id, null, p_item_id, v_desc, v_pk.pieces, v_unit, v_price, v_discount,
          nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
          p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
          v_origin, null, null
        );
      end if;
      perform recompute_invoice(v_invoice.id);
      return v_line_id;
    end if;
  end if;
  v_line_total := round(v_unit * v_qty);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
    discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
    source_type, source_id, price_origin, manual_reason, pack_size
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, v_qty, v_unit, v_price, v_discount,
    nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
    p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
    v_origin, p_manual_reason, v_pack
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

-- set_visit_payer (from 20261225090000_insurer_tariffs): + an 'excluded' line has no insurer share.
create or replace function set_visit_payer(p_encounter_id uuid, p_payer_id uuid, p_member_number text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_patient uuid;
  v_plan uuid;
  v_coverage uuid;
  v_type payer_type;
  v_rule text;
  v_payer uuid;
begin
  if not (has_perm('charge.write') or has_perm('billing.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id;

  if p_payer_id is not null then
    select type, not_listed_rule into v_type, v_rule from payer where id = p_payer_id and active and deleted_at is null;
    if v_type is null then
      raise exception 'unknown or inactive insurer' using errcode = '22023';
    end if;
  end if;

  if p_payer_id is null or v_type = 'cash' then
    update encounter set coverage_id = null where id = p_encounter_id;
    update invoice set payer_id = null, coverage_id = null where id = v_invoice.id;
    v_payer := null;
  else
    select id into v_plan from plan where payer_id = p_payer_id and active and deleted_at is null
    order by created_at limit 1;
    select id into v_coverage from coverage
    where patient_id = v_patient and payer_id = p_payer_id and active and deleted_at is null
    order by created_at desc limit 1;
    if v_coverage is null then
      insert into coverage (patient_id, payer_id, plan_id, member_number)
      values (v_patient, p_payer_id, v_plan, nullif(trim(coalesce(p_member_number, '')), ''))
      returning id into v_coverage;
    elsif p_member_number is not null then
      update coverage set member_number = nullif(trim(p_member_number), ''), plan_id = coalesce(plan_id, v_plan) where id = v_coverage;
    end if;
    select plan_id into v_plan from coverage where id = v_coverage;
    update encounter set coverage_id = v_coverage where id = p_encounter_id;
    update invoice set payer_id = p_payer_id, coverage_id = v_coverage where id = v_invoice.id;
    v_payer := p_payer_id;
  end if;

  -- the preset lines at the new payer's price (a typed price, a discount or a whole-pack line keeps its own)
  update invoice_line l
  set list_price = n.price, unit_price = n.price
  from (
    select l2.id, pf.price
    from invoice_line l2
    cross join lateral price_source_for(l2.service_id, l2.item_id, v_payer, (l2.created_at at time zone 'Africa/Kigali')::date) pf
    where l2.invoice_id = v_invoice.id and l2.deleted_at is null
      and l2.price_origin <> 'manual' and coalesce(l2.discount_pct, 0) = 0 and l2.pack_size is null
      and pf.price is not null
  ) n
  where l.id = n.id;

  -- the split: the payer's coverage of each line's group (0 for cash); a line the insurer has no
  -- price for follows its rule
  update invoice_line l
  set coverage_pct = g.pct,
      insurer_share = round(round(l.unit_price * l.quantity) * g.pct / 100),
      patient_share = round(l.unit_price * l.quantity) - round(round(l.unit_price * l.quantity) * g.pct / 100)
  from (
    select l2.id,
           case
             when v_payer is null then 0
             when v_rule = 'not_covered' and l2.price_origin <> 'manual' and pf.source = 'cash' then 0
             when l2.price_origin <> 'manual' and pf.source = 'excluded' then 0
             else coalesce(coverage_pct_for(v_plan, coalesce(s.service_group, 'pharmacy'::service_group)), 0)
           end as pct
    from invoice_line l2
    left join service s on s.id = l2.service_id
    left join lateral price_source_for(l2.service_id, l2.item_id, v_payer, (l2.created_at at time zone 'Africa/Kigali')::date) pf on true
    where l2.invoice_id = v_invoice.id and l2.deleted_at is null
  ) g
  where l.id = g.id;
  perform recompute_invoice(v_invoice.id);
end
$$;

-- pharmacy_queue (from 20261225090000_insurer_tariffs): + an 'excluded' medicine has no insurer
-- share (priceSource says 'excluded' or 'preauth').
create or replace function pharmacy_queue(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_stores jsonb;
  v_lines jsonb;
  v_patients jsonb;
begin
  -- the pharmacy and the manager only: the list carries allergies, prescriptions and bill amounts
  if not (may_use_desk('pharmacy') or is_manager()) then
    return jsonb_build_object('locationId', null, 'stores', '[]'::jsonb, 'lines', '[]'::jsonb, 'patients', '[]'::jsonb);
  end if;
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                   and active and deleted_at is null) then
      raise exception 'choose an open pharmacy store' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  else
    v_loc := main_pharmacy();
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'isMain', l.id = main_pharmacy())
                            order by (l.id = main_pharmacy()) desc, l.created_at), '[]'::jsonb)
  into v_stores
  from stock_location l where l.type = 'pharmacy' and l.active and l.deleted_at is null;

  with lines as (
    select m.id, m.encounter_id, m.created_at, m.split_from, p.id as patient_id,
           p.surname || ' ' || p.given_names as patient, p.file_number, p.sex, p.birth_date, p.allergies,
           (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1) as ticket,
           m.item_id, i.name_generic || coalesce(' ' || i.strength, '') as item, i.selling_unit, i.pack_size,
           i.sale_mode, i.pack_unit, d.due,
           -- the pack price counts only for a cash-priced line (no insurer, or the insurer has no own price)
           case when (inv.payer_id is null or coalesce(pp.fallback, false)) and i.sale_mode <> 'piece'
                then i.pack_price end as pack_price,
           i.prescribing_rule, m.quantity, m.quantity_given, m.dose, m.frequency, m.duration_days, m.instructions,
           pr.id as prescriber_id, pr.full_name as prescriber, pr.specialty,
           py.name as payer, cp.price as cash_price, pp.price as payer_price, pp.fallback,
           cov.pct, pp.source as price_source, py.not_listed_rule,
           pc.total as line_total, pc.packs, pc.pieces as rest,
           doctor_holds(m.encounter_id) as holds
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    left join lateral (select pf.price from price_for(null, m.item_id, null) pf) cp on true
    left join lateral (select pf.price, pf.fallback, pf.source from price_source_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select case when inv.payer_id is not null and (pp.source = 'excluded' or (pp.source = 'cash' and py.not_listed_rule = 'not_covered')) then 0
                              else coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                             'pharmacy'::service_group), 0) end as pct) cov on true
    -- 0107: what is given by default: what remains (a medicine sold only by the whole pack:
    -- up to whole packs), priced by how it is sold
    left join lateral (select rx_due(m.item_id, greatest(ceil(m.quantity)::integer - m.quantity_given, 0)) as due) d on true
    left join lateral (select k.total, case when k.packs > 0 then k.packs end as packs, k.pieces
                       from price_quantity(m.item_id, d.due, pp.price,
                                           inv.payer_id is null or coalesce(pp.fallback, false)) k) pc on true
    where rx_pending(m)
  ), priced as (
    select l.*, round(coalesce(case when l.payer_price is null then 0 else l.line_total end, 0) * l.pct / 100) as insurer_share
    from lines l
  )
  select
    coalesce(jsonb_agg((jsonb_build_object(
      'requestId', x.id, 'encounterId', x.encounter_id, 'patientId', x.patient_id, 'patient', x.patient,
      'file', x.file_number, 'ticket', x.ticket,
      'itemId', x.item_id, 'item', x.item, 'unit', x.selling_unit,
      'packSize', x.pack_size, 'packPrice', x.pack_price, 'packs', x.packs, 'splitFrom', x.split_from,
      'saleMode', x.sale_mode, 'packUnit', x.pack_unit, 'due', x.due, 'restPieces', x.rest,
      'quantity', x.quantity, 'given', x.quantity_given,
      'remaining', ceil(x.quantity)::integer - x.quantity_given, 'dose', x.dose, 'frequency', x.frequency, 'days', x.duration_days,
      'instructions', x.instructions, 'prescriber', x.prescriber, 'prescriberId', x.prescriber_id, 'at', x.created_at,
      -- the cash price (as before) and what the bill will say
      'price', x.cash_price, 'cashPrice', x.cash_price, 'payerPrice', x.payer_price,
      'priced', x.payer_price is not null, 'payer', x.payer, 'coveragePct', x.pct,
      'lineTotal', case when x.payer_price is null then 0 else coalesce(x.line_total, 0) end, 'insurerShare', x.insurer_share,
      'patientShare', case when x.payer_price is null then 0 else coalesce(x.line_total, 0) end - x.insurer_share,
      -- the stock of the store chosen at the desk
      'locationId', v_loc, 'pharmacyLocationId', v_loc,
      'onHandPharmacy', case when v_loc is null then 0 else usable_stock(x.item_id, v_loc) end,
      'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                            where s.item_id = x.item_id and s.location_id = v_loc and s.quantity > 0
                              and s.expiry < current_date),
      'onHandElsewhere', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = x.item_id and l.id is distinct from v_loc and l.active and l.deleted_at is null
                            and s.quantity > 0 and (s.expiry is null or s.expiry >= current_date)),
      'doctorHolds', x.holds,
      -- the pharmacist's check
      'sex', x.sex, 'birthDate', x.birth_date,
      'ageYears', case when x.birth_date is not null then extract(year from age(current_date, x.birth_date))::integer end,
      'allergies', x.allergies,
      'prescribingRule', x.prescribing_rule, 'prescriberSpecialty', x.specialty,
      'ruleOk', rx_rule_ok(x.prescribing_rule, x.specialty)
    ) || jsonb_build_object('priceSource', x.price_source, 'notListedRule', x.not_listed_rule)) order by x.created_at), '[]'::jsonb)
  into v_lines
  from priced x;

  with lines as (
    select m.encounter_id, min(m.created_at) as first_at, count(*)::integer as n,
           sum(case when pp.price is null then 0 else pc.total end) as total,
           sum(round(case when pp.price is null then 0 else pc.total end * cov.pct / 100)) as insurer
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join lateral (select pf.price, pf.fallback, pf.source from price_source_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select case when inv.payer_id is not null and (pp.source = 'excluded' or (pp.source = 'cash' and py.not_listed_rule = 'not_covered')) then 0
                              else coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                             'pharmacy'::service_group), 0) end as pct) cov on true
    left join lateral (select k.total
                       from price_quantity(m.item_id,
                                           rx_due(m.item_id, greatest(ceil(m.quantity)::integer - m.quantity_given, 0)),
                                           pp.price, inv.payer_id is null or coalesce(pp.fallback, false)) k) pc on true
    where rx_pending(m)
    group by m.encounter_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', l.encounter_id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
      'file', p.file_number,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = l.encounter_id order by q.created_at limit 1),
      'sex', p.sex, 'birthDate', p.birth_date,
      'ageYears', case when p.birth_date is not null then extract(year from age(current_date, p.birth_date))::integer end,
      'ageMonths', case when p.birth_date is not null
                        then (extract(year from age(current_date, p.birth_date)) * 12
                              + extract(month from age(current_date, p.birth_date)))::integer end,
      'allergies', p.allergies, 'payer', py.name,
      'lines', l.n, 'total', l.total, 'insurerShare', l.insurer, 'patientShare', l.total - l.insurer,
      'balance', invoice_balance(inv.id),
      'doctorHolds', doctor_holds(l.encounter_id)
    ) order by l.first_at), '[]'::jsonb)
  into v_patients
  from lines l
  join encounter e on e.id = l.encounter_id
  join patient p on p.id = e.patient_id
  left join invoice inv on inv.encounter_id = e.id
  left join payer py on py.id = inv.payer_id;

  return jsonb_build_object('locationId', v_loc, 'stores', v_stores, 'lines', v_lines, 'patients', v_patients);
end
$$;

-- ---------------------------------------------------------------- the insurer's tariff table
-- insurer_tariff_rows (from 20261225090000_insurer_tariffs): + each line's code on the lists, the
-- published list that prices it, the insurer's exception (cover, price, note), preauth; an
-- 'excluded' line has no insurer share. + the lists the insurer follows ('books').
create or replace function insurer_tariff_rows(p_payer uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_plan plan%rowtype;
  v_rows jsonb;
  v_lists jsonb;
  v_books jsonb;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  select * into v_plan from plan where payer_id = p_payer and active and deleted_at is null
  order by created_at limit 1;

  with base as (
    select 'service'::text as kind, s.id, s.code, s.name_en as name, s.name_fr, s.name_kin,
           s.service_group::text as grp, s.category_id,
           tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) as list_code
    from service s where s.deleted_at is null and s.active
    union all
    select 'item', i.id, i.code, i.name_generic || coalesce(' ' || i.strength, ''), null, null, 'pharmacy', null,
           tariff_code_norm(i.code)
    from item i where i.deleted_at is null and i.active
  ), priced as (
    select b.*, cp.price as cash_price, pp.price, pp.source, tp.book_id, tp.note as line_note,
           ex.cover as ex_cover, ex.price as ex_price, ex.note as ex_note,
           case when pp.source = 'excluded'
                  or (coalesce(pp.source, 'cash') = 'cash' and v_payer.not_listed_rule = 'not_covered') then 0
                else coalesce(coverage_pct_for(v_plan.id, b.grp::service_group), 0) end as pct
    from base b
    left join lateral (select pf.price from price_source_for(case when b.kind = 'service' then b.id end,
                                                             case when b.kind = 'item' then b.id end, null) pf) cp on true
    left join lateral (select pf.price, pf.source from price_source_for(case when b.kind = 'service' then b.id end,
                                                                        case when b.kind = 'item' then b.id end, p_payer) pf) pp on true
    left join lateral (select t.book_id, t.note from tariff_price_for(case when b.kind = 'service' then b.id end,
                                                                      case when b.kind = 'item' then b.id end, p_payer) t) tp on true
    left join tariff_exception ex on ex.payer_id = p_payer and ex.code = b.list_code
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', x.kind, 'id', x.id, 'code', x.code, 'name', x.name, 'nameFr', x.name_fr, 'nameKin', x.name_kin,
      'group', x.grp, 'categoryId', x.category_id,
      'cashPrice', x.cash_price, 'price', x.price, 'source', coalesce(x.source, 'none'),
      'coveragePct', x.pct,
      'insurerShare', case when x.price is null then null else round(x.price * x.pct / 100) end,
      'patientShare', case when x.price is null then null else x.price - round(x.price * x.pct / 100) end,
      'ask', coalesce(x.source, 'cash') = 'cash' and v_payer.not_listed_rule = 'ask'
    ) || jsonb_build_object(
      'preauth', x.source = 'preauth',
      'listCode', x.list_code,
      'listId', x.book_id,
      'list', (select bk.name from tariff_book bk where bk.id = x.book_id),
      'lineNote', x.line_note,
      'exception', case when x.ex_cover is null then null
                        else jsonb_build_object('cover', x.ex_cover, 'price', x.ex_price, 'note', x.ex_note) end
    ) order by x.kind desc, x.name, x.code), '[]'::jsonb)
  into v_rows
  from priced x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', pl.id, 'name', pl.name, 'effectiveFrom', pl.effective_from, 'effectiveTo', pl.effective_to,
      'rows', (select count(*)::int from price_list_item x where x.price_list_id = pl.id and x.deleted_at is null),
      'createdAt', pl.created_at, 'createdBy', pr.full_name,
      'inEffect', pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date),
      'future', pl.effective_from > current_date
    ) order by pl.effective_from desc, pl.created_at desc), '[]'::jsonb)
  into v_lists
  from price_list pl
  left join profiles pr on pr.id = pl.created_by
  where pl.payer_id = p_payer and pl.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'bookId', b.id, 'name', b.name, 'kind', b.kind, 'publisher', b.publisher, 'column', pt.column_key,
      'label', (select c.value ->> 'label' from tariff_version v, jsonb_array_elements(v.columns) c
                where v.book_id = b.id and v.status = 'current' and c.value ->> 'key' = pt.column_key),
      'priority', pt.priority
    ) order by pt.priority, pt.created_at), '[]'::jsonb)
  into v_books
  from payer_tariff pt
  join tariff_book b on b.id = pt.book_id and b.deleted_at is null
  where pt.payer_id = p_payer;

  return jsonb_build_object(
    'payerId', p_payer, 'code', v_payer.code, 'name', v_payer.name,
    'notListedRule', v_payer.not_listed_rule, 'followsReferenceList', v_payer.follows_reference_list,
    'coveragePct', v_plan.coverage_pct, 'pctByGroup', coalesce(v_plan.pct_by_group, '{}'::jsonb),
    'rows', v_rows, 'lists', v_lists, 'books', v_books);
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function
  tariff_norm(text), tariff_code_norm(text), tariff_cover_of(text), tariff_code_of(uuid, uuid),
  tariff_version_at(uuid, date), tariff_price_for(uuid, uuid, uuid, date),
  import_tariff(uuid, jsonb, text, date, jsonb, jsonb, uuid, text, text, boolean),
  tariff_books(), tariff_lines(uuid, text, uuid, text, integer, integer),
  save_tariff_line(uuid, text, text, jsonb, text, text, text, text, boolean),
  remove_tariff_line(uuid, text, boolean), save_tariff_book(uuid, text, text, boolean),
  set_payer_tariff(uuid, uuid, text, integer),
  save_tariff_exception(uuid, text, text, numeric, text, uuid),
  link_tariff_service(uuid, text)
  from public, anon;
grant execute on function
  tariff_norm(text), tariff_code_norm(text), tariff_cover_of(text), tariff_code_of(uuid, uuid),
  tariff_version_at(uuid, date), tariff_price_for(uuid, uuid, uuid, date),
  import_tariff(uuid, jsonb, text, date, jsonb, jsonb, uuid, text, text, boolean),
  tariff_books(), tariff_lines(uuid, text, uuid, text, integer, integer),
  save_tariff_line(uuid, text, text, jsonb, text, text, text, text, boolean),
  remove_tariff_line(uuid, text, boolean), save_tariff_book(uuid, text, text, boolean),
  set_payer_tariff(uuid, uuid, text, integer),
  save_tariff_exception(uuid, text, text, numeric, text, uuid),
  link_tariff_service(uuid, text)
  to authenticated;
