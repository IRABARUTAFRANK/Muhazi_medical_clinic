-- 0136 · Taking a published price list away completely, and uploading it again cleanly.
--
-- remove_tariff_book(list): the list goes with everything that came with it:
--   * the insurers that followed it stop following it (they are named in the answer);
--   * the insurers' exceptions written for its lines (from its instructions or typed on it) go;
--   * the links of its lines to the clinic's treatments and medicines go;
--   * the treatments it made (service.list_book_id) go: those never used are deleted, those used
--     (a bill, a request, a procedure, a nurse's order) are hidden, their bills keep them; the
--     clinic's own prices of those treatments go too;
--   * a clinic-wide list: the clinic's own treatments and medicines it priced (no price of the
--     clinic) keep the price they have today as the clinic's own price, so nothing is left without
--     a price.
-- Answers what was done. Only the manager (or catalogue.write).
--
-- A list of treatments uploaded again after that brings its treatments back: a treatment deleted
-- with its list comes back (the same treatment, the same code, its old bills) instead of a copy
-- with another code, and a treatment hidden with its list is taken over by the new list.
-- tariff_line_in_clinic no longer counts a treatment deleted with its list; one the clinic deleted
-- itself still counts (it is not made again).

-- ---------------------------------------------------------------- a line already a treatment
-- tariff_line_in_clinic (from 20270115090000_clinic_price_lists): a treatment deleted with its list
-- does not count; links to deleted treatments do not count.
create or replace function tariff_line_in_clinic(p_book uuid, p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
           select 1 from service s
           where tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = p_code
             and (s.deleted_at is null
                  or not exists (select 1 from tariff_book ob where ob.id = s.list_book_id and ob.deleted_at is not null)))
      or exists (select 1 from tariff_link k join service s on s.id = k.service_id and s.deleted_at is null
                 where k.book_id = p_book and k.code = p_code)
$$;

-- ---------------------------------------------------------------- the treatments a list makes
-- tariff_make_services (from 20270115090000_clinic_price_lists): + the treatments of a list taken
-- away come back with this one (hidden ones are taken over, deleted ones come back), before new
-- ones are made.
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
  -- the treatments hidden with a list taken away (they had been used): this list takes them over
  update service s
  set list_book_id = p_book,
      active = coalesce(v_live, false) and v_col is not null and jsonb_typeof(l.prices -> v_col) = 'number',
      updated_at = now()
  from tariff_line l
  where l.version_id = p_version and l.removed_at is null
    and s.deleted_at is null and s.list_book_id is not null and s.list_book_id <> p_book
    and exists (select 1 from tariff_book ob where ob.id = s.list_book_id and ob.deleted_at is not null)
    and tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) = l.code;
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

-- ---------------------------------------------------------------- take a list away completely
create or replace function remove_tariff_book(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_followers jsonb;
  v_exceptions integer := 0;
  v_links integer := 0;
  v_deleted integer := 0;
  v_hidden integer := 0;
  v_prices integer := 0;
  v_kept integer := 0;
  v_cash uuid;
  r record;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_book from tariff_book where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'price list not found' using errcode = 'P0002';
  end if;

  -- a clinic-wide list: the clinic's own treatments / medicines it prices today keep that price
  if v_book.scope = 'clinic' then
    for r in
      select s.id as service_id, null::uuid as item_id, c.price
      from service s
      cross join lateral clinic_list_price(s.id, null) c
      where v_book.kind = 'treatments' and s.deleted_at is null and s.list_book_id is distinct from p_id
        and c.book_id = p_id and c.price is not null and own_cash_price(s.id, null) is null
      union all
      select null::uuid, i.id, c.price
      from item i
      cross join lateral clinic_list_price(null, i.id) c
      where v_book.kind = 'medicines' and i.deleted_at is null
        and c.book_id = p_id and c.price is not null and own_cash_price(null, i.id) is null
    loop
      if v_cash is null then
        select id into v_cash from price_list
        where payer_id is null and deleted_at is null and effective_from <= current_date
          and (effective_to is null or effective_to >= current_date)
        order by effective_from desc limit 1;
        if v_cash is null then
          insert into price_list (payer_id, name, effective_from)
          values (null, 'Cash prices', current_date) returning id into v_cash;
        end if;
      end if;
      if r.service_id is not null then
        insert into price_list_item (price_list_id, service_id, price) values (v_cash, r.service_id, r.price)
        on conflict (price_list_id, service_id) where service_id is not null
        do update set price = excluded.price, deleted_at = null;
      else
        insert into price_list_item (price_list_id, item_id, price) values (v_cash, r.item_id, r.price)
        on conflict (price_list_id, item_id) where item_id is not null
        do update set price = excluded.price, deleted_at = null;
      end if;
      v_kept := v_kept + 1;
    end loop;
  end if;

  -- the insurers stop following it
  select coalesce(jsonb_agg(py.name order by py.name), '[]'::jsonb) into v_followers
  from payer_tariff pt join payer py on py.id = pt.payer_id
  where pt.book_id = p_id;
  delete from payer_tariff where book_id = p_id;
  -- the exceptions written for its lines
  delete from tariff_exception where book_id = p_id;
  get diagnostics v_exceptions = row_count;
  -- the links of its lines
  delete from tariff_link where book_id = p_id;
  get diagnostics v_links = row_count;

  -- the treatments it made: the clinic's own prices of them go; never used: deleted; used: hidden
  update price_list_item pli set deleted_at = now(), updated_at = now()
  from price_list pl
  where pli.price_list_id = pl.id and pl.payer_id is null and pli.deleted_at is null
    and pli.service_id in (select s.id from service s where s.list_book_id = p_id and s.deleted_at is null);
  get diagnostics v_prices = row_count;
  with used as (
    select il.service_id from invoice_line il where il.service_id is not null
    union select sr.service_id from service_request sr
    union select pr.service_id from procedure pr
    union select n.service_id from nurse_order n where n.service_id is not null
  ),
  made as (
    select s.id, s.id in (select u.service_id from used u) as used
    from service s
    where s.list_book_id = p_id and s.deleted_at is null
  ),
  gone as (
    update service s
    set active = false, deleted_at = case when m.used then null else now() end, updated_at = now()
    from made m
    where s.id = m.id
    returning m.used
  )
  select count(*) filter (where not gone.used)::int, count(*) filter (where gone.used)::int
  into v_deleted, v_hidden
  from gone;

  update tariff_book set deleted_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'tariff_book', p_id,
          jsonb_build_object('name', v_book.name, 'publisher', v_book.publisher, 'kind', v_book.kind,
                             'scope', v_book.scope),
          jsonb_build_object('followers', v_followers, 'exceptions', v_exceptions, 'links', v_links,
                             'deleted', v_deleted, 'hidden', v_hidden, 'ownPrices', v_prices, 'kept', v_kept));
  return jsonb_build_object(
    'name', v_book.name,
    'followers', v_followers,
    'exceptions', v_exceptions,
    'links', v_links,
    'deleted', v_deleted,
    'hidden', v_hidden,
    'ownPrices', v_prices,
    'kept', v_kept);
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function remove_tariff_book(uuid), tariff_line_in_clinic(uuid, text) from public, anon;
grant execute on function remove_tariff_book(uuid), tariff_line_in_clinic(uuid, text) to authenticated;
revoke all on function tariff_make_services(uuid, uuid) from public, anon, authenticated;
