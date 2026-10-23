/**
 * Runs every migration and the seed against an in-memory Postgres (PGlite), then walks the
 * patient journey of doc Â§3 / Â§4.5 to prove the business rules work before touching Supabase.
 *
 *   pnpm db:check
 *
 * Supabase-specific pieces (auth schema, roles) are stubbed just enough for the SQL to run.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'supabase', 'migrations')

const STUB = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
-- Supabase grants these to its API roles by default.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;
`

const db = new PGlite()
const results = []
let failures = 0

const step = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ step: name, ok: true, detail: detail ?? '' })
  } catch (e) {
    failures++
    results.push({ step: name, ok: false, detail: String(e.message ?? e).split('\n')[0] })
  }
}
const expectError = async (name, fn, pattern) => {
  await step(name, async () => {
    try {
      await fn()
    } catch (e) {
      if (pattern.test(String(e.message))) return `refused: ${String(e.message).split('\n')[0]}`
      throw e
    }
    throw new Error('expected an error but the statement succeeded')
  })
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const as = async (userId, role = 'authenticated') => {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '${userId ?? ''}', false); set role ${role};`,
  )
}
const asAdmin = async () =>
  db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`)

// ---------------------------------------------------------------- schema
await step('stub Supabase auth schema and roles', async () => {
  await db.exec(STUB)
})
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
for (const f of files) {
  await step(`migration ${f}`, async () => {
    await db.exec(await readFile(path.join(migrationsDir, f), 'utf8'))
  })
}
if (failures) finish()
await step('seed.sql', async () => {
  await db.exec(await readFile(path.join(root, 'supabase', 'seed.sql'), 'utf8'))
  const n = await one('select count(*)::int as n from service')
  return `${n.n} services`
})
await step('table count', async () => {
  const r = await one(`select count(*)::int as n from pg_tables where schemaname = 'public'`)
  return `${r.n} tables`
})
await step(
  'public read surface as anon: service lines, insurers, clinic info, status',
  async () => {
    await as(null, 'anon')
    const lines = await one(`select count(*)::int as n from public_service_lines`)
    const payers = await one(`select count(*)::int as n from public_payers`)
    const info = await one(`select public_clinic_info() as j`)
    const status = await one(`select public_clinic_status() as j`)
    await asAdmin()
    if (lines.n !== 9) throw new Error(`${lines.n} service lines`)
    // insurers are seeded inactive until the clinic signs its first partner
    if (payers.n !== 0) throw new Error(`${payers.n} insurers (expected none active)`)
    if (info.j.profile.phone !== '0799476752') throw new Error('profile phone not seeded')
    if (typeof status.j.open !== 'boolean') throw new Error('status.open missing')
    return `${lines.n} lines Â· ${payers.n} insurers Â· open=${status.j.open}`
  },
)

// ---------------------------------------------------------------- staff accounts via auth trigger
const staff = {}
const mkUser = async (username, full_name, role, extra = {}) => {
  const r = await one(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [`${username}@staff.muhaziclinic.rw`, JSON.stringify({ username, full_name, role, ...extra })],
  )
  staff[role] = r.id
  return r.id
}
await step('auth users â†’ profiles trigger', async () => {
  await mkUser('j.uwimana', 'Uwimana Josiane', 'receptionist')
  await mkUser('c.nyirahabimana', 'Nyirahabimana Chantal', 'nurse', { station: 'Triage' })
  await mkUser('b.mukamana', 'Dr. Mukamana BÃ©atrice', 'doctor', { station: 'Consultation 1' })
  await mkUser('s.mugisha', 'Mugisha Samuel', 'cashier')
  await mkUser('p.kalisa', 'Kalisa Pascal', 'pharmacist')
  await mkUser('u.lab', 'Uwera Diane', 'lab_tech')
  await mkUser('t.mugabo', 'Mugabo ThÃ©ogÃ¨ne', 'manager', { dashboard: 'manager' })
  const r = await one(`select count(*)::int as n, bool_and(active) as active from profiles`)
  return `${r.n} profiles`
})

await step(
  'sign-in logic: record_sign_in stamps, audits and refuses deactivated accounts',
  async () => {
    await as(staff.receptionist)
    const r = await one(`select record_sign_in('test-device') as j`)
    if (r.j.role !== 'receptionist' || r.j.must_change_pin !== true)
      throw new Error(JSON.stringify(r.j))
    await as(staff.manager)
    await db.query(`select set_profile_active($1, false)`, [staff.cashier])
    await as(staff.cashier)
    let refused = false
    try {
      await db.query(`select record_sign_in()`)
    } catch (e) {
      refused = /deactivated/i.test(String(e.message))
    }
    await as(staff.manager)
    await db.query(`select set_profile_active($1, true)`, [staff.cashier])
    const dir = await one(`select count(*)::int as n from staff_directory`)
    await asAdmin()
    const logins = await one(`select count(*)::int as n from audit_event where action = 'login'`)
    if (!refused) throw new Error('deactivated cashier could sign in')
    if (dir.n !== 7) throw new Error(`directory ${dir.n}`)
    if (logins.n < 1) throw new Error('login not audited')
    return `stamped Â· ${logins.n} login event(s) Â· deactivation enforced Â· directory ${dir.n}`
  },
)
await expectError(
  'manager cannot deactivate their own account',
  async () => {
    await as(staff.manager)
    await db.query(`select set_profile_active($1, false)`, [staff.manager])
  },
  /own account/i,
)
await expectError(
  'a receptionist cannot deactivate anyone',
  async () => {
    await as(staff.receptionist)
    await db.query(`select set_profile_active($1, false)`, [staff.nurse])
  },
  /managers only/i,
)
await step('mark_pin_changed clears the first-PIN flag for the caller only', async () => {
  await as(staff.receptionist)
  await db.query(`select mark_pin_changed()`)
  await asAdmin()
  const r = await one(`select must_change_pin from profiles where id = $1`, [staff.receptionist])
  const other = await one(`select must_change_pin from profiles where id = $1`, [staff.nurse])
  if (r.must_change_pin !== false || other.must_change_pin !== true) throw new Error('flags wrong')
})

// ---------------------------------------------------------------- the patient journey (doc Â§3, Â§4.5 worked example)
let patientId, coverageId, encounterId, invoiceId
await step('receptionist registers a patient â†’ hub file number', async () => {
  await as(staff.receptionist)
  const r = await one(
    `insert into patient (surname, given_names, sex, birth_date, phone_1, consent_treatment, consent_messages, consent_insurer)
     values ('Niyonzima', 'Jean Bosco', 'male', '1972-03-14', '0788123456', true, true, true) returning id, file_number`,
  )
  patientId = r.id
  if (r.file_number !== 'MMC-000001') throw new Error(`file number ${r.file_number}`)
  return r.file_number
})
await step('duplicate check finds the same phone', async () => {
  const r = await db.query(
    `select * from find_patient_duplicates(null, '0788123456', null, null, null)`,
  )
  if (r.rows.length !== 1) throw new Error(`${r.rows.length} rows`)
  return 'match on phone'
})
await step('coverage: RSSB RAMA member', async () => {
  const r = await one(
    `insert into coverage (patient_id, payer_id, plan_id, member_number)
     select $1, p.id, pl.id, '1197280012345678' from payer p join plan pl on pl.payer_id = p.id where p.code = 'RAMA'
     returning id`,
    [patientId],
  )
  coverageId = r.id
})
await step('walk-in: open_encounter â†’ ticket + draft invoice', async () => {
  const r = await one(`select open_encounter($1, 'opd', 'triage', $2) as id`, [
    patientId,
    coverageId,
  ])
  encounterId = r.id
  const q = await one(`select ticket_no from queue_entry where encounter_id = $1`, [encounterId])
  const inv = await one(`select id, status from invoice where encounter_id = $1`, [encounterId])
  invoiceId = inv.id
  return `${q.ticket_no}, invoice ${inv.status}`
})
await expectError(
  'receptionist cannot read clinical observations (RLS)',
  async () => {
    await as(staff.receptionist)
    await db.query(
      `insert into observation (encounter_id, code, value_num, unit) values ($1, 'bp_sys', 128, 'mmHg')`,
      [encounterId],
    )
  },
  /row-level security/i,
)
await step('nurse records vitals and triage', async () => {
  await as(staff.nurse)
  await db.query(
    `insert into observation (encounter_id, code, value_num, unit) values ($1, 'bp_sys', 128, 'mmHg')`,
    [encounterId],
  )
  await db.query(
    `update encounter set triage_level = 'yellow', triage_reason = 'fever 3 days' where id = $1`,
    [encounterId],
  ) // the nurse sends the patient on to the doctors
  await db.query(`select finish_station($1, 'triage', 'consultation')`, [encounterId])
})
await step('doctor charges consultation (RSSB preset 5,000)', async () => {
  await as(staff.doctor)
  await db.query(
    `select add_charge($1, 'consultation', (select id from service where code = 'CONS-GEN'))`,
    [encounterId],
  )
})
await step('doctor orders lab (preset 2,000 + 4,000)', async () => {
  // 0059: ordered tests are charged by the order itself; this journey only needs the two lines
  await asAdmin()
  await db.query(
    `select add_charge_internal($1, 'laboratory', (select id from service where code = 'LAB-MRDT'))`,
    [encounterId],
  )
  await db.query(
    `select add_charge_internal($1, 'laboratory', (select id from service where code = 'LAB-FBC'))`,
    [encounterId],
  )
  await as(staff.doctor)
})
await step('doctor records the primary diagnosis', async () => {
  await db.query(
    `insert into condition (encounter_id, icd10_code, text, type) values ($1, 'B54', 'Malaria', 'primary')`,
    [encounterId],
  )
})
await expectError(
  'typed price without a reason is refused',
  async () => {
    // the doctor also sends the patient to Nursing (injection) and Pharmacy
    await asAdmin()
    await db.query(
      `insert into queue_entry (encounter_id, station, ticket_no)
       select $1, s, 'A-001' from unnest(array['nursing', 'pharmacy']::station[]) s`,
      [encounterId],
    )
    await as(staff.nurse)
    await db.query(
      `select add_charge($1, 'nursing', (select id from service where code = 'NUR-INJ'), null, 1, 1000)`,
      [encounterId],
    )
  },
  /reason is required/i,
)
await step('nurse types the injection price with a reason (1,000)', async () => {
  await db.query(
    `select add_charge($1, 'nursing', (select id from service where code = 'NUR-INJ'), null, 1, 1000, 'standard injection fee')`,
    [encounterId],
  )
})
await step('pharmacist dispenses FEFO 21 Ã— amoxicillin and charges 6,300', async () => {
  await as(staff.pharmacist)
  const loc = await one(`select id from stock_location where name = 'Pharmacy'`)
  const item = await one(`select id from item where code = 'AMOX500'`)
  await db.query(`select dispense_fefo($1, $2, 21, $3)`, [encounterId, item.id, loc.id])
  await db.query(`select add_charge($1, 'pharmacy', null, $2, 21)`, [encounterId, item.id])
  const soh = await one(`select quantity from stock_on_hand where item_id = $1`, [item.id])
  if (soh.quantity !== 979) throw new Error(`stock on hand ${soh.quantity}`)
  return `stock on hand 979`
})
await step('running bill = 18,300 split 2,745 / 15,555 at 85 %', async () => {
  await asAdmin()
  const r = await one(`select total, patient_share, insurer_share from invoice where id = $1`, [
    invoiceId,
  ])
  const got = `${r.total} / ${r.patient_share} / ${r.insurer_share}`
  if (got !== '18300 / 2745 / 15555') throw new Error(got)
  return got
})
await expectError(
  'a nurse (no billing.write, no payment.take) cannot post an invoice',
  async () => {
    await as(staff.nurse)
    await db.query(`select post_invoice($1)`, [invoiceId])
  },
  /not allowed/i,
)
await expectError(
  'card payments are refused (cash, MTN MoMo and Airtel Money only)',
  async () => {
    await as(staff.cashier)
    await db.query(`select record_payment($1, 'card', 100, 'CARD-1', null)`, [invoiceId])
  },
  /payment_method_accepted/i,
)
await step(
  'cashier records MoMo 2,745 with reference and posts â†’ INV number + claim',
  async () => {
    await as(staff.cashier)
    await db.query(
      `select record_payment($1, 'momo', 2745, 'MP251015.1234.A12345', '0788123456')`,
      [invoiceId],
    )
    const n = await one(`select post_invoice($1) as number`, [invoiceId])
    const bal = await one(`select invoice_balance($1) as balance`, [invoiceId])
    await asAdmin()
    const claim = await one(`select status, amount from claim where invoice_id = $1`, [invoiceId])
    if (Number(bal.balance) !== 0) throw new Error(`balance ${bal.balance}`)
    return `${n.number}, balance 0, claim ${claim.status} ${claim.amount}`
  },
)
await expectError(
  'posted invoice is immutable',
  async () => {
    await asAdmin()
    await db.query(`update invoice set total = 1 where id = $1`, [invoiceId])
  },
  /immutable/i,
)
await expectError(
  'lines of a posted invoice cannot change',
  async () => db.query(`delete from invoice_line where invoice_id = $1`, [invoiceId]),
  /posted invoice/i,
)
await step('doctor closes the visit (primary diagnosis present)', async () => {
  await as(staff.doctor)
  await db.query(`select close_encounter($1)`, [encounterId])
})
await step('manager creates the monthly RSSB claim batch', async () => {
  await as(staff.manager)
  const r = await one(
    `select create_claim_batch((select id from payer where code = 'RAMA'), date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date) as id`,
  )
  const b = await one(`select number, total_claimed from claim_batch where id = $1`, [r.id])
  return `${b.number} Â· ${b.total_claimed}`
})
await step('audit log has entries for every write', async () => {
  await asAdmin()
  const r = await one(
    `select count(*)::int as n, count(distinct entity)::int as entities from audit_event`,
  )
  if (r.n < 20) throw new Error(`${r.n} events`)
  return `${r.n} events across ${r.entities} entities`
})

// ---------------------------------------------------------------- public booking (anonymous)
const nextMondayTen = () => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(8, 0, 0, 0) // 10:00 Africa/Kigali (UTC+2)
  return d.toISOString()
}
const slot = nextMondayTen()
let appointmentId
// The site books real accounts with a public calendar only (0066): the sample dentist gets an
// account so the public booking can be tried.
await asAdmin()
const dentist = (
  await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [
    'f.ndayisaba@staff.muhaziclinic.rw',
    JSON.stringify({
      username: 'f.ndayisaba',
      full_name: 'Dr. Ndayisaba Felix',
      role: 'doctor',
      station: 'Dental',
    }),
  ])
).id
await db.query(`update practitioner set user_id = $1 where code = 'nf'`, [dentist])
await step('anonymous inquiry for Dr. Ndayisaba next Monday 10:00 â†’ reference', async () => {
  await as(null, 'anon')
  const r = await one(
    `select create_appointment_inquiry('nf', $1::timestamptz, 'Uwase Claudine', '0788 000 111', 'RSSB RAMA', 'consultation', null, 'whatsapp') as ref`,
    [slot],
  )
  if (!/^MMC-\d{4}-\d{4}$/.test(r.ref)) throw new Error(r.ref)
  await asAdmin()
  const a = await one(`select id from appointment where reference = $1`, [r.ref])
  appointmentId = a.id
  return r.ref
})
await expectError(
  'anonymous cannot read appointments directly',
  async () => {
    await as(null, 'anon')
    await db.query(`select * from appointment`)
  },
  /permission denied/i,
)
// a request does not hold its time (0068): another person may ask for it too
await step('a request leaves the time free; a second request for it is accepted', async () => {
  const r = await one(
    `select count(*)::int as n from public_booked_slots where starts_at = $1::timestamptz`,
    [slot],
  )
  if (r.n !== 0) throw new Error(`${r.n} rows`)
  const second = await one(
    `select create_appointment_inquiry('nf', $1::timestamptz, 'Other Person', '0788 000 222', null, null, null, 'sms') as ref`,
    [slot],
  )
  return `still free; second request ${second.ref}`
})
await expectError(
  'inquiry outside working hours is refused',
  async () =>
    db.query(
      `select create_appointment_inquiry('nf', ($1::timestamptz + interval '6 days'), 'Sunday Person', '0788 000 333', null, null, null, 'sms')`,
      [slot],
    ),
  /does not work at that time/i,
)
await step('receptionist approves, doctor accepts â†’ confirmed', async () => {
  await as(staff.receptionist)
  await db.query(`select approve_inquiry($1, $2)`, [appointmentId, patientId])
  await as(dentist)
  await db.query(`select accept_appointment($1)`, [appointmentId])
  await asAdmin()
  const a = await one(`select status from appointment where id = $1`, [appointmentId])
  if (a.status !== 'confirmed') throw new Error(a.status)
  return 'confirmed'
})
// ---------------------------------------------------------------- 0039: website request → reception books a doctor → doctor answers
let homeInquiryId
await step(
  'website request with a preferred time (no doctor); reception sees the file match',
  async () => {
    await as(null, 'anon')
    const r = await one(
      `select create_appointment_inquiry(null, null, 'Nadia Uwase', '0788 000 111', null, null, 'Needs consultation', 'whatsapp', $1::timestamptz) as ref`,
      [slot],
    )
    await as(staff.receptionist)
    const open = (await one(`select inquiries_open() as j`)).j
    const q = open.find((x) => x.reference === r.ref)
    await asAdmin()
    if (!q || !q.preferredAt || q.doctor) throw new Error('not listed as a free request')
    homeInquiryId = q.id
    return `${r.ref} prefers ${q.preferredAt.slice(0, 16)}; phone matches ${q.matches} file(s)`
  },
)
await expectError(
  'a request cannot be approved without a doctor and a time',
  async () => {
    await as(staff.receptionist)
    await db.query(`select approve_inquiry($1, $2)`, [homeInquiryId, patientId])
  },
  /choose the doctor/,
)
await step(
  'reception books it with a doctor who has no calendar yet; doctor accepts; reception is told',
  async () => {
    await as(staff.receptionist)
    const docs = (await one(`select bookable_doctors() as j`)).j
    if (!docs.some((d) => d.userId === staff.doctor)) throw new Error('doctor not bookable')
    await db.query(
      `select approve_inquiry_auto($1, $2, $3, ($4::timestamptz + interval '1 day'))`,
      [homeInquiryId, patientId, staff.doctor, slot],
    )
    await asAdmin()
    const a = await one(
      `select a.status, pr.user_id from appointment a join practitioner pr on pr.id = a.practitioner_id where a.id = $1`,
      [homeInquiryId],
    )
    if (a.status !== 'approved' || a.user_id !== staff.doctor)
      throw new Error('not booked with the doctor')
    await as(staff.doctor)
    const mine = (await one(`select home_summary() as j`)).j
    if (!mine.toAccept.some((x) => x.id === homeInquiryId))
      throw new Error('doctor does not see it to accept')
    await db.query(`select accept_appointment($1)`, [homeInquiryId])
    await as(staff.receptionist)
    const notes = (await one(`select my_notifications(50) as j`)).j
    await asAdmin()
    const told = (notes.items ?? notes).some((n) => n.kind === 'appt_confirmed')
    if (!told) throw new Error('reception not told')
    return 'approved with the doctor → confirmed → reception notified'
  },
)
await step('nurse may write but manager may not read HIV tests (sensitive)', async () => {
  await as(staff.nurse)
  await db.query(
    `insert into hiv_test (encounter_id, patient_id, result) values ($1, $2, 'negative')`,
    [encounterId, patientId],
  )
  await as(staff.manager)
  const r = await one(`select count(*)::int as n from hiv_test`)
  if (r.n !== 0) throw new Error(`manager saw ${r.n} rows`)
  return 'manager sees 0 rows'
})

// ---------------------------------------------------------------- catalogue operations (0018)
await step('manager saves lock time and patient fields; staff read lock time', async () => {
  await as(staff.manager)
  await db.query(`select save_setting('security.lock', '{"idle_minutes": 30}'::jsonb)`)
  await db.query(
    `select save_setting('patient.fields', '[{"key":"kin","label":"Next of kin","type":"text"}]'::jsonb)`,
  )
  await as(staff.nurse)
  const r = await one(`select staff_settings() ->> 'idle_minutes' as m`)
  if (r.m !== '30') throw new Error(r.m)
  return 'idle 30 min'
})
await expectError(
  'nurse may not change the lock time',
  async () => {
    await as(staff.nurse)
    await db.query(`select save_setting('security.lock', '{"idle_minutes": 240}'::jsonb)`)
  },
  /not allowed/i,
)
await step('manager adjusts prices Ã—1.1, then deletes a treatment', async () => {
  await as(staff.manager)
  const id = (await one(`select upsert_service(null, 'Check test', 'consultation', 1000) as id`)).id
  const n = (await one(`select adjust_prices('consultation', 'multiply', 1.1, 100) as n`)).n
  const p = await one(`select cash_price from catalogue_services where id = $1`, [id])
  if (Number(p.cash_price) !== 1100) throw new Error(`price ${p.cash_price}`)
  await db.query(`select delete_service($1)`, [id])
  const gone = await one(`select count(*)::int as n from catalogue_services where id = $1`, [id])
  if (gone.n !== 0) throw new Error('still listed')
  return `${n} prices changed, deleted`
})
await step('manager deletes an insurer', async () => {
  await as(staff.manager)
  const id = (await one(`select upsert_payer(null, 'Test Insurer', 'private', 80) as id`)).id
  await db.query(`select delete_payer($1)`, [id])
  const gone = await one(`select count(*)::int as n from insurer_plans where id = $1`, [id])
  if (gone.n !== 0) throw new Error('still listed')
  return 'deleted'
})

// ---------------------------------------------------------------- vitals on behalf (0020)
let paperVisit = null
await step('receptionist types the nurseâ€™s paper vitals; patient moves on', async () => {
  await as(staff.receptionist)
  paperVisit = (await one(`select open_encounter($1, 'opd', 'triage', null) as id`, [patientId])).id
  await db.query(
    `select record_vitals($1, '{"bp_sys":"130","temp":"37.9"}'::jsonb, 'yellow', 'consultation', null, $2, now() - interval '20 minutes')`,
    [paperVisit, staff.nurse],
  )
  await asAdmin()
  const o = await one(
    `select count(*)::int as n, bool_and(performer_id = $2) as by_nurse, bool_and(created_by = $3) as typed_by_rec
     from observation where encounter_id = $1`,
    [paperVisit, staff.nurse, staff.receptionist],
  )
  const q = await one(
    `select station from queue_entry where encounter_id = $1 and finished_at is null`,
    [paperVisit],
  )
  if (o.n !== 2 || !o.by_nurse || !o.typed_by_rec) throw new Error(JSON.stringify(o))
  if (q.station !== 'consultation') throw new Error(q.station)
  return 'measured by nurse, typed by receptionist, now at consultation'
})
await step('receptionist sees the vitals (not the clinical notes) of the visit', async () => {
  await as(staff.receptionist)
  const v = await one(`select count(*)::int as n from visit_vitals where encounter_id = $1`, [
    paperVisit,
  ])
  if (v.n < 2) throw new Error(`sees ${v.n} vitals`)
  const notes = await one(`select count(*)::int as n from observation where encounter_id = $1`, [
    paperVisit,
  ])
  if (notes.n !== 0) throw new Error('reads raw observations')
  return `${v.n} vitals visible, raw clinical rows hidden`
})
await expectError(
  'receptionist must name who measured',
  async () => {
    await as(staff.receptionist)
    await db.query(`select record_vitals($1, '{"pulse":"80"}'::jsonb)`, [paperVisit])
  },
  /choose the nurse/i,
)
await step('doctor adds later vitals without moving the patient', async () => {
  await as(staff.doctor)
  await db.query(`select record_vitals($1, '{"weight":"64"}'::jsonb)`, [paperVisit])
  await asAdmin()
  const q = await one(
    `select count(*)::int as n from queue_entry where encounter_id = $1 and finished_at is null`,
    [paperVisit],
  )
  if (q.n !== 1) throw new Error(`${q.n} open queue entries`)
  return 'still one open queue entry'
})

// ---------------------------------------------------------------- linked desk operations (0022)
await step('reception marks a booked patient arrived â†’ linked to a visit', async () => {
  await as(staff.receptionist)
  const day = await one(
    `select appointments_day((select (starts_at at time zone 'Africa/Kigali')::date from appointment where id = $1)) as d`,
    [appointmentId],
  )
  if (!day.d.some((a) => a.id === appointmentId)) throw new Error('not in the day list')
  const v = await one(`select appointment_arrived($1) as v`, [appointmentId])
  await asAdmin()
  const q = await one(
    `select station from queue_entry where encounter_id = ($1::jsonb ->> 'encounter_id')::uuid and finished_at is null`,
    [JSON.stringify(v.v)],
  )
  const a = await one(`select status from appointment where id = $1`, [appointmentId])
  if (!q || a.status !== 'arrived') throw new Error(`${q?.station} ${a.status}`)
  return v.v.existing
    ? `arrived, kept the open visit (at ${q.station})`
    : `arrived, queued at ${q.station}`
})
await step('doctor leaves the nurse a task; nurse sees and completes it', async () => {
  await as(staff.doctor)
  const id = (
    await one(
      `select create_task($1, 'Injection: ceftriaxone 1 g IM', now() + interval '1 hour') as id`,
      [paperVisit],
    )
  ).id
  await as(staff.nurse)
  const list = (await one(`select open_tasks() as t`)).t
  if (!list.some((x) => x.id === id)) throw new Error('nurse does not see the task')
  await db.query(`select complete_task($1)`, [id])
  const after = (await one(`select open_tasks() as t`)).t
  if (after.some((x) => x.id === id)) throw new Error('still open')
  return 'created, seen, done'
})
await step('nurse admits to a bed, discharges, marks it ready', async () => {
  await asAdmin()
  let bed = await one(`select id from bed where status = 'free' and deleted_at is null limit 1`)
  if (!bed)
    bed = await one(`insert into bed (name, sort_order) values ('Check bed', 99) returning id`)
  await as(staff.nurse)
  await db.query(`select admit_to_bed($1, $2)`, [paperVisit, bed.id])
  const board = (await one(`select bed_board() as b`)).b
  if (board.find((b) => b.id === bed.id)?.state !== 'occupied') throw new Error('not occupied')
  await db.query(`select discharge_bed($1)`, [bed.id])
  await db.query(`select bed_ready($1)`, [bed.id])
  await asAdmin()
  const s = await one(`select status from bed where id = $1`, [bed.id])
  if (s.status !== 'free') throw new Error(s.status)
  return 'occupied â†’ cleaning â†’ free'
})
await expectError(
  'only the manager sets the number of beds (0028)',
  async () => {
    await as(staff.nurse)
    await db.query(`select set_bed_count(3, 5000)`)
  },
  /only the manager/i,
)
await step('manager sets 6 beds at 15,000 a night; a 2-night stay bills 30,000', async () => {
  await as(staff.manager)
  const r = (await one(`select set_bed_count(6, 15000) as r`)).r
  if (r.beds !== 6) throw new Error(`beds ${r.beds}`)
  await as(staff.nurse)
  const bed = (await one(`select bed_board() as b`)).b.find((b) => b.state === 'free')
  if (bed.nightlyPrice !== 15000) throw new Error(`price ${bed.nightlyPrice}`)
  const a = (await one(`select admit_to_bed($1, $2, 2) as a`, [paperVisit, bed.id])).a
  if (Number(a.total) !== 30000) throw new Error(`total ${a.total}`)
  await asAdmin()
  const line = await one(
    `select l.description, l.unit_price from invoice_line l join invoice i on i.id = l.invoice_id
     where i.encounter_id = $1 and l.source_type = 'bed_stay' order by l.created_at desc limit 1`,
    [paperVisit],
  )
  if (Number(line.unit_price) !== 30000) throw new Error(`line ${line.unit_price}`)
  await as(staff.nurse)
  const x = (await one(`select extend_bed_stay($1, 3, 40000) as x`, [bed.id])).x
  if (Number(x.total) !== 40000) throw new Error(`extend ${x.total}`)
  await as(staff.manager)
  let refused = false
  try {
    await db.query(`select remove_bed($1)`, [bed.id])
  } catch {
    refused = true
  }
  if (!refused) throw new Error('removed an occupied bed')
  await as(staff.nurse)
  await db.query(`select discharge_bed($1)`, [bed.id])
  await db.query(`select bed_ready($1)`, [bed.id])
  return `${line.description} = 30,000; +3 nights agreed 40,000; occupied bed kept`
})

// ---------------------------------------------------------------- nurse registers, reception completes (0023)
await step('nurse registers with name/sex/age only â†’ reception sees it to complete', async () => {
  await as(staff.nurse)
  const v = await one(`select register_patient('Quick', 'Nurse Entry', 'female', null, 30) as v`)
  const pid = v.v.patient_id
  await as(staff.receptionist)
  const list = (await one(`select files_to_complete() as l`)).l
  const row = list.find((r) => r.patientId === pid)
  if (!row) throw new Error('not listed')
  const missing = row.missing.join(',')
  await db.query(
    `select update_patient($1, '{"phone_1":"0788000111","national_id":"1199680012345678","sector":"Kiramuruzi"}'::jsonb)`,
    [pid],
  )
  const after = (await one(`select files_to_complete() as l`)).l
  if (after.some((r) => r.patientId === pid)) throw new Error('still listed after completing')
  return `missing ${missing} â†’ completed by reception`
})

// ---------------------------------------------------------------- trusted devices (0025)
await step('a trusted device skips the code; revoked or foreign keys do not', async () => {
  const key = 'k'.repeat(40)
  await as(staff.nurse)
  const until = (await one(`select trust_this_device($1, 'test browser') as u`, [key])).u
  if (!until) throw new Error('not trusted')
  if (!(await one(`select use_trusted_device($1) as ok`, [key])).ok)
    throw new Error('own key refused')
  await as(staff.receptionist)
  if ((await one(`select use_trusted_device($1) as ok`, [key])).ok)
    throw new Error('foreign key accepted')
  await as(staff.manager)
  await db.query(`select revoke_trusted_devices(true)`)
  await as(staff.nurse)
  if ((await one(`select use_trusted_device($1) as ok`, [key])).ok)
    throw new Error('revoked key accepted')
  return 'trusted â†’ used â†’ revoked'
})
await step('trust_days 0 means a code at every sign-in', async () => {
  await as(staff.manager)
  await db.query(`select save_setting('security.otp', '{"trust_days": 0}'::jsonb)`)
  await as(staff.nurse)
  const u = (await one(`select trust_this_device($1) as u`, ['z'.repeat(40)])).u
  await as(staff.manager)
  await db.query(`select save_setting('security.otp', '{"trust_days": 30}'::jsonb)`)
  if (u) throw new Error('trusted although disabled')
  return 'no trust when 0'
})

// ---------------------------------------------------------------- departments + notifications (0026)
let deptId = null
await step('manager creates a department; staff can read it; nurse cannot create', async () => {
  await as(staff.manager)
  deptId = (
    await one(`select upsert_department(null, 'Nursing care', 'Triage and wards', '{nurse}') as id`)
  ).id
  await asAdmin()
  await db.query(`update profiles set department_id = $1, position = 'head' where id = $2`, [
    deptId,
    staff.nurse,
  ])
  await as(staff.receptionist)
  const d = await one(`select count(*)::int as n from department where id = $1`, [deptId])
  if (d.n !== 1) throw new Error('not readable')
  return 'created and readable'
})
await expectError(
  'nurse may not create a department',
  async () => {
    await as(staff.nurse)
    await db.query(`select upsert_department(null, 'Shadow', null, '{nurse}')`)
  },
  /not allowed/i,
)
await step('queue arrival notifies the station role; read state is per person', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'triage', null) as id`, [patientId])
  await as(staff.nurse)
  const n = (await one(`select my_notifications(50) as n`)).n
  const item = n.items.find((x) => x.kind === 'queue' && x.link?.includes(v.id))
  if (!item) throw new Error('nurse not notified')
  await db.query(`select mark_notifications_read(array[$1::uuid])`, [item.id])
  const after = (await one(`select my_notifications(50) as n`)).n
  if (after.items.find((x) => x.id === item.id)?.read !== true) throw new Error('not marked read')
  await as(staff.cashier)
  const c = (await one(`select my_notifications(50) as n`)).n
  if (c.items.some((x) => x.id === item.id)) throw new Error('cashier sees a triage notification')
  return 'nurse notified, cashier not'
})
await step('manager message to department heads reaches the head only', async () => {
  await as(staff.manager)
  await db.query(
    `select send_notification('department', $1, 'Staff meeting 16:00', 'Bring the week report', true)`,
    [deptId],
  )
  await as(staff.nurse)
  const n = (await one(`select my_notifications(50) as n`)).n
  if (!n.items.some((x) => x.title === 'Staff meeting 16:00')) throw new Error('head not reached')
  await as(staff.doctor)
  const d = (await one(`select my_notifications(50) as n`)).n
  if (d.items.some((x) => x.title === 'Staff meeting 16:00'))
    throw new Error('reached a non-member')
  return 'head reached, others not'
})
await expectError(
  'a receptionist may not broadcast messages',
  async () => {
    await as(staff.receptionist)
    await db.query(`select send_notification('all', null, 'Hello all', null)`)
  },
  /only the manager/i,
)

// ---------------------------------------------------------------- desk dashboards (0019)
await step('nurse and receptionist read desk_summary', async () => {
  await as(staff.nurse)
  const n = await one(`select desk_summary() as d`)
  await as(staff.receptionist)
  const r = await one(`select desk_summary() as d`)
  const d = r.d
  if (d.tiles == null || !Array.isArray(d.arrivals) || d.mine == null) throw new Error('shape')
  return `visits today ${d.tiles.visitsToday}, vitals ${n.d.tiles.vitalsToday}`
})
await expectError(
  'anonymous visitors may not read desk_summary',
  async () => {
    await as(null, 'anon')
    await db.query(`select desk_summary()`)
  },
  /permission denied|not allowed/i,
)

// ---------------------------------------------------------------- 0029: no ID, first free doctor, notices
await step('adult without ID is flagged until the file says why there is none', async () => {
  await as(staff.receptionist)
  const v = await one(`select register_patient('Noid', 'Adult Person', 'male', null, 30) as v`)
  const pid = v.v.patient_id
  await asAdmin()
  const before = await one(`select patient_missing(p) as m from patient p where id = $1`, [pid])
  if (!before.m.includes('national_id')) throw new Error('not flagged')
  await as(staff.receptionist)
  await db.query(`select set_no_national_id($1, 'not_issued')`, [pid])
  await asAdmin()
  const after = await one(`select patient_missing(p) as m from patient p where id = $1`, [pid])
  if (after.m.includes('national_id')) throw new Error('still flagged')
  return 'flagged â†’ "not issued yet" â†’ not flagged'
})
await step('sent to two doctor desks; the first doctor who takes removes the other', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'reception', null) as id`, [patientId])
  await db.query(
    `select send_to_stations($1, 'reception', array['consultation','dental']::station[])`,
    [v.id],
  )
  await asAdmin()
  const rows = await db.query(
    `select id, station from queue_entry where encounter_id = $1 and finished_at is null and pool_id is not null`,
    [v.id],
  )
  if (rows.rows.length !== 2) throw new Error(`pooled ${rows.rows.length}`)
  const cons = rows.rows.find((r) => r.station === 'consultation')
  const dent = rows.rows.find((r) => r.station === 'dental')
  await as(staff.doctor)
  await db.query(`select take_patient($1)`, [cons.id])
  let refused = ''
  try {
    await db.query(`select take_patient($1)`, [dent.id])
  } catch (e) {
    refused = e.message
  }
  if (!/already taken/i.test(refused)) throw new Error('second desk could still take: ' + refused)
  await asAdmin()
  const open = await db.query(
    `select station from queue_entry where encounter_id = $1 and finished_at is null`,
    [v.id],
  )
  if (open.rows.length !== 1 || open.rows[0].station !== 'consultation')
    throw new Error('pool left open')
  return `taken at consultation; dental refused (${refused})`
})
await step('a person hides a notice from their list; the sender sees it was read', async () => {
  await as(staff.manager)
  await db.query(`select send_notification('role', 'nurse', 'Check oxygen', null)`)
  await as(staff.nurse)
  let n = (await one(`select my_notifications(100) as n`)).n
  const item = n.items.find((x) => x.title === 'Check oxygen')
  if (!item) throw new Error('not received')
  await db.query(`select hide_notifications(array[$1::uuid])`, [item.id])
  n = (await one(`select my_notifications(100) as n`)).n
  if (n.items.some((x) => x.id === item.id)) throw new Error('still listed')
  await as(staff.manager)
  const sent = (await one(`select my_sent_notifications(50) as s`)).s
  const mine = sent.find((x) => x.id === item.id)
  if (!mine || mine.readBy < 1) throw new Error('sent list / read count')
  await db.query(`select delete_notification($1)`, [item.id])
  return `hidden for the nurse; read by ${mine.readBy}; deleted by the sender`
})
await step('a patient waiting since yesterday still counts (0030)', async () => {
  await asAdmin()
  const q = await one(
    `select q.id, q.station from queue_entry q join encounter e on e.id = q.encounter_id
     where q.finished_at is null and q.deleted_at is null and e.status = 'open' limit 1`,
  )
  await db.query(`update queue_entry set created_at = now() - interval '1 day' where id = $1`, [
    q.id,
  ])
  const status = (await one(`select public_clinic_status() as s`)).s
  await as(staff.receptionist)
  const desk = (await one(`select desk_summary() as d`)).d
  await asAdmin()
  await db.query(`update queue_entry set created_at = now() where id = $1`, [q.id])
  const tile = desk.stations.find((s) => s.station === q.station)
  if (!status.waiting) throw new Error('public waiting is 0')
  if (!tile || tile.waiting + tile.busy < 1) throw new Error(`station ${q.station} missing`)
  return `waiting ${status.waiting}; ${q.station} tile ${tile.waiting} waiting`
})
// ---------------------------------------------------------------- 0031
await step('shared patient â†’ one notice per role, gone once a doctor takes them', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'reception', null) as id`, [patientId])
  await db.query(
    `select send_to_stations($1, 'reception', array['consultation','dental','theatre']::station[])`,
    [v.id],
  )
  await as(staff.doctor)
  let n = (await one(`select my_notifications(200) as n`)).n
  const mine = n.items.filter((x) => x.link?.includes(v.id))
  if (mine.length !== 1 || mine[0].kind !== 'queue_pool') throw new Error(`notices ${mine.length}`)
  await asAdmin()
  const q = await one(
    `select id from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
    [v.id],
  )
  await as(staff.doctor)
  await db.query(`select take_patient($1)`, [q.id])
  n = (await one(`select my_notifications(200) as n`)).n
  if (n.items.some((x) => x.link?.includes(v.id))) throw new Error('notice still listed')
  return '1 notice for 3 desks; removed after Take'
})
await step('temporary PIN readable by the manager only, deleted when the PIN changes', async () => {
  await asAdmin()
  await db.query(
    `insert into staff_temp_pin (user_id, pin) values ($1, '482915')
     on conflict (user_id) do update set pin = excluded.pin`,
    [staff.nurse],
  )
  await as(staff.manager)
  const m = await db.query(`select pin from staff_temp_pin where user_id = $1`, [staff.nurse])
  await as(staff.receptionist)
  const r = await db.query(`select pin from staff_temp_pin`)
  await as(staff.nurse)
  await db.query(`select mark_pin_changed()`)
  await asAdmin()
  const left = await db.query(`select 1 from staff_temp_pin where user_id = $1`, [staff.nurse])
  if (m.rows.length !== 1) throw new Error('manager cannot read')
  if (r.rows.length !== 0) throw new Error('receptionist can read')
  if (left.rows.length !== 0) throw new Error('not deleted')
  return 'manager reads, receptionist not, gone after change'
})
await step(
  'history: manager sees all, a nurse only her own; preferences follow the person',
  async () => {
    await as(staff.manager)
    const h = (await one(`select activity_history(null, null, null, null, 50, 0) as h`)).h
    if (!(h.total > 0) || !h.items[0].actor) throw new Error(`history ${h.total}`)
    const groups = new Set(h.items.map((x) => x.group))
    await as(staff.nurse)
    await db.query(`select save_my_prefs('{"textSize":"xlarge","theme":"dim"}'::jsonb)`)
    const p = (await one(`select my_prefs() as p`)).p
    if (p.textSize !== 'xlarge') throw new Error('prefs')
    // 0033: a nurse sees her own activity only, even when asking for someone else's.
    const own = (
      await one(`select activity_history(null, null, $1, null, 200, 0) as h`, [staff.manager])
    ).h
    await asAdmin()
    const nurseName = (await one(`select full_name from profiles where id = $1`, [staff.nurse]))
      .full_name
    if (own.items.some((x) => x.actor !== nurseName)) throw new Error('nurse saw others')
    return `${h.total} events (${[...groups].join(', ')}); nurse sees own ${own.total}; prefs saved`
  },
)

// ---------------------------------------------------------------- 0034 referrals
await step('doctor refers to another desk with "come back to me"; it is sent back', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
  await as(staff.doctor)
  await db.query(
    `select refer_patient($1, 'consultation', 'pharmacy', null, 'Check stock of amoxicillin', true)`,
    [v.id],
  )
  await as(staff.pharmacist)
  const n = (await one(`select my_notifications(200) as n`)).n
  const notice = n.items.find((x) => x.kind === 'referral' && x.link?.includes(v.id))
  if (!notice || notice.params.note !== 'Check stock of amoxicillin')
    throw new Error('not told why')
  const route = (await one(`select visit_routing($1) as r`, [v.id])).r
  const here = route.find((r) => r.station === 'pharmacy')
  if (!here || here.returnTo !== staff.doctor || here.returnStation !== 'consultation')
    throw new Error('no way back')
  await db.query(
    `select refer_patient($1, 'pharmacy', 'consultation', $2, 'Stock checked', false)`,
    [v.id, staff.doctor],
  )
  await as(staff.doctor)
  const d = (await one(`select my_notifications(200) as n`)).n
  if (!d.items.some((x) => x.kind === 'referral' && x.params.note === 'Stock checked'))
    throw new Error('doctor not told it came back')
  await as(staff.pharmacist)
  const left = (await one(`select my_notifications(200) as n`)).n
  if (left.items.some((x) => x.id === notice.id)) throw new Error('old notice not cleared')
  return 'consultation â†’ pharmacy (why + way back) â†’ back to the same doctor'
})

// ---------------------------------------------------------------- 0035 results, room medicines, cover
await step('lab result: recorded by the lab, doctor told, listed in the patient file', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
  await asAdmin()
  const svc = await one(`select id from service where service_group = 'lab' and active limit 1`)
  await as(staff.doctor)
  const req = (await one(`select order_test($1, $2, 'fever') as id`, [v.id, svc.id])).id
  await as(staff.lab_tech)
  await db.query(`select record_result($1, 'Plasmodium seen', 'Malaria positive', true)`, [req])
  await as(staff.doctor)
  const n = (await one(`select my_notifications(200) as n`)).n
  if (!n.items.some((x) => x.kind === 'result' && x.params.impression === 'Malaria positive'))
    throw new Error('doctor not told')
  const r = (await one(`select patient_results($1) as r`, [patientId])).r
  const mine = r.find((x) => x.id === req)
  if (!mine || !mine.verified || mine.impression !== 'Malaria positive')
    throw new Error('not in file')
  return `${mine.test}: ${mine.impression} (verified by ${mine.resultBy})`
})
await step('medicine given in the room: recorded as given, no pharmacy queue', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
  await asAdmin()
  const item = await one(`select id from item where active limit 1`)
  await as(staff.doctor)
  const r = (
    await one(
      `select prescribe($1, $2, 2, '1 tab', 'oral', 'BD', 1, null, 'room', 'consultation') as r`,
      [v.id, item.id],
    )
  ).r
  await asAdmin()
  const m = await one(`select supply, given_at from medication_request where id = $1`, [r.id])
  const q = await db.query(
    `select 1 from queue_entry where encounter_id = $1 and station = 'pharmacy' and finished_at is null`,
    [v.id],
  )
  if (m.supply !== 'room' || !m.given_at) throw new Error('not recorded as given')
  if (q.rows.length) throw new Error('sent to the pharmacy anyway')
  return `given in the room; charged: ${r.charged}`
})
await step(
  'nurse covers for the doctor: gets his rights and patients, loses them after',
  async () => {
    const can = async () => (await one(`select has_perm('orders.write') as ok`)).ok
    await as(staff.nurse)
    const before = await can()
    await as(staff.doctor)
    const cover = (
      await one(`select start_cover($1, now() + interval '4 hours', 'Theatre all day') as id`, [
        staff.nurse,
      ])
    ).id
    await as(staff.nurse)
    const during = await can()
    const mine = (await one(`select my_cover() as c`)).c
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'reception', null) as id`, [patientId])
    await db.query(
      `select refer_patient($1, 'reception', 'consultation', $2, 'for the doctor', false)`,
      [v.id, staff.doctor],
    )
    await asAdmin()
    const q = await one(
      `select assigned_to from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [v.id],
    )
    await as(staff.nurse)
    const nurseDuring = (await one(`select may_work_on($1) as ok`, [v.id])).ok
    await as(staff.doctor)
    await db.query(`select end_cover($1)`, [cover])
    await as(staff.nurse)
    const after = await can()
    const nurseAfter = (await one(`select may_work_on($1) as ok`, [v.id])).ok
    if (before || !during || after) throw new Error(`rights ${before}/${during}/${after}`)
    // 0057: the patient stays the doctor's; the covering nurse may work on it only during the cover
    if (q.assigned_to !== staff.doctor) throw new Error('patient moved away from the doctor')
    if (!nurseDuring || nurseAfter) throw new Error(`nurse may work ${nurseDuring}/${nurseAfter}`)
    if (!mine.covering.length) throw new Error('my_cover empty')
    return 'orders.write and the doctor patient only during cover; the patient stays with the doctor'
  },
)

// ---------------------------------------------------------------- 0036 lab and finance dashboards
await step('lab worklist: ordered → sample taken → result → done today', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
  await asAdmin()
  const svc = await one(`select id from service where service_group = 'lab' and active limit 1`)
  await as(staff.doctor)
  const req = (await one(`select order_test($1, $2, 'check', 2) as id`, [v.id, svc.id])).id
  await as(staff.lab_tech)
  const open = (await one(`select lab_worklist('open') as w`)).w
  if (!open.some((x) => x.id === req)) throw new Error('not on the worklist')
  await db.query(`select set_request_status($1, 'collected')`, [req])
  const s1 = (await one(`select lab_summary() as s`)).s
  await db.query(`select record_result($1, 'Hb 12.1 g/dL', 'Normal', true)`, [req])
  const done = (await one(`select lab_worklist('done') as w`)).w
  const s2 = (await one(`select lab_summary() as s`)).s
  if (!done.some((x) => x.id === req)) throw new Error('not in done today')
  if (!(s1.inProcess >= 1) || !(s2.doneToday >= 1)) throw new Error('summary')
  return `in process ${s1.inProcess} → done today ${s2.doneToday}, urgent ${s1.urgent}`
})
await step('cashier summary: today by method, mine, payments, open bills', async () => {
  await as(staff.cashier)
  const s = (await one(`select cashier_summary() as s`)).s
  if (typeof s.total !== 'number' || !Array.isArray(s.payments) || !Array.isArray(s.byMethod))
    throw new Error('shape')
  let refused = false
  try {
    await as(staff.lab_tech)
    await db.query(`select cashier_summary()`)
  } catch {
    refused = true
  }
  if (!refused) throw new Error('lab tech read the money')
  return `RWF ${s.total} in ${s.count} payment(s); open bills ${s.openBills}; lab refused`
})

// ---------------------------------------------------------------- calendars + departments (0037)
await step('doctor keeps a calendar; staff see it, the public only once public', async () => {
  await as(staff.doctor)
  const hours = JSON.stringify({ 1: [['08:00', '12:00']], 3: [['14:00', '17:00']] })
  await one(
    `select save_calendar(null, $1::jsonb, 30, 'staff', '{2026-12-25}', 'Theatre on Fridays') as id`,
    [hours],
  )
  await as(staff.nurse)
  const seen = (await one(`select staff_doctor_calendars() as j`)).j
  const mine = seen.find((c) => c.name === 'Dr. Mukamana BÃ©atrice')
  if (!mine || mine.slotMinutes !== 30 || mine.daysOff[0] !== '2026-12-25')
    throw new Error('staff do not see it')
  await as(null, 'anon')
  const pub1 = await one(
    `select count(*)::int as n from public_practitioners where names like 'Dr. Mukamana%'`,
  )
  await as(staff.doctor)
  await db.query(`select save_calendar(null, $1::jsonb, 30, 'public')`, [hours])
  await as(null, 'anon')
  const pub2 = await one(
    `select count(*)::int as n from public_practitioners where names like 'Dr. Mukamana%'`,
  )
  await asAdmin()
  if (pub1.n !== 0 || pub2.n !== 1) throw new Error(`public ${pub1.n} → ${pub2.n}`)
  return `staff ${seen.length} calendar(s); public ${pub1.n} → ${pub2.n}`
})
await expectError(
  'a cashier may not keep a calendar, nor edit a doctor’s',
  async () => {
    await as(staff.cashier)
    await db.query(`select save_calendar($1, '{}'::jsonb, 30, 'staff')`, [staff.doctor])
  },
  /not allowed/,
)
await expectError(
  'working periods must start before they end',
  async () => {
    await as(staff.doctor)
    await db.query(`select save_calendar(null, '{"1":[["12:00","08:00"]]}'::jsonb, 30, 'staff')`)
  },
  /start before it ends/,
)
await step('treatment placed in a department; billing by treatment for the manager', async () => {
  await as(staff.manager)
  const sid = (await one(`select upsert_service(null, 'Dept test', 'consultation', 1500) as id`)).id
  await db.query(`select set_service_department($1, $2)`, [sid, deptId])
  const r = await one(`select department_name from catalogue_services where id = $1`, [sid])
  const bill = (await one(`select service_billing(current_date - 30, current_date) as j`)).j
  await as(staff.nurse)
  let refused = false
  try {
    await db.query(`select set_service_department($1, null)`, [sid])
  } catch {
    refused = true
  }
  await asAdmin()
  if (r.department_name !== 'Nursing care' || !refused)
    throw new Error('department not set or nurse allowed')
  return `in "${r.department_name}"; ${Object.keys(bill).length} treatment(s) billed this month`
})

await step('history explains: names behind ids, changed fields, no secrets', async () => {
  await as(staff.manager)
  const h = (
    await one(
      `select activity_history(now() - interval '1 day', now() + interval '1 minute', null, null, 500, 0) as j`,
    )
  ).j
  await asAdmin()
  const charge = h.items.find((x) => x.entity === 'invoice_line' && x.action === 'create')
  const pay = h.items.find((x) => x.entity === 'payment')
  const upd = h.items.find((x) => x.action === 'update' && x.changes.length > 0)
  const leak = h.items.some((x) =>
    Object.keys(x.row ?? {}).some((k) => /pin|password|hash/i.test(k) && !/mapping/.test(k)),
  )
  if (!charge?.patient || !charge.row?.description)
    throw new Error('charge has no patient or description')
  if (!pay?.patient || !pay.names?.invoice) throw new Error('payment has no patient or bill')
  if (!upd) throw new Error('no change list on updates')
  if (leak) throw new Error('secret field in history')
  return `charge for ${charge.patient}; payment bill ${pay.names.invoice}; ${upd.entity} changed ${upd.changes.map((c) => c.f).join(', ')}`
})

// ---------------------------------------------------------------- 0040: cashier-only payments, bookings detail, flow setting
await step(
  '0040: the manager may not record a payment; the cashier may; the bill says who settled it',
  async () => {
    await asAdmin()
    const enc = await one(
      `select i.encounter_id as id from invoice i where i.status = 'draft' and invoice_balance(i.id) > 0 limit 1`,
    )
    let refused = false
    try {
      await as(staff.manager)
      await db.query(`select take_payment($1, 'cash', 100)`, [enc.id])
    } catch (e) {
      refused = /only the cashier|may not take payments/.test(String(e.message))
    }
    await as(staff.cashier)
    await db.query(`select take_payment($1, 'cash', 100)`, [enc.id])
    const b = await one(`select settled_by, settled_at from visit_bill where encounter_id = $1`, [
      enc.id,
    ])
    await asAdmin()
    if (!refused || !b.settled_by) throw new Error(`refused=${refused} by=${b.settled_by}`)
    return `manager refused; cashier paid; settled by ${b.settled_by}`
  },
)
await step(
  '0040: appointment detail carries the reason and who approved; flow setting toggles triage',
  async () => {
    await as(staff.receptionist)
    const d = (await one(`select appointment_detail($1) as j`, [homeInquiryId])).j
    if (!d || d.reason !== 'Needs consultation' || !d.approvedBy || !d.acceptedBy)
      throw new Error(JSON.stringify(d).slice(0, 200))
    await as(staff.manager)
    await db.query(`select save_setting('flow', '{"triage_first": true}'::jsonb)`)
    const s1 = (await one(`select staff_settings() as j`)).j
    await db.query(`select save_setting('flow', '{"triage_first": false}'::jsonb)`)
    const s2 = (await one(`select staff_settings() as j`)).j
    await asAdmin()
    if (s1.triage_first !== true || s2.triage_first !== false)
      throw new Error('setting not read back')
    return `reason "${d.reason}", approved by ${d.approvedBy}, accepted by ${d.acceptedBy}; triage_first toggles`
  },
)

// ---------------------------------------------------------------- 0041: journey, specialty, catalogue tools
await step(
  '0041: the journey of a visit lists desks, vitals, charges and payments in order',
  async () => {
    await asAdmin()
    const enc = await one(
      `select i.encounter_id as id from invoice i join payment p on p.invoice_id = i.id limit 1`,
    )
    await as(staff.receptionist)
    const j = (await one(`select visit_journey($1) as j`, [enc.id])).j
    await asAdmin()
    if (!j.steps.length || !j.payments.length || !j.bill) throw new Error('journey incomplete')
    return `${j.steps.length} desk step(s), ${j.vitals.length} vitals, ${j.charges.length} charge(s), ${j.payments.length} payment(s), bill ${j.bill.status}`
  },
)
await step('0041: a specialty on the doctor shows on the calendar title', async () => {
  await asAdmin()
  await db.query(`update profiles set specialty = 'Minor surgery' where id = $1`, [staff.doctor])
  const pr = await one(`select title from practitioner where user_id = $1`, [staff.doctor])
  const dir = await one(`select specialty from staff_directory where id = $1`, [staff.doctor])
  if (pr.title !== 'Minor surgery' || dir.specialty !== 'Minor surgery')
    throw new Error('not synced')
  return 'profile → calendar title synced'
})
await step('0041: bulk add into a department, move a type, then start over', async () => {
  await as(staff.manager)
  const n = (
    await one(`select bulk_add_services($1, $2::jsonb) as n`, [
      deptId,
      JSON.stringify([
        {
          name_en: 'Wound dressing',
          name_kin: 'Gupfuka igikomere',
          name_fr: 'Pansement',
          price: 2000,
          group: 'nursing',
        },
        { name_en: 'Injection', price: 1000, group: 'nursing' },
      ]),
    ])
  ).n
  const moved = (await one(`select move_group_to_department('lab', $1) as n`, [deptId])).n
  const before = await one(
    `select count(*)::int as n from catalogue_services where department_id = $1`,
    [deptId],
  )
  const gone = (await one(`select delete_all_services() as n`)).n
  const after = await one(
    `select count(*)::int as n from catalogue_services where code <> 'BED-STAY'`,
  )
  await asAdmin()
  const bed = await one(`select active from service where code = 'BED-STAY' and deleted_at is null`)
  if (n !== 2 || before.n < 2 || after.n !== 0 || gone < 2 || !bed?.active)
    throw new Error(`n=${n} before=${before.n} after=${after.n}`)
  return `added 2, moved ${moved} lab tests, then deleted all ${gone}; catalogue empty`
})

// ---------------------------------------------------------------- 0042: stock receive → send to a desk → hand over at the pharmacy
await step(
  '0042: receive, send to an office, pharmacy hands over a prescription and charges it',
  async () => {
    await as(staff.manager)
    const itemId = (
      await one(`select upsert_item(null, 'Ciprofloxacin', 200, '500 mg', 'tablet', 'tab') as id`)
    ).id
    const main = (await one(`select id from stock_location where type = 'main_store' limit 1`)).id
    const pharm = (await one(`select id from stock_location where type = 'pharmacy' limit 1`)).id
    const office = (
      await one(`select save_location(null, 'Consultation office', 'nursing', $1) as id`, [deptId])
    ).id
    await db.query(
      `select receive_stock($1, $2, 100, 80, 'CIP-001', '2028-01-31', 'Kigali Pharma Wholesale Ltd')`,
      [itemId, main],
    )
    await db.query(`select transfer_stock($1, $2, $3, 60)`, [itemId, main, pharm])
    await db.query(`select transfer_stock($1, $2, $3, 10, 'weekly supply')`, [itemId, main, office])
    const ov = (await one(`select stock_overview() as j`)).j
    const it = ov.items.find((x) => x.id === itemId)
    if (!it || it.onHand !== 100 || Number(it.costValue) !== 8000 || it.byLocation[office] !== 10)
      throw new Error(JSON.stringify(it))
    let refused = false
    try {
      await db.query(`select transfer_stock($1, $2, $3, 500)`, [itemId, main, pharm])
    } catch (e) {
      refused = /not enough stock/.test(String(e.message))
    }
    // a prescription for an open visit, then the pharmacist hands it over
    await asAdmin()
    const enc = await one(
      `select e.id from encounter e join invoice i on i.encounter_id = e.id where e.status = 'open' and i.status = 'draft' limit 1`,
    )
    await as(staff.doctor)
    const rx = (
      await one(
        `select prescribe($1, $2, 10, '1 tab', 'oral', 'twice a day', 5, null, 'pharmacy') as j`,
        [enc.id, itemId],
      )
    ).j
    await as(staff.pharmacist)
    const q = (await one(`select pharmacy_queue() as j`)).j
    if (!q.some((x) => x.requestId === rx.id)) throw new Error('not in the pharmacy queue')
    const d = (await one(`select dispense_prescription($1) as j`, [rx.id])).j
    const after = (await one(`select stock_overview() as j`)).j.items.find((x) => x.id === itemId)
    const sales = (await one(`select stock_sales(current_date, current_date) as j`)).j
    await asAdmin()
    const line = await one(
      `select unit_price, quantity from invoice_line where item_id = $1 order by created_at desc limit 1`,
      [itemId],
    )
    if (!d.charged || after.byLocation[pharm] !== 50 || Number(line.unit_price) !== 200)
      throw new Error(`charged=${d.charged} pharm=${after.byLocation[pharm]}`)
    const sold = sales.items.find((x) => /Ciprofloxacin/.test(x.item))
    if (!sold || Number(sold.units) !== 10 || Number(sold.revenue) !== 2000)
      throw new Error('sales wrong ' + JSON.stringify(sold))
    return `100 received (RWF 8,000), 60 → pharmacy, 10 → office; over-transfer refused: ${refused}; 10 handed over at RWF 200 = revenue 2,000, cost ${sold.cost}`
  },
)

// ---------------------------------------------------------------- 0043: booking notice goes away; wait = until taken
await step('0043: the booking-request notice disappears once reception books it', async () => {
  await as(null, 'anon')
  const ref = (
    await one(
      `select create_appointment_inquiry(null, null, 'Notice Test', '0788 000 999', null, null, 'Check-up', 'sms', now() + interval '3 days') as ref`,
    )
  ).ref
  await asAdmin()
  const a = await one(`select id from appointment where reference = $1`, [ref])
  const before = await one(
    `select count(*)::int as n from notification where kind = 'inquiry' and params ->> 'appointment' = $1`,
    [a.id],
  )
  await as(staff.receptionist)
  await db.query(`select approve_inquiry($1, $2, $3, ($4::timestamptz + interval '7 days'))`, [
    a.id,
    patientId,
    staff.doctor,
    slot,
  ])
  await asAdmin()
  const after = await one(
    `select count(*)::int as n from notification where kind = 'inquiry' and params ->> 'appointment' = $1`,
    [a.id],
  )
  // reception and the manager are told (0066)
  if (before.n < 1 || after.n !== 0) throw new Error(`before ${before.n} after ${after.n}`)
  return 'request notice 1 → 0 after booking'
})
await step('0043: reception cannot register an emergency', async () => {
  await as(staff.receptionist)
  let refused = false
  try {
    await db.query(`select start_visit($1, true, 'consultation')`, [patientId])
  } catch (e) {
    refused = /treating staff/.test(e.message)
  }
  await asAdmin()
  if (!refused) throw new Error('receptionist registered an emergency')
  return 'receptionist refused'
})
await step(
  '0043: average wait counts only patients already taken today; longest waiting shown apart',
  async () => {
    await as(staff.receptionist)
    const d = (await one(`select desk_summary() as j`)).j
    await asAdmin()
    const s = d.stations.find((x) => x.waiting > 0)
    if (typeof d.tiles.avgWaitMin !== 'number' || (s && s.longest == null))
      throw new Error(JSON.stringify(s))
    return `avg ${d.tiles.avgWaitMin} min; ${s ? `${s.station} longest waiting ${s.longest} min` : 'nobody waiting'}`
  },
)

// ---------------------------------------------------------------- 0044: cashier, tests that come back, task done
await step(
  '0044: the cashier cannot add a treatment, and only cash / MoMo / Airtel are accepted',
  async () => {
    await asAdmin()
    // 0041 deleted the whole catalogue; bring it back for these checks.
    await db.query(
      `update service set deleted_at = null, active = true where deleted_at is not null`,
    )
    const enc = await one(`select id from encounter where status = 'open' limit 1`)
    const svc = await one(`select id from service where active and deleted_at is null limit 1`)
    await as(staff.cashier)
    let charge = false
    try {
      await db.query(`select add_charge($1, 'cashier', $2)`, [enc.id, svc.id])
    } catch (e) {
      charge = /not allowed/.test(e.message)
    }
    await asAdmin()
    let card = false
    try {
      await db.query(
        `insert into payment (invoice_id, method, amount) select id, 'card', 100 from invoice limit 1`,
      )
    } catch (e) {
      card = /payment_method_accepted/.test(e.message)
    }
    if (!charge || !card) throw new Error(`charge refused ${charge}, card refused ${card}`)
    return 'cashier add refused; card refused'
  },
)
await step(
  '0044: tests without a diagnosis send the patient to the lab and back to the doctor',
  async () => {
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
    await asAdmin()
    await as(staff.manager)
    await db.query(`select bulk_add_services($1, $2::jsonb)`, [
      deptId,
      JSON.stringify([
        { name_en: 'Check test A', price: 1500, group: 'lab' },
        { name_en: 'Check test B', price: 2500, group: 'lab' },
      ]),
    ])
    await asAdmin()
    const tests = (
      await one(
        `select array_agg(id) as ids from service where name_en like 'Check test _' and deleted_at is null`,
      )
    ).ids
    await as(staff.doctor)
    const n = (
      await one(`select order_tests($1, $2, 'fever, cause not found yet', 'consultation') as n`, [
        v.id,
        tests,
      ])
    ).n
    await asAdmin()
    const atLab = await one(
      `select return_station, return_to from queue_entry where encounter_id = $1 and station = 'laboratory' and finished_at is null`,
      [v.id],
    )
    const atDoc = await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [v.id],
    )
    if (n !== tests.length || atLab?.return_station !== 'consultation' || atDoc.n !== 0)
      throw new Error(`n ${n} lab ${JSON.stringify(atLab)} doc ${atDoc.n}`)
    const reqs = (
      await db.query(`select id from service_request where encounter_id = $1 order by created_at`, [
        v.id,
      ])
    ).rows
    await as(staff.lab_tech)
    await db.query(`select record_result($1, 'Hb 12', 'Normal', true)`, [reqs[0].id])
    await asAdmin()
    const half = await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [v.id],
    )
    await as(staff.lab_tech)
    await db.query(`select record_result($1, 'No parasites', 'Negative', true)`, [reqs[1].id])
    await asAdmin()
    const back = await one(
      `select assigned_to, referral_note from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [v.id],
    )
    const lab = await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'laboratory' and finished_at is null`,
      [v.id],
    )
    if (half.n !== 0 || !back || back.assigned_to !== staff.doctor || lab.n !== 0)
      throw new Error(`half ${half.n} back ${JSON.stringify(back)} lab ${lab.n}`)
    return `${n} tests; after the last result: back to the doctor (${back.referral_note})`
  },
)
await step('0044: the doctor is told when the nurse has done the task', async () => {
  await as(staff.receptionist)
  const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
  await as(staff.doctor)
  const id = (await one(`select create_task($1, 'Repeat vitals in 1 hour') as id`, [v.id])).id
  await as(staff.nurse)
  await db.query(`select complete_task($1)`, [id])
  await as(staff.doctor)
  const n = (await one(`select my_notifications(200) as n`)).n
  await asAdmin()
  const done = n.items.find(
    (x) => x.kind === 'task_done' && x.params.title === 'Repeat vitals in 1 hour',
  )
  if (!done) throw new Error('doctor not told')
  return `doctor told: done by ${done.params.by}`
})

// ---------------------------------------------------------------- 0045: paid patients leave; "the patient has left"
await step(
  '0045: doctor finishes, cashier is paid → off the cashier and the visit closes',
  async () => {
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
    await as(staff.doctor)
    const svc = await one(
      `select id from service s where name_en = 'Check test A' and deleted_at is null`,
    )
    // a charge on the bill (the test may be an ordered one since 0052)
    await asAdmin()
    await db.query(`select add_charge_internal($1, 'consultation', $2)`, [v.id, svc.id])
    await as(staff.doctor)
    await db.query(`select add_diagnosis($1, 'Malaria', 'B54', 'primary', false)`, [v.id])
    await db.query(`select finish_visit($1)`, [v.id])
    await asAdmin()
    const due = await one(`select invoice_balance(id) as b from invoice where encounter_id = $1`, [
      v.id,
    ])
    await as(staff.cashier)
    const r = (await one(`select take_payment($1, 'cash', $2) as r`, [v.id, due.b])).r
    await asAdmin()
    const e = await one(`select status from encounter where id = $1`, [v.id])
    const q = await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and finished_at is null`,
      [v.id],
    )
    if (!r.closed || e.status !== 'closed' || q.n !== 0)
      throw new Error(JSON.stringify({ r, e, q }))
    return `paid ${due.b} RWF → visit closed, nobody waiting`
  },
)
await step(
  '0045: "patient has left": refused while money is due, manager with a reason',
  async () => {
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
    await as(staff.doctor)
    const svc = await one(
      `select id from service s where name_en = 'Check test A' and deleted_at is null`,
    )
    // a charge on the bill (the test may be an ordered one since 0052)
    await asAdmin()
    await db.query(`select add_charge_internal($1, 'consultation', $2)`, [v.id, svc.id])
    await as(staff.doctor)
    await as(staff.receptionist)
    let refused = false
    try {
      await db.query(`select end_visit($1)`, [v.id])
    } catch (e) {
      refused = /still due/.test(e.message)
    }
    await as(staff.manager)
    await db.query(`select end_visit($1, 'left without paying, family will come')`, [v.id])
    await asAdmin()
    const e = await one(`select status, left_reason from encounter where id = $1`, [v.id])
    if (!refused || e.status !== 'closed' || !e.left_reason)
      throw new Error(JSON.stringify({ refused, e }))
    return 'reception refused (money due); manager closed it with a reason'
  },
)

// ---------------------------------------------------------------- 0046: nurses told about missing vitals
await step(
  '0046: reception sends a patient to the doctor → nurses told "no vitals"; gone once taken',
  async () => {
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
    await as(staff.nurse)
    const before = (await one(`select my_notifications(200) as n`)).n.items.filter(
      (x) => x.kind === 'no_vitals' && x.params.encounter === v.id,
    )
    await db.query(`select record_vitals($1, '{"pulse":"80","temp":"36.8"}'::jsonb)`, [v.id])
    const after = (await one(`select my_notifications(200) as n`)).n.items.filter(
      (x) => x.kind === 'no_vitals' && x.params.encounter === v.id,
    )
    await as(staff.doctor)
    const doc = (await one(`select my_notifications(200) as n`)).n.items.some(
      (x) => x.kind === 'no_vitals',
    )
    await asAdmin()
    if (before.length !== 1 || after.length !== 0 || doc)
      throw new Error(`before ${before.length} after ${after.length} doctor sees ${doc}`)
    return `nurse notice 1 → 0 after vitals (${before[0].params.ticket} ${before[0].params.name})`
  },
)

// ---------------------------------------------------------------- 0048: a treatment in several departments
await step(
  '0048: one treatment given by two departments; the nurse knows her department',
  async () => {
    await as(staff.manager)
    const surgery = (
      await one(`select upsert_department(null, 'Minor surgery', '', '{doctor,nurse}') as id`)
    ).id
    const svc = (await one(`select upsert_service(null, 'Wound dressing', 'nursing', 3000) as id`))
      .id
    await db.query(`select set_service_departments($1, $2)`, [svc, [deptId, surgery]])
    const two = await one(
      `select department_ids, department_names from catalogue_services where id = $1`,
      [svc],
    )
    await db.query(`select set_service_departments($1, $2)`, [svc, [surgery]])
    const one1 = await one(
      `select department_ids, department_id from catalogue_services where id = $1`,
      [svc],
    )
    await as(staff.nurse)
    const me = (await one(`select my_placement() as p`)).p
    await asAdmin()
    if (
      two.department_ids.length !== 2 ||
      one1.department_ids.length !== 1 ||
      one1.department_id !== surgery ||
      me.departmentId !== deptId
    )
      throw new Error(JSON.stringify({ two, one1, me }))
    return `${two.department_names.join(' + ')} → Minor surgery only; nurse's department: ${me.department}`
  },
)

// ---------------------------------------------------------------- 0049: the clinic's own categories
await step(
  '0049: a new "lab test" category makes its treatments orderable tests; kind can change',
  async () => {
    await as(staff.manager)
    const cat = (
      await one(
        `select save_category(null, 'Blood tests', 'Ibizamini by''amaraso', 'Analyses de sang', 'lab') as id`,
      )
    ).id
    const svc = (await one(`select upsert_service(null, 'Haemoglobin', 'other', 2000) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [svc, cat])
    const asLab = await one(
      `select service_group, category_id from catalogue_services where id = $1`,
      [svc],
    )
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
    await as(staff.doctor)
    await db.query(`select order_test($1, $2, 'pale')`, [v.id, svc])
    await as(staff.manager)
    await db.query(`select save_category($1, 'Blood work', null, null, 'treatment')`, [cat])
    const asTreatment = await one(`select service_group from service where id = $1`, [svc])
    await asAdmin()
    if (
      asLab.service_group !== 'lab' ||
      asLab.category_id !== cat ||
      asTreatment.service_group !== 'other'
    )
      throw new Error(JSON.stringify({ asLab, asTreatment }))
    return 'Blood tests (lab) → Haemoglobin orderable; kind → treatment: no longer a test'
  },
)
await step('0049: a category in use cannot be deleted; the bed category never', async () => {
  await as(staff.manager)
  const cat = (await one(`select id from service_category where name_en = 'Blood work'`)).id
  let inUse = false
  try {
    await db.query(`select delete_category($1)`, [cat])
  } catch (e) {
    inUse = /still has/.test(e.message)
  }
  const other = (await one(`select id from service_category where base_group = 'other'`)).id
  await asAdmin()
  await db.query(`update service set category_id = $2 where category_id = $1`, [cat, other])
  await as(staff.manager)
  await db.query(`select delete_category($1)`, [cat])
  const bed = (await one(`select id from service_category where kind = 'bed'`)).id
  let bedRefused = false
  try {
    await db.query(`select delete_category($1)`, [bed])
  } catch (e) {
    bedRefused = /bed category/.test(e.message)
  }
  const d = (await one(`select dashboard_summary(current_date - 30, current_date) as d`)).d
  await asAdmin()
  const named = d.visitsByGroup.some((x) => typeof x.name === 'string')
  if (!inUse || !bedRefused || !named) throw new Error(JSON.stringify({ inUse, bedRefused, named }))
  return 'in use refused, deleted once empty, bed refused; dashboard counts by category name'
})

// ---------------------------------------------------------------- 0050: departments in the history
await step('0050: creating and deleting a department shows in the activity history', async () => {
  await as(staff.manager)
  const id = (await one(`select upsert_department(null, 'Eye clinic', '', '{doctor}') as id`)).id
  await db.query(`select delete_department($1)`, [id])
  const h = (await one(`select activity_history(null, null, null, 'admin', 200) as h`)).h
  await asAdmin()
  const items = h.items.filter((x) => x.entity === 'department' && x.row?.name === 'Eye clinic')
  const actions = items.map((x) => x.action)
  if (!actions.includes('create') || items.length < 2)
    throw new Error(JSON.stringify(items.map((x) => x.action)))
  return `history: ${actions.join(', ')} of department "Eye clinic"`
})

// ---------------------------------------------------------------- 0051: an employee in several departments
await step(
  '0051: a nurse heads one department and is a member of another; messages and rights follow',
  async () => {
    await as(staff.manager)
    const wards = (await one(`select upsert_department(null, 'Wards', '', '{}') as id`)).id
    const maternity = (await one(`select upsert_department(null, 'Maternity', '', '{}') as id`)).id
    await asAdmin()
    // what manage-staff does after the manager's e-mailed code
    await db.query(`select set_staff_departments($1, $2::jsonb)`, [
      staff.nurse,
      JSON.stringify([
        { department_id: wards, position: 'head' },
        { department_id: maternity, position: 'member' },
      ]),
    ])
    await as(staff.nurse)
    const me = (await one(`select my_placement() as p`)).p
    await db.query(`select send_notification('department', $1, 'Ward round at 10', null)`, [wards])
    let refused = false
    try {
      await db.query(`select send_notification('department', $1, 'Not mine to send', null)`, [
        maternity,
      ])
    } catch (e) {
      refused = /only the manager/.test(e.message)
    }
    await as(staff.manager)
    await db.query(`select send_notification('department', $1, 'Maternity meeting', null)`, [
      maternity,
    ])
    await as(staff.nurse)
    const got = (await one(`select my_notifications(200) as n`)).n.items.some(
      (x) => x.title === 'Maternity meeting',
    )
    await as(staff.manager)
    await db.query(`select delete_department($1)`, [wards])
    await asAdmin()
    const after = await one(`select department_id, position from profiles where id = $1`, [
      staff.nurse,
    ])
    if (
      me.departments.length !== 2 ||
      !refused ||
      !got ||
      after.department_id !== maternity ||
      after.position !== 'member'
    )
      throw new Error(JSON.stringify({ me: me.departments, refused, got, after }))
    return 'Wards (head) + Maternity (member); sends to Wards only; gets Maternity messages; Wards deleted → Maternity is main'
  },
)

// ---------------------------------------------------------------- 0052: the clinic chooses the desk
await step(
  '0052: a category done at Nursing: ordered, sent to Nursing, not on the lab list, back to the doctor',
  async () => {
    await as(staff.manager)
    const cat = (
      await one(
        `select save_category(null, 'Physiotherapy', null, null, 'treatment', 'nursing') as id`,
      )
    ).id
    const svc = (await one(`select upsert_service(null, 'Physio session', 'other', 4000) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [svc, cat])
    const row = await one(`select order_station from catalogue_services where id = $1`, [svc])
    await as(staff.receptionist)
    const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [patientId])
    await as(staff.doctor)
    await db.query(`select order_tests($1, $2, 'back pain', 'consultation')`, [v.id, [svc]])
    await asAdmin()
    const atNursing = await one(
      `select return_station from queue_entry where encounter_id = $1 and station = 'nursing' and finished_at is null`,
      [v.id],
    )
    const req = await one(
      `select id, station from service_request where encounter_id = $1 and service_id = $2`,
      [v.id, svc],
    )
    await as(staff.lab_tech)
    const lab = (await one(`select lab_worklist('open') as w`)).w
    const onLabList = JSON.stringify(lab).includes(req.id)
    await as(staff.nurse)
    await db.query(
      `select record_result($1, 'Session done, mobility better', 'Continue at home', true)`,
      [req.id],
    )
    await asAdmin()
    const back = await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [v.id],
    )
    if (
      row.order_station !== 'nursing' ||
      req.station !== 'nursing' ||
      atNursing?.return_station !== 'consultation' ||
      onLabList ||
      back.n !== 1
    )
      throw new Error(JSON.stringify({ row, req, atNursing, onLabList, back }))
    return 'Physiotherapy → Nursing; not on the lab list; result by the nurse → back to the doctor'
  },
)

// ---------------------------------------------------------------- 0053: a file without a visit
await step('0053: reception registers a file for a booking; no visit, no queue', async () => {
  await as(staff.receptionist)
  const r = (
    await one(
      `select register_patient_file('Uwase', 'Claudine', 'female', null, 30, '0788 111 222') as r`,
    )
  ).r
  await asAdmin()
  const visits = await one(`select count(*)::int as n from encounter where patient_id = $1`, [
    r.patient_id,
  ])
  if (!r.file_number || visits.n !== 0) throw new Error(JSON.stringify({ r, visits }))
  return `file ${r.file_number}, no visit opened`
})

// ---------------------------------------------------------------- 0054: who may do what
await step(
  '0054: the manager locks payments for reception, allows one receptionist, locks one cashier',
  async () => {
    const mine = async (who) => {
      await as(who)
      const r = (await one(`select my_permissions() as p`)).p
      await asAdmin()
      return r.includes('payment.take')
    }
    const before = await mine(staff.receptionist)
    await as(staff.manager)
    await db.query(`select set_role_permission('receptionist', 'payment.take', false)`)
    const locked = await mine(staff.receptionist)
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'payment.take', true)`, [staff.receptionist])
    const exception = await mine(staff.receptionist)
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'payment.take', false)`, [staff.cashier])
    const cashierLocked = await mine(staff.cashier)
    let managerRefused = false
    await as(staff.manager)
    try {
      await db.query(`select set_role_permission('manager', 'payment.take', false)`)
    } catch (e) {
      managerRefused = /keeps every feature/.test(e.message)
    }
    // back to the defaults
    await db.query(`select set_staff_permission($1, 'payment.take', null)`, [staff.receptionist])
    await db.query(`select set_staff_permission($1, 'payment.take', null)`, [staff.cashier])
    await db.query(`select set_role_permission('receptionist', 'payment.take', true)`)
    const m = (await one(`select permission_matrix() as m`)).m
    await asAdmin()
    if (
      !before ||
      locked ||
      !exception ||
      cashierLocked ||
      !managerRefused ||
      !m.roles.receptionist.includes('payment.take')
    )
      throw new Error(JSON.stringify({ before, locked, exception, cashierLocked, managerRefused }))
    return 'reception: yes → locked → one receptionist allowed; one cashier locked; manager cannot be locked'
  },
)

// ---------------------------------------------------------------- 0055: patients belong where they were sent
const d1 = staff.doctor
let d2, d3, paed
const visitAt = async (given) => {
  await as(staff.receptionist)
  const r = (
    await one(`select register_patient_file('Mutoni', $1, 'female', null, 6, null) as r`, [given])
  ).r
  const v = await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [
    r.patient_id,
  ])
  await asAdmin()
  const q = await one(
    `select id from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
    [v.id],
  )
  return { enc: v.id, queue: q.id }
}
const tryAs = async (who, sql, params) => {
  await as(who)
  try {
    await db.query(sql, params)
    return 'ok'
  } catch (e) {
    return String(e.message).split('\n')[0]
  } finally {
    await asAdmin()
  }
}
await step(
  '0055: a taken patient is the doctor’s; sent to Paediatrics, only its doctors may work',
  async () => {
    d2 = await mkUser('d.two', 'Dr. Two', 'doctor')
    d3 = await mkUser('d.three', 'Dr. Three', 'doctor')
    staff.doctor = d1
    await asAdmin()
    paed = (
      await one(
        `insert into department (name, roles) values ('Paediatrics', '{doctor}') returning id`,
      )
    ).id
    await db.query(`insert into staff_department (profile_id, department_id) values ($1, $2)`, [
      d2,
      paed,
    ])
    const p = await visitAt('Aline')
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    const note = `select add_clinical_note($1, 'seen')`
    const otherNote = await tryAs(d2, note, [p.enc])
    const otherTake = await tryAs(d2, `select take_patient($1)`, [p.queue])
    await as(d1)
    await db.query(
      `select refer_patient($1, 'consultation', 'consultation', null, 'child, 6 years', false, $2)`,
      [p.enc, paed],
    )
    const member = await tryAs(d2, note, [p.enc])
    const notMember = await tryAs(d3, note, [p.enc])
    const sender = await tryAs(d1, note, [p.enc])
    const access = await (async () => {
      await as(d3)
      const a = (await one(`select visit_access($1) as a`, [p.enc])).a
      await asAdmin()
      return a
    })()
    if (
      !/is with Dr\. One|is with/.test(otherNote) ||
      !/already taken|sent to/.test(otherTake) ||
      member !== 'ok' ||
      !/is with/.test(notMember) ||
      !/is with/.test(sender) ||
      access.canWork !== false ||
      !/Paediatrics/.test(access.holder)
    )
      throw new Error(JSON.stringify({ otherNote, otherTake, member, notMember, sender, access }))
    return `other doctor refused; Paediatrics member ok, others refused (${access.holder})`
  },
)
await step('0055: a doctor calls the next patient; reception sends one to them', async () => {
  const p = await visitAt('Bella')
  await as(d3)
  const call = (
    await one(`select call_next('consultation', 'reception', null, 'room 2 free') as id`)
  ).id
  await as(staff.receptionist)
  const inbox = (await one(`select my_calls() as c`)).c
  const sees = inbox.incoming.some((x) => x.id === call)
  const wrong = await tryAs(staff.nurse, `select answer_call($1, $2)`, [call, p.queue])
  await as(staff.receptionist)
  await db.query(`select answer_call($1, $2)`, [call, p.queue])
  await asAdmin()
  const q = await one(`select assigned_to from queue_entry where id = $1`, [p.queue])
  const st = await one(`select status from staff_call where id = $1`, [call])
  const note = `select add_clinical_note($1, 'seen')`
  const caller = await tryAs(d3, note, [p.enc])
  const other = await tryAs(d2, note, [p.enc])
  const again = await tryAs(staff.receptionist, `select answer_call($1, $2)`, [call, p.queue])
  if (
    !sees ||
    !/not for you/.test(wrong) ||
    q.assigned_to !== d3 ||
    st.status !== 'answered' ||
    caller !== 'ok' ||
    !/is with/.test(other) ||
    !/already answered/.test(again)
  )
    throw new Error(JSON.stringify({ sees, wrong, q, st, caller, other, again }))
  return 'reception saw the call, sent the patient; only the caller may work on them'
})
await step('0055: asking a colleague for help gives them the patient until it ends', async () => {
  await asAdmin()
  const enc = (
    await one(
      `select q.encounter_id as id from queue_entry q where q.assigned_to = $1 and q.finished_at is null limit 1`,
      [d3],
    )
  ).id
  const note = `select add_clinical_note($1, 'second look')`
  const before = await tryAs(d1, note, [enc])
  await as(d3)
  const help = (await one(`select ask_help($1, $2, 'rash, what do you think?') as id`, [enc, d1]))
    .id
  await as(d1)
  const inbox = (await one(`select my_calls() as c`)).c
  await db.query(`select respond_help($1, true)`, [help])
  const during = await tryAs(d1, note, [enc])
  await as(d3)
  await db.query(`select cancel_call($1)`, [help])
  const after = await tryAs(d1, note, [enc])
  await asAdmin()
  const st = await one(`select status from staff_call where id = $1`, [help])
  if (
    !/is with/.test(before) ||
    !inbox.incoming.some((x) => x.id === help) ||
    during !== 'ok' ||
    !/is with/.test(after) ||
    st.status !== 'done'
  )
    throw new Error(JSON.stringify({ before, during, after, st }))
  return 'refused → help accepted → may work → help ended → refused'
})

// ---------------------------------------------------------------- 0056: laboratory and pharmacy desks
await step(
  '0056: finishing keeps the medicines; pharmacy hands over → cashier; a line not given tells the doctor',
  async () => {
    const p = await visitAt('Chloe')
    await asAdmin()
    const amox = (await one(`select id from item where code = 'AMOX500'`)).id
    const para = (await one(`select id from item where code <> 'AMOX500' order by code limit 1`)).id
    await as(staff.manager)
    const cons = (
      await one(`select upsert_service(null, 'Consultation 56', 'consultation', 5000) as id`)
    ).id
    await as(d1)
    await db.query(`select add_diagnosis($1, 'Malaria', 'B54', 'primary')`, [p.enc])
    await db.query(`select prescribe(p_encounter_id => $1, p_item_id => $2, p_quantity => 10)`, [
      p.enc,
      amox,
    ])
    await db.query(`select prescribe(p_encounter_id => $1, p_item_id => $2, p_quantity => 6)`, [
      p.enc,
      para,
    ])
    await db.query(`select add_charge($1, 'consultation', $2)`, [p.enc, cons])
    await db.query(`select finish_visit($1)`, [p.enc])
    await asAdmin()
    const open = async () =>
      (
        await db.query(
          `select station::text from queue_entry where encounter_id = $1 and finished_at is null and deleted_at is null order by station`,
          [p.enc],
        )
      ).rows.map((r) => r.station)
    const afterFinish = await open()
    const enc1 = await one(`select status::text from encounter where id = $1`, [p.enc])
    const lines = (
      await db.query(`select id, item_id from medication_request where encounter_id = $1`, [p.enc])
    ).rows
    await as(staff.pharmacist)
    const sum1 = (await one(`select pharmacy_summary() as s`)).s
    await db.query(`select dispense_prescription($1)`, [lines.find((l) => l.item_id === amox).id])
    const midway = await (async () => {
      await asAdmin()
      return open()
    })()
    await as(staff.pharmacist)
    await db.query(`select rx_not_given($1, 'out of stock, bought outside')`, [
      lines.find((l) => l.item_id === para).id,
    ])
    const sum2 = (await one(`select pharmacy_summary() as s`)).s
    await asAdmin()
    const afterAll = await open()
    const told = await one(
      `select count(*)::int as n from notification where kind = 'rx_not_given' and recipient_user = $1`,
      [d1],
    )
    await as(d1)
    const vc = (await one(`select visit_clinical($1) as v`, [p.enc])).v
    await asAdmin()
    const notGiven = vc.prescriptions.find((r) => r.notGivenReason)
    if (
      JSON.stringify(afterFinish) !== '["pharmacy"]' ||
      enc1.status !== 'open' ||
      sum1.lines < 2 ||
      JSON.stringify(midway) !== '["pharmacy"]' ||
      JSON.stringify(afterAll) !== '["cashier"]' ||
      told.n !== 1 ||
      !notGiven ||
      sum2.dispensedToday < 1 ||
      sum2.notGivenToday < 1
    )
      throw new Error(JSON.stringify({ afterFinish, enc1, sum1, midway, afterAll, told, sum2 }))
    return 'finish → pharmacy; 1 handed over, 1 not given (doctor told) → cashier'
  },
)
await step(
  '0056: a result goes back to the ordering doctor; a test not done leaves the bill and tells them',
  async () => {
    const p = await visitAt('Delphine')
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await as(staff.manager)
    const blood = (await one(`select save_category(null, 'Lab tests 56', null, null, 'lab') as id`))
      .id
    const mrdt = (await one(`select upsert_service(null, 'Malaria RDT 56', 'other', 2000) as id`))
      .id
    const fbc = (
      await one(`select upsert_service(null, 'Full blood count 56', 'other', 4000) as id`)
    ).id
    await db.query(`select set_service_category($1, $2)`, [mrdt, blood])
    await db.query(`select set_service_category($1, $2)`, [fbc, blood])
    await as(d1)
    await db.query(`select order_test($1, $2, 'fever')`, [p.enc, mrdt])
    await asAdmin()
    // the doctor sent the patient to the lab without asking them back
    await db.query(
      `update queue_entry set finished_at = now() where encounter_id = $1 and station = 'consultation'`,
      [p.enc],
    )
    const req1 = (
      await one(`select id from service_request where encounter_id = $1 and service_id = $2`, [
        p.enc,
        mrdt,
      ])
    ).id
    await as(staff.lab_tech)
    await db.query(`select record_result($1, 'Negative', 'No malaria', true)`, [req1])
    await asAdmin()
    const back1 = await one(
      `select assigned_to, referral_note from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [p.enc],
    )
    const labOpen1 = await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'laboratory' and finished_at is null`,
      [p.enc],
    )
    await as(d1)
    await db.query(`select order_test($1, $2, 'pallor')`, [p.enc, fbc])
    await asAdmin()
    const req2 = (
      await one(`select id from service_request where encounter_id = $1 and service_id = $2`, [
        p.enc,
        fbc,
      ])
    ).id
    const charged = await one(
      `select count(*)::int as n from invoice_line where source_type = 'service_request' and source_id = $1 and deleted_at is null`,
      [req2],
    )
    await as(staff.lab_tech)
    await db.query(`select set_request_status($1, 'cancelled', 'reagent finished')`, [req2])
    await asAdmin()
    const stillCharged = await one(
      `select count(*)::int as n from invoice_line where source_type = 'service_request' and source_id = $1 and deleted_at is null`,
      [req2],
    )
    const told = await one(
      `select count(*)::int as n from notification where kind = 'test_cancelled' and recipient_user = $1`,
      [d1],
    )
    if (
      back1?.assigned_to !== d1 ||
      !/Results ready/.test(back1?.referral_note ?? '') ||
      labOpen1.n !== 0 ||
      charged.n !== 1 ||
      stillCharged.n !== 0 ||
      told.n !== 1
    )
      throw new Error(JSON.stringify({ back1, labOpen1, charged, stillCharged, told }))
    return 'result → back to Dr. One; cancelled test off the bill, doctor told'
  },
)

// ---------------------------------------------------------------- 0057: the desks connected
await step(
  '0057: reception takes a payment (receipt); the bill stays open for a pending test; paid and done → closed',
  async () => {
    const p = await visitAt('Esther')
    await as(staff.manager)
    const cons = (
      await one(`select upsert_service(null, 'Consultation 57', 'consultation', 5000) as id`)
    ).id
    const labCat = (
      await one(`select save_category(null, 'Lab tests 57', null, null, 'lab') as id`)
    ).id
    const test = (await one(`select upsert_service(null, 'Malaria RDT 57', 'other', 2000) as id`))
      .id
    await db.query(`select set_service_category($1, $2)`, [test, labCat])
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select add_charge($1, 'consultation', $2)`, [p.enc, cons])
    await db.query(`select order_test($1, $2, 'fever')`, [p.enc, test])
    await as(staff.receptionist)
    const first = (await one(`select take_payment($1, 'cash', 7000) as r`, [p.enc])).r
    await asAdmin()
    const inv1 = await one(`select status::text from invoice where encounter_id = $1`, [p.enc])
    // still open: the doctor can charge more
    await as(d1)
    await db.query(`select add_charge($1, 'consultation', $2)`, [p.enc, cons])
    // the result goes back to the doctor, who sends the patient to the cashier
    await asAdmin()
    const req = (await one(`select id from service_request where encounter_id = $1`, [p.enc])).id
    await db.query(`update encounter set triage_level = 'red' where id = $1`, [p.enc])
    await as(staff.lab_tech)
    await db.query(`select record_result($1, 'Negative', 'No malaria', true)`, [req])
    await as(d1)
    await db.query(`select finish_station($1, 'consultation', 'cashier')`, [p.enc])
    await asAdmin()
    const atCashier = await one(
      `select priority from queue_entry where encounter_id = $1 and station = 'cashier' and finished_at is null`,
      [p.enc],
    )
    await as(staff.receptionist)
    const last = (await one(`select take_payment($1, 'cash', 5000) as r`, [p.enc])).r
    await asAdmin()
    const enc = await one(`select status::text from encounter where id = $1`, [p.enc])
    const inv2 = await one(`select status::text, number from invoice where encounter_id = $1`, [
      p.enc,
    ])
    if (
      !/^RCT-/.test(first.receipt ?? '') ||
      first.closed ||
      inv1.status !== 'draft' ||
      atCashier?.priority !== 1 ||
      !last.closed ||
      enc.status !== 'closed' ||
      inv2.status !== 'posted'
    )
      throw new Error(JSON.stringify({ first, inv1, atCashier, last, enc, inv2 }))
    return `paid early (${first.receipt}, bill open) → more charged → red at the cashier → paid → closed ${inv2.number}`
  },
)
await step(
  // 0070: once the patient has left reception, reception follows the visit and no longer sends on
  '0057/0070: reception does not send on a patient already sent to another desk; it follows the visit',
  async () => {
    const p = await visitAt('Fiona')
    let refused = ''
    await as(staff.receptionist)
    try {
      await db.query(`select finish_station($1, 'reception', 'laboratory')`, [p.enc])
    } catch (e) {
      refused = String(e.message).split('\n')[0]
    }
    const access = (await one(`select visit_access($1) as a`, [p.enc])).a
    await asAdmin()
    const open = (
      await db.query(
        `select station::text from queue_entry where encounter_id = $1 and finished_at is null order by station`,
        [p.enc],
      )
    ).rows.map((r) => r.station)
    if (!refused || access.canRoute !== false || JSON.stringify(open) !== '["consultation"]')
      throw new Error(JSON.stringify({ refused, access, open }))
    return 'refused; still at consultation; reception follows (canRoute false)'
  },
)
await step(
  '0057: a booked patient waits for the booked doctor; the booking completes with the visit',
  async () => {
    await as(staff.receptionist)
    const r = (
      await one(`select register_patient_file('Ishimwe', 'Gloria', 'female', null, 28, null) as r`)
    ).r
    await asAdmin()
    const pr = (await one(`select ensure_practitioner($1) as id`, [d2])).id
    const appt = (
      await one(
        `insert into appointment (patient_id, practitioner_id, starts_at, status, source)
       values ($1, $2, now() + interval '30 minutes', 'confirmed', 'reception') returning id`,
        [r.patient_id, pr],
      )
    ).id
    await as(staff.receptionist)
    const v = (await one(`select appointment_arrived($1) as v`, [appt])).v
    const enc = v.encounter_id
    // triage first is off: straight to the booked doctor's desk, and the doctor is told (0065)
    await asAdmin()
    const told = await one(
      `select count(*)::int as n from notification where kind = 'booked_arrived' and recipient_user = $1`,
      [d2],
    )
    if (told.n < 1) throw new Error('the booked doctor was not told')
    const q = await one(
      `select assigned_to from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [enc],
    )
    const linked = await one(`select appointment_id from encounter where id = $1`, [enc])
    await as(staff.manager)
    await db.query(`select end_visit($1, 'test over')`, [enc]).catch(() => null)
    await asAdmin()
    const a = await one(`select status::text from appointment where id = $1`, [appt])
    if (q?.assigned_to !== d2 || linked.appointment_id !== appt || a.status !== 'completed')
      throw new Error(JSON.stringify({ q, linked, a }))
    return 'straight to the booked doctor (told) → visit ends → booking completed'
  },
)
await step(
  '0057: the pharmacy sells without a prescription; the doctor lists tests and prescriptions',
  async () => {
    const p = await visitAt('Grace')
    await asAdmin()
    const amox = (await one(`select id from item where code = 'AMOX500'`)).id
    await as(staff.pharmacist)
    const sold = (await one(`select sell_medicine($1, $2, 3, null) as r`, [p.enc, amox])).r
    await asAdmin()
    const line = await one(`select prescriber_id, given_at from medication_request where id = $1`, [
      sold.requestId,
    ])
    await as(d1)
    const orders = (await one(`select my_orders(30) as j`)).j
    const rx = (await one(`select my_prescriptions(30) as j`)).j
    await asAdmin()
    if (!sold.dispenseId || line.prescriber_id !== staff.pharmacist || !line.given_at)
      throw new Error(JSON.stringify({ sold, line }))
    if (!orders.length || !rx.length || !rx.every((x) => x.state))
      throw new Error(JSON.stringify({ orders: orders.length, rx: rx.length }))
    return `sold and handed over; doctor lists ${orders.length} tests, ${rx.length} prescriptions`
  },
)

// ---------------------------------------------------------------- 0058: staff rows locked
await expectError(
  '0058: an employee cannot make themselves manager by writing their own staff row',
  async () => {
    await as(staff.nurse)
    await db.query(`update profiles set role = 'manager' where id = auth.uid()`)
  },
  /permission denied|staff accounts are changed by the manager only/i,
)
await step('0058: the nurse is still a nurse; switches cannot be written directly', async () => {
  await asAdmin()
  const r = await one(`select role::text from profiles where id = $1`, [staff.nurse])
  let blocked = false
  await as(staff.nurse)
  try {
    await db.query(
      `insert into role_permissions (role, permission) values ('nurse', 'billing.write')`,
    )
  } catch (e) {
    blocked = /permission denied/i.test(e.message)
  }
  await asAdmin()
  if (r.role !== 'nurse' || !blocked) throw new Error(JSON.stringify({ r, blocked }))
  return 'role unchanged; role_permissions write refused'
})

// ---------------------------------------------------------------- 0059: desks complete
await step(
  '0059: Add a treatment refuses ordered tests, the bed line and fake sources; orders work without charge.write',
  async () => {
    const p = await visitAt('Hope')
    await as(staff.manager)
    const labCat = (
      await one(`select save_category(null, 'Lab tests 59', null, null, 'lab') as id`)
    ).id
    const test = (await one(`select upsert_service(null, 'Widal 59', 'other', 3000) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [test, labCat])
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    const tryCharge = async (sql, params) => {
      try {
        await db.query(sql, params)
        return 'ok'
      } catch (e) {
        return String(e.message).split('\n')[0]
      }
    }
    const ordered = await tryCharge(`select add_charge($1, 'consultation', $2)`, [p.enc, test])
    const bed = await tryCharge(
      `select add_charge($1, 'beds', (select id from service where code = 'BED-STAY'), null, 1, 1000, 'x')`,
      [p.enc],
    )
    const spoof = await tryCharge(
      `select add_charge($1, 'consultation', $2, null, 1, null, null, null, null, 'bed_stay', null)`,
      [p.enc, test],
    )
    // the manager switches 'Add treatments' off for doctors: ordering a test still works
    await as(staff.manager)
    await db.query(`select set_role_permission('doctor', 'charge.write', false)`)
    await as(d1)
    const order = await tryCharge(`select order_test($1, $2, 'fever')`, [p.enc, test])
    await as(staff.manager)
    await db.query(`select set_role_permission('doctor', 'charge.write', true)`)
    await asAdmin()
    const charged = await one(
      `select count(*)::int as n from invoice_line l join invoice i on i.id = l.invoice_id
       where i.encounter_id = $1 and l.source_type = 'service_request' and l.deleted_at is null`,
      [p.enc],
    )
    if (
      !/ordered, not added/.test(ordered) ||
      !/beds board/.test(bed) ||
      !/automatic charges/.test(spoof) ||
      order !== 'ok' ||
      charged.n !== 1
    )
      throw new Error(JSON.stringify({ ordered, bed, spoof, order, charged }))
    return 'ordered test, bed line and fake source refused; the order charges by itself'
  },
)
await step('0059: Bed stay cannot be deleted nor hidden', async () => {
  await as(staff.manager)
  const bed = (await one(`select id from service where code = 'BED-STAY'`)).id
  let refused = false
  try {
    await db.query(`select delete_service($1)`, [bed])
  } catch (e) {
    refused = /built in/.test(e.message)
  }
  await asAdmin()
  await db.query(`update service set active = false where id = $1`, [bed])
  const s = await one(`select active, deleted_at from service where id = $1`, [bed])
  if (!refused || !s.active || s.deleted_at) throw new Error(JSON.stringify({ refused, s }))
  return 'delete refused; hiding has no effect'
})
await step(
  "0059: a nursing order is on the nurses' worklist and the nurse can mark it not done",
  async () => {
    const p = await visitAt('Ines')
    await as(staff.manager)
    const cat = (
      await one(
        `select save_category(null, 'Nursing care 59', null, null, 'treatment', 'nursing') as id`,
      )
    ).id
    const svc = (await one(`select upsert_service(null, 'Wound care 59', 'other', 1500) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [svc, cat])
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select order_tests($1, $2, 'leg wound', 'consultation')`, [p.enc, [svc]])
    await as(staff.nurse)
    const list = (await one(`select desk_orders('nursing') as j`)).j
    const mine = list.find((x) => x.encounterId === p.enc)
    await db.query(`select set_request_status($1, 'cancelled', 'patient refused the dressing')`, [
      mine.id,
    ])
    await asAdmin()
    const r = await one(`select status::text from service_request where id = $1`, [mine.id])
    if (!mine || r.status !== 'cancelled') throw new Error(JSON.stringify({ mine, r }))
    return 'listed for Nursing; cancelled by the nurse'
  },
)
await step('0059: the triage colour reorders the waiting places', async () => {
  const p = await visitAt('Jeanne')
  await as(staff.nurse)
  await db.query(`select record_vitals($1, '{"temp": 39.8}'::jsonb, 'red')`, [p.enc])
  await asAdmin()
  const q = await one(`select priority from queue_entry where id = $1`, [p.queue])
  if (q.priority !== 1) throw new Error(JSON.stringify(q))
  return 'red → priority 1 at Consultation'
})
await step(
  '0059: a debt left by the manager is listed; reception books a phone caller',
  async () => {
    const p = await visitAt('Kevine')
    await as(staff.manager)
    const cons = (
      await one(`select upsert_service(null, 'Consultation 59', 'consultation', 4000) as id`)
    ).id
    await asAdmin()
    await db.query(`select add_charge_internal($1, 'consultation', $2)`, [p.enc, cons])
    await as(staff.manager)
    await db.query(`select end_visit($1, 'left without paying, will come back')`, [p.enc])
    await as(staff.cashier)
    const debts = (await one(`select unpaid_debts() as j`)).j
    const debt = debts.find((x) => x.encounterId === p.enc)
    await asAdmin()
    const patient = (await one(`select patient_id from encounter where id = $1`, [p.enc]))
      .patient_id
    await as(staff.receptionist)
    const appt = (
      await one(
        `select book_appointment($1, $2, date_trunc('hour', now()) + interval '3 days 2 hours', 'follow-up', 'phone') as id`,
        [patient, d3],
      )
    ).id
    await asAdmin()
    const a = await one(`select status::text, source::text from appointment where id = $1`, [appt])
    if (!debt || Number(debt.amount) !== 4000 || a.status !== 'approved' || a.source !== 'phone')
      throw new Error(JSON.stringify({ debt, a }))
    return `debt ${debt.amount} listed; phone booking approved, doctor asked to accept`
  },
)

// ---------------------------------------------------------------- 0060: desks polished
await step(
  '0060: an order line is removed only by the manager; taking records the doctor; urgent orders; lab reads the record',
  async () => {
    const p = await visitAt('Lina')
    await as(staff.manager)
    const labCat = (
      await one(`select save_category(null, 'Lab tests 60', null, null, 'lab') as id`)
    ).id
    const test = (await one(`select upsert_service(null, 'CRP 60', 'other', 2500) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [test, labCat])
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select order_tests($1, $2, 'sepsis?', null, 1)`, [p.enc, [test]])
    await asAdmin()
    const req = await one(`select id, priority from service_request where encounter_id = $1`, [
      p.enc,
    ])
    const line = await one(
      `select l.id from invoice_line l join invoice i on i.id = l.invoice_id where i.encounter_id = $1 and l.source_id = $2`,
      [p.enc, req.id],
    )
    const doctorOf = await one(
      `select pr.user_id from encounter e join practitioner pr on pr.id = e.practitioner_id where e.id = $1`,
      [p.enc],
    )
    let doctorRemove = 'ok'
    await as(d1)
    try {
      await db.query(`select void_charge($1, 'mistake')`, [line.id])
    } catch (e) {
      doctorRemove = String(e.message).split('\n')[0]
    }
    await as(staff.lab_tech)
    const record = (await one(`select visit_clinical($1) as v`, [p.enc])).v
    await db.query(`select set_request_status($1, 'cancelled', 'no reagent')`, [req.id])
    let resultOnCancelled = 'ok'
    try {
      await db.query(`select record_result($1, 'x', 'y', true)`, [req.id])
    } catch (e) {
      resultOnCancelled = String(e.message).split('\n')[0]
    }
    await asAdmin()
    if (
      req.priority !== 1 ||
      doctorOf?.user_id !== d1 ||
      !/comes from a test or order/.test(doctorRemove) ||
      !record?.orders?.length ||
      !/not done/.test(resultOnCancelled)
    )
      throw new Error(
        JSON.stringify({
          req,
          doctorOf,
          doctorRemove,
          orders: record?.orders?.length,
          resultOnCancelled,
        }),
      )
    return 'urgent (1); treating doctor recorded; line kept from the doctor; lab reads the record; no result on not done'
  },
)
await step('0060: answering a call does not pull a patient out of the lab', async () => {
  const p = await visitAt('Mireille')
  // the patient is at the laboratory (moved directly for the test)
  await asAdmin()
  await db.query(
    `update queue_entry set finished_at = now() where encounter_id = $1 and finished_at is null`,
    [p.enc],
  )
  await db.query(
    `insert into queue_entry (encounter_id, station, ticket_no) select $1, 'laboratory', ticket_no from queue_entry where encounter_id = $1 limit 1`,
    [p.enc],
  )
  const lab = await one(
    `select id from queue_entry where encounter_id = $1 and station = 'laboratory' and finished_at is null`,
    [p.enc],
  )
  await as(d3)
  const call = (await one(`select call_next('consultation', 'reception', null, null) as id`)).id
  let refused = ''
  await as(staff.receptionist)
  try {
    await db.query(`select answer_call($1, $2)`, [call, lab.id])
  } catch (e) {
    refused = String(e.message).split('\n')[0]
  }
  await as(d3)
  await db.query(`select cancel_call($1)`, [call])
  await asAdmin()
  if (!/not waiting for a doctor/.test(refused)) throw new Error(refused || 'not refused')
  return 'refused: the patient is at the laboratory'
})

// ---------------------------------------------------------------- 0061: loose ends
await step(
  '0061: a head sees the dashboard without the money; a task opens the visit to the nurse',
  async () => {
    await asAdmin()
    await db.query(`update profiles set dashboard = 'head' where id = $1`, [d2])
    await as(d2)
    const head = (await one(`select dashboard_summary(current_date - 7, current_date) as d`)).d
    await asAdmin()
    await db.query(`update profiles set dashboard = null where id = $1`, [d2])
    const p = await visitAt('Nadine')
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await as(staff.nurse)
    const before = (await one(`select may_work_on($1) as ok`, [p.enc])).ok
    await as(d1)
    const task = (
      await one(`select create_task($1, 'Injection: ceftriaxone 1 g IM') as id`, [p.enc])
    ).id
    await as(staff.nurse)
    const during = (await one(`select may_work_on($1) as ok`, [p.enc])).ok
    await db.query(`select complete_task($1)`, [task])
    const after = (await one(`select may_work_on($1) as ok`, [p.enc])).ok
    await asAdmin()
    const money = head.revenue30d.length + head.collections.length + (head.receivables ?? []).length
    if (money !== 0 || before || !during || after)
      throw new Error(JSON.stringify({ money, before, during, after }))
    return 'head: no money; nurse may work only while the task is open'
  },
)

// ---------------------------------------------------------------- 0062: the cash desk
await step(
  '0062: a wrong payment is cancelled by its cashier only; the cash count keeps the difference',
  async () => {
    const p = await visitAt('Olive')
    await as(staff.manager)
    const cons = (
      await one("select upsert_service(null, 'Consultation 62', 'consultation', 3000) as id")
    ).id
    await asAdmin()
    await db.query("select add_charge_internal($1, 'consultation', $2)", [p.enc, cons])
    await as(staff.cashier)
    const r = (await one("select take_payment($1, 'cash', 3000) as r", [p.enc])).r
    await asAdmin()
    const pay = (await one('select id from payment where receipt_no = $1', [r.receipt])).id
    let other = ''
    await as(staff.receptionist)
    try {
      await db.query("select void_payment($1, 'wrong patient')", [pay])
    } catch (e) {
      other = String(e.message).split('\n')[0]
    }
    await as(staff.cashier)
    const v = (await one("select void_payment($1, 'wrong patient') as v", [pay])).v
    await db.query("select take_payment($1, 'cash', 1000)", [p.enc])
    const close = (
      await one('select close_cash_day(null, $1::jsonb, $2) as c', [
        JSON.stringify({ cash: 900 }),
        'short 100',
      ])
    ).c
    const s = (await one('select cashier_summary() as s')).s
    await asAdmin()
    if (
      !/only the person who took/.test(other) ||
      Number(v.balance) !== 3000 ||
      Number(close.variance) >= 0 ||
      !s.voided.length ||
      !s.closes.length
    )
      throw new Error(
        JSON.stringify({ other, v, close, voided: s.voided.length, closes: s.closes.length }),
      )
    return `cancelled (owed again ${v.balance}); count difference ${close.variance}`
  },
)

// ---------------------------------------------------------------- 0063: the desks' last items
await step(
  '0063: a verified result is corrected with its reason; an emptied bill comes to 0; tasks withdrawn; heads see their department',
  async () => {
    const p = await visitAt('Gloria')
    await as(staff.manager)
    const labCat = (
      await one(`select save_category(null, 'Lab tests 63', null, null, 'lab') as id`)
    ).id
    const test = (await one(`select upsert_service(null, 'Malaria RDT 63', 'other', 1500) as id`))
      .id
    await db.query(`select set_service_category($1, $2)`, [test, labCat])
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select order_tests($1, $2, 'fever', null)`, [p.enc, [test]])
    await asAdmin()
    const req = (await one(`select id from service_request where encounter_id = $1`, [p.enc])).id
    await as(staff.lab_tech)
    await db.query(`select record_result($1, 'negative', 'no malaria', true)`, [req])
    let rewrite = 'ok'
    try {
      await db.query(`select record_result($1, 'positive', 'malaria', false)`, [req])
    } catch (e) {
      rewrite = String(e.message).split('\n')[0]
    }
    await db.query(`select correct_result($1, 'positive', 'P. falciparum', 'wrong sample label')`, [
      req,
    ])
    // the lab sees the vitals stamp on its queue (no clinical rights)
    await as(d1)
    await db.query(`select record_vitals($1, '{"temp": 38.4}'::jsonb, 'yellow')`, [p.enc])
    await as(staff.lab_tech)
    const stamp = await one(
      `select count(*)::int as n from queue_board where encounter_id = $1 and vitals_at is not null`,
      [p.enc],
    )
    await asAdmin()
    const rep = await one(
      `select d.impression, d.verified_at is not null as verified, d.corrected_at is not null as corrected,
              (select count(*)::int from report_correction rc where rc.report_id = d.id) as kept
       from diagnostic_report d where d.service_request_id = $1`,
      [req],
    )
    const notice = await one(
      `select count(*)::int as n from notification where kind = 'result' and (params ->> 'corrected')::boolean`,
    )
    // a bill whose only line is removed comes back to 0
    const inv = await one(`select id from invoice where encounter_id = $1`, [p.enc])
    await db.query(`update invoice_line set deleted_at = now() where invoice_id = $1`, [inv.id])
    await db.query(`select recompute_invoice($1)`, [inv.id])
    const total = Number((await one(`select total from invoice where id = $1`, [inv.id])).total)
    // a doctor's task: the nurse says it could not be done; the doctor is told
    await as(d1)
    const task = (await one(`select create_task($1, 'Wound dressing') as id`, [p.enc])).id
    await as(staff.nurse)
    await db.query(`select cancel_task($1, 'patient refused')`, [task])
    await asAdmin()
    const told = await one(
      `select count(*)::int as n from notification where kind = 'task_done' and (params ->> 'notDone')::boolean`,
    )
    // the head of a department sees it; a member does not
    await as(staff.manager)
    const dept = (
      await one(`select upsert_department(null, 'Laboratory 63', '', '{lab_tech}') as id`)
    ).id
    await asAdmin()
    await db.query(
      `insert into staff_department (profile_id, department_id, position) values ($1, $2, 'head'), ($3, $2, 'member')`,
      [staff.lab_tech, dept, staff.cashier],
    )
    await as(staff.lab_tech)
    const ds = (
      await one(`select department_summary($1, current_date - 1, current_date) as d`, [dept])
    ).d
    let member = 'ok'
    await as(staff.cashier)
    try {
      await db.query(`select department_summary($1, current_date, current_date)`, [dept])
    } catch (e) {
      member = String(e.message).split('\n')[0]
    }
    // the reorder level: one rule (a level set and reached)
    await as(staff.pharmacist)
    const item = (await one(`select upsert_item(null, 'Paracetamol 63', 50) as id`)).id
    await db.query(`select set_reorder_level($1, 10)`, [item])
    await asAdmin()
    const low = await one(`select count(*)::int as n from items_below_reorder where item_id = $1`, [
      item,
    ])
    await db.query(`delete from staff_department where department_id = $1`, [dept])
    if (
      !/verified/.test(rewrite) ||
      rep.impression !== 'P. falciparum' ||
      !rep.verified ||
      !rep.corrected ||
      rep.kept !== 1 ||
      notice.n < 1 ||
      total !== 0 ||
      told.n < 1 ||
      stamp.n < 1 ||
      !ds.members.length ||
      !/not allowed/.test(member) ||
      low.n !== 1
    )
      throw new Error(
        JSON.stringify({
          rewrite,
          rep,
          notice,
          total,
          told,
          stamp,
          members: ds.members.length,
          member,
          low,
        }),
      )
    return 'correction kept with reason; empty bill 0; not-done told; department head only; reorder at 10'
  },
)

// ---------------------------------------------------------------- 0064: cashier, lab, pharmacy desks
await step(
  '0064: a hand-over undone comes off the bill; the overpaid money is given back; counts corrected; a lab call takes no doctor patient',
  async () => {
    const p = await visitAt('Rosine')
    await as(staff.manager)
    const item = (
      await one(`select upsert_item(null, 'Ibuprofen 64', 100, '400 mg', 'tablet', 'tab') as id`)
    ).id
    const main = (await one(`select id from stock_location where type = 'main_store' limit 1`)).id
    const pharm = (
      await one(`select id from stock_location where type = 'pharmacy' and active limit 1`)
    ).id
    let noExpiry = 'ok'
    try {
      await db.query(`select receive_stock($1, $2, 10, 50)`, [item, main])
    } catch (e) {
      noExpiry = String(e.message).split('\n')[0]
    }
    await db.query(`select receive_stock($1, $2, 40, 50, 'IBU-64', '2029-06-30')`, [item, main])
    await db.query(`select transfer_stock($1, $2, $3, 20)`, [item, main, pharm])
    // the main store holds 18, not 20: the count is corrected with its reason
    const diff = (await one(`select adjust_stock($1, $2, 18, 'monthly count') as d`, [item, main]))
      .d
    // prescribed, handed over, paid, then brought back: off the bill, money given back
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    const rx = (
      await one(
        `select prescribe($1, $2, 5, '1 tab', 'oral', 'three times a day', 2, null, 'pharmacy') as j`,
        [p.enc, item],
      )
    ).j
    await as(staff.pharmacist)
    await db.query(`select dispense_prescription($1)`, [rx.id])
    await as(staff.cashier)
    await db.query(`select take_payment($1, 'cash', 500)`, [p.enc])
    await as(staff.pharmacist)
    const back = (await one(`select return_medicine($1, 'wrong strength') as r`, [rx.id])).r
    const inPharm = Number(
      (
        await one(
          `select coalesce(sum(quantity), 0) as n from stock_on_hand where item_id = $1 and location_id = $2`,
          [item, pharm],
        )
      ).n,
    )
    await as(staff.cashier)
    let tooMuch = 'ok'
    try {
      await db.query(`select refund_payment($1, 900, 'cash', 'returned medicine')`, [p.enc])
    } catch (e) {
      tooMuch = String(e.message).split('\n')[0]
    }
    const refunded = (
      await one(`select refund_payment($1, 500, 'cash', 'returned medicine') as r`, [p.enc])
    ).r
    const day = (await one(`select cashier_summary() as s`)).s
    // a lab call never pulls a patient waiting for the doctor
    const q2 = await visitAt('Divine')
    await as(staff.lab_tech)
    const call = (await one(`select call_next('laboratory', 'reception', null, null) as id`)).id
    let labPull = 'ok'
    await as(staff.receptionist)
    try {
      await db.query(`select answer_call($1, $2)`, [call, q2.queue])
    } catch (e) {
      labPull = String(e.message).split('\n')[0]
    }
    await as(staff.lab_tech)
    await db.query(`select cancel_call($1)`, [call]).catch(() => {})
    await asAdmin()
    if (
      !/expiry/.test(noExpiry) ||
      Number(diff) !== -2 ||
      Number(back.balance) !== -500 ||
      inPharm !== 20 ||
      !/at most/.test(tooMuch) ||
      Number(refunded.balance) !== 0 ||
      Number(day.refunded) < 500 ||
      !/only a patient already sent/.test(labPull)
    )
      throw new Error(
        JSON.stringify({
          noExpiry,
          diff,
          back,
          inPharm,
          tooMuch,
          refunded,
          refundedDay: day.refunded,
          labPull,
        }),
      )
    return 'count -2 kept; returned to the shelf; 500 given back (not 900); lab call refused a doctor patient'
  },
)

// ---------------------------------------------------------------- 0065: manager, reception, doctor
await step(
  '0065: duplicate files merged; phones match however written; the manager is told what is owed; a result is marked seen',
  async () => {
    // the same person twice: the duplicate's visit moves, its number still finds the patient
    await as(staff.receptionist)
    const keep = (
      await one(
        `select register_patient_file('Habimana', 'Jean 65', 'male', null, 40, '0788650001') as r`,
      )
    ).r
    const dup = (
      await one(
        `select register_patient_file('Habimana', 'Jean Bosco 65', 'male', null, 40, '+250788650001') as r`,
      )
    ).r
    const v = (
      await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [dup.patient_id])
    ).id
    await asAdmin()
    const same = (await one(`select phone_key('+250 788 650 001') = phone_key('0788650001') as ok`))
      .ok
    let notManager = 'ok'
    await as(staff.receptionist)
    try {
      await db.query(`select merge_patients($1, $2)`, [keep.patient_id, dup.patient_id])
    } catch (e) {
      notManager = String(e.message).split('\n')[0]
    }
    await as(staff.manager)
    const m = (await one(`select merge_patients($1, $2) as m`, [keep.patient_id, dup.patient_id])).m
    await asAdmin()
    const moved = (await one(`select patient_id from encounter where id = $1`, [v])).patient_id
    const alias = await one(`select patient_id from patient_alias where file_number = $1`, [
      dup.file_number,
    ])
    // leaving with money owed: the manager is told how much
    await as(staff.manager)
    const cons = (
      await one(`select upsert_service(null, 'Consultation 65', 'consultation', 4000) as id`)
    ).id
    await asAdmin()
    await db.query(`select add_charge_internal($1, 'consultation', $2)`, [v, cons])
    let owed = ''
    await as(staff.manager)
    try {
      await db.query(`select end_visit($1)`, [v])
    } catch (e) {
      owed = String(e.message).split('\n')[0]
    }
    await db.query(`select end_visit($1, 'went home, will pay tomorrow')`, [v])
    // a result the doctor has seen leaves "to review"
    const p = await visitAt('Seen65')
    await as(staff.manager)
    const cat = (await one(`select save_category(null, 'Lab tests 65', null, null, 'lab') as id`))
      .id
    const test = (await one(`select upsert_service(null, 'Glucose 65', 'other', 1000) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [test, cat])
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select order_tests($1, $2, 'thirst', null)`, [p.enc, [test]])
    await asAdmin()
    const req = (await one(`select id from service_request where encounter_id = $1`, [p.enc])).id
    await as(staff.lab_tech)
    await db.query(`select record_result($1, '5.4 mmol/L', 'normal', true)`, [req])
    await as(d1)
    const before = (await one(`select home_summary() as s`)).s.results.find(
      (r) => r.encounterId === p.enc,
    )
    await db.query(`select mark_result_reviewed($1)`, [before.id])
    const after = (await one(`select home_summary() as s`)).s.results.find(
      (r) => r.encounterId === p.enc,
    )
    await asAdmin()
    if (
      !same ||
      !/only the manager/.test(notManager) ||
      moved !== keep.patient_id ||
      alias?.patient_id !== keep.patient_id ||
      Number(m.moved) < 1 ||
      !/still due \(4000/.test(owed) ||
      before.reviewed ||
      !after.reviewed
    )
      throw new Error(JSON.stringify({ same, notManager, moved, alias, m, owed, before, after }))
    return 'merged (visit moved, old number kept); owed 4000 said; result marked seen'
  },
)

// ---------------------------------------------------------------- 0066: public site, sign-in, catalogue
await step(
  '0066: sample calendars cannot be booked; overlapping times are taken; lock-screen wrong PINs are counted; a moved category leaves its other departments',
  async () => {
    // a sample doctor with no account is not on the site, so not bookable
    await as(null, 'anon')
    let sample = 'ok'
    try {
      await db.query(
        `select create_appointment_inquiry('hj', now() + interval '2 days', 'Sample Test', '0788 066 001')`,
      )
    } catch (e) {
      sample = String(e.message).split('\n')[0]
    }
    // half an hour into a 60-minute booking of the dentist: taken
    let overlap = 'ok'
    try {
      await db.query(
        `select create_appointment_inquiry('nf', ($1::timestamptz + interval '30 minutes'), 'Overlap Test', '0788 066 002')`,
        [slot],
      )
    } catch (e) {
      overlap = String(e.message).split('\n')[0]
    }
    // wrong PINs at the lock screen
    await as(staff.cashier)
    await db.query(`select record_wrong_pin('lock screen')`)
    const n = (await one(`select record_wrong_pin('lock screen') as n`)).n
    // a category moved into one department leaves the others
    await as(staff.manager)
    const a = (await one(`select upsert_department(null, 'Dept A 66', '', '{doctor}') as id`)).id
    const b = (await one(`select upsert_department(null, 'Dept B 66', '', '{doctor}') as id`)).id
    const cat = (
      await one(`select save_category(null, 'Category 66', null, null, 'treatment') as id`)
    ).id
    const svc = (await one(`select upsert_service(null, 'Service 66', 'consultation', 1000) as id`))
      .id
    await db.query(`select set_service_category($1, $2)`, [svc, cat])
    await asAdmin()
    await db.query(`insert into service_department (service_id, department_id) values ($1, $2)`, [
      svc,
      a,
    ])
    await as(staff.manager)
    await db.query(`select move_category_to_department($1, $2)`, [cat, b])
    await asAdmin()
    const depts = (
      await db.query(`select department_id from service_department where service_id = $1`, [svc])
    ).rows.map((r) => r.department_id)
    if (
      !/unknown practitioner/.test(sample) ||
      !/just been taken/.test(overlap) ||
      Number(n) < 2 ||
      depts.length !== 1 ||
      depts[0] !== b
    )
      throw new Error(JSON.stringify({ sample, overlap, n, depts }))
    return 'sample refused; overlap refused; 2 wrong PINs counted; category only in its new department'
  },
)

// ---------------------------------------------------------------- 0067: register first, then send
await step(
  '0067: the file first, then where the visit starts: a desk by service and its department, or "I see this patient myself"',
  async () => {
    const reg = async (given) => {
      await as(staff.receptionist)
      return (
        await one(`select register_patient_file('Kamanzi', $1, 'female', null, 30, null) as r`, [
          given,
        ])
      ).r
    }
    // reception sends a patient to Dental, the dental department, with what she comes for
    await as(staff.manager)
    const dept = (
      await one(`select upsert_department(null, 'Dental care 67', '', '{doctor}') as id`)
    ).id
    const a = await reg('Aline 67')
    await as(staff.receptionist)
    const v1 = (
      await one(`select begin_visit($1, 'dental', $2, 'toothache', false, false) as v`, [
        a.patient_id,
        dept,
      ])
    ).v
    await asAdmin()
    const q1 = await one(
      `select station::text, department_id, referral_note, taken_by from queue_entry where encounter_id = $1`,
      [v1.encounter_id],
    )
    // reception cannot "see the patient myself"
    const b = await reg('Belise 67')
    let notMine = 'ok'
    await as(staff.receptionist)
    try {
      await db.query(`select begin_visit($1, 'consultation', null, null, true, false)`, [
        b.patient_id,
      ])
    } catch (e) {
      notMine = String(e.message).split('\n')[0]
    }
    // the doctor registers and treats: the visit is theirs at once
    await as(d1)
    const v2 = (
      await one(`select begin_visit($1, 'consultation', null, 'fever', true, false) as v`, [
        b.patient_id,
      ])
    ).v
    await asAdmin()
    const q2 = await one(
      `select taken_by, started_at is not null as started from queue_entry where encounter_id = $1`,
      [v2.encounter_id],
    )
    // with "triage first" on, a desk choice starts at triage; "myself" still starts at the desk
    await db.query(
      `insert into setting (key, value) values ('flow', '{"triage_first": true}') on conflict (key) do update set value = excluded.value`,
    )
    const c = await reg('Claire 67')
    await as(staff.receptionist)
    const v3 = (
      await one(`select begin_visit($1, 'dental', null, null, false, false) as v`, [c.patient_id])
    ).v
    const d = await reg('Diane 67')
    await as(d1)
    const v4 = (
      await one(`select begin_visit($1, 'consultation', null, null, true, false) as v`, [
        d.patient_id,
      ])
    ).v
    await asAdmin()
    await db.query(`update setting set value = '{"triage_first": false}' where key = 'flow'`)
    if (
      q1.station !== 'dental' ||
      q1.department_id !== dept ||
      q1.referral_note !== 'toothache' ||
      q1.taken_by ||
      !/do not work at/.test(notMine) ||
      q2.taken_by !== d1 ||
      !q2.started ||
      v3.station !== 'triage' ||
      v4.station !== 'consultation'
    )
      throw new Error(JSON.stringify({ q1, notMine, q2, v3: v3.station, v4: v4.station }))
    return 'dental + department + note; reception not "myself"; doctor takes at once; triage first respected'
  },
)

// ---------------------------------------------------------------- 0068: bookings and calendars by role
await step(
  "0068: reception books, the calendar's doctor accepts (and may move the time); the manager oversees; calendars by role",
  async () => {
    // a request for the dentist; the manager may not book it, reception does
    await as(null, 'anon')
    const when = new Date(Date.parse(slot) + 14 * 86_400_000).toISOString()
    const ref = (
      await one(
        `select create_appointment_inquiry('nf', $1::timestamptz, 'Role Test', '0788 068 001') as ref`,
        [when],
      )
    ).ref
    await asAdmin()
    const appt = (await one(`select id from appointment where reference = $1`, [ref])).id
    const toDoctor = await one(
      `select count(*)::int as n from notification where kind = 'inquiry' and recipient_user = $1 and params ->> 'appointment' = $2`,
      [dentist, appt],
    )
    const toManager = await one(
      `select count(*)::int as n from notification where kind = 'inquiry' and recipient_role = 'manager' and params ->> 'appointment' = $1`,
      [appt],
    )
    let manager = 'ok'
    await as(staff.manager)
    try {
      await db.query(`select approve_inquiry($1, $2)`, [appt, patientId])
    } catch (e) {
      manager = String(e.message).split('\n')[0]
    }
    await as(staff.receptionist)
    await db.query(`select approve_inquiry($1, $2)`, [appt, patientId])
    // another doctor cannot accept it; the dentist accepts it one hour later
    let other = 'ok'
    await as(d1)
    try {
      await db.query(`select accept_appointment($1)`, [appt])
    } catch (e) {
      other = String(e.message).split('\n')[0]
    }
    await as(dentist)
    const moved = (
      await one(`select accept_appointment($1, $2::timestamptz + interval '1 hour') as r`, [
        appt,
        when,
      ])
    ).r
    await asAdmin()
    const a = await one(`select status::text, starts_at from appointment where id = $1`, [appt])
    // calendars: reception sees the dentist's shared calendar; a doctor of another department does not
    await db.query(`update practitioner set calendar_visibility = 'staff' where user_id = $1`, [
      dentist,
    ])
    await as(staff.receptionist)
    const desk = (await one(`select staff_doctor_calendars() as c`)).c
    await as(d1)
    const doctor = (await one(`select staff_doctor_calendars() as c`)).c
    await asAdmin()
    const has = (list) => list.some((x) => x.userId === dentist)
    if (
      toDoctor.n !== 1 ||
      toManager.n !== 0 ||
      !/not allowed/.test(manager) ||
      !/only the doctor of this calendar/.test(other) ||
      !moved.moved ||
      a.status !== 'confirmed' ||
      new Date(a.starts_at).getTime() !== Date.parse(when) + 3_600_000 ||
      !has(desk) ||
      has(doctor)
    )
      throw new Error(
        JSON.stringify({
          toDoctor,
          toManager,
          manager,
          other,
          moved,
          a,
          desk: has(desk),
          doctor: has(doctor),
        }),
      )
    return 'doctor told, manager not; manager refused; other doctor refused; moved +1 h; calendars by role'
  },
)

// ---------------------------------------------------------------- 0069: send by service, to the section or one person
await step(
  '0069: a service is its section; its people with their load; send to one of them; after triage the patient reaches them',
  async () => {
    // the dentist does circumcision too (written in the calendar's services)
    await asAdmin()
    await db.query(`update practitioner set categories = '{dental,circ}' where user_id = $1`, [
      dentist,
    ])
    await as(staff.receptionist)
    const circ = (await one(`select service_staff('circ') as s`)).s
    const consult = (await one(`select service_staff('consultation') as s`)).s
    const reg = async (given) =>
      (
        await one(`select register_patient_file('Habineza', $1, 'male', null, 9, null) as r`, [
          given,
        ])
      ).r
    const a = await reg('Eric 69')
    // a person who does not give the service is refused
    let wrong = 'ok'
    try {
      await db.query(
        `select begin_visit(p_patient_id => $1, p_service => 'circ', p_assigned_to => $2)`,
        [a.patient_id, d1],
      )
    } catch (e) {
      wrong = String(e.message).split('\n')[0]
    }
    const v1 = (
      await one(
        `select begin_visit(p_patient_id => $1, p_service => 'circ', p_assigned_to => $2, p_note => 'circumcision 9 years') as v`,
        [a.patient_id, dentist],
      )
    ).v
    await asAdmin()
    const q1 = await one(
      `select station::text, assigned_to, service from queue_entry where encounter_id = $1`,
      [v1.encounter_id],
    )
    const told = await one(
      `select count(*)::int as n from notification where kind = 'referral' and recipient_user = $1 and params ->> 'queue' = (select id::text from queue_entry where encounter_id = $2)`,
      [dentist, v1.encounter_id],
    )
    await as(staff.receptionist)
    const load = (await one(`select service_staff('circ') as s`)).s.staff.find(
      (p) => p.id === dentist,
    )
    // triage first: the nurse measures, then the patient reaches the dentist at Dental
    await asAdmin()
    await db.query(
      `insert into setting (key, value) values ('flow', '{"triage_first": true}') on conflict (key) do update set value = excluded.value`,
    )
    const b = await (async () => {
      await as(staff.receptionist)
      return reg('Fils 69')
    })()
    await as(staff.receptionist)
    const v2 = (
      await one(
        `select begin_visit(p_patient_id => $1, p_service => 'dental', p_assigned_to => $2) as v`,
        [b.patient_id, dentist],
      )
    ).v
    await as(staff.nurse)
    await db.query(`select record_vitals($1, '{"temp": 36.8}'::jsonb, 'green', 'dental')`, [
      v2.encounter_id,
    ])
    await asAdmin()
    await db.query(`update setting set value = '{"triage_first": false}' where key = 'flow'`)
    const q2 = await one(
      `select station::text, assigned_to, service from queue_entry where encounter_id = $1 and station = 'dental' and finished_at is null`,
      [v2.encounter_id],
    )
    if (
      !circ.staff.some((p) => p.id === dentist) ||
      consult.staff.some((p) => p.id === dentist) ||
      !/does not give this service/.test(wrong) ||
      q1.station !== 'theatre' ||
      q1.assigned_to !== dentist ||
      q1.service !== 'circ' ||
      told.n < 1 ||
      !load ||
      Number(load.waiting) < 1 ||
      v2.station !== 'triage' ||
      q2?.assigned_to !== dentist ||
      q2?.service !== 'dental'
    )
      throw new Error(
        JSON.stringify({ circ: circ.staff.length, wrong, q1, told, load, v2: v2.station, q2 }),
      )
    return 'circ lists the dentist; wrong person refused; sent to the dentist at Minor surgery (told, load 1); after triage at Dental with the dentist'
  },
)

// ---------------------------------------------------------------- 0070: a named triage nurse; the visit's track
await step(
  '0070: triage to one named nurse (the other nurses do not get the patient); the track has the treatment and the bill',
  async () => {
    await asAdmin()
    const nurse2 = (
      await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [
        'a.umutoni@staff.muhaziclinic.rw',
        JSON.stringify({
          username: 'a.umutoni',
          full_name: 'Umutoni Aline',
          role: 'nurse',
          station: 'Triage',
        }),
      ])
    ).id
    await as(staff.receptionist)
    const tri = (await one(`select service_staff('triage') as s`)).s
    const r = (
      await one(`select register_patient_file('Gasana', 'Yves 70', 'male', null, 33, null) as r`)
    ).r
    const v = (
      await one(
        `select begin_visit(p_patient_id => $1, p_station => 'triage', p_triage_to => $2) as v`,
        [r.patient_id, staff.nurse],
      )
    ).v
    await asAdmin()
    const q = await one(
      `select id, station::text, assigned_to from queue_entry where encounter_id = $1`,
      [v.encounter_id],
    )
    await as(nurse2)
    const other = (await one(`select queue_entry_for_me($1) as ok`, [q.id])).ok
    await as(staff.nurse)
    const mine = (await one(`select queue_entry_for_me($1) as ok`, [q.id])).ok
    // reception now only follows this patient
    await as(staff.receptionist)
    const access = (await one(`select visit_access($1) as a`, [v.encounter_id])).a
    const track = (await one(`select visit_journey($1) as j`, [v.encounter_id])).j
    await asAdmin()
    if (
      !tri.staff.some((p) => p.id === staff.nurse) ||
      !tri.staff.some((p) => p.id === nurse2) ||
      q.station !== 'triage' ||
      q.assigned_to !== staff.nurse ||
      other ||
      !mine ||
      access.canRoute !== false ||
      !('treatmentDoneAt' in track) ||
      track.steps.length !== 1
    )
      throw new Error(
        JSON.stringify({ tri: tri.staff.length, q, other, mine, access, keys: Object.keys(track) }),
      )
    return 'both nurses listed; sent to one; the other cannot take; reception follows; track fields'
  },
)

await step(
  '0071: a section is its people, not a role: a nurse set in Consultation takes and is told',
  async () => {
    await asAdmin()
    const nurse2 = (await one(`select id from profiles where username = 'a.umutoni'`)).id
    await as(staff.manager)
    const dep = (
      await one(
        `select upsert_department(null, 'Consultation 71', null, '{}', array['consultation']) as id`,
      )
    ).id
    await asAdmin()
    await db.query(
      `insert into staff_department (profile_id, department_id, position) values ($1, $2, 'member')`,
      [nurse2, dep],
    )
    await as(staff.receptionist)
    const list = (await one(`select service_staff('consultation') as s`)).s
    const r = (
      await one(`select register_patient_file('Mutesi', 'Grace 71', 'female', null, 29, null) as r`)
    ).r
    const v = (
      await one(
        `select begin_visit(p_patient_id => $1, p_station => 'consultation', p_service => 'consultation') as v`,
        [r.patient_id],
      )
    ).v
    await asAdmin()
    const q = await one(
      `select id from queue_entry where encounter_id = $1 and station = 'consultation'`,
      [v.encounter_id],
    )
    const may = {}
    const told = {}
    for (const [k, id] of [
      ['nurse2', nurse2],
      ['nurse', staff.nurse],
      ['doctor', staff.doctor],
    ]) {
      await as(id)
      may[k] = (await one(`select queue_entry_for_me($1) as ok`, [q.id])).ok
      const n = (await one(`select my_notifications(200) as n`)).n
      told[k] = n.items.some(
        (x) => x.link?.includes(v.encounter_id) && ['queue', 'referral'].includes(x.kind),
      )
    }
    // the nurse of Consultation takes; then sends on to Family planning (at Nursing)
    await as(nurse2)
    await db.query(`select take_patient($1)`, [q.id])
    await db.query(
      `select refer_patient($1, 'consultation', 'nursing', null, 'family planning', false, null, 'fp')`,
      [v.encounter_id],
    )
    await asAdmin()
    const fp = await one(
      `select id, service from queue_entry where encounter_id = $1 and station = 'nursing' and finished_at is null`,
      [v.encounter_id],
    )
    await as(staff.nurse)
    const nurseFp = (await one(`select queue_entry_for_me($1) as ok`, [fp.id])).ok
    await as(staff.doctor)
    const doctorFp = (await one(`select queue_entry_for_me($1) as ok`, [fp.id])).ok
    await asAdmin()
    if (
      !list.staff.some((p) => p.id === nurse2) ||
      !may.nurse2 ||
      may.nurse ||
      !may.doctor ||
      !told.nurse2 ||
      told.nurse ||
      fp.service !== 'fp' ||
      !nurseFp ||
      doctorFp
    )
      throw new Error(JSON.stringify({ may, told, fp, nurseFp, doctorFp, n: list.staff.length }))
    return 'nurse of Consultation listed, may take, told (other nurse not); FP at Nursing for nurses'
  },
)

await step('0072: every role reads every view the app reads (the bill loads for all)', async () => {
  const views = [
    'catalogue_services',
    'items_catalogue',
    'items_below_reorder',
    'queue_board',
    'staff_directory',
    'visit_bill',
    'visit_charges',
    'visit_vitals',
    'public_practitioners',
    'public_booked_slots',
  ]
  const bad = []
  for (const role of [
    'manager',
    'receptionist',
    'nurse',
    'doctor',
    'cashier',
    'lab_tech',
    'pharmacist',
  ]) {
    await as(staff[role])
    for (const v of views) {
      try {
        await db.query(`select * from ${v} limit 3`)
      } catch (e) {
        bad.push(`${role} ${v}: ${e.message}`)
      }
    }
  }
  await asAdmin()
  if (bad.length) throw new Error(bad.join(' | '))
  return `${views.length} views read by 7 roles`
})

await step(
  '0073: one head per department; the previous head becomes assistant head (a deputy with the dashboard)',
  async () => {
    await as(staff.manager)
    const dep = (await one(`select upsert_department(null, 'Ward 73', null, '{}', null) as id`)).id
    await asAdmin()
    await db.query(
      `insert into staff_department (profile_id, department_id, position) values ($1, $2, 'head')`,
      [staff.nurse, dep],
    )
    await db.query(
      `insert into staff_department (profile_id, department_id, position) values ($1, $2, 'head')`,
      [staff.doctor, dep],
    )
    const rows = (
      await db.query(`select profile_id, position from staff_department where department_id = $1`, [
        dep,
      ])
    ).rows
    const pos = Object.fromEntries(rows.map((r) => [r.profile_id, r.position]))
    const nurse = await one(`select dashboard, head_of from profiles where id = $1`, [staff.nurse])
    const doctor = await one(`select dashboard, head_of from profiles where id = $1`, [
      staff.doctor,
    ])
    // the assistant head reads the department's figures
    await as(staff.nurse)
    const summary = (
      await one(`select department_summary($1, current_date, current_date) as s`, [dep])
    ).s
    // made a plain member again: the department dashboard goes (unless head or assistant elsewhere)
    await asAdmin()
    await db.query(
      `update staff_department set position = 'member' where profile_id = $1 and department_id = $2`,
      [staff.nurse, dep],
    )
    const lead = (
      await one(
        `select exists (select 1 from staff_department where profile_id = $1 and position in ('head','assistant')) as l`,
        [staff.nurse],
      )
    ).l
    const after = await one(`select dashboard from profiles where id = $1`, [staff.nurse])
    const heads = (
      await one(
        `select count(*)::int as n from staff_department where department_id = $1 and position = 'head'`,
        [dep],
      )
    ).n
    if (
      pos[staff.doctor] !== 'head' ||
      pos[staff.nurse] !== 'assistant' ||
      heads !== 1 ||
      doctor.dashboard !== 'head' ||
      doctor.head_of !== 'Ward 73' ||
      nurse.dashboard !== 'head' ||
      !summary ||
      after.dashboard !== (lead ? 'head' : null)
    )
      throw new Error(JSON.stringify({ pos, heads, nurse, doctor, after, lead }))
    return 'doctor head, nurse moved to assistant (dashboard kept), member again → no dashboard'
  },
)

finish()

function finish() {
  const pad = (s, n) => String(s).padEnd(n)
  console.log('')
  for (const r of results) console.log(`${r.ok ? ' ok ' : 'FAIL'}  ${pad(r.step, 62)} ${r.detail}`)
  console.log('')
  console.log(`${results.length - failures}/${results.length} checks passed`)
  process.exit(failures ? 1 : 0)
}
