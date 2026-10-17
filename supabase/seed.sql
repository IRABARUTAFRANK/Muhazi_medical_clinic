-- Muhazi Medical Clinic System — reference data and sample catalogue
-- Payers and plans, preset services with cash and RSSB tariffs, pharmacy items, practitioners,
-- stock locations, beds, templates and clinic settings. Prices are illustrative (doc §4.5 example).
-- Staff accounts are created by scripts/seed-staff.mjs (they live in Supabase Auth).

-- ---------------------------------------------------------------- payers and plans
-- The clinic has no insurance partners yet: insurers are seeded inactive so billing can be set up
-- later without re-seeding. `public_payers` (and therefore the public site) lists active ones only.
insert into payer (code, name, type, cycle_day, active) values
  ('CASH',    'Cash',                    'cash',      null, true),
  ('RAMA',    'RSSB RAMA',               'rssb_rama', 5,    false),
  ('CBHI',    'Mutuelle de Santé (CBHI)','cbhi',      5,    false),
  ('MMI',     'MMI',                     'mmi',       10,   false),
  ('RADIANT', 'Radiant',                 'private',   10,   false),
  ('PRIME',   'Prime',                   'private',   10,   false),
  ('BRITAM',  'Britam',                  'private',   10,   false);

insert into plan (payer_id, name, coverage_pct, pct_by_group)
select id, 'Standard', pct, groups::jsonb
from (values
  ('CASH', 0, '{}'),
  ('RAMA', 85, '{}'),
  ('CBHI', 90, '{}'),
  ('MMI', 85, '{"dental": 50}'),
  ('RADIANT', 80, '{"dental": 50}'),
  ('PRIME', 80, '{}'),
  ('BRITAM', 80, '{}')
) as v(code, pct, groups)
join payer p on p.code = v.code;

-- ---------------------------------------------------------------- preset services (doc §1.1, §4.1)
insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price, default_duration_min) values
  ('REG-CARD',  'Registration and patient card', null, 'Enregistrement et carte', 'registration', false, null),
  ('CONS-GEN',  'General consultation', 'Gusuzuma', 'Consultation générale', 'consultation', false, 20),
  ('CONS-FU',   'Follow-up consultation', null, 'Consultation de suivi', 'consultation', false, 15),
  ('CONS-FP',   'Family planning consultation', 'Kuboneza urubyaro', 'Consultation de planification familiale', 'consultation', false, 20),
  ('LAB-MRDT',  'Malaria RDT', null, 'TDR paludisme', 'lab', false, null),
  ('LAB-FBC',   'Full blood count', null, 'Hémogramme', 'lab', false, null),
  ('LAB-GLU',   'Glucose (fasting)', null, 'Glycémie à jeun', 'lab', false, null),
  ('LAB-URIN',  'Urinalysis', null, 'Analyse d''urine', 'lab', false, null),
  ('LAB-HIV',   'HIV rapid test', null, 'Test VIH rapide', 'lab', false, null),
  ('DEN-EXAM',  'Dental examination', 'Gusuzuma amenyo', 'Examen dentaire', 'dental', false, 20),
  ('DEN-FILL',  'Dental filling', null, 'Plombage', 'dental', false, 40),
  ('DEN-EXT',   'Tooth extraction', 'Gukura iryinyo', 'Extraction dentaire', 'dental', false, 30),
  ('DEN-SCAL',  'Scaling and cleaning', null, 'Détartrage', 'dental', false, 30),
  ('US-OB',     'Obstetric ultrasound', 'Guca mu cyuma', 'Échographie obstétricale', 'imaging', false, 30),
  ('US-ABD',    'Abdominal ultrasound', null, 'Échographie abdominale', 'imaging', false, 30),
  ('NUR-VIT',   'Vital signs', 'Ibipimo', 'Constantes', 'nursing', false, null),
  ('NUR-INJ',   'Injection', 'Urushinge', 'Injection', 'nursing', true, null),
  ('NUR-DRESS', 'Dressing', null, 'Pansement', 'nursing', true, null),
  ('SUR-SUT',   'Suturing', null, 'Suture', 'procedure', true, 30),
  ('SUR-ABSC',  'Abscess drainage', null, 'Drainage d''abcès', 'procedure', true, 30),
  ('SUR-CIRC',  'Circumcision', 'Gusiramura', 'Circoncision', 'procedure', false, 45),
  ('VAC-DOSE',  'Vaccination dose', 'Inkingo', 'Dose de vaccin', 'nursing', false, null),
  ('BED-HOUR',  'Observation bed (per hour)', null, 'Lit d''observation (heure)', 'bed', false, null),
  ('BED-DAY',   'Observation bed (per day)', null, 'Lit d''observation (jour)', 'bed', false, null);

