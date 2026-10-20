-- 0032 — Remove "waiting at …" notices created before 0031 that are no longer true.
-- From 0031 on, a queue notice is deleted when the patient leaves the desk, and a patient sent to
-- several desks gets one shared notice. Older notices carry no queue id, so they are tidied here:
-- a notice stays only while that patient still waits, alone (not shared), at that desk.
delete from notification n
where n.kind = 'queue'
  and not (n.params ? 'queue')
  and not exists (
    select 1
    from queue_entry q
    where q.encounter_id::text = substring(n.link from 'encounter=([0-9a-f-]{36})')
      and q.station::text = n.params ->> 'station'
      and q.finished_at is null
      and q.deleted_at is null
      and q.pool_id is null
  );
