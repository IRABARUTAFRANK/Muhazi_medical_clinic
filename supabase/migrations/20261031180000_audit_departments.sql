-- 0050 · Departments and categories appear in the activity history.
--
-- Creating, renaming or deleting a department (or a treatment category) wrote nothing to
-- audit_event, so the History page never showed it. Both tables now carry the audit trigger
-- (not the updated_at trigger: they have no updated_at column), and categories belong to the
-- "settings and staff" group of the history like departments.

drop trigger if exists trg_audit on department;
create trigger trg_audit after insert or update or delete on department
  for each row execute function audit_row();
drop trigger if exists trg_audit on service_category;
create trigger trg_audit after insert or update or delete on service_category
  for each row execute function audit_row();

create or replace function activity_group(p_entity text, p_action audit_action)
returns text
language sql immutable
as $$
  select case
    when p_action = 'login' then 'signin'
    when p_entity in ('patient', 'encounter', 'appointment', 'coverage') then 'patients'
    when p_entity = 'observation' then 'vitals'
    when p_entity = 'queue_entry' then 'queue'
    when p_entity in ('invoice', 'invoice_line', 'payment', 'credit_note', 'day_close', 'claim') then 'billing'
    when p_entity in ('condition', 'medication_request', 'service_request', 'procedure',
                      'diagnostic_report', 'internal_task', 'vaccination', 'medication_dispense',
                      'hiv_test', 'fp_event') then 'clinical'
    when p_entity in ('bed', 'bed_stay') then 'beds'
    when p_entity in ('profiles', 'setting', 'department', 'service', 'service_category', 'payer', 'plan',
                      'price_list', 'price_list_item', 'practitioner') or p_action = 'settings' then 'admin'
    else 'other'
  end
$$;