-- Public booking category of each service (what the landing and booking pages show)
update service set booking_category = v.cat
from (values
  ('CONS-GEN', 'consultation'), ('CONS-FU', 'consultation'), ('CONS-FP', 'fp'),
  ('LAB-MRDT', 'laboratory'), ('LAB-FBC', 'laboratory'), ('LAB-GLU', 'laboratory'), ('LAB-URIN', 'laboratory'),
  ('LAB-HIV', 'hiv'), ('VAC-DOSE', 'hiv'),
  ('DEN-EXAM', 'dental'), ('DEN-FILL', 'dental'), ('DEN-EXT', 'dental'), ('DEN-SCAL', 'dental'),
  ('US-OB', 'ultrasound'), ('US-ABD', 'ultrasound'),
  ('NUR-VIT', 'nursing'), ('NUR-INJ', 'nursing'), ('NUR-DRESS', 'nursing'), ('BED-HOUR', 'nursing'), ('BED-DAY', 'nursing'),
  ('SUR-SUT', 'surgery'), ('SUR-ABSC', 'surgery'), ('SUR-CIRC', 'circ')
) as v(code, cat)
where service.code = v.code;

-- ---------------------------------------------------------------- pharmacy items
insert into item (code, name_generic, strength, form, unit, pack_size, selling_unit, reorder_level) values
  ('AMOX500',  'Amoxicillin', '500 mg', 'capsule', 'cap', 100, 'cap', 500),
  ('PARA500',  'Paracetamol', '500 mg', 'tablet', 'tab', 100, 'tab', 1000),
  ('AL20120',  'Artemether-lumefantrine', '20/120 mg', 'tablet', 'tab', 24, 'tab', 150),
  ('ORS',      'Oral rehydration salts', null, 'sachet', 'sachet', 100, 'sachet', 200),
  ('GLOVE-M',  'Examination gloves M', null, 'box', 'box', 1, 'box', 10),
  ('MRDT-KIT', 'Malaria RDT kit', null, 'test', 'test', 25, 'test', 100),
  ('CEFTRI1G', 'Ceftriaxone', '1 g', 'vial', 'vial', 10, 'vial', 50);

-- ---------------------------------------------------------------- price lists
insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices 2026', date '2026-01-01');
insert into price_list (payer_id, name, effective_from)
select id, 'RSSB tariff 2026', date '2026-01-01' from payer where code = 'RAMA';

insert into price_list_item (price_list_id, service_id, price)
select pl.id, s.id, v.price
from (values
  ('REG-CARD', 500), ('CONS-GEN', 8000), ('CONS-FU', 5000), ('CONS-FP', 0),
  ('LAB-MRDT', 2500), ('LAB-FBC', 5000), ('LAB-GLU', 2500), ('LAB-URIN', 2500), ('LAB-HIV', 0),
  ('DEN-EXAM', 5000), ('DEN-FILL', 15000), ('DEN-EXT', 15000), ('DEN-SCAL', 20000),
  ('US-OB', 20000), ('US-ABD', 20000),
  ('NUR-VIT', 0), ('NUR-INJ', 1000), ('NUR-DRESS', 2000),
  ('SUR-SUT', 25000), ('SUR-ABSC', 25000), ('SUR-CIRC', 30000), ('VAC-DOSE', 0),
  ('BED-HOUR', 1000), ('BED-DAY', 10000)
) as v(code, price)
join service s on s.code = v.code
cross join price_list pl
where pl.payer_id is null;

