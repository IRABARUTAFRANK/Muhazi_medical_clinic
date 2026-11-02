-- 0121 · Counts on the menu: "My queue 2", "My bookings 4", like the red count on Notifications.
--
-- The owner: "On the sidebar, like the red notification count, I see that I have 2 patients in my
-- queue, or 4 bookings today, and the other entries where it applies — everything except Calendar."
--
-- nav_counts() gives the signed-in person a small object of plain counts (no names, no amounts),
-- read every 20 seconds by the menu. Only the keys that apply to the person are in it; the app
-- puts each one on its menu entry:
--   queue            patients waiting for me: sent to me by name (assigned, or a handover waiting
--                    for my answer), then my desks' queue nobody has taken (as my home's "Waiting
--                    for me" counts it, my_summary 0120); not yet started. Doctors and nurses.
--   inClinic         patients at my desks now (waiting or with me); the manager and reception:
--                    every open visit.
--   results          results back for me (after a handover: for the colleague who took the
--                    patient) and not marked seen, last 7 days.
--   prescriptions    my prescriptions still waiting at the pharmacy (open visits).
--   myBookings       my bookings today (whoever keeps a calendar).
--   bookings         today's bookings with every doctor + the requests still to answer (reception,
--                    the manager, whoever may answer booking requests).
--   worklist         tests waiting at the laboratory / ultrasound desks I use (not yet verified).
--   pharmacy         the pharmacy desk: patients with medicines to hand over + walk-in sales paid
--                    and not handed over yet.
--   stock            a room-store holder (no pharmacy desk): delivery notes to confirm + walk-in
--                    sales paid at my store and not handed over yet.
--   bills            open bills with something still to pay (the cash desk, the manager).
--   payments         walk-in sales waiting to be paid (whoever takes payments; not the manager).
--   recordAccess     requests to see past records waiting for an answer (the manager and whoever
--                    may answer them); the manager also counts emergency accesses not reviewed.
--   documents        staff licences and contracts expiring within 60 days or expired (manager).
--   filesToComplete  patient files with something missing (reception).
-- The visibility rules are those of the pages the entries open; every count is a count(*).

create or replace function nav_counts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_desks text[] := my_desk_list();
  v_station station;
  -- a doctor's or nurse's desk: consultation, dental, nursing, triage…
  v_treat boolean;
  v_pharmacy boolean;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
