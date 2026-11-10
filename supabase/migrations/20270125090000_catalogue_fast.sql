-- 0148: the catalogue of treatments read in one pass.
--
-- catalogue_services (20270115) called three price functions for every treatment: price_for,
-- clinic_list_price and own_cash_price, each with its own look-ups. With the Ministry's list
-- (3,198 treatments) the page's read of the view — as the signed-in user, four pages of a
-- thousand rows — ran past the server's time limit on the live database (HTTP 500), and every
-- list of treatments on the visit page came back empty. Here the list prices and the clinic's own
-- cash prices are computed once for all treatments (two set-returning functions, security
-- definer like the ones they replace) and joined; the answers are the same, row for row, which
-- the checks compare against the old functions.

create index if not exists tariff_line_version_code_idx on tariff_line (version_id, code);
create index if not exists tariff_link_service_idx on tariff_link (service_id) where service_id is not null;
create index if not exists price_list_item_service_idx on price_list_item (service_id) where service_id is not null;

/** The clinic's own cash price of every treatment that has one: the latest cash list in force. */
create or replace function own_cash_prices(p_at date default current_date)
returns table (service_id uuid, price numeric)
language sql stable security definer set search_path = public
as $$
  select distinct on (pli.service_id) pli.service_id, pli.price
  from price_list pl
  join price_list_item pli on pli.price_list_id = pl.id
  where pl.payer_id is null and pl.deleted_at is null and pli.deleted_at is null
    and pli.service_id is not null
    and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
  order by pli.service_id, pl.effective_from desc, pl.created_at desc
$$;

/**
 * The clinic-wide lists' price of every treatment they price (clinic_list_price for all at once):
 * the version of each list in force on the date, its private column, the treatment's code on
 * that list (its link there, else its link on another clinic-wide list, else its own code), the
 * first list by priority.
 */
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
  )
  select distinct on (c.service_id) c.service_id, ln.price, ln.book_id
  from codes c
  join lines ln on ln.book_id = c.book_id and ln.code = c.code
  order by c.service_id, ln.priority, ln.created_at
$$;
revoke all on function own_cash_prices(date), clinic_list_prices(date) from public, anon;
grant execute on function own_cash_prices(date), clinic_list_prices(date) to authenticated;

-- ---------------------------------------------------------------- catalogue_services (from 20270115090000_clinic_price_lists)
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         coalesce(own.price, lp.price) as cash_price,
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
         own.price as own_price,
         lp.book_id as list_id,
         b.name as list_name
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  left join service_category c on c.id = s.category_id
  left join own_cash_prices(current_date) own on own.service_id = s.id
  left join clinic_list_prices(current_date) lp on lp.service_id = s.id
  left join tariff_book b on b.id = lp.book_id
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;
