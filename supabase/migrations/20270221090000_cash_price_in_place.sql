-- 0202 · An insurer's tariff: every field of a line edited in place (Frank, 2026-11-25: "only
-- the MMI price can be changed; I must be able to change the other fields too").
--
-- In the tariff window a line now opens with: the clinic's cash price, the insurer's own price
-- and its cover (covered at its coverage / not covered / only with its approval) with a note. The
-- insurer's price and its cover already had their functions (set_insurer_price,
-- save_tariff_exception); the clinic's cash price was only set with the whole treatment or medicine
-- form. set_cash_price sets it alone, with the rules of those forms (upsert_service, upsert_item):
-- the same price as the clinic-wide list (or none, when the list has one) means the clinic follows
-- the list again; otherwise the price goes on the clinic's price list in effect. What the patient
-- and the insurer pay follows from the price and the cover, as on the bill.

create or replace function set_cash_price(p_service_id uuid, p_item_id uuid, p_price numeric)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
begin
  if auth.uid() is null or not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  if (p_service_id is not null and not exists (select 1 from service s where s.id = p_service_id and s.deleted_at is null))
     or (p_item_id is not null and not exists (select 1 from item i where i.id = p_item_id and i.deleted_at is null)) then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;
  if p_price is not null and p_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  -- the list's own price (or none when the list has one): the clinic follows the list
  if cash_follows_list(p_service_id, p_item_id, p_price) then
    return jsonb_build_object('follows', true,
                              'price', (select cl.price from clinic_list_price(p_service_id, p_item_id) cl));
  end if;
  if p_price is null then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date)
    returning id into v_list;
  end if;
  if p_service_id is not null then
    insert into price_list_item (price_list_id, service_id, price) values (v_list, p_service_id, round(p_price))
    on conflict (price_list_id, service_id) where service_id is not null
    do update set price = excluded.price, deleted_at = null;
  else
    insert into price_list_item (price_list_id, item_id, price) values (v_list, p_item_id, round(p_price))
    on conflict (price_list_id, item_id) where item_id is not null
    do update set price = excluded.price, deleted_at = null;
  end if;
  return jsonb_build_object('follows', false, 'price', round(p_price));
end
$$;

revoke all on function set_cash_price(uuid, uuid, numeric) from public, anon;
grant execute on function set_cash_price(uuid, uuid, numeric) to authenticated;
