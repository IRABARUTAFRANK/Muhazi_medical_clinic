-- 0165: the Kinyarwanda voice of the waiting-room screen, chosen per screen.
--
-- No browser speaks Kinyarwanda. Each screen now chooses how its Kinyarwanda call is said:
--  * browser  — the TV's closest voice, the sentence respelled for it (0163);
--  * recorded — a staff member's own recordings ("Umurwayi witwa", each desk's "urakenewe muri
--               deparitoma …", "ukenewe na muganga"), made once in Settings and kept in the
--               public bucket "voice"; the TV plays them, only the names come from the browser;
--  * server   — the clinic's voice server (a small service running an open Kinyarwanda
--               text-to-speech model) asked through the edge function rw-voice, the audio kept
--               in the same bucket (tts/<hash>.wav) so a sentence is made once.
-- Tables: voice_clip (the recordings), voice_cache (the server's sentences). display_key_ok
-- lets the edge function check a TV's key.

alter table display_screen add column if not exists rw_voice text not null default 'browser';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'display_screen_rw_voice_check') then
    alter table display_screen add constraint display_screen_rw_voice_check
      check (rw_voice in ('browser', 'recorded', 'server'));
  end if;
end
$$;

create table if not exists voice_clip (
  key text primary key,
  path text not null,
  duration_ms integer,
  recorded_by uuid,
  recorded_at timestamptz not null default now()
);
comment on table voice_clip is 'The staff''s Kinyarwanda recordings for the waiting-room screen (0165): intro, desk:<station>, staff.';
alter table voice_clip enable row level security;
revoke all on voice_clip from anon, authenticated;

create table if not exists voice_cache (
  hash text primary key,
  path text not null,
  created_at timestamptz not null default now()
);
comment on table voice_cache is 'Sentences the voice server already made (0165), by SHA-256 of the text: tts/<hash>.wav in the voice bucket.';
alter table voice_cache enable row level security;
revoke all on voice_cache from anon, authenticated;

/** A recording's key: intro, staff, or desk:<station>. */
create or replace function voice_clip_key_ok(p_key text)
returns boolean
language sql immutable
as $$
  select p_key in ('intro', 'staff')
      or (p_key like 'desk:%' and exists (select 1 from unnest(enum_range(null::station)) x(s) where x.s::text = substr(p_key, 6)))
$$;

create or replace function voice_clips()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', c.key, 'path', c.path, 'durationMs', c.duration_ms, 'recordedAt', c.recorded_at,
      'recordedBy', (select full_name from profiles where id = c.recorded_by)
    ) order by c.key)
    from voice_clip c
  ), '[]'::jsonb);
end
$$;

create or replace function save_voice_clip(p_key text, p_path text, p_duration_ms integer default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not voice_clip_key_ok(p_key) then
    raise exception 'unknown recording %', coalesce(p_key, '?') using errcode = '22023', hint = 'clip_key';
  end if;
  if coalesce(p_path, '') !~ '^clips/[A-Za-z0-9_.:-]{1,120}$' then
    raise exception 'the recording''s path is not in the clips folder' using errcode = '22023', hint = 'clip_path';
  end if;
  insert into voice_clip (key, path, duration_ms, recorded_by, recorded_at)
  values (p_key, p_path, p_duration_ms, auth.uid(), now())
  on conflict (key) do update
    set path = excluded.path, duration_ms = excluded.duration_ms, recorded_by = auth.uid(), recorded_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'voice_clip', null, jsonb_build_object('key', p_key, 'path', p_path));
end
$$;

