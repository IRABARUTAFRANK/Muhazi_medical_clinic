-- 0200 · The nurse records what she gave or did for a doctor's task (Frank, 2026-11-24).
--
-- A doctor may leave a task in words ("give Paracetamol 1 g now"). The nurse read it and did it,
-- but a medicine given that way was never recorded: nothing left the stock, nothing went on the
-- bill. Now, under the task, she records what she gave (a medicine of the clinic's stock: how many
-- pieces, the dose and route in words) or did (a medical act of the price list, or one in words):
--   * it is written as an order carried out at once by her (nurse_order with task_id, given now by
--     give_nurse_order): the pieces leave the stock and go on the bill exactly as an order of the
--     doctor marked Given; her Undo (the same day; the manager any day) works as for any order;
--   * when the doctor already ordered the same medicine or act for this visit and it is still to do,
--     or it was given on this visit in the last 12 hours, it is refused with the way out (mark that
--     order given), unless she says why she records it even so (kept on the order);
--   * "the task is done" in the same press, if she says so; the doctor who wrote the task is told
--     what was recorded (one notice);
--   * undone by her (or the manager), it is cancelled like any order undone by its writer, never left
--     as a new "to do" (undo_order_doses).
-- The tasks lists (open_tasks, visit_tasks) carry what was recorded under each task; the order's
-- JSON carries its task. No existing function changes its arguments.

alter table nurse_order add column if not exists task_id uuid references internal_task (id);
alter table nurse_order add column if not exists recorded_why text;
create index if not exists nurse_order_task_idx on nurse_order (task_id) where task_id is not null;
comment on column nurse_order.task_id is
  'The task of the doctor this was recorded for by the nurse after doing it (0200); null: an order of the doctor.';
comment on column nurse_order.recorded_why is
  'Why the nurse recorded it although the doctor had ordered it or it was just given (0200).';

