-- 0119 · The waiting-room screen as a slideshow: one call banner, one desk at a time.
--
-- Frank tried the TV with the clinic's ten desks: ten columns were unreadable. The page now shows
-- the latest call as one big statement on top, and under it ONE desk card at a time, turning every
-- few seconds (the desks with a patient only). Each waiting patient on that card says who will see
-- them when it is known: the doctor they were sent to by name, with the doctor's room. That is the
-- only change to the board: 'next' entries carry person and room (null when nobody is named).
-- Nothing else of 0118 changes (the voice, the line, the settings).

-- ---------------------------------------------------------------- what the TV shows
-- display_board (from 20261228090000_waiting_screen_voice): the same board; each waiting entry
-- also says who will see the patient (the doctor they were sent to by name, with their room).
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
