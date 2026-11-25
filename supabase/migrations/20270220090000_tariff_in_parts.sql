-- 0201 · The insurer's tariff window timed out (Frank, 2026-11-25: "canceling statement due to
-- statement timeout" on Prices › insurers › MMI). insurer_tariff_rows works out every treatment and
-- medicine of the clinic with the whole price search of the bill (price_source_for, the lists the
-- insurer follows, its exceptions, the clinic's price) in ONE statement; with the clinic's lists
-- (thousands of lines) that passes the time Supabase allows a signed-in person's statement (8 s).
--
-- insurer_tariff_head gives everything of the window except the lines (the insurer, its coverage
-- and rule, its lists and the official lists it follows) and the ids of the active treatments and
-- medicines; the web reads the lines in parts with payer_lines (0140, unchanged: the same lines
-- the bill uses), several at a time, and puts them together. insurer_tariff_rows stays for an
-- older web. Nothing else changes.

create or replace function insurer_tariff_head(p_payer uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_plan plan%rowtype;
  v_services jsonb;
  v_items jsonb;
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

  -- the lines are read in parts with payer_lines (each part well within the time limit)
  select coalesce(jsonb_agg(s.id order by s.name_en, s.code), '[]'::jsonb) into v_services
  from service s where s.deleted_at is null and s.active;
  select coalesce(jsonb_agg(i.id order by i.name_generic, i.code), '[]'::jsonb) into v_items
  from item i where i.deleted_at is null and i.active;

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
    'serviceIds', v_services, 'itemIds', v_items, 'lists', v_lists, 'books', v_books);
end
$$;

revoke all on function insurer_tariff_head(uuid) from public, anon;
grant execute on function insurer_tariff_head(uuid) to authenticated;