-- RSSB tariff (doc §4.5 worked example: consultation 5,000, malaria RDT 2,000, FBC 4,000)
insert into price_list_item (price_list_id, service_id, price)
select pl.id, s.id, v.price
from (values
  ('REG-CARD', 500), ('CONS-GEN', 5000), ('CONS-FU', 3000), ('CONS-FP', 0),
  ('LAB-MRDT', 2000), ('LAB-FBC', 4000), ('LAB-GLU', 2000), ('LAB-URIN', 2000), ('LAB-HIV', 0),
  ('DEN-EXAM', 4000), ('DEN-FILL', 12000), ('DEN-EXT', 12000), ('DEN-SCAL', 15000),
  ('US-OB', 15000), ('US-ABD', 15000),
  ('NUR-VIT', 0), ('NUR-INJ', 1000), ('NUR-DRESS', 1500),
  ('SUR-SUT', 20000), ('SUR-ABSC', 20000), ('SUR-CIRC', 25000), ('VAC-DOSE', 0),
  ('BED-HOUR', 800), ('BED-DAY', 8000)
) as v(code, price)
join service s on s.code = v.code
join price_list pl on pl.name = 'RSSB tariff 2026';

-- Pharmacy prices per selling unit (cash list; insurers without their own list fall back here)
insert into price_list_item (price_list_id, item_id, price)
select pl.id, i.id, v.price
from (values
  ('AMOX500', 300), ('PARA500', 50), ('AL20120', 500), ('ORS', 300), ('GLOVE-M', 8000), ('MRDT-KIT', 0), ('CEFTRI1G', 2500)
) as v(code, price)
join item i on i.code = v.code
cross join price_list pl
where pl.payer_id is null;

-- ---------------------------------------------------------------- practitioners (public calendars)
insert into practitioner (code, names, title, specialty, slot_minutes, working_hours, categories, languages) values
  ('mb', 'Dr. Mukamana Béatrice', 'General practitioner', 'general', 60,
    '{"1":[["08:00","17:00"]],"2":[["08:00","17:00"]],"3":[["08:00","17:00"]],"4":[["08:00","17:00"]],"5":[["08:00","17:00"]],"6":[["08:00","17:00"]]}',
    '{consultation}', 'KIN · EN · FR'),
  ('hj', 'Dr. Habyarimana Jean Claude', 'General practitioner · minor surgery', 'general', 60,
    '{"0":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]],"6":[["09:00","18:00"]]}',
    '{consultation,surgery,circ}', 'KIN · FR'),
  ('nf', 'Dr. Ndayisaba Félix', 'Dental officer', 'dental', 60,
    '{"1":[["08:00","16:00"]],"2":[["08:00","16:00"]],"3":[["08:00","16:00"]],"4":[["08:00","16:00"]],"5":[["08:00","16:00"]]}',
    '{dental}', 'KIN · EN · FR'),
  ('ua', 'Dr. Uwera Aline', 'Sonographer', 'imaging', 60,
    '{"1":[["08:00","15:00"]],"3":[["08:00","15:00"]],"5":[["08:00","15:00"]],"6":[["08:00","15:00"]]}',
    '{ultrasound}', 'KIN · EN'),
  ('ms', 'Mukarugwiza Solange', 'Midwife · family planning', 'midwifery', 60,
    '{"1":[["08:00","17:00"]],"2":[["08:00","17:00"]],"3":[["08:00","17:00"]],"4":[["08:00","17:00"]],"5":[["08:00","17:00"]],"6":[["08:00","17:00"]]}',
    '{fp,ultrasound}', 'KIN · FR'),
  ('nc', 'Nyirahabimana Chantal', 'Nurse · vaccination & HIV testing', 'nursing', 60,
    '{"0":[["07:00","19:00"]],"1":[["07:00","19:00"]],"2":[["07:00","19:00"]],"3":[["07:00","19:00"]],"4":[["07:00","19:00"]],"5":[["07:00","19:00"]],"6":[["07:00","19:00"]]}',
    '{nursing,hiv}', 'KIN · EN');

