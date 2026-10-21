-- 0047 · "Delete all treatments" keeps the built-in Bed stay line.
--
-- Bed billing (admit_to_bed / extend_bed_stay) charges every stay under the service BED-STAY;
-- deleting it made bed admissions fail ("unknown or inactive service"). The catalogue reset now
-- spares it, and it comes back if it was deleted.

create or replace function delete_all_services()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update price_list_item set deleted_at = now()
  where deleted_at is null
    and service_id in (select id from service where deleted_at is null and code <> 'BED-STAY');
  update service set deleted_at = now(), active = false where deleted_at is null and code <> 'BED-STAY';
  get diagnostics v_n = row_count;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'service', null, jsonb_build_object('all', true, 'count', v_n));
  return v_n;
end
$$;

update service set deleted_at = null, active = true where code = 'BED-STAY';