begin
  if v_me is null or v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_start := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_today + 1)::timestamp) at time zone 'Africa/Kigali';
  v_station := my_home_station();
  v_treat := not v_manager and v_role not in ('receptionist', 'cashier')
             and v_desks && (treating_desks() || array['triage']);
  v_pharmacy := not v_manager and 'pharmacy' = any (v_desks);

  -- MY QUEUE and THE PATIENTS AT MY DESKS (the rule of my_summary's "Waiting for me")
  if v_treat and has_perm('queue.read') and has_perm('patient.read') then
    with mine as (
      select q.encounter_id, q.started_at
      from queue_entry q
      join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
      where q.deleted_at is null and q.finished_at is null
        and (q.assigned_to = v_me
             or q.taken_by = v_me
             or exists (select 1 from patient_handover h
                        where h.queue_id = q.id and h.status = 'pending' and h.to_user = v_me
                          and h.deleted_at is null)
             or (q.assigned_to is null and q.taken_by is null
                 and (serves_station(v_me, q.station, coalesce(q.service, e.service))
                      or q.station = v_station)
                 and (q.department_id is null
                      or exists (select 1 from profiles me where me.id = v_me and me.department_id = q.department_id)
                      or exists (select 1 from staff_department sd
                                 where sd.profile_id = v_me and sd.department_id = q.department_id))))
    )
    select jsonb_build_object(
             'queue', count(*) filter (where started_at is null),
             'inClinic', count(distinct encounter_id))
    into v_out
    from mine;
  elsif (v_manager or v_role = 'receptionist') and has_perm('patient.read') then
    v_out := jsonb_build_object('inClinic',
      (select count(*) from encounter e where e.status = 'open' and e.deleted_at is null));
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if not v_manager
     and ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'surgery', 'circ']) d(desk)
                     where desk_via(v_me, d.desk) = 'department')) then
    select count(*) into v_n
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    where d.deleted_at is null and d.reviewed_at is null
      and r.status in ('resulted', 'verified')
      and d.updated_at > now() - interval '7 days'
      -- cheap first: my own request, or a visit handed over to me
      and (r.requester_id = v_me
           or exists (select 1 from patient_handover h where h.encounter_id = r.encounter_id
                      and h.to_user = v_me and h.status = 'taken' and h.deleted_at is null))
      and result_recipient(r.encounter_id, r.requester_id) = v_me;
    v_out := v_out || jsonb_build_object('results', v_n);

    select count(*) into v_n
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open' and e.deleted_at is null
    where coalesce(m.prescriber_id, m.created_by) = v_me and rx_pending(m);
    v_out := v_out || jsonb_build_object('prescriptions', v_n);
  end if;

  -- MY BOOKINGS TODAY (whoever keeps a calendar)
  if has_perm('appointment.accept') or v_manager then
    select count(*) into v_n
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_me and pr.deleted_at is null
    where a.deleted_at is null
      and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
      and a.starts_at >= v_start and a.starts_at < v_end;
    if v_n > 0 or exists (select 1 from practitioner pr where pr.user_id = v_me and pr.deleted_at is null) then
      v_out := v_out || jsonb_build_object('myBookings', v_n);
    end if;
  end if;

  -- TODAY'S BOOKINGS + THE REQUESTS TO ANSWER (reception's Bookings page)
  if v_manager or v_role = 'receptionist' or has_perm('appointment.approve') then
    v_out := v_out || jsonb_build_object('bookings',
      (select count(*) from appointment a
       where a.deleted_at is null
         and ((a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
               and a.starts_at >= v_start and a.starts_at < v_end)
              or a.status = 'inquiry')));
  end if;

  -- THE LABORATORY / ULTRASOUND WORKLIST (the rule of lab_worklist, open)
  if not v_manager and v_desks && array['laboratory', 'ultrasound'] and has_perm('orders.read') then
    v_out := v_out || jsonb_build_object('worklist',
      (select count(*)
       from service_request r
       join encounter e on e.id = r.encounter_id and e.status = 'open'
       where r.deleted_at is null
         and r.status not in ('verified', 'cancelled')
         and r.category = any (my_test_categories())
         and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station
                                      else 'laboratory'::station end) in ('laboratory', 'ultrasound')
         and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
              or not sensitive_service(r.service_id))));
  end if;

  -- THE PHARMACY: patients with medicines to hand over + walk-in sales paid, not handed over
  if v_pharmacy then
    v_out := v_out || jsonb_build_object('pharmacy',
      (select count(distinct m.encounter_id)
       from medication_request m
       join encounter e on e.id = m.encounter_id and e.status = 'open'
       where rx_pending(m))
      + (select count(*) from counter_sale s
         join stock_location l on l.id = s.location_id
         where s.deleted_at is null and s.status = 'paid' and not is_room_type(l.type)));
  elsif not v_manager and exists (
      select 1 from stock_location l
      where l.active and l.deleted_at is null and is_room_type(l.type) and holds_store(v_me, l.id)) then
    -- A ROOM STORE (a doctor's office, the ward): delivery notes to confirm + walk-in sales to give
    v_out := v_out || jsonb_build_object('stock',
      (select count(*) from stock_transfer t
       where t.deleted_at is null and t.status = 'in_transit' and t.direction = 'to_room'
         and holds_store(v_me, t.to_location_id))
      + (select count(*) from counter_sale s
         join stock_location l on l.id = s.location_id
         where s.deleted_at is null and s.status = 'paid' and is_room_type(l.type)
           and holds_store(v_me, s.location_id)));
  end if;

  -- MONEY: open bills (as cashier_summary counts them) and walk-in sales waiting to be paid
  if v_manager or v_role = 'cashier' or has_perm('payment.take') then
    v_out := v_out || jsonb_build_object('bills',
      (select count(*) from invoice i join encounter e on e.id = i.encounter_id
       where i.deleted_at is null and i.status = 'draft' and e.status = 'open'
         and invoice_balance(i.id) > 0));
  end if;
  if not v_manager and (v_role = 'cashier' or has_perm('payment.take')) then
    v_out := v_out || jsonb_build_object('payments',
      (select count(*) from counter_sale s where s.deleted_at is null and s.status = 'open'));
  end if;

  -- RECORD ACCESS: requests waiting for an answer (record_access_requests 'pending')
  if v_manager or has_perm('records.approve') then
    v_out := v_out || jsonb_build_object('recordAccess',
      (select count(*) from record_access_request r
       join encounter e on e.id = r.encounter_id and e.status = 'open'
       where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
         and r.created_at > now() - interval '90 days')
      + case when v_manager then
          (select count(*) from record_access_request r
           where r.kind = 'emergency' and r.reviewed_at is null
             and r.created_at > now() - interval '90 days')
        else 0 end);
  end if;

  -- STAFF DOCUMENTS expiring within 60 days, or expired (staff_documents_expiring)
  if v_manager then
    v_out := v_out || jsonb_build_object('documents',
      (select count(*) from staff_document d
       join profiles p on p.id = d.profile_id and p.active
       where d.deleted_at is null and d.kind in ('licence', 'contract')
         and d.expires_on is not null and d.expires_on <= staff_doc_today() + 60));
  end if;

  -- FILES TO COMPLETE (reception; the rule of files_to_complete)
  if v_role = 'receptionist' and has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('filesToComplete',
      (with s as (select patient_builtins() as b, patient_fields() as f)
       select count(distinct p.id)
       from patient p
       cross join s
       left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
       where p.deleted_at is null and p.merged_into is null
         and (e.id is not null or p.created_at > now() - interval '2 days')
         and cardinality(patient_missing_with(p, s.b, s.f)) > 0));
  end if;

  return v_out;
end
$$;
revoke all on function nav_counts() from public, anon;
grant execute on function nav_counts() to authenticated;
