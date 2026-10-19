-- 0024 · Reception sees the vitals it may enter.
--
-- Found in live testing (2026-10-19): the receptionist opened a visit whose vitals the nurse
-- had just recorded and saw "No vitals yet" — visit_vitals ran with the caller's rights and
-- observation is readable only with clinical.read. A receptionist holds vitals.write (to type
-- the nurse's paper sheet) and must see what is already there to avoid entering it twice.
-- The view now runs with its owner's rights and filters explicitly: vital-sign codes only,
-- for staff with clinical.read or vitals.write. Diagnoses and notes stay clinical-only.

create or replace view visit_vitals with (security_invoker = false) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by
  from observation o
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
    and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')
    and (has_perm('clinical.read') or has_perm('vitals.write'))
  order by o.encounter_id, o.code, o.effective_at desc;

revoke all on visit_vitals from anon;
grant select on visit_vitals to authenticated;
