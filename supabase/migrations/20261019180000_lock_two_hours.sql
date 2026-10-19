-- 0021 · Screen lock after two hours without activity (clinic request, 2026-10-19).
-- The manager can still change it in Settings → Screen lock.

insert into setting (key, value, changed_at)
values ('security.lock', '{"idle_minutes": 120}'::jsonb, now())
on conflict (key) do update set value = excluded.value, changed_at = now();

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120)
  )
$$;
