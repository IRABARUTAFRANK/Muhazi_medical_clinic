-- 0038 · History that explains what happened.
--
-- Each history item now also carries the record as it was saved (without secrets and without
-- bookkeeping columns), the fields that changed with their old and new values, and the names
-- behind the ids (patient and file, treatment, medicine, employee, doctor, bed, bill number), so
-- the screen can write a full sentence: "Charged Uwase Claudine RWF 5,000 for Consultation".

-- The record without secrets (PIN, password, keys, tokens) and without bookkeeping columns.
create or replace function audit_clean(p jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) as e(k, v)
  where e.k !~* '((^|_)pin($|_)|password|hash|token|secret|api_key|photo_blob|signature)'
    and e.k not in ('id', 'created_at', 'created_by', 'device_id', 'received_at', 'updated_at',
                    'updated_by', 'version')
$$;

-- Fields that changed between two versions: [{f, from, to}], same filtering as audit_clean.
create or replace function audit_changes(p_before jsonb, p_after jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('f', k, 'from', b -> k, 'to', a -> k) order by k), '[]'::jsonb)
  from (select audit_clean(p_before) as b, audit_clean(p_after) as a) x,
       lateral (select jsonb_object_keys(x.a) as k union select jsonb_object_keys(x.b)) keys
  where (x.b -> k) is distinct from (x.a -> k)
    and p_before is not null and p_after is not null
$$;

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

  select count(*) into v_total
  from audit_event a
  where a.at >= v_from and a.at < v_to and a.action <> 'read'
    and (p_actor is null or a.actor_id = p_actor)
    and (p_group is null or activity_group(a.entity, a.action) = p_group);

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  ),
  -- The visit behind the record: directly, through its bill, or through its test order.
  ev2 as (
    select ev.*,
      case when ev.entity = 'encounter' then ev.entity_id
        else coalesce(
          nullif(ev.row ->> 'encounter_id', '')::uuid,
          (select i.encounter_id from invoice i where i.id = nullif(ev.row ->> 'invoice_id', '')::uuid),
          (select i.encounter_id from invoice i where ev.entity = 'invoice' and i.id = ev.entity_id),
          (select sr.encounter_id from service_request sr where sr.id = nullif(ev.row ->> 'service_request_id', '')::uuid),
          (select md.encounter_id from medication_request md where md.id = nullif(ev.row ->> 'medication_request_id', '')::uuid))
      end as enc_id
    from ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev2.id,
      'at', ev2.at,
      'action', ev2.action,
      'entity', ev2.entity,
      'group', ev2.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'patient', coalesce(
        case when ev2.entity = 'patient' then (ev2.row ->> 'surname') || ' ' || (ev2.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names,
        case when ev2.entity = 'appointment' then ev2.row ->> 'contact_name' end),
      'detail', null,
      'reason', ev2.reason,
      'row', audit_clean(ev2.row),
      'changes', case when ev2.action = 'update' then audit_changes(ev2.before, ev2.after) else '[]'::jsonb end,
      'names', jsonb_strip_nulls(jsonb_build_object(
        'file', coalesce(case when ev2.entity = 'patient' then ev2.row ->> 'file_number' end,
                         pe.file_number, pp.file_number),
        'target', case ev2.entity
          when 'profiles' then (select p.full_name || coalesce(' (' || p.staff_id || ')', '') from profiles p where p.id = ev2.entity_id)
          when 'practitioner' then ev2.row ->> 'names'
          when 'service' then coalesce(ev2.row ->> 'name_en', (select s.name_en from service s where s.id = ev2.entity_id))
          when 'payer' then coalesce(ev2.row ->> 'name', (select y.name from payer y where y.id = ev2.entity_id))
          when 'bed' then ev2.row ->> 'name'
          when 'item' then ev2.row ->> 'name_generic'
        end,
        'service', (select s.name_en from service s where s.id = coalesce(
          nullif(ev2.row ->> 'service_id', '')::uuid,
          (select sr.service_id from service_request sr where sr.id = nullif(ev2.row ->> 'service_request_id', '')::uuid))),
        'item', (select it.name_generic || coalesce(' ' || it.strength, '') from item it
                 where it.id = coalesce(nullif(ev2.row ->> 'item_id', '')::uuid,
                   (select md.item_id from medication_request md where md.id = nullif(ev2.row ->> 'medication_request_id', '')::uuid))),
        'staff', (select p.full_name from profiles p
                  where p.id = nullif(coalesce(ev2.after ->> 'assigned_to', ev2.after ->> 'taken_by',
                                               ev2.row ->> 'assigned_to', ev2.row ->> 'given_by'), '')::uuid),
        'referredBy', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'referred_by', '')::uuid),
        'returnTo', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'return_to', '')::uuid),
        'performer', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'performer_id', '')::uuid),
        'practitioner', (select x.names from practitioner x where x.id = nullif(ev2.row ->> 'practitioner_id', '')::uuid),
        'bed', (select b.name from bed b where b.id = nullif(ev2.row ->> 'bed_id', '')::uuid),
        'invoice', coalesce(case when ev2.entity = 'invoice' then ev2.row ->> 'number' end,
                            (select i.number from invoice i where i.id = nullif(ev2.row ->> 'invoice_id', '')::uuid)),
        'department', (select d.name from department d where d.id = nullif(ev2.row ->> 'department_id', '')::uuid)
      ))
    ) order by ev2.at desc), '[]'::jsonb)
  into v_items
  from ev2
  left join profiles pr on pr.id = ev2.actor_id
  left join encounter en on en.id = ev2.enc_id
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev2.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;

revoke all on function audit_clean(jsonb), audit_changes(jsonb, jsonb) from public, anon;
