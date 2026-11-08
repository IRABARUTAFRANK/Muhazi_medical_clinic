-- 0140 · What an insurer pays for the lines on screen, fast.
--
-- A visit under an insurer showed its prices by reading the insurer's whole tariff
-- (insurer_tariff_rows: every treatment and medicine through the price rules, about 5 s for the
-- 3,200 treatments of the Ministry's list — near the time the database allows a request). Since
-- 0139 an insured patient's every visit is under the insurer, so that went on every visit page.
--
-- * payer_lines(insurer, treatments, medicines): the same lines as insurer_tariff_rows (the same
--   fields, the same price rules: price_source_for, the one the bill uses), only for the
--   treatments and medicines asked (null: all of them). The visit asks for the treatment chosen,
--   the tests offered and the medicines prescribed.
-- * The clinic's price of each line is read from the clinic's list (then the clinic-wide lists)
--   directly instead of through the price rules a second time.
-- * The insurer's exception shown on a line is the one the bill applies: on its own code first,
--   else on the list line it is linked to.
-- * insurer_tariff_rows (the insurer's window on Price lists & insurers) is built on payer_lines.

create or replace function payer_lines(p_payer uuid, p_services uuid[] default null, p_items uuid[] default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_plan plan%rowtype;
  v_rows jsonb;
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
    select 'service'::text as kind, s.id, s.id as svc_id, null::uuid as item_id, s.code, s.name_en as name,
           s.name_fr, s.name_kin, s.service_group::text as grp, s.category_id,
           tariff_code_norm(coalesce(nullif(s.tariff_code, ''), s.code)) as list_code
    from service s
    where s.deleted_at is null and s.active and (p_services is null or s.id = any (p_services))
    union all
    select 'item', i.id, null, i.id, i.code, i.name_generic || coalesce(' ' || i.strength, ''), null, null, 'pharmacy', null,
           tariff_code_norm(i.code)
    from item i
    where i.deleted_at is null and i.active and (p_items is null or i.id = any (p_items))
  ),
  -- the clinic's own price of each (as price_source_for without an insurer: the clinic's list in effect)
  own_svc as materialized (
    select distinct on (pli.service_id) pli.service_id, pli.price
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null and pli.service_id is not null
      and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
    order by pli.service_id, pl.effective_from desc, pl.created_at desc
  ), own_item as materialized (
    select distinct on (pli.item_id) pli.item_id, pli.price
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null and pli.item_id is not null
      and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
    order by pli.item_id, pl.effective_from desc, pl.created_at desc
  ),
  -- the codes the insurer's lists link the clinic's treatments and medicines to (for its exceptions)
  links as materialized (
    select k.code, k.service_id, k.item_id
    from tariff_link k
    join payer_tariff pt on pt.book_id = k.book_id and pt.payer_id = p_payer
  ), priced as (
    select b.*, coalesce(os.price, oi.price, cl.price) as cash_price, pp.price, pp.source, tp.book_id,
           tp.note as line_note,
           coalesce(exo.cover, exl.cover) as ex_cover,
           case when exo.code is not null then exo.price else exl.price end as ex_price,
           case when exo.code is not null then exo.note else exl.note end as ex_note,
           case when pp.source = 'excluded'
                  or (coalesce(pp.source, 'cash') = 'cash' and v_payer.not_listed_rule = 'not_covered') then 0
                else coalesce(coverage_pct_for(v_plan.id, b.grp::service_group), 0) end as pct
    from base b
    left join own_svc os on os.service_id = b.svc_id
    left join own_item oi on oi.item_id = b.item_id
    -- no price of the clinic's own: the clinic-wide lists (the Ministry's)
    left join lateral (
      select c.price from clinic_list_price(b.svc_id, b.item_id, current_date) c
      where os.price is null and oi.price is null) cl on true
    left join lateral (select pf.price, pf.source from price_source_for(b.svc_id, b.item_id, p_payer) pf) pp on true
    left join lateral (select t.book_id, t.note from tariff_price_for(b.svc_id, b.item_id, p_payer) t) tp on true
    -- the exception the bill applies: on the line's own code first, else on the list line it is linked to
    left join tariff_exception exo on exo.payer_id = p_payer and exo.code = b.list_code
    left join lateral (
      select x.cover, x.price, x.note
      from links l
      join tariff_exception x on x.payer_id = p_payer and x.code = l.code
      where exo.code is null and (l.service_id = b.svc_id or l.item_id = b.item_id)
      limit 1) exl on true
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
  return v_rows;
end
$$;

-- ---------------------------------------------------------------- the insurer's tariff table
-- insurer_tariff_rows (from 20270114090000_published_price_lists): its lines are payer_lines'.
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

  v_rows := payer_lines(p_payer, null, null);

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
revoke all on function payer_lines(uuid, uuid[], uuid[]) from public, anon;
grant execute on function payer_lines(uuid, uuid[], uuid[]) to authenticated;
