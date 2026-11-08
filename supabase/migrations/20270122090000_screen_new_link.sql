-- 0142: a new link for a waiting screen.
--
-- A screen's key is kept hashed (0114): the link is shown once and cannot be read back later.
-- When the manager needs the link again (a new TV, the old address lost), they ask for a new
-- one: a fresh key replaces the old, the old link stops working at once, and the new link is
-- shown once, as at creation. Audited.

/** A fresh key for an active screen; the old one stops working. Returns {id, key}. */
create or replace function renew_display_screen_key(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_key text;
  v_name text;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_key := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  update display_screen
  set key_hash = encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), updated_at = now(), updated_by = auth.uid()
  where id = p_id and active and revoked_at is null
  returning name into v_name;
  if not found then
    raise exception 'this screen is not known or was revoked' using errcode = 'P0002', hint = 'screen_unknown';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'display_screen', p_id, jsonb_build_object('key', 'new_link', 'name', v_name));
  return jsonb_build_object('id', p_id, 'key', v_key);
end
$$;

revoke all on function renew_display_screen_key(uuid) from public, anon;
grant execute on function renew_display_screen_key(uuid) to authenticated;
