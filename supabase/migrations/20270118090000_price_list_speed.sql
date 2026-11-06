-- 0138 · Checking and keeping a big price list (the full MoH tariff: 3,198 lines) within the time
-- the server allows.
--
-- Each line of a list is looked for among the clinic's treatments and medicines by its code
-- (tariff_code_norm of the treatment's list code, else its own code; a medicine's code). Without an
-- index every line read every treatment: a list of 3,198 lines over 3,198 treatments made from an
-- earlier upload took more than 20 s and the check stopped ("canceling statement due to statement
-- timeout"). These indexes answer each line at once.
create index if not exists service_tariff_code_norm_idx
  on service (tariff_code_norm(coalesce(nullif(tariff_code, ''), code)));
create index if not exists item_tariff_code_norm_idx
  on item (tariff_code_norm(code));
create index if not exists service_list_book_idx
  on service (list_book_id) where list_book_id is not null;

-- ---------------------------------------------------------------- import_tariff
-- import_tariff (from 20270115090000_clinic_price_lists): the same check and keep; the lines are
-- matched to the clinic's treatments and medicines by plain joins on their code (or a link of this
-- list), not by one join with an "or" that compared every line with every treatment; the list read
-- is analysed so the planner knows its size.
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


-- ---------------------------------------------------------------- tariff_make_services
-- tariff_make_services (from 20270116090000_remove_price_lists): the treatments of a list taken
-- away are picked first (they are few), then matched to the lines by their code.
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
      active = coalesce(v_live, false) and v_col is not null and jsonb_typeof(l.prices -> v_col) = 'number',
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
          active = coalesce(v_live, false) and v_col is not null and jsonb_typeof(r.prices -> v_col) = 'number',
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
            coalesce(v_live, false) and v_col is not null and jsonb_typeof(r.prices -> v_col) = 'number');
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

