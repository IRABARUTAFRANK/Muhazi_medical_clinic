-- 0033 — Activity history on every dashboard: each person sees what they did themselves; the
-- manager still sees everyone's (and can filter by person).

create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Everyone sees their own activity; only the manager sees everybody's (and may pick a person).
  if not is_manager() then
    p_actor := auth.uid();
  end if;
  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
  )
  select count(*) into v_total from ev;

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev.id,
      'at', ev.at,
      'action', ev.action,
      'entity', ev.entity,
      'group', ev.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'patient', coalesce(
        case when ev.entity = 'patient' then (ev.row ->> 'surname') || ' ' || (ev.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names),
      'detail', case ev.entity
        when 'observation' then (ev.row ->> 'code') || ' ' || coalesce(ev.row ->> 'value_num', ev.row ->> 'value_text', '')
        when 'invoice_line' then (ev.row ->> 'description') || ' · ' ||
             round(coalesce((ev.row ->> 'unit_price')::numeric, 0) * coalesce((ev.row ->> 'quantity')::numeric, 1))
        when 'payment' then (ev.row ->> 'method') || ' · ' || (ev.row ->> 'amount')
        when 'queue_entry' then (ev.row ->> 'ticket_no') || ' · ' || (ev.row ->> 'station') ||
             case when ev.action = 'update' and ev.after ->> 'finished_at' is not null
                       and ev.before ->> 'finished_at' is null then ' · done'
                  when ev.action = 'update' and ev.after ->> 'started_at' is not null
                       and ev.before ->> 'started_at' is null then ' · taken'
                  else '' end
        when 'encounter' then coalesce(ev.row ->> 'status', '')
        when 'bed_stay' then coalesce(ev.row ->> 'planned_nights', '') || ' night(s)'
        when 'profiles' then coalesce(ev.after ->> 'manage_staff', ev.row ->> 'username', '')
        else coalesce(ev.row ->> 'name', ev.row ->> 'title', ev.row ->> 'description',
                      ev.row ->> 'name_en', ev.row ->> 'code', ev.reason, '')
      end,
      'reason', ev.reason
    ) order by ev.at desc), '[]'::jsonb)
  into v_items
  from ev
  left join profiles pr on pr.id = ev.actor_id
  left join encounter en on en.id = case when ev.entity = 'encounter' then ev.entity_id
                                         else nullif(ev.row ->> 'encounter_id', '')::uuid end
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;