-- ---------------------------------------------------------------- the order: its task
-- nurse_order_json: copied whole from 20270218090000_dose_parts_schedule; + taskId, taskTitle,
-- recordedWhy.
create or replace function nurse_order_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', o.id, 'encounterId', o.encounter_id, 'kind', o.kind, 'text', o.text,
    'serviceId', o.service_id, 'service', (select s.name_en from service s where s.id = o.service_id),
    'itemId', o.item_id, 'item', case when o.item_id is not null then item_label(o.item_id) end,
    'quantity', o.quantity, 'dose', o.dose, 'route', o.route, 'frequency', o.frequency,
    'dosesPlanned', o.doses_planned,
    'given', (select count(*) from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null and d.given)::integer,
    'notGiven', (select count(*) from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null and not d.given)::integer,
    'assignedTo', o.assigned_to, 'assignedName', (select full_name from profiles where id = o.assigned_to),
    'status', o.status, 'notes', o.notes, 'at', o.created_at,
    'by', (select full_name from profiles where id = o.created_by), 'byId', o.created_by,
    'endedAt', o.ended_at, 'endedBy', (select full_name from profiles where id = o.ended_by), 'endReason', o.end_reason,
    'mine', nurse_order_mine(o.assigned_to),
    -- 0193: the medicine's piece and box, and the part to take home
    'unit', coalesce(i.selling_unit, i.unit),
    'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
    'packUnit', i.pack_unit, 'saleMode', i.sale_mode,
    'homeQuantity', o.home_quantity, 'homeDose', o.home_dose, 'homeFrequency', o.home_frequency,
    'homeDays', o.home_days, 'homeInstructions', o.home_instructions,
    'doses', coalesce((select jsonb_agg(jsonb_build_object(
        'n', d.n, 'given', d.given, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id),
        'note', d.note, 'charged', d.charged,
        'store', (select l.name from stock_location l where l.id = d.location_id),
        -- 0193
        'id', d.id, 'byId', d.by_id, 'recordedAt', d.created_at,
        'quantity', case when d.given and o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
        'homeQuantity', d.home_quantity, 'office', d.office,
        'billed', (select coalesce(sum(round(l.quantity * l.unit_price)), 0) from invoice_line l
                   where l.nurse_order_dose_id = d.id and l.deleted_at is null),
        'onBill', exists (select 1 from invoice_line l where l.nurse_order_dose_id = d.id and l.deleted_at is null),
        'batches', coalesce((select jsonb_agg(jsonb_build_object('batchNo', b.batch_no, 'expiry', b.expiry, 'quantity', x.q)
                                              order by b.expiry nulls last, b.batch_no)
                             from (select m.batch_id, sum(m.quantity)::integer as q from stock_movement m
                                   where m.nurse_order_dose_id = d.id and m.type = 'consumption' and m.deleted_at is null
                                   group by m.batch_id) x
                             left join batch b on b.id = x.batch_id), '[]'::jsonb),
        -- 0198: the planned time, the part given
        'dueAt', d.due_at, 'part', d.part) order by d.n)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null), '[]'::jsonb),
    -- 0193: the times undone (back in the stock, off the bill): who, when, why
    'undone', coalesce((select jsonb_agg(jsonb_build_object(
        'n', d.n, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id),
        'quantity', case when o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
        'homeQuantity', d.home_quantity, 'undoneAt', d.deleted_at,
        'undoneBy', (select full_name from profiles where id = d.undone_by), 'reason', d.undo_reason,
        -- 0198
        'given', d.given, 'part', d.part, 'dueAt', d.due_at)
        order by d.deleted_at)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is not null and d.undo_reason is not null), '[]'::jsonb))
  || jsonb_build_object(
    -- 0198: the dose, the part and its price
    'doseAmount', o.dose_amount, 'doseUnit', o.dose_unit,
    'part', o.part, 'partText', o.part_text, 'partPrice', o.part_price,
    'partPriceBy', (select full_name from profiles where id = o.part_price_by), 'partPriceById', o.part_price_by,
    'partPriceReason', o.part_price_reason,
    'partMode', case when o.item_id is not null then item_part_mode(o.item_id) end,
    -- 0198: the time to give and the repeat
    'firstAt', coalesce(o.first_at, o.created_at), 'timed', o.first_at is not null,
    'everyMinutes', o.every_minutes,
    'untilStopped', o.every_minutes is not null and o.doses_planned is null,
    -- 0200: recorded by the nurse for a task of the doctor
    'taskId', o.task_id, 'taskTitle', (select k.title from internal_task k where k.id = o.task_id),
    'recordedWhy', o.recorded_why,
    'nextDueAt', nd.next_due,
    'late', coalesce(o.status = 'open' and o.first_at is not null and nd.next_due < now() - interval '60 minutes', false),
    'times', case when o.every_minutes is not null then coalesce((
      select jsonb_agg(jsonb_build_object(
          'n', t.n, 'dueAt', t.due_at,
          'state', case when d.id is not null then case when d.given then 'given' else 'not_given' end
                        when o.status <> 'open' then 'stopped'
                        when t.due_at < now() - interval '60 minutes' then 'late'
                        when t.due_at <= now() + interval '30 minutes' then 'due'
                        else 'later' end,
          'doseId', d.id, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id), 'byId', d.by_id,
          'recordedAt', d.created_at, 'note', d.note,
          'quantity', case when d.given and o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
          'part', case when d.given then d.part end,
          'billed', case when d.id is not null then
                      (select coalesce(sum(round(l.quantity * l.unit_price)), 0) from invoice_line l
                       where l.nurse_order_dose_id = d.id and l.deleted_at is null) end)
        order by t.n)
      from order_times(o.id) t
      left join nurse_order_dose d on d.id = t.dose_id), '[]'::jsonb) end)
  from nurse_order o
  left join item i on i.id = o.item_id
  left join lateral (select min(t.due_at) as next_due from order_times(o.id) t
                     where t.dose_id is null and o.status = 'open') nd on true
  where o.id = p_id
$$;

-- ---------------------------------------------------------------- the tasks: what was recorded
-- open_tasks and visit_tasks: copied whole from 20270111090000_nurse_task_for_whom; + recorded.
create or replace function open_tasks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name,
      'forName', fo.full_name,
      'forMe', k.assigned_to = auth.uid(),
      -- 0200: what the nurse recorded for it (given or done), in the order recorded
      'recorded', coalesce((select jsonb_agg(jsonb_build_object(
          'id', o.id, 'kind', o.kind, 'text', o.text, 'quantity', o.quantity,
          'unit', (select coalesce(i.selling_unit, i.unit) from item i where i.id = o.item_id),
          'at', o.created_at, 'by', (select full_name from profiles where id = o.created_by),
          'status', o.status) order by o.created_at)
        from nurse_order o where o.task_id = k.id and o.deleted_at is null and o.status <> 'cancelled'), '[]'::jsonb)
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  -- a finished visit's task is over too
  left join encounter e on e.id = k.encounter_id
  left join profiles pr on pr.id = k.created_by
  left join profiles fo on fo.id = k.assigned_to
  where k.deleted_at is null and k.done_at is null and (k.encounter_id is null or e.status = 'open')
    and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role) or is_manager())
