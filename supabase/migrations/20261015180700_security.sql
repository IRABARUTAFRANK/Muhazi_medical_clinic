-- Muhazi Medical Clinic System — 0008 security
-- Permission keys per role (doc §1.4), row-level security on every table, grants for the
-- Supabase roles. The anonymous public site can only read the two public views and call
-- create_appointment_inquiry(); staff go through has_perm().

-- ---------------------------------------------------------------- role → permissions
insert into role_permissions (role, permission)
select r::role_key, p
from (values
  -- receptionist: register and find patients, queue tickets, inquiries and approval, print cards
  ('receptionist', 'patient.read'), ('receptionist', 'patient.write'),
  ('receptionist', 'appointment.read'), ('receptionist', 'appointment.write'), ('receptionist', 'appointment.approve'),
  ('receptionist', 'queue.read'), ('receptionist', 'queue.write'),
  ('receptionist', 'billing.read'),
  ('receptionist', 'messages.read'), ('receptionist', 'messages.write'),
  ('receptionist', 'catalogue.read'), ('receptionist', 'settings.read'), ('receptionist', 'staff.read'),
  -- cashier / finance: payments, receipts, day close, charge slips from stations without a screen
  ('cashier', 'patient.read'),
  ('cashier', 'billing.read'), ('cashier', 'billing.write'), ('cashier', 'charge.write'),
  ('cashier', 'claims.read'),
  ('cashier', 'queue.read'), ('cashier', 'queue.write'),
  ('cashier', 'catalogue.read'), ('cashier', 'settings.read'), ('cashier', 'staff.read'),
  -- nurse: vitals, triage, nursing acts, beds, vaccination, FP, HIV testing, charge nursing acts
  ('nurse', 'patient.read'), ('nurse', 'patient.write'),
  ('nurse', 'appointment.read'),
  ('nurse', 'queue.read'), ('nurse', 'queue.write'),
  ('nurse', 'clinical.read'), ('nurse', 'clinical.write'),
  ('nurse', 'sensitive.read'), ('nurse', 'sensitive.write'),
  ('nurse', 'orders.read'), ('nurse', 'prescription.read'),
  ('nurse', 'charge.write'), ('nurse', 'stock.read'),
  ('nurse', 'catalogue.read'), ('nurse', 'settings.read'), ('nurse', 'staff.read'),
  -- doctor / dentist: consult, diagnose, prescribe, order, procedures, accept appointments, charge acts
  ('doctor', 'patient.read'), ('doctor', 'patient.write'),
  ('doctor', 'appointment.read'), ('doctor', 'appointment.accept'),
  ('doctor', 'queue.read'), ('doctor', 'queue.write'),
  ('doctor', 'clinical.read'), ('doctor', 'clinical.write'),
  ('doctor', 'sensitive.read'), ('doctor', 'sensitive.write'),
  ('doctor', 'orders.read'), ('doctor', 'orders.write'), ('doctor', 'prescription.read'),
  ('doctor', 'charge.write'), ('doctor', 'charge.manual'),
  ('doctor', 'catalogue.read'), ('doctor', 'settings.read'), ('doctor', 'staff.read'),
  -- sonographer: imaging worklist, reports, charge for exams
  ('sonographer', 'patient.read'),
  ('sonographer', 'queue.read'), ('sonographer', 'queue.write'),
  ('sonographer', 'clinical.read'),
  ('sonographer', 'orders.read'), ('sonographer', 'orders.write'),
  ('sonographer', 'charge.write'),
  ('sonographer', 'catalogue.read'), ('sonographer', 'settings.read'), ('sonographer', 'staff.read'),
  -- lab technician: samples, results, verification, reports, reagent stock, charge for tests
  ('lab_tech', 'patient.read'),
  ('lab_tech', 'queue.read'), ('lab_tech', 'queue.write'),
  ('lab_tech', 'orders.read'), ('lab_tech', 'orders.write'),
  ('lab_tech', 'charge.write'),
  ('lab_tech', 'stock.read'), ('lab_tech', 'stock.write'),
  ('lab_tech', 'catalogue.read'), ('lab_tech', 'settings.read'), ('lab_tech', 'staff.read'),
  -- pharmacist: dispense, prices of medicines, stock, purchases, direct sales
  ('pharmacist', 'patient.read'),
  ('pharmacist', 'queue.read'), ('pharmacist', 'queue.write'),
  ('pharmacist', 'prescription.read'),
  ('pharmacist', 'stock.read'), ('pharmacist', 'stock.write'), ('pharmacist', 'stock.dispense'),
  ('pharmacist', 'charge.write'), ('pharmacist', 'item_price.write'),
  ('pharmacist', 'catalogue.read'), ('pharmacist', 'settings.read'), ('pharmacist', 'staff.read')
) as v(r, p);

-- manager / owner: everything (clinical notes read-only is enforced by the app and audit)
insert into role_permissions (role, permission)
select 'manager', p
from unnest(array[
  'patient.read', 'patient.write', 'appointment.read', 'appointment.write', 'appointment.approve', 'appointment.accept',
  'queue.read', 'queue.write', 'clinical.read', 'orders.read', 'prescription.read',
  'charge.write', 'charge.manual', 'billing.read', 'billing.write', 'claims.read', 'claims.write',
  'stock.read', 'stock.write', 'stock.dispense', 'item_price.write',
  'catalogue.read', 'catalogue.write', 'settings.read', 'settings.write',
  'messages.read', 'messages.write', 'staff.read', 'staff.write', 'audit.read', 'reports.read'
]) as p;

