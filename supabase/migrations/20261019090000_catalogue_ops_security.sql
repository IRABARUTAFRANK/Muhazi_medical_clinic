-- 0018 · Catalogue operations, screen-lock setting, settings allowlist.
--
-- * save_setting accepts `patient.fields` (customizable patient file, 0017) and
--   `security.lock` ({ idle_minutes }), the inactivity time before a staff screen locks.
-- * staff_settings(): the non-secret settings every signed-in staff member needs, readable
--   without settings.read (the lock time is enforced in every browser).
-- * delete_service / delete_payer: soft delete (deleted_at + inactive). Old bills keep their
--   lines and history; the treatment or insurer disappears from every list.
-- * adjust_prices: raise or lower the cash price of every treatment (or one group) at once —
--   by a multiplier (× 1.1), a percentage (+10 %) or an amount (+500 RWF), rounded.

create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 15)
  )
$$;

-- ---------------------------------------------------------------- delete (soft)
create or replace function delete_service(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update service set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'service', p_id, null);
end
$$;

create or replace function delete_payer(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from payer where id = p_id and type = 'cash') then
    raise exception 'cash cannot be deleted' using errcode = '22023';
  end if;
  if exists (select 1 from invoice where payer_id = p_id and status = 'draft' and deleted_at is null) then
    raise exception 'this insurer is on an open bill; finish or change those visits first' using errcode = '23503';
  end if;
  update payer set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  update plan set active = false where payer_id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'payer', p_id, null);
end
$$;

-- ---------------------------------------------------------------- bulk price change
-- p_mode: 'multiply' (p_value = 1.1), 'percent' (p_value = 10 or -5), 'amount' (p_value = 500).
-- p_round: round the new price to this many RWF (1 = no rounding). Returns how many changed.
create or replace function adjust_prices(
  p_group service_group default null,
  p_mode text default 'multiply',
  p_value numeric default 1,
  p_round integer default 100
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
  v_count integer := 0;
  v_step integer := greatest(coalesce(p_round, 1), 1);
  r record;
  v_new numeric;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode not in ('multiply', 'percent', 'amount') or p_value is null then
    raise exception 'unknown adjustment' using errcode = '22023';
  end if;
  if p_mode = 'multiply' and (p_value <= 0 or p_value > 10) then
    raise exception 'the multiplier must be above 0 and at most 10' using errcode = '22023';
  end if;
  if p_mode = 'percent' and (p_value <= -100 or p_value > 900) then
    raise exception 'the percentage must be above -100 and at most 900' using errcode = '22023';
  end if;

  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    return 0;
  end if;

  for r in
    select pli.id, pli.price
    from price_list_item pli
    join service s on s.id = pli.service_id
    where pli.price_list_id = v_list and pli.deleted_at is null and s.deleted_at is null
      and (p_group is null or s.service_group = p_group)
      and pli.price > 0
  loop
    v_new := case p_mode
      when 'multiply' then r.price * p_value
      when 'percent' then r.price * (100 + p_value) / 100
      else r.price + p_value
    end;
    v_new := greatest(round(v_new / v_step) * v_step, 0);
    if v_new <> r.price then
      update price_list_item set price = v_new where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;

  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'price_list', v_list,
          jsonb_build_object('group', p_group, 'mode', p_mode, 'value', p_value, 'round', v_step, 'changed', v_count));
  return v_count;
end
$$;

grant execute on function staff_settings(), delete_service(uuid), delete_payer(uuid),
  adjust_prices(service_group, text, numeric, integer) to authenticated;
revoke execute on function staff_settings(), delete_service(uuid), delete_payer(uuid),
  adjust_prices(service_group, text, numeric, integer) from anon;