$$;

create or replace function visit_tasks(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name,
      'mine', k.created_by = auth.uid(),
      'forName', fo.full_name,
      'forMe', k.assigned_to = auth.uid(),
      -- 0200: what the nurse recorded for it (given or done), in the order recorded
      'recorded', coalesce((select jsonb_agg(jsonb_build_object(
          'id', o.id, 'kind', o.kind, 'text', o.text, 'quantity', o.quantity,
          'unit', (select coalesce(i.selling_unit, i.unit) from item i where i.id = o.item_id),
          'at', o.created_at, 'by', (select full_name from profiles where id = o.created_by),
          'status', o.status) order by o.created_at)
        from nurse_order o where o.task_id = k.id and o.deleted_at is null and o.status <> 'cancelled'), '[]'::jsonb)
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  left join profiles pr on pr.id = k.created_by
  left join profiles fo on fo.id = k.assigned_to
  where k.encounter_id = p_encounter_id and k.deleted_at is null and k.done_at is null
    and (has_perm('clinical.read') or has_perm('vitals.write'))
$$;

-- ---------------------------------------------------------------- recording for a task
-- The nurse records a medicine she gave or an act she did for a task of the doctor (0200): the
-- task is hers (for her, for the nurses, written by her) or the manager's; at the nursing desk when
-- the clinic offers it, as for ticking the task off. A medicine: from the clinic's stock, whole
-- pieces (whole boxes when sold only by the box); an act: one of the price list, or in words (then
-- nothing is billed). Refused when the doctor already ordered the same thing for this visit and it
-- is still to do, or it was given on this visit in the last 12 hours, unless she says why she
-- records it even so. Written as an order of hers carried out now (give_nurse_order: the stock and
-- the bill as for any order); the task is done in the same press when she says so; the doctor who
-- wrote the task is told.
create or replace function record_for_task(
  p_task_id uuid,
  p_kind text,
  p_item_id uuid default null,
  p_service_id uuid default null,
  p_text text default null,
  p_quantity numeric default null,
  p_dose text default null,
  p_route text default null,
  p_note text default null,
  p_even_so boolean default false,
  p_why text default null,
  p_task_done boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_k internal_task%rowtype;
  v_e encounter%rowtype;
  v_i item%rowtype;
  v_text text := nullif(trim(coalesce(p_text, '')), '');
  v_qty numeric;
  v_why text := nullif(trim(coalesce(p_why, '')), '');
  v_even boolean := coalesce(p_even_so, false);
  v_id uuid;
  v_r jsonb;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_k from internal_task where id = p_task_id and deleted_at is null for update;
  if not found or v_k.done_at is not null then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
  -- the task is hers: as the tasks lists show it (open_tasks), or she wrote it, or the manager
  if not (v_k.assigned_to = auth.uid() or task_for_me(v_k.assigned_role) or v_k.created_by = auth.uid()
          or is_manager()) then
    raise exception 'not allowed: this task is for someone else' using errcode = '42501', hint = 'task_not_yours';
  end if;
  if desk_offered('nursing') and v_k.assigned_to is distinct from auth.uid()
     and v_k.created_by is distinct from auth.uid() then
    perform assert_desk(array['nursing'], 'nursing care');
  end if;
  select * into v_e from encounter where id = v_k.encounter_id and deleted_at is null;
  if v_k.encounter_id is null or not found or v_e.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if coalesce(p_kind, '') not in ('act', 'drug') then
    raise exception 'say whether it is a medical act or a drug to give' using errcode = '22023';
  end if;
  if p_kind = 'drug' then
    select * into v_i from item i where i.id = p_item_id and i.active and i.deleted_at is null;
    if p_item_id is null or not found then
      raise exception 'choose the medicine from the stock' using errcode = '22023', hint = 'item_needed';
    end if;
    v_qty := coalesce(p_quantity, 0);
    if v_qty <= 0 then
      raise exception 'quantity must be more than zero' using errcode = '22023';
    end if;
    if v_qty <> trunc(v_qty) then
      raise exception 'count whole pieces here; a part of a piece (½, ¼ or ml) is given apart'
        using errcode = '22023', hint = 'bad_part';
    end if;
    perform assert_whole_packs(p_item_id, v_qty);
    v_text := item_label(p_item_id);
  else
    v_qty := coalesce(p_quantity, 1);
    if v_qty <= 0 then
      raise exception 'quantity must be more than zero' using errcode = '22023';
    end if;
    if p_service_id is not null
       and not exists (select 1 from service s where s.id = p_service_id and s.active and s.deleted_at is null) then
      raise exception 'unknown service' using errcode = '22023';
    end if;
    v_text := coalesce((select s.name_en from service s where s.id = p_service_id), v_text);
  end if;
  if length(coalesce(v_text, '')) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  -- the same thing twice: what the doctor ordered and is still to do, or what was just given
  if not v_even then
    if exists (
      select 1 from nurse_order o
      where o.encounter_id = v_e.id and o.deleted_at is null and o.status = 'open'
        and ((p_kind = 'drug' and o.item_id = p_item_id)
          or (p_kind = 'act' and p_service_id is not null and o.service_id = p_service_id)
          or (p_kind = 'act' and p_service_id is null and o.kind = 'act' and o.service_id is null
              and lower(o.text) = lower(v_text)))) then
      raise exception 'the doctor already ordered this for this visit and it is still to do: mark that order given, or say why you record it even so'
        using errcode = '22023', hint = 'already_ordered';
    end if;
    if exists (
      select 1 from nurse_order_dose d
      join nurse_order o on o.id = d.order_id
      where o.encounter_id = v_e.id and o.deleted_at is null and d.deleted_at is null and d.given
        and d.at > now() - interval '12 hours'
        and ((p_kind = 'drug' and o.item_id = p_item_id)
          or (p_kind = 'act' and p_service_id is not null and o.service_id = p_service_id))) then
      raise exception 'this was already given on this visit in the last 12 hours: say why you record it again'
        using errcode = '22023', hint = 'already_given';
    end if;
  elsif length(coalesce(v_why, '')) < 3 then
    raise exception 'say why you record it even so' using errcode = '22023', hint = 'why_needed';
  end if;
  insert into nurse_order (encounter_id, patient_id, kind, text, service_id, item_id, quantity, dose, route,
                           doses_planned, assigned_to, notes, first_at, task_id, recorded_why)
  values (v_e.id, v_e.patient_id, p_kind, v_text,
          case when p_kind = 'act' then p_service_id end, case when p_kind = 'drug' then p_item_id end,
          v_qty,
          case when p_kind = 'drug' then nullif(trim(coalesce(p_dose, '')), '') end,
          case when p_kind = 'drug' then nullif(trim(coalesce(p_route, '')), '') end,
          1, auth.uid(), nullif(trim(coalesce(p_note, '')), ''), now(), p_task_id,
          case when v_even then v_why end)
  returning id into v_id;
  -- carried out now by her: the stock and the bill as for any order given
  v_r := give_nurse_order(v_id, null);
  if coalesce(p_task_done, false) then
    update internal_task set done_at = now(), done_by = auth.uid() where id = p_task_id;
  end if;
  -- the doctor who wrote the task is told what was recorded (and that the task is done)
  if v_k.created_by is not null and v_k.created_by is distinct from auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('task_recorded',
            jsonb_build_object('title', v_k.title, 'what', v_text, 'kind', p_kind, 'quantity', v_qty,
                               'unit', case when p_kind = 'drug' then coalesce(v_i.selling_unit, v_i.unit) end,
                               'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_e.patient_id),
                               'by', (select full_name from profiles where id = auth.uid()),
                               'done', coalesce(p_task_done, false), 'evenSo', v_even, 'orderId', v_id),
            '/app/visit?encounter=' || v_e.id, v_k.created_by, auth.uid());
  end if;
  return v_r || jsonb_build_object('taskDone', coalesce(p_task_done, false));
end
$$;

revoke all on function
  record_for_task(uuid, text, uuid, uuid, text, numeric, text, text, text, boolean, text, boolean)
  from public, anon;
grant execute on function
  record_for_task(uuid, text, uuid, uuid, text, numeric, text, text, text, boolean, text, boolean)
  to authenticated;