create or replace function delete_voice_clip(p_key text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from voice_clip where key = p_key;
  if not found then
    raise exception 'no such recording' using errcode = 'P0002', hint = 'clip_unknown';
  end if;
end
$$;

/** The edge function rw-voice checks a TV before making a sentence for it: a screen's own key or a TV's key, active. */
create or replace function display_key_ok(p_key text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from display_screen s
    where s.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      and s.active and s.revoked_at is null
  ) or exists (
    select 1 from display_device d
    join display_screen s on s.id = d.screen_id and s.active and s.revoked_at is null
    where d.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex') and d.revoked_at is null
  )
$$;

-- the voice bucket: public to read (the TV plays from it), the manager's recordings under clips/,
-- the server's sentences under tts/ (written by the edge function with the service role)
create or replace function voice_object_write_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select has_perm('settings.write') and p_name like 'clips/%'
$$;
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'no storage schema here: the bucket voice is not created';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('voice', 'voice', true, 5242880,
          array['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4'])
  on conflict (id) do update
    set public = true, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists voice_insert on storage.objects';
  execute 'drop policy if exists voice_update on storage.objects';
  execute 'drop policy if exists voice_delete on storage.objects';
  execute 'drop policy if exists voice_select on storage.objects';
  execute $p$create policy voice_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'voice' and public.voice_object_write_ok(name))$p$;
  execute $p$create policy voice_update on storage.objects for update to authenticated
    using (bucket_id = 'voice' and public.voice_object_write_ok(name))$p$;
  execute $p$create policy voice_delete on storage.objects for delete to authenticated
    using (bucket_id = 'voice' and public.voice_object_write_ok(name))$p$;
  execute $p$create policy voice_select on storage.objects for select to anon, authenticated
    using (bucket_id = 'voice')$p$;
end
$$;

