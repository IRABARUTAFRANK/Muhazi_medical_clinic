-- 0118 · The waiting-room screen speaks the call and runs a scrolling line.
--
-- Frank: "a sound saying it" — after the chime the TV says "Ticket A-014. Habimana Eric. Please
-- come to Consultation 2." (the browser's own voice, English or French: browsers have no
-- Kinyarwanda voice), once to three times; a result ready is announced too. And a line scrolls
-- at the bottom with who is next at each desk, the results ready and the clinic's message.
--
-- * display_screen gains voice (on/off), voice_lang ('en' | 'fr'), voice_repeat (1..3) and
--   ticker (the scrolling line on/off).
-- * save_display_screen takes the four as its last parameters (without defaults, so that the
--   seven-argument function of 0114 and this one never compete for a call: seven arguments reach
--   the old one, which leaves the voice and the line as they are; eleven reach this one). The
--   screens card always sends the eleven. Refusals: 22023 with hints screen_voice_lang /
--   screen_voice_repeat.
-- * display_screens() and display_board(p_key) return voice, voiceLang, voiceRepeat, ticker
--   (the board's version changes with them, as with every setting of the screen).

alter table display_screen add column if not exists voice boolean not null default true;
alter table display_screen add column if not exists voice_lang text not null default 'en';
alter table display_screen add column if not exists voice_repeat smallint not null default 2;
alter table display_screen add column if not exists ticker boolean not null default true;
alter table display_screen drop constraint if exists display_screen_voice_lang_check;
alter table display_screen add constraint display_screen_voice_lang_check check (voice_lang in ('en', 'fr'));
alter table display_screen drop constraint if exists display_screen_voice_repeat_check;
alter table display_screen add constraint display_screen_voice_repeat_check check (voice_repeat between 1 and 3);

-- ---------------------------------------------------------------- the screens
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
      'voice', s.voice, 'voiceLang', s.voice_lang, 'voiceRepeat', s.voice_repeat, 'ticker', s.ticker,
      'active', s.active and s.revoked_at is null, 'createdAt', s.created_at,
      'createdBy', (select full_name from profiles where id = s.created_by),
      'revokedAt', s.revoked_at
    ) order by (s.active and s.revoked_at is null) desc, s.created_at desc)
    from display_screen s
  ), '[]'::jsonb);
end
$$;

/**
 * Creates a screen (p_id null: the answer carries the plain key, shown once) or changes one.
 * Desks are station names (none = every desk with patients); languages among rw, en, fr; the
 * voice English or French, said 1 to 3 times; the scrolling line on or off. The seven-parameter
 * function of 0114 stays beside this one (see the header).
 */
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
  p_ticker boolean
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
  if coalesce(p_voice_repeat, 0) not between 1 and 3 then
    raise exception 'the call is said 1 to 3 times' using errcode = '22023', hint = 'screen_voice_repeat';
  end if;
  if p_id is null then
    -- 256 random bits; only the hash is kept, so the key cannot be read back later
    v_key := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into display_screen (name, key_hash, desks, show_names, chime, languages, message,
                                voice, voice_lang, voice_repeat, ticker)
    values (v_name, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), v_desks,
            coalesce(p_show_names, true), coalesce(p_chime, true), v_langs,
            nullif(trim(coalesce(p_message, '')), ''),
            coalesce(p_voice, true), p_voice_lang, p_voice_repeat, coalesce(p_ticker, true))
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'key', v_key);
  end if;
  update display_screen
  set name = v_name, desks = v_desks, show_names = coalesce(p_show_names, true),
      chime = coalesce(p_chime, true), languages = v_langs,
      message = nullif(trim(coalesce(p_message, '')), ''),
      voice = coalesce(p_voice, true), voice_lang = p_voice_lang, voice_repeat = p_voice_repeat,
      ticker = coalesce(p_ticker, true),
      updated_at = now(), updated_by = auth.uid()
  where id = p_id and active and revoked_at is null;
  if not found then
    raise exception 'this screen is not known or was revoked' using errcode = 'P0002', hint = 'screen_unknown';
  end if;
  return jsonb_build_object('id', p_id);
end
$$;
revoke all on function save_display_screen(uuid, text, text[], boolean, boolean, text[], text, boolean, text, integer, boolean)
  from public, anon;
grant execute on function save_display_screen(uuid, text, text[], boolean, boolean, text[], text, boolean, text, integer, boolean)
  to authenticated;

-- ---------------------------------------------------------------- what the TV shows
-- display_board (from 20261224090000_waiting_screen): the same board, plus the voice and the
-- scrolling line settings of the screen.
create or replace function display_board(p_key text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s display_screen%rowtype;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_desks text[];
  v_board jsonb;
  v_results jsonb;
  v_payload jsonb;
begin
  select * into v_s from display_screen
  where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
    and active and revoked_at is null;
  if not found then
    raise exception 'this screen key is not known or was revoked' using errcode = '42501', hint = 'screen_unknown';
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
                   'priority', least(q.priority, 3)
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
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