-- ---------------------------------------------------------------- policy helper
create or replace function apply_rls(p_table text, p_read text, p_write text)
returns void
language plpgsql
as $$
begin
  execute format('alter table %I enable row level security', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_select', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_delete', p_table);
  execute format('create policy %I on %I for select to authenticated using (has_perm(%L))',
                 p_table || '_select', p_table, p_read);
  execute format('create policy %I on %I for insert to authenticated with check (has_perm(%L))',
                 p_table || '_insert', p_table, p_write);
  execute format('create policy %I on %I for update to authenticated using (has_perm(%L)) with check (has_perm(%L))',
                 p_table || '_update', p_table, p_write, p_write);
  -- Nothing is physically deleted during retention (doc §2.3); only the manager may hard-delete.
  execute format('create policy %I on %I for delete to authenticated using (is_manager())',
                 p_table || '_delete', p_table);
end
$$;

-- ---------------------------------------------------------------- tables
alter table mmc_base enable row level security;            -- template: no policies, no access
alter table number_series enable row level security;       -- functions only
alter table audit_event enable row level security;
create policy audit_event_select on audit_event for select to authenticated using (has_perm('audit.read'));

alter table profiles enable row level security;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or has_perm('staff.read'));
create policy profiles_insert on profiles for insert to authenticated with check (has_perm('staff.write'));
create policy profiles_update on profiles for update to authenticated
  using (id = auth.uid() or has_perm('staff.write'))
  with check (id = auth.uid() or has_perm('staff.write'));

alter table role_permissions enable row level security;
create policy role_permissions_select on role_permissions for select to authenticated using (true);
create policy role_permissions_write on role_permissions for all to authenticated
  using (is_manager()) with check (is_manager());

select apply_rls('setting', 'settings.read', 'settings.write');
select apply_rls('translation', 'settings.read', 'settings.write');
select apply_rls('device', 'staff.read', 'staff.write');

select apply_rls('payer', 'catalogue.read', 'catalogue.write');
select apply_rls('plan', 'catalogue.read', 'catalogue.write');
select apply_rls('patient', 'patient.read', 'patient.write');
select apply_rls('patient_alias', 'patient.read', 'patient.write');
select apply_rls('coverage', 'patient.read', 'patient.write');

select apply_rls('service', 'catalogue.read', 'catalogue.write');
select apply_rls('item', 'catalogue.read', 'item_price.write');
select apply_rls('price_list', 'catalogue.read', 'catalogue.write');
select apply_rls('price_list_item', 'catalogue.read', 'catalogue.write');
select apply_rls('practitioner', 'catalogue.read', 'staff.write');

select apply_rls('appointment', 'appointment.read', 'appointment.write');
select apply_rls('encounter', 'queue.read', 'queue.write');
select apply_rls('queue_entry', 'queue.read', 'queue.write');
select apply_rls('observation', 'clinical.read', 'clinical.write');
select apply_rls('condition', 'clinical.read', 'clinical.write');
select apply_rls('service_request', 'orders.read', 'orders.write');
select apply_rls('diagnostic_report', 'orders.read', 'orders.write');
select apply_rls('procedure', 'clinical.read', 'clinical.write');
select apply_rls('medication_request', 'prescription.read', 'clinical.write');
select apply_rls('bed', 'queue.read', 'clinical.write');
select apply_rls('bed_stay', 'clinical.read', 'clinical.write');
select apply_rls('vaccination', 'clinical.read', 'clinical.write');
select apply_rls('fp_event', 'clinical.read', 'clinical.write');
select apply_rls('hiv_test', 'sensitive.read', 'sensitive.write');
select apply_rls('document', 'patient.read', 'patient.write');

select apply_rls('stock_location', 'stock.read', 'stock.write');
select apply_rls('supplier', 'stock.read', 'stock.write');
select apply_rls('batch', 'stock.read', 'stock.write');
select apply_rls('stock_movement', 'stock.read', 'stock.write');
select apply_rls('medication_dispense', 'prescription.read', 'stock.dispense');
select apply_rls('purchase_order', 'stock.read', 'stock.write');
select apply_rls('purchase_order_line', 'stock.read', 'stock.write');
select apply_rls('goods_receipt', 'stock.read', 'stock.write');

select apply_rls('invoice', 'billing.read', 'billing.write');
select apply_rls('invoice_line', 'billing.read', 'charge.write');
select apply_rls('payment', 'billing.read', 'billing.write');
select apply_rls('credit_note', 'billing.read', 'billing.write');
select apply_rls('claim', 'claims.read', 'claims.write');
select apply_rls('claim_batch', 'claims.read', 'claims.write');
select apply_rls('day_close', 'billing.read', 'billing.write');

select apply_rls('template', 'messages.read', 'settings.write');
select apply_rls('message', 'messages.read', 'messages.write');
select apply_rls('internal_task', 'queue.read', 'queue.write');
select apply_rls('hmis_submission', 'reports.read', 'reports.read');

-- Clinical staff may read the running bill of the visit they are working on (doc §4.2).
create policy invoice_select_clinical on invoice for select to authenticated using (has_perm('charge.write'));
create policy invoice_line_select_clinical on invoice_line for select to authenticated using (has_perm('charge.write'));

-- ---------------------------------------------------------------- grants (Supabase roles)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke all on mmc_base from anon, authenticated;
revoke all on number_series from anon, authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function create_appointment_inquiry(text, timestamptz, text, text, text, text, text, text) to anon;
grant select on public_practitioners, public_booked_slots to anon, authenticated;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public revoke execute on functions from anon;