-- ---------------------------------------------------------------- stock, beds, supplier
insert into stock_location (name, type) values
  ('Main store', 'main_store'), ('Pharmacy', 'pharmacy'), ('Nursing', 'nursing'), ('Laboratory', 'lab');
insert into supplier (name, terms) values ('Kigali Pharma Wholesale Ltd', '30 days');
insert into bed (name, sort_order) select 'Bed ' || n, n from generate_series(1, 8) as n;

-- Opening stock: one batch of amoxicillin received into the pharmacy (ledger movement, never an edit)
insert into batch (item_id, batch_no, expiry, unit_cost, supplier_id)
select i.id, 'AMX-2605', date '2027-05-31', 180, s.id from item i, supplier s where i.code = 'AMOX500';
insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
select b.item_id, b.id, l.id, 1000, 'receipt', 'opening stock'
from batch b join stock_location l on l.name = 'Pharmacy' where b.batch_no = 'AMX-2605';

-- ---------------------------------------------------------------- settings and templates
insert into setting (key, value) values
  ('clinic.profile', '{"name":"Muhazi Medical Clinic","tagline":"Quality care, healthy life.","sector":"Kiramuruzi","district":"Gatsibo","province":"Eastern Province","country":"Rwanda","phone":"0799476752","whatsapp":"0799476752","email":"muhazimedicalclinicltd@gmail.com","tin":"","moh_licence":"","fda_licence":""}'),
  -- days keyed by JS weekday (0 = Sunday), clinic local time
  ('clinic.hours', '{"timezone":"Africa/Kigali","days":{"0":["00:00","24:00"],"1":["00:00","24:00"],"2":["00:00","24:00"],"3":["00:00","24:00"],"4":["00:00","24:00"],"5":["00:00","24:00"],"6":["00:00","24:00"]},"lab":["00:00","24:00"]}'),
  ('numbering', '{"patient_file":"MMC-{seq:6}","invoice":"INV-{year}-{seq:6}","inquiry":"MMC-{year}-{seq:4}","claim_batch":"CLM-{payer}-{year}-{month}"}'),
  ('booking', '{"inquiry_hold_hours":24,"max_weeks_ahead":3,"no_show_grace_min":30}'),
  ('compliance', '{"dpo_name":"","ncsa_registration":"","breach_notice_hours":48,"breach_report_hours":72}');

insert into template (key, language, body) values
  ('appointment.confirmed', 'kin', 'Muhazi Medical Clinic: gahunda yawe yemejwe ku wa {{date}} saa {{time}}. Zana indangamuntu n''ikarita y''ubwishingizi.'),
  ('appointment.confirmed', 'en', 'Muhazi Medical Clinic: your appointment is confirmed for {{date}} at {{time}}. Bring your ID and insurance card.'),
  ('appointment.confirmed', 'fr', 'Muhazi Medical Clinic : votre rendez-vous est confirmé le {{date}} à {{time}}. Apportez votre pièce d''identité et votre carte d''assurance.'),
  ('appointment.reminder', 'kin', 'Muhazi Medical Clinic: urakumbuzwa gahunda yawe ejo ku wa {{date}} saa {{time}}.'),
  ('appointment.reminder', 'en', 'Muhazi Medical Clinic: reminder of your appointment tomorrow {{date}} at {{time}}.'),
  ('appointment.reminder', 'fr', 'Muhazi Medical Clinic : rappel de votre rendez-vous demain {{date}} à {{time}}.'),
  ('results.ready', 'kin', 'Muhazi Medical Clinic: ibisubizo byawe byiteguye. Mwaza kubifata cyangwa mukavugana na muganga wanyu.'),
  ('results.ready', 'en', 'Muhazi Medical Clinic: your results are ready. Please come to collect them or speak to your doctor.'),
  ('results.ready', 'fr', 'Muhazi Medical Clinic : vos résultats sont prêts. Passez les retirer ou parlez à votre médecin.');