-- ---------------------------------------------------------------- display_board (from 20270127090000_tv_setup)
create or replace function display_board(p_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s display_screen%rowtype;
  v_hash text;
  v_dev uuid;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_desks text[];
  v_board jsonb;
  v_results jsonb;
  v_payload jsonb;
begin
  v_hash := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  -- the screen's own key (a link, before 0158), else the key of a TV set up by signing in
  select * into v_s from display_screen
  where key_hash = v_hash and active and revoked_at is null;
  if not found then
    select d.id into v_dev
    from display_device d
    join display_screen s on s.id = d.screen_id and s.active and s.revoked_at is null
    where d.key_hash = v_hash and d.revoked_at is null;
    if v_dev is not null then
      select s.* into v_s from display_screen s
      where s.id = (select screen_id from display_device where id = v_dev);
    end if;
    if v_dev is null then
      raise exception 'this screen key is not known or was revoked' using errcode = '42501', hint = 'screen_unknown';
    end if;
    update display_device set last_seen_at = now()
    where id = v_dev and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  end if;
  -- the desks shown: the ones chosen, else every desk with a patient now
  if cardinality(v_s.desks) > 0 then
    v_desks := v_s.desks;
  else
    select coalesce(array_agg(x.station::text order by x.station), '{}') into v_desks
    from (select distinct q.station
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          where q.deleted_at is null and q.finished_at is null) x;
  end if;
  select coalesce(jsonb_agg(d.j order by d.ord), '[]'::jsonb) into v_board
  from (
    select u.ord, jsonb_build_object(
      'station', u.s,
      'now', (
        select coalesce(jsonb_agg(n.j order by n.at desc), '[]'::jsonb)
        from (
          select coalesce(q.called_at, q.started_at) as at, jsonb_build_object(
                   'id', q.id, 'ticket', q.ticket_no,
                   'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
                   'room', pr.station, 'person', pr.full_name,
                   'calledAt', coalesce(q.called_at, q.started_at),
                   'started', q.started_at is not null
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
          left join profiles pr on pr.id = coalesce(q.taken_by, q.called_by, q.assigned_to)
          where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
            and coalesce(q.called_at, q.started_at) is not null
            and (coalesce(q.called_at, q.started_at) at time zone 'Africa/Kigali')::date = v_today
          order by coalesce(q.called_at, q.started_at) desc
          limit 4
        ) n
      ),
      'next', (
        select coalesce(jsonb_agg(x.j order by x.pri, x.at), '[]'::jsonb)
        from (
          select case when q.priority <= 2 then q.priority else 3 end as pri, q.created_at as at,
                 jsonb_build_object(
                   'id', q.id, 'ticket', q.ticket_no,
                   'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
                   'priority', least(q.priority, 3),
                   'person', pa.full_name, 'room', pa.station
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
          left join profiles pa on pa.id = q.assigned_to
          where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
            and q.called_at is null and q.started_at is null
          order by 1, 2
          limit 5
        ) x
      ),
      'waiting', (
        select count(*)
        from queue_entry q
        join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
        where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
          and q.called_at is null and q.started_at is null
      )
    ) as j
    from unnest(v_desks) with ordinality as u(s, ord)
  ) d;
  -- results verified in the last hour, one line per visit; never a sensitive (HIV) test
  select coalesce(jsonb_agg(r.j order by r.at desc), '[]'::jsonb) into v_results
  from (
    select max(d.verified_at) as at, jsonb_build_object(
             'id', e.id,
             'ticket', (select ticket_no from queue_entry where encounter_id = e.id order by created_at limit 1),
             'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
             'at', max(d.verified_at)
           ) as j
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    join encounter e on e.id = r.encounter_id and e.status = 'open' and e.deleted_at is null
    join patient p on p.id = e.patient_id
    where d.deleted_at is null and d.verified_at > now() - interval '60 minutes'
      and r.category in ('lab', 'imaging') and not sensitive_service(r.service_id)
    group by e.id, p.surname, p.given_names
  ) r;
  v_payload := jsonb_build_object(
    'name', v_s.name, 'desks', v_board, 'results', v_results, 'message', v_s.message,
    'chime', v_s.chime, 'languages', to_jsonb(v_s.languages), 'showNames', v_s.show_names,
    'voice', v_s.voice, 'voiceLang', v_s.voice_lang, 'voiceRepeat', v_s.voice_repeat, 'ticker', v_s.ticker,
    -- 0165: how the Kinyarwanda call is said, and the staff's recordings (paths in the voice bucket)
    'rwVoice', v_s.rw_voice,
    'clips', (select coalesce(jsonb_object_agg(c.key, c.path), '{}'::jsonb) from voice_clip c),
    'clinic', coalesce((select value ->> 'name' from setting where key = 'clinic.profile'), 'Muhazi Medical Clinic')
  );
  return v_payload || jsonb_build_object(
    'version', ('x' || left(md5(v_payload::text), 7))::bit(28)::int,
    'now', now()
  );
end
$$;
revoke all on function display_board(text) from public;
grant execute on function display_board(text) to anon, authenticated;

-- ---------------------------------------------------------------- display_screens (from 20261228090000_waiting_screen_voice)
create or replace function display_screens()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'desks', to_jsonb(s.desks), 'showNames', s.show_names,
      'chime', s.chime, 'languages', to_jsonb(s.languages), 'message', s.message,
      'voice', s.voice, 'voiceLang', s.voice_lang, 'voiceRepeat', s.voice_repeat, 'ticker', s.ticker, 'rwVoice', s.rw_voice,
      'active', s.active and s.revoked_at is null, 'createdAt', s.created_at,
      'createdBy', (select full_name from profiles where id = s.created_by),
      'revokedAt', s.revoked_at
    ) order by (s.active and s.revoked_at is null) desc, s.created_at desc)
    from display_screen s
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- save_display_screen, twelve arguments
create or replace function save_display_screen(
  p_id uuid,
  p_name text,
  p_desks text[],
  p_show_names boolean,
  p_chime boolean,
  p_languages text[],
  p_message text,
  p_voice boolean,
  p_voice_lang text,
  p_voice_repeat integer,
  p_ticker boolean,
  p_rw_voice text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_desks text[] := '{}';
  v_langs text[] := '{}';
  v_d text;
  v_key text;
  v_id uuid;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name is null or length(v_name) > 60 then
    raise exception 'give the screen a name' using errcode = '22023', hint = 'screen_name';
  end if;
  foreach v_d in array coalesce(p_desks, '{}') loop
    if not exists (select 1 from unnest(enum_range(null::station)) as x(s) where x.s::text = v_d) then
      raise exception 'unknown desk %', coalesce(v_d, '?') using errcode = '22023', hint = 'screen_desk';
    end if;
    if not (v_d = any (v_desks)) then
      v_desks := v_desks || v_d;
    end if;
  end loop;
  foreach v_d in array coalesce(p_languages, '{}') loop
    if v_d is null or v_d not in ('rw', 'en', 'fr') then
      raise exception 'unknown language %', coalesce(v_d, '?') using errcode = '22023', hint = 'screen_language';
    end if;
    if not (v_d = any (v_langs)) then
      v_langs := v_langs || v_d;
    end if;
  end loop;
  if cardinality(v_langs) = 0 then
    raise exception 'choose at least one language' using errcode = '22023', hint = 'screen_language';
  end if;
  if length(coalesce(p_message, '')) > 300 then
    raise exception 'the message is too long' using errcode = '22023', hint = 'screen_message';
  end if;
  if coalesce(p_voice_lang, '') not in ('en', 'fr') then
    raise exception 'the voice speaks English or French' using errcode = '22023', hint = 'screen_voice_lang';
  end if;
  if coalesce(p_rw_voice, '') not in ('browser', 'recorded', 'server') then
    raise exception 'the Kinyarwanda voice is browser, recorded or server' using errcode = '22023', hint = 'screen_rw_voice';
  end if;
  if coalesce(p_voice_repeat, 0) not between 1 and 3 then
    raise exception 'the call is said 1 to 3 times' using errcode = '22023', hint = 'screen_voice_repeat';
  end if;
  if p_id is null then
    -- 256 random bits; only the hash is kept, so the key cannot be read back later
    v_key := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into display_screen (name, key_hash, desks, show_names, chime, languages, message,
                                voice, voice_lang, voice_repeat, ticker, rw_voice)
    values (v_name, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), v_desks,
            coalesce(p_show_names, true), coalesce(p_chime, true), v_langs,
            nullif(trim(coalesce(p_message, '')), ''),
            coalesce(p_voice, true), p_voice_lang, p_voice_repeat, coalesce(p_ticker, true), p_rw_voice)
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'key', v_key);
  end if;
  update display_screen
  set name = v_name, desks = v_desks, show_names = coalesce(p_show_names, true),
      chime = coalesce(p_chime, true), languages = v_langs,
      message = nullif(trim(coalesce(p_message, '')), ''),
      voice = coalesce(p_voice, true), voice_lang = p_voice_lang, voice_repeat = p_voice_repeat,
      ticker = coalesce(p_ticker, true), rw_voice = p_rw_voice,
      updated_at = now(), updated_by = auth.uid()
  where id = p_id and active and revoked_at is null;
  if not found then
    raise exception 'this screen is not known or was revoked' using errcode = 'P0002', hint = 'screen_unknown';
  end if;
  return jsonb_build_object('id', p_id);
end
$$;

revoke all on function voice_clip_key_ok(text), voice_object_write_ok(text) from public, anon;
grant execute on function voice_clip_key_ok(text), voice_object_write_ok(text) to authenticated;
revoke all on function voice_clips(), save_voice_clip(text, text, integer), delete_voice_clip(text),
  save_display_screen(uuid, text, text[], boolean, boolean, text[], text, boolean, text, integer, boolean, text)
  from public, anon;
grant execute on function voice_clips(), save_voice_clip(text, text, integer), delete_voice_clip(text),
  save_display_screen(uuid, text, text[], boolean, boolean, text[], text, boolean, text, integer, boolean, text)
  to authenticated;
revoke all on function display_key_ok(text) from public, anon, authenticated;
