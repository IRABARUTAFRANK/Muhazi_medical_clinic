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
// 0092: staff_login_email checks the PIN against the Auth password hash (bcrypt, pgcrypto).
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'supabase', 'migrations')

const STUB = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
-- Supabase grants these to its API roles by default.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;
`

const db = new PGlite({ extensions: { pgcrypto } })
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
// The access token says how the session was opened (`amr`): the e-mailed code by default.
// (0081: the code counts for 15 minutes after it was typed: `timestamp` is now.)
const CODE_AMR = JSON.stringify({
  amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }],
})
const PIN_AMR = JSON.stringify({ amr: [{ method: 'password', timestamp: 0 }] })
const as = async (userId, role = 'authenticated', claims = CODE_AMR) => {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '${userId ?? ''}', false); select set_config('request.jwt.claims', '${claims}', false); set role ${role};`,
  )
}
/** 0081: a session approved by the database (as after the e-mailed code), for calls that ask. */
const asApproved = async (userId) => {
  const sid = crypto.randomUUID()
  await asAdmin()
  await db.query(
    `insert into approved_session (session_id, user_id, via) values ($1, $2, 'code')`,
    [sid, userId],
  )
  await as(
    userId,
    'authenticated',
    JSON.stringify({ sub: userId, session_id: sid, amr: JSON.parse(CODE_AMR).amr }),
  )
}
/** A session opened with the PIN alone (no e-mailed code). */
const asPinOnly = (userId) => as(userId, 'authenticated', PIN_AMR)
const asAdmin = async () =>
  db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '', false);`,
  )

// ---------------------------------------------------------------- schema
await step('stub Supabase auth schema and roles', async () => {
  await db.exec(STUB)
})
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
// 0079: a browser key made under the old 30-day rule, just before the migration that ends them.
const oldKey = 'q'.repeat(40)
let oldKeyUser = null
for (const f of files) {
  if (f === '20261120090000_session_hours.sql') {
    await step('0079: plant a 30-day browser key from before the rule', async () => {
      oldKeyUser = (
        await one(
          `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
          [
            'oldkey@staff.muhaziclinic.rw',
            JSON.stringify({ username: 'oldkey', full_name: 'Old Key', role: 'nurse' }),
          ],
        )
      ).id
      await db.query(
        `insert into trusted_device (user_id, token_hash, label, created_at, expires_at, last_used_at)
         values ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), 'old browser',
                 now() - interval '1 day', now() + interval '29 days', now() - interval '1 day')`,
        [oldKeyUser, oldKey],
      )
      return '29 days left'
    })
  }
  await step(`migration ${f}`, async () => {
    await db.exec(await readFile(path.join(migrationsDir, f), 'utf8'))
  })
}
if (failures) finish()
await step('0079: keys made under the old 30-day rule no longer skip the code', async () => {
  await as(oldKeyUser)
  const used = (await one(`select use_trusted_device($1) as e`, [oldKey])).e
  const extended = (await one(`select extend_this_device($1) as e`, [oldKey])).e
  await asAdmin()
  const r = await one(
    `select revoked_at from trusted_device where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [oldKey],
  )
  // the test person leaves no trace for the checks below
  await db.query(`delete from auth.users where id = $1`, [oldKeyUser])
  await db.query(`delete from profiles where id = $1`, [oldKeyUser])
  if (used || extended || !r?.revoked_at) throw new Error(JSON.stringify({ used, extended, r }))
  return 'ended by the migration: not used, not extended'
})
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
  // the file is made behind the registration function (direct table writes are closed to staff)
  await asAdmin()
  const r = await one(
    `insert into patient (surname, given_names, sex, birth_date, phone_1, consent_treatment, consent_messages, consent_insurer)
     values ('Niyonzima', 'Jean Bosco', 'male', '1972-03-14', '0788123456', true, true, true) returning id, file_number`,
  )
  await as(staff.receptionist)
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
  await asAdmin()
  const r = await one(
    `insert into coverage (patient_id, payer_id, plan_id, member_number)
     select $1, p.id, pl.id, '1197280012345678' from payer p join plan pl on pl.payer_id = p.id where p.code = 'RAMA'
     returning id`,
    [patientId],
  )
  await as(staff.receptionist)
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
  // 0085: the clinical tables are written by the desk functions only
  /row-level security|permission denied/i,
)
await step('nurse records vitals and triage', async () => {
  // 0085: the clinical tables are written by the desk functions only; the journey writes them as
  // their owner, with the nurse's identity
  await as(staff.nurse, 'postgres')
  await db.query(
    `insert into observation (encounter_id, code, value_num, unit) values ($1, 'bp_sys', 128, 'mmHg')`,
    [encounterId],
  )
  await db.query(
    `update encounter set triage_level = 'yellow', triage_reason = 'fever 3 days' where id = $1`,
    [encounterId],
  ) // the nurse sends the patient on to the doctors
  await as(staff.nurse)
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
  // 0085: written by the desk functions only (add_diagnosis); here as the owner, as the doctor
  await as(staff.doctor, 'postgres')
  await db.query(
    `insert into condition (encounter_id, icd10_code, text, type) values ($1, 'B54', 'Malaria', 'primary')`,
    [encounterId],
  )
  await as(staff.doctor)
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
  // 0082: dispense_fefo is internal (only the checked functions call it): run as its owner, with
  // the pharmacist's identity, as dispense_prescription does
  await as(staff.pharmacist, 'postgres')
  await db.query(`select dispense_fefo($1, $2, 21, $3)`, [encounterId, item.id, loc.id])
  await as(staff.pharmacist)
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
  // 0085: written by the desk functions only; here as the owner, as the nurse
  await as(staff.nurse, 'postgres')
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
await step('receptionist types the nurseâ€™s paper vitals; the nurse sends on', async () => {
  await as(staff.receptionist)
  paperVisit = (await one(`select open_encounter($1, 'opd', 'triage', null) as id`, [patientId])).id
  // 0078: reception records the sheet; the nurse at triage chooses where the patient goes
  await db.query(
    `select record_vitals($1, '{"bp_sys":"130","temp":"37.9"}'::jsonb, 'yellow', null, null, $2, now() - interval '20 minutes')`,
    [paperVisit, staff.nurse],
  )
  await as(staff.nurse)
  await db.query(`select send_from_triage($1, 'yellow', 'consultation')`, [paperVisit])
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
  await asApproved(staff.manager)
  await db.query(`select revoke_trusted_devices(true)`)
  await as(staff.nurse)
  if ((await one(`select use_trusted_device($1) as ok`, [key])).ok)
    throw new Error('revoked key accepted')
  return 'trusted â†’ used â†’ revoked'
})
// 0079: trust_days no longer decides anything. The browser key always follows the hours of
// inactivity (security.session), whatever trust_days says.
await step(
  'trust_days no longer decides: the browser key lasts the hours of inactivity',
  async () => {
    const key = 'z'.repeat(40)
    await as(staff.manager)
    await db.query(`select save_setting('security.otp', '{"trust_days": 0}'::jsonb)`)
    await as(staff.nurse)
    const u = (await one(`select trust_this_device($1) as u`, [key])).u
    await as(staff.manager)
    await db.query(`select save_setting('security.otp', '{"trust_days": 30}'::jsonb)`)
    await asAdmin()
    const r = await one(
      `select extract(epoch from expires_at - created_at)::int as secs from trusted_device
     where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [key],
    )
    if (!u || r?.secs !== 5 * 3600) throw new Error(JSON.stringify({ u, r }))
    return 'trust_days 0: key still made, ends after 5 hours'
  },
)

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
// 0030 kept a patient waiting since yesterday in the counts; 0086: still shown, as "forgotten"
// (left from an earlier day, please close), not as waiting today.
await step('a patient waiting since yesterday shows as forgotten (0030 → 0086)', async () => {
  await asAdmin()
  const q = await one(
    `select q.id, q.station from queue_entry q join encounter e on e.id = q.encounter_id
     where q.finished_at is null and q.started_at is null and q.deleted_at is null and e.status = 'open' limit 1`,
  )
  await as(staff.receptionist)
  const before = (await one(`select desk_summary() as d`)).d
  await asAdmin()
  await db.query(`update queue_entry set created_at = now() - interval '1 day' where id = $1`, [
    q.id,
  ])
  const status = (await one(`select public_clinic_status() as s`)).s
  await as(staff.receptionist)
  const desk = (await one(`select desk_summary() as d`)).d
  await asAdmin()
  await db.query(`update queue_entry set created_at = now() where id = $1`, [q.id])
  const was = before.stations.find((s) => s.station === q.station)
  const tile = desk.stations.find((s) => s.station === q.station)
  if (typeof status.waiting !== 'number' || 'avg_wait_min' in status)
    throw new Error(JSON.stringify(status))
  if (!tile || tile.forgotten !== (was?.forgotten ?? 0) + 1 || tile.waiting !== was.waiting - 1)
    throw new Error(JSON.stringify({ was, tile }))
  return `${q.station}: waiting ${was.waiting} → ${tile.waiting}, forgotten ${tile.forgotten}`
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
  // 0083: only a holder of a room store gives here (42501); 0082: never without stock (MS003);
  // the store the doctor holds gets exactly 2 from the pharmacy, then closes
  const tryRoom = async () => {
    await as(staff.doctor)
    try {
      await db.query(
        `select prescribe($1, $2, 2, '1 tab', 'oral', 'BD', 1, null, 'room', 'consultation')`,
        [v.id, item.id],
      )
      return null
    } catch (e) {
      return e.code
    }
  }
  const noStore = await tryRoom()
  await as(staff.manager)
  const room = (
    await one(`select save_room_store(null, 'Treatment room (check)', 'nursing', $1) as id`, [
      [staff.doctor],
    ])
  ).id
  const noStock = await tryRoom()
  await as(staff.manager)
  await db.query(`select receive_stock($1, main_pharmacy(), 2, 10, 'ROOM-CHK', '2031-01-31')`, [
    item.id,
  ])
  const note = (
    await one(`select send_to_room($1, $2::jsonb) as j`, [
      room,
      JSON.stringify([{ itemId: item.id, quantity: 2 }]),
    ])
  ).j
  await as(staff.doctor)
  await db.query(`select confirm_receipt($1)`, [note.id])
  const r = (
    await one(
      `select prescribe($1, $2, 2, '1 tab', 'oral', 'BD', 1, null, 'room', 'consultation') as r`,
      [v.id, item.id],
    )
  ).r
  await as(staff.manager)
  await db.query(`select set_location_active($1, false)`, [room])
  await asAdmin()
  if (noStore !== '42501' || noStock !== 'MS003' || !r.stockTaken || r.locationId !== room)
    throw new Error(JSON.stringify({ noStore, noStock, r }))
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
  'cover retired: start_cover refuses; the nurse gets no rights and no patients',
  async () => {
    // 0088: "Cover for me" is retired: start_cover refuses and the nurse never gets his rights
    const can = async () => (await one(`select has_perm('orders.write') as ok`)).ok
    await as(staff.nurse)
    const before = await can()
    await as(staff.doctor)
    let refused = null
    try {
      await db.query(`select start_cover($1, now() + interval '4 hours', 'Theatre all day')`, [
        staff.nurse,
      ])
    } catch (e) {
      refused = `${e.code}/${e.hint ?? ''}`
    }
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
    const nurseMay = (await one(`select may_work_on($1) as ok`, [v.id])).ok
    await asAdmin()
    if (refused !== '42501/cover_retired') throw new Error(`start_cover: ${refused}`)
    if (before || during) throw new Error(`rights ${before}/${during}`)
    if (q.assigned_to !== staff.doctor) throw new Error('patient moved away from the doctor')
    if (nurseMay) throw new Error('the nurse may work on the doctor patient')
    if (mine.covering.length || mine.coveredBy.length) throw new Error('my_cover not empty')
    return 'start_cover refused (cover_retired); no rights, no patients, my_cover empty'
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
  // 0080: the specialty also says where a doctor works; this doctor stays at Consultation
  await asAdmin()
  await db.query(`update profiles set specialty = null where id = $1`, [staff.doctor])
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
    // 0083: deliveries come into the pharmacy; a room store is supplied with a transfer note
    const pharm = (await one(`select main_pharmacy() as id`)).id
    const office = (
      await one(`select save_location(null, 'Consultation office', 'nursing', $1) as id`, [deptId])
    ).id
    await db.query(
      `select receive_stock($1, $2, 100, 80, 'CIP-001', '2028-01-31', 'Kigali Pharma Wholesale Ltd')`,
      [itemId, pharm],
    )
    const note = (
      await one(`select send_to_room($1, $2::jsonb, null, 'weekly supply') as j`, [
        office,
        JSON.stringify([{ itemId, quantity: 10 }]),
      ])
    ).j
    await db.query(`select confirm_receipt($1)`, [note.id])
    const ov = (await one(`select stock_overview() as j`)).j
    const it = ov.items.find((x) => x.id === itemId)
    if (!it || it.onHand !== 100 || Number(it.costValue) !== 8000 || it.byLocation[office] !== 10)
      throw new Error(JSON.stringify(it))
    let refused = false
    try {
      await db.query(`select send_to_room($1, $2::jsonb)`, [
        office,
        JSON.stringify([{ itemId, quantity: 500 }]),
      ])
    } catch (e) {
      refused = /not enough/.test(String(e.message))
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
    // 0082: the hand-over waits until the doctor has finished: the doctor sends the patient on
    await db.query(
      `select refer_patient($1, q.station, 'pharmacy') from queue_entry q
        where q.encounter_id = $1 and q.finished_at is null and station_role(q.station) = 'doctor'`,
      [enc.id],
    )
    await as(staff.pharmacist)
    const q = (await one(`select pharmacy_queue() as j`)).j
    // 0082: { locationId, stores, lines, patients }
    if (!q.lines.some((x) => x.requestId === rx.id)) throw new Error('not in the pharmacy queue')
    const d = (await one(`select dispense_prescription($1) as j`, [rx.id])).j
    const after = (await one(`select stock_overview() as j`)).j.items.find((x) => x.id === itemId)
    const sales = (await one(`select stock_sales(current_date, current_date) as j`)).j
    await asAdmin()
    const line = await one(
      `select unit_price, quantity from invoice_line where item_id = $1 order by created_at desc limit 1`,
      [itemId],
    )
    if (!d.charged || after.byLocation[pharm] !== 80 || Number(line.unit_price) !== 200)
      throw new Error(`charged=${d.charged} pharm=${after.byLocation[pharm]}`)
    const sold = sales.items.find((x) => /Ciprofloxacin/.test(x.item))
    if (!sold || Number(sold.units) !== 10 || Number(sold.revenue) !== 2000 || !refused)
      throw new Error('sales wrong ' + JSON.stringify({ sold, refused }))
    return `100 received into the pharmacy (RWF 8,000), 10 → office by note ${note.number}; over-send refused: ${refused}; 10 handed over at RWF 200 = revenue 2,000, cost ${sold.cost}`
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
// 0043 showed an average wait on the desk tiles; 0086 removed it (it was not a waiting time: see
// wait_time_stats at the end). The longest waiting now stays.
await step('0043 → 0086: desk tiles show the longest waiting now, no average wait', async () => {
  await as(staff.receptionist)
  const d = (await one(`select desk_summary() as j`)).j
  await asAdmin()
  const s = d.stations.find((x) => x.waiting > 0)
  if (
    'avgWaitMin' in d.tiles ||
    'triageAvgWaitMin' in d.tiles ||
    d.stations.some((x) => 'minutes' in x) ||
    (s && s.longest == null)
  )
    throw new Error(JSON.stringify({ tiles: d.tiles, s }))
  return s ? `${s.station} longest waiting ${s.longest} min` : 'nobody waiting'
})

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
  '0057: a booked patient waits for the booked doctor; a visit ended unseen cancels the booking',
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
    // 0101: nobody took the patient: the booking is not "Seen" but cancelled, left unseen
    const a = await one(`select status::text, cancel_reason from appointment where id = $1`, [appt])
    if (
      q?.assigned_to !== d2 ||
      linked.appointment_id !== appt ||
      a.status !== 'cancelled' ||
      !String(a.cancel_reason).startsWith('left_unseen')
    )
      throw new Error(JSON.stringify({ q, linked, a }))
    return 'straight to the booked doctor (told) → left unseen → booking cancelled (left_unseen)'
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
    // 0083: deliveries come into the pharmacy (the main store no longer receives)
    const pharm = (await one(`select main_pharmacy() as id`)).id
    let noExpiry = 'ok'
    try {
      await db.query(`select receive_stock($1, $2, 10, 50)`, [item, pharm])
    } catch (e) {
      noExpiry = String(e.message).split('\n')[0]
    }
    await db.query(`select receive_stock($1, $2, 40, 50, 'IBU-64', '2029-06-30')`, [item, pharm])
    // the pharmacy holds 38, not 40: the count is corrected with its reason
    const diff = (await one(`select adjust_stock($1, $2, 38, 'monthly count') as d`, [item, pharm]))
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
    // 0082: the hand-over waits until the doctor has sent the patient on
    await db.query(`select refer_patient($1, 'consultation', 'pharmacy')`, [p.enc])
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
      inPharm !== 38 ||
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

await step(
  '0074: the RHIA medicines list with prices; finishing after sending to the pharmacy keeps one pharmacy place',
  async () => {
    await asAdmin()
    const rhia = await one(
      `select count(*)::int as n, count(*) filter (where price > 0)::int as priced
     from medicine_reference where source = 'RHIA June 2026'`,
    )
    const p = await visitAt('Loren 74')
    const amox = (await one(`select id from item where code = 'AMOX500'`)).id
    await as(staff.doctor)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select add_diagnosis($1, 'Malaria', 'B54', 'primary')`, [p.enc])
    await db.query(`select prescribe(p_encounter_id => $1, p_item_id => $2, p_quantity => 2)`, [
      p.enc,
      amox,
    ])
    // sent to the pharmacy, then "Finish visit"
    await db.query(`select refer_patient($1, 'consultation', 'pharmacy')`, [p.enc])
    await db.query(`select finish_visit($1)`, [p.enc])
    await asAdmin()
    const places = (
      await db.query(
        `select station::text, finished_at is null as open from queue_entry where encounter_id = $1 and station = 'pharmacy'`,
        [p.enc],
      )
    ).rows
    if (rhia.n < 1400 || rhia.priced !== rhia.n || places.length !== 1 || !places[0].open)
      throw new Error(JSON.stringify({ rhia, places }))
    return `${rhia.n} medicines priced; one open pharmacy place`
  },
)

await step('0075: the role dashboards count a period (today by default)', async () => {
  await as(staff.receptionist)
  const today = (await one(`select desk_summary() as d`)).d
  const all = (await one(`select desk_summary('2020-01-01', current_date) as d`)).d
  await as(staff.lab_tech)
  const lab = (await one(`select lab_summary('2020-01-01', current_date) as s`)).s
  await as(staff.pharmacist)
  const ph = (await one(`select pharmacy_summary(current_date - 30, current_date) as s`)).s
  await as(staff.doctor)
  const home = (await one(`select home_summary(current_date - 6, current_date) as j`)).j
  await asAdmin()
  if (!(all.tiles.registeredToday >= today.tiles.registeredToday) || !lab || !ph || !home)
    throw new Error(JSON.stringify({ t: today.tiles, a: all.tiles }))
  return `registered today ${today.tiles.registeredToday}, since 2020 ${all.tiles.registeredToday}`
})

await step(
  '0076: deleting an employee removes the sign-in but keeps their name on the records; a month deactivated is pointed out',
  async () => {
    await asAdmin()
    const id = (
      await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [
        'k.leaving@staff.muhaziclinic.rw',
        JSON.stringify({
          username: 'k.leaving',
          full_name: 'Kalisa Leaving',
          role: 'nurse',
          station: 'Nursing',
        }),
      ])
    ).id
    const staffId = (await one(`select staff_id from profiles where id = $1`, [id])).staff_id
    const p = await visitAt('Leaving 76')
    await asAdmin()
    await db.query(`update queue_entry set assigned_to = $2 where id = $1`, [p.queue, id])
    const kept = (await one(`select retire_staff($1, $2) as r`, [id, staff.manager])).r
    await db.query(`delete from auth.users where id = $1`, [id])
    const prof = await one(
      `select deleted_at is not null as deleted, active, username, staff_id, full_name from profiles where id = $1`,
      [id],
    )
    const q = await one(`select assigned_to from queue_entry where id = $1`, [p.queue])
    await as(staff.manager)
    const listed = (await db.query(`select 1 from staff_directory where id = $1`, [id])).rows.length
    // the manager may not delete the last manager, nor themselves
    await asAdmin()
    const self = await db.query(`select retire_staff($1, $1)`, [staff.manager]).then(
      () => 'ok',
      (e) => e.message,
    )
    // an account deactivated for 40 days is pointed out once
    await db.query(
      `update profiles set active = false, deactivated_at = now() - interval '40 days', deletion_reminded_at = null where id = $1`,
      [staff.cashier],
    )
    await as(staff.manager)
    const first = (await one(`select deactivation_reminders() as n`)).n
    const again = (await one(`select deactivation_reminders() as n`)).n
    const n = (await one(`select my_notifications(200) as n`)).n
    await asAdmin()
    await db.query(`update profiles set active = true, deactivated_at = null where id = $1`, [
      staff.cashier,
    ])
    const told = n.items.some((x) => x.kind === 'deactivated_long')
    if (
      !prof.deleted ||
      prof.active ||
      !prof.username.startsWith('former.') ||
      prof.staff_id !== staffId ||
      prof.full_name !== 'Kalisa Leaving' ||
      q.assigned_to !== null ||
      listed !== 0 ||
      !/own account/.test(self) ||
      first < 1 ||
      again !== 0 ||
      !told ||
      kept.patientsBack !== 1
    )
      throw new Error(JSON.stringify({ prof, q, listed, self, first, again, told, kept }))
    return (
      'profile kept as former employee (' +
      prof.username +
      '); patient back to the desk; reminder once'
    )
  },
)

await step(
  '0077: the RHIA list is a reference list; a medicine added from it gets its details',
  async () => {
    await asAdmin()
    const ref = await one(`select count(*)::int as n from medicine_reference`)
    const inItems = (
      await one(
        `select count(*)::int as n from item where source = 'RHIA June 2026' and deleted_at is null`,
      )
    ).n
    const pick = await one(
      `select code, generic, presentation, price from medicine_reference where generic ilike 'paracetamol%' order by code limit 1`,
    )
    await as(staff.pharmacist)
    const id = (
      await one(`select upsert_item(null, $1, 150, $2, null, 'Tablet', true, $3) as id`, [
        pick.generic,
        pick.presentation,
        pick.code,
      ])
    ).id
    await asAdmin()
    const it = await one(
      `select code, prescribing_rule is not distinct from (select prescribing_rule from medicine_reference where code = $2) as rule, atc_group is not null as grp, source from item where id = $1`,
      [id, pick.code],
    )
    const price = (await one(`select cash_price from items_catalogue where id = $1`, [id]))
      .cash_price
    if (
      ref.n < 1400 ||
      inItems !== 0 ||
      it.code !== pick.code ||
      !it.rule ||
      !it.grp ||
      Number(price) !== 150
    )
      throw new Error(JSON.stringify({ ref, inItems, it, price }))
    return `${ref.n} in the list, none in the clinic's medicines until added; added with its rule and group, clinic price kept`
  },
)

// ---------------------------------------------------------------- 0078: fixes from the audit
const newStaff = async (username, full_name, role, station = null) => {
  await asAdmin()
  return (
    await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [
      `${username}@staff.muhaziclinic.rw`,
      JSON.stringify({ username, full_name, role, station }),
    ])
  ).id
}
await step(
  '0078: from triage, only who has the patient sends on; reception and another nurse record only',
  async () => {
    await asAdmin()
    const nurse2 = (await one(`select id from profiles where username = 'a.umutoni'`)).id
    await as(staff.receptionist)
    const r = (
      await one(
        `select register_patient_file('Mutesi', 'Triage 78', 'female', null, 31, null) as r`,
      )
    ).r
    // reception sends the patient to triage, to a named nurse
    const enc = (
      await one(
        `select begin_visit(p_patient_id => $1, p_station => 'triage', p_triage_to => $2) as v`,
        [r.patient_id, staff.nurse],
      )
    ).v.encounter_id
    const recSends = await tryAs(
      staff.receptionist,
      `select record_vitals($1, '{"temp":"37.2"}'::jsonb, 'green', 'consultation', null, $2)`,
      [enc, staff.nurse],
    )
    const recRecords = await tryAs(
      staff.receptionist,
      `select record_vitals($1, '{"pulse":"82"}'::jsonb, null, null, null, $2)`,
      [enc, staff.nurse],
    )
    const otherSends = await tryAs(
      nurse2,
      `select record_vitals($1, '{"temp":"37.3"}'::jsonb, 'green', 'consultation')`,
      [enc],
    )
    const otherRecords = await tryAs(nurse2, `select record_vitals($1, '{"resp":"18"}'::jsonb)`, [
      enc,
    ])
    const namedSends = await tryAs(
      staff.nurse,
      `select record_vitals($1, '{"spo2":"98"}'::jsonb, 'green', 'consultation')`,
      [enc],
    )
    const open = (
      await db.query(
        `select station::text from queue_entry where encounter_id = $1 and finished_at is null`,
        [enc],
      )
    ).rows.map((x) => x.station)
    if (
      !/record the measurements/.test(recSends) ||
      recRecords !== 'ok' ||
      !/this patient is with/.test(otherSends) ||
      otherRecords !== 'ok' ||
      namedSends !== 'ok' ||
      JSON.stringify(open) !== '["consultation"]'
    )
      throw new Error(
        JSON.stringify({ recSends, recRecords, otherSends, otherRecords, namedSends, open }),
      )
    return 'reception and the other nurse record only; the named nurse sends on to Consultation'
  },
)

await step(
  '0078: deleting a doctor: patients due back to them, and their results, go to the section',
  async () => {
    const doc = await newStaff('d.leaving78', 'Dr. Leaving 78', 'doctor', 'Consultation 2')
    await as(staff.manager)
    const cat = (await one(`select save_category(null, 'Lab tests 78', null, null, 'lab') as id`))
      .id
    const test = (await one(`select upsert_service(null, 'Malaria RDT 78', 'other', 2000) as id`))
      .id
    await db.query(`select set_service_category($1, $2)`, [test, cat])
    // a: sent to the lab to come back to the doctor; b: sent to the lab without asking back
    const a = await visitAt('Back 78')
    const b = await visitAt('Requester 78')
    await as(doc)
    for (const p of [a, b]) {
      await db.query(`select take_patient($1)`, [p.queue])
      await db.query(`select order_test($1, $2, 'fever')`, [p.enc, test])
    }
    await db.query(
      `select refer_patient(p_encounter_id => $1, p_from => 'consultation', p_to => 'laboratory', p_return => true)`,
      [a.enc],
    )
    await asAdmin()
    await db.query(
      `update queue_entry set finished_at = now() where encounter_id = $1 and station = 'consultation'`,
      [b.enc],
    )
    const labOf = (enc) =>
      one(
        `select return_to, return_station::text from queue_entry where encounter_id = $1 and station = 'laboratory' and finished_at is null`,
        [enc],
      )
    const before = await labOf(a.enc)
    await db.query(`select retire_staff($1, $2)`, [doc, staff.manager])
    const after = await labOf(a.enc)
    await as(staff.lab_tech)
    for (const p of [a, b]) {
      const req = (await one(`select id from service_request where encounter_id = $1`, [p.enc])).id
      await db.query(`select record_result($1, 'Negative', 'No malaria', true)`, [req])
    }
    await asAdmin()
    const backOf = (enc) =>
      one(
        `select assigned_to, referral_note from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
        [enc],
      )
    const backA = await backOf(a.enc)
    const backB = await backOf(b.enc)
    // anyone in Consultation may take them
    await as(d1)
    const mayA =
      backA &&
      (
        await one(
          `select queue_entry_for_me(id) as ok from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
          [a.enc],
        )
      ).ok
    await asAdmin()
    if (
      before?.return_to !== doc ||
      after?.return_to !== null ||
      after?.return_station !== 'consultation' ||
      !backA ||
      backA.assigned_to !== null ||
      !backB ||
      backB.assigned_to !== null ||
      !/Results ready/.test(backB.referral_note ?? '') ||
      !mayA
    )
      throw new Error(JSON.stringify({ before, after, backA, backB, mayA }))
    return 'return_to cleared; both results back to Consultation for anyone there'
  },
)

await step('0078: before deleting, the manager sees what the delete touches', async () => {
  const doc = await newStaff('d.preview78', 'Dr. Preview 78', 'doctor', 'Consultation 3')
  const p = await visitAt('Preview 78')
  await as(staff.manager)
  const pr = (await one(`select ensure_practitioner($1) as id`, [doc])).id
  await asAdmin()
  await db.query(`update queue_entry set assigned_to = $2 where id = $1`, [p.queue, doc])
  const patient = (await one(`select patient_id from encounter where id = $1`, [p.enc])).patient_id
  // one booking to come; one cancelled and one past, which do not count
  for (const [at, status] of [
    [`now() + interval '2 days'`, 'confirmed'],
    [`now() + interval '3 days'`, 'cancelled'],
    [`now() - interval '3 days'`, 'confirmed'],
  ])
    await db.query(
      `insert into appointment (patient_id, practitioner_id, starts_at, status, source)
       values ($1, $2, ${at}, '${status}', 'reception')`,
      [patient, pr],
    )
  await db.query(
    `insert into notification (kind, title, body, recipient_user) values ('message', 'Hello', 'Note for you', $1)`,
    [doc],
  )
  await db.query(`insert into internal_task (title, assigned_to) values ('Call back 78', $1)`, [
    doc,
  ])
  const notices = (
    await one(`select count(*)::int as n from notification where recipient_user = $1`, [doc])
  ).n
  await as(staff.manager)
  const pv = (await one(`select retire_staff_preview($1) as j`, [doc])).j
  const refused = await tryAs(staff.receptionist, `select retire_staff_preview($1)`, [doc])
  if (
    pv.notices !== notices ||
    notices < 1 ||
    pv.upcomingAppointments !== 1 ||
    pv.waitingPatients !== 1 ||
    pv.openTasks !== 1 ||
    !/managers only/.test(refused)
  )
    throw new Error(JSON.stringify({ pv, notices, refused }))
  return `${pv.notices} notice(s), ${pv.upcomingAppointments} booking to come, ${pv.waitingPatients} patient, ${pv.openTasks} task; managers only`
})

await step('0078: the cashier figures, My orders and My prescriptions take a period', async () => {
  await as(staff.cashier)
  const day = (await one(`select cashier_summary() as s`)).s
  const oneArg = (await one(`select cashier_summary(current_date) as s`)).s
  const range = (
    await one(`select cashier_summary(p_from => current_date - 30, p_to => current_date + 1) as s`)
  ).s
  await as(d1)
  const last30 = (await one(`select my_orders(30) as j`)).j
  const ordRange = (
    await one(`select my_orders(p_from => current_date - 30, p_to => current_date + 1) as j`)
  ).j
  const ordOld = (await one(`select my_orders(p_from => '2020-01-01', p_to => '2020-01-31') as j`))
    .j
  const rxRange = (
    await one(`select my_prescriptions(p_from => current_date - 30, p_to => current_date + 1) as j`)
  ).j
  await as(staff.pharmacist)
  const pq = (await one(`select pharmacy_queue() as j`)).j
  await asAdmin()
  if (
    Number(range.total) < Number(day.total) ||
    range.count < day.count ||
    range.from >= range.to ||
    oneArg.day !== day.day ||
    Number(oneArg.total) !== Number(day.total) ||
    !ordRange.length ||
    ordRange.length !== last30.length ||
    ordOld.length !== 0 ||
    !Array.isArray(rxRange) ||
    !pq.lines.every((l) => typeof l.onHandElsewhere === 'number' && l.pharmacyLocationId)
  )
    throw new Error(
      JSON.stringify({
        day: [day.day, day.total, day.count],
        range: [range.from, range.to, range.total, range.count],
        oneArg: [oneArg.day, oneArg.total],
        ord: [last30.length, ordRange.length, ordOld.length],
        rx: rxRange.length,
        pq: pq.slice(0, 1),
      }),
    )
  return `today ${day.total} / 31 days ${range.total}; ${ordRange.length} orders, ${rxRange.length} prescriptions in the period; ${pq.length} pharmacy line(s) with stock elsewhere`
})

await step('0078: calls from someone who left are withdrawn and cannot be answered', async () => {
  const gone = await newStaff('d.calls78', 'Dr. Calls 78', 'doctor', 'Consultation 4')
  const off = await newStaff('d.off78', 'Dr. Off 78', 'doctor', 'Consultation 5')
  const p = await visitAt('Calls 78')
  await as(gone)
  const call = (await one(`select call_next('consultation', 'reception', null, null) as id`)).id
  await as(off)
  const offCall = (await one(`select call_next('consultation', 'reception', null, null) as id`)).id
  await asAdmin()
  const noticesBefore = (
    await one(
      `select count(*)::int as n from notification where kind = 'call_next' and params ->> 'call' = $1`,
      [call],
    )
  ).n
  await db.query(`select retire_staff($1, $2)`, [gone, staff.manager])
  const st = (await one(`select status from staff_call where id = $1`, [call])).status
  const noticesAfter = (
    await one(
      `select count(*)::int as n from notification where kind = 'call_next' and params ->> 'call' = $1`,
      [call],
    )
  ).n
  // deactivated, not deleted: the call stays but nobody can send them a patient
  await db.query(`update profiles set active = false where id = $1`, [off])
  const refused = await tryAs(staff.receptionist, `select answer_call($1, $2)`, [offCall, p.queue])
  await asAdmin()
  const q = await one(`select assigned_to from queue_entry where id = $1`, [p.queue])
  if (
    noticesBefore < 1 ||
    st !== 'cancelled' ||
    noticesAfter !== 0 ||
    !/no longer works here/.test(refused) ||
    q.assigned_to !== null
  )
    throw new Error(JSON.stringify({ noticesBefore, st, noticesAfter, refused, q }))
  return 'deleted: call cancelled, notice gone; deactivated: answering refused'
})

// ---------------------------------------------------------------- 0079: hours of inactivity
// A tab signs out after N hours without activity (the clock runs in the tab). The browser key
// made after the e-mailed code ends N hours after the code; activity pushes the end forward
// (extend_this_device); another tab using it (use_trusted_device) never does.
const sessKey = 's'.repeat(40)
const sessRow = (key) =>
  one(
    `select expires_at, created_at, revoked_at,
            extract(epoch from expires_at - created_at)::int as secs,
            extract(epoch from expires_at - last_used_at)::int as since_use
     from trusted_device where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [key],
  )
const sessBack = (key, interval) =>
  db.query(
    `update trusted_device
        set created_at = created_at - $2::interval, last_used_at = last_used_at - $2::interval,
            expires_at = expires_at - $2::interval
      where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [key, interval],
  )
const ms = (t) => new Date(t).getTime()
await step('0079: staff read the hours of inactivity (default 5)', async () => {
  await as(staff.nurse)
  const s = (await one(`select staff_settings() as j`)).j
  if (s.session_hours !== 5) throw new Error(JSON.stringify(s))
  return '5 hours'
})
await step('0079: after the code, the browser key ends now + 5 hours (server clock)', async () => {
  await as(staff.nurse)
  const until = (await one(`select trust_this_device($1, 'test browser') as u`, [sessKey])).u
  if (!until) throw new Error('no end returned')
  await asAdmin()
  const r = await sessRow(sessKey)
  if (r.secs !== 5 * 3600) throw new Error(`${r.secs} s`)
  if (ms(until) !== ms(r.expires_at)) throw new Error('returned end differs from the stored end')
  return `ends ${new Date(until).toISOString()}`
})
await step('0079: another tab uses the key: same end, never pushed forward', async () => {
  // as if the code had been entered an hour ago
  await asAdmin()
  await sessBack(sessKey, '1 hour')
  const before = (await sessRow(sessKey)).expires_at
  await as(staff.nurse)
  const end = (await one(`select use_trusted_device($1) as e`, [sessKey])).e
  if (!end) throw new Error('own key refused')
  await asAdmin()
  const after = (await sessRow(sessKey)).expires_at
  if (ms(end) !== ms(before)) throw new Error('a different end was returned')
  if (ms(after) !== ms(before)) throw new Error('using the key pushed the end forward')
  return 'same end, not extended'
})
await step('0079: activity pushes the end to now + 5 hours (owner only)', async () => {
  await asAdmin()
  const before = (await sessRow(sessKey)).expires_at
  // someone else cannot push it, nor use it, nor sign it out
  await as(staff.receptionist)
  const foreignExtend = (await one(`select extend_this_device($1) as e`, [sessKey])).e
  const foreignUse = (await one(`select use_trusted_device($1) as e`, [sessKey])).e
  await db.query(`select revoke_this_device($1)`, [sessKey])
  await asAdmin()
  const mid = await sessRow(sessKey)
  await as(staff.nurse)
  const end = (await one(`select extend_this_device($1) as e`, [sessKey])).e
  await asAdmin()
  const after = await sessRow(sessKey)
  if (
    foreignExtend ||
    foreignUse ||
    mid.revoked_at ||
    ms(mid.expires_at) !== ms(before) ||
    !end ||
    ms(end) !== ms(after.expires_at) ||
    ms(after.expires_at) <= ms(before) ||
    after.since_use !== 5 * 3600
  )
    throw new Error(JSON.stringify({ foreignExtend, foreignUse, mid, end, after }))
  return 'owner: end moved forward by the hour of no use; others: refused, untouched'
})
await step('0079: a new code on the same browser starts the key over (one row)', async () => {
  await as(staff.nurse)
  const until = (await one(`select trust_this_device($1, 'test browser') as u`, [sessKey])).u
  await asAdmin()
  const n = await one(
    `select count(*)::int as n from trusted_device where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [sessKey],
  )
  const r = await sessRow(sessKey)
  if (n.n !== 1 || r.secs !== 5 * 3600 || ms(until) !== ms(r.expires_at))
    throw new Error(JSON.stringify({ n: n.n, secs: r.secs }))
  return '1 row, a new 5 hours'
})
await step('0079: 5 hours without activity: the key asks for a new code', async () => {
  await asAdmin()
  await sessBack(sessKey, '5 hours 1 minute')
  const before = (await sessRow(sessKey)).expires_at
  await as(staff.nurse)
  const extended = (await one(`select extend_this_device($1) as e`, [sessKey])).e
  const used = (await one(`select use_trusted_device($1) as e`, [sessKey])).e
  await asAdmin()
  const after = (await sessRow(sessKey)).expires_at
  if (extended || used || ms(after) !== ms(before))
    throw new Error(JSON.stringify({ extended, used, before, after }))
  return 'expired: not used, not brought back'
})
await step('0079: signing out revokes this browser: the next sign-in needs a code', async () => {
  const key = 'o'.repeat(40)
  await as(staff.nurse)
  await one(`select trust_this_device($1) as u`, [key])
  if (!(await one(`select use_trusted_device($1) as e`, [key])).e)
    throw new Error('own key refused')
  await db.query(`select revoke_this_device($1)`, [key])
  const used = (await one(`select use_trusted_device($1) as e`, [key])).e
  const extended = (await one(`select extend_this_device($1) as e`, [key])).e
  await db.query(`select revoke_this_device($1)`, [key]) // twice is harmless
  if (used || extended) throw new Error(JSON.stringify({ used, extended }))
  return 'signed out: not used, not brought back'
})
await step('0079: the PIN alone (no e-mailed code) cannot make a browser key', async () => {
  const key = 'p'.repeat(40)
  await asPinOnly(staff.nurse)
  const pinOnly = (await one(`select trust_this_device($1) as u`, [key])).u
  const noClaims = await (async () => {
    await as(staff.nurse, 'authenticated', '')
    return (await one(`select trust_this_device($1) as u`, [key])).u
  })()
  await as(staff.nurse)
  const code = (await one(`select signed_in_with_code() as c`)).c
  await asAdmin()
  const n = await one(
    `select count(*)::int as n from trusted_device where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [key],
  )
  if (pinOnly || noClaims || !code || n.n !== 0)
    throw new Error(JSON.stringify({ pinOnly, noClaims, code, n: n.n }))
  return 'PIN only: no key; after the code: allowed'
})
await step('0079: a key ended by a sign-out is never brought back, even with a code', async () => {
  const key = 'r'.repeat(40)
  await as(staff.nurse)
  await one(`select trust_this_device($1) as u`, [key])
  await db.query(`select revoke_this_device($1)`, [key])
  const again = (await one(`select trust_this_device($1) as u`, [key])).u
  const used = (await one(`select use_trusted_device($1) as e`, [key])).e
  await asAdmin()
  const r = await one(
    `select revoked_at from trusted_device where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [key],
  )
  if (again || used || !r?.revoked_at) throw new Error(JSON.stringify({ again, used, r }))
  return 'still revoked; the browser makes a new key at the next code'
})
await step('0079: the manager sets the hours; new keys and activity follow them', async () => {
  await as(staff.manager)
  await db.query(`select save_setting('security.session', '{"hours": 3}'::jsonb)`)
  await as(staff.nurse)
  const s = (await one(`select staff_settings() as j`)).j
  const key = 'h'.repeat(40)
  await one(`select trust_this_device($1) as u`, [key])
  await asAdmin()
  const made = await sessRow(key)
  await sessBack(key, '1 hour')
  await as(staff.nurse)
  await one(`select extend_this_device($1) as e`, [key])
  await asAdmin()
  const moved = await sessRow(key)
  await as(staff.manager)
  await db.query(`select save_setting('security.session', '{"hours": 5}'::jsonb)`)
  if (s.session_hours !== 3 || made.secs !== 3 * 3600 || moved.since_use !== 3 * 3600)
    throw new Error(JSON.stringify({ s, made: made.secs, moved: moved.since_use }))
  return '3 hours read and applied, back to 5'
})
await expectError(
  '0079: a nurse may not change the hours of inactivity',
  async () => {
    await as(staff.nurse)
    await db.query(`select save_setting('security.session', '{"hours": 12}'::jsonb)`)
  },
  /not allowed/i,
)
await step('0079: changing settings is not enough: only the manager sets the hours', async () => {
  // the manager lets the receptionist change settings (an exception for this employee)
  await asAdmin()
  await db.query(
    `insert into staff_permission (profile_id, permission, allowed) values ($1, 'settings.write', true)
     on conflict (profile_id, permission) do update set allowed = true`,
    [staff.receptionist],
  )
  await as(staff.receptionist)
  const may = (await one(`select has_perm('settings.write') as ok`)).ok
  const refused = await tryAs(
    staff.receptionist,
    `select save_setting('security.session', '{"hours": 4}'::jsonb)`,
  )
  await db.query(
    `delete from staff_permission where profile_id = $1 and permission = 'settings.write'`,
    [staff.receptionist],
  )
  const h = (await one(`select session_hours() as h`)).h
  if (!may || !/not allowed/.test(refused) || h !== 5)
    throw new Error(JSON.stringify({ may, refused, h }))
  return 'receptionist with settings.write refused; still 5 hours'
})
await expectError(
  '0079: the hours are a whole number from 1 to 12',
  async () => {
    await as(staff.manager)
    await db.query(`select save_setting('security.session', '{"hours": 13}'::jsonb)`)
  },
  /between 1 and 12/i,
)
await expectError(
  '0079: half hours are refused',
  async () => {
    await as(staff.manager)
    await db.query(`select save_setting('security.session', '{"hours": 2.5}'::jsonb)`)
  },
  /between 1 and 12/i,
)
await expectError(
  '0079: hours written as text are refused',
  async () => {
    await as(staff.manager)
    await db.query(`select save_setting('security.session', '{"hours": "five"}'::jsonb)`)
  },
  /between 1 and 12/i,
)
await step('0079: the sign-in functions are closed to visitors (anon)', async () => {
  await asAdmin()
  const r = await one(
    `select bool_or(has_function_privilege('anon', p, 'execute')) as anon_any,
            bool_and(has_function_privilege('authenticated', p, 'execute')) as staff_all
     from unnest(array['session_hours()', 'signed_in_with_code()', 'trust_this_device(text, text)', 'use_trusted_device(text)',
                       'extend_this_device(text)', 'revoke_this_device(text)',
                       'revoke_trusted_devices(boolean)']::regprocedure[]) p`,
  )
  if (r.anon_any || !r.staff_all) throw new Error(JSON.stringify(r))
  return 'anon refused; staff allowed'
})

// ---------------------------------------------------------------- 0080: the specialty adds where a doctor works
const servicesOf80 = async (id) =>
  (
    await one(
      `select coalesce(array_agg(s order by s), '{}') as s
       from unnest(array['consultation', 'dental', 'laboratory', 'ultrasound', 'nursing', 'surgery',
                         'circ', 'fp', 'hiv', 'pharmacy', 'triage']) s
       where staff_serves($1, s)`,
      [id],
    )
  ).s
const doctor80 = {}
await step(
  '0080: a doctor with no service set: the specialty adds its section (Dentist → Dental), the desk the app opens (Consultation) stays',
  async () => {
    await asAdmin()
    doctor80.dentist = (
      await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [
        'd.dentist80@staff.muhaziclinic.rw',
        JSON.stringify({ username: 'd.dentist80', full_name: 'Dr. Habimana Eric', role: 'doctor' }),
      ])
    ).id
    await db.query(`update profiles set specialty = 'Dentist', station = null where id = $1`, [
      doctor80.dentist,
    ])
    const mine = (await one(`select staff_services($1) as s`, [doctor80.dentist])).s
    const dental = await servicesOf80(doctor80.dentist)
    await as(staff.receptionist)
    const listDental = (await one(`select service_staff('dental') as s`)).s
    await asAdmin()
    if (
      mine.length ||
      !dental.includes('dental') ||
      // no desk name: the app opens this doctor's queue at Consultation, so it stays
      !dental.includes('consultation') ||
      dental.includes('surgery') ||
      !listDental.staff.some((p) => p.id === doctor80.dentist)
    )
      throw new Error(JSON.stringify({ mine, dental }))
    return `Dentist serves ${dental.join(', ')}; listed for Dental`
  },
)
await step(
  '0080: General practitioner → Consultation; Surgeon adds Minor surgery and circumcision; the desk name counts too',
  async () => {
    await asAdmin()
    const id = doctor80.dentist
    await db.query(`update profiles set specialty = 'General practitioner' where id = $1`, [id])
    const gp = await servicesOf80(id)
    // the specialty and the desk name both count
    await db.query(
      `update profiles set specialty = 'General practitioner', station = 'Dental room' where id = $1`,
      [id],
    )
    const gpDental = await servicesOf80(id)
    await db.query(`update profiles set specialty = 'Surgeon', station = null where id = $1`, [id])
    const surgeon = await servicesOf80(id)
    // a "Minor surgery" doctor at the desk "Consultation 1" keeps Consultation
    await db.query(
      `update profiles set specialty = 'Minor surgery', station = 'Consultation 1' where id = $1`,
      [id],
    )
    const both = await servicesOf80(id)
    await db.query(
      `update profiles set specialty = 'Chirurgien-dentiste', station = null where id = $1`,
      [id],
    )
    const fr = await servicesOf80(id)
    // at a desk named for a section, the specialty adds to that desk only
    await db.query(
      `update profiles set specialty = 'Dentist', station = 'Dental 1' where id = $1`,
      [id],
    )
    const atDental = await servicesOf80(id)
    if (
      !gp.includes('consultation') ||
      gp.includes('dental') ||
      !gpDental.includes('consultation') ||
      !gpDental.includes('dental') ||
      !surgeon.includes('surgery') ||
      !surgeon.includes('circ') ||
      !surgeon.includes('consultation') ||
      !both.includes('consultation') ||
      !both.includes('surgery') ||
      both.includes('dental') ||
      !fr.includes('dental') ||
      fr.includes('surgery') ||
      !atDental.includes('dental') ||
      atDental.includes('consultation')
    )
      throw new Error(JSON.stringify({ gp, gpDental, surgeon, both, fr, atDental }))
    return `GP: ${gp.join(', ')} · Surgeon: ${surgeon.join(', ')} · Chirurgien-dentiste: ${fr.join(', ')}`
  },
)
await step(
  '0080: no specialty (or one naming no section) leaves the desk name to decide, as before',
  async () => {
    await asAdmin()
    const id = doctor80.dentist
    await db.query(
      `update profiles set specialty = null, station = 'Dental chair 2' where id = $1`,
      [id],
    )
    const byDesk = await servicesOf80(id)
    // "Resident" is not "dent…": the word must start with it
    await db.query(`update profiles set specialty = 'Resident', station = null where id = $1`, [id])
    const resident = await servicesOf80(id)
    if (
      !byDesk.includes('dental') ||
      byDesk.includes('consultation') ||
      !resident.includes('consultation') ||
      resident.includes('dental')
    )
      throw new Error(JSON.stringify({ byDesk, resident }))
    return `desk "Dental chair 2": ${byDesk.join(', ')} · Resident: ${resident.join(', ')}`
  },
)
await step(
  '0080: a doctor whose department gives services keeps exactly those, whatever the specialty',
  async () => {
    // the dentist above is now set in Dental, so Dental has its people
    await asAdmin()
    await db.query(`update profiles set specialty = 'Dentist', station = null where id = $1`, [
      doctor80.dentist,
    ])
    await as(staff.manager)
    const dental = (
      await one(`select upsert_department(null, 'Dental 80', null, '{}', array['dental']) as id`)
    ).id
    const theatre = (
      await one(`select upsert_department(null, 'Theatre 80', null, '{}', array['surgery']) as id`)
    ).id
    await asAdmin()
    const other = (
      await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [
        'd.theatre80@staff.muhaziclinic.rw',
        JSON.stringify({
          username: 'd.theatre80',
          full_name: 'Dr. Ingabire Alice',
          role: 'doctor',
        }),
      ])
    ).id
    await db.query(`update profiles set specialty = 'Dentist' where id = $1`, [other])
    await db.query(
      `insert into staff_department (profile_id, department_id, position) values ($1, $2, 'member'), ($3, $4, 'member')`,
      [doctor80.dentist, dental, other, theatre],
    )
    // only the services nobody is set for may still fall back to the role's usual desk
    const unset = (
      await one(
        `select coalesce(array_agg(s order by s), '{}') as s
         from unnest(array['consultation', 'dental', 'laboratory', 'ultrasound', 'nursing', 'surgery',
                           'circ', 'fp', 'hiv', 'pharmacy', 'triage']) s
         where not service_has_staff(s)`,
      )
    ).s
    const mine = await servicesOf80(other)
    const dentist = await servicesOf80(doctor80.dentist)
    const extra = mine.filter((s) => s !== 'surgery')
    if (
      !mine.includes('surgery') ||
      mine.includes('dental') ||
      extra.some((s) => !unset.includes(s)) ||
      !dentist.includes('dental') ||
      dentist.includes('surgery')
    )
      throw new Error(JSON.stringify({ mine, dentist, unset }))
    return `department Theatre: ${mine.join(', ')} (specialty Dentist not used) · Dental: ${dentist.join(', ')}`
  },
)
await step('0080: the serving functions stay closed to visitors (anon)', async () => {
  await asAdmin()
  const r = await one(
    `select has_function_privilege('anon', 'staff_serves(uuid, text)', 'execute') as anon,
            has_function_privilege('authenticated', 'staff_serves(uuid, text)', 'execute') as staff,
            role_serves('doctor', null, 'dental', 'Orthodontist') as ortho,
            role_serves('doctor', null, 'consultation', 'Paediatrician') as paed,
            role_serves('doctor', null, 'ultrasound', 'Radiologist') as radio,
            role_serves('doctor', 'Theatre', 'surgery') as old3,
            role_serves('nurse', null, 'nursing', 'Midwife') as nurse,
            role_serves('doctor', null, 'consultation', 'Dentist') as dent_no_desk,
            role_serves('doctor', 'Dental 1', 'consultation', 'Dentist') as dent_at_dental,
            has_function_privilege('anon', 'role_serves(role_key, text, text, text)', 'execute') as anon4`,
  )
  if (
    r.anon ||
    r.anon4 ||
    !r.staff ||
    !r.ortho ||
    !r.paed ||
    !r.radio ||
    !r.old3 ||
    !r.nurse ||
    !r.dent_no_desk ||
    r.dent_at_dental
  )
    throw new Error(JSON.stringify(r))
  return 'anon refused; staff allowed; specialties map to sections'
})

// ---------------------------------------------------------------- 0081: the code is checked by the database
// A session (access token `session_id`) works only once approved: by the e-mailed code typed in
// the last 15 minutes (record_sign_in with amr otp/magiclink) or by a valid browser key
// (use_trusted_device). The PostgREST pre-request check_request() refuses every other staff
// request (SQLSTATE PT401).
const now81 = () => Math.floor(Date.now() / 1000)
const as81 = (userId, sid, method = 'otp', ts = now81()) =>
  as(
    userId,
    'authenticated',
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      session_id: sid,
      amr: [{ method, timestamp: ts }],
    }),
  )
/** What PostgREST would do before a request on `p` (check_request): 'pass' or the refusal. */
const gate81 = async (p, method = 'POST') => {
  await db.query(
    `select set_config('request.path', $1, false), set_config('request.method', $2, false)`,
    [p, method],
  )
  try {
    await db.query(`select check_request()`)
    return 'pass'
  } catch (e) {
    return { code: e.code, hint: e.hint, message: String(e.message) }
  }
}
const refused81 = (r, hint) => r !== 'pass' && r.code === 'PT401' && (!hint || r.hint === hint)
const row81 = async (sid) => {
  await asAdmin()
  return one(`select * from approved_session where session_id = $1`, [sid])
}
const switch81 = async (on) => {
  await asAdmin()
  await db.query(`update setting set value = $1::jsonb where key = 'security.enforce_code'`, [
    JSON.stringify({ on }),
  ])
}
const sidPin81 = crypto.randomUUID()
const sidCode81 = crypto.randomUUID()
const sidDevice81 = crypto.randomUUID()
const key81 = 'g'.repeat(40)
await step('0081: a PIN-only session is not approved: every request refused', async () => {
  await as81(staff.nurse, sidPin81, 'password')
  const ok = (await one(`select session_ok() as ok`)).ok
  const table = await gate81('/patient', 'GET')
  const rpc = await gate81('/rpc/find_patients')
  const status = (await one(`select session_status() as j`)).j
  if (ok || !refused81(table, 'code_required') || !refused81(rpc, 'code_required') || status.ok)
    throw new Error(JSON.stringify({ ok, table, rpc, status }))
  if (!/sign in again with the e-mailed code/.test(table.message)) throw new Error(table.message)
  return `refused: ${table.message} (${table.code}, ${table.hint})`
})
await expectError(
  '0081: record_sign_in never approves a PIN-only session',
  async () => {
    await as81(staff.nurse, sidPin81, 'password')
    await db.query(`select record_sign_in('pin only')`)
  },
  /not approved/i,
)
await step('0081: ... and no approval was written for it', async () => {
  const r = await row81(sidPin81)
  if (r) throw new Error(JSON.stringify(r))
  return 'no row'
})
await step(
  '0081: only the sign-in and sign-out calls pass before the approval; nothing else',
  async () => {
    await as81(staff.nurse, sidPin81, 'password')
    const allowed = [
      '/rpc/record_sign_in',
      '/rpc/use_trusted_device',
      '/rpc/my_must_change_pin',
      '/rpc/mark_pin_changed',
      '/rpc/touch_session',
      '/rpc/end_session',
      '/rpc/revoke_this_device',
      '/rpc/session_status',
      '/rest/v1/rpc/end_session',
    ]
    const bad = []
    for (const p of allowed) if ((await gate81(p)) !== 'pass') bad.push(p)
    for (const p of [
      '/rpc/record_sign_in_x',
      '/rpc/record_wrong_pin',
      '/rpc/revoke_trusted_devices',
      '/rpc/staff_settings',
      '/rpc/session_ok',
      '/rpc/staff_login_email',
      '/rpc/public_staff_check',
      '/rpc/my_session_profile',
      '/rpc/trust_this_device',
      '/rpc/extend_this_device',
      '/rpc/graphql',
      '/patient/rpc/end_session',
      '/profiles',
      '/setting',
      '/rpc/save_setting',
    ])
      if (!refused81(await gate81(p), 'code_required')) bad.push(p)
    const pin = (await one(`select my_must_change_pin() as b`)).b
    if (bad.length || typeof pin !== 'boolean') throw new Error(JSON.stringify({ bad, pin }))
    return `${allowed.length} calls allowed; wrong PINs, browser keys and data refused`
  },
)
await step('0081: the e-mailed code approves the session; data passes', async () => {
  await as81(staff.nurse, sidCode81, 'otp')
  const before = await gate81('/patient', 'GET')
  const p = (await one(`select record_sign_in('code') as j`)).j
  const ok = (await one(`select session_ok() as ok`)).ok
  const table = await gate81('/patient', 'GET')
  const rpc = await gate81('/rpc/find_patients')
  const status = (await one(`select session_status() as j`)).j
  const r = await row81(sidCode81)
  if (
    !refused81(before) ||
    p.role !== 'nurse' ||
    !ok ||
    table !== 'pass' ||
    rpc !== 'pass' ||
    !status.ok ||
    status.via !== 'code' ||
    r?.via !== 'code' ||
    r.user_id !== staff.nurse
  )
    throw new Error(JSON.stringify({ before, ok, table, rpc, status, r }))
  return 'approved via code'
})
await step('0081: the sign-in link (magiclink) approves too', async () => {
  const sid = crypto.randomUUID()
  await as81(staff.receptionist, sid, 'magiclink')
  await db.query(`select record_sign_in('link')`)
  const ok = (await one(`select session_ok() as ok`)).ok
  if (!ok) throw new Error('link session not approved')
  return 'approved via code'
})
await step(
  '0081: a code typed long ago (a refresh token left behind) approves nothing',
  async () => {
    const sid = crypto.randomUUID()
    await as81(staff.receptionist, sid, 'otp', now81() - 86_400)
    let refused = null
    try {
      await db.query(`select record_sign_in('old code')`)
    } catch (e) {
      refused = e.code
    }
    const ok = (await one(`select session_ok() as ok`)).ok
    const r = await row81(sid)
    if (refused !== 'PT401' || ok || r) throw new Error(JSON.stringify({ refused, ok, r }))
    return 'a day-old code: refused, no approval'
  },
)
await step('0081: a session signed out and forgotten is never approved again', async () => {
  const sid = crypto.randomUUID()
  const typed = now81()
  await as81(staff.receptionist, sid, 'otp', typed)
  await db.query(`select record_sign_in('code')`)
  await db.query(`select end_session('signed out')`)
  // a later record_sign_in with the same token (code still fresh): the end stays
  let again = null
  try {
    await db.query(`select record_sign_in('again')`)
  } catch (e) {
    again = e.hint
  }
  // the row is gone (old purge) and the same session comes back a day later: refused
  await asAdmin()
  await db.query(`delete from approved_session where session_id = $1`, [sid])
  await as81(staff.receptionist, sid, 'otp', typed - 86_400)
  let later = null
  try {
    await db.query(`select record_sign_in('later')`)
  } catch (e) {
    later = e.code
  }
  const r = await row81(sid)
  if (again !== 'ended' || later !== 'PT401' || r)
    throw new Error(JSON.stringify({ again, later, r }))
  return 'ended stays ended; a forgotten old session is refused'
})
await step('0081: another tab: only a valid browser key approves (via device)', async () => {
  // the key is made after the code, in the approved code session
  await as81(staff.nurse, sidCode81, 'otp')
  if (!(await one(`select trust_this_device($1, 'gate test') as u`, [key81])).u)
    throw new Error('no key made')
  // a wrong key: nothing
  await as81(staff.nurse, sidDevice81, 'password')
  const wrong = (await one(`select use_trusted_device($1) as e`, [key81.replace(/g$/, 'h')])).e
  const okWrong = (await one(`select session_ok() as ok`)).ok
  // someone else holding this key: nothing
  const other = crypto.randomUUID()
  await as81(staff.receptionist, other, 'password')
  const foreign = (await one(`select use_trusted_device($1) as e`, [key81])).e
  const okForeign = (await one(`select session_ok() as ok`)).ok
  // the right key
  await as81(staff.nurse, sidDevice81, 'password')
  const end = (await one(`select use_trusted_device($1) as e`, [key81])).e
  const ok = (await one(`select session_ok() as ok`)).ok
  const p = (await one(`select record_sign_in('device') as j`)).j
  const table = await gate81('/patient', 'GET')
  const r = await row81(sidDevice81)
  const foreignRow = await row81(other)
  if (wrong || okWrong || foreign || okForeign || foreignRow || !end || !ok || p.role !== 'nurse')
    throw new Error(JSON.stringify({ wrong, okWrong, foreign, okForeign, foreignRow, end, ok }))
  if (table !== 'pass' || r?.via !== 'device') throw new Error(JSON.stringify({ table, r }))
  return 'wrong / foreign key refused; own key approves'
})
await step('0081: a revoked browser key approves nothing', async () => {
  const k = 'r'.repeat(40)
  const sid = crypto.randomUUID()
  await as81(staff.nurse, sidCode81, 'otp')
  await db.query(`select trust_this_device($1, 'gate test 2')`, [k])
  await db.query(`select revoke_this_device($1)`, [k])
  await as81(staff.nurse, sid, 'password')
  const e = (await one(`select use_trusted_device($1) as e`, [k])).e
  const ok = (await one(`select session_ok() as ok`)).ok
  if (e || ok) throw new Error(JSON.stringify({ e, ok }))
  return 'refused'
})
await step('0081: activity (touch_session) keeps the session for N hours from now', async () => {
  const hours = (await one(`select session_hours() as h`)).h
  await asAdmin()
  await db.query(
    `update approved_session set last_seen_at = now() - make_interval(hours => $2) + interval '10 minutes'
      where session_id = $1`,
    [sidCode81, hours],
  )
  await as81(staff.nurse, sidCode81, 'otp')
  const before = await gate81('/patient', 'GET')
  const touched = (await one(`select touch_session() as b`)).b
  const r = await row81(sidCode81)
  const age = (
    await one(`select extract(epoch from now() - $1::timestamptz)::int as s`, [r.last_seen_at])
  ).s
  if (before !== 'pass' || !touched || age > 5)
    throw new Error(JSON.stringify({ before, touched, age }))
  return `${hours} h from now`
})
await step('0081: N hours without activity: refused, ended as idle, never revived', async () => {
  const hours = (await one(`select session_hours() as h`)).h
  await asAdmin()
  // past the hours and the 10 minutes of grace
  await db.query(
    `update approved_session set last_seen_at = now() - make_interval(hours => $2) - interval '11 minutes'
      where session_id = $1`,
    [sidCode81, hours],
  )
  await as81(staff.nurse, sidCode81, 'otp')
  const table = await gate81('/patient', 'GET')
  const touched = (await one(`select touch_session() as b`)).b
  const r = await row81(sidCode81)
  // neither another touch, a browser key nor a new record_sign_in brings it back
  await as81(staff.nurse, sidCode81, 'otp')
  const touched2 = (await one(`select touch_session() as b`)).b
  const k = 'i'.repeat(40)
  await db.query(`select trust_this_device($1, 'idle test')`, [k])
  const key = (await one(`select use_trusted_device($1) as e`, [k])).e
  let again = null
  try {
    await db.query(`select record_sign_in('again')`)
  } catch (e) {
    again = e.hint
  }
  const ok = (await one(`select session_ok() as ok`)).ok
  const after = await gate81('/rpc/find_patients')
  if (
    !refused81(table, 'idle') ||
    !/without activity/.test(table.message) ||
    touched ||
    touched2 ||
    r.ended_reason !== 'idle' ||
    !r.ended_at ||
    key ||
    again !== 'idle' ||
    ok ||
    !refused81(after, 'idle')
  )
    throw new Error(JSON.stringify({ table, touched, touched2, r, key, again, ok, after }))
  return table.message
})
await step('0081: a signed-out session (end_session) is refused', async () => {
  await as81(staff.nurse, sidDevice81, 'password')
  const before = await gate81('/patient', 'GET')
  await db.query(`select end_session('signed out')`)
  const ok = (await one(`select session_ok() as ok`)).ok
  const table = await gate81('/patient', 'GET')
  const touched = (await one(`select touch_session() as b`)).b
  const key = (await one(`select use_trusted_device($1) as e`, [key81])).e
  const r = await row81(sidDevice81)
  if (
    before !== 'pass' ||
    ok ||
    !refused81(table, 'ended') ||
    touched ||
    key ||
    r.ended_reason !== 'signed out'
  )
    throw new Error(JSON.stringify({ before, ok, table, touched, key, r }))
  return table.message
})
await expectError(
  '0081: a PIN-only manager session cannot end every browser key',
  async () => {
    await as81(staff.manager, crypto.randomUUID(), 'password')
    await db.query(`select revoke_trusted_devices(true)`)
  },
  /not approved/i,
)
await expectError(
  '0081: ... nor a code session that was signed out',
  async () => {
    const sid = crypto.randomUUID()
    await as81(staff.manager, sid, 'otp')
    await db.query(`select record_sign_in('code')`)
    await db.query(`select end_session('signed out')`)
    await db.query(`select revoke_trusted_devices(true)`)
  },
  /not approved/i,
)
await step('0081: before the code, a PIN change is allowed only for the first PIN', async () => {
  // not the first PIN: refused
  await asAdmin()
  await db.query(`update profiles set must_change_pin = false where id = $1`, [staff.lab_tech])
  await as81(staff.lab_tech, crypto.randomUUID(), 'password')
  let refused = null
  try {
    await db.query(`select mark_pin_changed()`)
  } catch (e) {
    refused = e.code
  }
  // the first PIN (temporary PIN from the manager): allowed and written in the history
  await asAdmin()
  await db.query(`update profiles set must_change_pin = true where id = $1`, [staff.lab_tech])
  await as81(staff.lab_tech, crypto.randomUUID(), 'password')
  const first = (await one(`select my_must_change_pin() as b`)).b
  await db.query(`select mark_pin_changed()`)
  await asAdmin()
  const flag = (
    await one(`select must_change_pin as b from profiles where id = $1`, [staff.lab_tech])
  ).b
  const audit = (
    await one(
      `select count(*)::int as n from audit_event where actor_id = $1 and reason like 'PIN changed%'`,
      [staff.lab_tech],
    )
  ).n
  if (refused !== 'PT401' || !first || flag || audit < 1)
    throw new Error(JSON.stringify({ refused, first, flag, audit }))
  return 'other PIN changes refused; first PIN allowed and recorded'
})
await step('0081: visitors (anon) and the server (service_role) are not touched', async () => {
  await as(null, 'anon', '')
  const anon = await gate81('/rpc/public_clinic_info')
  const anonTable = await gate81('/public_service_lines', 'GET')
  const anonLogin = await gate81('/rpc/staff_login_email')
  await as(null, 'service_role', '')
  const server = await gate81('/profiles', 'GET')
  await asAdmin()
  if (anon !== 'pass' || anonTable !== 'pass' || anonLogin !== 'pass' || server !== 'pass')
    throw new Error(JSON.stringify({ anon, anonTable, anonLogin, server }))
  return 'pass'
})
await step('0081: kill switch security.enforce_code off lets everything through', async () => {
  const sid = crypto.randomUUID()
  await switch81(false)
  await as81(staff.nurse, sid, 'password')
  const off = await gate81('/patient', 'GET')
  const p = (await one(`select record_sign_in('switch off') as j`)).j
  const status = (await one(`select session_status() as j`)).j
  // the screens never sign anyone out because of the rule while it is off
  const touched = (await one(`select touch_session() as b`)).b
  await switch81(true)
  await as81(staff.nurse, sid, 'password')
  const on = await gate81('/patient', 'GET')
  const touchedOn = (await one(`select touch_session() as b`)).b
  await asAdmin()
  if (
    off !== 'pass' ||
    p.role !== 'nurse' ||
    !status.ok ||
    status.enforced ||
    !touched ||
    touchedOn ||
    !refused81(on)
  )
    throw new Error(JSON.stringify({ off, status, touched, touchedOn, on }))
  return 'off: pass · on: refused'
})
await step('0081: the switch and the hours cannot be changed through the API', async () => {
  // an approved manager (settings.write) writing the table directly: refused
  const tries = [
    `update setting set value = '{"on": false}' where key = 'security.enforce_code'`,
    `delete from setting where key = 'security.enforce_code'`,
    `update setting set value = '{"hours": 12}' where key = 'security.session'`,
    `insert into setting (key, value) values ('security.other', '{}')`,
  ]
  const passed = []
  for (const q of tries) {
    await asApproved(staff.manager)
    try {
      await db.query(q)
      passed.push(q)
    } catch (e) {
      if (!/settings screen only|permission denied/.test(String(e.message)))
        passed.push(`${q}: ${e.message}`)
    }
  }
  // save_setting (role check + history) still works for the hours
  await asApproved(staff.manager)
  await db.query(`select save_setting('security.session', '{"hours": 5}'::jsonb)`)
  await asAdmin()
  const sw = (await one(`select value from setting where key = 'security.enforce_code'`)).value
  if (passed.length || sw?.on !== true) throw new Error(JSON.stringify({ passed, sw }))
  return 'direct writes refused; save_setting works'
})
await step('0081: the approvals are closed to the API; the gate runs for every role', async () => {
  await asAdmin()
  const r = await one(
    `select has_table_privilege('authenticated', 'approved_session', 'select') as staff_read,
            has_table_privilege('anon', 'approved_session', 'select') as anon_read,
            has_table_privilege('authenticated', 'approved_session', 'insert') as staff_write,
            has_function_privilege('anon', 'session_ok()', 'execute') as anon_ok,
            has_function_privilege('anon', 'record_sign_in(text)', 'execute') as anon_sign,
            has_function_privilege('authenticated', 'touch_session()', 'execute') as staff_touch,
            has_function_privilege('authenticated', 'end_session(text)', 'execute') as staff_end,
            has_function_privilege('anon', 'check_request()', 'execute') as anon_gate,
            has_function_privilege('authenticated', 'check_request()', 'execute') as staff_gate,
            has_function_privilege('service_role', 'check_request()', 'execute') as server_gate,
            (select value from setting where key = 'security.enforce_code') as switch`,
  )
  if (
    r.staff_read ||
    r.anon_read ||
    r.staff_write ||
    r.anon_ok ||
    r.anon_sign ||
    !r.staff_touch ||
    !r.staff_end ||
    !r.anon_gate ||
    !r.staff_gate ||
    !r.server_gate ||
    r.switch?.on !== true
  )
    throw new Error(JSON.stringify(r))
  return 'table closed; gate callable by anon, staff, server; switch on'
})

// ---------------------------------------------------------------- 0082: dispensing and money
const t82 = {}
/** The error code of a statement run as someone (null when it succeeds). */
const codeAs = async (who, sql, params = []) => {
  await as(who)
  try {
    await db.query(sql, params)
    return null
  } catch (e) {
    return e.code ?? String(e.message).split('\n')[0]
  } finally {
    await asAdmin()
  }
}
const openStations82 = async (enc) =>
  (
    await db.query(
      `select station::text as s from queue_entry where encounter_id = $1 and finished_at is null
        and deleted_at is null order by station`,
      [enc],
    )
  ).rows.map((r) => r.s)
await step(
  '0082: set-up: an insurer price list, two pharmacy stores, an insured patient',
  async () => {
    await as(staff.manager)
    t82.amox = (
      await one(`select upsert_item(null, 'Amoxicillin 82', 300, '500 mg', 'capsule', 'cap') as id`)
    ).id
    t82.para = (
      await one(`select upsert_item(null, 'Paracetamol 82', 50, '500 mg', 'tablet', 'tab') as id`)
    ).id
    t82.ors = (
      await one(`select upsert_item(null, 'ORS 82', 200, null, 'sachet', 'sachet') as id`)
    ).id
    t82.ph2 = (await one(`select save_location(null, 'Pharmacy 2 (82)', 'pharmacy') as id`)).id
    await asAdmin()
    t82.main = (await one(`select main_pharmacy() as id`)).id
    t82.mainStore = (
      await one(`select id from stock_location where type = 'main_store' and active limit 1`)
    ).id
    // RHIA rule on amoxicillin: children's doctor only (a warning, never a refusal)
    await db.query(`update item set prescribing_rule = 'PED' where id = $1`, [t82.amox])
    const payer = (
      await one(
        `insert into payer (code, name, type) values ('INS82', 'Insurer 82', 'private') returning id`,
      )
    ).id
    const plan = (
      await one(
        `insert into plan (payer_id, name, coverage_pct, pct_by_group)
       values ($1, 'Plan 82', 50, '{"pharmacy": 90}') returning id`,
        [payer],
      )
    ).id
    const list = (
      await one(
        `insert into price_list (payer_id, name) values ($1, 'Insurer 82 prices') returning id`,
        [payer],
      )
    ).id
    await db.query(
      `insert into price_list_item (price_list_id, item_id, price) values ($1, $2, 250)`,
      [list, t82.amox],
    )
    await as(staff.manager)
    await db.query(`select receive_stock($1, $2, 20, 100, 'AMX-82A', '2030-06-30')`, [
      t82.amox,
      t82.main,
    ])
    await db.query(`select receive_stock($1, $2, 5, 100, 'AMX-82B', '2030-06-30')`, [
      t82.amox,
      t82.ph2,
    ])
    await db.query(`select receive_stock($1, $2, 10, 20, 'PAR-82', '2030-06-30')`, [
      t82.para,
      t82.main,
    ])
    await as(staff.receptionist)
    t82.patient = (
      await one(
        `select register_patient_file('Ishimwe', 'Insured 82', 'female', '2019-03-01') as r`,
      )
    ).r.patient_id
    await asAdmin()
    await db.query(`update patient set allergies = 'Penicillin' where id = $1`, [t82.patient])
    t82.coverage = (
      await one(
        `insert into coverage (patient_id, payer_id, plan_id, member_number)
       values ($1, $2, $3, 'M-82') returning id`,
        [t82.patient, payer, plan],
      )
    ).id
    await as(staff.receptionist)
    t82.enc = (
      await one(`select open_encounter($1, 'opd', 'consultation', $2) as id`, [
        t82.patient,
        t82.coverage,
      ])
    ).id
    await asAdmin()
    const q = await one(
      `select id from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [t82.enc],
    )
    await as(d1)
    await db.query(`select take_patient($1)`, [q.id])
    await asAdmin()
    const stores = (
      await one(
        `select count(*)::int as n from stock_location where type = 'pharmacy' and active and deleted_at is null`,
      )
    ).n
    if (!t82.main || t82.main === t82.ph2 || stores < 2)
      throw new Error(JSON.stringify({ t82, stores }))
    return `main pharmacy + Pharmacy 2; ${stores} open pharmacy stores`
  },
)
await step('0082 CHK-1: prescribe warns about the RHIA rule, never refuses', async () => {
  await as(d1)
  t82.rx = (
    await one(`select prescribe($1, $2, 4, '1 cap', 'oral', 'TDS', 5, null, 'pharmacy') as j`, [
      t82.enc,
      t82.amox,
    ])
  ).j
  await asAdmin()
  const rules = await one(
    `select rx_rule_ok('PED', 'Paediatrician') as ped, rx_rule_ok('IM or PED', 'Internal medicine') as im,
            rx_rule_ok('DT', 'General practitioner') as dt, rx_rule_ok('HU', 'Surgeon') as hu,
            rx_rule_ok('SPEC', 'General practitioner') as spec_gp, rx_rule_ok('SPEC', 'Cardiologist') as spec,
            rx_rule_ok(null, 'x') as none`,
  )
  const w = t82.rx.warnings ?? []
  if (
    !t82.rx.id ||
    w.length !== 1 ||
    w[0].kind !== 'prescribingRule' ||
    w[0].rule !== 'PED' ||
    rules.ped !== true ||
    rules.im !== true ||
    rules.dt !== false ||
    rules.hu !== null ||
    rules.spec_gp !== false ||
    rules.spec !== true ||
    rules.none !== null
  )
    throw new Error(JSON.stringify({ rx: t82.rx, rules }))
  return `warning ${w[0].kind} (${w[0].rule}); rule matching by specialty works`
})
await step(
  '0082 PRICE-1 / STORE-1 / CHK-1: the pharmacy list prices like the bill, per store, with the check data',
  async () => {
    await as(staff.pharmacist)
    const q = (await one(`select pharmacy_queue() as j`)).j
    const q2 = (await one(`select pharmacy_queue($1) as j`, [t82.ph2])).j
    await asAdmin()
    const bad = await codeAs(staff.pharmacist, `select pharmacy_queue($1)`, [t82.mainStore])
    const l = q.lines.find((x) => x.requestId === t82.rx.id)
    const l2 = q2.lines.find((x) => x.requestId === t82.rx.id)
    const pt = q.patients.find((x) => x.encounterId === t82.enc)
    const mainRow = q.stores.find((s) => s.id === t82.main)
    if (
      !l ||
      Number(l.cashPrice) !== 300 ||
      Number(l.price) !== 300 ||
      Number(l.payerPrice) !== 250 ||
      Number(l.lineTotal) !== 1000 ||
      Number(l.coveragePct) !== 90 ||
      Number(l.insurerShare) !== 900 ||
      Number(l.patientShare) !== 100 ||
      l.payer !== 'Insurer 82' ||
      l.onHandPharmacy !== 20 ||
      l.locationId !== t82.main ||
      l.allergies !== 'Penicillin' ||
      l.sex !== 'female' ||
      typeof l.ageYears !== 'number' ||
      l.prescribingRule !== 'PED' ||
      l.ruleOk !== false ||
      l.doctorHolds !== true ||
      l2.onHandPharmacy !== 5 ||
      l2.locationId !== t82.ph2 ||
      l2.onHandElsewhere < 20 ||
      !pt ||
      Number(pt.patientShare) !== 100 ||
      Number(pt.total) !== 1000 ||
      pt.allergies !== 'Penicillin' ||
      typeof pt.ageMonths !== 'number' ||
      !mainRow?.isMain ||
      q.stores.length < 2 ||
      q2.locationId !== t82.ph2 ||
      bad !== '22023'
    )
      throw new Error(JSON.stringify({ l, l2, pt, stores: q.stores, bad }))
    return `cash 300, insurer list 250 × 4 = 1,000: patient 100, insurer 900; main 20 / Pharmacy 2: 5; a non-pharmacy store refused`
  },
)
await step('0082 ORD-2: no hand-over while the doctor still has the patient', async () => {
  const held = await codeAs(staff.pharmacist, `select dispense_prescription($1)`, [t82.rx.id])
  const notGiven = (await one(`select given_at from medication_request where id = $1`, [t82.rx.id]))
    .given_at
  // a sale written by the pharmacist is not held: from Pharmacy 2, charged like the bill
  await as(staff.pharmacist)
  const sold = (
    await one(`select sell_medicine($1, $2, 1, null, $3) as j`, [t82.enc, t82.amox, t82.ph2])
  ).j
  await asAdmin()
  const ph2 = (await one(`select usable_stock($1, $2) as n`, [t82.amox, t82.ph2])).n
  if (held !== 'MS002' || notGiven || !sold.charged || sold.locationId !== t82.ph2 || ph2 !== 4)
    throw new Error(JSON.stringify({ held, notGiven, sold, ph2 }))
  return 'refused (MS002) while held; the pharmacist’s own sale goes through (Pharmacy 2: 5 → 4)'
})
await step(
  '0082 STORE-1 / PAY-END: sent on, handed over from the chosen store → cashier; the bill matches the desk',
  async () => {
    await as(d1)
    await db.query(`select refer_patient($1, 'consultation', 'pharmacy')`, [t82.enc])
    await as(staff.pharmacist)
    const d = (await one(`select dispense_prescription($1, $2) as j`, [t82.rx.id, t82.ph2])).j
    await asAdmin()
    const line = await one(
      `select patient_share, insurer_share, unit_price from invoice_line
        where source_type = 'medication_dispense' and source_id = $1 and deleted_at is null`,
      [d.dispenseId],
    )
    const ph2 = (await one(`select usable_stock($1, $2) as n`, [t82.amox, t82.ph2])).n
    const main = (await one(`select usable_stock($1, $2) as n`, [t82.amox, t82.main])).n
    const mv = await one(
      `select count(*)::int as n from stock_movement where medication_request_id = $1 and type = 'dispense'`,
      [t82.rx.id],
    )
    const stations = await openStations82(t82.enc)
    const bal = (
      await one(`select invoice_balance(id) as b from invoice where encounter_id = $1`, [t82.enc])
    ).b
    if (
      !d.charged ||
      d.locationId !== t82.ph2 ||
      Number(line.patient_share) !== 100 ||
      Number(line.insurer_share) !== 900 ||
      ph2 !== 0 ||
      main !== 20 ||
      mv.n < 1 ||
      JSON.stringify(stations) !== '["cashier"]' ||
      Number(bal) !== 125
    )
      throw new Error(JSON.stringify({ d, line, ph2, main, mv, stations, bal }))
    return 'Pharmacy 2 → 0, main untouched; bill line 100 / 900 as the desk said; patient at the cashier (125 due)'
  },
)
await step(
  '0082 PAY-END: an open visit of an earlier day with money due is on the unpaid list',
  async () => {
    await asAdmin()
    await db.query(`update encounter set arrived_at = now() - interval '2 days' where id = $1`, [
      t82.enc,
    ])
    await as(staff.cashier)
    const list = (await one(`select unpaid_debts() as j`)).j
    await asAdmin()
    await db.query(`update encounter set arrived_at = now() where id = $1`, [t82.enc])
    const row = list.find((x) => x.encounterId === t82.enc)
    if (!row || row.status !== 'open' || Number(row.amount) !== 125 || !row.since)
      throw new Error(JSON.stringify(row))
    return `listed: ${row.status}, ${row.amount} RWF since ${String(row.since).slice(0, 10)}`
  },
)
await step(
  '0082 RET-1: a return after the bill is posted: stock back, line kept, credit note, cashier told',
  async () => {
    await as(staff.cashier)
    const paid = (await one(`select take_payment($1, 'cash', 125) as j`, [t82.enc])).j
    await asAdmin()
    const inv = await one(`select id, status, patient_share from invoice where encounter_id = $1`, [
      t82.enc,
    ])
    const linesBefore = (
      await one(
        `select count(*)::int as n from invoice_line where invoice_id = $1 and deleted_at is null`,
        [inv.id],
      )
    ).n
    const claimBefore = await one(`select amount from claim where invoice_id = $1`, [inv.id])
    await as(staff.pharmacist)
    const back = (await one(`select return_medicine($1, 'wrong medicine') as j`, [t82.rx.id])).j
    await asAdmin()
    const linesAfter = (
      await one(
        `select count(*)::int as n from invoice_line where invoice_id = $1 and deleted_at is null`,
        [inv.id],
      )
    ).n
    const cn = await one(
      `select number, patient_amount, insurer_amount, total from credit_note where invoice_id = $1`,
      [inv.id],
    )
    const claimAfter = await one(`select amount from claim where invoice_id = $1`, [inv.id])
    const m = await one(
      `select given_at, not_given_reason, rx_pending(m) as pending from medication_request m where id = $1`,
      [t82.rx.id],
    )
    const ph2 = (await one(`select usable_stock($1, $2) as n`, [t82.amox, t82.ph2])).n
    const told = await one(
      `select count(*)::int as n from notification where kind = 'refund_due' and 'cashier' = any(recipient_stations)
         and link like '%' || $1 || '%'`,
      [t82.enc],
    )
    await as(staff.cashier)
    const refunded = (
      await one(`select refund_payment($1, 100, 'cash', 'returned medicine') as r`, [t82.enc])
    ).r
    await asAdmin()
    if (
      !paid.closed ||
      inv.status !== 'posted' ||
      back.mode !== 'credit' ||
      Number(back.credit) !== 100 ||
      Number(back.balance) !== -100 ||
      back.units !== 4 ||
      linesAfter !== linesBefore ||
      !/^CN-/.test(cn?.number ?? '') ||
      Number(cn.patient_amount) !== 100 ||
      Number(cn.insurer_amount) !== 900 ||
      Number(claimBefore?.amount) !== Number(claimAfter?.amount) + 900 ||
      m.given_at ||
      m.pending ||
      !/^returned: wrong medicine/.test(m.not_given_reason ?? '') ||
      ph2 !== 4 ||
      told.n !== 1 ||
      Number(refunded.balance) !== 0
    )
      throw new Error(
        JSON.stringify({
          paid,
          inv,
          back,
          linesBefore,
          linesAfter,
          cn,
          claimBefore,
          claimAfter,
          m,
          ph2,
          told,
          refunded,
        }),
      )
    return `posted bill kept (${linesAfter} lines); ${cn.number}: patient 100 back, claim −900; 4 units back; cashier told; refunded → 0`
  },
)
await step(
  '0082 CHG-1: a closed bill refuses the charge (MS001); the hand-over takes nothing',
  async () => {
    const p = await visitAt('Closedbill 82')
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    const rx = (
      await one(`select prescribe($1, $2, 2, null, null, null, null, null, 'pharmacy') as j`, [
        p.enc,
        t82.para,
      ])
    ).j
    await db.query(`select refer_patient($1, 'consultation', 'pharmacy')`, [p.enc])
    await asAdmin()
    // the bill posted early (straight through the API by the cashier, or a return case)
    const inv = (await one(`select id from invoice where encounter_id = $1`, [p.enc])).id
    await db.query(
      `insert into invoice_line (invoice_id, item_id, description, quantity, unit_price, office)
     values ($1, $2, 'early line', 1, 10, 'pharmacy')`,
      [inv, t82.para],
    )
    await db.query(`select post_invoice_now($1)`, [inv])
    const before = (await one(`select usable_stock($1, $2) as n`, [t82.para, t82.main])).n
    const refused = await codeAs(staff.pharmacist, `select dispense_prescription($1)`, [rx.id])
    const after = (await one(`select usable_stock($1, $2) as n`, [t82.para, t82.main])).n
    let direct = null
    try {
      await db.query(`select add_charge_internal($1, 'pharmacy', null, $2, 1)`, [p.enc, t82.para])
    } catch (e) {
      direct = e.code
    }
    const m = await one(`select given_at from medication_request where id = $1`, [rx.id])
    if (refused !== 'MS001' || direct !== 'MS001' || before !== after || m.given_at)
      throw new Error(JSON.stringify({ refused, direct, before, after, m }))
    return `refused MS001; stock ${before} → ${after}; not marked given`
  },
)
await step(
  '0082 ORD-2 / TRACK-1: the prescriber cancels a waiting line (reason); others may not; shown as cancelled',
  async () => {
    const p = await visitAt('Cancel 82')
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    const a = (
      await one(`select prescribe($1, $2, 3, null, null, null, null, null, 'pharmacy') as j`, [
        p.enc,
        t82.para,
      ])
    ).j
    const b = (
      await one(`select prescribe($1, $2, 1, null, null, null, null, null, 'pharmacy') as j`, [
        p.enc,
        t82.ors,
      ])
    ).j
    const other = await codeAs(d2, `select cancel_prescription($1, 'not mine')`, [a.id])
    const noReason = await codeAs(d1, `select cancel_prescription($1, '')`, [a.id])
    await as(d1)
    const c1 = (await one(`select cancel_prescription($1, 'wrong dose') as j`, [a.id])).j
    await as(staff.pharmacist)
    const q = (await one(`select pharmacy_queue() as j`)).j
    await asAdmin()
    const gone = !q.lines.some((x) => x.requestId === a.id)
    const stillB = q.lines.some((x) => x.requestId === b.id)
    const handCancelled = await codeAs(staff.pharmacist, `select dispense_prescription($1)`, [a.id])
    const twice = await codeAs(d1, `select cancel_prescription($1, 'again')`, [a.id])
    const told = await one(
      `select count(*)::int as n from notification where kind = 'rx_cancelled' and 'pharmacy' = any(recipient_stations)
         and params ->> 'reason' = 'wrong dose'`,
    )
    // the last line cancelled: the pharmacy place closes (the doctor still has the patient)
    await as(d1)
    const c2 = (await one(`select cancel_prescription($1, 'not needed') as j`, [b.id])).j
    const journey = (await one(`select visit_journey($1) as j`, [p.enc])).j
    const clinical = (await one(`select visit_clinical($1) as j`, [p.enc])).j
    const mine = (await one(`select my_prescriptions(1) as j`)).j
    await asAdmin()
    const stations = await openStations82(p.enc)
    const jm = journey.medicines.find((x) => x.cancelReason === 'wrong dose')
    const cm = clinical.prescriptions.find((x) => x.id === a.id)
    const mm = mine.find((x) => x.id === a.id)
    if (
      other !== '42501' ||
      noReason !== '22023' ||
      c1.pending !== 1 ||
      !gone ||
      !stillB ||
      handCancelled !== '23505' ||
      twice !== 'P0002' ||
      told.n !== 1 ||
      c2.pending !== 0 ||
      stations.includes('pharmacy') ||
      !stations.includes('consultation') ||
      !jm?.cancelledAt ||
      !cm?.cancelledAt ||
      cm.pending !== false ||
      cm.prescriberId !== d1 ||
      mm?.state !== 'cancelled'
    )
      throw new Error(
        JSON.stringify({
          other,
          noReason,
          c1,
          gone,
          stillB,
          handCancelled,
          twice,
          told,
          c2,
          stations,
          jm,
          cm,
          mm,
        }),
      )
    return 'another doctor refused; cancelled with its reason, off the pharmacy list, pharmacy told; journey/clinical/my list say cancelled'
  },
)
await step('0082 TRACK-1: the visit track says not given, with the reason', async () => {
  const p = await visitAt('Notgiven 82')
  await as(d1)
  await db.query(`select take_patient($1)`, [p.queue])
  const a = (
    await one(`select prescribe($1, $2, 1, null, null, null, null, null, 'pharmacy') as j`, [
      p.enc,
      t82.ors,
    ])
  ).j
  await as(staff.pharmacist)
  await db.query(`select rx_not_given($1, 'out of stock')`, [a.id])
  await as(d1)
  const j = (await one(`select visit_journey($1) as j`, [p.enc])).j
  await asAdmin()
  const m = j.medicines[0]
  if (!m?.notGivenAt || m.notGivenReason !== 'out of stock' || m.cancelledAt)
    throw new Error(JSON.stringify(m))
  return `not given: “${m.notGivenReason}”`
})
await step(
  '0082 ROOM-1: given here from unexpired stock across batches; never expired; short is refused',
  async () => {
    await as(staff.manager)
    // 0083: a room store held by d1, supplied by the pharmacy with a transfer note
    t82.room = (
      await one(`select save_room_store(null, 'Room store 82', 'nursing', $1) as id`, [[d1]])
    ).id
    await db.query(`select receive_stock($1, $2, 3, 50, 'ORS-82A', '2030-01-31')`, [
      t82.ors,
      t82.main,
    ])
    await db.query(`select receive_stock($1, $2, 3, 50, 'ORS-82B', '2031-01-31')`, [
      t82.ors,
      t82.main,
    ])
    const ors82 = (
      await one(`select send_to_room($1, $2::jsonb, null, null, $3) as j`, [
        t82.room,
        JSON.stringify([{ itemId: t82.ors, quantity: 6 }]),
        t82.main,
      ])
    ).j
    await as(d1)
    await db.query(`select confirm_receipt($1)`, [ors82.id])
    await asAdmin()
    // 4 expired units on the shelf (an old delivery)
    const old = (
      await one(
        `insert into batch (item_id, batch_no, expiry, unit_cost) values ($1, 'ORS-82OLD', current_date - 10, 50) returning id`,
        [t82.ors],
      )
    ).id
    await db.query(
      `insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
       values ($1, $2, $3, 4, 'receipt', 'old delivery')`,
      [t82.ors, old, t82.room],
    )
    const p = await visitAt('Room 82')
    t82.roomEnc = p.enc
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    // 5 = 3 + 2 from two batches (no single batch holds 5)
    const r = (
      await one(
        `select prescribe($1, $2, 5, null, null, null, null, null, 'room', 'consultation') as j`,
        [p.enc, t82.ors],
      )
    ).j
    await asAdmin()
    const left = await db.query(
      `select b.batch_no, s.quantity from stock_on_hand s join batch b on b.id = s.batch_id
        where s.item_id = $1 and s.location_id = $2 order by b.batch_no`,
      [t82.ors, t82.room],
    )
    const byBatch = Object.fromEntries(left.rows.map((x) => [x.batch_no, x.quantity]))
    const moved = await one(
      `select count(*)::int as n, sum(quantity)::int as q from stock_movement
        where medication_request_id = $1 and type = 'consumption'`,
      [r.id],
    )
    const linesBefore = (
      await one(`select count(*)::int as n from medication_request where encounter_id = $1`, [
        p.enc,
      ])
    ).n
    // 2 more: only 1 unexpired unit left (4 expired are never given): refused, nothing written
    const short = await codeAs(
      d1,
      `select prescribe($1, $2, 2, null, null, null, null, null, 'room', 'consultation')`,
      [p.enc, t82.ors],
    )
    // a chosen store that holds none: refused too
    const chosen = await codeAs(
      d1,
      `select prescribe($1, $2, 1, null, null, null, null, null, 'room', 'consultation', $3)`,
      [p.enc, t82.para, t82.room],
    )
    const linesAfter = (
      await one(`select count(*)::int as n from medication_request where encounter_id = $1`, [
        p.enc,
      ])
    ).n
    const charge = await one(
      `select count(*)::int as n, coalesce(sum(l.patient_share), 0) as due from invoice_line l
        join invoice i on i.id = l.invoice_id where i.encounter_id = $1 and l.deleted_at is null`,
      [p.enc],
    )
    if (
      !r.stockTaken ||
      !r.charged ||
      r.locationId !== t82.room ||
      byBatch['ORS-82A'] !== 0 ||
      byBatch['ORS-82B'] !== 1 ||
      byBatch['ORS-82OLD'] !== 4 ||
      moved.n !== 2 ||
      moved.q !== 5 ||
      short !== 'MS003' ||
      chosen !== 'MS003' ||
      linesAfter !== linesBefore ||
      charge.n !== 1 ||
      Number(charge.due) !== 1000
    )
      throw new Error(
        JSON.stringify({ r, byBatch, moved, short, chosen, linesBefore, linesAfter, charge }),
      )
    return '5 given from batches A (3) + B (2), expired untouched; 2 more refused (MS003), nothing written or charged'
  },
)
await step(
  '0082 PAY-END: given here, the doctor finishes → cashier; the patient leaves unpaid → on the unpaid list',
  async () => {
    await as(d1)
    await db.query(`select add_diagnosis($1, 'Diarrhoea', 'A09', 'primary')`, [t82.roomEnc])
    await db.query(`select finish_visit($1)`, [t82.roomEnc])
    await asAdmin()
    const stations = await openStations82(t82.roomEnc)
    // reception may not close it with money due; the manager may, with the reason
    const rec = await codeAs(staff.receptionist, `select end_visit($1, 'went home')`, [t82.roomEnc])
    await as(staff.manager)
    await db.query(`select end_visit($1, 'left without paying')`, [t82.roomEnc])
    await as(staff.cashier)
    const list = (await one(`select unpaid_debts() as j`)).j
    await asAdmin()
    const row = list.find((x) => x.encounterId === t82.roomEnc)
    if (
      JSON.stringify(stations) !== '["cashier"]' ||
      rec !== '23514' ||
      !row ||
      row.status !== 'left' ||
      Number(row.amount) !== 1000 ||
      row.reason !== 'left without paying'
    )
      throw new Error(JSON.stringify({ stations, rec, row }))
    return `finish → cashier; left: listed as ${row.status}, ${row.amount} RWF`
  },
)
await step(
  '0082 NEG-1: every function that takes stock locks (medicine, store) first',
  async () => {
    await asAdmin()
    const r = await db.query(
      `select p.proname, position('lock_stock(' in p.prosrc) > 0 as locks
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('dispense_fefo', 'use_stock', 'transfer_stock', 'adjust_stock', 'give_from_store')`,
    )
    const missing = r.rows.filter((x) => !x.locks).map((x) => x.proname)
    // the lock itself works and is held to the end of the transaction
    await db.query(`select lock_stock($1, $2)`, [t82.ors, t82.room])
    const staffCall = await codeAs(staff.pharmacist, `select lock_stock($1, $2)`, [
      t82.ors,
      t82.room,
    ])
    if (r.rows.length !== 5 || missing.length || staffCall !== '42501')
      throw new Error(JSON.stringify({ rows: r.rows, missing, staffCall }))
    return '5 functions lock before reading the balance; the lock is internal'
  },
)
await step(
  '0082 RIGHTS-1: the ledger and the hand-over fields change only through the functions',
  async () => {
    const [anyRx] = (
      await db.query(`select id, encounter_id, item_id from medication_request where id = $1`, [
        t82.rx.id,
      ])
    ).rows
    const tries = {
      giveDirect: await codeAs(d1, `update medication_request set given_at = now() where id = $1`, [
        anyRx.id,
      ]),
      notGivenDirect: await codeAs(
        d1,
        `update medication_request set not_given_at = now(), not_given_reason = 'x' where id = $1`,
        [anyRx.id],
      ),
      supplyDirect: await codeAs(
        d1,
        `update medication_request set supply = 'room' where id = $1`,
        [anyRx.id],
      ),
      qtyDirect: await codeAs(d1, `update medication_request set quantity = 1 where id = $1`, [
        anyRx.id,
      ]),
      cancelDirect: await codeAs(
        d1,
        `update medication_request set cancelled_at = now() where id = $1`,
        [anyRx.id],
      ),
      deleteSoft: await codeAs(
        d1,
        `update medication_request set deleted_at = now() where id = $1`,
        [anyRx.id],
      ),
      insertDirect: await codeAs(
        d1,
        `insert into medication_request (encounter_id, item_id, quantity) values ($1, $2, 1)`,
        [anyRx.encounter_id, anyRx.item_id],
      ),
      deleteHard: await codeAs(staff.manager, `delete from medication_request where id = $1`, [
        anyRx.id,
      ]),
      movement: await codeAs(
        staff.pharmacist,
        `insert into stock_movement (item_id, to_location_id, quantity, type) values ($1, $2, 99, 'receipt')`,
        [t82.ors, t82.room],
      ),
      movementEdit: await codeAs(
        staff.manager,
        `update stock_movement set quantity = 1 where item_id = $1`,
        [t82.ors],
      ),
      batch: await codeAs(
        staff.pharmacist,
        `update batch set expiry = '2040-01-01' where item_id = $1`,
        [t82.ors],
      ),
      dispense: await codeAs(
        staff.pharmacist,
        `update medication_dispense set deleted_at = now() where item_id = $1`,
        [t82.amox],
      ),
      credit: await codeAs(
        staff.manager,
        `insert into credit_note (invoice_id, total, reason, patient_amount)
       select id, 1, 'x', 1 from invoice limit 1`,
      ),
    }
    // security hardening (20261202090000): no direct table writes at all, a dose correction included
    const dose = await codeAs(d1, `update medication_request set dose = '2 caps' where id = $1`, [
      anyRx.id,
    ])
    const refused = Object.entries(tries).filter(([, c]) => c !== '42501')
    if (refused.length || dose !== '42501') throw new Error(JSON.stringify({ tries, dose }))
    return `${Object.keys(tries).length + 1} direct writes refused (a direct dose change too)`
  },
)
await step('0082: the manager marks the main pharmacy; others may not', async () => {
  const pharm = await codeAs(staff.pharmacist, `select set_main_pharmacy($1)`, [t82.ph2])
  const wrong = await codeAs(staff.manager, `select set_main_pharmacy($1)`, [t82.room])
  await as(staff.manager)
  await db.query(`select set_main_pharmacy($1)`, [t82.ph2])
  const now = (await one(`select main_pharmacy() as id`)).id
  await db.query(`select set_main_pharmacy($1)`, [t82.main])
  const back = (await one(`select main_pharmacy() as id`)).id
  await asAdmin()
  const mains = (
    await one(`select count(*)::int as n from stock_location where is_main and deleted_at is null`)
  ).n
  if (pharm !== '42501' || wrong !== '22023' || now !== t82.ph2 || back !== t82.main || mains !== 1)
    throw new Error(JSON.stringify({ pharm, wrong, now, back, mains }))
  return 'manager only; one main pharmacy store at a time'
})

// ---------------------------------------------------------------- 0083: stores and stock
const t83 = {}
const json83 = (x) => JSON.stringify(x)
const usable83 = async (item, loc) => (await one(`select usable_stock($1, $2) as n`, [item, loc])).n
await step('0083 C: the manager creates room stores and says who holds them', async () => {
  await as(staff.manager)
  t83.main = (await one(`select main_pharmacy() as id`)).id
  t83.cef = (
    await one(`select upsert_item(null, 'Ceftriaxone 83', 500, '1 g', 'vial', 'vial') as id`)
  ).id
  t83.old = (await one(`select upsert_item(null, 'Expired only 83', 100) as id`)).id
  // a doctor's office (type room, held by d2) and a ward held by a whole department
  const pharmRoom = await codeAs(
    staff.pharmacist,
    `select save_room_store(null, 'Not allowed 83', 'room', $1)`,
    [[d2]],
  )
  await as(staff.manager)
  t83.office = (
    await one(`select save_room_store(null, 'Dr Office 83', 'room', $1) as id`, [[d2]])
  ).id
  await asAdmin()
  t83.dept = (
    await one(
      `insert into department (name, roles) values ('Maternity 83', '{nurse}') returning id`,
    )
  ).id
  await db.query(
    `insert into staff_department (profile_id, department_id, position) values ($1, $2, 'member')`,
    [staff.nurse, t83.dept],
  )
  await as(staff.manager)
  t83.ward = (
    await one(`select save_room_store(null, 'Maternity ward 83', 'nursing', null, $1) as id`, [
      [t83.dept],
    ])
  ).id
  const assignByPharm = await codeAs(staff.pharmacist, `select assign_store_holder($1, $2)`, [
    t83.office,
    d3,
  ])
  const newMain = await codeAs(
    staff.manager,
    `select save_location(null, 'Second main 83', 'main_store')`,
  )
  const direct = await codeAs(
    staff.manager,
    `insert into stock_location (name, type) values ('Direct 83', 'pharmacy')`,
  )
  await as(d2)
  const mine2 = (await one(`select my_stores() as j`)).j
  await as(staff.nurse)
  const mineNurse = (await one(`select my_stores() as j`)).j
  await as(d3)
  const mine3 = (await one(`select my_stores() as j`)).j
  await asAdmin()
  const type = (await one(`select type::text as t from stock_location where id = $1`, [t83.office]))
    .t
  const told = (
    await one(
      `select count(*)::int as n from notification where kind = 'store_assigned' and recipient_user = $1`,
      [d2],
    )
  ).n
  if (
    pharmRoom !== '42501' ||
    assignByPharm !== '42501' ||
    newMain !== '22023' ||
    direct !== '42501' ||
    type !== 'room' ||
    mine2.length !== 1 ||
    mine2[0].id !== t83.office ||
    !mine2[0].personal ||
    !mineNurse.some((s) => s.id === t83.ward && s.departments.includes('Maternity 83')) ||
    mine3.length !== 0 ||
    told < 1
  )
    throw new Error(
      json83({ pharmRoom, assignByPharm, newMain, direct, type, mine2, mineNurse, mine3, told }),
    )
  return 'room store (type room) held by a doctor, a ward by its department; others refused; no new main store'
})
await step(
  '0083 B: a delivery note into the pharmacy, boxes or units, a new medicine from the RHIA list',
  async () => {
    await asAdmin()
    t83.ref = (
      await one(
        `select r.code, r.generic from medicine_reference r
          where not exists (select 1 from item i where i.code = r.code) order by r.code limit 1`,
      )
    ).code
    await as(staff.pharmacist)
    const lines = [
      {
        itemId: t83.cef,
        unit: 'box',
        quantity: 3,
        packSize: 10,
        cost: 2000,
        batchNo: 'CEF-83A',
        expiry: '2030-01-31',
      },
      {
        refCode: t83.ref,
        unit: 'unit',
        quantity: 40,
        cost: 50,
        sellingPrice: 120,
        batchNo: 'REF-83',
        expiry: '2029-12-31',
      },
    ]
    const d = (
      await one(`select receive_delivery('Supplier 83', 'DN-8301', $1::jsonb) as j`, [
        json83(lines),
      ])
    ).j
    const twice = await codeAs(
      staff.pharmacist,
      `select receive_delivery('supplier 83', 'dn-8301', $1::jsonb)`,
      [json83(lines)],
    )
    const noPack = await codeAs(
      staff.pharmacist,
      `select receive_delivery('Supplier 83', 'DN-8302', $1::jsonb)`,
      [
        json83([
          {
            itemId: t83.old,
            unit: 'box',
            quantity: 1,
            cost: 10,
            batchNo: 'X',
            expiry: '2030-01-01',
          },
        ]),
      ],
    )
    const byNurse = await codeAs(
      staff.nurse,
      `select receive_delivery('Supplier 83', 'DN-8303', $1::jsonb)`,
      [json83(lines)],
    )
    await as(staff.pharmacist)
    const detail = (await one(`select delivery_detail($1) as j`, [d.id])).j
    const list = (await one(`select deliveries() as j`)).j
    await asAdmin()
    const newItem = await one(
      `select i.id, i.code, (select pf.price from price_for(null, i.id, null) pf) as price from item i where i.code = $1`,
      [t83.ref],
    )
    const pack = (await one(`select pack_size from item where id = $1`, [t83.cef])).pack_size
    t83.refItem = newItem.id
    const inPharm = await usable83(t83.cef, t83.main)
    if (
      !/^GRN-\d{6}-\d{3}$/.test(d.number) ||
      d.units !== 70 ||
      Number(d.totalCost) !== 8000 ||
      twice !== '23505' ||
      noPack !== '22023' ||
      byNurse !== '42501' ||
      !newItem ||
      Number(newItem.price) !== 120 ||
      pack !== 10 ||
      inPharm !== 30 ||
      detail.lines.length !== 2 ||
      Number(detail.lines.find((x) => x.itemId === t83.cef).unitCost) !== 200 ||
      !list.some((x) => x.id === d.id && x.reference === 'DN-8301')
    )
      throw new Error(json83({ d, twice, noPack, byNurse, newItem, pack, inPharm, detail }))
    return `${d.number}: 3 boxes × 10 + 40 units, RWF 8,000; ${newItem.code} added at RWF 120; the same note twice refused`
  },
)
await step(
  '0083 BATCH-1: a batch keeps its expiry; each delivery keeps its cost; past dates and closed stores refused',
  async () => {
    await as(staff.pharmacist)
    const otherExpiry = await codeAs(
      staff.pharmacist,
      `select receive_stock($1, $2, 10, 250, 'CEF-83A', '2031-01-31', 'Supplier 83')`,
      [t83.cef, t83.main],
    )
    await as(staff.pharmacist)
    await db.query(
      `select receive_stock($1, $2, 10, 250, 'CEF-83A', '2030-01-31', 'Supplier 83')`,
      [t83.cef, t83.main],
    )
    const past = await codeAs(
      staff.pharmacist,
      `select receive_stock($1, $2, 1, 10, 'P-83', current_date - 1)`,
      [t83.cef, t83.main],
    )
    await as(staff.manager)
    t83.ph3 = (await one(`select save_location(null, 'Pharmacy 3 (83)', 'pharmacy') as id`)).id
    await db.query(`select set_location_active($1, false)`, [t83.ph3])
    const closed = await codeAs(
      staff.pharmacist,
      `select receive_stock($1, $2, 1, 10, 'C-83', '2030-01-01')`,
      [t83.cef, t83.ph3],
    )
    const intoRoom = await codeAs(
      staff.manager,
      `select receive_stock($1, $2, 1, 10, 'R-83', '2030-01-01')`,
      [t83.cef, t83.office],
    )
    const mainStore = (
      await one(
        `select id from stock_location where type = 'main_store' and deleted_at is null limit 1`,
      )
    ).id
    t83.mainStore = mainStore
    const intoMain = await codeAs(
      staff.manager,
      `select receive_stock($1, $2, 1, 10, 'M-83', '2030-01-01')`,
      [t83.cef, mainStore],
    )
    await asAdmin()
    const layers = (
      await db.query(
        `select b.unit_cost, sum(s.quantity)::int as q from batch b
           join stock_on_hand s on s.batch_id = b.id and s.location_id = $2
          where b.item_id = $1 and b.batch_no = 'CEF-83A' group by b.unit_cost order by b.unit_cost`,
        [t83.cef, t83.main],
      )
    ).rows.map((r) => [Number(r.unit_cost), r.q])
    // an old expired batch on the pharmacy shelf (never sent, sold or handed over)
    const oldBatch = (
      await one(
        `insert into batch (item_id, batch_no, expiry, unit_cost) values ($1, 'CEF-83OLD', current_date - 5, 200) returning id`,
        [t83.cef],
      )
    ).id
    await db.query(
      `insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, moved_at)
       values ($1, $2, $3, 5, 'receipt', 'old delivery', now() - interval '400 days')`,
      [t83.cef, oldBatch, t83.main],
    )
    const oldOnly = (
      await one(
        `insert into batch (item_id, batch_no, expiry, unit_cost) values ($1, 'OLD-83', current_date - 5, 50) returning id`,
        [t83.old],
      )
    ).id
    await db.query(
      `insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
       values ($1, $2, $3, 5, 'receipt', 'old delivery')`,
      [t83.old, oldOnly, t83.main],
    )
    if (
      otherExpiry !== '22023' ||
      past !== '22023' ||
      closed !== '22023' ||
      intoRoom !== '22023' ||
      intoMain !== '22023' ||
      json83(layers) !==
        json83([
          [200, 30],
          [250, 10],
        ])
    )
      throw new Error(json83({ otherExpiry, past, closed, intoRoom, intoMain, layers }))
    return 'other expiry refused; 30 at 200 kept beside 10 at 250; past expiry, closed store, room and main store refused'
  },
)
await step(
  '0083 D: a refill asked, a transfer note sent (FEFO, never expired), on the way, received with a loss',
  async () => {
    await as(staff.pharmacist)
    await db.query(`select set_reorder_level($1, 25, 60)`, [t83.cef])
    const notHolder = await codeAs(d3, `select request_refill($1, $2::jsonb)`, [
      t83.office,
      json83([{ itemId: t83.cef, quantity: 10 }]),
    ])
    await as(d2)
    const rq = (
      await one(`select request_refill($1, $2::jsonb, 'for the week') as j`, [
        t83.office,
        json83([{ itemId: t83.cef, quantity: 10 }]),
      ])
    ).j
    await as(staff.pharmacist)
    const open = (await one(`select refill_requests('open') as j`)).j
    const tooMuch = await codeAs(staff.pharmacist, `select send_to_room($1, $2::jsonb, $3)`, [
      t83.office,
      json83([{ itemId: t83.cef, quantity: 41 }]),
      rq.id,
    ])
    await as(staff.pharmacist)
    t83.note = (
      await one(`select send_to_room($1, $2::jsonb, $3) as j`, [
        t83.office,
        json83([{ itemId: t83.cef, quantity: 30 }]),
        rq.id,
      ])
    ).j
    const ov = (await one(`select stock_overview() as j`)).j
    const it = ov.items.find((x) => x.id === t83.cef)
    const detail = (await one(`select transfer_note($1) as j`, [t83.note.id])).j
    await asAdmin()
    const pharmAfter = await usable83(t83.cef, t83.main)
    const inStoreBefore = await usable83(t83.cef, t83.office)
    const reqAfter = await one(`select status, transfer_id from store_request where id = $1`, [
      rq.id,
    ])
    const lowTold = (
      await one(
        `select count(*)::int as n from notification where kind = 'stock_low' and params ->> 'itemId' = $1`,
        [t83.cef],
      )
    ).n
    const asked = (
      await one(
        `select count(*)::int as n from notification where kind = 'refill_requested' and params ->> 'number' = $1`,
        [rq.number],
      )
    ).n
    // the receiver confirms: the first line 2 short (broken: a loss), the rest as sent
    const byOther = await codeAs(d3, `select confirm_receipt($1)`, [t83.note.id])
    const first = detail.items[0]
    await as(d2)
    const got = (
      await one(`select confirm_receipt($1, $2::jsonb, 'checked') as j`, [
        t83.note.id,
        json83([
          {
            lineId: first.lineId,
            received: first.quantity - 2,
            reason: 'two vials broken',
            action: 'loss',
          },
        ]),
      ])
    ).j
    const again = await codeAs(d2, `select confirm_receipt($1)`, [t83.note.id])
    await asAdmin()
    const inStore = await usable83(t83.cef, t83.office)
    const diffTold = (
      await one(
        `select count(*)::int as n from notification where kind = 'transfer_difference' and params ->> 'number' = $1`,
        [t83.note.number],
      )
    ).n
    if (
      notHolder !== '42501' ||
      !open.some((r) => r.id === rq.id && r.lines[0].quantity === 10) ||
      tooMuch !== '23514' ||
      !/^T-\d{6}-\d{3}$/.test(t83.note.number) ||
      t83.note.units !== 30 ||
      detail.items.some((x) => x.batchNo === 'CEF-83OLD') ||
      it.inTransit !== 30 ||
      pharmAfter !== 10 ||
      inStoreBefore !== 0 ||
      reqAfter.status !== 'fulfilled' ||
      reqAfter.transfer_id !== t83.note.id ||
      lowTold !== 1 ||
      asked !== 1 ||
      byOther !== '42501' ||
      got.received !== 28 ||
      got.lost !== 2 ||
      again !== '23505' ||
      inStore !== 28 ||
      diffTold !== 2
    )
      throw new Error(
        json83({
          notHolder,
          tooMuch,
          note: t83.note,
          inTransit: it.inTransit,
          pharmAfter,
          inStoreBefore,
          reqAfter,
          lowTold,
          asked,
          byOther,
          got,
          again,
          inStore,
          diffTold,
          items: detail.items,
        }),
      )
    return `${rq.number} → ${t83.note.number}: 30 on the way (pharmacy 40 → 10, told once it is low); 28 received, 2 lost; manager and pharmacy told`
  },
)
await step(
  '0083 D: a note cancelled before receipt comes back; a return note is confirmed by the pharmacy',
  async () => {
    await as(staff.pharmacist)
    const n2 = (
      await one(`select send_to_room($1, $2::jsonb) as j`, [
        t83.office,
        json83([{ itemId: t83.cef, quantity: 5 }]),
      ])
    ).j
    await asAdmin()
    const during = await usable83(t83.cef, t83.main)
    const byHolder = await codeAs(d2, `select cancel_transfer($1, 'not mine')`, [n2.id])
    await as(staff.pharmacist)
    await db.query(`select cancel_transfer($1, 'wrong store')`, [n2.id])
    const receiveCancelled = await codeAs(d2, `select confirm_receipt($1)`, [n2.id])
    await asAdmin()
    const after = await usable83(t83.cef, t83.main)
    await as(d2)
    const rt = (
      await one(`select return_to_pharmacy($1, $2::jsonb, 'not needed') as j`, [
        t83.office,
        json83([{ itemId: t83.cef, quantity: 3 }]),
      ])
    ).j
    const notesD2 = (await one(`select transfer_notes() as j`)).j
    const holderConfirms = await codeAs(d2, `select confirm_receipt($1)`, [rt.id])
    await as(staff.pharmacist)
    await db.query(`select confirm_receipt($1)`, [rt.id])
    await as(d3)
    const notesD3 = (await one(`select transfer_notes() as j`)).j
    await asAdmin()
    const pharm = await usable83(t83.cef, t83.main)
    const store = await usable83(t83.cef, t83.office)
    if (
      during !== 5 ||
      byHolder !== '42501' ||
      receiveCancelled !== '23505' ||
      after !== 10 ||
      !/^RT-\d{6}-\d{3}$/.test(rt.number) ||
      holderConfirms !== '42501' ||
      !notesD2.some((n) => n.id === rt.id && n.canCancel && !n.canReceive) ||
      notesD2.some((n) => n.fromId !== t83.office && n.toId !== t83.office) ||
      notesD2.some((n) => n.value !== null) ||
      notesD3.length !== 0 ||
      pharm !== 13 ||
      store !== 25
    )
      throw new Error(
        json83({
          during,
          byHolder,
          receiveCancelled,
          after,
          rt,
          holderConfirms,
          notesD2: notesD2.length,
          notesD3: notesD3.length,
          pharm,
          store,
        }),
      )
    return `cancelled: the 5 came back; ${rt.number}: 3 back to the pharmacy once it confirmed`
  },
)
await step(
  '0083 E: given here only from a store the doctor holds; others prescribe for the pharmacy',
  async () => {
    const p = await visitAt('Room 83')
    t83.enc = p.enc
    await as(d2)
    await db.query(`select take_patient($1)`, [p.queue])
    const r = (
      await one(
        `select prescribe($1, $2, 2, null, null, null, null, null, 'room', 'consultation') as j`,
        [p.enc, t83.cef],
      )
    ).j
    const short = await codeAs(
      d2,
      `select prescribe($1, $2, 100, null, null, null, null, null, 'room', 'consultation')`,
      [p.enc, t83.cef],
    )
    const otherStore = await codeAs(
      d2,
      `select prescribe($1, $2, 1, null, null, null, null, null, 'room', 'consultation', $3)`,
      [p.enc, t83.cef, t82.room],
    )
    // d3 holds nothing: given here is refused (hint no_room_store), for the pharmacy is fine
    const p3 = await visitAt('Room 83 bis')
    await as(d3)
    await db.query(`select take_patient($1)`, [p3.queue])
    let noStore = null
    try {
      await db.query(
        `select prescribe($1, $2, 1, null, null, null, null, null, 'room', 'consultation')`,
        [p3.enc, t83.cef],
      )
    } catch (e) {
      noStore = `${e.code}/${e.hint}`
    }
    await as(d3)
    const forPharmacy = (
      await one(`select prescribe($1, $2, 1, null, null, null, null, null, 'pharmacy') as j`, [
        p3.enc,
        t83.cef,
      ])
    ).j
    await asAdmin()
    const charge = await one(
      `select count(*)::int as n, coalesce(sum(l.patient_share + l.insurer_share), 0) as total from invoice_line l
        where l.source_type = 'medication_request' and l.source_id = $1 and l.deleted_at is null`,
      [r.id],
    )
    const store = await usable83(t83.cef, t83.office)
    if (
      r.locationId !== t83.office ||
      !r.stockTaken ||
      !r.charged ||
      short !== 'MS003' ||
      otherStore !== '42501' ||
      noStore !== '42501/no_room_store' ||
      forPharmacy.supply !== 'pharmacy' ||
      charge.n !== 1 ||
      Number(charge.total) !== 1000 ||
      store !== 23
    )
      throw new Error(json83({ r, short, otherStore, noStore, forPharmacy, charge, store }))
    return 'from Dr Office 83 (2 × RWF 500 on the bill); short MS003; another store or no store refused'
  },
)
await step(
  '0083 RIGHTS-2: holders count and write off their store; the pharmacy its own; rooms by note only',
  async () => {
    const nursePharm = await codeAs(staff.nurse, `select use_stock($1, $2, 1, null, 'damaged')`, [
      t83.cef,
      t83.main,
    ])
    const noReason = await codeAs(d2, `select use_stock($1, $2, 1, null, '')`, [
      t83.cef,
      t83.office,
    ])
    await as(d2)
    await db.query(`select use_stock($1, $2, 1, null, 'vial broken')`, [t83.cef, t83.office])
    const diff = (
      await one(`select adjust_stock($1, $2, 21, 'monthly count') as d`, [t83.cef, t83.office])
    ).d
    const pharmCount = await codeAs(staff.pharmacist, `select adjust_stock($1, $2, 30, 'count')`, [
      t83.cef,
      t83.office,
    ])
    const direct = await codeAs(staff.pharmacist, `select transfer_stock($1, $2, $3, 1)`, [
      t83.cef,
      t83.main,
      t83.office,
    ])
    // an old main store: its stock goes to the pharmacy, then it closes
    await asAdmin()
    const layer = (
      await one(
        `select id from batch where item_id = $1 and batch_no = 'CEF-83A' and unit_cost = 200`,
        [t83.cef],
      )
    ).id
    await db.query(
      `insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, moved_at)
       values ($1, $2, $3, 4, 'receipt', 'old main store', now() - interval '300 days')`,
      [t83.cef, layer, t83.mainStore],
    )
    await as(staff.pharmacist)
    await db.query(`select transfer_stock($1, $2, $3, 4)`, [t83.cef, t83.mainStore, t83.main])
    await db.query(`select set_location_active($1, false)`, [t83.mainStore])
    const pharmCloseRoom = await codeAs(staff.pharmacist, `select set_location_active($1, false)`, [
      t83.office,
    ])
    const closeFull = await codeAs(staff.manager, `select set_location_active($1, false)`, [
      t83.office,
    ])
    await asAdmin()
    const store = await usable83(t83.cef, t83.office)
    const pharm = await usable83(t83.cef, t83.main)
    if (
      nursePharm !== '42501' ||
      noReason !== '22023' ||
      Number(diff) !== -1 ||
      pharmCount !== '42501' ||
      direct !== '22023' ||
      pharmCloseRoom !== '42501' ||
      closeFull !== '23514' ||
      store !== 21 ||
      pharm !== 17
    )
      throw new Error(
        json83({
          nursePharm,
          noReason,
          diff,
          pharmCount,
          direct,
          pharmCloseRoom,
          closeFull,
          store,
          pharm,
        }),
      )
    return 'write-off with a reason, count by the holder; pharmacy → room only by note; old main store emptied and closed'
  },
)
await step(
  '0083 F: holders see their stores only; the pharmacy and the manager see all (closed ones too)',
  async () => {
    await as(d2)
    const ov2 = (await one(`select stock_overview() as j`)).j
    const moves2 = (await one(`select stock_movements(current_date - 1, current_date + 1) as j`)).j
    const noStore = await codeAs(d3, `select stock_overview()`)
    await as(staff.pharmacist)
    const ovP = (await one(`select stock_overview() as j`)).j
    const storeP = (await one(`select store_stock($1) as j`, [t83.office])).j
    const otherStore = await codeAs(d2, `select store_stock($1)`, [t83.ward])
    await asAdmin()
    const it2 = ov2.items.find((x) => x.id === t83.cef)
    const office = ovP.locations.find((l) => l.id === t83.office)
    const closed = ovP.locations.find((l) => l.id === t83.ph3)
    if (
      ov2.locations.length !== 1 ||
      ov2.locations[0].id !== t83.office ||
      it2.byLocation[t83.office] !== 21 ||
      it2.onHand !== 21 ||
      it2.costValue !== null ||
      !moves2.length ||
      moves2.some((m) => m.fromId !== t83.office && m.toId !== t83.office) ||
      noStore !== '42501' ||
      !office?.holders.some((h) => h.profileId === d2) ||
      !office.isRoom ||
      closed?.active !== false ||
      !ovP.locations.some((l) => l.isMain && l.id === t83.main) ||
      ovP.locations.some((l) => l.type === 'transit') ||
      storeP.items.find((x) => x.itemId === t83.cef)?.usable !== 21 ||
      storeP.value === null ||
      otherStore !== '42501'
    )
      throw new Error(json83({ ov2: ov2.locations, it2, noStore, office, closed, otherStore }))
    return `Dr Office 83 only for its doctor (${moves2.length} movements); all ${ovP.locations.length} stores for the pharmacy, closed ones included`
  },
)
await step(
  '0083 CAT-1 / ALERT-1 / REORDER: no delete with stock; alerts on unexpired stock; what to order',
  async () => {
    const del = await codeAs(staff.manager, `select delete_item($1)`, [t83.cef])
    await as(d2)
    await db.query(`select set_store_min($1, $2, 30)`, [t83.office, t83.cef])
    await as(staff.pharmacist)
    const alerts = (await one(`select stock_alerts() as j`)).j
    const reorder = (await one(`select reorder_suggestions() as j`)).j
    await as(d2)
    const alerts2 = (await one(`select stock_alerts() as j`)).j
    const reorderD2 = (await one(`select reorder_suggestions() as j`)).j
    await asAdmin()
    const roomTold = (
      await one(
        `select count(*)::int as n from notification where kind = 'room_stock_low' and recipient_user = $1`,
        [d2],
      )
    ).n
    const lowTold = (
      await one(
        `select count(*)::int as n from notification where kind = 'stock_low' and params ->> 'itemId' = $1
           and not params ? 'key'`, // 0097: the daily alerts (with a key) apart
        [t83.cef],
      )
    ).n
    const r = reorder.find((x) => x.itemId === t83.cef)
    const expired = alerts.expired.filter((x) => x.itemId === t83.cef)
    const expiring = alerts.expiring.filter((x) => x.batchNo === 'CEF-83OLD')
    if (
      del !== '23514' ||
      !alerts.low.some((x) => x.itemId === t83.cef && x.onHand === 17) ||
      !alerts.roomLow.some((x) => x.storeId === t83.office && x.onHand === 21 && x.min === 30) ||
      !expired.some((x) => x.batchNo === 'CEF-83OLD' && x.quantity === 5) ||
      expiring.length ||
      alerts2.low.length ||
      alerts2.expired.some((x) => x.storeId !== t83.office) ||
      roomTold !== 1 ||
      lowTold !== 1 ||
      !r ||
      r.suggested !== 43 ||
      r.lastSupplier !== 'Supplier 83' ||
      Number(r.lastCost) !== 250 ||
      r.inRooms < 21 ||
      reorderD2.length
    )
      throw new Error(json83({ del, alerts, r, roomTold, lowTold, reorderD2 }))
    return `delete refused (stock left); low at 17 ≤ 25 told once; room below its 30; order ${r.suggested} up to 60 from ${r.lastSupplier} at ${r.lastCost}`
  },
)
await step(
  '0083 COUNTER SALE: a walk-in pays first at the cashier, then the pharmacy hands over',
  async () => {
    await as(staff.pharmacist)
    const s = (
      await one(`select create_counter_sale($1::jsonb, 'Walk-in 83', '0788000083') as j`, [
        json83([{ itemId: t83.cef, quantity: 2 }]),
      ])
    ).j
    const early = await codeAs(staff.pharmacist, `select hand_over_counter_sale($1)`, [s.id])
    const expiredOnly = await codeAs(staff.pharmacist, `select create_counter_sale($1::jsonb)`, [
      json83([{ itemId: t83.old, quantity: 1 }]),
    ])
    const noRef = await codeAs(staff.cashier, `select take_counter_payment($1, 'momo')`, [s.id])
    await as(staff.cashier)
    const paid = (await one(`select take_counter_payment($1, 'cash') as j`, [s.id])).j
    const day = (await one(`select cashier_summary() as j`)).j
    const twice = await codeAs(staff.cashier, `select take_counter_payment($1, 'cash')`, [s.id])
    await as(staff.pharmacist)
    const h = (await one(`select hand_over_counter_sale($1) as j`, [s.id])).j
    const sales = (await one(`select stock_sales(current_date, current_date) as j`)).j
    const summary = (await one(`select pharmacy_summary() as j`)).j
    const voidAfter = await codeAs(staff.cashier, `select void_payment($1, 'wrong buyer')`, [
      paid.paymentId,
    ])
    // another one cancelled while unpaid
    await as(staff.pharmacist)
    const s2 = (
      await one(`select create_counter_sale($1::jsonb) as j`, [
        json83([{ itemId: t83.cef, quantity: 1 }]),
      ])
    ).j
    await db.query(`select cancel_counter_sale($1, 'buyer left')`, [s2.id])
    const payCancelled = await codeAs(staff.cashier, `select take_counter_payment($1, 'cash')`, [
      s2.id,
    ])
    await as(staff.cashier)
    const list = (await one(`select counter_sales() as j`)).j
    await asAdmin()
    const pharm = await usable83(t83.cef, t83.main)
    const told = (
      await one(
        `select count(*)::int as n from notification where kind = 'counter_sale_to_pay' and params ->> 'number' = $1`,
        [s.number],
      )
    ).n
    const row = day.payments.find((x) => x.counterSale === s.number)
    if (
      !/^S-\d{6}-\d{3}$/.test(s.number) ||
      Number(s.total) !== 1000 ||
      early !== '22023' ||
      expiredOnly !== '23514' ||
      noRef !== '22023' ||
      !/^RCT-/.test(paid.receipt) ||
      twice !== '23505' ||
      !row ||
      row.patient !== 'Walk-in 83' ||
      day.counterSales.count < 1 ||
      Number(day.myExpected.cash) < 1000 ||
      h.status !== 'handed_over' ||
      h.lines[0].batches[0].batchNo === 'CEF-83OLD' ||
      pharm !== 15 ||
      Number(sales.counterRevenue) < 1000 ||
      summary.counterSales < 1 ||
      voidAfter !== '23514' ||
      payCancelled !== 'P0002' ||
      !list.some((x) => x.id === s2.id && x.status === 'cancelled') ||
      told !== 1
    )
      throw new Error(
        json83({
          s,
          early,
          expiredOnly,
          noRef,
          paid,
          twice,
          row,
          h,
          pharm,
          voidAfter,
          payCancelled,
        }),
      )
    return `${s.number}: paid first (${paid.receipt}, in the cash count), then handed over from unexpired stock; unpaid one cancelled`
  },
)
await step(
  '0083: the room store report; the store emptied back to the pharmacy, closed, reopened',
  async () => {
    await as(d2)
    const rep = (
      await one(`select room_store_summary($1, current_date - 1, current_date + 1) as j`, [
        t83.office,
      ])
    ).j
    const notHolder = await codeAs(d3, `select room_store_summary($1)`, [t83.office])
    await as(staff.pharmacist)
    const repP = (await one(`select room_store_summary($1) as j`, [t83.office])).j
    await as(staff.manager)
    const back = (await one(`select return_to_pharmacy($1) as j`, [t83.office])).j
    const whileOnTheWay = await codeAs(staff.manager, `select set_location_active($1, false)`, [
      t83.office,
    ])
    await as(staff.pharmacist)
    await db.query(`select confirm_receipt($1)`, [back.id])
    await as(staff.manager)
    await db.query(`select set_location_active($1, false)`, [t83.office])
    await as(d2)
    const mineClosed = (await one(`select my_stores() as j`)).j
    await as(staff.manager)
    await db.query(`select set_location_active($1, true)`, [t83.office])
    await as(d2)
    const mineOpen = (await one(`select my_stores() as j`)).j
    await asAdmin()
    const pharm = await usable83(t83.cef, t83.main)
    if (
      rep.given.units !== 2 ||
      rep.given.lines !== 1 ||
      Number(rep.given.charged) !== 1000 ||
      rep.received.units !== 28 ||
      rep.returned.units !== 3 ||
      rep.losses.writtenOff !== 1 ||
      rep.losses.countDown !== 1 ||
      rep.stock.value !== null ||
      repP.stock.value === null ||
      notHolder !== '42501' ||
      back.units !== 21 ||
      whileOnTheWay !== '23514' ||
      pharm !== 36 ||
      mineClosed.length !== 0 ||
      mineOpen.length !== 1
    )
      throw new Error(json83({ rep, notHolder, back, whileOnTheWay, pharm, mineClosed, mineOpen }))
    return `given 2 (RWF 1,000 billed), received 28, returned 3, 1 written off, count -1; ${back.number} took the 21 left back; closed and reopened`
  },
)
await step('0083: the lab keeps its own store and receives its reagents there', async () => {
  await as(staff.manager)
  const lab = (
    await one(
      `select id from stock_location where type = 'lab' and active and deleted_at is null limit 1`,
    )
  ).id
  await db.query(`select assign_store_holder($1, $2)`, [lab, staff.lab_tech])
  const reagent = (await one(`select upsert_item(null, 'Reagent 83', 0) as id`)).id
  await as(staff.lab_tech)
  await db.query(`select receive_stock($1, $2, 5, 10, 'LAB-83', '2030-01-01')`, [reagent, lab])
  const mine = (await one(`select my_stores() as j`)).j
  const intoPharm = await codeAs(
    staff.lab_tech,
    `select receive_stock($1, $2, 5, 10, 'LAB-83', '2030-01-01')`,
    [reagent, t83.main],
  )
  await asAdmin()
  const inLab = await usable83(reagent, lab)
  if (inLab !== 5 || intoPharm !== '42501' || !mine.some((s) => s.id === lab))
    throw new Error(json83({ inLab, intoPharm, mine }))
  return 'lab technician receives into the lab store; not into the pharmacy'
})

// ---------------------------------------------------------------- review fixes (0082 / 0083)
/** code/hint of a statement run as someone ('ok' when it succeeds). */
const hintAs = async (who, sql, params = []) => {
  await as(who)
  try {
    await db.query(sql, params)
    return 'ok'
  } catch (e) {
    return `${e.code}/${e.hint ?? ''}`
  } finally {
    await asAdmin()
  }
}
await step(
  'review: dispense_fefo, bills, payments and medicines are not written directly',
  async () => {
    await asAdmin()
    const line = await one(
      `select l.id from invoice_line l join invoice i on i.id = l.invoice_id
        where i.status = 'draft' and l.deleted_at is null and i.deleted_at is null limit 1`,
    )
    const pay = await one(
      `select id from payment where counter_sale_id is not null and deleted_at is null limit 1`,
    )
    const fefo = await codeAs(staff.pharmacist, `select dispense_fefo($1, $2, 1, $3)`, [
      t83.enc,
      t83.cef,
      t83.main,
    ])
    const lineFree = await codeAs(d2, `update invoice_line set patient_share = 0 where id = $1`, [
      line.id,
    ])
    const payGone = await codeAs(
      staff.cashier,
      `update payment set deleted_at = now() where id = $1`,
      [pay.id],
    )
    const payNew = await codeAs(
      staff.cashier,
      `insert into payment (counter_sale_id, method, amount) select counter_sale_id, 'cash', 1 from payment where id = $1`,
      [pay.id],
    )
    const itemGone = await codeAs(
      staff.pharmacist,
      `update item set deleted_at = now(), active = false where id = $1`,
      [t83.cef],
    )
    const packDirect = await codeAs(
      staff.pharmacist,
      `update item set pack_size = 7 where id = $1`,
      [t83.old],
    )
    await as(staff.pharmacist)
    await db.query(`select set_pack_size($1, 20)`, [t83.old])
    const badPack = await codeAs(staff.pharmacist, `select set_pack_size($1, 0)`, [t83.old])
    const nursePack = await codeAs(staff.nurse, `select set_pack_size($1, 5)`, [t83.old])
    await asAdmin()
    const pack = (await one(`select pack_size from item where id = $1`, [t83.old])).pack_size
    const still = await one(`select deleted_at, active from item where id = $1`, [t83.cef])
    if (
      fefo !== '42501' ||
      lineFree !== '42501' ||
      payGone !== '42501' ||
      payNew !== '42501' ||
      itemGone !== '42501' ||
      packDirect !== '42501' ||
      badPack !== '22023' ||
      nursePack !== '42501' ||
      pack !== 20 ||
      still.deleted_at !== null ||
      !still.active
    )
      throw new Error(
        json83({ fefo, lineFree, payGone, payNew, itemGone, packDirect, badPack, nursePack, pack }),
      )
    return 'dispense_fefo internal; bill line, payment and medicine writes refused; box size through set_pack_size'
  },
)
await step(
  'review: the tables show what the functions show (stores, costs, buyers, the pharmacy list)',
  async () => {
    const count = async (who, sql, params = []) => {
      await as(who)
      try {
        return (await one(sql, params)).n
      } finally {
        await asAdmin()
      }
    }
    const notWard = `select count(*)::int as n from stock_movement
      where not (from_location_id is not distinct from $1 or to_location_id is not distinct from $1)`
    const nurseOther = await count(staff.nurse, notWard, [t83.ward])
    const nurseBatch = await count(staff.nurse, `select count(*)::int as n from batch`)
    const nurseGrn = await count(staff.nurse, `select count(*)::int as n from goods_receipt_line`)
    const nurseSales = await count(staff.nurse, `select count(*)::int as n from counter_sale`)
    const nurseMain = await count(
      staff.nurse,
      `select count(*)::int as n from stock_on_hand where location_id = $1`,
      [t83.main],
    )
    const labNotes = await count(staff.lab_tech, `select count(*)::int as n from stock_transfer`)
    const d2Notes = await count(d2, `select count(*)::int as n from stock_transfer_line`)
    const cashierSales = await count(staff.cashier, `select count(*)::int as n from counter_sale`)
    const pharmBatch = await count(staff.pharmacist, `select count(*)::int as n from batch`)
    const pharmMain = await count(
      staff.pharmacist,
      `select count(*)::int as n from stock_on_hand where location_id = $1`,
      [t83.main],
    )
    await as(staff.nurse)
    const nurseQueue = (await one(`select pharmacy_queue() as j`)).j
    await as(staff.lab_tech)
    const labQueue = (await one(`select pharmacy_queue() as j`)).j
    await asAdmin()
    if (
      nurseOther !== 0 ||
      nurseBatch !== 0 ||
      nurseGrn !== 0 ||
      nurseSales !== 0 ||
      nurseMain !== 0 ||
      labNotes !== 0 ||
      d2Notes < 1 ||
      cashierSales < 1 ||
      pharmBatch < 1 ||
      pharmMain < 1 ||
      nurseQueue.lines.length ||
      labQueue.lines.length
    )
      throw new Error(
        json83({
          nurseOther,
          nurseBatch,
          nurseGrn,
          nurseSales,
          nurseMain,
          labNotes,
          d2Notes,
          cashierSales,
          pharmBatch,
          pharmMain,
          nurseQueue,
          labQueue,
        }),
      )
    return `a nurse sees only her ward (no batches, deliveries, buyers, pharmacy list); the doctor his notes; the pharmacy ${pharmBatch} batches`
  },
)
await step(
  'review: room stores are not counted up; losses are told; the sender does not confirm; a store needs a holder',
  async () => {
    // stock the office again with a note (the doctor confirms)
    await as(staff.pharmacist)
    const note = (
      await one(`select send_to_room($1, $2::jsonb) as j`, [
        t83.office,
        json83([{ itemId: t83.cef, quantity: 4 }]),
      ])
    ).j
    await as(d2)
    await db.query(`select confirm_receipt($1)`, [note.id])
    const up = await hintAs(d2, `select adjust_stock($1, $2, 9, 'found more')`, [
      t83.cef,
      t83.office,
    ])
    await asAdmin()
    const lossBefore = (
      await one(`select count(*)::int as n from notification where kind = 'room_stock_loss'`)
    ).n
    await as(d2)
    await db.query(`select use_stock($1, $2, 1, null, 'broken vial')`, [t83.cef, t83.office])
    await db.query(`select adjust_stock($1, $2, 2, 'counted at night')`, [t83.cef, t83.office])
    await asAdmin()
    const losses = (
      await db.query(
        `select recipient_role::text as role, recipient_stations::text[] as st, params from notification
          where kind = 'room_stock_loss' order by created_at`,
      )
    ).rows.slice(lossBefore)
    // the pharmacist also holds the office: still may not confirm the note they sent
    await as(staff.manager)
    await db.query(`select set_store_holders($1, $2, $3)`, [t83.office, [d2, staff.pharmacist], []])
    await as(staff.pharmacist)
    const note2 = (
      await one(`select send_to_room($1, $2::jsonb) as j`, [
        t83.office,
        json83([{ itemId: t83.cef, quantity: 1 }]),
      ])
    ).j
    const own = await hintAs(staff.pharmacist, `select confirm_receipt($1)`, [note2.id])
    await as(d2)
    await db.query(`select confirm_receipt($1)`, [note2.id])
    await as(staff.manager)
    await db.query(`select set_store_holders($1, $2, $3)`, [t83.office, [d2], []])
    // a room store nobody holds is not sent to
    await asAdmin()
    const orphan = (
      await one(
        `insert into stock_location (name, type) values ('No holder 83', 'theatre') returning id`,
      )
    ).id
    const noHolder = await hintAs(staff.pharmacist, `select send_to_room($1, $2::jsonb)`, [
      orphan,
      json83([{ itemId: t83.cef, quantity: 1 }]),
    ])
    const inOffice = await usable83(t83.cef, t83.office)
    if (
      up !== '22023/use_transfer_note' ||
      losses.length !== 4 ||
      !losses.some((x) => x.role === 'manager' && x.params.units === 1) ||
      !losses.some(
        (x) => (x.st ?? []).includes('pharmacy') && x.params.reason.startsWith('count'),
      ) ||
      own !== '42501/own_note' ||
      noHolder !== '22023/no_holder' ||
      inOffice !== 3
    )
      throw new Error(json83({ up, losses, own, noHolder, inOffice }))
    return 'count up refused (transfer note); write-off and count down told to manager + pharmacy; own note refused; no holder refused'
  },
)
await step('review: a medicine given here by mistake is put back (store and bill)', async () => {
  const p = await visitAt('Undo 83')
  await as(d2)
  await db.query(`select take_patient($1)`, [p.queue])
  const r = (
    await one(
      `select prescribe($1, $2, 2, null, null, null, null, null, 'room', 'consultation') as j`,
      [p.enc, t83.cef],
    )
  ).j
  await asAdmin()
  const inStoreGiven = await usable83(t83.cef, t83.office)
  const other = await codeAs(d3, `select undo_given_here($1, 'not mine')`, [r.id])
  const noReason = await codeAs(d2, `select undo_given_here($1, '')`, [r.id])
  await as(d2)
  const u = (await one(`select undo_given_here($1, 'wrong medicine') as j`, [r.id])).j
  const twice = await codeAs(d2, `select undo_given_here($1, 'again')`, [r.id])
  await asAdmin()
  const inStore = await usable83(t83.cef, t83.office)
  const line = (
    await one(
      `select count(*)::int as n from invoice_line where source_type = 'medication_request'
          and source_id = $1 and deleted_at is null`,
      [r.id],
    )
  ).n
  const m = await one(`select given_at, not_given_reason from medication_request where id = $1`, [
    r.id,
  ])
  if (
    inStoreGiven !== 1 ||
    other !== '42501' ||
    noReason !== '22023' ||
    u.units !== 2 ||
    u.mode !== 'bill' ||
    twice !== '23505' ||
    inStore !== 3 ||
    line !== 0 ||
    m.given_at !== null ||
    m.not_given_reason !== 'returned: wrong medicine'
  )
    throw new Error(json83({ inStoreGiven, other, noReason, u, twice, inStore, line, m }))
  return 'the giver puts it back the same day: 2 units back in the office, the bill line removed; others refused'
})
await step(
  'review: a paid counter sale holds its stock; a cancelled payment puts it back; card counted',
  async () => {
    await as(staff.pharmacist)
    const s = (
      await one(`select create_counter_sale($1::jsonb, 'Walk-in review') as j`, [
        json83([{ itemId: t83.cef, quantity: 1 }]),
      ])
    ).j
    await asAdmin()
    const before = await usable83(t83.cef, t83.main)
    await as(staff.cashier)
    const paid = (await one(`select take_counter_payment($1, 'cash') as j`, [s.id])).j
    await asAdmin()
    const held = await usable83(t83.cef, t83.main)
    await as(staff.cashier)
    await db.query(`select void_payment($1, 'wrong method')`, [paid.paymentId])
    await asAdmin()
    const back = await usable83(t83.cef, t83.main)
    await as(staff.cashier)
    const card = (await one(`select take_counter_payment($1, 'card', 'CARD-83') as j`, [s.id])).j
    await as(staff.pharmacist)
    const h = (await one(`select hand_over_counter_sale($1) as j`, [s.id])).j
    await asAdmin()
    const after = await usable83(t83.cef, t83.main)
    // the cashier counts the day exactly as expected, card included: no difference
    await as(staff.cashier)
    const exp = (await one(`select close_cash_day(null, '{}'::jsonb) as j`)).j.expected
    const counted = Object.fromEntries(
      Object.entries(exp).map(([k, v]) => [k, String(Math.max(0, Math.round(Number(v))))]),
    )
    const closed = (await one(`select close_cash_day(null, $1::jsonb) as j`, [json83(counted)])).j
    await asAdmin()
    if (
      held !== before - 1 ||
      back !== before ||
      after !== before - 1 ||
      !card.receipt ||
      h.lines[0].quantity !== 1 ||
      h.lines[0].batches.length !== 1 ||
      !('card' in exp) ||
      Number(closed.variance) !== 0
    )
      throw new Error(json83({ before, held, back, after, card, h, exp, closed }))
    return `taken at payment (${before} → ${held}), back when the payment was cancelled, handed over from what was held; card ${exp.card} counted, variance 0`
  },
)

// ---------------------------------------------------------------- 0084: sign-in trace reports + 0079 repair
// When a tab loses its signed-in person without the person choosing it, the browser sends its
// sign-in trace (report_client_event): visitors too, since the sign-in may be gone. Only the
// manager reads them; nobody writes the table directly. The 0081 gate lets the report through.
const report84 = (kind, detail) =>
  db.query(`select report_client_event($1, $2::jsonb)`, [kind, JSON.stringify(detail)])
const count84 = async (where = 'true', params = []) => {
  await asAdmin()
  return (await one(`select count(*)::int as n from client_event where ${where}`, params)).n
}
await step('0084: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261124120000_signin_trace_and_repair.sql'), 'utf8'),
  )
  return 'no error'
})
await step('0084: a visitor (the sign-in already gone) stores a report', async () => {
  const before = await count84()
  await as(null, 'anon', '')
  await report84('signed_out_unexpected', {
    username: 'j.uwimana',
    trace: ['2026-10-25T08:00:00.000Z [ab12cd34] auth.event {"event":"SIGNED_OUT"}'],
  })
  await asAdmin()
  const r = await one(`select * from client_event order by id desc limit 1`)
  if ((await count84()) !== before + 1 || r.user_id !== null || r.username !== 'j.uwimana')
    throw new Error(JSON.stringify(r))
  if (r.kind !== 'signed_out_unexpected' || r.detail.trace.length !== 1)
    throw new Error(JSON.stringify(r))
  return 'stored, no user id, the username the tab held'
})
await step('0084: a signed-in person stores a report with their id', async () => {
  await asApproved(staff.nurse)
  await report84('verify_failed_after_code', { username: 'someone-else', trace: [] })
  // an unapproved (PIN only) session may report too
  await as81(staff.receptionist, crypto.randomUUID(), 'password')
  await report84('initial_session_missing', { trace: [] })
  await asAdmin()
  const rows = (
    await db.query(`select user_id, username, kind from client_event order by id desc limit 2`)
  ).rows
  if (
    rows[1].user_id !== staff.nurse ||
    rows[1].kind !== 'verify_failed_after_code' ||
    rows[0].user_id !== staff.receptionist ||
    rows[0].username !== null
  )
    throw new Error(JSON.stringify(rows))
  return 'user id from the sign-in; username as said by the tab'
})
await expectError(
  '0084: a report over 8 KB is refused',
  async () => {
    await as(null, 'anon', '')
    await report84('signed_out_unexpected', { trace: ['x'.repeat(8300)] })
  },
  /too large/i,
)
await expectError(
  '0084: an unknown kind is refused',
  async () => {
    await as(null, 'anon', '')
    await report84('Robert; drop table', {})
  },
  /unknown kind/i,
)
await step('0084: the manager reads the reports; other staff and visitors do not', async () => {
  await asApproved(staff.manager)
  const manager = (await one(`select count(*)::int as n from client_event`)).n
  await asApproved(staff.nurse)
  const nurse = (await one(`select count(*)::int as n from client_event`)).n
  let anon = 'read'
  try {
    await as(null, 'anon', '')
    await db.query(`select count(*) from client_event`)
  } catch (e) {
    anon = /permission denied/i.test(String(e.message)) ? 'refused' : String(e.message)
  }
  await asAdmin()
  if (manager < 3 || nurse !== 0 || anon !== 'refused')
    throw new Error(JSON.stringify({ manager, nurse, anon }))
  return `manager ${manager} reports; nurse 0; visitors refused`
})
await step('0084: nobody writes the reports directly (insert, update, delete)', async () => {
  const tries = [
    [() => as(null, 'anon', ''), `insert into client_event (kind) values ('x')`],
    [() => asApproved(staff.nurse), `insert into client_event (kind) values ('x')`],
    [() => asApproved(staff.manager), `insert into client_event (kind) values ('x')`],
    [() => asApproved(staff.manager), `update client_event set kind = 'x'`],
    [() => asApproved(staff.manager), `delete from client_event`],
  ]
  const passed = []
  for (const [who, sql] of tries) {
    await who()
    try {
      await db.query(sql)
      passed.push(sql)
    } catch (e) {
      if (!/permission denied/i.test(String(e.message))) passed.push(`${sql}: ${e.message}`)
    }
  }
  await asAdmin()
  if (passed.length) throw new Error(JSON.stringify(passed))
  return `${tries.length} direct writes refused`
})
await step(
  '0084: the gate lets the report through for an unapproved or ended session; nothing else',
  async () => {
    const sidEnded = crypto.randomUUID()
    await as81(staff.nurse, sidEnded, 'otp')
    await db.query(`select record_sign_in('code')`)
    await db.query(`select end_session('test')`)
    const bad = []
    for (const [sid, method] of [
      [crypto.randomUUID(), 'password'],
      [sidEnded, 'otp'],
    ]) {
      await as81(staff.nurse, sid, method)
      for (const p of ['/rpc/report_client_event', '/rest/v1/rpc/report_client_event'])
        if ((await gate81(p)) !== 'pass') bad.push(`${method} ${p}`)
      for (const p of [
        '/rpc/report_client_event_x',
        '/rpc/report_client_events',
        '/client_event',
        '/rpc/find_patients',
        '/patient',
      ])
        if (!refused81(await gate81(p))) bad.push(`${method} ${p} passed`)
    }
    // the sign-in and sign-out calls still pass as before
    await as81(staff.nurse, crypto.randomUUID(), 'password')
    for (const p of ['/rpc/record_sign_in', '/rpc/end_session', '/rpc/session_status'])
      if ((await gate81(p)) !== 'pass') bad.push(p)
    await asAdmin()
    if (bad.length) throw new Error(JSON.stringify(bad))
    return 'report passes (not approved, ended); data and look-alike names refused'
  },
)
await step(
  '0084: extend_this_device and signed_in_with_code are there and work as in 0079',
  async () => {
    await asAdmin()
    const rights = await one(
      `select bool_or(has_function_privilege('anon', p, 'execute')) as anon_any,
            bool_and(has_function_privilege('authenticated', p, 'execute')) as staff_all
     from unnest(array['signed_in_with_code()', 'extend_this_device(text)']::regprocedure[]) p`,
    )
    const key = '8'.repeat(40)
    await as(staff.nurse)
    const code = (await one(`select signed_in_with_code() as c`)).c
    await one(`select trust_this_device($1) as u`, [key])
    await asAdmin()
    await db.query(
      `update trusted_device set expires_at = now() + interval '1 hour'
     where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [key],
    )
    await as(staff.nurse)
    const extended = (await one(`select extend_this_device($1) as e`, [key])).e
    const unknown = (await one(`select extend_this_device($1) as e`, ['9'.repeat(40)])).e
    await asPinOnly(staff.nurse)
    const pin = (await one(`select signed_in_with_code() as c`)).c
    await as(staff.receptionist)
    const foreign = (await one(`select extend_this_device($1) as e`, [key])).e
    await asAdmin()
    const hours = (await one(`select session_hours() as h`)).h
    const left = (new Date(extended).getTime() - Date.now()) / 3_600_000
    if (
      rights.anon_any ||
      !rights.staff_all ||
      !code ||
      pin ||
      unknown !== null ||
      foreign !== null ||
      Math.abs(left - hours) > 0.05
    )
      throw new Error(JSON.stringify({ rights, code, pin, unknown, foreign, left, hours }))
    return `code: true, PIN: false; own key extended to now + ${hours} h; unknown or foreign key: null`
  },
)
await step('0084: more than 300 reports in an hour are refused (abuse cap)', async () => {
  await asAdmin()
  const before = await count84()
  await db.query(
    `insert into client_event (kind, detail) select 'flood', '{}'::jsonb from generate_series(1, 300)`,
  )
  let refused = false
  try {
    await as(null, 'anon', '')
    await report84('signed_out_unexpected', { trace: [] })
  } catch (e) {
    refused = /too many/i.test(String(e.message))
  }
  await asAdmin()
  const after = await count84()
  await db.query(`delete from client_event where kind = 'flood'`)
  if (!refused || after !== before + 300)
    throw new Error(JSON.stringify({ refused, before, after }))
  return 'the 301st report in the hour is refused'
})
// ---------------------------------------------------------------- 0084: what the documents print
const t84 = {}
const json84 = (x) => JSON.stringify(x)
await step(
  '0084 A: the registration number is kept, listed for the manager and the person',
  async () => {
    // as manage-staff does it (service role)
    await asAdmin()
    await db.query(
      `update profiles set registration_no = 'RMDC/2017/0458', registration_body = 'RMDC', specialty = 'General practitioner' where id = $1`,
      [d2],
    )
    let tooLong = null
    try {
      await db.query(`update profiles set registration_no = $2 where id = $1`, [d2, 'X'.repeat(41)])
    } catch (e) {
      tooLong = e.code
    }
    await as(staff.manager)
    const row = await one(
      `select registration_no, registration_body from staff_directory where id = $1`,
      [d2],
    )
    await as(d2)
    const mine = (await one(`select my_placement() as j`)).j
    const session = (await one(`select my_session_profile() as j`)).j
    const direct = await codeAs(d2, `update profiles set registration_no = 'mine' where id = $1`, [
      d2,
    ])
    await asAdmin()
    if (
      tooLong !== '23514' ||
      row.registration_no !== 'RMDC/2017/0458' ||
      row.registration_body !== 'RMDC' ||
      mine.registrationNo !== 'RMDC/2017/0458' ||
      mine.registrationBody !== 'RMDC' ||
      session.registration_no !== 'RMDC/2017/0458' ||
      direct !== '42501'
    )
      throw new Error(json84({ tooLong, row, mine, session, direct }))
    return 'saved by the manager path; staff_directory, my_placement and my_session_profile give it; a direct write refused'
  },
)
await step(
  '0084 B: every visit has a reference V-YYYY-NNNNNN, old ones numbered in order',
  async () => {
    const before = await one(
      `select count(*)::int as n, count(distinct reference)::int as d,
            bool_and(reference ~ '^V-[0-9]{4}-[0-9]{6}$') as ok from encounter`,
    )
    await as(staff.receptionist)
    const r = (
      await one(
        `select register_patient_file('Ishimwe', 'Doc 84', 'female', '2018-05-04', null, '0788 123 456') as r`,
      )
    ).r
    t84.patient = r.patient_id
    t84.enc = (
      await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [t84.patient])
    ).id
    await asAdmin()
    t84.queue = (
      await one(
        `select id from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
        [t84.enc],
      )
    ).id
    const ref = (await one(`select reference from encounter where id = $1`, [t84.enc])).reference
    const last = (
      await one(`select last from number_series where key = 'visit' and year = $1`, [
        Number(ref.split('-')[1]),
      ])
    ).last
    t84.reference = ref
    if (
      before.n < 1 ||
      before.d !== before.n ||
      !before.ok ||
      !/^V-\d{4}-\d{6}$/.test(ref) ||
      Number(ref.split('-')[2]) !== last
    )
      throw new Error(json84({ before, ref, last }))
    return `${before.n} earlier visits numbered, the new one ${ref}`
  },
)
await step('0084 C: "no known allergies" is recorded apart from "not recorded"', async () => {
  // 0088: the safety fields are read through the functions only; the check reads them as admin
  const read84 = async () => {
    await db.exec(`reset role`)
    const r = await one(`select allergies, allergies_none from patient where id = $1`, [
      t84.patient,
    ])
    await db.exec(`set role authenticated`)
    return r
  }
  await as(d2)
  await db.query(`select update_patient($1, '{"allergies_none": true}'::jsonb)`, [t84.patient])
  const none = await read84()
  await db.query(`select update_patient($1, '{"allergies": "Sulfonamides (rash)"}'::jsonb)`, [
    t84.patient,
  ])
  const some = await read84()
  // "none" again clears the text; clearing both = not recorded
  await db.query(`select update_patient($1, '{"allergies_none": true}'::jsonb)`, [t84.patient])
  const again = await read84()
  const bad = await codeAs(d2, `select update_patient($1, '{"allergies_none": "yes"}'::jsonb)`, [
    t84.patient,
  ])
  const cashier = await codeAs(
    staff.cashier,
    `select update_patient($1, '{"allergies_none": false}'::jsonb)`,
    [t84.patient],
  )
  await asAdmin()
  if (
    none.allergies !== null ||
    none.allergies_none !== true ||
    some.allergies !== 'Sulfonamides (rash)' ||
    some.allergies_none !== false ||
    again.allergies !== null ||
    again.allergies_none !== true ||
    bad !== '22023' ||
    cashier !== '42501'
  )
    throw new Error(json84({ none, some, again, bad, cashier }))
  return 'none → text clears none → none clears the text; a wrong value and the cashier refused'
})
await step(
  '0084 D: prescription numbers RX-YYYY-NNNNNN: kept while no line is added, new after',
  async () => {
    await as(d2)
    await db.query(`select take_patient($1)`, [t84.queue])
    const a = (
      await one(
        `select prescribe($1, $2, 10, '1 vial', 'IM', 'OD', 5, null, 'pharmacy', 'consultation') as j`,
        [t84.enc, t83.cef],
      )
    ).j
    const b = (
      await one(
        `select prescribe($1, $2, 12, '2 tab', 'oral', 'TDS', 2, 'after meals', 'pharmacy', 'consultation') as j`,
        [t84.enc, t82.para],
      )
    ).j
    const n1 = (await one(`select prescription_number($1) as j`, [t84.enc])).j
    await as(staff.pharmacist)
    const n2 = (await one(`select prescription_number($1) as j`, [t84.enc])).j
    await as(d2)
    await db.query(`select cancel_prescription($1, 'not needed')`, [b.id])
    const n3 = (await one(`select prescription_number($1) as j`, [t84.enc])).j
    await db.query(
      `select prescribe($1, $2, 6, '1 tab', 'oral', 'BD', 3, null, 'pharmacy', 'consultation')`,
      [t84.enc, t82.para],
    )
    const n4 = (await one(`select prescription_number($1) as j`, [t84.enc])).j
    await asAdmin()
    const reception = await codeAs(staff.receptionist, `select prescription_number($1)`, [t84.enc])
    const cashier = await codeAs(staff.cashier, `select prescription_number($1)`, [t84.enc])
    const insert = await codeAs(
      d2,
      `insert into prescription_doc (number, encounter_id, line_ids) values ('RX-1', $1, '{}')`,
      [t84.enc],
    )
    // a visit with nothing prescribed
    await as(staff.receptionist)
    const otherPatient = (
      await one(`select register_patient_file('Empty', 'Rx 84', 'male', null, 40, null) as r`)
    ).r.patient_id
    const other = (
      await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [otherPatient])
    ).id
    await asAdmin()
    const empty = await hintAs(d2, `select prescription_number($1)`, [other])
    const rows = (
      await one(`select count(*)::int as n from prescription_doc where encounter_id = $1`, [
        t84.enc,
      ])
    ).n
    await as(d2)
    const seen = (await one(`select count(*)::int as n from prescription_doc`)).n
    await asAdmin()
    t84.rx = n4.number
    if (
      !/^RX-\d{4}-\d{6}$/.test(n1.number) ||
      !n1.isNew ||
      n1.lineIds.length !== 2 ||
      !n1.lineIds.includes(a.id) ||
      n1.prescriber?.registrationNo !== 'RMDC/2017/0458' ||
      n1.prescriber?.specialty !== 'General practitioner' ||
      n1.prescriber?.name !== 'Dr. Two' ||
      n2.number !== n1.number ||
      n2.isNew ||
      n3.number !== n1.number ||
      n3.isNew ||
      n4.number === n1.number ||
      !n4.isNew ||
      n4.lineIds.length !== 2 ||
      Number(n4.number.slice(-6)) !== Number(n1.number.slice(-6)) + 1 ||
      reception !== '42501' ||
      cashier !== '42501' ||
      insert !== '42501' ||
      empty !== '22023/no_lines' ||
      rows !== 2 ||
      seen < 2
    )
      throw new Error(json84({ n1, n2, n3, n4, reception, cashier, insert, empty, rows, seen }))
    return `${n1.number} printed twice (doctor, pharmacy) and after a cancellation; a new line → ${n4.number}`
  },
)
await step(
  '0084 E: visit_clinical, patient_file, the bill and the lab list carry what the documents print',
  async () => {
    await asAdmin()
    const payer = (
      await one(
        `insert into payer (code, name, type) values ('RSSB84', 'RSSB (RAMA) 84', 'rssb_rama') returning id`,
      )
    ).id
    await db.query(
      `insert into plan (payer_id, name, coverage_pct) values ($1, 'RAMA 84', 85) returning id`,
      [payer],
    )
    await as(staff.manager)
    const cons = (await one(`select upsert_service(null, 'Consultation 84', 'other', 5000) as id`))
      .id
    const lab = (await one(`select upsert_service(null, 'Malaria RDT 84', 'lab', 2000) as id`)).id
    await as(d2)
    await db.query(`select record_vitals($1, '{"weight":"21.5","temp":"37.4"}'::jsonb)`, [t84.enc])
    await db.query(`select add_charge($1, 'consultation', $2)`, [t84.enc, cons])
    const req = (await one(`select order_test($1, $2, 'fever', 2) as id`, [t84.enc, lab])).id
    await as(staff.manager)
    await db.query(`select set_visit_payer($1, $2, 'RAMA-84-000777')`, [t84.enc, payer])
    await as(staff.receptionist)
    const due = (
      await one(`select patient_share from visit_bill where encounter_id = $1`, [t84.enc])
    ).patient_share
    const paid = (await one(`select take_payment($1, 'cash', $2) as r`, [t84.enc, due])).r
    const bill = await one(
      `select member_no, coverage_pct, receipt_no, receipt_method, receipt_amount from visit_bill where encounter_id = $1`,
      [t84.enc],
    )
    await as(d2)
    const vc = (await one(`select visit_clinical($1) as j`, [t84.enc])).j
    const file = (await one(`select patient_file($1) as j`, [t84.patient])).j
    await as(staff.lab_tech)
    const list = (await one(`select lab_worklist('open') as j`)).j
    await asAdmin()
    const row = list.find((x) => x.id === req)
    const p = vc.patient
    const visit = file.visits.find((v) => v.id === t84.enc)
    if (
      p.birthDate !== '2018-05-04' ||
      p.sex !== 'female' ||
      !String(p.phone ?? '')
        .replace(/\s/g, '')
        .endsWith('788123456') ||
      p.insurer !== 'RSSB (RAMA) 84' ||
      p.memberNo !== 'RAMA-84-000777' ||
      Number(p.coveragePct) !== 85 ||
      Number(p.weightKg) !== 21.5 ||
      p.allergiesNone !== true ||
      p.allergies !== null ||
      vc.visit?.reference !== t84.reference ||
      !vc.prescriptions.every((x) => x.prescriber?.registrationNo === 'RMDC/2017/0458') ||
      file.document?.memberNo !== 'RAMA-84-000777' ||
      Number(file.document?.weightKg) !== 21.5 ||
      file.patient.allergies_none !== true ||
      visit?.reference !== t84.reference ||
      bill.member_no !== 'RAMA-84-000777' ||
      Number(bill.coverage_pct) !== 85 ||
      bill.receipt_no !== paid.receipt ||
      bill.receipt_method !== 'cash' ||
      Number(bill.receipt_amount) !== Number(due) ||
      !row ||
      row.visitReference !== t84.reference ||
      row.memberNo !== 'RAMA-84-000777' ||
      Number(row.weightKg) !== 21.5 ||
      row.allergiesNone !== true ||
      row.birthDate !== '2018-05-04'
    )
      throw new Error(json84({ p, visit: vc.visit, doc: file.document, bill, paid, row }))
    return `born ${p.birthDate}, ${p.insurer} ${p.memberNo} (${p.coveragePct} %), ${p.weightKg} kg, no known allergies; receipt ${bill.receipt_no}`
  },
)
await step(
  '0084 F: a cash visit prints no insurer; the weight of an earlier visit is used',
  async () => {
    await asAdmin()
    await db.query(`update encounter set status = 'closed', closed_at = now() where id = $1`, [
      t84.enc,
    ])
    await as(staff.receptionist)
    const enc = (
      await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [t84.patient])
    ).id
    await asAdmin()
    // the earlier visit's weight is recent: used; the cash visit has no insurer and no member number
    const d = (await one(`select doc_patient($1, $2) as j`, [t84.patient, enc])).j
    // older than 90 days: not printed
    await db.query(
      `update observation set effective_at = now() - interval '120 days' where encounter_id = $1 and code = 'weight'`,
      [t84.enc],
    )
    const old = (await one(`select doc_patient($1, $2) as j`, [t84.patient, enc])).j
    const internal = await codeAs(d2, `select doc_patient($1, $2)`, [t84.patient, enc])
    if (
      d.insurer !== null ||
      d.memberNo !== null ||
      Number(d.weightKg) !== 21.5 ||
      old.weightKg !== null ||
      internal !== '42501'
    )
      throw new Error(json84({ d, old, internal }))
    return 'cash: no insurer; earlier weight within 90 days used, older not; doc_patient internal'
  },
)

// ---------------------------------------------------------------- 0085: departments decide the desks
const t85 = {}
const json85 = (x) => JSON.stringify(x)
const deskAs = async (who, desk) => {
  await as(who)
  const r = (await one(`select may_use_desk($1) as ok`, [desk])).ok
  await asAdmin()
  return r
}
const myDesks85 = async (who) => {
  await as(who)
  const r = (await one(`select my_desks() as j`)).j
  await asAdmin()
  return r
}
const member85 = async (who, dep, position = 'member') => {
  await asAdmin()
  await db.query(
    `insert into staff_department (profile_id, department_id, position) values ($1, $2, $3)
     on conflict (profile_id, department_id) do update set position = excluded.position`,
    [who, dep, position],
  )
}
/** A department written directly (no placement of the people who work there as usual). */
const dept85 = async (name, services, roles = '{}') => {
  await asAdmin()
  return (
    await one(`insert into department (name, roles, services) values ($1, $2, $3) returning id`, [
      name,
      roles,
      services,
    ])
  ).id
}
const patient85 = async (given) => {
  await as(staff.receptionist)
  const id = (
    await one(`select register_patient_file('Desk', $1, 'female', null, 30, null) as r`, [given])
  ).r.patient_id
  await asAdmin()
  return id
}
const routing85 = async () => (await one(`select routing_snapshot()::text[] as r`)).r
await step(
  '0085 A: safety net — no department gives a desk: the role decides, as before',
  async () => {
    t85.docLab = await newStaff('doc.lab85', 'Dr. Lab 85', 'doctor', 'Consultation 2')
    t85.docCons = await newStaff('doc.cons85', 'Dr. Cons 85', 'doctor', 'Consultation 3')
    t85.docEcho = await newStaff('doc.echo85', 'Dr. Echo 85', 'doctor', 'Ultrasound')
    t85.nurse = await newStaff('nurse.ph85', 'Nurse Pharmacy 85', 'nurse')
    t85.pharm = await newStaff('pharm.lab85', 'Pharmacist Lab 85', 'pharmacist')
    await asAdmin()
    // nobody gives laboratory, ultrasound or pharmacy yet (Consultation 71 gives consultation)
    const offered = (
      await one(
        `select bool_or(desk_offered(d)) as any from unnest(array['laboratory','ultrasound','pharmacy']) d`,
      )
    ).any
    const r = {
      offered,
      // the worklists were run by the lab tech, the sonographer and the ultrasound doctor
      docLab: await deskAs(t85.docLab, 'laboratory'),
      docImaging: await deskAs(t85.docLab, 'ultrasound'),
      echo: await deskAs(t85.docEcho, 'ultrasound'),
      nurseLab: await deskAs(t85.nurse, 'laboratory'),
      labTech: await deskAs(staff.lab_tech, 'laboratory'),
      labTechImaging: await deskAs(staff.lab_tech, 'ultrasound'),
      pharm: await deskAs(staff.pharmacist, 'pharmacy'),
      nursePharm: await deskAs(t85.nurse, 'pharmacy'),
      cashierTriage: await deskAs(staff.cashier, 'triage'),
      cashierReception: await deskAs(staff.cashier, 'reception'),
      receptionTriage: await deskAs(staff.receptionist, 'triage'),
      docMine: await myDesks85(t85.docLab),
    }
    if (
      r.offered ||
      r.docLab ||
      r.docImaging ||
      !r.echo ||
      r.nurseLab ||
      !r.labTech ||
      r.labTechImaging ||
      !r.pharm ||
      r.nursePharm ||
      r.cashierTriage ||
      r.cashierReception ||
      !r.receptionTriage ||
      r.docMine.via?.triage !== 'role' ||
      r.docMine.desks.includes('laboratory') ||
      r.docMine.desks.includes('pharmacy') ||
      !r.docMine.ceiling.includes('pharmacy')
    )
      throw new Error(json85(r))
    return `doctor: no worklist by role (the ultrasound doctor: imaging); lab tech: lab not imaging; nurse: no lab, no pharmacy; desks ${r.docMine.desks.length}`
  },
)
await step(
  '0085 B: a doctor in Laboratory enters results; a doctor only in Consultation cannot; the lab tech is placed',
  async () => {
    // the laboratory given for the first time: the lab tech (his usual desk) is placed in it
    await as(staff.manager)
    t85.lab = (
      await one(
        `select upsert_department(null, 'Laboratory 85', null, '{}', array['laboratory']) as id`,
      )
    ).id
    await asAdmin()
    const labTechPlaced = (
      await one(
        `select count(*)::int as n from staff_department where profile_id = $1 and department_id = $2`,
        [staff.lab_tech, t85.lab],
      )
    ).n
    t85.cons = (await one(`select id from department where name = 'Consultation 71'`)).id
    await as(staff.manager)
    t85.test = (await one(`select upsert_service(null, 'Malaria RDT 85', 'lab', 2000) as id`)).id
    await member85(t85.docLab, t85.lab)
    await member85(t85.docCons, t85.cons)
    await as(staff.receptionist)
    const p = (
      await one(`select register_patient_file('Desk', 'Lab 85', 'female', null, 30, null) as r`)
    ).r.patient_id
    t85.enc = (await one(`select open_encounter($1, 'opd', 'consultation', null) as id`, [p])).id
    await asAdmin()
    const req = async (requester = null) =>
      (
        await one(
          `insert into service_request (encounter_id, category, service_id, priority, station, requester_id)
           values ($1, 'lab', $2, 3, 'laboratory', $3) returning id`,
          [t85.enc, t85.test, requester],
        )
      ).id
    t85.req1 = await req()
    t85.req2 = await req()
    t85.req3 = await req()
    // the doctor's own test: no longer by "orders.write" once a department gives the laboratory
    const own = await req(t85.docCons)
    const inLab = await hintAs(
      t85.docLab,
      `select record_result($1, 'Negative', 'No malaria', true)`,
      [t85.req1],
    )
    const consOnly = await hintAs(t85.docCons, `select record_result($1, 'x', 'y', true)`, [
      t85.req2,
    ])
    const ownTest = await hintAs(t85.docCons, `select record_result($1, 'x', 'y', true)`, [own])
    // no department gives the ultrasound: the clinician still types the result of his own test
    const img = async (requester) =>
      (
        await one(
          `insert into service_request (encounter_id, category, service_id, priority, station, requester_id)
           values ($1, 'imaging', $2, 3, 'ultrasound', $3) returning id`,
          [t85.enc, t85.test, requester],
        )
      ).id
    const ownImg = await hintAs(t85.docCons, `select record_result($1, 'x', 'y', false)`, [
      await img(t85.docCons),
    ])
    const otherImg = await hintAs(t85.docCons, `select record_result($1, 'x', 'y', false)`, [
      await img(t85.docLab),
    ])
    await as(t85.docCons)
    const vc85 = (await one(`select visit_clinical($1) as j`, [t85.enc])).j
    await asAdmin()
    const mineFlag =
      vc85?.orders?.find((o) => o.id === own)?.mine === true &&
      vc85.orders.find((o) => o.id === t85.req2)?.mine === false
    const sample = await hintAs(t85.docCons, `select set_request_status($1, 'collected')`, [
      t85.req2,
    ])
    const labTech = await hintAs(staff.lab_tech, `select record_result($1, 'x', 'y', false)`, [
      t85.req2,
    ])
    // a doctor or a sonographer may not write a result straight into the table (0085)
    const direct = await codeAs(
      t85.docCons,
      `insert into diagnostic_report (service_request_id, findings, verified_at) values ($1, 'x', now())`,
      [t85.req3],
    )
    const directStatus = await codeAs(
      t85.docCons,
      `update service_request set status = 'verified' where id = $1`,
      [t85.req3],
    )
    await as(t85.docLab)
    const catsLab = (await one(`select my_test_categories()::text[] as c`)).c
    await as(t85.docCons)
    const catsCons = (await one(`select my_test_categories()::text[] as c`)).c
    await asAdmin()
    const status = (await one(`select status from service_request where id = $1`, [t85.req1]))
      .status
    if (
      labTechPlaced !== 1 ||
      inLab !== 'ok' ||
      status !== 'verified' ||
      consOnly !== '42501/no_desk' ||
      ownTest !== '42501/no_desk' ||
      // 0102: the requester never enters a result, even while no department gives the desk
      ownImg !== '42501/no_desk' ||
      otherImg !== '42501/no_desk' ||
      !mineFlag ||
      sample !== '42501/no_desk' ||
      labTech !== 'ok' ||
      direct !== '42501' ||
      directStatus !== '42501' ||
      String(catsLab) !== String(['lab']) ||
      String(catsCons) !== String([])
    )
      throw new Error(
        json85({
          labTechPlaced,
          inLab,
          consOnly,
          ownTest,
          ownImg,
          otherImg,
          mineFlag,
          sample,
          labTech,
          direct,
          directStatus,
          status,
          catsLab,
          catsCons,
        }),
      )
    return `in Laboratory: verified; Consultation only: ${consOnly}; direct write: ${direct}; lab tech placed`
  },
)
await step(
  '0085 C: the role is the ceiling — a pharmacist placed in Laboratory still cannot enter results',
  async () => {
    await member85(t85.pharm, t85.lab)
    const lab = await deskAs(t85.pharm, 'laboratory')
    const result = await hintAs(t85.pharm, `select record_result($1, 'x', 'y', true)`, [t85.req2])
    // the manager narrows the doctor's ceiling: the department no longer gives him the lab
    await as(staff.manager)
    await db.query(`select set_role_desk('doctor', 'laboratory', false)`)
    const narrowed = await deskAs(t85.docLab, 'laboratory')
    await as(staff.manager)
    await db.query(`select set_role_desk('doctor', 'laboratory', true)`)
    const back = await deskAs(t85.docLab, 'laboratory')
    const managerRefused = await hintAs(
      staff.manager,
      `select set_role_desk('manager', 'pharmacy', false)`,
    )
    const unknown = await hintAs(staff.manager, `select set_role_desk('nurse', 'cashier', true)`)
    const notManager = await hintAs(staff.nurse, `select set_role_desk('nurse', 'pharmacy', true)`)
    await as(staff.manager)
    const matrix = (await one(`select role_desk_matrix() as j`)).j
    await as(staff.nurse)
    const hidden = (await one(`select role_desk_matrix() as j`)).j
    await asAdmin()
    const audited = (
      await one(
        `select count(*)::int as n from audit_event where entity = 'setting' and after ->> 'key' = 'desks'`,
      )
    ).n
    if (
      lab ||
      result !== '42501/no_desk' ||
      narrowed ||
      !back ||
      managerRefused !== '22023/' ||
      unknown !== '22023/' ||
      notManager !== '42501/' ||
      !matrix?.roles?.pharmacist?.includes('pharmacy') ||
      matrix.roles.pharmacist.includes('laboratory') ||
      matrix.roles.cashier?.includes('reception') ||
      matrix.desks.length !== 12 ||
      !matrix.offered.includes('laboratory') ||
      hidden !== null ||
      audited < 2
    )
      throw new Error(
        json85({
          lab,
          result,
          narrowed,
          back,
          managerRefused,
          unknown,
          notManager,
          matrix,
          hidden,
          audited,
        }),
      )
    return `pharmacist in Laboratory: ${result}; ceiling switched off and on (audited ${audited})`
  },
)
await step(
  '0085 D: a nurse in Pharmacy gets the pharmacy desk, never the money; the manager has every desk',
  async () => {
    await as(staff.manager)
    t85.pharmacy = (
      await one(
        `select upsert_department(null, 'Pharmacy 85', null, '{}', array['pharmacy']) as id`,
      )
    ).id
    await member85(t85.nurse, t85.pharmacy)
    const nurse = await deskAs(t85.nurse, 'pharmacy')
    await as(t85.nurse)
    const admin = (await one(`select stock_admin() as ok`)).ok
    const queue = (await one(`select pharmacy_queue(null) as j`)).j
    const pay = (await one(`select has_perm('payment.take') as ok`)).ok
    await asAdmin()
    const payment = await hintAs(t85.nurse, `select take_payment($1, 'cash', 100)`, [t85.enc])
    // a return on a posted bill is money: the nurse of the Pharmacy department may not
    const again = (
      await one(
        `insert into medication_dispense (medication_request_id, encounter_id, item_id, batch_id, quantity)
         select medication_request_id, encounter_id, item_id, batch_id, quantity from medication_dispense
         where medication_request_id = $1 order by created_at desc limit 1 returning id`,
        [t82.rx.id],
      )
    ).id
    const posted = (
      await one(`select status::text as s from invoice where encounter_id = $1`, [t82.enc])
    ).s
    const returned = await hintAs(t85.nurse, `select return_medicine($1, 'test 85 return')`, [
      t82.rx.id,
    ])
    await db.query(`update medication_dispense set deleted_at = now() where id = $1`, [again])
    // the pharmacist was not placed: putting him in would have changed which patients reach a
    // colleague (the pharmacist of Laboratory 85); the manager was told
    const pharmacist = await deskAs(staff.pharmacist, 'pharmacy')
    const otherNurse = await deskAs(staff.nurse, 'pharmacy')
    const mgr = await myDesks85(staff.manager)
    if (
      !nurse ||
      !admin ||
      !Array.isArray(queue?.stores) ||
      pay ||
      payment !== '42501/' ||
      posted === 'draft' ||
      returned !== '42501/' ||
      pharmacist ||
      otherNurse ||
      mgr.desks.length !== 12 ||
      mgr.via.pharmacy !== 'manager'
    )
      throw new Error(
        json85({
          nurse,
          admin,
          queue,
          pay,
          payment,
          posted,
          returned,
          pharmacist,
          otherNurse,
          mgr,
        }),
      )
    return 'nurse of Pharmacy 85: pharmacy desk and stores; payment and a posted-bill return refused; manager 12 desks'
  },
)
await step(
  '0085 E: day one — the people who used a desk keep it (placed, or kept as before); nothing else changes',
  async () => {
    await asAdmin()
    // a doctor who once wrote a lab result is not made a member of the Laboratory
    t85.docOnce = await newStaff('doc.once85', 'Dr. Once 85', 'doctor', 'Consultation 4')
    await db.query(`update diagnostic_report set created_by = $1 where service_request_id = $2`, [
      t85.docOnce,
      t85.req1,
    ])
    const serves = async () =>
      (await one(`select staff_serves($1, 'consultation') as ok`, [t85.docOnce])).ok
    const consBefore = await serves()
    const before = await routing85()
    const lines = (await one(`select place_staff_for_desks(true) as j`)).j
    const after = await routing85()
    const consAfter = await serves()
    const placed = (who, desk) =>
      lines.find((l) => l.profileId === who && l.desk === desk && l.action === 'placed')
    const pharmacist = placed(staff.pharmacist, 'pharmacy')
    const kept = lines.filter((l) => l.action === 'kept')
    const notice = await one(
      `select params, title, body, recipient_role from notification where kind = 'desks_placed'
       order by created_at desc limit 1`,
    )
    const history = (
      await one(
        `select count(*)::int as n from audit_event where after ->> 'key' = 'desk_placement' and entity_id = $1`,
        [staff.pharmacist],
      )
    ).n
    const keptRows = (await one(`select count(*)::int as n from staff_desk_keep`)).n
    const r = {
      pharmacist: await deskAs(staff.pharmacist, 'pharmacy'),
      viaLab: (await myDesks85(staff.lab_tech)).via?.laboratory,
      keptVia: kept[0] ? (await myDesks85(kept[0].profileId)).via?.[kept[0].desk] : 'kept',
      onceLab: lines.find((l) => l.profileId === t85.docOnce && l.desk === 'laboratory'),
      onceMember: (
        await one(
          `select count(*)::int as n from staff_department where profile_id = $1 and department_id = $2`,
          [t85.docOnce, t85.lab],
        )
      ).n,
      docCons: lines.find((l) => l.profileId === t85.docCons && l.desk === 'laboratory'),
      cashier: lines.find((l) => l.profileId === staff.cashier),
      again: (await one(`select place_staff_for_desks(true) as j`)).j,
    }
    if (
      !pharmacist ||
      pharmacist.department !== 'Pharmacy 85' ||
      !r.pharmacist ||
      r.viaLab !== 'department' ||
      r.keptVia !== 'kept' ||
      keptRows !== kept.length ||
      r.onceLab ||
      r.onceMember !== 0 ||
      consBefore !== consAfter ||
      json85(before) !== json85(after) ||
      r.docCons ||
      r.cashier ||
      r.again.length !== 0 ||
      lines.some((l) => l.action === 'lost') ||
      notice?.recipient_role !== 'manager' ||
      Number(notice.params.count) !== lines.length ||
      !/Pharmacy 85/.test(notice.body) ||
      history !== 1
    )
      throw new Error(json85({ lines, r, notice, history, keptRows, consBefore, consAfter }))
    return `${lines.length} lines: ${lines.length - kept.length} placed, ${kept.length} kept as before; the patients reaching each person unchanged; run again: none`
  },
)
await step(
  '0085 F: reception is a desk; emergencies stay with the people who treat; nurse tasks follow the nursing desk',
  async () => {
    await as(staff.manager)
    const unknown = await hintAs(
      staff.manager,
      `select upsert_department(null, 'Bad 85', null, '{}', array['cashier'])`,
    )
    t85.front = await dept85('Front desk 85', ['reception'], '{receptionist}')
    const p = await patient85('Front 85')
    const pEm = await patient85('Emergency 85')
    const pDoc = await patient85('Walk-in 85')
    const pMine = await patient85('Myself 85')
    const before = await hintAs(staff.receptionist, `select start_visit($1)`, [p])
    await member85(staff.receptionist, t85.front)
    const after = await hintAs(staff.receptionist, `select start_visit($1)`, [p])
    // the manager's "not allowed" on "start a visit" takes the desk away, department or not
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'visit.start', false)`, [staff.receptionist])
    const switchedOff = await deskAs(staff.receptionist, 'reception')
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'visit.start', null)`, [staff.receptionist])
    // a doctor outside Front desk 85: an emergency, yes; an ordinary visit, no; open_encounter
    // straight, no
    const emergency = await hintAs(t85.docCons, `select start_visit($1, true, 'consultation')`, [
      pEm,
    ])
    const ordinary = await hintAs(t85.docCons, `select start_visit($1)`, [pDoc])
    const direct = await hintAs(
      t85.docCons,
      `select open_encounter($1, 'opd', 'consultation', null)`,
      [pDoc],
    )
    const directRow = await codeAs(
      staff.cashier,
      `insert into encounter (patient_id, type) values ($1, 'opd')`,
      [pDoc],
    )
    // a nurse outside it takes a patient herself at triage
    const myself = await hintAs(
      staff.nurse,
      `select begin_visit($1, 'triage', null, null, true, false)`,
      [pMine],
    )
    // nurse tasks: by role until a department gives nursing care, then its people
    const tasks = async (who) => {
      await as(who)
      const r = (await one(`select task_for_me('nurse') as ok`)).ok
      await asAdmin()
      return r
    }
    const nurseBefore = await tasks(staff.nurse)
    const docBefore = await tasks(t85.docLab)
    t85.nursing = await dept85('Nursing 85', ['nursing'])
    await member85(t85.docLab, t85.nursing)
    const nurseAfter = await tasks(staff.nurse)
    const docAfter = await tasks(t85.docLab)
    const bed = await hintAs(staff.nurse, `select bed_ready(gen_random_uuid())`)
    // a nurse task on a visit: the doctor of Nursing 85 is told and may work on the patient; the
    // nurses outside it are not told
    const task = (
      await one(
        `insert into internal_task (encounter_id, patient_id, assigned_role, title)
         select e.id, e.patient_id, 'nurse', 'Injection 85' from encounter e where e.id = $1 returning id`,
        [t85.enc],
      )
    ).id
    const told = await one(
      `select count(*) filter (where recipient_user = $1)::int as doc,
                count(*) filter (where recipient_role = 'nurse')::int as nurses
         from notification where kind = 'task' and params ->> 'title' = 'Injection 85'`,
      [t85.docLab],
    )
    await as(t85.docLab)
    const docWorks = (await one(`select may_work_on($1) as ok`, [t85.enc])).ok
    await asAdmin()
    // marking it done straight in the table is refused; complete_task does it
    const directDone = await codeAs(
      staff.cashier,
      `update internal_task set done_at = now() where id = $1`,
      [task],
    )
    const done = await hintAs(t85.docLab, `select complete_task($1)`, [task])
    await as(staff.manager)
    const dir = await one(`select desks from staff_directory where id = $1`, [t85.docLab])
    await as(t85.docLab)
    const session = (await one(`select my_session_profile() as j`)).j
    await asAdmin()
    // put things back for anything after: reception and nursing given by no department
    await db.query(`update department set active = false where id in ($1, $2)`, [
      t85.front,
      t85.nursing,
    ])
    const r = {
      unknown,
      before,
      after,
      switchedOff,
      emergency,
      ordinary,
      direct,
      directRow,
      myself,
      nurseBefore,
      docBefore,
      nurseAfter,
      docAfter,
      bed,
      told,
      docWorks,
      directDone,
      done,
      dir,
      session,
    }
    if (
      unknown !== '22023/' ||
      before !== '42501/no_desk' ||
      after !== 'ok' ||
      switchedOff ||
      emergency !== 'ok' ||
      ordinary !== '42501/no_desk' ||
      direct !== '42501/no_desk' ||
      directRow !== '42501' ||
      myself !== 'ok' ||
      !nurseBefore ||
      docBefore ||
      nurseAfter ||
      !docAfter ||
      bed !== '42501/no_desk' ||
      told.doc !== 1 ||
      told.nurses !== 0 ||
      !docWorks ||
      directDone !== '42501' ||
      done !== 'ok' ||
      !dir?.desks?.includes('nursing') ||
      !dir.desks.includes('laboratory') ||
      !session?.desks?.includes('laboratory')
    )
      throw new Error(json85(r))
    return `reception: ${before} → ok as a member; emergency by a doctor outside: ok, ordinary: ${ordinary}; nurse tasks to Nursing 85 (told by name)`
  },
)
await step('0085 G: one head and one assistant per department; members many', async () => {
  await as(staff.manager)
  const dep = (await one(`select upsert_department(null, 'Ward 85', null, '{}', null) as id`)).id
  await asAdmin()
  const ids = []
  for (const n of ['a', 'b', 'c', 'd', 'e'])
    ids.push(await newStaff(`ward85.${n}`, `Ward 85 ${n.toUpperCase()}`, 'nurse'))
  const [a, b, c, d, e] = ids
  const positions = async () => {
    const rows = (
      await db.query(`select profile_id, position from staff_department where department_id = $1`, [
        dep,
      ])
    ).rows
    return Object.fromEntries(rows.map((r) => [ids.indexOf(r.profile_id), r.position]))
  }
  await member85(a, dep, 'head')
  await member85(b, dep, 'assistant')
  await member85(e, dep, 'member')
  // a new assistant: the previous assistant becomes a member
  await member85(c, dep, 'assistant')
  const s1 = await positions()
  // the assistant made head: the previous head becomes the assistant
  await db.query(
    `update staff_department set position = 'head' where profile_id = $1 and department_id = $2`,
    [c, dep],
  )
  const s2 = await positions()
  // a new head: the previous head is the assistant, the previous assistant a member
  await member85(d, dep, 'head')
  const s3 = await positions()
  const lead = async (id) =>
    (await one(`select dashboard from profiles where id = $1`, [id])).dashboard
  const dash = { a: await lead(a), c: await lead(c), d: await lead(d) }
  let twice = 'ok'
  try {
    await db.exec('begin')
    await db.query(`alter table staff_department disable trigger staff_department_one_head`)
    await db.query(
      `update staff_department set position = 'assistant' where department_id = $1 and profile_id = $2`,
      [dep, b],
    )
    await db.exec('commit')
  } catch (err) {
    twice = err.code ?? String(err.message)
    await db.exec('rollback')
  }
  const want1 = { 0: 'head', 1: 'member', 2: 'assistant', 4: 'member' }
  const want2 = { 0: 'assistant', 1: 'member', 2: 'head', 4: 'member' }
  const want3 = { 0: 'member', 1: 'member', 2: 'assistant', 3: 'head', 4: 'member' }
  if (
    json85(s1) !== json85(want1) ||
    json85(s2) !== json85(want2) ||
    json85(s3) !== json85(want3) ||
    dash.a !== null ||
    dash.c !== 'head' ||
    dash.d !== 'head' ||
    twice !== '23P01'
  )
    throw new Error(json85({ s1, s2, s3, dash, twice }))
  return 'assistant replaced; assistant promoted (old head → assistant); new head cascades; two assistants refused'
})
await step(
  '0085 H: triage by department; cover gives no desk (0088); exceptions only take away',
  async () => {
    const triage = await dept85('Triage 85', ['triage'])
    await asAdmin()
    const nurse2 = await newStaff('triage85.n', 'Triage Nurse 85', 'nurse')
    await member85(nurse2, triage)
    await as(staff.receptionist)
    const takers = (await one(`select vitals_takers() as j`)).j.map((x) => x.id)
    await asAdmin()
    const r = {
      member: await deskAs(nurse2, 'triage'),
      other: await deskAs(staff.nurse, 'triage'),
      listed: takers.includes(nurse2),
      otherListed: takers.includes(staff.nurse),
    }
    // a new receptionist (no vitals yet) keeps triage: it is the receptionist's usual desk
    const recep2 = await newStaff('recep85.n', 'Receptionist 85', 'receptionist')
    r.recepBefore = await deskAs(recep2, 'triage')
    r.placed = (await one(`select place_staff_for_desks(true, array['triage']) as j`)).j
    r.recepAfter = await deskAs(recep2, 'triage')
    r.recepVia = (await myDesks85(recep2)).via?.triage
    // 0088: cover is retired: no cover row can be written, and one from before (history) gives
    // no desk: neither the doctor's consultation nor his department's pharmacy
    await member85(t85.docCons, t85.pharmacy)
    try {
      await db.query(
        `insert into clinician_cover (doctor_id, nurse_id, ends_at) values ($1, $2, now() + interval '1 hour')`,
        [t85.docCons, nurse2],
      )
      r.coverInsert = 'ok'
    } catch (e) {
      r.coverInsert = `${e.code}/${e.hint ?? ''}`
    }
    await db.exec(`alter table clinician_cover disable trigger trg_cover_retired`)
    await db.query(
      `insert into clinician_cover (doctor_id, nurse_id, ends_at) values ($1, $2, now() + interval '1 hour')`,
      [t85.docCons, nurse2],
    )
    await db.exec(`alter table clinician_cover enable trigger trg_cover_retired`)
    r.cover = await deskAs(nurse2, 'consultation')
    r.coverVia = (await myDesks85(nurse2)).via?.consultation ?? null
    r.coverPharmacy = await deskAs(nurse2, 'pharmacy')
    r.dispense = await hintAs(nurse2, `select dispense_prescription(gen_random_uuid())`)
    await db.query(`update clinician_cover set ended_at = now() where nurse_id = $1`, [nurse2])
    await db.query(`delete from staff_department where profile_id = $1 and department_id = $2`, [
      t85.docCons,
      t85.pharmacy,
    ])
    // the manager's exception: "orders.write not allowed" for the doctor of Laboratory 85 takes
    // the desk away; "allowed" for the receptionist adds no worklist
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'orders.write', false)`, [t85.docLab])
    r.denied = await deskAs(t85.docLab, 'laboratory')
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'orders.write', null)`, [t85.docLab])
    r.restored = await deskAs(t85.docLab, 'laboratory')
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'orders.write', true)`, [staff.receptionist])
    r.allowedAdds = await deskAs(staff.receptionist, 'laboratory')
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'orders.write', null)`, [staff.receptionist])
    await asAdmin()
    await db.query(`update department set active = false where id = $1`, [triage])
    if (
      !r.member ||
      r.other ||
      !r.listed ||
      r.otherListed ||
      r.recepBefore ||
      !r.recepAfter ||
      r.recepVia !== 'department' ||
      r.coverInsert !== '42501/cover_retired' ||
      r.cover ||
      r.coverVia !== null ||
      r.coverPharmacy ||
      r.dispense !== '42501/no_desk' ||
      r.denied ||
      !r.restored ||
      r.allowedAdds
    )
      throw new Error(json85(r))
    return 'triage: members (the receptionist placed); cover refused and gives no desk; exceptions only take away'
  },
)

// ---------------------------------------------------------------- 0086: analytics
// A small clinic week seeded straight into the tables (1st–7th of a past month, Kigali time), so
// every figure below is known exactly. P is that week; the week before holds one payment.
const t86 = {}
const json86 = (x) => JSON.stringify(x)
const P86 = ['2025-03-03', '2025-03-09']
const at86 = (s) => `${s}+02`
const visit86 = async (given, arrived, type = 'opd') => {
  await asAdmin()
  const pid = (
    await one(
      `insert into patient (surname, given_names, sex, created_at) values ('Analytics', $1, 'female', $2) returning id`,
      [given, at86(arrived)],
    )
  ).id
  const enc = (
    await one(
      `insert into encounter (patient_id, type, arrived_at, created_at) values ($1, $2, $3, $3) returning id`,
      [pid, type, at86(arrived)],
    )
  ).id
  const inv = (await one(`select id from invoice where encounter_id = $1`, [enc])).id
  return { pid, enc, inv }
}
const queue86 = async (enc, station, created, started = null, finished = null, more = {}) =>
  (
    await one(
      `insert into queue_entry (encounter_id, station, ticket_no, created_at, started_at, finished_at, taken_by, pool_id)
       values ($1, $2, 'T86', $3, $4, $5, $6, $7) returning id`,
      [
        enc,
        station,
        at86(created),
        started && at86(started),
        finished && at86(finished),
        more.takenBy ?? null,
        more.pool ?? null,
      ],
    )
  ).id
const close86 = async (enc, at) =>
  db.query(`update encounter set status = 'closed', closed_at = $2 where id = $1`, [enc, at86(at)])
const pay86 = async (inv, method, amount, paid, more = {}) =>
  (
    await one(
      `insert into payment (invoice_id, method, amount, cashier_id, paid_at, deleted_at, voided_at, voided_by, void_reason)
       values ($1, $2, $3, $4, $5, $6, $6, $7, $8) returning id`,
      [
        inv,
        method,
        amount,
        staff.cashier,
        at86(paid),
        more.voidedAt ? at86(more.voidedAt) : null,
        more.voidedAt ? staff.cashier : null,
        more.voidedAt ? 'wrong amount' : null,
      ],
    )
  ).id
/** A function run as someone: its jsonb, or the error code. */
const call86 = async (who, sql, params = []) => {
  await as(who)
  try {
    return (await one(sql, params)).j
  } catch (e) {
    return e.code ?? String(e.message).split('\n')[0]
  } finally {
    await asAdmin()
  }
}
await step('0086: seed a week (waits, money, work) for the analytics checks', async () => {
  await asAdmin()
  t86.head = await newStaff('an86.head', 'Head Analytics 86', 'doctor')
  t86.member = await newStaff('an86.member', 'Member Analytics 86', 'doctor')
  t86.outsider = await newStaff('an86.out', 'Outsider Analytics 86', 'doctor')
  t86.nobody = await newStaff('an86.nobody', 'Nobody Analytics 86', 'doctor')
  t86.retired = await newStaff('an86.retired', 'Retired Analytics 86', 'nurse')
  t86.dept = await dept85('Analytics 86', ['consultation'])
  await member85(t86.head, t86.dept, 'head')
  await member85(t86.member, t86.dept)
  // E1: triage (vitals measured 8 min after joining), then consultation taken by the member (10 min)
  const e1 = await visit86('One', '2025-03-03 08:45')
  await queue86(e1.enc, 'triage', '2025-03-03 08:50', null, '2025-03-03 09:00')
  await db.query(
    `insert into observation (encounter_id, code, value_num, performer_id, effective_at) values ($1, 'temp', 37, $2, $3)`,
    [e1.enc, staff.nurse, at86('2025-03-03 08:58')],
  )
  await queue86(
    e1.enc,
    'consultation',
    '2025-03-03 09:00',
    '2025-03-03 09:10',
    '2025-03-03 09:30',
    {
      takenBy: t86.member,
    },
  )
  // E2: consultation taken by the head (30 min); the cashier 5 min (paid by MoMo)
  const e2 = await visit86('Two', '2025-03-03 08:55')
  await queue86(
    e2.enc,
    'consultation',
    '2025-03-03 09:00',
    '2025-03-03 09:30',
    '2025-03-03 09:50',
    {
      takenBy: t86.head,
    },
  )
  await queue86(e2.enc, 'cashier', '2025-03-03 09:40', null, '2025-03-03 09:45')
  // E3 20 min, E4 40 min, E5 50 min
  const e3 = await visit86('Three', '2025-03-03 09:55')
  await queue86(e3.enc, 'consultation', '2025-03-03 10:00', '2025-03-03 10:20', '2025-03-03 10:40')
  const e4 = await visit86('Four', '2025-03-03 09:55')
  await queue86(e4.enc, 'consultation', '2025-03-03 10:00', '2025-03-03 10:40', '2025-03-03 11:00')
  const e5 = await visit86('Five', '2025-03-04 10:55')
  await queue86(e5.enc, 'consultation', '2025-03-04 11:00', '2025-03-04 11:50', '2025-03-04 12:00')
  // E6: closed with the visit, nobody took the patient: no wait
  const e6 = await visit86('Six', '2025-03-04 08:00')
  await queue86(e6.enc, 'consultation', '2025-03-04 08:05', null, '2025-03-04 12:00')
  // E7: sent to dental and consultation at once; consultation took the patient after 60 min
  const pool = crypto.randomUUID()
  const e7 = await visit86('Seven', '2025-03-04 08:55')
  await queue86(e7.enc, 'dental', '2025-03-04 09:00', null, '2025-03-04 10:00', { pool })
  await queue86(
    e7.enc,
    'consultation',
    '2025-03-04 09:00',
    '2025-03-04 10:00',
    '2025-03-04 10:30',
    {
      pool,
    },
  )
  // E8: 13 hours (a data error); E9: across midnight (a data error)
  const e8 = await visit86('Eight', '2025-03-05 05:55')
  await queue86(e8.enc, 'consultation', '2025-03-05 06:00', '2025-03-05 19:00', '2025-03-05 19:10')
  const e9 = await visit86('Nine', '2025-03-05 23:25')
  await queue86(e9.enc, 'consultation', '2025-03-05 23:30', '2025-03-06 00:10', '2025-03-06 00:20')
  for (const e of [e1, e2, e3, e4, e5, e6, e7, e8, e9]) await close86(e.enc, '2025-03-06 01:00')
  Object.assign(t86, { e1, e2, e3, e4, e5, e6, e7, e8, e9 })
  // money: 10 000 cash + 5 000 MoMo + 2 000 Airtel; 3 000 cancelled; 1 500 refunded; 4 000 the week before
  await pay86(e1.inv, 'cash', 10000, '2025-03-03 10:00')
  await pay86(e2.inv, 'momo', 5000, '2025-03-03 09:45')
  await pay86(e3.inv, 'cash', 3000, '2025-03-04 10:00', { voidedAt: '2025-03-04 10:05' })
  await pay86(e5.inv, 'airtel', 2000, '2025-03-05 12:00')
  await pay86(e6.inv, 'cash', 4000, '2025-02-25 10:00')
  await db.query(
    `insert into refund (invoice_id, amount, method, reason, cashier_id, refunded_at) values ($1, 1500, 'cash', 'overcharged', $2, $3)`,
    [e1.inv, staff.cashier, at86('2025-03-05 13:00')],
  )
  await db.query(
    `insert into invoice_line (invoice_id, service_id, description, quantity, unit_price, office, created_at, entered_by)
     select $1, s.id, 'Consultation 86', 1, 10000, 'consultation', $2, null
     from service s where s.deleted_at is null and s.department_id is null
       and not exists (select 1 from service_department sd where sd.service_id = s.id)
     order by s.code limit 1`,
    [e1.inv, at86('2025-03-03 09:20')],
  )
  // work: the member wrote a diagnosis and a prescription on E2, gave a room medicine on E3
  // (prescribed by the outsider) and registered E5's patient; the retired nurse wrote on E4
  const item = (
    await one(`select id from item where deleted_at is null order by created_at limit 1`)
  ).id
  await db.query(
    `insert into condition (encounter_id, text, created_by, created_at) values ($1, 'Malaria 86', $2, $3), ($4, 'Note 86', $5, $6)`,
    [e2.enc, t86.member, at86('2025-03-03 09:35'), e4.enc, t86.retired, at86('2025-03-03 10:45')],
  )
  await db.query(
    `insert into medication_request (encounter_id, item_id, quantity, prescriber_id, created_at) values ($1, $2, 1, $3, $4)`,
    [e2.enc, item, t86.member, at86('2025-03-03 09:36')],
  )
  await db.query(
    `insert into medication_request (encounter_id, item_id, quantity, prescriber_id, created_at, given_by, given_at)
     values ($1, $2, 1, $3, $4, $5, $6)`,
    [e3.enc, item, t86.outsider, at86('2025-03-03 10:25'), t86.member, at86('2025-03-04 10:30')],
  )
  await db.query(`update patient set created_by = $1 where id = $2`, [t86.member, e5.pid])
  await db.query(`update profiles set active = false where id = $1`, [t86.retired])
  return '9 visits, 5 payments, 1 refund, a department of 2'
})
await step('0086: who may look: the manager, a head (no money), nobody else', async () => {
  const fns = [
    [`select revenue_analysis($1, $2) as j`, P86],
    [`select staff_activity($1, $2) as j`, P86],
    [`select staff_activity_detail($1, $2, $3) as j`, [t86.member, ...P86]],
    [`select visits_analysis($1, $2) as j`, P86],
    [`select wait_time_stats($1, $2) as j`, P86],
  ]
  const nobody = []
  for (const [sql, params] of fns) nobody.push(await call86(t86.nobody, sql, params))
  const access = {
    nobody: await call86(t86.nobody, `select analytics_access() as j`),
    head: await call86(t86.head, `select analytics_access() as j`),
    manager: await call86(staff.manager, `select analytics_access() as j`),
  }
  const head = {
    revenue: await call86(t86.head, ...fns[0]),
    outsider: await call86(t86.head, `select staff_activity_detail($1, $2, $3) as j`, [
      t86.outsider,
      ...P86,
    ]),
    otherDept: await call86(t86.head, `select staff_activity($1, $2, $3) as j`, [
      ...P86,
      crypto.randomUUID(),
    ]),
  }
  if (
    nobody.some((x) => x !== '42501') ||
    access.nobody.views.length !== 0 ||
    json86(access.head.views) !== json86(['staff', 'visits', 'treatments', 'waiting']) ||
    access.head.departments[0]?.id !== t86.dept ||
    access.head.manager ||
    !access.manager.views.includes('revenue') ||
    head.revenue !== '42501' ||
    head.outsider !== '42501' ||
    head.otherDept !== '42501'
  )
    throw new Error(json86({ nobody, access, head }))
  return `nobody: 42501 ×${nobody.length}; head views ${access.head.views.join(', ')}; head: no revenue, no outsider`
})
await step('0086: revenue: net = collected − refunds; days add up; the period before', async () => {
  const r = await call86(staff.manager, `select revenue_analysis($1, $2) as j`, P86)
  const d = await call86(staff.manager, `select dashboard_summary($1, $2) as j`, P86)
  const sum = (k) => r.days.reduce((n, x) => n + Number(x[k]), 0)
  const t = r.totals
  const cash = r.byMethod.find((m) => m.method === 'cash')
  const periodNet = (d.revenuePeriod ?? []).reduce((n, x) => n + Number(x.net), 0)
  if (
    Number(t.collected) !== 17000 ||
    Number(t.refunded) !== 1500 ||
    Number(t.net) !== 15500 ||
    Number(t.voided) !== 3000 ||
    t.voidedCount !== 1 ||
    t.payments !== 3 ||
    t.paidVisits !== 3 ||
    Number(r.prev.collected) !== 4000 ||
    r.days.length !== 7 ||
    sum('net') !== 15500 ||
    sum('cash') + sum('momo') + sum('airtel') + sum('other') !== 17000 ||
    sum('refunds') !== 1500 ||
    sum('voided') !== 3000 ||
    Number(cash?.amount) !== 10000 ||
    r.voided[0]?.reason !== 'wrong amount' ||
    r.refunds[0]?.reason !== 'overcharged' ||
    Number(t.charged) !== 10000 ||
    Number(d.tiles.refunded) !== 1500 ||
    d.revenuePeriod?.length !== 7 ||
    periodNet !== 15500
  )
    throw new Error(json86({ t, prev: r.prev, days: r.days, byMethod: r.byMethod }))
  return `collected ${t.collected} − refunded ${t.refunded} = net ${t.net}; cancelled ${t.voided}; before ${r.prev.collected}`
})
await step(
  '0086: who did what: patients seen by writing too, room medicines, retired staff',
  async () => {
    const m = await call86(staff.manager, `select staff_activity($1, $2) as j`, P86)
    const person = (id) => m.people.find((p) => p.id === id)
    const mem = person(t86.member)
    const cashier = person(staff.cashier)
    const retired = person(t86.retired)
    const d = await call86(staff.manager, `select dashboard_summary($1, $2) as j`, P86)
    const row = d.staff.find((x) => x.id === t86.member)
    // the head: their department's people only, never money
    const h = await call86(t86.head, `select staff_activity($1, $2) as j`, P86)
    const hd = await call86(t86.head, `select staff_activity_detail($1, $2, $3) as j`, [
      t86.member,
      ...P86,
    ])
    const md = await call86(staff.manager, `select staff_activity_detail($1, $2, $3) as j`, [
      staff.cashier,
      ...P86,
    ])
    const headIds = h.people.map((p) => p.id).sort()
    const seenByDay = m.days.filter((x) => x.kind === 'patientsSeen').reduce((n, x) => n + x.n, 0)
    if (
      seenByDay !== m.totals.patientsSeen ||
      d.reorder.some((r) => !r.id || !r.name) ||
      mem?.departments[0]?.id !== t86.dept ||
      mem?.counts.patientsSeen !== 2 ||
      mem.counts.diagnoses !== 1 ||
      mem.counts.prescriptions !== 1 ||
      mem.counts.medicinesGiven !== 1 ||
      mem.counts.registered !== 1 ||
      person(t86.head)?.counts.patientsSeen !== 1 ||
      person(staff.nurse)?.counts.vitals < 1 ||
      cashier?.counts.payments !== 3 ||
      Number(cashier.amount) !== 17000 ||
      cashier.counts.refunds !== 1 ||
      cashier.counts.voided !== 1 ||
      !retired ||
      retired.active ||
      retired.counts.diagnoses !== 1 ||
      m.summary.patientsSeen !== 4 ||
      !m.kinds.includes('payments') ||
      row?.patients !== 2 ||
      row.dispensed !== 1 ||
      json86(headIds) !== json86([t86.head, t86.member].sort()) ||
      h.kinds.some((k) => ['payments', 'refunds', 'voided', 'handovers'].includes(k)) ||
      h.people.some((p) => p.amount != null) ||
      h.summary.collected != null ||
      hd.total !== 6 ||
      hd.money != null ||
      hd.records.some((x) => x.amount != null) ||
      md.money?.byMethod.length !== 3 ||
      md.money.voided[0]?.reason !== 'wrong amount'
    )
      throw new Error(json86({ mem, cashier, retired, summary: m.summary, row, headIds, hd }))
    return `member: seen ${mem.counts.patientsSeen}, room medicines ${mem.counts.medicinesGiven}; head sees ${headIds.length} people, no money`
  },
)
await step(
  '0086: a pharmacy hand-over counts once; counter sales are the pharmacy’s revenue',
  async () => {
    await asAdmin()
    const pharmId = (await one(`select main_pharmacy() as id`)).id
    const batch = await one(`select id, item_id from batch order by created_at limit 1`)
    // a hand-over at the pharmacy, as dispense_prescription writes it: a medication_dispense row
    // AND given_by / given_at on the request (the room-store branch must not count it again)
    const rx = (
      await one(
        `insert into medication_request (encounter_id, item_id, quantity, prescriber_id, created_at, given_by, given_at)
         values ($1, $2, 2, $3, $4, $5, $6) returning id`,
        [
          t86.e4.enc,
          batch.item_id,
          t86.outsider,
          at86('2025-03-04 11:00'),
          staff.pharmacist,
          at86('2025-03-04 11:30'),
        ],
      )
    ).id
    await db.query(
      `insert into medication_dispense (medication_request_id, encounter_id, item_id, batch_id, quantity, dispenser_id, created_at)
       values ($1, $2, $3, $4, 2, $5, $6)`,
      [rx, t86.e4.enc, batch.item_id, batch.id, staff.pharmacist, at86('2025-03-04 11:30')],
    )
    // a walk-in sale of 2 400, paid by cash
    const sale = (
      await one(
        `insert into counter_sale (number, location_id, status, total, paid_at, created_at)
         values ('CS-86-' || substr(gen_random_uuid()::text, 1, 8), $1, 'paid', 2400, $2, $2) returning id`,
        [pharmId, at86('2025-03-06 10:00')],
      )
    ).id
    await db.query(
      `insert into counter_sale_line (sale_id, item_id, quantity, unit_price, line_total, created_at)
       values ($1, $2, 3, 800, 2400, $3)`,
      [sale, batch.item_id, at86('2025-03-06 10:00')],
    )
    await db.query(
      `insert into payment (counter_sale_id, method, amount, cashier_id, paid_at) values ($1, 'cash', 2400, $2, $3)`,
      [sale, staff.cashier, at86('2025-03-06 10:00')],
    )
    const m = await call86(staff.manager, `select staff_activity($1, $2) as j`, P86)
    const ph = m.people.find((p) => p.id === staff.pharmacist)
    const d = await call86(staff.manager, `select dashboard_summary($1, $2) as j`, P86)
    const row = d.staff.find((x) => x.id === staff.pharmacist)
    const det = await call86(staff.manager, `select staff_activity_detail($1, $2, $3, $4) as j`, [
      staff.pharmacist,
      ...P86,
      'medicinesGiven',
    ])
    const r = await call86(staff.manager, `select revenue_analysis($1, $2) as j`, P86)
    const pharmDeptId = (
      await one(
        `select id from department where active and deleted_at is null and 'pharmacy' = any (services)
         order by sort_order, name limit 1`,
      )
    )?.id
    const pharmDept = r.byDepartment.find((x) =>
      pharmDeptId ? x.id === pharmDeptId : x.key === 'pharmacy',
    )
    const pharmCat = r.byCategory.find((x) => x.group === 'pharmacy' && x.id == null)
    if (
      ph?.counts.medicinesGiven !== 1 ||
      row?.dispensed !== 1 ||
      det.total !== 1 ||
      det.records.length !== 1 ||
      Number(r.totals.charged) !== 12400 ||
      Number(r.totals.counterSales) !== 2400 ||
      Number(pharmCat?.charged) !== 2400 ||
      Number(pharmCat?.collectedEst) !== 2400 ||
      !pharmDept ||
      Number(pharmDept.collectedEst) < 2400 ||
      Number(pharmDept.charged) < 2400
    )
      throw new Error(
        json86({
          ph: ph?.counts,
          row,
          det: det.total,
          totals: r.totals,
          pharmCat,
          byDepartment: r.byDepartment,
        }),
      )
    return `pharmacist: 1 medicine given (not 2); charged ${r.totals.charged} with the counter sale; pharmacy collected (est.) ${pharmDept.collectedEst}`
  },
)
await step(
  '0086: waiting time: median and 90th percentile; left-out, pooled and untaken waits',
  async () => {
    const w = await call86(staff.manager, `select wait_time_stats($1, $2) as j`, P86)
    const desk = (s) => w.desks.find((x) => x.station === s)
    const cons = desk('consultation')
    const day = (d) => w.days.find((x) => x.day === d)
    const h = await call86(t86.head, `select wait_time_stats($1, $2) as j`, P86)
    if (
      cons?.n !== 6 ||
      Number(cons.median) !== 35 ||
      Number(cons.p90) !== 55 ||
      cons.excluded !== 2 ||
      desk('dental')?.n !== 0 ||
      desk('dental').median !== null ||
      desk('triage')?.n !== 1 ||
      Number(desk('triage').median) !== 8 ||
      desk('cashier')?.n !== 1 ||
      Number(desk('cashier').median) !== 5 ||
      w.overall.n !== 8 ||
      Number(w.overall.median) !== 25 ||
      Number(w.overall.p90) !== 53 ||
      w.overall.excluded !== 2 ||
      w.arrival.n !== 6 ||
      Number(w.arrival.median) !== 40 ||
      w.days.length !== 7 ||
      day('2025-03-03')?.n !== 6 ||
      Number(day('2025-03-03').median) !== 15 ||
      day('2025-03-04')?.n !== 2 ||
      Number(day('2025-03-04').median) !== 55 ||
      w.rules.minN !== 5 ||
      json86(h.desks.map((x) => x.station)) !== json86(['consultation']) ||
      h.desks[0].n !== 6
    )
      throw new Error(
        json86({ desks: w.desks, overall: w.overall, arrival: w.arrival, days: w.days }),
      )
    return `consultation n ${cons.n}, median ${cons.median}, p90 ${cons.p90}, left out ${cons.excluded}; all desks median ${w.overall.median}`
  },
)
await step('0086: waiting now: joined today; older open entries are forgotten', async () => {
  const today = async () =>
    (await call86(staff.manager, `select wait_time_stats() as j`)).desks.find(
      (x) => x.station === 'consultation',
    )
  const before = await today()
  const dashBefore = await call86(
    staff.manager,
    `select dashboard_summary(current_date, current_date) as j`,
  )
  await asAdmin()
  const now = (
    await one(`insert into patient (surname, given_names) values ('Analytics', 'Now') returning id`)
  ).id
  const old = (
    await one(`insert into patient (surname, given_names) values ('Analytics', 'Old') returning id`)
  ).id
  const eNow = (await one(`insert into encounter (patient_id) values ($1) returning id`, [now])).id
  const eOld = (
    await one(
      `insert into encounter (patient_id, arrived_at) values ($1, now() - interval '1 day') returning id`,
      [old],
    )
  ).id
  await db.query(
    `insert into queue_entry (encounter_id, station, ticket_no, created_at) values
     ($1, 'consultation', 'N86', now() - interval '20 minutes'), ($2, 'consultation', 'O86', now() - interval '1 day')`,
    [eNow, eOld],
  )
  const after = await today()
  const dash = await call86(
    staff.manager,
    `select dashboard_summary(current_date, current_date) as j`,
  )
  const tile = dash.waitByStation.find((x) => x.station === 'consultation')
  await db.query(`update queue_entry set finished_at = now() where encounter_id in ($1, $2)`, [
    eNow,
    eOld,
  ])
  await db.query(`update encounter set status = 'closed', closed_at = now() where id in ($1, $2)`, [
    eNow,
    eOld,
  ])
  await asAdmin()
  await db.query(`update department set active = false where id = $1`, [t86.dept])
  if (
    after.waitingNow !== before.waitingNow + 1 ||
    after.forgotten !== before.forgotten + 1 ||
    after.longestNow < 20 ||
    dash.tiles.waitingNow !== dashBefore.tiles.waitingNow + 1 ||
    dash.tiles.forgottenNow !== dashBefore.tiles.forgottenNow + 1 ||
    'avgWaitMin' in dash.tiles ||
    !tile ||
    'minutes' in tile ||
    tile.forgotten < 1
  )
    throw new Error(json86({ before, after, tiles: dash.tiles, tile }))
  return `consultation: waiting ${before.waitingNow} → ${after.waitingNow}, forgotten ${before.forgotten} → ${after.forgotten}; no average on the cards`
})
await step(
  '0086: visits and treatments: the period, new patients, a head sees no money',
  async () => {
    const m = await call86(staff.manager, `select visits_analysis($1, $2) as j`, P86)
    const h = await call86(t86.head, `select visits_analysis($1, $2) as j`, P86)
    const daySum = m.days.reduce((n, x) => n + x.visits, 0)
    const hourSum = m.byHour.reduce((n, x) => n + x, 0)
    const line = m.treatments.find((x) => x.description === 'Consultation 86')
    // a department counts only the visits its own people took or were given (or sent to it)
    await asAdmin()
    const hExpected = (
      await one(
        `select count(distinct q.encounter_id)::int as n from queue_entry q
         join encounter e on e.id = q.encounter_id and e.deleted_at is null
         where q.deleted_at is null and q.station = 'consultation'
           and e.arrived_at >= ($1::date)::timestamp at time zone 'Africa/Kigali'
           and e.arrived_at < ($2::date + 1)::timestamp at time zone 'Africa/Kigali'
           and (q.department_id = $3 or exists (select 1 from staff_department sd
                where sd.department_id = $3 and sd.profile_id in (q.taken_by, q.assigned_to)))`,
        [...P86, t86.dept],
      )
    ).n
    if (
      m.totals.visits !== 9 ||
      m.totals.newPatients !== 9 ||
      m.totals.registered !== 9 ||
      m.prev.visits !== 0 ||
      daySum !== 9 ||
      hourSum !== 9 ||
      m.days.length !== 7 ||
      m.byType.find((x) => x.type === 'opd')?.count !== 9 ||
      line?.count !== 1 ||
      Number(line.amount) !== 10000 ||
      h.totals.visits !== hExpected ||
      hExpected < 1 ||
      hExpected >= 9 ||
      h.treatmentTotals.charged != null ||
      h.treatments.some((x) => x.amount != null)
    )
      throw new Error(json86({ totals: m.totals, prev: m.prev, h: h.totals, line }))
    return `visits ${m.totals.visits} (${m.totals.newPatients} new), by day and hour; head: no amounts`
  },
)

// ---------------------------------------------------------------- 0087: every switch decides
// Settings → Who may do what: a role's switch, or one employee's exception (which wins), decides
// what the database lets the person do, in both directions.
const t87 = {}
const json87 = (x) => JSON.stringify(x)
const perms87 = async (who) => {
  await as(who)
  const p = (await one(`select my_permissions() as p`)).p
  await asAdmin()
  return p
}
/** As the manager: a role's switch, or one employee's exception (null = as the role). */
const role87 = async (role, perm, on) => {
  await as(staff.manager)
  await db.query(`select set_role_permission($1, $2, $3)`, [role, perm, on])
  await asAdmin()
}
const except87 = async (who, perm, on) => {
  await as(staff.manager)
  await db.query(`select set_staff_permission($1, $2, $3)`, [who, perm, on])
  await asAdmin()
}
/** A visit opened directly: at triage or not, with a bill line of `amount` RWF. */
const visit87 = async (given, { triage = false, amount = 0 } = {}) => {
  await asAdmin()
  const pid = (
    await one(
      `insert into patient (surname, given_names, sex) values ('Switch', $1, 'female') returning id`,
      [given],
    )
  ).id
  const enc = (await one(`insert into encounter (patient_id) values ($1) returning id`, [pid])).id
  if (triage)
    await db.query(
      `insert into queue_entry (encounter_id, station, ticket_no) values ($1, 'triage', 'S87')`,
      [enc],
    )
  const inv = (await one(`select id from invoice where encounter_id = $1`, [enc])).id
  if (amount)
    await db.query(
      `insert into invoice_line (invoice_id, service_id, description, quantity, unit_price, office, patient_share, insurer_share)
       select $1, s.id, 'Consultation 87', 1, $2, 'consultation', $2, 0 from service s
       where s.deleted_at is null order by s.code limit 1`,
      [inv, amount],
    )
  return { pid, enc, inv }
}
/** A statement's single value as someone ({ error } when refused). */
const valAs = async (who, sql, params = []) => {
  await as(who)
  try {
    return (await one(sql, params))?.v
  } catch (e) {
    return { error: `${e.code}/${e.hint ?? ''}` }
  } finally {
    await asAdmin()
  }
}
await step(
  '0087 A: vital signs switched off for nurses: every function that writes them refuses',
  async () => {
    t87.triage = await dept85('Triage 87', ['triage'])
    t87.nurse = await newStaff('sw87.nurse', 'Switch Nurse 87', 'nurse', 'Triage')
    await member85(t87.nurse, t87.triage)
    const atTriage = await visit87('Vitals', { triage: true })
    const later = await visit87('Later')
    const vitals = `select record_vitals($1, '{"pulse":"80"}'::jsonb)`
    const r = {}
    r.deskOn = await deskAs(t87.nurse, 'triage')
    r.on = await hintAs(t87.nurse, vitals, [atTriage.enc])
    // Frank's switch: "Record vital signs" off for the nurse role
    await role87('nurse', 'vitals.write', false)
    r.perms = await perms87(t87.nurse)
    r.deskOff = await deskAs(t87.nurse, 'triage')
    r.atTriage = await hintAs(t87.nurse, vitals, [atTriage.enc])
    r.later = await hintAs(t87.nurse, vitals, [later.enc])
    r.send = await hintAs(t87.nurse, `select send_from_triage($1, 'green', 'consultation')`, [
      atTriage.enc,
    ])
    r.otherNurse = await hintAs(staff.nurse, vitals, [later.enc])
    // reading what other permissions allow stays: the nurse still sees the vitals of the visit
    r.read = await valAs(
      t87.nurse,
      `select count(*)::int as v from visit_vitals where encounter_id = $1`,
      [atTriage.enc],
    )
    // the manager allows this one nurse: her exception wins over the role
    await except87(t87.nurse, 'vitals.write', true)
    r.permsEx = await perms87(t87.nurse)
    r.deskEx = await deskAs(t87.nurse, 'triage')
    r.exception = await hintAs(t87.nurse, vitals, [later.enc])
    // and the other way: the role allowed again, this nurse not allowed
    await role87('nurse', 'vitals.write', true)
    await except87(t87.nurse, 'vitals.write', false)
    r.denied = await hintAs(t87.nurse, vitals, [later.enc])
    r.otherBack = await hintAs(staff.nurse, vitals, [later.enc])
    await except87(t87.nurse, 'vitals.write', null)
    r.back = await hintAs(t87.nurse, vitals, [atTriage.enc])
    await asAdmin()
    await db.query(`update department set active = false where id = $1`, [t87.triage])
    if (
      !r.deskOn ||
      r.on !== 'ok' ||
      r.perms.includes('vitals.write') ||
      r.deskOff ||
      r.atTriage !== '42501/not_permitted' ||
      r.later !== '42501/not_permitted' ||
      r.send !== '42501/not_permitted' ||
      r.otherNurse !== '42501/not_permitted' ||
      !(r.read > 0) ||
      !r.permsEx.includes('vitals.write') ||
      !r.deskEx ||
      r.exception !== 'ok' ||
      r.denied !== '42501/not_permitted' ||
      r.otherBack !== 'ok' ||
      r.back !== 'ok'
    )
      throw new Error(json87(r))
    return 'off: record_vitals (at triage and later) and send_from_triage refuse, the triage desk goes, vitals still read; exceptions win both ways'
  },
)
await step(
  '0087 B: "Take payments" given to a nurse: she takes a payment, reprints the receipt, counts her cash',
  async () => {
    const v = await visit87('Pays', { amount: 5000 })
    const r = {}
    r.before = await hintAs(t87.nurse, `select take_payment($1, 'cash', 2000)`, [v.enc])
    await role87('nurse', 'payment.take', true)
    // her treatments switched off: what she reads of the bill comes from "Take payments" alone
    await except87(t87.nurse, 'charge.write', false)
    r.perms = await perms87(t87.nurse)
    const paid = await valAs(t87.nurse, `select take_payment($1, 'cash', 2000) as v`, [v.enc])
    r.receipt = paid?.receipt ?? null
    r.bill = await valAs(
      t87.nurse,
      `select to_jsonb(b) as v from (select paid, balance, receipt_no, receipt_amount, settled_by
         from visit_bill where encounter_id = $1) b`,
      [v.enc],
    )
    r.lines = await valAs(
      t87.nurse,
      `select count(*)::int as v from visit_charges where encounter_id = $1`,
      [v.enc],
    )
    await asAdmin()
    const notes = (await one(`select count(*)::int as n from credit_note`)).n
    r.notes = await valAs(t87.nurse, `select count(*)::int as v from credit_note`)
    // the cashier pages: her own payments, the bills waiting; the cashier still sees the whole desk
    const mine = await valAs(t87.nurse, `select cashier_summary() as v`)
    const desk = await valAs(staff.cashier, `select cashier_summary() as v`)
    r.mine = {
      scope: mine?.scope,
      total: Number(mine?.total),
      count: mine?.count,
      payments: mine?.payments?.length,
      allMine: mine?.payments?.every((p) => p.mine),
      expected: mine?.myExpected?.cash,
      openBills: mine?.openBills,
    }
    r.desk = { scope: desk?.scope, total: Number(desk?.total) }
    // the manager switches her off during the day: she can no longer take money, but still counts
    // what she took
    await role87('nurse', 'payment.take', false)
    r.off = await hintAs(t87.nurse, `select take_payment($1, 'cash', 1000)`, [v.enc])
    r.direct = await hintAs(t87.nurse, `select record_payment($1, 'cash', 1000)`, [v.inv])
    r.offSummary = (await valAs(t87.nurse, `select cashier_summary() as v`))?.scope
    r.count = await valAs(
      t87.nurse,
      `select close_cash_day(null, '{"cash":"2000"}'::jsonb, 'switched off') as v`,
    )
    r.afterCount = await valAs(t87.nurse, `select cashier_summary() as v`)
    r.billOff = await valAs(
      t87.nurse,
      `select count(*)::int as v from visit_bill where encounter_id = $1`,
      [v.enc],
    )
    await except87(t87.nurse, 'charge.write', null)
    if (
      r.before !== '42501/' ||
      !r.perms.includes('payment.take') ||
      r.perms.includes('charge.write') ||
      !r.receipt ||
      Number(r.bill?.paid) !== 2000 ||
      Number(r.bill?.balance) !== 3000 ||
      r.bill?.receipt_no !== r.receipt ||
      Number(r.bill?.receipt_amount) !== 2000 ||
      r.bill?.settled_by !== 'Switch Nurse 87' ||
      r.lines !== 1 ||
      r.notes !== notes ||
      r.mine.scope !== 'mine' ||
      r.mine.total !== 2000 ||
      r.mine.count !== 1 ||
      r.mine.payments !== 1 ||
      !r.mine.allMine ||
      Number(r.mine.expected) !== 2000 ||
      !(r.mine.openBills >= 1) ||
      r.desk.scope !== 'desk' ||
      !(r.desk.total >= 2000) ||
      r.off !== '42501/' ||
      r.direct !== '42501/not_permitted' ||
      r.offSummary !== 'mine' ||
      Number(r.count?.variance) !== 0 ||
      r.afterCount?.error !== '42501/' ||
      r.billOff !== 0
    )
      throw new Error(json87(r))
    return `receipt ${r.receipt}, bill paid ${r.bill.paid} of 5000; her summary: ${r.mine.total} (own only); switched off: refused, still counted (variance 0)`
  },
)
await step(
  '0087 C: "Take payments" off for one cashier: no payment, refund, cancellation or cash count by direct calls',
  async () => {
    const cashier = await newStaff('sw87.cashier', 'Switch Cashier 87', 'cashier')
    const v = await visit87('Cashier', { amount: 4000 })
    const r = {}
    r.on = await valAs(cashier, `select take_payment($1, 'cash', 1000) as v`, [v.enc])
    const pay = (await one(`select id from payment where invoice_id = $1`, [v.inv])).id
    await except87(cashier, 'payment.take', false)
    r.perms = await perms87(cashier)
    r.take = await hintAs(cashier, `select take_payment($1, 'cash', 1000)`, [v.enc])
    r.record = await hintAs(cashier, `select record_payment($1, 'cash', 1000)`, [v.inv])
    r.post = await hintAs(cashier, `select post_invoice($1)`, [v.inv])
    r.refund = await hintAs(cashier, `select refund_payment($1, 500, 'cash', 'test 87')`, [v.enc])
    r.void = await hintAs(cashier, `select void_payment($1, 'test 87')`, [pay])
    // she took 1 000 today: she still counts it; the desk's summary stays hers to read (billing.read)
    r.count = await hintAs(cashier, `select close_cash_day(null, '{"cash":"1000"}'::jsonb)`)
    r.summary = (await valAs(cashier, `select cashier_summary() as v`))?.scope
    // another cashier switched off, with nothing taken today: no cash count
    const idle = await newStaff('sw87.idle', 'Idle Cashier 87', 'cashier')
    await except87(idle, 'payment.take', false)
    r.idleCount = await hintAs(idle, `select close_cash_day(null, '{}'::jsonb)`)
    await except87(cashier, 'payment.take', null)
    await except87(idle, 'payment.take', null)
    r.back = await hintAs(cashier, `select record_payment($1, 'cash', 500)`, [v.inv])
    if (
      !r.on?.receipt ||
      r.perms.includes('payment.take') ||
      r.take !== '42501/' ||
      r.record !== '42501/not_permitted' ||
      r.post !== '42501/not_permitted' ||
      r.refund !== '42501/not_permitted' ||
      r.void !== '42501/not_permitted' ||
      r.count !== 'ok' ||
      r.summary !== 'desk' ||
      r.idleCount !== '42501/not_permitted' ||
      r.back !== 'ok'
    )
      throw new Error(json87(r))
    return 'off: record_payment, post_invoice, refund and cancel refused; the day she worked still counted'
  },
)
await step(
  '0087 D: "Test results" off for the lab: the Laboratory desk stays, results and samples refused',
  async () => {
    const v = await visit87('Lab')
    const req = async () =>
      (
        await one(
          `insert into service_request (encounter_id, category, service_id, priority, station)
           values ($1, 'lab', $2, 3, 'laboratory') returning id`,
          [v.enc, t85.test],
        )
      ).id
    const a = await req()
    const b = await req()
    const r = {}
    r.deskOn = await deskAs(staff.lab_tech, 'laboratory')
    r.verify = await hintAs(
      staff.lab_tech,
      `select record_result($1, 'Negative', 'No malaria', true)`,
      [a],
    )
    await role87('lab_tech', 'orders.write', false)
    r.deskOff = await deskAs(staff.lab_tech, 'laboratory')
    r.result = await hintAs(staff.lab_tech, `select record_result($1, 'x', 'y', true)`, [b])
    r.sample = await hintAs(staff.lab_tech, `select set_request_status($1, 'collected')`, [b])
    r.correct = await hintAs(staff.lab_tech, `select correct_result($1, 'x', 'y', 'typo 87')`, [a])
    // one lab tech allowed: the exception wins
    await except87(staff.lab_tech, 'orders.write', true)
    r.exception = await hintAs(staff.lab_tech, `select set_request_status($1, 'collected')`, [b])
    await except87(staff.lab_tech, 'orders.write', null)
    await role87('lab_tech', 'orders.write', true)
    r.back = await hintAs(staff.lab_tech, `select record_result($1, 'x', 'y', true)`, [b])
    if (
      !r.deskOn ||
      r.verify !== 'ok' ||
      !r.deskOff ||
      r.result !== '42501/not_permitted' ||
      r.sample !== '42501/not_permitted' ||
      r.correct !== '42501/not_permitted' ||
      r.exception !== 'ok' ||
      r.back !== 'ok'
    )
      throw new Error(json87(r))
    return 'off: record_result, set_request_status and correct_result refuse at the Laboratory desk; one lab tech allowed'
  },
)
await step(
  '0087 E: "Approve bookings" given to a pharmacist: he sees the requests and answers them',
  async () => {
    await asAdmin()
    const inquiry = async (name) =>
      (
        await one(
          `insert into appointment (status, contact_name, contact_phone, preferred_at)
           values ('inquiry', $1, '0788000087', now() + interval '1 day') returning id`,
          [name],
        )
      ).id
    const a = await inquiry('Booking 87 A')
    const b = await inquiry('Booking 87 B')
    const seen = async () =>
      ((await valAs(staff.pharmacist, `select inquiries_open() as v`)) ?? []).filter((x) =>
        [a, b].includes(x.id),
      ).length
    const r = {}
    r.before = await seen()
    r.rejectBefore = await hintAs(staff.pharmacist, `select reject_inquiry($1, 'test 87')`, [a])
    await except87(staff.pharmacist, 'appointment.approve', true)
    r.after = await seen()
    r.detail = (await valAs(staff.pharmacist, `select appointment_detail($1) as v`, [a]))?.id
    r.day = Array.isArray(await valAs(staff.pharmacist, `select appointments_day() as v`))
    r.reject = await hintAs(staff.pharmacist, `select reject_inquiry($1, 'test 87')`, [a])
    // the reception's switch off: the receptionist answers no more requests
    await role87('receptionist', 'appointment.approve', false)
    r.recep = await hintAs(staff.receptionist, `select reject_inquiry($1, 'test 87')`, [b])
    await role87('receptionist', 'appointment.approve', true)
    await except87(staff.pharmacist, 'appointment.approve', null)
    await asAdmin()
    await db.query(`update appointment set deleted_at = now() where id = any ($1)`, [[a, b]])
    if (
      r.before !== 0 ||
      r.rejectBefore !== '42501/' ||
      r.after !== 2 ||
      r.detail !== a ||
      !r.day ||
      r.reject !== 'ok' ||
      r.recep !== '42501/'
    )
      throw new Error(json87(r))
    return 'allowed: requests seen (2) and answered; reception switched off: refused'
  },
)
await step(
  '0087 F: "Manage stock" decides at the pharmacy desk; dispensing and selling stay with the desk',
  async () => {
    const pharm = (await one(`select main_pharmacy() as id`)).id
    const item = (await one(`select id from item where code = 'AMOX500'`)).id
    const receive = `select receive_stock($1, $2, 5, 10, 'SW-87', '2031-06-30')`
    t87.pharm = await newStaff('sw87.pharm', 'Switch Pharmacist 87', 'pharmacist')
    await member85(t87.pharm, t85.pharmacy)
    const r = {}
    r.desk = await deskAs(t87.pharm, 'pharmacy')
    r.on = await hintAs(t87.pharm, receive, [item, pharm])
    await role87('pharmacist', 'stock.write', false)
    r.off = await hintAs(t87.pharm, receive, [item, pharm])
    r.count = await hintAs(t87.pharm, `select adjust_stock($1, $2, 0, 'count 87')`, [item, pharm])
    r.manage = (await valAs(t87.pharm, `select store_stock($1) as v`, [pharm]))?.canManage
    r.admin = await valAs(t87.pharm, `select stock_admin() as v`)
    await role87('pharmacist', 'stock.write', true)
    r.manageOn = (await valAs(t87.pharm, `select store_stock($1) as v`, [pharm]))?.canManage
    // the nurse of Pharmacy 85 dispenses (the desk) but does not manage the stock …
    r.nurse = await hintAs(t85.nurse, receive, [item, pharm])
    // … until the manager allows her
    await except87(t85.nurse, 'stock.write', true)
    r.nurseEx = await hintAs(t85.nurse, receive, [item, pharm])
    await except87(t85.nurse, 'stock.write', null)
    // a lab tech (stock.write by role) without the pharmacy desk still does not
    r.labTech = await hintAs(staff.lab_tech, receive, [item, pharm])
    if (
      !r.desk ||
      r.on !== 'ok' ||
      r.off !== '42501/not_permitted' ||
      r.count !== '42501/not_permitted' ||
      r.manage !== false ||
      r.admin !== true ||
      r.manageOn !== true ||
      r.nurse !== '42501/not_permitted' ||
      r.nurseEx !== 'ok' ||
      r.labTech !== '42501/'
    )
      throw new Error(json87(r))
    return 'pharmacist switched off: receive and count refused, desk kept; nurse of Pharmacy allowed by exception'
  },
)

// ---------------------------------------------------------------- 0088 patient record privacy
const t88 = {}
const json88 = (x) => JSON.stringify(x)
/** A function's jsonb as someone (`{ error: 'code/hint' }` when refused). */
const j88 = async (who, sql, params = []) => {
  await as(who)
  try {
    return (await one(sql, params)).j
  } catch (e) {
    return { error: `${e.code}/${e.hint ?? ''}` }
  } finally {
    await asAdmin()
  }
}
const log88 = async (pid) =>
  (
    await db.query(
      `select actor_id, via, what, encounter_id, request_id from record_access_entry where patient_id = $1 order by at`,
      [pid],
    )
  ).rows
const notices88 = async (kind, requestId) =>
  (
    await db.query(
      `select recipient_user, urgent from notification where kind = $1 and params ->> 'requestId' = $2`,
      [kind, requestId],
    )
  ).rows
/** An open visit of the patient at consultation, taken by `doctor`. */
const openVisit88 = async (pid, doctor) => {
  await asAdmin()
  const enc = (await one(`insert into encounter (patient_id) values ($1) returning id`, [pid])).id
  await db.query(
    `insert into queue_entry (encounter_id, station, ticket_no, department_id, taken_by, started_at)
     values ($1, 'consultation', 'P88', $2, $3, now())`,
    [enc, t88.dept, doctor],
  )
  return enc
}
const close88 = async (enc) => {
  await asAdmin()
  await db.query(
    `update queue_entry set finished_at = now() where encounter_id = $1 and finished_at is null`,
    [enc],
  )
  await db.query(`update encounter set status = 'closed', closed_at = now() where id = $1`, [enc])
}
await step(
  '0088 seed: a patient with a past visit (Dr A) and an open one (Dr B); a head and an assistant',
  async () => {
    t88.dept = await dept85('Consultation 88', ['consultation'])
    t88.docA = await newStaff('p88.doca', 'Dr. Past 88', 'doctor', 'Consultation 1')
    t88.docB = await newStaff('p88.docb', 'Dr. Now 88', 'doctor', 'Consultation 1')
    t88.docC = await newStaff('p88.docc', 'Dr. Other 88', 'doctor', 'Consultation 1')
    t88.head = await newStaff('p88.head', 'Dr. Head 88', 'doctor', 'Consultation 1')
    t88.assist = await newStaff('p88.assist', 'Dr. Assistant 88', 'doctor', 'Consultation 1')
    for (const d of [t88.docA, t88.docB, t88.docC]) await member85(d, t88.dept)
    await member85(t88.head, t88.dept, 'head')
    await member85(t88.assist, t88.dept, 'assistant')
    await asAdmin()
    t88.pid = (
      await one(
        `insert into patient (surname, given_names, sex, allergies, blood_group, notes)
         values ('Private', 'Record 88', 'female', 'Penicillin', 'A+', 'Asthmatic, carries an inhaler') returning id`,
      )
    ).id
    // the past visit, treated by Dr A in Consultation 88
    t88.v1 = await openVisit88(t88.pid, t88.docA)
    await db.query(
      `insert into condition (encounter_id, icd10_code, text, type, created_by)
       values ($1, 'I10', 'Essential hypertension', 'primary', $2)`,
      [t88.v1, t88.docA],
    )
    await db.query(
      `insert into observation (encounter_id, code, value_text, performer_id, created_by)
       values ($1, 'note', 'Past visit note 88', $2, $2)`,
      [t88.v1, t88.docA],
    )
    await db.query(
      `insert into observation (encounter_id, code, value_num, unit, performer_id) values ($1, 'bp_sys', 162, 'mmHg', $2)`,
      [t88.v1, t88.docA],
    )
    const item = (await one(`select id from item where code = 'AMOX500'`)).id
    await db.query(
      `insert into medication_request (encounter_id, item_id, quantity, duration_days, prescriber_id, created_by, created_at)
       values ($1, $2, 30, 60, $3, $3, now() - interval '10 days')`,
      [t88.v1, item, t88.docA],
    )
    t88.service = (
      await one(`select id from service where deleted_at is null order by code limit 1`)
    ).id
    const sr = (
      await one(
        `insert into service_request (encounter_id, category, service_id, station, requester_id)
         values ($1, 'lab', $2, 'laboratory', $3) returning id`,
        [t88.v1, t88.service, t88.docA],
      )
    ).id
    await db.query(
      `insert into diagnostic_report (service_request_id, findings, impression, verified_at) values ($1, 'Past finding 88', 'Past result 88', now())`,
      [sr],
    )
    await close88(t88.v1)
    // the visit today, Dr B treats the patient
    t88.v2 = await openVisit88(t88.pid, t88.docB)
    const r = await one(
      `select (select count(*)::int from encounter where patient_id = $1) as visits,
              heads_in_charge($1) = array[$2::uuid] as heads, visit_departments($3) as deps`,
      [t88.pid, t88.head, t88.v1],
    )
    if (r.visits !== 2 || !r.heads || !r.deps.includes(t88.dept)) throw new Error(json88(r))
    return `Consultation 88 in charge (${r.deps.length} departments give consultation); one head; 1 past visit, 1 open`
  },
)
await step(
  '0088 A: four levels — identity, safety summary, this visit, full history (manager, head, own visit)',
  async () => {
    const file = `select patient_file($1) as j`
    const vc = `select visit_clinical($1) as j`
    const r = {}
    const rec = await j88(staff.receptionist, file, [t88.pid])
    const pastRec = rec.visits.find((v) => v.id === t88.v1)
    r.reception = {
      level: rec.access.level,
      private: pastRec.private,
      diagnosis: pastRec.diagnosis,
      conditions: rec.conditions.length,
      allergies: rec.patient.allergies,
      blood: rec.patient.blood_group,
      hidden: rec.safetyHidden,
      summary: rec.summary,
      docAllergies: rec.document?.allergies,
      // identity stays: name, file number, phone, payer
      name: rec.patient.surname,
      file: !!rec.patient.file_number,
      bills: rec.bills.length,
    }
    r.recClinical = await j88(staff.receptionist, vc, [t88.v1])
    const b = await j88(t88.docB, file, [t88.pid])
    r.docB = {
      level: b.access.level,
      v1Private: b.visits.find((v) => v.id === t88.v1).private,
      v2View: b.visits.find((v) => v.id === t88.v2).view,
      allergies: b.summary?.allergies,
      blood: b.summary?.bloodGroup,
      alerts: b.summary?.alerts,
      chronic: b.summary?.chronic?.map((c) => c.icd10),
      meds: b.summary?.medications?.length,
      lastBp: b.summary?.lastVitals?.find((v) => v.code === 'bp_sys')?.value,
      conditions: b.conditions.length,
      canRequest: b.access.canRequest,
      canEmergency: b.access.canEmergency,
      hiddenVisits: b.access.hiddenVisits,
      treating: b.access.treatingEncounterId === t88.v2,
    }
    const bv1 = await j88(t88.docB, vc, [t88.v1])
    r.docBv1 = { private: bv1.private, dx: bv1.diagnoses.length, notes: bv1.notes.length }
    const bv2 = await j88(t88.docB, vc, [t88.v2])
    r.docBv2 = { private: bv2.private, view: bv2.view }
    // Dr C is in the department but neither treats nor treated the patient
    const cv2 = await j88(t88.docC, vc, [t88.v2])
    r.docC = { v2: cv2.private, level: (await j88(t88.docC, file, [t88.pid])).access.level }
    // Dr A treated the past visit: he sees it, not today's
    const a = await j88(t88.docA, file, [t88.pid])
    r.docA = {
      level: a.access.level,
      v1: a.visits.find((v) => v.id === t88.v1).view,
      own: a.access.ownVisits,
      dx: (await j88(t88.docA, vc, [t88.v1])).diagnoses.length,
      v2: (await j88(t88.docA, vc, [t88.v2])).private,
    }
    const h = await j88(t88.head, file, [t88.pid])
    r.head = {
      level: h.access.level,
      via: h.access.via,
      v1: h.visits.find((v) => v.id === t88.v1).view,
      dx: (await j88(t88.head, vc, [t88.v1])).diagnoses.length,
    }
    const as_ = await j88(t88.assist, file, [t88.pid])
    r.assistant = { level: as_.access.level, v1: as_.visits.find((v) => v.id === t88.v1).private }
    const m = await j88(staff.manager, file, [t88.pid])
    r.manager = {
      level: m.access.level,
      via: m.access.via,
      v1: m.visits.find((v) => v.id === t88.v1).view,
    }
    // results: Dr B sees none of the past visit's, the head does
    r.resultsB = (await j88(t88.docB, `select patient_results($1) as j`, [t88.pid])).length
    r.resultsHead = (await j88(t88.head, `select patient_results($1) as j`, [t88.pid])).length
    r.log = (await log88(t88.pid)).map((x) => `${x.via}:${x.what}`)
    if (
      r.reception.level !== 'identity' ||
      r.reception.private !== true ||
      r.reception.diagnosis !== null ||
      r.reception.conditions !== 0 ||
      r.reception.allergies !== null ||
      r.reception.blood !== null ||
      r.reception.hidden !== true ||
      r.reception.summary !== null ||
      r.reception.docAllergies !== undefined ||
      r.reception.name !== 'Private' ||
      !r.reception.file ||
      r.reception.bills !== 2 ||
      r.recClinical !== null ||
      r.docB.level !== 'summary' ||
      r.docB.v1Private !== true ||
      r.docB.v2View !== 'visit' ||
      r.docB.allergies !== 'Penicillin' ||
      r.docB.blood !== 'A+' ||
      !r.docB.alerts ||
      !r.docB.chronic?.includes('I10') ||
      r.docB.meds !== 1 ||
      Number(r.docB.lastBp) !== 162 ||
      r.docB.conditions !== 0 ||
      !r.docB.canRequest ||
      !r.docB.canEmergency ||
      r.docB.hiddenVisits !== 1 ||
      !r.docB.treating ||
      r.docBv1.private !== true ||
      r.docBv1.dx !== 0 ||
      r.docBv1.notes !== 0 ||
      r.docBv2.private !== false ||
      r.docBv2.view !== 'visit' ||
      r.docC.v2 !== true ||
      r.docC.level !== 'identity' ||
      r.docA.level !== 'identity' ||
      r.docA.v1 !== 'own' ||
      r.docA.own !== 1 ||
      r.docA.dx !== 1 ||
      r.docA.v2 !== true ||
      r.head.level !== 'full' ||
      r.head.via !== 'head' ||
      r.head.v1 !== 'head' ||
      r.head.dx !== 1 ||
      r.assistant.level !== 'identity' ||
      r.assistant.v1 !== true ||
      r.manager.level !== 'full' ||
      r.manager.via !== 'manager' ||
      r.manager.v1 !== 'manager' ||
      r.resultsB !== 0 ||
      r.resultsHead !== 1 ||
      !r.log.includes('own:file') ||
      !r.log.includes('own:visit') ||
      !r.log.includes('head:file') ||
      !r.log.includes('manager:file') ||
      r.log.some((x) => x.startsWith('visit'))
    )
      throw new Error(json88(r))
    return `reception: identity; Dr B (treating): summary, past private; Dr A: own visit; head and manager: full; assistant: identity; log ${r.log.length}`
  },
)
await step(
  '0088 B: request access: only while treating, with a reason; the manager answers (or who the manager allowed, 0095); ends when the visit closes',
  async () => {
    const ask = `select request_record_access($1, $2) as j`
    const pending = `select record_access_requests('pending') as j`
    const mine = async (who) => {
      await as(who)
      const p = (await one(`select my_permissions() as p`)).p
      await asAdmin()
      return p.includes('records.approve')
    }
    const r = {}
    r.noReason = (await j88(t88.docB, ask, [t88.pid, ' ']))?.error
    r.notTreating = (await j88(t88.docC, ask, [t88.pid, 'Need the history']))?.error
    r.reception = (await j88(staff.receptionist, ask, [t88.pid, 'Need the history']))?.error
    r.head = (await j88(t88.head, ask, [t88.pid, 'Need the history']))?.error
    const req = await j88(t88.docB, ask, [t88.pid, 'Chest pain: earlier ECG and treatment'])
    t88.req = req.id
    r.approvers = req.approvers
    r.again = (await j88(t88.docB, ask, [t88.pid, 'again']))?.existing
    // 0095: only the manager is told; a head is not an approver by position
    r.notices = (await notices88('access_request', t88.req)).map((n) => n.recipient_user).sort()
    r.pendingHead = (await j88(t88.head, pending)).length
    r.pendingManager = (await j88(staff.manager, pending)).map(
      (x) => x.id === t88.req && x.canAnswer,
    )
    r.pendingAssist = (await j88(t88.assist, pending)).length
    r.accessB = (await j88(t88.docB, `select patient_access($1) as j`, [t88.pid])).request?.status
    const answer = `select answer_record_access($1, $2, $3) as j`
    r.assistant = (await j88(t88.assist, answer, [t88.req, true, null]))?.error
    r.headAnswer = (await j88(t88.head, answer, [t88.req, true, null]))?.error
    r.self = (await j88(t88.docB, answer, [t88.req, true, null]))?.error
    // the manager gives the head the right as an exception: the head sees and may answer
    await except87(t88.head, 'records.approve', true)
    r.headMine = await mine(t88.head)
    r.pendingHeadOn = (await j88(t88.head, pending)).map((x) => x.id === t88.req && x.canAnswer)
    await except87(t88.head, 'records.approve', null)
    r.headMineOff = await mine(t88.head)
    r.headAgain = (await j88(t88.head, answer, [t88.req, true, null]))?.error
    r.refuseNoReason = (await j88(staff.manager, answer, [t88.req, false, '']))?.error
    // the switch for every nurse: a nurse answers
    r.nurseBefore = (await j88(staff.nurse, answer, [t88.req, true, null]))?.error
    await role87('nurse', 'records.approve', true)
    r.nurseMine = await mine(staff.nurse)
    r.managerMine = await mine(staff.manager)
    r.approve = (await j88(staff.nurse, answer, [t88.req, true, null]))?.status
    r.late = (await j88(staff.manager, answer, [t88.req, false, 'No']))?.error
    r.othersCleared = (await notices88('access_request', t88.req)).length
    r.answerNotice = (await notices88('access_answer', t88.req)).map((n) => n.recipient_user)
    const b = await j88(t88.docB, `select patient_file($1) as j`, [t88.pid])
    r.after = {
      level: b.access.level,
      via: b.access.via,
      v1: b.visits.find((v) => v.id === t88.v1).view,
      dx: (await j88(t88.docB, `select visit_clinical($1) as j`, [t88.v1])).diagnoses.length,
    }
    r.logged = (await log88(t88.pid)).filter(
      (x) => x.actor_id === t88.docB && x.via === 'request' && x.request_id === t88.req,
    ).length
    r.mine = (await j88(t88.docB, `select record_access_requests('mine') as j`)).map(
      (x) => `${x.status}:${x.active}`,
    )
    // the visit closes: the access ends
    await close88(t88.v2)
    const closed = await j88(t88.docB, `select patient_file($1) as j`, [t88.pid])
    r.closed = {
      level: closed.access.level,
      v1: closed.visits.find((v) => v.id === t88.v1).private,
      // his own visit of today stays his
      v2: closed.visits.find((v) => v.id === t88.v2).view,
      active: (await j88(t88.docB, `select record_access_requests('mine') as j`))[0]?.active,
    }
    // a refused request: the requester is told why, and may ask again
    t88.v3 = await openVisit88(t88.pid, t88.docB)
    // while the nurses hold the switch, a new request is sent to the manager and the nurse
    const req2 = (await j88(t88.docB, ask, [t88.pid, 'Follow-up of the earlier result'])).id
    const told2 = (await notices88('access_request', req2)).map((n) => n.recipient_user)
    const roles2 = (
      await db.query(`select distinct role from profiles where id = any ($1)`, [told2])
    ).rows.map((x) => x.role)
    r.notices2 = {
      manager: told2.includes(staff.manager),
      nurse: told2.includes(staff.nurse),
      head: told2.includes(t88.head),
      roles: roles2.sort(),
    }
    await role87('nurse', 'records.approve', false)
    r.nurseAfter = await mine(staff.nurse)
    r.cancel = await hintAs(t88.docC, `select cancel_record_access($1)`, [req2])
    // the manager always answers
    r.refused = (await j88(staff.manager, answer, [req2, false, 'Ask the patient first']))?.status
    r.refusedNotice = await one(
      `select params ->> 'reason' as reason, params ->> 'approved' as ok from notification where kind = 'access_answer' and params ->> 'requestId' = $1`,
      [req2],
    )
    r.canAgain = (await j88(t88.docB, `select patient_access($1) as j`, [t88.pid])).canRequest
    if (
      r.noReason !== '22023/reason_needed' ||
      r.notTreating !== '42501/not_treating' ||
      r.reception !== '42501/' ||
      r.head !== '42501/not_treating' ||
      r.again !== true ||
      r.approvers !== 1 ||
      json88(r.notices) !== json88([staff.manager]) ||
      r.pendingHead !== 0 ||
      !r.pendingManager.includes(true) ||
      r.pendingAssist !== 0 ||
      r.accessB !== 'pending' ||
      r.assistant !== '42501/not_approver' ||
      r.headAnswer !== '42501/not_approver' ||
      r.self !== '42501/not_approver' ||
      !r.headMine ||
      !r.pendingHeadOn.includes(true) ||
      r.headMineOff ||
      r.headAgain !== '42501/not_approver' ||
      r.refuseNoReason !== '22023/reason_needed' ||
      r.nurseBefore !== '42501/not_approver' ||
      !r.nurseMine ||
      !r.managerMine ||
      r.approve !== 'approved' ||
      r.late !== '22023/already_answered' ||
      r.othersCleared !== 0 ||
      json88(r.answerNotice) !== json88([t88.docB]) ||
      r.after.level !== 'full' ||
      r.after.via !== 'request' ||
      r.after.v1 !== 'request' ||
      r.after.dx !== 1 ||
      r.logged < 1 ||
      json88(r.mine) !== json88(['approved:true']) ||
      r.closed.level !== 'identity' ||
      r.closed.v1 !== true ||
      r.closed.v2 !== 'own' ||
      r.closed.active !== false ||
      !r.notices2.manager ||
      !r.notices2.nurse ||
      r.notices2.head ||
      json88(r.notices2.roles) !== json88(['manager', 'nurse']) ||
      r.nurseAfter ||
      r.cancel !== 'P0002/not_found' ||
      r.refused !== 'refused' ||
      r.refusedNotice?.reason !== 'Ask the patient first' ||
      r.refusedNotice?.ok !== 'false' ||
      r.canAgain !== true
    )
      throw new Error(json88(r))
    return 'asked with a reason → the manager told, not the head; head answers only with the right (exception), a nurse with the switch; access ended at closing; refusal says why'
  },
)
await step(
  '0088 C: emergency access: at once, with a reason; urgent notices; red log entry; the manager reviews',
  async () => {
    const em = `select emergency_record_access($1, $2) as j`
    const r = {}
    r.notTreating = (await j88(t88.docC, em, [t88.pid, 'Collapsed in the corridor']))?.error
    r.noReason = (await j88(t88.docB, em, [t88.pid, '']))?.error
    const e = await j88(t88.docB, em, [t88.pid, 'Unconscious: need past medicines'])
    t88.emergency = e.id
    r.via = e.via
    r.level = (await j88(t88.docB, `select patient_access($1) as j`, [t88.pid])).via
    r.dx = (await j88(t88.docB, `select visit_clinical($1) as j`, [t88.v1])).diagnoses.length
    r.notices = (await notices88('access_emergency', t88.emergency))
      .map(
        (n) =>
          `${n.recipient_user === staff.manager ? 'manager' : n.recipient_user === t88.head ? 'head' : 'other'}:${n.urgent}`,
      )
      .sort()
    const log = await j88(staff.manager, `select record_access_log(p_patient_id => $1) as j`, [
      t88.pid,
    ])
    r.red = log.rows.filter((x) => x.emergency && x.requestId === t88.emergency).length
    r.unreviewed = log.unreviewed
    r.reviewByDoctor = await hintAs(t88.head, `select review_emergency_access($1, 'ok')`, [
      t88.emergency,
    ])
    r.review = await hintAs(staff.manager, `select review_emergency_access($1, $2)`, [
      t88.emergency,
      'Justified: patient arrived unconscious',
    ])
    const list = await j88(staff.manager, `select record_access_requests('emergency') as j`)
    const row = list.find((x) => x.id === t88.emergency)
    r.reviewed = { by: !!row?.reviewedBy, note: row?.reviewNote, canReview: row?.canReview }
    const log2 = await j88(staff.manager, `select record_access_log(p_via => 'emergency') as j`)
    r.logReviewed = log2.rows.find((x) => x.requestId === t88.emergency)?.reviewed
    if (
      r.notTreating !== '42501/not_treating' ||
      r.noReason !== '22023/reason_needed' ||
      r.via !== 'emergency' ||
      r.level !== 'emergency' ||
      r.dx !== 1 ||
      json88(r.notices) !== json88(['manager:true']) ||
      r.red < 1 ||
      !(r.unreviewed >= 1) ||
      r.reviewByDoctor !== '42501/not_manager' ||
      r.review !== 'ok' ||
      !r.reviewed.by ||
      r.reviewed.note !== 'Justified: patient arrived unconscious' ||
      r.reviewed.canReview !== false ||
      r.logReviewed !== true
    )
      throw new Error(json88(r))
    return 'opened at once, the manager told (urgent; the head only with the right, 0095), red entry, reviewed by the manager'
  },
)
await step(
  '0088 D: the access log: once per half hour, the manager filters it, the patient file shows who looked',
  async () => {
    await asAdmin()
    const before = (await log88(t88.pid)).filter((x) => x.actor_id === t88.head).length
    await j88(t88.head, `select patient_file($1) as j`, [t88.pid])
    await j88(t88.head, `select patient_file($1) as j`, [t88.pid])
    await j88(t88.head, `select patient_results($1) as j`, [t88.pid])
    const after = (await log88(t88.pid)).filter((x) => x.actor_id === t88.head).length
    const r = { before, after }
    r.byActor = (
      await j88(staff.manager, `select record_access_log(p_actor => $1) as j`, [t88.docA])
    ).rows.map((x) => x.via)
    r.doctorLog = (await j88(t88.docB, `select record_access_log() as j`))?.error
    r.headSees = (await j88(t88.head, `select patient_access_log($1) as j`, [t88.pid])).length
    r.doctorSees = (await j88(t88.docB, `select patient_access_log($1) as j`, [t88.pid]))?.error
    r.assistantSees = (
      await j88(t88.assist, `select patient_access_log($1) as j`, [t88.pid])
    )?.error
    // nobody writes or reads the tables directly
    r.write = await codeAs(
      t88.docB,
      `insert into record_access_entry (actor_id, patient_id, via) values ($1, $2, 'manager')`,
      [t88.docB, t88.pid],
    )
    r.read = await codeAs(staff.manager, `select count(*) from record_access_request`)
    r.logFn = await codeAs(t88.docB, `select log_record_access($1, null, 'manager', 'file')`, [
      t88.pid,
    ])
    if (
      r.after !== r.before ||
      !r.byActor.length ||
      r.byActor.some((v) => v !== 'own') ||
      r.doctorLog !== '42501/' ||
      !(r.headSees >= 3) ||
      r.doctorSees !== '42501/' ||
      r.assistantSees !== '42501/' ||
      r.write !== '42501' ||
      r.read !== '42501' ||
      r.logFn !== '42501'
    )
      throw new Error(json88(r))
    return `repeat openings not logged twice; manager-only log; who looked: ${r.headSees} lines`
  },
)
await step(
  '0088 E: the clinical tables read directly give only the visits one may see',
  async () => {
    const count = async (who, table, col = 'encounter_id') =>
      valAs(who, `select count(*)::int as v from ${table} where ${col} = $1`, [t88.v1])
    const r = {
      docC: await count(t88.docC, 'condition'),
      docCobs: await count(t88.docC, 'observation'),
      docCrx: await count(t88.docC, 'medication_request'),
      docA: await count(t88.docA, 'condition'),
      head: await count(t88.head, 'condition'),
      assist: await count(t88.assist, 'condition'),
      manager: await count(staff.manager, 'condition'),
      reports: await valAs(
        t88.docC,
        `select count(*)::int as v from diagnostic_report d join service_request r on r.id = d.service_request_id where r.encounter_id = $1`,
        [t88.v1],
      ),
      reportsA: await valAs(
        t88.docA,
        `select count(*)::int as v from diagnostic_report d join service_request r on r.id = d.service_request_id where r.encounter_id = $1`,
        [t88.v1],
      ),
    }
    if (
      r.docC !== 0 ||
      r.docCobs !== 0 ||
      r.docCrx !== 0 ||
      r.docA !== 1 ||
      r.head !== 1 ||
      r.assist !== 0 ||
      r.manager !== 1 ||
      r.reports !== 0 ||
      r.reportsA !== 1
    )
      throw new Error(json88(r))
    return 'other doctor and assistant: none; the doctor who treated, the head, the manager: the rows'
  },
)
await step(
  '0088 F: level 1 cannot clear or replace the safety fields; may add one where none is recorded',
  async () => {
    await asAdmin()
    const p2 = (
      await one(
        `insert into patient (surname, given_names, sex) values ('Private', 'New 88', 'male') returning id`,
      )
    ).id
    // the patient form sends every field: the hidden ones empty
    const form = {
      surname: 'Private',
      phone_1: '0788000088',
      allergies: '',
      blood_group: '',
      notes: '',
      allergies_none: false,
    }
    const r = {}
    r.update = await hintAs(staff.receptionist, `select update_patient($1, $2)`, [
      t88.pid,
      JSON.stringify(form),
    ])
    r.kept = await one(`select allergies, blood_group, notes, phone_1 from patient where id = $1`, [
      t88.pid,
    ])
    r.replace = await hintAs(staff.receptionist, `select update_patient($1, $2)`, [
      t88.pid,
      JSON.stringify({ ...form, allergies: 'None' }),
    ])
    r.notReplaced = (await one(`select allergies from patient where id = $1`, [t88.pid])).allergies
    r.add = await hintAs(staff.receptionist, `select update_patient($1, $2)`, [
      p2,
      JSON.stringify({ ...form, allergies: 'Sulfa drugs', blood_group: 'B+' }),
    ])
    r.added = await one(`select allergies, blood_group from patient where id = $1`, [p2])
    // the doctor treating the patient now changes them
    r.doctor = await hintAs(t88.docB, `select update_patient($1, $2)`, [
      t88.pid,
      JSON.stringify({ allergies: 'Penicillin, aspirin' }),
    ])
    r.changed = (await one(`select allergies from patient where id = $1`, [t88.pid])).allergies
    if (
      r.update !== 'ok' ||
      r.kept.allergies !== 'Penicillin' ||
      r.kept.blood_group !== 'A+' ||
      !r.kept.notes ||
      r.kept.phone_1 !== '0788000088' ||
      r.replace !== 'ok' ||
      r.notReplaced !== 'Penicillin' ||
      r.add !== 'ok' ||
      r.added.allergies !== 'Sulfa drugs' ||
      r.added.blood_group !== 'B+' ||
      r.doctor !== 'ok' ||
      r.changed !== 'Penicillin, aspirin'
    )
      throw new Error(json88(r))
    return 'reception: empty fields ignored, no replacing; adds where none; the treating doctor changes them'
  },
)
await step(
  '0088 G: the visit track hides the clinical part; the lab desk reads the visit of its open test',
  async () => {
    const jr = `select visit_journey($1) as j`
    const rec = await j88(staff.receptionist, jr, [t88.v1])
    const head = await j88(t88.head, jr, [t88.v1])
    const r = {
      recPrivate: rec.private,
      recDx: rec.diagnoses.length,
      recSteps: rec.steps.length,
      recCharges: Array.isArray(rec.charges),
      headPrivate: head.private,
      headDx: head.diagnoses.length,
    }
    // a test of today's visit waits at the laboratory
    await asAdmin()
    await db.query(
      `insert into service_request (encounter_id, category, service_id, station, requester_id)
       values ($1, 'lab', $2, 'laboratory', $3)`,
      [t88.v3, t88.service, t88.docB],
    )
    r.labDesk = await deskAs(staff.lab_tech, 'laboratory')
    const lab = await j88(staff.lab_tech, `select visit_clinical($1) as j`, [t88.v3])
    r.lab = { private: lab.private, orders: lab.orders.length, allergies: lab.patient.allergies }
    r.labPast = (await j88(staff.lab_tech, `select visit_clinical($1) as j`, [t88.v1])).private
    // the doctor prints today's documents: the record and the prescription number
    r.print = (await j88(t88.docB, `select visit_clinical($1) as j`, [t88.v3])).visit?.reference
    if (
      r.recPrivate !== true ||
      r.recDx !== 0 ||
      r.recSteps < 1 ||
      !r.recCharges ||
      r.headPrivate !== false ||
      r.headDx !== 1 ||
      !r.labDesk ||
      r.lab.private !== false ||
      r.lab.orders !== 1 ||
      !r.lab.allergies ||
      r.labPast !== true ||
      !r.print
    )
      throw new Error(json88(r))
    return "reception: steps and bill only; the head: the diagnoses; the lab: today's test, not the past"
  },
)
await step(
  '0088 H: only the department the visit was sent to is in charge; another department giving the desk is not',
  async () => {
    t88.dept2 = await dept85('Consultation 88 bis', ['consultation'])
    t88.head2 = await newStaff('p88.head2', 'Dr. Head Elsewhere 88', 'doctor', 'Consultation 1')
    await member85(t88.head2, t88.dept2, 'head')
    await asAdmin()
    const r = await one(
      `select $2::uuid = any (heads_in_charge($1)) as heads, $2::uuid = any (record_access_approvers($1)) as approver,
              $3::uuid = any (visit_departments($4)) as dept2`,
      [t88.pid, t88.head2, t88.dept2, t88.v1],
    )
    r.via = await valAs(t88.head2, `select history_via($1) as v`, [t88.pid])
    const f = await j88(t88.head2, `select patient_file($1) as j`, [t88.pid])
    r.level = f.access.level
    r.canSeeLog = f.access.canSeeLog
    r.firstHead = (
      await one(`select $2::uuid = any (heads_in_charge($1)) as ok`, [t88.pid, t88.head])
    ).ok
    // a visit sent to no department: nobody's department while nobody took the patient; once
    // someone took them, that person's department (security hardening: never every department
    // giving the desk)
    const pid = (
      await one(
        `insert into patient (surname, given_names, sex) values ('Nodept', 'Visit 88', 'male') returning id`,
      )
    ).id
    const enc = (await one(`insert into encounter (patient_id) values ($1) returning id`, [pid])).id
    await db.query(
      `insert into queue_entry (encounter_id, station, ticket_no) values ($1, 'consultation', 'P88N')`,
      [enc],
    )
    const untaken = (
      await one(`select $2::uuid = any (visit_departments($1)) as ok`, [enc, t88.dept2])
    ).ok
    await db.query(`update queue_entry set taken_by = $2 where encounter_id = $1`, [enc, t88.head2])
    const taken = (
      await one(`select $2::uuid = any (visit_departments($1)) as ok`, [enc, t88.dept2])
    ).ok
    r.noDept = !untaken && taken
    if (
      r.heads ||
      r.approver ||
      r.dept2 ||
      r.via !== null ||
      r.level === 'full' ||
      r.canSeeLog ||
      !r.firstHead ||
      !r.noDept
    )
      throw new Error(json88(r))
    return 'the other head of a consultation department: not in charge, no approval, no history'
  },
)
await step(
  "0088 I: 'own' is for the people who treated a closed visit; measuring, a lab result do not open it",
  async () => {
    await asAdmin()
    // the lab technician validated the past visit's result; the triage nurse measured its vitals
    await db.query(
      `update diagnostic_report d set created_by = $2, verified_by = $2
       from service_request r where r.id = d.service_request_id and r.encounter_id = $1`,
      [t88.v1, staff.lab_tech],
    )
    await db.query(
      `insert into observation (encounter_id, code, value_num, unit, performer_id, created_by)
       values ($1, 'bp_dia', 96, 'mmHg', $2, $2)`,
      [t88.v1, staff.nurse],
    )
    const vv = `select visit_view($1) as v`
    const r = {
      lab: await valAs(staff.lab_tech, vv, [t88.v1]),
      nurse: await valAs(staff.nurse, vv, [t88.v1]),
      docA: await valAs(t88.docA, vv, [t88.v1]),
      labDx: await valAs(
        staff.lab_tech,
        `select count(*)::int as v from condition where encounter_id = $1`,
        [t88.v1],
      ),
    }
    if (r.lab !== null || r.nurse !== null || r.docA !== 'own' || r.labDx !== 0)
      throw new Error(json88(r))
    return 'the lab technician and the nurse who measured: private; the doctor who treated: own'
  },
)
await step(
  '0088 J: past vital signs: visit_vitals and the patient file; reception sees the open visit only',
  async () => {
    await asAdmin()
    await db.query(
      `insert into observation (encounter_id, code, value_num, unit, performer_id, created_by)
       values ($1, 'bp_sys', 131, 'mmHg', $2, $3)`,
      [t88.v3, staff.nurse, staff.receptionist],
    )
    const vv = `select count(*)::int as v from visit_vitals where encounter_id = $1`
    const rec = await j88(staff.receptionist, `select patient_file($1) as j`, [t88.pid])
    const r = {
      docC: await valAs(t88.docC, vv, [t88.v1]),
      docA: await valAs(t88.docA, vv, [t88.v1]),
      recPast: await valAs(staff.receptionist, vv, [t88.v1]),
      recOpen: await valAs(staff.receptionist, vv, [t88.v3]),
      fileOpen: rec.vitals.some((v) => v.encounterId === t88.v3 && Number(v.value) === 131),
      filePast: rec.vitals.some((v) => v.encounterId === t88.v1),
    }
    if (
      r.docC !== 0 ||
      !(r.docA > 0) ||
      r.recPast !== 0 ||
      !(r.recOpen > 0) ||
      !r.fileOpen ||
      r.filePast
    )
      throw new Error(json88(r))
    return "past vitals: none for Dr C or reception, the doctor who treated sees them; today's for reception"
  },
)
await step(
  '0088 K: the tables read directly give no safety field, triage reason or referral note',
  async () => {
    const r = {
      allergies: await codeAs(t88.docB, `select allergies from patient limit 1`),
      flags: await codeAs(staff.receptionist, `select flags from patient limit 1`),
      star: await codeAs(t88.docB, `select * from patient limit 1`),
      triage: await codeAs(t88.docB, `select triage_reason from encounter limit 1`),
      referral: await codeAs(t88.docB, `select referral_note from queue_entry limit 1`),
      identity: await valAs(
        staff.receptionist,
        `select surname || ' ' || file_number as v from patient where id = $1`,
        [t88.pid],
      ),
      visit: await valAs(
        staff.receptionist,
        `select status::text as v from encounter where id = $1`,
        [t88.v1],
      ),
      board: await valAs(
        staff.receptionist,
        `select count(*)::int as v from queue_board where encounter_id = $1`,
        [t88.v3],
      ),
      boardCashier: await codeAs(
        staff.cashier,
        `select referral_note, taken_by_name from queue_board limit 5`,
      ),
      // the patient search: the allergy mark for those who read clinical records
      searchRec: (
        await j88(staff.receptionist, `select patients_list('Private Record 88') as j`)
      ).rows.find((x) => x.id === t88.pid)?.hasAllergies,
      searchDoc: (await j88(t88.docC, `select patients_list('Private Record 88') as j`)).rows.find(
        (x) => x.id === t88.pid,
      )?.hasAllergies,
    }
    if (
      r.allergies !== '42501' ||
      r.flags !== '42501' ||
      r.star !== '42501' ||
      r.triage !== '42501' ||
      r.referral !== '42501' ||
      !r.identity?.startsWith('Private ') ||
      r.visit !== 'closed' ||
      !(r.board >= 1) ||
      r.boardCashier !== null ||
      r.searchRec !== false ||
      r.searchDoc !== true
    )
      throw new Error(json88(r))
    return 'safety fields, triage reason, referral note refused; identity, visits and the queue read'
  },
)
await step(
  '0088 L: the safety summary is for the people treating: not the cashier or reception holding the patient',
  async () => {
    await asAdmin()
    const pid = (
      await one(
        `insert into patient (surname, given_names, sex, allergies) values ('Cashier', 'Wait 88', 'female', 'Latex') returning id`,
      )
    ).id
    const enc = (await one(`insert into encounter (patient_id) values ($1) returning id`, [pid])).id
    await db.query(
      `insert into queue_entry (encounter_id, station, ticket_no) values ($1, 'cashier', 'C88'), ($1, 'reception', 'R88')`,
      [enc],
    )
    const cash = await j88(staff.cashier, `select patient_file($1) as j`, [pid])
    const rec = await j88(staff.receptionist, `select patient_file($1) as j`, [pid])
    const r = {
      cashier: `${cash.access.level}:${cash.summary}`,
      reception: `${rec.access.level}:${rec.summary}`,
      cashierAllergies: cash.patient.allergies,
    }
    if (
      r.cashier !== 'identity:null' ||
      r.reception !== 'identity:null' ||
      r.cashierAllergies !== null
    )
      throw new Error(json88(r))
    return 'the cashier and reception holding the patient: identity, no summary'
  },
)
await step(
  '0088 M: the analytics of a colleague hide what was written in visits one may not see',
  async () => {
    const detail = `select staff_activity_detail($1, null, null, 'diagnoses') as j`
    const pick = (j) =>
      (j?.records ?? []).filter((x) => x.encounterId === t88.v1).map((x) => x.what ?? null)
    const r = {
      assistant: pick(await j88(t88.assist, detail, [t88.docA])),
      head: pick(await j88(t88.head, detail, [t88.docA])),
      manager: pick(await j88(staff.manager, detail, [t88.docA])),
    }
    if (
      !r.assistant.length ||
      r.assistant.some((w) => w !== null) ||
      !r.head.some((w) => w && /hypertension/i.test(w)) ||
      !r.manager.some((w) => w && /hypertension/i.test(w))
    )
      throw new Error(json88(r))
    return 'assistant: the diagnosis hidden; the head in charge and the manager: shown'
  },
)
await step(
  '0088 N: a request waiting when the visit closes is cancelled, its notices removed; the rules are not callable',
  async () => {
    await asAdmin()
    const pid = (
      await one(
        `insert into patient (surname, given_names, sex) values ('Closing', 'Request 88', 'male') returning id`,
      )
    ).id
    const enc = await openVisit88(pid, t88.docC)
    const req = (
      await j88(t88.docC, `select request_record_access($1, $2) as j`, [pid, 'Earlier treatment'])
    ).id
    const before = (await notices88('access_request', req)).length
    await close88(enc)
    const r = {
      before,
      status: (await one(`select status from record_access_request where id = $1`, [req])).status,
      after: (await notices88('access_request', req)).length,
      tookPart: await codeAs(t88.docB, `select took_part($1, $2)`, [t88.v1, t88.docA]),
      heads: await codeAs(t88.docB, `select heads_in_charge($1)`, [t88.pid]),
      level: await codeAs(t88.docB, `select patient_level($1)`, [t88.pid]),
      viewOk: await codeAs(t88.docB, `select visit_view($1)`, [t88.v1]),
    }
    if (
      !(r.before >= 1) ||
      r.status !== 'cancelled' ||
      r.after !== 0 ||
      r.tookPart !== '42501' ||
      r.heads !== '42501' ||
      r.level !== '42501' ||
      r.viewOk !== null
    )
      throw new Error(json88(r))
    return `request cancelled at closing, ${r.before} notices removed; the rule helpers refused`
  },
)

// ---------------------------------------------------------------- 0089 supporting files
const t89 = {}
/** A storage path of the visit: <patient>/<visit>/<file>.<ext>. */
const path89 = (pid, enc, ext = 'jpg') => `${pid}/${enc}/${crypto.randomUUID()}.${ext}`
/** attach_file as someone: the file's json, or { error: 'code/hint' }. */
const attach89 = (who, o) =>
  j88(who, `select attach_file($1, $2, $3, $4, $5, $6, $7, $8) as j`, [
    o.enc,
    o.path ?? path89(o.pid ?? t89.pid, o.enc, o.ext ?? 'jpg'),
    o.kind ?? 'photo',
    o.title ?? 'Wound photo',
    o.mime ?? 'image/jpeg',
    o.size ?? 250000,
    o.sr ?? null,
    o.note ?? null,
  ])
/** A boolean rule as someone with an approved session (true) or a session without approval. */
const rule89 = async (who, sql, params, approved = true) => {
  if (approved) await asApproved(who)
  else await as(who)
  try {
    return (await one(sql, params)).b
  } finally {
    await asAdmin()
  }
}
await step(
  '0089 seed: a patient with a past visit (Dr A) and an open one (Dr B, an ultrasound asked)',
  async () => {
    t89.usDept = await dept85('Ultrasound 89', ['ultrasound'])
    t89.labDept = await dept85('Laboratory 89', ['laboratory'])
    t89.sono = await newStaff('p89.sono', 'Sono 89', 'sonographer')
    t89.lab = await newStaff('p89.lab', 'Lab 89', 'lab_tech')
    await member85(t89.sono, t89.usDept)
    await member85(t89.lab, t89.labDept)
    await asAdmin()
    t89.pid = (
      await one(
        `insert into patient (surname, given_names, sex) values ('Files', 'Patient 89', 'female') returning id`,
      )
    ).id
    t89.other = (
      await one(
        `insert into patient (surname, given_names, sex) values ('Other', 'Patient 89', 'male') returning id`,
      )
    ).id
    // the past visit: Dr A adds a referral letter while it is open, then it closes
    t89.v1 = await openVisit88(t89.pid, t88.docA)
    const f1 = await attach89(t88.docA, {
      enc: t89.v1,
      kind: 'referral',
      title: 'Referral letter from Kiziguro',
      mime: 'application/pdf',
      ext: 'pdf',
      size: 480000,
    })
    if (f1.error) throw new Error(`Dr A could not attach: ${f1.error}`)
    t89.f1 = f1
    await close88(t89.v1)
    // today: Dr B treats the patient and asks for an ultrasound
    t89.v2 = await openVisit88(t89.pid, t88.docB)
    await asAdmin()
    t89.sr = (
      await one(
        `insert into service_request (encounter_id, category, service_id, station, requester_id)
         values ($1, 'imaging', $2, 'ultrasound', $3) returning id`,
        [t89.v2, t88.service, t88.docB],
      )
    ).id
    t89.otherVisit = await openVisit88(t89.other, t88.docB)
    t89.otherSr = (
      await one(
        `insert into service_request (encounter_id, category, service_id, station, requester_id)
         values ($1, 'imaging', $2, 'ultrasound', $3) returning id`,
        [t89.otherVisit, t88.service, t88.docB],
      )
    ).id
    return `past visit with a referral letter (${f1.mimeType}, view ${f1.view}); open visit with an ultrasound asked`
  },
)
await step(
  '0089 A: who adds a file: the people working on the open visit, the ultrasound desk on its test; the limits',
  async () => {
    const r = {}
    const b = await attach89(t88.docB, { enc: t89.v2, title: 'Rash on the arm', note: 'Day 2' })
    t89.fB = b
    r.docB = {
      error: b.error,
      view: b.view,
      canRemove: b.canRemove,
      kind: b.kind,
      by: b.uploadedBy,
    }
    const s = await attach89(t89.sono, {
      enc: t89.v2,
      sr: t89.sr,
      kind: 'ultrasound',
      title: 'Abdominal ultrasound image',
      mime: 'image/png',
      ext: 'png',
    })
    t89.fS = s
    r.sono = { error: s.error, test: s.test, sr: s.serviceRequestId === t89.sr }
    await asAdmin()
    r.notice = (
      await db.query(
        `select recipient_user, link, params ->> 'title' as title from notification
         where kind = 'file_attached' and params ->> 'fileId' = $1`,
        [s.id ?? ''],
      )
    ).rows
    r.noticeForB = (
      await db.query(
        `select count(*)::int as n from notification where kind = 'file_attached' and params ->> 'fileId' = $1`,
        [b.id ?? ''],
      )
    ).rows[0].n
    r.reception = (await attach89(staff.receptionist, { enc: t89.v2 })).error
    r.cashier = (await attach89(staff.cashier, { enc: t89.v2 })).error
    r.docC = (await attach89(t88.docC, { enc: t89.v2 })).error
    r.labNoTest = (await attach89(t89.lab, { enc: t89.v2 })).error
    r.sonoOtherTest = (await attach89(t89.sono, { enc: t89.v2, sr: t89.otherSr })).error
    r.gif = (await attach89(t88.docB, { enc: t89.v2, mime: 'image/gif', ext: 'gif' })).error
    r.big = (await attach89(t88.docB, { enc: t89.v2, size: 10485761 })).error
    r.pdfAsJpg = (
      await attach89(t88.docB, { enc: t89.v2, mime: 'application/pdf', ext: 'jpg' })
    ).error
    r.otherPatientPath = (
      await attach89(t88.docB, { enc: t89.v2, path: path89(t89.other, t89.v2) })
    ).error
    r.otherVisitPath = (
      await attach89(t88.docB, { enc: t89.v2, path: path89(t89.pid, t89.v1) })
    ).error
    r.badPath = (await attach89(t88.docB, { enc: t89.v2, path: '../../etc/passwd' })).error
    r.noTitle = (await attach89(t88.docB, { enc: t89.v2, title: '  ' })).error
    r.kind = (await attach89(t88.docB, { enc: t89.v2, kind: 'xray' })).error
    r.closed = (await attach89(t88.docA, { enc: t89.v1 })).error
    r.again = (await attach89(t88.docB, { enc: t89.v2, path: b.path })).error
    r.manager = (
      await attach89(staff.manager, { enc: t89.v2, kind: 'other', title: 'Consent' })
    ).error
    if (
      r.docB.error ||
      r.docB.view !== 'visit' ||
      r.docB.canRemove !== true ||
      r.docB.kind !== 'photo' ||
      r.docB.by !== 'Dr. Now 88' ||
      r.sono.error ||
      !r.sono.sr ||
      !r.sono.test ||
      r.notice.length !== 1 ||
      r.notice[0].recipient_user !== t88.docB ||
      r.notice[0].link !== `/app/visit?encounter=${t89.v2}` ||
      r.noticeForB !== 0 ||
      r.reception !== '42501/not_on_visit' ||
      r.cashier !== '42501/not_on_visit' ||
      r.docC !== '42501/not_on_visit' ||
      r.labNoTest !== '42501/not_on_visit' ||
      r.sonoOtherTest !== '22023/wrong_test' ||
      r.gif !== '22023/file_type' ||
      r.big !== '22023/file_too_big' ||
      r.pdfAsJpg !== '22023/file_path' ||
      r.otherPatientPath !== '22023/file_path' ||
      r.otherVisitPath !== '22023/file_path' ||
      r.badPath !== '22023/file_path' ||
      r.noTitle !== '22023/title_needed' ||
      r.kind !== '22023/file_kind' ||
      r.closed !== '22023/file_visit_closed' ||
      r.again !== '23505/' ||
      r.manager
    )
      throw new Error(json88(r))
    return 'Dr B, the ultrasound desk (requester told) and the manager add; reception, cashier, Dr C, the laboratory refused; type, size, path, title checked'
  },
)
await step(
  '0089 B: who sees the files: the privacy levels (open visit: level 3, past visit: level 4); opening a past file is logged',
  async () => {
    const list = `select list_patient_files($1) as j`
    const seen = async (who) => {
      const j = await j88(who, list, [t89.pid])
      if (j.error) return j.error
      return {
        files: j.files.length,
        hidden: j.hidden,
        attachTo: j.attachTo,
        titles: j.files.map((f) => f.title).sort(),
      }
    }
    const r = {}
    r.docB = await seen(t88.docB)
    r.docA = await seen(t88.docA)
    r.head = await seen(t88.head)
    r.assistant = await seen(t88.assist)
    r.reception = await seen(staff.receptionist)
    r.manager = await seen(staff.manager)
    r.sono = await seen(t89.sono)
    const vs = await j88(t89.sono, `select list_visit_files($1, $2) as j`, [t89.v2, t89.sr])
    r.sonoTest = { files: vs.files?.length, canAttach: vs.canAttach, max: vs.maxBytes }
    const vc = await j88(t88.docC, `select list_visit_files($1) as j`, [t89.v2])
    r.docCVisit = { files: vc.files?.length, hidden: vc.hidden, canAttach: vc.canAttach }
    const open = `select file_open($1) as j`
    r.openBpast = (await j88(t88.docB, open, [t89.f1.id])).error
    r.openRecPast = (await j88(staff.receptionist, open, [t89.fB.id])).error
    const a = await j88(t88.docA, open, [t89.f1.id])
    r.openA = { path: a.path === t89.f1.path, expires: a.expiresIn, bucket: a.bucket }
    r.openBtoday = (await j88(t88.docB, open, [t89.fB.id])).path === t89.fB.path
    r.openHead = !!(await j88(t88.head, open, [t89.f1.id])).path
    r.openMissing = (await j88(t88.docB, open, [crypto.randomUUID()])).error
    r.log = (await log88(t89.pid)).filter((x) => x.what === 'attachment').map((x) => x.via)
    if (
      r.docB.files !== 3 ||
      r.docB.hidden !== 1 ||
      r.docB.attachTo !== t89.v2 ||
      r.docA.files !== 1 ||
      r.docA.titles[0] !== 'Referral letter from Kiziguro' ||
      r.docA.hidden !== 3 ||
      r.docA.attachTo !== null ||
      r.head.files !== 4 ||
      r.head.hidden !== 0 ||
      r.assistant.files !== 0 ||
      r.assistant.hidden !== 4 ||
      r.reception.files !== 0 ||
      r.reception.hidden !== 4 ||
      r.reception.attachTo !== null ||
      r.manager.files !== 4 ||
      r.manager.attachTo !== t89.v2 ||
      r.sono.files !== 3 ||
      r.sono.hidden !== 1 ||
      r.sonoTest.files !== 1 ||
      r.sonoTest.canAttach !== true ||
      r.sonoTest.max !== 10485760 ||
      r.docCVisit.files !== 0 ||
      r.docCVisit.hidden !== 3 ||
      r.docCVisit.canAttach !== false ||
      r.openBpast !== '42501/private' ||
      r.openRecPast !== '42501/private' ||
      !r.openA.path ||
      r.openA.expires !== 300 ||
      r.openA.bucket !== 'patient-files' ||
      !r.openBtoday ||
      !r.openHead ||
      r.openMissing !== 'P0002/not_found' ||
      !r.log.includes('own') ||
      !r.log.includes('head') ||
      r.log.includes('visit')
    )
      throw new Error(json88(r))
    return `Dr B sees today's 3 of 4 (past private); Dr A his past file; head and manager all; reception none; log: ${r.log.join(', ')}`
  },
)
await step(
  '0089 C: the Storage rules: an approved session, a visit one may add to, a file one may see; no overwrite',
  async () => {
    const ins = `select file_object_insert_ok($1) as b`
    const read = `select file_object_read_ok($1) as b`
    const del = `select file_object_delete_ok($1) as b`
    const fresh = path89(t89.pid, t89.v2)
    const r = {}
    r.insB = await rule89(t88.docB, ins, [fresh])
    r.insBnoApproval = await rule89(t88.docB, ins, [fresh], false)
    r.insRec = await rule89(staff.receptionist, ins, [fresh])
    r.insC = await rule89(t88.docC, ins, [fresh])
    r.insPast = await rule89(t88.docA, ins, [path89(t89.pid, t89.v1)])
    r.insWrongPatient = await rule89(t88.docB, ins, [path89(t89.other, t89.v2)])
    r.insBadName = await rule89(t88.docB, ins, [`${t89.pid}/${t89.v2}/photo.jpg`])
    r.insExe = await rule89(t88.docB, ins, [path89(t89.pid, t89.v2, 'exe')])
    r.insRegistered = await rule89(t88.docB, ins, [t89.fB.path])
    r.readB = await rule89(t88.docB, read, [t89.fB.path])
    r.readBpast = await rule89(t88.docB, read, [t89.f1.path])
    r.readBnoApproval = await rule89(t88.docB, read, [t89.fB.path], false)
    r.readA = await rule89(t88.docA, read, [t89.f1.path])
    r.readRec = await rule89(staff.receptionist, read, [t89.fB.path])
    r.readPending = await rule89(t88.docB, read, [fresh])
    r.readPendingC = await rule89(t88.docC, read, [fresh])
    r.delLive = await rule89(t88.docB, del, [t89.fB.path])
    r.delPending = await rule89(t88.docB, del, [fresh])
    // the table is read through the functions only
    r.table = await codeAs(t88.docB, `select * from patient_file_doc`)
    r.helper = await codeAs(t88.docB, `select files_list($1, null, null)`, [t89.pid])
    r.anon = await codeAs(null, `select list_patient_files($1)`, [t89.pid])
    if (
      r.insB !== true ||
      r.insBnoApproval !== false ||
      r.insRec !== false ||
      r.insC !== false ||
      r.insPast !== false ||
      r.insWrongPatient !== false ||
      r.insBadName !== false ||
      r.insExe !== false ||
      r.insRegistered !== false ||
      r.readB !== true ||
      r.readBpast !== false ||
      r.readBnoApproval !== false ||
      r.readA !== true ||
      r.readRec !== false ||
      r.readPending !== true ||
      r.readPendingC !== false ||
      r.delLive !== false ||
      r.delPending !== true ||
      r.table !== '42501' ||
      r.helper !== '42501' ||
      r.anon !== '42501'
    )
      throw new Error(json88(r))
    return 'send, read and delete follow the visit and the levels; no approved session: nothing'
  },
)
await step(
  '0089 D: removing a file: the uploader within 24 hours or the manager, with a reason; kept and audited',
  async () => {
    const rm = `select remove_file($1, $2) as j`
    const r = {}
    r.docC = (await j88(t88.docC, rm, [t89.fB.id, 'Wrong patient']))?.error
    r.noReason = (await j88(t88.docB, rm, [t89.fB.id, ' ']))?.error
    const ok = await j88(t88.docB, rm, [t89.fB.id, 'Wrong patient'])
    r.ok = { error: ok.error, path: ok.path === t89.fB.path }
    r.again = (await j88(t88.docB, rm, [t89.fB.id, 'Wrong patient']))?.error
    r.listB = (await j88(t88.docB, `select list_patient_files($1) as j`, [t89.pid])).files.map(
      (f) => f.id,
    )
    const m = await j88(staff.manager, `select list_patient_files($1) as j`, [t89.pid])
    const mf = m.files.find((f) => f.id === t89.fB.id)
    r.manager = { removed: mf?.removed, reason: mf?.removeReason, by: mf?.removedBy }
    r.openRemoved = (await j88(t88.docB, `select file_open($1) as j`, [t89.fB.id]))?.error
    const del = `select file_object_delete_ok($1) as b`
    r.delB = await rule89(t88.docB, del, [t89.fB.path])
    r.delC = await rule89(t88.docC, del, [t89.fB.path])
    // the remover still reads it (Postgres deletes only rows it may read); nobody else
    r.readB = await rule89(t88.docB, `select file_object_read_ok($1) as b`, [t89.fB.path])
    r.readHead = await rule89(t88.head, `select file_object_read_ok($1) as b`, [t89.fB.path])
    // the ultrasound image, added more than 24 hours ago: only the manager removes it now
    await asAdmin()
    await db.query(
      `update patient_file_doc set uploaded_at = now() - interval '25 hours' where id = $1`,
      [t89.fS.id],
    )
    r.late = (await j88(t89.sono, rm, [t89.fS.id, 'Blurred image']))?.error
    r.sonoCanRemove = (
      await j88(t89.sono, `select list_visit_files($1) as j`, [t89.v2])
    ).files.find((f) => f.id === t89.fS.id)?.canRemove
    r.byManager = (await j88(staff.manager, rm, [t89.fS.id, 'Blurred image']))?.error ?? null
    r.delManager = await rule89(staff.manager, del, [t89.fS.path])
    await asAdmin()
    r.audit = await one(
      `select count(*) filter (where action = 'create')::int as created,
                count(*) filter (where action = 'delete' and reason is not null)::int as removed
         from audit_event where entity = 'patient_file_doc' and entity_id = any($1::uuid[])`,
      [[t89.fB.id, t89.fS.id]],
    )
    if (
      r.docC !== '42501/not_uploader' ||
      r.noReason !== '22023/reason_needed' ||
      r.ok.error ||
      !r.ok.path ||
      r.again !== '22023/already_removed' ||
      r.listB.includes(t89.fB.id) ||
      r.manager.removed !== true ||
      r.manager.reason !== 'Wrong patient' ||
      r.manager.by !== 'Dr. Now 88' ||
      r.openRemoved !== 'P0002/not_found' ||
      r.delB !== true ||
      r.delC !== false ||
      r.readB !== true ||
      r.readHead !== false ||
      r.late !== '42501/remove_too_late' ||
      r.sonoCanRemove !== false ||
      r.byManager !== null ||
      r.delManager !== true ||
      r.audit.created !== 2 ||
      r.audit.removed !== 2
    )
      throw new Error(json88(r))
    return 'Dr C refused; Dr B removed with a reason (kept, the manager sees why); after 24 h only the manager; audited'
  },
)

await step(
  '0089 E: with a Storage schema (stub of Supabase): the bucket, its policies, registering checks the file arrived',
  async () => {
    await asAdmin()
    // just enough of Supabase Storage for the migration's guarded part
    await db.exec(`
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key, name text not null, public boolean default false,
        file_size_limit bigint, allowed_mime_types text[]);
      create table if not exists storage.objects (
        id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
        name text not null, owner uuid default auth.uid(), metadata jsonb, unique (bucket_id, name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated;
      grant select, insert, update, delete on storage.objects to authenticated;
    `)
    await db.exec(
      await readFile(path.join(migrationsDir, '20261201090000_supporting_files.sql'), 'utf8'),
    )
    const r = {}
    r.bucket = await one(
      `select public, file_size_limit::int as max, allowed_mime_types as types from storage.buckets where id = 'patient-files'`,
    )
    r.policies = (
      await db.query(
        `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1`,
      )
    ).rows.map((x) => x.policyname)
    const put = async (who, name, size = 120000, mime = 'image/jpeg') => {
      await asApproved(who)
      try {
        await db.query(
          `insert into storage.objects (bucket_id, name, metadata) values ('patient-files', $1, $2)`,
          [name, JSON.stringify({ size, mimetype: mime })],
        )
        return null
      } catch (e) {
        return e.code ?? String(e.message)
      } finally {
        await asAdmin()
      }
    }
    const fresh = path89(t89.pid, t89.v2)
    r.putC = await put(t88.docC, fresh)
    r.putB = await put(t88.docB, fresh, 90000)
    // registering: the file must be there; the size is the one Storage holds
    r.missing = (await attach89(t88.docB, { enc: t89.v2, path: path89(t89.pid, t89.v2) })).error
    const ok = await attach89(t88.docB, { enc: t89.v2, path: fresh, size: 1 })
    r.ok = { error: ok.error, size: ok.sizeBytes }
    const big = path89(t89.pid, t89.v2)
    r.putBig = await put(t88.docB, big, 20000000)
    r.bigRegistered = (await attach89(t88.docB, { enc: t89.v2, path: big })).error
    const sees = async (who) => {
      await asApproved(who)
      try {
        return (
          await one(`select count(*)::int as n from storage.objects where name = $1`, [fresh])
        ).n
      } finally {
        await asAdmin()
      }
    }
    r.seeB = await sees(t88.docB)
    r.seeA = await sees(t88.docA)
    r.seeRec = await sees(staff.receptionist)
    // no approved session: nothing
    await as(t88.docB)
    r.seeBnoApproval = (
      await one(`select count(*)::int as n from storage.objects where name = $1`, [fresh])
    ).n
    await asAdmin()
    const drop = async (who, name) => {
      await asApproved(who)
      try {
        return (await db.query(`delete from storage.objects where name = $1 returning id`, [name]))
          .rows.length
      } finally {
        await asAdmin()
      }
    }
    r.dropLive = await drop(t88.docB, fresh)
    await j88(t88.docB, `select remove_file($1, $2) as j`, [ok.id, 'Duplicate photo'])
    r.dropRemoved = await drop(t88.docB, fresh)
    r.dropUnregistered = await drop(t88.docB, big)
    if (
      r.bucket?.public !== false ||
      r.bucket?.max !== 10485760 ||
      r.bucket?.types?.length !== 4 ||
      r.policies.join(',') !== 'patient_files_delete,patient_files_insert,patient_files_select' ||
      r.putC !== '42501' ||
      r.putB !== null ||
      r.missing !== '22023/not_uploaded' ||
      r.ok.error ||
      r.ok.size !== 90000 ||
      r.putBig !== null ||
      r.bigRegistered !== '22023/file_too_big' ||
      r.seeB !== 1 ||
      r.seeA !== 0 ||
      r.seeRec !== 0 ||
      r.seeBnoApproval !== 0 ||
      r.dropLive !== 0 ||
      r.dropRemoved !== 1 ||
      r.dropUnregistered !== 1
    )
      throw new Error(json88(r))
    return 'private bucket (10 MB, 4 types), 3 policies; sending, reading and deleting follow the rules'
  },
)

await step(
  '0089 F: a past file is read only after a logged opening; the uploader keeps 24 h; a copy left in storage',
  async () => {
    const read = `select file_object_read_ok($1) as b`
    const del = `select file_object_delete_ok($1) as b`
    const open = `select file_open($1) as j`
    // the storage stub of 0089 E is still here: a file is put before it is registered
    const put = async (who, name, mime = 'image/jpeg') => {
      await asApproved(who)
      try {
        await db.query(
          `insert into storage.objects (bucket_id, name, metadata) values ('patient-files', $1, $2)`,
          [name, JSON.stringify({ size: 64000, mimetype: mime })],
        )
      } finally {
        await asAdmin()
      }
    }
    const r = {}
    // 1. Dr A's past file: no 'attachment' line, no read; file_open writes it, then the read works
    await asAdmin()
    await db.query(
      `delete from record_access_entry where actor_id = $1 and patient_id = $2 and what = 'attachment'`,
      [t88.docA, t89.pid],
    )
    r.readBefore = await rule89(t88.docA, read, [t89.f1.path])
    r.open = (await j88(t88.docA, open, [t89.f1.id])).path === t89.f1.path
    r.readAfter = await rule89(t88.docA, read, [t89.f1.path])
    // 2. the manager opens the past visit, then its file: two lines, not one
    await j88(staff.manager, `select visit_clinical($1) as j`, [t89.v1])
    await j88(staff.manager, open, [t89.f1.id])
    await asAdmin()
    r.managerLog = (
      await db.query(
        `select what from record_access_entry where actor_id = $1 and encounter_id = $2 order by what`,
        [staff.manager, t89.v1],
      )
    ).rows.map((x) => x.what)
    // 3. the ultrasound adds an image to the other patient's test; the visit closes: the
    // sonographer still sees it (24 h, 'own'), opens it and may remove it; Dr C never
    const sPath = path89(t89.other, t89.otherVisit, 'png')
    await put(t89.sono, sPath, 'image/png')
    const s = await attach89(t89.sono, {
      pid: t89.other,
      enc: t89.otherVisit,
      path: sPath,
      sr: t89.otherSr,
      kind: 'ultrasound',
      title: 'Pelvic ultrasound image',
      mime: 'image/png',
    })
    r.sonoAttach = s.error ?? null
    await close88(t89.otherVisit)
    const sl = await j88(t89.sono, `select list_patient_files($1) as j`, [t89.other])
    const sf = sl.files?.find((f) => f.id === s.id)
    r.sonoAfterClose = { view: sf?.view, canRemove: sf?.canRemove }
    r.sonoOpen = (await j88(t89.sono, open, [s.id])).path === sPath
    r.sonoRead = await rule89(t89.sono, read, [sPath])
    r.docCOpen = (await j88(t88.docC, open, [s.id])).error
    r.sonoRemove =
      (await j88(t89.sono, `select remove_file($1, $2) as j`, [s.id, 'Wrong side'])).error ?? null
    // 4. Dr B removes a file but its copy stays in storage: the manager sees it is left; Dr B may
    // delete it for 15 minutes only, the manager at any time
    const bPath = path89(t89.pid, t89.v2)
    await put(t88.docB, bPath)
    const b = await attach89(t88.docB, { enc: t89.v2, path: bPath, title: 'Second wound photo' })
    r.bAttach = b.error ?? null
    await j88(t88.docB, `select remove_file($1, $2) as j`, [b.id, 'Blurred photo'])
    const left = async () =>
      (await j88(staff.manager, `select list_patient_files($1) as j`, [t89.pid])).files?.find(
        (f) => f.id === b.id,
      )?.storageLeft
    r.leftBefore = await left()
    r.delBNow = await rule89(t88.docB, del, [bPath])
    await asAdmin()
    await db.query(
      `update patient_file_doc set removed_at = now() - interval '20 minutes' where id = $1`,
      [b.id],
    )
    r.delBLate = await rule89(t88.docB, del, [bPath])
    r.readBLate = await rule89(t88.docB, read, [bPath])
    r.delManager = await rule89(staff.manager, del, [bPath])
    await asApproved(staff.manager)
    try {
      r.dropped = (
        await db.query(`delete from storage.objects where name = $1 returning id`, [bPath])
      ).rows.length
    } finally {
      await asAdmin()
    }
    r.leftAfter = await left()
    if (
      r.readBefore !== false ||
      !r.open ||
      r.readAfter !== true ||
      r.managerLog.join(',') !== 'attachment,visit' ||
      r.sonoAttach ||
      r.sonoAfterClose.view !== 'own' ||
      r.sonoAfterClose.canRemove !== true ||
      !r.sonoOpen ||
      r.sonoRead !== true ||
      r.docCOpen !== '42501/private' ||
      r.sonoRemove ||
      r.bAttach ||
      r.leftBefore !== true ||
      r.delBNow !== true ||
      r.delBLate !== false ||
      r.readBLate !== false ||
      r.delManager !== true ||
      r.dropped !== 1 ||
      r.leftAfter !== false
    )
      throw new Error(json88(r))
    return 'read after the logged opening only; visit + attachment logged; uploader 24 h; the manager finishes a removal'
  },
)

// ---------------------------------------------------------------- 0088: hand one patient over to a colleague
// Dr. A has the patient at Consultation (department Handover 88 gives it, with Dr. B). Dr. C works
// in no department that gives consultation; the pharmacist serves another desk.
const t88h = {}
const json88h = (x) => JSON.stringify(x)
/** The open consultation queue entry of a visit (as the database). */
const q88h = async (enc) => {
  await asAdmin()
  return one(
    `select id, assigned_to, taken_by, started_at, return_to from queue_entry
     where encounter_id = $1 and station = 'consultation' and finished_at is null`,
    [enc],
  )
}
const newVisit88h = async (given, doctor) => {
  const pid = await patient85(given)
  await as(staff.receptionist)
  const enc = (await one(`select open_encounter($1, 'opd', 'reception', null) as id`, [pid])).id
  await db.query(
    `select refer_patient($1, 'reception', 'consultation', $2, 'for the doctor', false)`,
    [enc, doctor],
  )
  const q = await q88h(enc)
  await as(doctor)
  await db.query(`select take_patient($1)`, [q.id])
  await asAdmin()
  return enc
}
const lastNotice88h = async (who, kind) => {
  await asAdmin()
  return one(
    `select params, urgent, link from notification where recipient_user = $1 and kind = $2
     order by created_at desc limit 1`,
    [who, kind],
  )
}
await step(
  '0088 A: hand over: only who has the patient, only to a colleague of the desk, with a note',
  async () => {
    t88h.dep = await dept85('Handover 88', ['consultation'])
    t88h.a = await newStaff('doc.a88', 'Dr. Handover A 88', 'doctor', 'Consultation 4')
    t88h.b = await newStaff('doc.b88', 'Dr. Handover B 88', 'doctor', 'Consultation 5')
    t88h.c = await newStaff('doc.c88', 'Dr. Handover C 88', 'doctor', 'Consultation 6')
    await member85(t88h.a, t88h.dep)
    await member85(t88h.b, t88h.dep)
    t88h.enc = await newVisit88h('Handover 88', t88h.a)
    const ho = (who, to, note = 'Going to theatre; results of the RDT pending') =>
      hintAs(who, `select handover_patient($1, $2, $3)`, [t88h.enc, to, note])
    const r = {}
    r.notHolder = await ho(t88h.b, t88h.a)
    r.nonColleague = await ho(t88h.a, t88h.c)
    r.pharmacist = await ho(t88h.a, staff.pharmacist)
    r.self = await ho(t88h.a, t88h.a)
    r.noNote = await ho(t88h.a, t88h.b, '  ')
    const list = await valAs(t88h.a, `select handover_colleagues($1) as v`, [t88h.enc])
    r.list = Array.isArray(list) ? list.map((x) => x.id) : list
    r.listOther = await valAs(t88h.b, `select handover_colleagues($1) as v`, [t88h.enc])
    r.access = await valAs(t88h.a, `select visit_access($1) as v`, [t88h.enc])
    t88h.h1 = await valAs(t88h.a, `select handover_patient($1, $2, $3) as v`, [
      t88h.enc,
      t88h.b,
      'Going to theatre; results of the RDT pending',
    ])
    r.twice = await ho(t88h.a, t88h.b)
    // until Dr. B answers, the patient is still Dr. A's
    r.aMay = await valAs(t88h.a, `select may_work_on($1) as v`, [t88h.enc])
    r.bMay = await valAs(t88h.b, `select may_work_on($1) as v`, [t88h.enc])
    r.bWrite = await hintAs(t88h.b, `select add_clinical_note($1, 'not yet mine')`, [t88h.enc])
    r.incoming = (await valAs(t88h.b, `select my_handovers() as v`))?.incoming ?? []
    r.outgoing = (await valAs(t88h.a, `select my_handovers() as v`))?.outgoing ?? []
    await as(t88h.b)
    r.board = await one(
      `select for_me, can_work, handover_status, handover_from_name, handover_note, handover_to
       from queue_board where encounter_id = $1 and station = 'consultation'`,
      [t88h.enc],
    )
    await asAdmin()
    r.bAccess = await valAs(t88h.b, `select visit_access($1) as v`, [t88h.enc])
    r.notice = await lastNotice88h(t88h.b, 'handover')
    // only Dr. B answers
    r.cTake = await hintAs(t88h.c, `select take_handover($1)`, [t88h.h1])
    r.aTake = await hintAs(t88h.a, `select take_handover($1)`, [t88h.h1])
    r.cDecline = await hintAs(t88h.c, `select decline_handover($1, 'not mine')`, [t88h.h1])
    r.bCancel = await hintAs(t88h.b, `select cancel_handover($1)`, [t88h.h1])
    if (
      r.notHolder !== '42501/handover_not_holder' ||
      r.nonColleague !== '42501/handover_not_colleague' ||
      r.pharmacist !== '42501/handover_not_colleague' ||
      r.self !== '42501/handover_not_colleague' ||
      r.noNote !== '22023/handover_note' ||
      !Array.isArray(r.list) ||
      !r.list.includes(t88h.b) ||
      r.list.includes(t88h.a) ||
      r.list.includes(t88h.c) ||
      r.list.includes(staff.pharmacist) ||
      r.listOther?.error !== '42501/handover_not_holder' ||
      r.access?.canHandOver !== true ||
      typeof t88h.h1 !== 'string' ||
      r.twice !== '23505/handover_pending' ||
      r.aMay !== true ||
      r.bMay !== false ||
      !/^42501/.test(r.bWrite) ||
      r.incoming.length !== 1 ||
      r.incoming[0].id !== t88h.h1 ||
      r.incoming[0].fromName !== 'Dr. Handover A 88' ||
      r.outgoing[0]?.status !== 'pending' ||
      r.board?.for_me !== true ||
      r.board?.can_work !== false ||
      r.board?.handover_status !== 'pending' ||
      r.board?.handover_to !== t88h.b ||
      r.bAccess?.handover?.forMe !== true ||
      r.bAccess?.canHandOver !== false ||
      r.notice?.params?.by !== 'Dr. Handover A 88' ||
      !r.notice?.params?.note ||
      r.cTake !== '42501/handover_not_yours' ||
      r.aTake !== '42501/handover_not_yours' ||
      r.cDecline !== '42501/handover_not_yours' ||
      r.bCancel !== '42501/handover_not_yours'
    )
      throw new Error(json88h({ ...r, list: r.list, h1: t88h.h1 }))
    return 'holder only, colleague of the desk only (not Dr. C, not the pharmacist), note required; one at a time; Dr. A keeps the patient until the answer'
  },
)
await step(
  '0088 B: Take: the patient becomes the colleague’s; the sender loses it and is told',
  async () => {
    const r = {}
    r.take = await valAs(t88h.b, `select take_handover($1) as v`, [t88h.h1])
    r.q = await q88h(t88h.enc)
    r.aMay = await valAs(t88h.a, `select may_work_on($1) as v`, [t88h.enc])
    r.bMay = await valAs(t88h.b, `select may_work_on($1) as v`, [t88h.enc])
    r.aWrite = await hintAs(t88h.a, `select add_clinical_note($1, 'no longer mine')`, [t88h.enc])
    r.bWrite = await hintAs(t88h.b, `select add_clinical_note($1, 'taken over')`, [t88h.enc])
    r.again = await hintAs(t88h.b, `select take_handover($1)`, [t88h.h1])
    r.notice = await lastNotice88h(t88h.a, 'handover_answer')
    r.track = (await valAs(t88h.b, `select visit_journey($1) as v`, [t88h.enc]))?.handovers ?? []
    r.bAccess = await valAs(t88h.b, `select visit_access($1) as v`, [t88h.enc])
    r.aAccess = await valAs(t88h.a, `select visit_access($1) as v`, [t88h.enc])
    await asAdmin()
    // the change of hands is no new referral (the entry came from reception: referred_by is
    // set), and the answered "hands over to you" notice is gone
    r.referredBy = (
      await one(`select referred_by from queue_entry where id = $1`, [r.take?.queueId])
    )?.referred_by
    r.referral = (
      await one(
        `select count(*)::int as n from notification
         where recipient_user = $1 and kind in ('queue', 'referral') and params ->> 'queue' = $2`,
        [t88h.b, r.take?.queueId],
      )
    ).n
    r.hoNotice = (
      await one(
        `select count(*)::int as n from notification where kind = 'handover' and params ->> 'handover' = $1`,
        [t88h.h1],
      )
    ).n
    r.audit = (
      await one(
        `select count(*)::int as n from audit_event where entity = 'patient_handover' and entity_id = $1`,
        [t88h.h1],
      )
    ).n
    r.practitioner = (
      await one(
        `select pr.user_id from encounter e join practitioner pr on pr.id = e.practitioner_id where e.id = $1`,
        [t88h.enc],
      )
    )?.user_id
    if (
      r.take?.encounterId !== t88h.enc ||
      r.q.taken_by !== t88h.b ||
      r.q.assigned_to !== t88h.b ||
      r.aMay !== false ||
      r.bMay !== true ||
      !/^42501/.test(r.aWrite) ||
      r.bWrite !== 'ok' ||
      r.again !== '23505/handover_gone' ||
      r.notice?.params?.taken !== true ||
      r.notice?.params?.by !== 'Dr. Handover B 88' ||
      r.track.length !== 1 ||
      r.track[0].status !== 'taken' ||
      r.track[0].from !== 'Dr. Handover A 88' ||
      r.track[0].to !== 'Dr. Handover B 88' ||
      r.bAccess?.canHandOver !== true ||
      r.bAccess?.handover !== null ||
      r.aAccess?.canWork !== false ||
      r.aAccess?.canHandOver !== false ||
      r.audit < 2 ||
      r.practitioner !== t88h.b ||
      !r.referredBy ||
      r.referral !== 0 ||
      r.hoNotice !== 0
    )
      throw new Error(json88h(r))
    return `taken: Dr. B has the patient (and is the treating doctor), Dr. A may no longer write; told; ${r.audit} audit rows`
  },
)
await step('0088 C: Decline with a reason: the patient stays; the sender is told why', async () => {
  const r = {}
  t88h.h2 = await valAs(t88h.b, `select handover_patient($1, $2, $3) as v`, [
    t88h.enc,
    t88h.a,
    'Back to you for the review',
  ])
  r.noReason = await hintAs(t88h.a, `select decline_handover($1, ' ')`, [t88h.h2])
  r.decline = await hintAs(t88h.a, `select decline_handover($1, 'Fully booked this afternoon')`, [
    t88h.h2,
  ])
  r.q = await q88h(t88h.enc)
  r.bMay = await valAs(t88h.b, `select may_work_on($1) as v`, [t88h.enc])
  r.aMay = await valAs(t88h.a, `select may_work_on($1) as v`, [t88h.enc])
  r.notice = await lastNotice88h(t88h.b, 'handover_answer')
  r.outgoing = (await valAs(t88h.b, `select my_handovers() as v`))?.outgoing ?? []
  r.incomingA = (await valAs(t88h.a, `select my_handovers() as v`))?.incoming ?? []
  r.take = await hintAs(t88h.a, `select take_handover($1)`, [t88h.h2])
  const declined = r.outgoing.find((x) => x.id === t88h.h2)
  if (
    r.noReason !== '22023/handover_reason' ||
    r.decline !== 'ok' ||
    r.q.taken_by !== t88h.b ||
    r.bMay !== true ||
    r.aMay !== false ||
    r.notice?.params?.taken !== false ||
    r.notice?.params?.reason !== 'Fully booked this afternoon' ||
    declined?.status !== 'declined' ||
    declined?.reason !== 'Fully booked this afternoon' ||
    r.incomingA.length !== 0 ||
    r.take !== '23505/handover_gone'
  )
    throw new Error(json88h({ ...r, outgoing: declined }))
  return 'declined with a reason: Dr. B keeps the patient and reads why'
})
await step(
  '0088 D: Cancel by the sender (not the colleague); a waiting handover lapses when the patient moves',
  async () => {
    const r = {}
    t88h.h3 = await valAs(t88h.b, `select handover_patient($1, $2, $3) as v`, [
      t88h.enc,
      t88h.a,
      'Please continue, I am called away',
    ])
    r.aCancel = await hintAs(t88h.a, `select cancel_handover($1)`, [t88h.h3])
    r.bCancel = await hintAs(t88h.b, `select cancel_handover($1)`, [t88h.h3])
    r.notice = await lastNotice88h(t88h.a, 'handover_cancelled')
    r.take = await hintAs(t88h.a, `select take_handover($1)`, [t88h.h3])
    // a new handover, then the patient finishes at Consultation before the answer: it lapses
    t88h.h4 = await valAs(t88h.b, `select handover_patient($1, $2, $3) as v`, [
      t88h.enc,
      t88h.a,
      'Continue please',
    ])
    await asAdmin()
    await db.query(
      `update queue_entry set finished_at = now() where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [t88h.enc],
    )
    r.lapsed = (await one(`select status from patient_handover where id = $1`, [t88h.h4])).status
    // Dr. A is told the patient moved on; the "hands over to you" notices of h3 and h4 are gone
    r.lapseNotice = await lastNotice88h(t88h.a, 'handover_cancelled')
    r.hoNotices = (
      await one(
        `select count(*)::int as n from notification where kind = 'handover' and params ->> 'handover' in ($1, $2)`,
        [t88h.h3, t88h.h4],
      )
    ).n
    r.incomingA = (await valAs(t88h.a, `select my_handovers() as v`))?.incoming ?? []
    r.lateTake = await hintAs(t88h.a, `select take_handover($1)`, [t88h.h4])
    r.cancelled = (await one(`select status from patient_handover where id = $1`, [t88h.h3])).status
    // nobody may write the record directly
    r.direct = await hintAs(
      t88h.a,
      `update patient_handover set status = 'taken' where id = $1 returning id`,
      [t88h.h4],
    )
    await asAdmin()
    r.after = (await one(`select status from patient_handover where id = $1`, [t88h.h4])).status
    if (
      r.aCancel !== '42501/handover_not_yours' ||
      r.bCancel !== 'ok' ||
      r.cancelled !== 'cancelled' ||
      r.notice?.params?.by !== 'Dr. Handover B 88' ||
      r.take !== '23505/handover_gone' ||
      r.lapsed !== 'lapsed' ||
      r.lapseNotice?.params?.lapsed !== true ||
      r.lapseNotice?.params?.handover !== t88h.h4 ||
      r.hoNotices !== 0 ||
      r.incomingA.length !== 0 ||
      r.lateTake !== '23505/handover_gone' ||
      r.after !== 'lapsed'
    )
      throw new Error(json88h(r))
    return 'cancelled by the sender (colleague told); lapsed when the patient left; no direct writes'
  },
)
await step(
  '0088 E: cover retired: covering_for is empty, end_cover refuses, an old cover row grants nothing',
  async () => {
    const r = {}
    await asAdmin()
    await db.exec(`alter table clinician_cover disable trigger trg_cover_retired`)
    const id = (
      await one(
        `insert into clinician_cover (doctor_id, nurse_id, ends_at) values ($1, $2, now() + interval '1 hour') returning id`,
        [t88h.a, staff.nurse],
      )
    ).id
    await db.exec(`alter table clinician_cover enable trigger trg_cover_retired`)
    t88h.enc2 = await newVisit88h('Handover 88 two', t88h.a)
    r.coveringFor = await valAs(staff.nurse, `select covering_for($1) as v`, [staff.nurse])
    r.perm = await valAs(staff.nurse, `select has_perm('orders.write') as v`)
    r.desk = await valAs(staff.nurse, `select may_use_desk('consultation') as v`)
    r.work = await valAs(staff.nurse, `select may_work_on($1) as v`, [t88h.enc2])
    r.end = await hintAs(t88h.a, `select end_cover($1)`, [id])
    r.mine = await valAs(staff.nurse, `select my_cover() as v`)
    await asAdmin()
    await db.query(`update clinician_cover set ended_at = now() where id = $1`, [id])
    if (
      r.coveringFor !== null ||
      r.perm !== false ||
      r.desk !== false ||
      r.work !== false ||
      r.end !== '42501/cover_retired' ||
      r.mine?.covering?.length !== 0
    )
      throw new Error(json88h(r))
    return 'an old cover row gives no right, desk or patient; end_cover refuses; my_cover empty'
  },
)
await step(
  '0088 F: the patient is at the laboratory, due back to Dr. A: he hands over; the result comes back to Dr. B',
  async () => {
    const r = {}
    t88h.enc3 = await newVisit88h('Handover 88 lab', t88h.a)
    await asAdmin()
    const test = (
      await one(`select id from service where name_en = 'Check test A' and deleted_at is null`)
    ).id
    await as(t88h.a)
    await db.query(`select order_tests($1, $2, 'fever', 'consultation')`, [t88h.enc3, [test]])
    await asAdmin()
    const lab = await one(
      `select id, return_to, taken_by from queue_entry
       where encounter_id = $1 and station = 'laboratory' and finished_at is null`,
      [t88h.enc3],
    )
    r.labReturn = lab?.return_to === t88h.a
    r.access = await valAs(t88h.a, `select visit_access($1) as v`, [t88h.enc3])
    const list = await valAs(t88h.a, `select handover_colleagues($1) as v`, [t88h.enc3])
    r.list = Array.isArray(list) ? list.map((x) => x.id) : list
    t88h.h5 = await valAs(t88h.a, `select handover_patient($1, $2, $3) as v`, [
      t88h.enc3,
      t88h.b,
      'Called to theatre; malaria test pending, please decide',
    ])
    await asAdmin()
    r.row = await one(`select station, via_return, queue_id from patient_handover where id = $1`, [
      t88h.h5,
    ])
    // the lab taking the sample is not the patient leaving Dr. A
    await as(staff.lab_tech)
    const req = (
      await one(`select id from service_request where encounter_id = $1 and deleted_at is null`, [
        t88h.enc3,
      ])
    ).id
    r.collect = await hintAs(staff.lab_tech, `select set_request_status($1, 'collected')`, [req])
    await asAdmin()
    r.stillPending = (
      await one(`select status from patient_handover where id = $1`, [t88h.h5])
    ).status
    r.take = await valAs(t88h.b, `select take_handover($1) as v`, [t88h.h5])
    await asAdmin()
    const labAfter = await one(`select return_to, taken_by from queue_entry where id = $1`, [
      lab.id,
    ])
    r.labReturnB = labAfter.return_to === t88h.b
    r.labTakenKept = labAfter.taken_by !== t88h.b
    r.bMay = await valAs(t88h.b, `select may_work_on($1) as v`, [t88h.enc3])
    r.result = await hintAs(
      staff.lab_tech,
      `select record_result($1, 'No parasites', 'Negative', true)`,
      [req],
    )
    await asAdmin()
    r.back = await one(
      `select assigned_to from queue_entry
       where encounter_id = $1 and station = 'consultation' and finished_at is null`,
      [t88h.enc3],
    )
    r.toB = (
      await one(
        `select count(*)::int as n from notification
         where kind = 'result' and recipient_user = $1 and link like '%' || $2`,
        [t88h.b, t88h.enc3],
      )
    ).n
    r.toA = (
      await one(
        `select count(*)::int as n from notification
         where kind = 'result' and recipient_user = $1 and link like '%' || $2`,
        [t88h.a, t88h.enc3],
      )
    ).n
    r.orderedBy = (
      await one(`select requester_id from service_request where id = $1`, [req])
    ).requester_id
    if (
      !r.labReturn ||
      r.access?.canHandOver !== true ||
      !Array.isArray(r.list) ||
      !r.list.includes(t88h.b) ||
      r.list.includes(t88h.c) ||
      typeof t88h.h5 !== 'string' ||
      r.row?.station !== 'consultation' ||
      r.row?.via_return !== true ||
      r.row?.queue_id !== lab.id ||
      r.collect !== 'ok' ||
      r.stillPending !== 'pending' ||
      r.take?.encounterId !== t88h.enc3 ||
      !r.labReturnB ||
      !r.labTakenKept ||
      r.bMay !== true ||
      r.result !== 'ok' ||
      r.back?.assigned_to !== t88h.b ||
      r.toB !== 1 ||
      r.toA !== 0 ||
      r.orderedBy !== t88h.a
    )
      throw new Error(json88h({ ...r, h5: t88h.h5 }))
    return 'handed over while at the laboratory; taken; the result and the patient come back to Dr. B; "ordered by" stays Dr. A'
  },
)
await step(
  '0088 G: a colleague who leaves the clinic: the handover waiting for them ends and the sender is told',
  async () => {
    const r = {}
    t88h.enc4 = await newVisit88h('Handover 88 leaves', t88h.a)
    t88h.h6 = await valAs(t88h.a, `select handover_patient($1, $2, $3) as v`, [
      t88h.enc4,
      t88h.b,
      'Please continue with this patient',
    ])
    await asAdmin()
    await db.query(`update profiles set active = false, deactivated_at = now() where id = $1`, [
      t88h.b,
    ])
    r.row = await one(`select status, reason from patient_handover where id = $1`, [t88h.h6])
    r.notice = await lastNotice88h(t88h.a, 'handover_cancelled')
    r.hoNotice = (
      await one(
        `select count(*)::int as n from notification where kind = 'handover' and params ->> 'handover' = $1`,
        [t88h.h6],
      )
    ).n
    r.aMay = await valAs(t88h.a, `select may_work_on($1) as v`, [t88h.enc4])
    await db.query(`update profiles set active = true, deactivated_at = null where id = $1`, [
      t88h.b,
    ])
    // the patient can be handed over again
    r.again = await hintAs(t88h.a, `select handover_patient($1, $2, 'Again, please')`, [
      t88h.enc4,
      t88h.b,
    ])
    // the manager cancels it: both colleagues are told
    await asAdmin()
    const h7 = (
      await one(`select id from patient_handover where encounter_id = $1 and status = 'pending'`, [
        t88h.enc4,
      ])
    )?.id
    r.mgrCancel = await hintAs(staff.manager, `select cancel_handover($1)`, [h7])
    await asAdmin()
    r.toldA = (await lastNotice88h(t88h.a, 'handover_cancelled'))?.params?.handover === h7
    r.toldB = (await lastNotice88h(t88h.b, 'handover_cancelled'))?.params?.handover === h7
    if (
      r.row?.status !== 'cancelled' ||
      !r.row?.reason ||
      r.notice?.params?.handover !== t88h.h6 ||
      r.notice?.params?.left !== true ||
      r.notice?.params?.leftName !== 'Dr. Handover B 88' ||
      r.hoNotice !== 0 ||
      r.aMay !== true ||
      r.again !== 'ok' ||
      r.mgrCancel !== 'ok' ||
      !r.toldA ||
      !r.toldB
    )
      throw new Error(json88h(r))
    return 'deactivated colleague: the handover ends, Dr. A keeps the patient and is told; the manager cancels: both told'
  },
)

await step(
  '0088 G: the manager\'s "medical" extra fields are private like the safety summary',
  async () => {
    await asAdmin()
    await db.query(
      `insert into setting (key, value) values ('patient.fields', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [
        JSON.stringify([
          { key: 'kin', label: 'Next of kin', type: 'text' },
          { key: 'hiv', label: 'HIV status', type: 'text', private: true },
          { key: 'tb', label: 'TB treatment', type: 'text', private: true },
        ]),
      ],
    )
    await db.query(
      `update patient set extra = '{"kin":"Mama","hiv":"positive"}'::jsonb where id = $1`,
      [t88.pid],
    )
    const r = {}
    const rec = await j88(staff.receptionist, `select patient_file($1) as j`, [t88.pid])
    r.recExtra = rec.patient?.extra
    // 0092: the keys of the filled private fields (no values), so the form locks HIV and offers TB
    r.recFilled = rec.extra_filled
    // reception saves the form as it sees it, fills the empty TB field, tries to overwrite HIV
    r.save = await j88(staff.receptionist, `select to_jsonb(update_patient($1, $2::jsonb)) as j`, [
      t88.pid,
      JSON.stringify({ extra: { kin: 'Mama Uwase', tb: 'started', hiv: 'negative' } }),
    ])
    await asAdmin()
    r.stored = (await one(`select extra from patient where id = $1`, [t88.pid])).extra
    const b = await j88(t88.docB, `select patient_file($1) as j`, [t88.pid])
    r.docExtra = b.patient?.extra
    await db.query(`update setting set value = '[]'::jsonb where key = 'patient.fields'`)
    if (
      JSON.stringify(r.recExtra) !== JSON.stringify({ kin: 'Mama' }) ||
      JSON.stringify(r.recFilled) !== JSON.stringify(['hiv']) ||
      r.stored.hiv !== 'positive' ||
      r.stored.tb !== 'started' ||
      r.stored.kin !== 'Mama Uwase' ||
      r.docExtra?.hiv !== 'positive'
    )
      throw new Error(json88(r))
    return 'reception sees kin only; fills the empty TB field but cannot overwrite HIV; the treating doctor sees both'
  },
)

// ---------------------------------------------------------------- security hardening (20261202090000)
await step(
  'hardening: the audit log cannot be read, changed or forged by staff; nor through its partitions',
  async () => {
    await asAdmin()
    const part = (
      await one(
        `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
       join pg_class p on p.oid = i.inhparent where p.relname = 'audit_event' order by c.relname desc limit 1`,
      )
    ).relname
    const r = {
      readPart: await codeAs(staff.receptionist, `select count(*) from ${part}`),
      deletePart: await codeAs(staff.receptionist, `delete from ${part} where true`),
      insertParent: await codeAs(
        staff.receptionist,
        `insert into audit_event (actor_id, action, entity) values ($1, 'login', 'profiles')`,
        [staff.receptionist],
      ),
      deleteParent: await codeAs(staff.manager, `delete from audit_event where true`),
    }
    if (Object.values(r).some((c) => c !== '42501')) throw new Error(JSON.stringify({ part, ...r }))
    return `${part}: read, delete, insert and delete through the parent all refused`
  },
)
await step('hardening: views and tables are read only from the API', async () => {
  await asAdmin()
  const pid = (
    await one(`select id from patient where deleted_at is null order by created_at limit 1`)
  ).id
  const r = {
    practitioners: await codeAs(
      staff.lab_tech ?? staff.nurse,
      `update public_practitioners set names = 'FORGED' where true`,
    ),
    payers: await codeAs(
      staff.receptionist,
      `insert into public_payers (code, name) values ('FAKE', 'Fake')`,
    ),
    patient: await codeAs(staff.nurse, `update patient set allergies = null where id = $1`, [pid]),
    dayClose: await codeAs(staff.cashier, `update day_close set counted = expected where true`),
  }
  const priv = await one(
    `select has_table_privilege('authenticated', 'public_payers', 'insert') as payers_ins,
            has_table_privilege('anon', 'public_service_lines', 'update') as lines_upd,
            has_table_privilege('authenticated', 'patient', 'update') as patient_upd`,
  )
  if (
    Object.values(r).some((c) => c !== '42501') ||
    priv.payers_ins ||
    priv.lines_upd ||
    priv.patient_upd
  )
    throw new Error(JSON.stringify({ r, priv }))
  return 'forged practitioners, a fake insurer, a cleared allergy and a hidden cash shortage: all refused'
})
await step(
  'hardening: home results only for those who may see them; a deactivated account loses its sign-ins',
  async () => {
    const rec = await j88(staff.receptionist, `select home_summary() as j`)
    await asAdmin()
    const sid = crypto.randomUUID()
    await db.query(
      `insert into approved_session (session_id, user_id, via) values ($1, $2, 'code')`,
      [sid, staff.nurse],
    )
    await db.query(`update profiles set active = false where id = $1`, [staff.nurse])
    const ended = await one(
      `select ended_at is not null as e, ended_reason from approved_session where session_id = $1`,
      [sid],
    )
    await db.query(`update profiles set active = true where id = $1`, [staff.nurse])
    if ((rec.results ?? []).length !== 0 || !ended.e || ended.ended_reason !== 'deactivated')
      throw new Error(JSON.stringify({ results: rec.results?.length, ended }))
    return 'reception gets no results; the deactivated nurse’s approved sign-in ended at once'
  },
)

// ---------------------------------------------------------------- 0092 guide fixes
const t92 = {}
await step('0092: the sign-in e-mail lookup needs the PIN; 5 wrong PINs close it', async () => {
  await asAdmin()
  const me = await one(`select staff_id, username, email from profiles where id = $1`, [
    staff.lab_tech,
  ])
  await db.query(
    `update auth.users set encrypted_password = crypt('482915', gen_salt('bf', 6)) where id = $1`,
    [staff.lab_tech],
  )
  const look = async (pin) => {
    await as(null, 'anon', '')
    const r = (
      await one(`select staff_login_email($1, $2, $3) as e`, [me.staff_id, me.username, pin])
    ).e
    await asAdmin()
    return r
  }
  const r = {}
  r.wrong = await look('000000')
  r.right = await look('482915')
  r.audit = (
    await one(
      `select count(*)::int as n from audit_event where actor_id = $1 and action = 'login' and reason = 'wrong PIN (lookup)'`,
      [staff.lab_tech],
    )
  ).n
  for (let i = 0; i < 4; i++) await look('111111')
  r.locked = await look('482915')
  r.oldSignature = (
    await one(
      `select exists (select 1 from pg_proc where proname = 'staff_login_email' and pronargs = 2) as b`,
    )
  ).b
  await db.query(`delete from audit_event where actor_id = $1 and reason = 'wrong PIN (lookup)'`, [
    staff.lab_tech,
  ])
  if (
    r.wrong !== null ||
    r.right !== me.email ||
    r.audit !== 1 ||
    r.locked !== null ||
    r.oldSignature
  )
    throw new Error(json88(r))
  return 'wrong PIN: nothing (and logged); right PIN: the e-mail; after 5 wrong PINs: nothing even with the right one'
})
await step('0092: open bills on the home page only for who takes payments', async () => {
  // the earlier steps left open bills behind (the cashier's list is not empty)
  const bills = async (who) =>
    ((await j88(who, `select home_summary() as j`)).openBills ?? []).length
  const r = {
    nurse: await bills(staff.nurse),
    doctor: await bills(t88.docB),
    cashier: await bills(staff.cashier),
    manager: await bills(staff.manager),
  }
  if (r.nurse || r.doctor || !r.cashier || r.manager !== r.cashier) throw new Error(json88(r))
  return `nurse and doctor: none; cashier and manager: ${r.cashier} open bill(s)`
})
await step(
  '0092: HIV tests: the record needs sensitive.read, the lab list the right or the desk; an HIV diagnosis needs the right',
  async () => {
    await asAdmin()
    t92.pid = (
      await one(
        `insert into patient (surname, given_names, sex) values ('Guide', 'Fixes 92', 'male') returning id`,
      )
    ).id
    t92.enc = await openVisit88(t92.pid, t88.docB)
    await as(staff.manager)
    const cat = (await one(`select save_category(null, 'Lab tests 92', null, null, 'lab') as id`))
      .id
    t92.hiv = (await one(`select upsert_service(null, 'HIV test 92', 'other', 1000) as id`)).id
    t92.glu = (await one(`select upsert_service(null, 'Glucose 92', 'other', 1000) as id`)).id
    await db.query(`select set_service_category($1, $2)`, [t92.hiv, cat])
    await db.query(`select set_service_category($1, $2)`, [t92.glu, cat])
    // Dr B's two requests, written directly (as the 0088 seed does)
    await asAdmin()
    await db.query(
      `insert into service_request (encounter_id, category, service_id, station, requester_id)
       values ($1, 'lab', $2, 'laboratory', $3), ($1, 'lab', $4, 'laboratory', $3)`,
      [t92.enc, t92.hiv, t88.docB, t92.glu],
    )
    const tests = async (who, sql) =>
      ((await j88(who, sql, [t92.enc])) ?? {}).orders?.map((o) => o.test)
    const lab = async () =>
      (await j88(staff.lab_tech, `select lab_worklist('open') as j`))
        .filter((x) => x.encounterId === t92.enc)
        .map((x) => x.test)
    const r = {}
    r.doctor = await tests(t88.docB, `select visit_clinical($1) as j`)
    // the laboratory runs the test: its desk is enough, whatever its rights
    r.labList = await lab()
    r.reception = await tests(staff.receptionist, `select visit_clinical($1) as j`)
    // sensitive.read is not one of the switches: written directly, as the 0081 steps do
    await asAdmin()
    await db.query(
      `insert into staff_permission (profile_id, permission, allowed) values ($1, 'sensitive.read', false)`,
      [t88.docB],
    )
    r.doctorWithout = await tests(t88.docB, `select visit_clinical($1) as j`)
    r.b20 = await codeAs(t88.docB, `select add_diagnosis($1, 'HIV disease', 'B20')`, [t92.enc])
    await asAdmin()
    await db.query(
      `delete from staff_permission where permission = 'sensitive.read' and profile_id = $1`,
      [t88.docB],
    )
    r.b20Allowed = await codeAs(t88.docB, `select add_diagnosis($1, 'HIV disease', 'B20')`, [
      t92.enc,
    ])
    const has = (a, name) => (a ?? []).includes(name)
    if (
      !has(r.doctor, 'HIV test 92') ||
      !has(r.doctor, 'Glucose 92') ||
      !has(r.labList, 'HIV test 92') ||
      !has(r.labList, 'Glucose 92') ||
      r.reception !== undefined ||
      has(r.doctorWithout, 'HIV test 92') ||
      !has(r.doctorWithout, 'Glucose 92') ||
      r.b20 !== '42501' ||
      r.b20Allowed !== null
    )
      throw new Error(json88(r))
    return 'the doctor and the laboratory see both; reception nothing; a doctor without the right: the glucose only, B20 refused'
  },
)
await step("0092: a head's dashboard shows their own department's people only", async () => {
  await asAdmin()
  await db.query(`update profiles set dashboard = 'head' where id = $1`, [t88.head])
  await db.query(
    `insert into audit_event (actor_id, action, entity, entity_id, reason) values ($1, 'login', 'profiles', $1, 'signed in'), ($2, 'login', 'profiles', $2, 'signed in')`,
    [staff.receptionist, t88.docB],
  )
  const members = (
    await db.query(`select profile_id from staff_department where department_id = $1`, [t88.dept])
  ).rows.map((x) => x.profile_id)
  const head = await j88(t88.head, `select dashboard_summary(current_date - 7, current_date) as j`)
  const mgr = await j88(
    staff.manager,
    `select dashboard_summary(current_date - 7, current_date) as j`,
  )
  await asAdmin()
  await db.query(`update profiles set dashboard = null where id = $1`, [t88.head])
  const r = {
    staff: head.staff?.length,
    outsiders: (head.staff ?? []).filter((s) => !members.includes(s.id)).length,
    loginOutsiders: (head.logins ?? []).filter((l) => !members.includes(l.id)).length,
    loginsOfMine: (head.logins ?? []).some((l) => l.id === t88.docB),
    managerSeesAll: (mgr.staff ?? []).some((s) => s.id === staff.receptionist),
  }
  if (!r.staff || r.outsiders || r.loginOutsiders || !r.loginsOfMine || !r.managerSeesAll)
    throw new Error(json88(r))
  return `the head: ${r.staff} people of Consultation 88, their sign-ins only; the manager: everyone`
})
await step('0092: every temporary PIN ends the sign-ins; nobody gives themself one', async () => {
  await asAdmin()
  const session = async () => {
    const sid = crypto.randomUUID()
    await db.query(
      `insert into approved_session (session_id, user_id, via) values ($1, $2, 'code')`,
      [sid, staff.pharmacist],
    )
    return sid
  }
  const ended = async (sid) =>
    (await one(`select ended_reason from approved_session where session_id = $1`, [sid]))
      .ended_reason
  const r = {}
  const s1 = await session()
  await db.query(`update profiles set must_change_pin = true where id = $1`, [staff.pharmacist])
  await db.query(`insert into staff_temp_pin (user_id, pin, set_by) values ($1, '111111', $2)`, [
    staff.pharmacist,
    staff.manager,
  ])
  r.first = await ended(s1)
  // a second reset while the first is still pending: the flag does not change, the PIN does
  const s2 = await session()
  await db.query(`update staff_temp_pin set pin = '222222', set_at = now() where user_id = $1`, [
    staff.pharmacist,
  ])
  r.second = await ended(s2)
  // written by the server (manage-staff): as the owner here
  try {
    await db.query(`insert into staff_temp_pin (user_id, pin, set_by) values ($1, '333333', $1)`, [
      staff.manager,
    ])
    r.self = null
  } catch (e) {
    r.self = `${e.code}/${e.hint ?? ''}`
  }
  await db.query(`delete from staff_temp_pin where user_id = $1`, [staff.pharmacist])
  await db.query(`update profiles set must_change_pin = false where id = $1`, [staff.pharmacist])
  if (r.first !== 'new PIN' || r.second !== 'new PIN' || r.self !== '42501/not_permitted')
    throw new Error(json88(r))
  return 'both resets ended the open sign-in; a manager cannot set their own temporary PIN'
})
await step("0092: only the calendar's doctor (or the manager) declines a booking", async () => {
  // an approved booking on the dentist's calendar (written directly: the calendar is staff-only now)
  await asAdmin()
  const id = (
    await one(
      `insert into appointment (patient_id, practitioner_id, starts_at, status, contact_phone, category)
       select $1, p.id, $2::timestamptz + interval '21 days', 'approved', '0788 000 920', 'dental'
       from practitioner p where p.code = 'nf' returning id`,
      [patientId, slot],
    )
  ).id
  const r = {}
  r.other = await codeAs(staff.doctor, `select decline_appointment($1, 'busy')`, [id])
  r.owner = await codeAs(dentist, `select decline_appointment($1, 'busy')`, [id])
  await asAdmin()
  r.status = (await one(`select status from appointment where id = $1`, [id])).status
  if (r.other !== '42501' || r.owner !== null || r.status !== 'declined') throw new Error(json88(r))
  return "another doctor refused; the calendar's doctor declined"
})
await step(
  '0092: "Seen" and the file notice go to the requester or the colleague who took the patient over',
  async () => {
    await asAdmin()
    const sr = (
      await db.query(
        `select r.id from service_request r where r.encounter_id = $1 order by r.created_at`,
        [t92.enc],
      )
    ).rows.map((x) => x.id)
    const report = async (req) =>
      (
        await one(
          `insert into diagnostic_report (service_request_id, findings, impression, verified_at) values ($1, 'f', 'normal', now()) returning id`,
          [req],
        )
      ).id
    const r = {}
    const d1 = await report(sr[0])
    r.other = await codeAs(t88.docC, `select mark_result_reviewed($1)`, [d1])
    r.requester = await codeAs(t88.docB, `select mark_result_reviewed($1)`, [d1])
    // Dr B hands the patient over to Dr C, who takes them
    await asAdmin()
    const q = (await one(`select id from queue_entry where encounter_id = $1 limit 1`, [t92.enc]))
      .id
    await db.query(
      `insert into patient_handover (encounter_id, queue_id, station, from_user, to_user, note, status, answered_at, answered_by)
       values ($1, $2, 'consultation', $3, $4, 'please continue', 'taken', now(), $4)`,
      [t92.enc, q, t88.docB, t88.docC],
    )
    await db.query(`update queue_entry set taken_by = $2 where id = $1`, [q, t88.docC])
    const d2 = await report(sr[1])
    r.takenOver = await codeAs(t88.docC, `select mark_result_reviewed($1)`, [d2])
    r.reviewedBy = (
      await one(`select reviewed_by from diagnostic_report where id = $1`, [d2])
    ).reviewed_by
    // the laboratory adds a file to the test: the notice goes to Dr C, not Dr B
    // (the 0089 step re-ran its migration after all the others: put the 0092 definitions back)
    await asAdmin()
    await db.exec(
      await readFile(path.join(migrationsDir, '20261203090000_guide_fixes.sql'), 'utf8'),
    )
    const name = path89(t92.pid, t92.enc)
    await db.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('patient-files', $1, $2)`,
      [name, JSON.stringify({ size: 120000, mimetype: 'image/jpeg' })],
    )
    const f = await attach89(staff.lab_tech, {
      enc: t92.enc,
      pid: t92.pid,
      path: name,
      kind: 'lab',
      title: 'Printout 92',
      sr: sr[1],
    })
    await asAdmin()
    r.notice = (
      await db.query(
        `select recipient_user from notification where kind = 'file_attached' and params ->> 'fileId' = $1`,
        [f.id ?? ''],
      )
    ).rows.map((x) => x.recipient_user)
    if (
      r.other !== '42501' ||
      r.requester !== null ||
      r.takenOver !== null ||
      r.reviewedBy !== t88.docC ||
      r.notice.length !== 1 ||
      r.notice[0] !== t88.docC
    )
      throw new Error(json88({ ...r, file: f }))
    return 'another doctor refused; the requester and, after the handover, the colleague allowed; the notice went to the colleague'
  },
)
await step('0092: impossible vital signs are refused with a sentence per field', async () => {
  const v = await visit87('Vitals92')
  const r = {}
  r.sys = await codeAs(staff.nurse, `select record_vitals($1, '{"bp_sys":"450"}'::jsonb)`, [v.enc])
  r.temp = await codeAs(staff.nurse, `select record_vitals($1, '{"temp":"67"}'::jsonb)`, [v.enc])
  r.spo2 = await codeAs(staff.nurse, `select record_vitals($1, '{"spo2":"101"}'::jsonb)`, [v.enc])
  r.weight = await codeAs(staff.nurse, `select record_vitals($1, '{"weight":"0.2"}'::jsonb)`, [
    v.enc,
  ])
  r.ok = await codeAs(
    staff.nurse,
    `select record_vitals($1, '{"bp_sys":"300","temp":"30","spo2":"100","weight":"0.3","muac":"60"}'::jsonb)`,
    [v.enc],
  )
  await asAdmin()
  r.rows = (
    await one(`select count(*)::int as n from observation where encounter_id = $1`, [v.enc])
  ).n
  if (
    r.sys !== '22023' ||
    r.temp !== '22023' ||
    r.spo2 !== '22023' ||
    r.weight !== '22023' ||
    r.ok !== null ||
    r.rows !== 5
  )
    throw new Error(json88(r))
  return '450 mmHg, 67 °C, 101 %, 0.2 kg refused; the limits themselves accepted'
})
await step(
  '0092: a merge moves files and access rows; the old number still finds the patient',
  async () => {
    await as(staff.receptionist)
    const keep = (
      await one(
        `select register_patient_file('Merge', 'Keep 92', 'female', null, 30, '0788920001') as r`,
      )
    ).r
    const dup = (
      await one(
        `select register_patient_file('Merge', 'Dup 92', 'female', null, 30, '0788920002') as r`,
      )
    ).r
    await asAdmin()
    const enc = (
      await one(`insert into encounter (patient_id) values ($1) returning id`, [dup.patient_id])
    ).id
    await db.query(
      `insert into patient_file_doc (patient_id, encounter_id, kind, title, storage_path, mime_type, size_bytes, uploaded_by)
     values ($1, $2, 'photo', 'Photo 92', $3, 'image/jpeg', 1000, $4)`,
      [dup.patient_id, enc, path89(dup.patient_id, enc), t88.docB],
    )
    await db.query(
      `insert into record_access_request (patient_id, encounter_id, requested_by, reason) values ($1, $2, $3, 'second opinion')`,
      [dup.patient_id, enc, t88.docC],
    )
    await db.query(`update encounter set status = 'closed', closed_at = now() where id = $1`, [enc])
    await as(staff.manager)
    await db.query(`select merge_patients($1, $2)`, [keep.patient_id, dup.patient_id])
    await asAdmin()
    const r = {
      file: (await one(`select patient_id from patient_file_doc where encounter_id = $1`, [enc]))
        .patient_id,
      request: (
        await one(`select patient_id from record_access_request where encounter_id = $1`, [enc])
      ).patient_id,
    }
    await as(staff.receptionist)
    r.find = (await db.query(`select id from find_patients($1)`, [dup.file_number])).rows.map(
      (x) => x.id,
    )
    r.list = ((await one(`select patients_list($1) as j`, [dup.file_number])).j.rows ?? []).map(
      (x) => x.id,
    )
    await asAdmin()
    // (the digits of a file number may also match a phone, as before: the kept file is what counts)
    if (
      r.file !== keep.patient_id ||
      r.request !== keep.patient_id ||
      !r.find.includes(keep.patient_id) ||
      r.find.includes(dup.patient_id) ||
      !r.list.includes(keep.patient_id) ||
      r.list.includes(dup.patient_id)
    )
      throw new Error(json88(r))
    return 'file and access request moved; both searches find the kept file by the old number'
  },
)

// ---------------------------------------------------------------- calendars for nurses and the manager (0094)
await step('0094: a nurse keeps a calendar; the website lists it as a nurse', async () => {
  await as(staff.nurse)
  const hours = JSON.stringify(
    Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]])),
  )
  const mine = (await one(`select my_calendar(null) as j`)).j
  await one(
    `select save_calendar(null, $1::jsonb, 20, 'public', '{}', 'Dressings and injections') as id`,
    [hours],
  )
  await as(null, 'anon')
  const pub = await one(
    `select role, slot_minutes from public_practitioners where names = 'Nyirahabimana Chantal'`,
  )
  await asAdmin()
  if (mine.canKeep !== true) throw new Error('the nurse may not keep a calendar')
  if (!pub || pub.role !== 'nurse' || pub.slot_minutes !== 20) throw new Error(JSON.stringify(pub))
  return `canKeep; public row role ${pub.role}, ${pub.slot_minutes}-minute slots`
})
await step('0094: the manager keeps their own calendar and is in "Calendar of"', async () => {
  await as(staff.manager)
  const before = (await one(`select my_calendar(null) as j`)).j
  await one(`select save_calendar(null, '{"1":[["08:00","12:00"]]}'::jsonb, 30, 'staff') as id`)
  const people = (await one(`select calendar_people() as j`)).j
  const me = people.find((p) => p.userId === staff.manager)
  const nurse = people.find((p) => p.userId === staff.nurse)
  const cashier = people.find((p) => p.userId === staff.cashier)
  await asAdmin()
  if (before.canKeep !== true || before.saved !== false) throw new Error(JSON.stringify(before))
  if (!me || me.role !== 'manager' || me.saved !== true) throw new Error(JSON.stringify(me))
  if (!nurse || nurse.saved !== true || cashier) throw new Error('people list wrong')
  return `${people.length} people; the manager first, saved`
})
await expectError(
  '0094: a cashier still cannot be booked',
  async () => {
    await as(staff.receptionist)
    await db.query(`select ensure_practitioner($1)`, [staff.cashier])
  },
  /nurses and managers can be booked/,
)
await step(
  '0094: a nurse is booked at reception; on arrival the patient waits at Nursing',
  async () => {
    await asAdmin()
    const flow = (await one(`select value from setting where key = 'flow'`))?.value ?? null
    await db.query(
      `insert into setting (key, value) values ('flow', '{"triage_first": false}') on conflict (key) do update set value = setting.value || '{"triage_first": false}'`,
    )
    await as(staff.receptionist)
    const r = (
      await one(
        `select register_patient_file('Uwase', 'Nurse Booked', 'female', null, 24, null) as r`,
      )
    ).r
    const listed = (await one(`select bookable_doctors() as j`)).j.find(
      (d) => d.userId === staff.nurse,
    )
    const appt = (
      await one(
        `select book_appointment($1, $2, date_trunc('day', now()) + interval '1 day 9 hours', 'Dressing') as id`,
        [r.patient_id, staff.nurse],
      )
    ).id
    await as(staff.nurse)
    await db.query(`select accept_appointment($1)`, [appt])
    await as(staff.receptionist)
    const v = (await one(`select appointment_arrived($1) as v`, [appt])).v
    await asAdmin()
    const q = await one(
      `select station::text as station, assigned_to from queue_entry where encounter_id = $1 and finished_at is null`,
      [v.encounter_id],
    )
    const told = await one(
      `select count(*)::int as n from notification where kind = 'booked_arrived' and recipient_user = $1`,
      [staff.nurse],
    )
    if (flow) await db.query(`update setting set value = $1 where key = 'flow'`, [flow])
    else await db.query(`delete from setting where key = 'flow'`)
    if (!listed || listed.role !== 'nurse') throw new Error('the nurse is not in the bookable list')
    if (v.station !== 'nursing' || q?.station !== 'nursing' || q.assigned_to !== staff.nurse)
      throw new Error(JSON.stringify({ v, q }))
    if (told.n < 1) throw new Error('the nurse was not told')
    return `booked, accepted by the nurse; arrived at ${q.station}, given to the nurse, told`
  },
)

// ---------------------------------------------------------------- notices open their thing (0096)
await step('0096: a booking to accept carries the appointment id (Home focuses it)', async () => {
  await asAdmin()
  const pr = await one(`select id from practitioner where user_id = $1 limit 1`, [staff.doctor])
  if (!pr) throw new Error('the doctor has no calendar')
  const appt = (
    await one(
      `insert into appointment (practitioner_id, status, source, contact_name, contact_phone, starts_at)
       values ($1, 'inquiry', 'online', 'Notice Target 96', '0788000096', now() + interval '2 days') returning id`,
      [pr.id],
    )
  ).id
  await db.query(`update appointment set status = 'approved' where id = $1`, [appt])
  const n = await one(
    `select params, link from notification where kind = 'to_accept' and recipient_user = $1
       and params ->> 'appointment' = $2`,
    [staff.doctor, appt],
  )
  await db.query(`delete from notification where params ->> 'appointment' = $1`, [appt])
  await db.query(`delete from appointment where id = $1`, [appt])
  if (!n || n.params.name !== 'Notice Target 96' || !n.params.when)
    throw new Error(JSON.stringify(n))
  return `to_accept for the doctor with the appointment id; link ${n.link}`
})
await step(
  '0096: a task without a visit links to Home with its id; on a visit, the visit',
  async () => {
    await asAdmin()
    const loose = (
      await one(
        `insert into internal_task (title, assigned_to) values ('Call back 96', $1) returning id`,
        [staff.doctor],
      )
    ).id
    const a = await one(
      `select params, link from notification where kind = 'task' and params ->> 'title' = 'Call back 96'`,
    )
    const enc = await one(`select id, patient_id from encounter order by created_at desc limit 1`)
    const onVisit = (
      await one(
        `insert into internal_task (encounter_id, patient_id, title, assigned_to)
       values ($1, $2, 'Dressing 96', $3) returning id`,
        [enc.id, enc.patient_id, staff.doctor],
      )
    ).id
    const b = await one(
      `select params, link from notification where kind = 'task' and params ->> 'title' = 'Dressing 96'`,
    )
    await db.query(`delete from internal_task where id in ($1, $2)`, [loose, onVisit])
    if (a?.params.task !== loose || a.link !== `/app?focus=task:${loose}`)
      throw new Error(JSON.stringify(a))
    if (b?.params.task !== onVisit || b.link !== `/app/visit?encounter=${enc.id}`)
      throw new Error(JSON.stringify(b))
    return 'task id in params; Home focus without a visit, the visit otherwise'
  },
)

// ---------------------------------------------------------------- 0097 the pharmacy, simplified
const t97 = {}
await step('0097 A: add stock: a new supply and an existing medicine, no supplier', async () => {
  await as(staff.manager)
  t97.amox = (
    await one(`select upsert_item(null, 'Amoxicillin 97', 300, '500 mg', 'capsule', 'cap') as id`)
  ).id
  await asAdmin()
  t97.main = (await one(`select main_pharmacy() as id`)).id
  t97.day = await one(`select (current_date + 400)::text as d, (current_date + 10)::text as soon`)
  await as(staff.pharmacist)
  const r = (
    await one(`select add_stock($1::jsonb, null, 'shelf 97') as j`, [
      JSON.stringify([
        {
          item_id: t97.amox,
          batch_no: 'AMX-97',
          expiry: t97.day.d,
          quantity: 100,
          unit_cost: 120,
          sell_price: 350,
        },
        {
          new_item: { name: 'Gauze 97', kind: 'supply', unit: 'pack' },
          batch_no: 'GZ-97',
          expiry: t97.day.d,
          quantity: 10,
          unit_cost: 500,
          sell_price: 800,
        },
      ]),
    ])
  ).j
  await asAdmin()
  t97.gauze = r.lines[1].item_id
  const gz = await one(
    `select i.kind, i.code, (select pf.price from price_for(null, i.id, null) pf) as price from item i where i.id = $1`,
    [t97.gauze],
  )
  const amoxPrice = (await one(`select pf.price from price_for(null, $1, null) pf`, [t97.amox]))
    .price
  const grn = await one(
    `select supplier_id, supplier_name, total_cost from goods_receipt where id = $1`,
    [r.id],
  )
  const usable = (await one(`select usable_stock($1, $2) as n`, [t97.amox, t97.main])).n
  const nurse = await codeAs(staff.nurse, `select add_stock($1::jsonb)`, [
    JSON.stringify([
      { item_id: t97.amox, batch_no: 'N-97', expiry: t97.day.d, quantity: 1, unit_cost: 1 },
    ]),
  ])
  const otherStore = await codeAs(staff.pharmacist, `select add_stock($1::jsonb, $2)`, [
    JSON.stringify([
      { item_id: t97.amox, batch_no: 'P2-97', expiry: t97.day.d, quantity: 1, unit_cost: 1 },
    ]),
    t82.ph2,
  ])
  if (
    r.lines.length !== 2 ||
    r.lines[0].item_id !== t97.amox ||
    r.lines[0].quantity !== 100 ||
    !r.lines[0].price_updated ||
    !r.lines[1].created ||
    Number(r.total_cost) !== 17000 ||
    gz.kind !== 'supply' ||
    !/^SUP-/.test(gz.code) ||
    Number(gz.price) !== 800 ||
    Number(amoxPrice) !== 350 ||
    grn.supplier_id !== null ||
    grn.supplier_name !== null ||
    Number(grn.total_cost) !== 17000 ||
    usable !== 100 ||
    nurse !== '42501' ||
    otherStore !== '42501'
  )
    throw new Error(JSON.stringify({ r, gz, amoxPrice, grn, usable, nurse, otherStore }))
  return `GRN ${r.number} without supplier: 100 + 10 (new supply ${gz.code}); 17,000 cost; price 300 → 350`
})
await step(
  '0097 A: an expiry already past and a batch with another expiry are refused',
  async () => {
    const line = (x) => JSON.stringify([{ item_id: t97.amox, quantity: 5, unit_cost: 100, ...x }])
    const past = await hintAs(staff.pharmacist, `select add_stock($1::jsonb)`, [
      line({ batch_no: 'OLD-97X', expiry: '2020-01-01' }),
    ])
    const other = await hintAs(staff.pharmacist, `select add_stock($1::jsonb)`, [
      line({ batch_no: 'AMX-97', expiry: t97.day.soon }),
    ])
    // the nurse of Pharmacy 85 allowed to manage stock, without the price right: a different price is not applied
    await except87(t85.nurse, 'stock.write', true)
    await as(t85.nurse)
    const r = (
      await one(`select add_stock($1::jsonb) as j`, [
        line({ batch_no: 'AMX-97B', expiry: t97.day.d, sell_price: 999 }),
      ])
    ).j
    await asAdmin()
    await except87(t85.nurse, 'stock.write', null)
    const price = (await one(`select pf.price from price_for(null, $1, null) pf`, [t97.amox])).price
    if (
      past !== '22023/expired_date' ||
      other !== '22023/batch_expiry' ||
      !r.lines[0].price_ignored ||
      r.lines[0].price_updated ||
      Number(price) !== 350
    )
      throw new Error(JSON.stringify({ past, other, r, price }))
    return `past: ${past}; other expiry: ${other}; price 999 ignored without the right`
  },
)
await step('0097 A: receive_delivery still works, its supplier now optional', async () => {
  await as(staff.pharmacist)
  const d = (
    await one(`select receive_delivery(null, null, $1::jsonb) as j`, [
      JSON.stringify([
        {
          itemId: t97.amox,
          unit: 'unit',
          quantity: 2,
          cost: 100,
          batchNo: 'AMX-97D',
          expiry: t97.day.d,
        },
      ]),
    ])
  ).j
  await asAdmin()
  const g = await one(`select supplier_id, supplier_name from goods_receipt where id = $1`, [d.id])
  if (
    !/^GRN-/.test(d.number) ||
    d.units !== 2 ||
    g.supplier_id !== null ||
    g.supplier_name !== null
  )
    throw new Error(JSON.stringify({ d, g }))
  return `${d.number} without a supplier`
})
await step('0097 B: give 10 of 20, then the rest; the bill charges what was given', async () => {
  t97.v = await visit87('Pharmacy 97')
  const rx = async (q) =>
    (
      await one(
        `insert into medication_request (encounter_id, item_id, quantity, supply, prescriber_id)
         values ($1, $2, $3, 'pharmacy', $4) returning id`,
        [t97.v.enc, t97.amox, q, d1],
      )
    ).id
  t97.rx1 = await rx(20)
  t97.rx2 = await rx(20)
  await as(staff.pharmacist)
  const part = (await one(`select dispense_prescription($1, null, 10) as j`, [t97.rx1])).j
  const q = (await one(`select pharmacy_queue() as j`)).j
  await asAdmin()
  const line = q.lines.find((x) => x.requestId === t97.rx1)
  const told = await one(
    `select params from notification where kind = 'rx_part_given' and recipient_user = $1
      and params ->> 'requestId' = $2`,
    [d1, t97.rx1],
  )
  const tooMuch = await hintAs(staff.pharmacist, `select dispense_prescription($1, null, 11)`, [
    t97.rx1,
  ])
  await as(staff.pharmacist)
  const rest = (await one(`select dispense_prescription($1) as j`, [t97.rx1])).j
  await asAdmin()
  const m = await one(`select quantity_given, given_at from medication_request where id = $1`, [
    t97.rx1,
  ])
  const billed = (
    await one(
      `select coalesce(sum(l.quantity), 0)::int as n from invoice_line l
        join medication_dispense d on d.id = l.source_id and l.source_type = 'medication_dispense'
       where d.medication_request_id = $1 and l.deleted_at is null`,
      [t97.rx1],
    )
  ).n
  const again = await codeAs(staff.pharmacist, `select dispense_prescription($1)`, [t97.rx1])
  if (
    part.given !== 10 ||
    part.remaining !== 10 ||
    !line ||
    line.given !== 10 ||
    line.remaining !== 10 ||
    Number(line.lineTotal) !== 3500 ||
    told?.params.given !== 10 ||
    told?.params.remaining !== 10 ||
    tooMuch !== '22023/more_than_remaining' ||
    rest.given !== 10 ||
    rest.remaining !== 0 ||
    m.quantity_given !== 20 ||
    !m.given_at ||
    billed !== 20 ||
    again !== '23505'
  )
    throw new Error(JSON.stringify({ part, line, told, tooMuch, rest, m, billed, again }))
  return '10 given (queue: 10 remaining, the prescriber told), then 10: billed 20, closed'
})
await step('0097 B: 5 given, then "not given" closes the remaining 15', async () => {
  await as(staff.pharmacist)
  await db.query(`select dispense_prescription($1, null, 5)`, [t97.rx2])
  await db.query(`select rx_not_given($1, 'out of stock, bought outside')`, [t97.rx2])
  const q = (await one(`select pharmacy_queue() as j`)).j
  await asAdmin()
  const m = await one(
    `select quantity_given, given_at, not_given_at, rx_pending(m) as pending from medication_request m where id = $1`,
    [t97.rx2],
  )
  const told = await one(
    `select params from notification where kind = 'rx_not_given' and recipient_user = $1
      and params ->> 'requestId' = $2`,
    [d1, t97.rx2],
  )
  const after = await codeAs(staff.pharmacist, `select dispense_prescription($1)`, [t97.rx2])
  if (
    m.quantity_given !== 5 ||
    m.given_at ||
    !m.not_given_at ||
    m.pending ||
    q.lines.some((x) => x.requestId === t97.rx2) ||
    told?.params.given !== 5 ||
    told?.params.remaining !== 15 ||
    after !== '23505'
  )
    throw new Error(JSON.stringify({ m, told, after }))
  return 'off the list; the prescriber told 5 given, 15 not'
})
await step('0097 C: the pharmacist takes a walk-in payment, not a visit payment', async () => {
  await as(staff.pharmacist)
  const s = (
    await one(`select create_counter_sale($1::jsonb, 'Walk-in 97') as j`, [
      JSON.stringify([{ itemId: t97.amox, quantity: 2 }]),
    ])
  ).j
  const paid = (await one(`select take_counter_payment($1, 'cash') as j`, [s.id])).j
  const h = (await one(`select hand_over_counter_sale($1) as j`, [s.id])).j
  const day = (await one(`select cashier_summary() as j`)).j
  const count = (await one(`select close_cash_day(null, '{"cash":"700"}'::jsonb) as j`)).j
  await asAdmin()
  const pay = await one(`select cashier_id, amount from payment where id = $1`, [paid.paymentId])
  const toldPharmacy = (
    await one(
      `select count(*)::int as n from notification where kind = 'counter_sale_paid' and params ->> 'saleId' = $1`,
      [s.id],
    )
  ).n
  const visit = await hintAs(staff.pharmacist, `select take_payment($1, 'cash', 1000)`, [t97.v.enc])
  const nurse = await hintAs(staff.nurse, `select take_counter_payment($1, 'cash')`, [s.id])
  if (
    !/^RCT-/.test(paid.receipt ?? '') ||
    pay.cashier_id !== staff.pharmacist ||
    Number(pay.amount) !== 700 ||
    h.status !== 'handed_over' ||
    day.scope !== 'mine' ||
    Number(day.myExpected.cash) < 700 ||
    !day.payments.some((x) => x.counterSale === s.number && x.mine) ||
    Number(count.variance) !== 0 ||
    toldPharmacy !== 0 ||
    !visit.startsWith('42501') ||
    !nurse.startsWith('42501')
  )
    throw new Error(
      JSON.stringify({ paid, pay, h, day: day.scope, count, toldPharmacy, visit, nurse }),
    )
  return `walk-in paid at the pharmacy (${paid.receipt}), in the pharmacist's own count; a visit bill refused`
})
await step('0097 D: the room confirms a transfer note with one click (Received all)', async () => {
  await as(staff.pharmacist)
  const note = (
    await one(`select send_to_room($1, $2::jsonb) as j`, [
      t83.office,
      JSON.stringify([{ itemId: t97.amox, quantity: 3 }]),
    ])
  ).j
  await as(d2)
  await db.query(`select confirm_receipt($1)`, [note.id])
  await asAdmin()
  const st = (await one(`select status from stock_transfer where id = $1`, [note.id])).status
  const inRoom = (await one(`select usable_stock($1, $2) as n`, [t97.amox, t83.office])).n
  if (st !== 'received' || inRoom !== 3) throw new Error(JSON.stringify({ st, inRoom }))
  return 'note received in full by its holder; 3 in Dr Office 83'
})
await step(
  '0097 E: alerts: low, expiring (30 d), expired: created once; a daily summary',
  async () => {
    await as(staff.pharmacist)
    await db.query(`select set_reorder_level($1, 500)`, [t97.amox])
    await db.query(`select add_stock($1::jsonb)`, [
      JSON.stringify([
        {
          item_id: t97.amox,
          batch_no: 'AMX-97S',
          expiry: t97.day.soon,
          quantity: 4,
          unit_cost: 100,
        },
      ]),
    ])
    await asAdmin()
    t97.old = (
      await one(
        `insert into batch (item_id, batch_no, expiry, unit_cost) values ($1, 'AMX-97OLD', current_date - 3, 50) returning id`,
        [t97.amox],
      )
    ).id
    await db.query(
      `insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, unit_cost)
     values ($1, $2, $3, 4, 'receipt', 50)`,
      [t97.amox, t97.old, t97.main],
    )
    await as(staff.pharmacist)
    const first = (await one(`select stock_alert_check() as j`)).j
    const second = (await one(`select stock_alert_check() as j`)).j
    await asAdmin()
    const n = async (kind, key) =>
      await one(
        `select count(*)::int as n, bool_and(urgent) as urgent,
                count(*) filter (where recipient_role = 'manager')::int as manager
           from notification where kind = $1 and params ->> 'key' like $2`,
        [kind, key],
      )
    const low = await n('stock_low', `low:${t97.amox}:%`)
    const soon = await n('stock_expiring', 'expiring:%')
    const soonBatch = (
      await one(
        `select count(*)::int as n from notification where kind = 'stock_expiring' and params ->> 'batchNo' = 'AMX-97S'`,
      )
    ).n
    const old = await n('stock_expired', `expired:${t97.old}:%`)
    const summary = await n('stock_summary', 'summary:%')
    if (
      first.low < 1 ||
      first.expiring < 1 ||
      first.expired < 1 ||
      second.created !== 0 ||
      low.n !== 2 ||
      low.manager !== 1 ||
      soonBatch !== 2 ||
      soon.n < 2 ||
      old.n !== 2 ||
      !old.urgent ||
      summary.n !== 2 ||
      summary.manager !== 1
    )
      throw new Error(JSON.stringify({ first, second, low, soon, soonBatch, old, summary }))
    return `low ${first.low}, expiring ${first.expiring}, expired ${first.expired}: one notice each to the manager and the pharmacy; again: 0`
  },
)
await step('0097 F: totals, margin, message to the manager, the expiry window', async () => {
  await as(staff.pharmacist)
  const tot = (await one(`select stock_totals() as j`)).j
  const sales = (await one(`select stock_sales(current_date, current_date) as j`)).j
  await as(d2)
  const room = (await one(`select stock_totals($1) as j`, [t83.office])).j
  await asAdmin()
  const notHolder = await codeAs(d3, `select stock_totals($1)`, [t83.office])
  await as(staff.nurse)
  await db.query(`select message_manager('Please order gloves 97')`)
  await asAdmin()
  const short = await codeAs(staff.nurse, `select message_manager('hi')`)
  const msg = await one(
    `select recipient_role::text as r, params from notification where kind = 'staff_message'
      and params ->> 'text' = 'Please order gloves 97'`,
  )
  await as(staff.manager)
  await db.query(`select save_setting('stock.expiry_days', '60'::jsonb)`)
  const days60 = (await one(`select stock_expiry_days() as n`)).n
  const ov = (await one(`select stock_overview() as j`)).j
  await asAdmin()
  const bad = await codeAs(staff.manager, `select save_setting('stock.expiry_days', '0'::jsonb)`)
  await as(staff.manager)
  await db.query(`select save_setting('stock.expiry_days', '30'::jsonb)`)
  await asAdmin()
  if (
    !(Number(tot.inventory_cost) > 0) ||
    !(Number(tot.selling_value) > 0) ||
    tot.expired_units < 4 ||
    tot.expiring_30 < 1 ||
    tot.low < 1 ||
    tot.expiry_days !== 30 ||
    room.inventory_cost !== null ||
    room.items < 1 ||
    notHolder !== '42501' ||
    !(Number(sales.revenue) > 0) ||
    Number(sales.margin) !== Number(sales.revenue) - Number(sales.cost) ||
    msg?.r !== 'manager' ||
    msg.params.fromId !== staff.nurse ||
    short !== '22023' ||
    days60 !== 60 ||
    ov.expiryDays !== 60 ||
    bad !== '22023'
  )
    throw new Error(JSON.stringify({ tot, room, notHolder, sales, msg, short, days60, bad }))
  return `inventory ${tot.inventory_cost} at cost, ${tot.selling_value} to sell; margin ${sales.margin}; message to the managers; window 60 then 30`
})

// ---------------------------------------------------------------- 0098 the official list, versioned
const t98 = {}
await step(
  '0098 A: the June list is a versioned list; the view reads the list in effect',
  async () => {
    await asAdmin()
    const lists = await one(
      `select count(*)::int as n, min(name) as name, min(effective_from)::text as eff, min(status) as status,
            min(rows)::int as rows from reference_list`,
    )
    const view = (await one(`select count(*)::int as n from medicine_reference`)).n
    const follows = (
      await db.query(`select code from payer where follows_reference_list order by code`)
    ).rows.map((r) => r.code)
    if (
      lists.n !== 1 ||
      lists.name !== 'RHIA June 2026' ||
      lists.eff !== '2026-06-01' ||
      lists.status !== 'current' ||
      lists.rows !== view ||
      view < 1400 ||
      !'CBHI MMI RAMA'.split(' ').every((c) => follows.includes(c)) ||
      ['CASH', 'BRITAM', 'PRIME', 'RADIANT'].some((c) => follows.includes(c))
    )
      throw new Error(JSON.stringify({ lists, view, follows }))
    t98.n = view
    return `${view} rows, current; RAMA, MMI and CBHI follow the list`
  },
)
await step(
  '0098 B: the preview counts new, changed, removed, unchanged and the bad rows',
  async () => {
    await asAdmin()
    const picks = (
      await db.query(
        `select code, generic, presentation, price from medicine_reference r
        where not exists (select 1 from item i where i.code = r.code) and price is not null and price <> 1000
        order by code limit 2`,
      )
    ).rows
    t98.keep = picks[0]
    t98.gone = picks[1]
    await as(staff.manager)
    t98.item = (
      await one(`select upsert_item(null, $1, 1300, $2, null, 'Tablet', true, $3) as id`, [
        t98.keep.generic,
        t98.keep.presentation,
        t98.keep.code,
      ])
    ).id
    t98.goneItem = (
      await one(`select upsert_item(null, $1, 500, $2, null, 'Tablet', true, $3) as id`, [
        t98.gone.generic,
        t98.gone.presentation,
        t98.gone.code,
      ])
    ).id
    await asAdmin()
    const all = (
      await db.query(
        `select code, generic, presentation, prescribing_rule as rule, unit, price, atc_group as "group"
         from medicine_reference order by code`,
      )
    ).rows
    t98.rows = all
      .filter((r) => r.code !== t98.gone.code)
      .map((r, i) => ({
        ...r,
        row: i + 11,
        price: r.code === t98.keep.code ? 1000 : r.price == null ? null : Number(r.price),
      }))
    t98.rows.push(
      {
        row: 5001,
        code: 'T98NEW001',
        generic: 'Testamol 98',
        presentation: 'TESTAMOL 98 tablet',
        unit: 'TABLET',
        price: 250,
      },
      { row: 5002, code: '', generic: 'No code' },
      { row: 5003, code: 'T98BAD', generic: 'Bad price', price: '-4' },
      { row: 5004, code: t98.keep.code, generic: 'Twice', price: 7 },
    )
    await as(staff.manager)
    const p = (
      await one(
        `select import_reference_list('RHIA December 2026', current_date, $1::jsonb) as j`,
        [JSON.stringify(t98.rows)],
      )
    ).j
    await asAdmin()
    const lists = (await one(`select count(*)::int as n from reference_list`)).n
    const changed = p.changed.find((c) => c.code === t98.keep.code)
    const errs = p.errors.map((e) => `${e.row}:${e.code}`).join(',')
    if (
      !p.dryRun ||
      p.new !== 1 ||
      p.changed.length !== 1 ||
      Number(changed?.old) !== Number(t98.keep.price) ||
      Number(changed?.new) !== 1000 ||
      !changed.inClinic ||
      p.removed.length !== 1 ||
      p.removed[0].code !== t98.gone.code ||
      !p.removed[0].inClinic ||
      p.unchanged !== t98.n - 2 ||
      errs !== '5002:no_code,5003:bad_price,5004:duplicate' ||
      p.rows !== t98.n ||
      p.current?.name !== 'RHIA June 2026' ||
      lists !== 1
    )
      throw new Error(
        JSON.stringify({ ...p, changed: p.changed.slice(0, 3), removed: p.removed, lists }),
      )
    return `new 1, changed 1 (${changed.old} → 1000), removed 1, unchanged ${p.unchanged}, 3 bad rows; nothing stored`
  },
)
await step(
  '0098 C: only the manager uploads; a list cannot start before the current one',
  async () => {
    const rows = JSON.stringify([{ code: 'X1', generic: 'X' }])
    const pharm = await codeAs(
      staff.pharmacist,
      `select import_reference_list('X', current_date, $1::jsonb)`,
      [rows],
    )
    const early = await codeAs(
      staff.manager,
      `select import_reference_list('X', date '2026-05-01', $1::jsonb, false)`,
      [rows],
    )
    const noName = await codeAs(
      staff.manager,
      `select import_reference_list('  ', current_date, $1::jsonb)`,
      [rows],
    )
    if (pharm !== '42501' || early !== '22023' || noName !== '22023')
      throw new Error(JSON.stringify({ pharm, early, noName }))
    return 'pharmacist 42501; before June 22023; no name 22023'
  },
)
await step(
  '0098 D: using the list makes it current, keeps the old one, flags what left it',
  async () => {
    await as(staff.manager)
    const r = (
      await one(
        `select import_reference_list('RHIA December 2026', current_date, $1::jsonb, false) as j`,
        [JSON.stringify(t98.rows)],
      )
    ).j
    const shown = (await one(`select reference_lists() as j`)).j
    await asAdmin()
    const lists = (
      await db.query(`select name, status, rows from reference_list order by uploaded_at`)
    ).rows
    const oldRows = (
      await one(
        `select count(*)::int as n from medicine_reference_entry e join reference_list l on l.id = e.list_id
        where l.name = 'RHIA June 2026'`,
      )
    ).n
    const view = await one(
      `select count(*)::int as n, count(*) filter (where code = 'T98NEW001')::int as added,
            count(*) filter (where code = $1)::int as gone from medicine_reference`,
      [t98.gone.code],
    )
    const flags = await one(
      `select (select reference_removed_at is not null from item where id = $1) as gone,
            (select reference_removed_at is null from item where id = $2) as kept`,
      [t98.goneItem, t98.item],
    )
    const direct = await codeAs(
      staff.manager,
      `update item set reference_removed_at = null where id = $1`,
      [t98.goneItem],
    )
    if (
      r.dryRun ||
      !r.id ||
      r.itemsFlagged !== 1 ||
      JSON.stringify(lists.map((l) => l.status)) !== '["past","current"]' ||
      lists[1].rows !== t98.n ||
      oldRows !== t98.n ||
      view.n !== t98.n ||
      view.added !== 1 ||
      view.gone !== 0 ||
      !flags.gone ||
      !flags.kept ||
      direct !== '42501' ||
      shown[0]?.name !== 'RHIA December 2026' ||
      shown[0]?.status !== 'current' ||
      !shown[0]?.inEffect ||
      shown[1]?.status !== 'past'
    )
      throw new Error(
        JSON.stringify({
          r: { ...r, changed: null, removed: null },
          lists,
          oldRows,
          view,
          flags,
          direct,
          shown,
        }),
      )
    return `December current (${t98.n} rows), June kept as past (${oldRows}); 1 clinic medicine flagged`
  },
)
await step(
  '0098 E: an insurer that follows the list pays the list price; cash keeps the clinic price',
  async () => {
    await asAdmin()
    const pf = async (payer, at = null) =>
      Number(
        (
          await one(
            `select price from price_for(null, $1, (select id from payer where code = $2), coalesce($3::date, current_date))`,
            [t98.item, payer, at],
          )
        )?.price,
      )
    const rama = await pf('RAMA')
    const mmi = await pf('MMI')
    const britam = await pf('BRITAM')
    const cash = await pf('CASH')
    const none = Number(
      (await one(`select price from price_for(null, $1, null)`, [t98.item])).price,
    )
    // the day before the new list: the June price
    const before = await pf('RAMA', new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))
    // removed from the list: the cash price
    const gone = Number(
      (
        await one(
          `select price from price_for(null, $1, (select id from payer where code = 'RAMA'))`,
          [t98.goneItem],
        )
      ).price,
    )
    // the bill: a RAMA visit, the medicine charged, 85 % on 1,000
    const v = await visitAt('Loren 98')
    const cov = (
      await one(
        `insert into coverage (patient_id, payer_id, plan_id, member_number)
       select e.patient_id, p.id, pl.id, 'RAMA-98-0001' from encounter e, payer p join plan pl on pl.payer_id = p.id
        where e.id = $1 and p.code = 'RAMA' returning id`,
        [v.enc],
      )
    ).id
    await db.query(
      `update invoice set coverage_id = $2, payer_id = (select id from payer where code = 'RAMA') where encounter_id = $1`,
      [v.enc, cov],
    )
    await db.query(`select add_charge_internal($1, 'pharmacy', null, $2, 2)`, [v.enc, t98.item])
    const line = await one(
      `select l.unit_price, l.coverage_pct, l.insurer_share, l.patient_share from invoice_line l
       join invoice i on i.id = l.invoice_id where i.encounter_id = $1 and l.item_id = $2 and l.deleted_at is null`,
      [v.enc, t98.item],
    )
    if (
      rama !== 1000 ||
      mmi !== 1000 ||
      britam !== 1300 ||
      cash !== 1300 ||
      none !== 1300 ||
      before !== Number(t98.keep.price) ||
      gone !== 500 ||
      Number(line?.unit_price) !== 1000 ||
      Number(line.coverage_pct) !== 85 ||
      Number(line.insurer_share) !== 1700 ||
      Number(line.patient_share) !== 300
    )
      throw new Error(JSON.stringify({ rama, mmi, britam, cash, none, before, gone, line }))
    return `RAMA/MMI 1,000 (list), Britam/cash 1,300; the day before ${before}; bill 2 × 1,000 → 1,700 / 300`
  },
)
await step(
  '0098 F: a medicine added from the list keeps the list code; a new insurer of the kind follows',
  async () => {
    await as(staff.pharmacist)
    const r = (
      await one(`select add_stock($1::jsonb) as j`, [
        JSON.stringify([
          {
            new_item: {
              name: 'Testamol 98',
              strength: 'TESTAMOL 98 tablet',
              kind: 'medicine',
              unit: 'tablet',
              code: 'T98NEW001',
            },
            batch_no: 'T98-A',
            expiry: '2031-01-31',
            quantity: 10,
            unit_cost: 100,
            sell_price: 300,
          },
        ]),
      ])
    ).j
    const notOnList = await codeAs(staff.pharmacist, `select add_stock($1::jsonb)`, [
      JSON.stringify([
        {
          new_item: { name: 'Nolist 98', kind: 'medicine', code: 'T98NOPE' },
          batch_no: 'T98-B',
          expiry: '2031-01-31',
          quantity: 1,
          unit_cost: 1,
        },
      ]),
    ])
    await asAdmin()
    const it = await one(`select code, source from item where id = $1`, [r.lines[0].item_id])
    const ramaPrice = Number(
      (
        await one(
          `select price from price_for(null, $1, (select id from payer where code = 'RAMA'))`,
          [r.lines[0].item_id],
        )
      ).price,
    )
    const added = (
      await one(
        `insert into payer (code, name, type) values ('MMI98', 'MMI 98', 'mmi') returning follows_reference_list as f`,
      )
    ).f
    if (
      it.code !== 'T98NEW001' ||
      it.source !== 'RHIA December 2026' ||
      ramaPrice !== 250 ||
      notOnList !== 'P0002' ||
      !added
    )
      throw new Error(JSON.stringify({ it, ramaPrice, notOnList, added }))
    return 'item T98NEW001 (RAMA 250, cash 300); a code not on the list refused; a new MMI insurer follows'
  },
)

// ---------------------------------------------------------------- 0099 my bookings
const t99 = {}
await step('0099 A: the nurse lists her own bookings, waiting ones first to answer', async () => {
  await as(staff.receptionist)
  const r = (
    await one(
      `select register_patient_file('Mukeshimana', 'My Bookings', 'female', null, 30, null) as r`,
    )
  ).r
  t99.appt = (
    await one(
      `select book_appointment($1, $2, date_trunc('day', now()) + interval '2 days 10 hours', 'Wound check') as id`,
      [r.patient_id, staff.nurse],
    )
  ).id
  await as(staff.nurse)
  const mine = (await one(`select my_bookings() as j`)).j
  await asAdmin()
  const row = mine.rows.find((x) => x.id === t99.appt)
  if (mine.userId !== staff.nurse || !row) throw new Error(JSON.stringify(mine).slice(0, 300))
  if (
    row.status !== 'approved' ||
    row.reason !== 'Wound check' ||
    row.name !== 'Mukeshimana My Bookings'
  )
    throw new Error(JSON.stringify(row))
  if (!row.bookedBy || row.history.length < 1 || row.history.at(-1).status !== 'approved')
    throw new Error(JSON.stringify(row.history))
  return `${mine.rows.length} rows; waiting, booked by ${row.bookedBy}; ${row.history.length} history steps`
})
await step('0099 B: accepted at another time: confirmed, the move in its history', async () => {
  await as(staff.nurse)
  await db.query(
    `select accept_appointment($1, date_trunc('day', now()) + interval '2 days 11 hours')`,
    [t99.appt],
  )
  const mine = (await one(`select my_bookings(current_date - 1, current_date + 21) as j`)).j
  await asAdmin()
  const row = mine.rows.find((x) => x.id === t99.appt)
  if (!row || row.status !== 'confirmed' || !row.acceptedBy) throw new Error(JSON.stringify(row))
  const moved = row.history.find((h) => h.moved)
  if (!moved || moved.status !== 'confirmed') throw new Error(JSON.stringify(row.history))
  return `confirmed by ${row.acceptedBy}; history: ${row.history.map((h) => h.status + (h.moved ? ' (moved)' : '')).join(' → ')}`
})
await step('0099 C: the manager sees a colleague’s bookings; others do not', async () => {
  await as(staff.manager)
  const seen = (await one(`select my_bookings(null, null, $1) as j`, [staff.nurse])).j
  await asAdmin()
  const doctor = await codeAs(staff.doctor, `select my_bookings(null, null, $1)`, [staff.nurse])
  const desk = await codeAs(staff.receptionist, `select my_bookings()`)
  const backwards = await codeAs(staff.nurse, `select my_bookings(current_date, current_date - 1)`)
  if (!seen.rows.some((x) => x.id === t99.appt) || seen.userId !== staff.nurse)
    throw new Error('the manager does not see the nurse’s booking')
  if (doctor !== '42501' || desk !== '42501' || backwards !== '22023')
    throw new Error(JSON.stringify({ doctor, desk, backwards }))
  return 'manager sees it; a doctor and reception refused; a backwards period refused'
})

// ---------------------------------------------------------------- 0100 medicines bought outside
const t100 = {}
// the 0089 and 0092 steps re-ran older migrations: put the 0100 definitions back (it runs twice)
await step('0100: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261210090000_outside_prescriptions.sql'), 'utf8'),
  )
  return 'no error'
})
await step('0100 A: outside lines: not charged, not at the pharmacy, no stock moved', async () => {
  t100.v = await visitAt('Outside 100')
  t100.ref = await one(
    `select r.code, r.generic from medicine_reference r
        where not exists (select 1 from item i where i.code = r.code) order by r.code limit 1`,
  )
  const stock = async () => (await one(`select usable_stock($1, $2) as n`, [t97.amox, t97.main])).n
  const before = await stock()
  const billed = async () =>
    (
      await one(
        `select count(*)::int as n from invoice_line l join invoice i on i.id = l.invoice_id
            where i.encounter_id = $1 and l.deleted_at is null and l.item_id is not null`,
        [t100.v.enc],
      )
    ).n
  await as(d1)
  await db.query(`select take_patient($1)`, [t100.v.queue])
  await db.query(`select add_diagnosis($1, 'Otitis', 'H66', 'primary')`, [t100.v.enc])
  const rx = async (args) =>
    (
      await one(
        `select prescribe(p_encounter_id => $1, p_item_id => $2, p_quantity => $3, p_supply => $4,
                  p_medicine_name => $5, p_reference_code => $6, p_dose => '1 cap', p_frequency => 'TDS',
                  p_duration_days => 5) as j`,
        args,
      )
    ).j
  const clinic = await rx([t100.v.enc, t97.amox, 15, 'outside', null, null])
  const listed = await rx([t100.v.enc, null, 2, 'outside', null, t100.ref.code])
  const typed = await rx([t100.v.enc, null, 1, 'outside', 'Ear drops 100', null])
  const noName = await hintAs(
    d1,
    `select prescribe($1, null, 1, null, null, null, null, null, 'outside')`,
    [t100.v.enc],
  )
  const notHere = await hintAs(
    d1,
    `select prescribe($1, null, 1, null, null, null, null, null, 'pharmacy', null, null, 'X')`,
    [t100.v.enc],
  )
  await as(d1)
  const stockSeen = (await one(`select rx_stock() as j`)).j
  const vc = (await one(`select visit_clinical($1) as j`, [t100.v.enc])).j
  const mine = (await one(`select my_prescriptions(1) as j`)).j
  await as(staff.pharmacist)
  const q = (await one(`select pharmacy_queue() as j`)).j
  const giveOutside = await codeAs(staff.pharmacist, `select dispense_prescription($1)`, [
    clinic.id,
  ])
  await asAdmin()
  t100.clinic = clinic.id
  t100.typed = typed.id
  const lines = vc.prescriptions
  const atPharmacy = (
    await one(
      `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'pharmacy' and finished_at is null`,
      [t100.v.enc],
    )
  ).n
  const row = await one(
    `select medicine_name, reference_code, supply_set_by from medication_request where id = $1`,
    [listed.id],
  )
  if (
    clinic.supply !== 'outside' ||
    clinic.charged ||
    clinic.stockTaken ||
    clinic.medicineName !== 'Amoxicillin 97 500 mg' ||
    row.medicine_name !== t100.ref.generic ||
    row.reference_code !== t100.ref.code ||
    row.supply_set_by !== d1 ||
    typed.medicineName !== 'Ear drops 100' ||
    noName !== '22023/' ||
    notHere !== '22023/' ||
    (await billed()) !== 0 ||
    (await stock()) !== before ||
    atPharmacy !== 0 ||
    q.lines.some((x) => x.encounterId === t100.v.enc) ||
    giveOutside !== '23505' ||
    Number(stockSeen.items[t97.amox] ?? 0) !== before ||
    lines.length !== 3 ||
    !lines.every((x) => x.supply === 'outside' && x.pending === false && !x.dispensed) ||
    !lines.some((x) => x.item === 'Ear drops 100' && x.itemId === null) ||
    mine.find((x) => x.id === typed.id)?.state !== 'outside'
  )
    throw new Error(
      JSON.stringify({
        clinic,
        listed,
        typed,
        row,
        noName,
        notHere,
        atPharmacy,
        stockSeen,
        lines,
        giveOutside,
      }),
    )
  return `3 outside lines (clinic, list ${t100.ref.code}, typed): no bill line, stock ${before} kept, no pharmacy place`
})
await step(
  '0100 B: the prescriber moves a line to and from the pharmacy; the pharmacist may not',
  async () => {
    await as(d1)
    const p = (
      await one(`select prescribe($1, $2, 6, null, null, null, null, null, 'pharmacy') as j`, [
        t100.v.enc,
        t97.amox,
      ])
    ).j
    await asAdmin()
    const pharmacist = await codeAs(staff.pharmacist, `select rx_set_supply($1, 'outside')`, [p.id])
    const other = await codeAs(d2, `select rx_set_supply($1, 'outside')`, [p.id])
    const typedBack = await codeAs(d1, `select rx_set_supply($1, 'pharmacy')`, [t100.typed])
    await as(staff.pharmacist)
    const q1 = (await one(`select pharmacy_queue() as j`)).j
    await as(d1)
    const out = (await one(`select rx_set_supply($1, 'outside', 'none in stock') as j`, [p.id])).j
    await as(staff.pharmacist)
    const q2 = (await one(`select pharmacy_queue() as j`)).j
    await as(d1)
    const back = (await one(`select rx_set_supply($1, 'pharmacy') as j`, [t100.clinic])).j
    await as(staff.pharmacist)
    const q3 = (await one(`select pharmacy_queue() as j`)).j
    await asAdmin()
    const told = await one(
      `select count(*)::int as n from notification where kind = 'rx_outside' and 'pharmacy' = any(recipient_stations)
        and params ->> 'requestId' = $1`,
      [p.id],
    )
    const row = await one(
      `select supply, supply_reason, supply_set_by from medication_request where id = $1`,
      [p.id],
    )
    if (
      pharmacist !== '42501' ||
      other !== '42501' ||
      typedBack !== '22023' ||
      !q1.lines.some((x) => x.requestId === p.id) ||
      out.supply !== 'outside' ||
      out.pending !== 0 ||
      q2.lines.some((x) => x.requestId === p.id) ||
      told.n !== 1 ||
      row.supply !== 'outside' ||
      row.supply_reason !== 'none in stock' ||
      row.supply_set_by !== d1 ||
      back.supply !== 'pharmacy' ||
      back.pending !== 1 ||
      !q3.lines.some((x) => x.requestId === t100.clinic)
    )
      throw new Error(JSON.stringify({ pharmacist, other, typedBack, out, told, row, back }))
    t100.p = p.id
    return 'pharmacist and another doctor refused; out of the queue (pharmacy told), back in the queue'
  },
)
await step(
  '0100 C: "not given" tells the prescriber, who sends it outside; finishing does not wait for it',
  async () => {
    await as(staff.pharmacist)
    await db.query(`select rx_not_given($1, 'out of stock')`, [t100.clinic])
    await asAdmin()
    const told = await one(
      `select params from notification where kind = 'rx_not_given' and params ->> 'requestId' = $1`,
      [t100.clinic],
    )
    await as(d1)
    const out = (await one(`select rx_set_supply($1, 'outside') as j`, [t100.clinic])).j
    await db.query(`select finish_visit($1)`, [t100.v.enc])
    await asAdmin()
    const row = await one(
      `select supply, not_given_at is not null as ng, rx_pending(m) as pending from medication_request m where id = $1`,
      [t100.clinic],
    )
    const open = await openStations82(t100.v.enc)
    const lines = (
      await one(
        `select count(*)::int as n from invoice_line l join invoice i on i.id = l.invoice_id
          where i.encounter_id = $1 and l.deleted_at is null and l.item_id is not null`,
        [t100.v.enc],
      )
    ).n
    if (
      told?.params.outside !== true ||
      typeof told?.params.noStock !== 'boolean' ||
      out.supply !== 'outside' ||
      row.supply !== 'outside' ||
      row.pending ||
      open.includes('pharmacy') ||
      open.includes('consultation') ||
      lines !== 0
    )
      throw new Error(JSON.stringify({ told, out, row, open, lines }))
    return `prescriber told (no stock: ${told.params.noStock}); sent outside; finished: ${open.join(', ') || 'closed'}`
  },
)
await step('0100 D: "Prescribed but bought outside" for the pharmacy and the manager', async () => {
  await as(staff.pharmacist)
  const r = (await one(`select rx_bought_outside(current_date - 1, current_date + 1) as j`)).j
  await asAdmin()
  const doctor = await codeAs(d1, `select rx_bought_outside(current_date, current_date)`)
  const amox = r.find((x) => x.itemId === t97.amox)
  const typed = r.find((x) => x.name === 'Ear drops 100')
  if (
    !amox ||
    amox.times !== 2 ||
    Number(amox.quantity) !== 21 ||
    amox.notGiven !== 1 ||
    !typed ||
    typed.inClinic ||
    doctor !== '42501'
  )
    throw new Error(JSON.stringify({ r, doctor }))
  return `${r.length} medicines; ${amox.name}: ${amox.times} times, ${amox.quantity} units; a doctor refused`
})
await step('0100 E: an outside line is cancelled by its prescriber', async () => {
  await as(d1)
  const c = (await one(`select cancel_prescription($1, 'wrong medicine 100') as j`, [t100.typed])).j
  await asAdmin()
  const m = await one(
    `select cancelled_at is not null as c from medication_request where id = $1`,
    [t100.typed],
  )
  const told = await one(
    `select count(*)::int as n from notification where kind = 'rx_cancelled' and params ->> 'reason' = 'wrong medicine 100'`,
  )
  if (!m.c || c.pending !== 0 || told.n !== 0) throw new Error(JSON.stringify({ c, m, told }))
  return 'cancelled; the pharmacy not told (it never had it)'
})

// ---------------------------------------------------------------- 0101: a booking is Seen only when seen
const t101 = {}
const booked101 = async (given) => {
  await as(staff.receptionist)
  const r = (
    await one(`select register_patient_file('Uwase', $1, 'female', null, 30, null) as r`, [given])
  ).r
  await asAdmin()
  const pr = (await one(`select ensure_practitioner($1) as id`, [d2])).id
  const appt = (
    await one(
      `insert into appointment (patient_id, practitioner_id, starts_at, status, source)
       values ($1, $2, now() + interval '20 minutes', 'confirmed', 'reception') returning id`,
      [r.patient_id, pr],
    )
  ).id
  await as(staff.receptionist)
  const v = (await one(`select appointment_arrived($1) as v`, [appt])).v
  await asAdmin()
  const q = await one(
    `select id from queue_entry where encounter_id = $1 and station = 'consultation' and finished_at is null`,
    [v.encounter_id],
  )
  return { appt, enc: v.encounter_id, queue: q?.id }
}
const status101 = async (id) =>
  one(`select status::text, cancel_reason from appointment where id = $1`, [id])
await step('0101: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261211090000_booking_seen_rule.sql'), 'utf8'),
  )
  return 'no error'
})
await step(
  '0101 A: arrived is not Seen; the doctor takes, diagnoses and finishes → Seen',
  async () => {
    const b = await booked101('Claudine 101')
    const arrived = await status101(b.appt)
    await as(d2)
    await db.query(`select take_patient($1)`, [b.queue])
    const taken = await status101(b.appt)
    await db.query(`select add_diagnosis($1, 'Malaria', 'B54', 'primary')`, [b.enc])
    await db.query(`select finish_visit($1)`, [b.enc])
    await asAdmin()
    const done = await status101(b.appt)
    if (
      arrived.status !== 'arrived' ||
      taken.status !== 'in_progress' ||
      done.status !== 'completed'
    )
      throw new Error(JSON.stringify({ arrived, taken, done }))
    return 'arrived → in_progress → completed (Seen) only after the doctor finished'
  },
)
await step(
  '0101 B: the patient leaves before anyone takes them → not Seen, left unseen',
  async () => {
    const b = await booked101('Leaves 101')
    await as(staff.manager)
    await db.query(`select end_visit($1, 'could not wait')`, [b.enc]).catch(() => null)
    await asAdmin()
    const a = await status101(b.appt)
    if (a.status !== 'cancelled' || a.cancel_reason !== 'left_unseen: could not wait')
      throw new Error(JSON.stringify(a))
    return `cancelled · ${a.cancel_reason}`
  },
)
await step('0101 C: a wrong "Seen" is corrected when the update runs', async () => {
  await asAdmin()
  const pr = (await one(`select ensure_practitioner($1) as id`, [d2])).id
  const p = await one(`select id from patient order by created_at limit 1`)
  const past = (
    await one(
      `insert into appointment (patient_id, practitioner_id, starts_at, status, source)
       values ($1, $2, now() - interval '3 days', 'completed', 'reception') returning id`,
      [p.id, pr],
    )
  ).id
  const later = (
    await one(
      `insert into appointment (patient_id, practitioner_id, starts_at, status, source)
       values ($1, $2, now() + interval '2 days', 'completed', 'reception') returning id`,
      [p.id, pr],
    )
  ).id
  const b = await booked101('Wrong 101')
  await as(staff.manager)
  await db.query(`select end_visit($1, 'test')`, [b.enc]).catch(() => null)
  await asAdmin()
  // as the old rule left it
  await db.query(
    `update appointment set status = 'completed', cancel_reason = null where id = $1`,
    [b.appt],
  )
  await db.exec(
    await readFile(path.join(migrationsDir, '20261211090000_booking_seen_rule.sql'), 'utf8'),
  )
  const a = await status101(past)
  const c = await status101(later)
  const d = await status101(b.appt)
  if (a.status !== 'no_show' || c.status !== 'confirmed' || d.status !== 'cancelled')
    throw new Error(JSON.stringify({ a, c, d }))
  return 'no visit, past → did not come; no visit, coming → confirmed; left unseen → cancelled'
})

// ---------------------------------------------------------------- 0102 vital signs the clinic chooses
// 0092's check re-ran 20261203 (the old record_vitals) after every migration: 0102 applies again
// on top of it, as it would in a database updated file by file (it is idempotent).
await step('0102: the migration applies again on top of the re-run older ones', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261213090000_vitals_custom.sql'), 'utf8'),
  )
})
const vitals102 = async (enc) => {
  // the view answers whoever may read vital signs (the nurse), not the bare connection
  await as(staff.nurse)
  const rows = (
    await db.query(
      `select code, value_num::text as v, unit, label, id from visit_vitals where encounter_id = $1 order by code`,
      [enc],
    )
  ).rows
  await asAdmin()
  return rows
}
await step(
  '0102 A: a measurement of the new catalogue and a custom one are saved and read back',
  async () => {
    const v = await visit87('Vitals102')
    await as(staff.nurse)
    await db.query(`select record_vitals($1, $2::jsonb)`, [
      v.enc,
      JSON.stringify({
        glucose_mmol: '5.6',
        pain: { value: 4 },
        custom_blood_ketones: { value: 1.2, unit: 'mmol/L', label: 'Blood ketones' },
      }),
    ])
    const rows = await vitals102(v.enc)
    const g = rows.find((r) => r.code === 'glucose_mmol')
    const pn = rows.find((r) => r.code === 'pain')
    const c = rows.find((r) => r.code === 'custom_blood_ketones')
    if (
      rows.length !== 3 ||
      g?.unit !== 'mmol/L' ||
      g?.v !== '5.6' ||
      pn?.unit !== '/10' ||
      c?.unit !== 'mmol/L' ||
      c?.label !== 'Blood ketones' ||
      !c?.id
    )
      throw new Error(json88(rows))
    return 'glucose 5.6 mmol/L (unit from the catalogue), pain 4 /10, custom "Blood ketones" 1.2 mmol/L with id'
  },
)
await step(
  '0102 B: remove_vital takes a measurement off with a reason; the audit keeps the value',
  async () => {
    const v = await visit87('Remove102')
    await as(staff.nurse)
    await db.query(`select record_vitals($1, $2::jsonb)`, [
      v.enc,
      JSON.stringify({
        temp: '37.1',
        custom_blood_ketones: { value: 1.2, unit: 'mmol/L', label: 'Blood ketones' },
      }),
    ])
    const id = (await vitals102(v.enc)).find((r) => r.code === 'custom_blood_ketones').id
    const r = {}
    r.short = await codeAs(staff.nurse, `select remove_vital($1, 'no')`, [id])
    r.unknown = await codeAs(staff.nurse, `select remove_vital($1, 'wrong patient')`, [
      crypto.randomUUID(),
    ])
    r.ok = await codeAs(staff.nurse, `select remove_vital($1, 'typed on the wrong patient')`, [id])
    r.again = await codeAs(staff.nurse, `select remove_vital($1, 'typed on the wrong patient')`, [
      id,
    ])
    const left = (await vitals102(v.enc)).map((x) => x.code)
    const row = await one(
      `select deleted_at is not null as gone, remove_reason, removed_by from observation where id = $1`,
      [id],
    )
    const audit = await one(
      `select count(*)::int as n, max(before ->> 'value') as value, max(reason) as reason
       from audit_event where entity = 'observation' and entity_id = $1 and action = 'delete'`,
      [id],
    )
    if (
      r.short !== '22023' ||
      r.unknown !== 'P0002' ||
      r.ok !== null ||
      r.again !== '22023' ||
      left.join(',') !== 'temp' ||
      !row.gone ||
      row.remove_reason !== 'typed on the wrong patient' ||
      row.removed_by !== staff.nurse ||
      audit.n !== 1 ||
      audit.value !== '1.2' ||
      audit.reason !== 'typed on the wrong patient'
    )
      throw new Error(json88({ r, left, row, audit }))
    return 'short reason and unknown id refused; removed with reason; gone from visit_vitals; audited with the value; a second removal refused'
  },
)
await step(
  '0102 C: a value outside the catalogue limits, an unknown code, a custom one without a name are refused',
  async () => {
    const v = await visit87('Range102')
    const r = {}
    r.glucose = await codeAs(
      staff.nurse,
      `select record_vitals($1, '{"glucose_mmol":"99"}'::jsonb)`,
      [v.enc],
    )
    r.pain = await codeAs(staff.nurse, `select record_vitals($1, '{"pain":"11"}'::jsonb)`, [v.enc])
    r.gcs = await codeAs(staff.nurse, `select record_vitals($1, '{"gcs":{"value":2}}'::jsonb)`, [
      v.enc,
    ])
    r.unknown = await codeAs(staff.nurse, `select record_vitals($1, '{"xyz":"1"}'::jsonb)`, [v.enc])
    r.noName = await codeAs(
      staff.nurse,
      `select record_vitals($1, '{"custom_abc":{"value":1}}'::jsonb)`,
      [v.enc],
    )
    r.badCode = await codeAs(
      staff.nurse,
      `select record_vitals($1, '{"custom_Bad Code":{"value":1,"label":"x"}}'::jsonb)`,
      [v.enc],
    )
    r.ok = await codeAs(
      staff.nurse,
      `select record_vitals($1, '{"pain":"10","gcs":"15","fhr":"240","glucose_mgdl":{"value":"1100"}}'::jsonb)`,
      [v.enc],
    )
    const rows = await vitals102(v.enc)
    if (
      r.glucose !== '22023' ||
      r.pain !== '22023' ||
      r.gcs !== '22023' ||
      r.unknown !== '22023' ||
      r.noName !== '22023' ||
      r.badCode !== '22023' ||
      r.ok !== null ||
      rows.length !== 4
    )
      throw new Error(json88({ r, rows }))
    return 'glucose 99, pain 11, GCS 2, code xyz, custom without a name, bad custom code refused; the limits themselves accepted'
  },
)
await step('0102 D: the default set is saved by the manager and read by every nurse', async () => {
  const r = {}
  await as(staff.nurse)
  r.before = (await one(`select vitals_setting() as s`)).s.codes
  r.nurseSaves = await codeAs(staff.nurse, `select save_vitals_setting('["temp"]'::jsonb)`)
  r.unknown = await codeAs(staff.manager, `select save_vitals_setting('["temp","nope"]'::jsonb)`)
  r.empty = await codeAs(staff.manager, `select save_vitals_setting('[]'::jsonb)`)
  r.twice = await codeAs(staff.manager, `select save_vitals_setting('["temp","temp"]'::jsonb)`)
  r.ok = await codeAs(
    staff.manager,
    `select save_vitals_setting('["temp","pulse","glucose_mmol","bmi"]'::jsonb)`,
  )
  await as(staff.nurse)
  r.after = (await one(`select vitals_setting() as s`)).s.codes
  await asAdmin()
  r.audited = (
    await one(
      `select count(*)::int as n from audit_event where action = 'settings' and after ->> 'key' = 'vitals.default'`,
    )
  ).n
  if (
    r.before.join(',') !== 'bp_sys,bp_dia,pulse,temp,resp,spo2,weight,height,muac' ||
    r.nurseSaves !== '42501' ||
    r.unknown !== '22023' ||
    r.empty !== '22023' ||
    r.twice !== '22023' ||
    r.ok !== null ||
    r.after.join(',') !== 'temp,pulse,glucose_mmol,bmi' ||
    r.audited < 1
  )
    throw new Error(json88(r))
  return "the nine by default; the nurse may not save; unknown, empty and repeated codes refused; the manager's order read back; audited"
})

// ---------------------------------------------------------------- 0105 receipts of a period, patients' documents, analytics per dashboard
const t102r = {}
const json102r = (x) => JSON.stringify(x)
await step(
  '0105 A: receipts_in_period — the period sorted by time with the receipt data; filters by method and cashier; the cashier sees it; a nurse is refused',
  async () => {
    const p = await visitAt('Receipts 102')
    await as(staff.manager)
    const cons = (
      await one(`select upsert_service(null, 'Consultation 102R', 'consultation', 4000) as id`)
    ).id
    await as(d1)
    await db.query(`select take_patient($1)`, [p.queue])
    await db.query(`select add_charge($1, 'consultation', $2)`, [p.enc, cons])
    await db.query(`select add_diagnosis($1, 'Malaria 102R', 'B54')`, [p.enc])
    await db.query(`select finish_station($1, 'consultation', 'cashier')`, [p.enc])
    await as(staff.cashier)
    const r1 = (await one(`select take_payment($1, 'momo', 1500, 'MP102') as r`, [p.enc])).r
    const r2 = (await one(`select take_payment($1, 'cash', 2500) as r`, [p.enc])).r
    t102r.enc = p.enc
    await asAdmin()
    t102r.day = (await one(`select (now() at time zone 'Africa/Kigali')::date::text as d`)).d
    await as(staff.manager)
    const all = (await one(`select receipts_in_period($1, $1) as j`, [t102r.day])).j
    const momo = (await one(`select receipts_in_period($1, $1, null, 'momo') as j`, [t102r.day])).j
    const byCashier = (
      await one(`select receipts_in_period($1, $1, $2) as j`, [t102r.day, staff.cashier])
    ).j
    await as(staff.cashier)
    const mine = (await one(`select receipts_in_period($1, $1) as j`, [t102r.day])).j
    const refused = await tryAs(staff.nurse, `select receipts_in_period($1, $1)`, [t102r.day])
    await asAdmin()
    const ours = all.receipts.filter((x) => x.encounterId === p.enc)
    const sorted = all.receipts.every((x, i, a) => i === 0 || a[i - 1].at <= x.at)
    const r = {
      ours: ours.map((x) => [x.receiptNo, x.method, x.amount, x.paid, x.balance, x.patient.name]),
      lines: ours[0]?.lines,
      total: ours[0]?.total,
      count: all.count,
      sum: all.total,
      sorted,
      momoOnly: momo.receipts.every((x) => x.method === 'momo'),
      momoHasOurs: momo.receipts.some((x) => x.receiptNo === r1.receipt),
      cashierOnly: byCashier.receipts.every((x) => x.cashierId === staff.cashier),
      mine: mine.count,
      refused,
    }
    if (
      ours.length !== 2 ||
      ours[0].receiptNo !== r1.receipt ||
      ours[1].receiptNo !== r2.receipt ||
      Number(ours[0].paid) !== 1500 ||
      Number(ours[0].balance) !== 2500 ||
      Number(ours[1].paid) !== 4000 ||
      Number(ours[1].balance) !== 0 ||
      ours[0].patient.name !== 'Mutoni Receipts 102' ||
      ours[0].lines.length !== 1 ||
      Number(ours[0].lines[0].unitPrice) !== 4000 ||
      Number(ours[0].total) !== 4000 ||
      all.count !== all.receipts.length ||
      !sorted ||
      !r.momoOnly ||
      !r.momoHasOurs ||
      !r.cashierOnly ||
      byCashier.receipts.length < 2 ||
      mine.count < 2 ||
      !/not allowed/.test(refused)
    )
      throw new Error(json102r(r))
    return `${all.count} receipts · RWF ${all.total}; momo ${momo.count}; cashier ${byCashier.count}; nurse refused`
  },
)
await step(
  '0105 B: visits_in_period — the manager sees the period with doctor, diagnosis and status; filters (closed only, doctor, search); a head their department; reception refused',
  async () => {
    await as(staff.manager)
    const q = `select visits_in_period($1, $1, $2, $3, $4, $5, $6, $7) as j`
    const all = (await one(q, [t102r.day, null, null, null, null, false, null])).j
    const closedOnly = (await one(q, [t102r.day, null, null, null, null, true, null])).j
    const byDoc = (await one(q, [t102r.day, null, d1, null, null, false, null])).j
    const otherDoc = (await one(q, [t102r.day, null, d2, null, null, false, null])).j
    const search = (await one(q, [t102r.day, null, null, null, null, false, 'receipts 102'])).j
    const head = await (async () => {
      await as(t86.head)
      try {
        return (await one(`select visits_in_period($1, $1) as j`, [t102r.day])).j
      } catch (e) {
        return { error: e.code }
      }
    })()
    const headElsewhere = await tryAs(t86.head, `select visits_in_period($1, $1, $2)`, [
      t102r.day,
      t102r.deptOther ?? '00000000-0000-0000-0000-000000000000',
    ])
    const reception = await tryAs(staff.receptionist, `select visits_in_period($1, $1)`, [
      t102r.day,
    ])
    await asAdmin()
    const mine = all.visits.find((v) => v.id === t102r.enc)
    const r = {
      count: all.count,
      mine: mine && [mine.patient.name, mine.doctor?.name, mine.diagnosis, mine.status],
      closedOnly: closedOnly.visits.every((v) => v.status === 'closed'),
      closedHasMine: closedOnly.visits.some((v) => v.id === t102r.enc),
      byDoc:
        byDoc.visits.every((v) => v.doctor?.id === d1) &&
        byDoc.visits.some((v) => v.id === t102r.enc),
      otherDoc: otherDoc.visits.some((v) => v.id === t102r.enc),
      search: search.visits.map((v) => v.patient.name),
      options: Object.keys(all.options),
      headCount: head.count ?? head.error,
      headDept: head.department,
      headElsewhere,
      reception,
    }
    if (
      !mine ||
      mine.patient.name !== 'Mutoni Receipts 102' ||
      mine.doctor?.id !== d1 ||
      mine.diagnosis !== 'Malaria 102R' ||
      mine.status !== 'closed' ||
      !r.closedOnly ||
      !r.closedHasMine ||
      !r.byDoc ||
      r.otherDoc ||
      search.visits.length !== 1 ||
      !all.options.doctors.some((d) => d.id === d1) ||
      head.error ||
      head.department !== t86.dept ||
      !/not allowed/.test(headElsewhere) ||
      !/not allowed/.test(reception)
    )
      throw new Error(json102r(r))
    return `${all.count} visits; closed only, by doctor and search filter; head: own department (${head.count}); reception refused`
  },
)
await step(
  '0105 C: visit_documents reads each visit through visit_clinical and logs the opening of a closed visit once, as a single opening does',
  async () => {
    await asAdmin()
    const pid = (await one(`select patient_id from encounter where id = $1`, [t102r.enc]))
      .patient_id
    const logOf = async () =>
      (
        await db.query(
          `select actor_id, via, what from record_access_entry where patient_id = $1 and encounter_id = $2 order by at`,
          [pid, t102r.enc],
        )
      ).rows
    const before = await logOf()
    await as(staff.manager)
    const docs = (await one(`select visit_documents(array[$1]::uuid[]) as j`, [t102r.enc])).j
    await asAdmin()
    const after = await logOf()
    // the same visit opened on its screen right after: the same log line (half an hour), no second one
    await as(staff.manager)
    await one(`select visit_clinical($1) as j`, [t102r.enc])
    await asAdmin()
    const again = await logOf()
    const cashier = await tryAs(staff.cashier, `select visit_documents(array[$1]::uuid[])`, [
      t102r.enc,
    ])
    const d = docs[0]
    const r = {
      n: docs.length,
      view: d?.clinical?.view,
      private: d?.private,
      patient: d?.patient?.name,
      charges: d?.charges?.length,
      diagnoses: d?.clinical?.diagnoses?.length,
      vitals: Array.isArray(d?.vitals),
      logged: after.length - before.length,
      again: again.length - after.length,
      entry: after[after.length - 1],
      cashier,
    }
    if (
      docs.length !== 1 ||
      d.clinical.view !== 'manager' ||
      d.private ||
      d.patient.name !== 'Mutoni Receipts 102' ||
      d.charges.length !== 1 ||
      d.clinical.diagnoses.length !== 1 ||
      !Array.isArray(d.vitals) ||
      r.logged !== 1 ||
      r.again !== 0 ||
      r.entry.actor_id !== staff.manager ||
      r.entry.via !== 'manager' ||
      r.entry.what !== 'visit' ||
      !/not allowed/.test(cashier)
    )
      throw new Error(json102r(r))
    return 'one visit → one log line (manager, visit); the visit screen right after adds none; the cashier refused'
  },
)
await step(
  '0105 D: analytics_access keeps "views" as before and names each dashboard and its views; desk_analytics gives the doctor their own work',
  async () => {
    const access = async (who) => {
      await as(who)
      return (await one(`select analytics_access() as j`)).j
    }
    const m = await access(staff.manager)
    const c = await access(staff.cashier)
    // a plain doctor (d1 leads a department by now, so is a head)
    const d = await access(t86.nobody)
    const n = await access(staff.nurse)
    const r = await access(staff.receptionist)
    const ph = await access(staff.pharmacist)
    const lab = await access(staff.lab_tech)
    const h = await access(t86.head)
    await as(d1)
    const work = (await one(`select desk_analytics($1, $1) as j`, [t102r.day])).j
    await as(staff.cashier)
    const cashWork = (await one(`select desk_analytics($1, $1) as j`, [t102r.day])).j
    await asAdmin()
    const res = {
      manager: [
        m.dashboard,
        m.views.includes('revenue'),
        m.views.includes('receipts'),
        m.dashboardViews[0],
      ],
      cashier: [c.dashboard, c.views.length, c.dashboardViews],
      doctor: [d.dashboard, d.views.length, d.dashboardViews[0]],
      nurse: [n.dashboard, n.dashboardViews.includes('vitals')],
      reception: [r.dashboard, r.dashboardViews.includes('arrivals')],
      pharmacy: [ph.dashboard, ph.dashboardViews.includes('outside')],
      lab: [lab.dashboard, lab.dashboardViews.includes('turnaround')],
      head: [h.dashboard, h.views, h.dashboardViews[0]],
      work: [
        work.counts.patientsSeen,
        work.counts.diagnoses,
        work.records.length,
        !!work.bookings,
        !!work.tasks,
      ],
      cashWork: [cashWork.counts.payments, Object.keys(cashWork.counts).length],
    }
    if (
      m.dashboard !== 'manager' ||
      !m.views.includes('revenue') ||
      !m.views.includes('receipts') ||
      m.dashboardViews[0] !== 'visits' ||
      c.dashboard !== 'cashier' ||
      c.views.length !== 0 ||
      json102r(c.dashboardViews) !==
        json102r(['collections', 'receipts', 'methods', 'openBills', 'refunds']) ||
      d.dashboard !== 'doctor' ||
      d.views.length !== 0 ||
      d.dashboardViews[0] !== 'myPatients' ||
      n.dashboard !== 'nurse' ||
      !n.dashboardViews.includes('vitals') ||
      r.dashboard !== 'reception' ||
      !r.dashboardViews.includes('arrivals') ||
      ph.dashboard !== 'pharmacy' ||
      !ph.dashboardViews.includes('outside') ||
      lab.dashboard !== 'lab' ||
      !lab.dashboardViews.includes('turnaround') ||
      h.dashboard !== 'head' ||
      json102r(h.views) !== json102r(['staff', 'visits', 'treatments', 'waiting']) ||
      h.dashboardViews[0] !== 'visits' ||
      !(Number(work.counts.patientsSeen) >= 1) ||
      !(Number(work.counts.diagnoses) >= 1) ||
      !work.records.some((x) => x.encounterId === t102r.enc && x.kind === 'diagnoses') ||
      work.records.some((x) => x.amount != null) ||
      typeof work.bookings.booked !== 'number' ||
      typeof work.tasks.open !== 'number' ||
      'payments' in cashWork.counts
    )
      throw new Error(json102r(res))
    return `manager · cashier · doctor · nurse · reception · pharmacy · lab · head named; the doctor's own work: ${work.counts.patientsSeen} seen, ${work.counts.diagnoses} diagnoses; no money`
  },
)

// ---------------------------------------------------------------- 0104 (visit_edit_lock): a finished visit is locked
// the 0089 and 0092 steps re-ran older migrations (old add_diagnosis, record_result…): put the
// 20261212 definitions back (it runs twice, as in a database updated file by file)
await step('0104: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261212090000_visit_edit_lock.sql'), 'utf8'),
  )
  return 'no error'
})
const tLock = {}
/** The service role, as the `visit-edit-code` edge function calls the database. */
const asService = async () => {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '', false); select set_config('request.jwt.claim.role', 'service_role', false); set role service_role;`,
  )
}
const endService = async () => {
  await db.exec(`reset role; select set_config('request.jwt.claim.role', '', false);`)
  await asAdmin()
}
/** A code made for `who` the way the edge function asks for it: the grant id and the plain code. */
const codeFor = async (enc, who, reason = 'lab result changes the diagnosis') => {
  await asService()
  const j = (await one(`select request_visit_edit($1, $2, $3) as j`, [enc, reason, who])).j
  await endService()
  return j
}
/** A visit closed by its doctor: diagnosis, finished; the manager ends it if money was still due. */
const closedVisit = async (given) => {
  const v = await visitAt(given)
  await as(d1)
  await db.query(`select take_patient($1)`, [v.queue])
  tLock.dx = (await one(`select add_diagnosis($1, 'Malaria', 'B54', 'primary') as id`, [v.enc])).id
  tLock.note = (await one(`select add_clinical_note($1, 'Fever for two days') as id`, [v.enc])).id
  await db.query(`select finish_visit($1)`, [v.enc])
  await asAdmin()
  let st = (await one(`select status from encounter where id = $1`, [v.enc])).status
  if (st !== 'closed') {
    await as(staff.manager)
    await db.query(`select end_visit($1, 'test 102')`, [v.enc])
    await asAdmin()
    st = (await one(`select status from encounter where id = $1`, [v.enc])).status
  }
  if (st !== 'closed') throw new Error(`visit not closed: ${st}`)
  return v
}
await step(
  '0104 A: a finished visit refuses every change without a code; the manager too',
  async () => {
    tLock.v = await closedVisit('Lock 102')
    const enc = tLock.v.enc
    const r = {
      dx: await hintAs(d1, `select add_diagnosis($1, 'Late', 'A01', 'secondary')`, [enc]),
      note: await hintAs(d1, `select add_clinical_note($1, 'late note')`, [enc]),
      rx: await hintAs(
        d1,
        `select prescribe($1, null, 1, null, null, null, null, null, 'outside', null, null, 'Vitamin C')`,
        [enc],
      ),
      edit: await hintAs(
        d1,
        `select update_condition($1, 'Severe malaria', null, null, null, 'x')`,
        [tLock.dx],
      ),
      manager: await hintAs(staff.manager, `select add_diagnosis($1, 'Late', 'A01', 'secondary')`, [
        enc,
      ]),
      vitals: await hintAs(d1, `select record_vitals($1, '{"temp": 38}')`, [enc]),
    }
    await as(d1)
    const status = (await one(`select visit_edit_status($1) as j`, [enc])).j
    const active = (await one(`select visit_edit_active($1) as a`, [enc])).a
    await asAdmin()
    if (
      Object.values(r).some((x) => x !== 'P0002/') ||
      active !== false ||
      status.closed !== true ||
      status.active !== false ||
      status.canRequest !== true ||
      status.pending !== null
    )
      throw new Error(JSON.stringify({ r, active, status }))
    return `diagnosis, note, medicine, edit, vitals: ${r.dx}; manager: ${r.manager}; status closed, no window`
  },
)
await step(
  '0104 B: the code: never to the browser, e-mailed by the service role, 5 tries, then a 30-minute window',
  async () => {
    const enc = tLock.v.enc
    // from the browser (authenticated): a grant is made, the code is not returned
    await as(d1)
    const browser = (await one(`select request_visit_edit($1, 'wrong icd code') as j`, [enc])).j
    await asAdmin()
    // the service role names the person and receives the code (the edge function e-mails it)
    const made = await codeFor(enc, d1)
    // someone who did not treat the patient: refused (even through the service role)
    await asService()
    const stranger = await db
      .query(`select request_visit_edit($1, 'curious', $2)`, [enc, d2])
      .then(() => 'ok')
      .catch((e) => `${e.code}/${String(e.message).split('\n')[0]}`)
    await endService()
    const short = await hintAs(d1, `select request_visit_edit($1, 'x')`, [enc])
    const row = await one(
      `select code_hash, attempts, verified_at from visit_edit_grant where id = $1`,
      [made.id],
    )
    // five wrong codes end the grant: each one is counted (answered, not refused), the sixth refused
    const wrong = []
    await as(d1)
    for (let i = 0; i < 5; i++)
      wrong.push((await one(`select verify_visit_edit($1, '000000') as j`, [enc])).j.triesLeft)
    wrong.push(await tryAs(d1, `select verify_visit_edit($1, '000000')`, [enc]))
    const again = await codeFor(enc, d1)
    const right = await tryAs(d1, `select verify_visit_edit($1, $2)`, [enc, again.code])
    await as(d1)
    const status = (await one(`select visit_edit_status($1) as j`, [enc])).j
    const active = (await one(`select visit_edit_active($1) as a`, [enc])).a
    await as(d2)
    const other = (await one(`select visit_edit_active($1) as a`, [enc])).a
    await asAdmin()
    const grant = await one(
      `select verified_at, expires_at, extract(epoch from (expires_at - verified_at))::int as secs from visit_edit_grant where id = $1`,
      [again.id],
    )
    const audit = (
      await one(
        `select count(*)::int as n from audit_event where entity = 'encounter' and entity_id = $1 and after ->> 'visit_edit_grant' = $2`,
        [enc, again.id],
      )
    ).n
    tLock.grant = again.id
    if (
      browser.code != null ||
      browser.email != null ||
      !browser.id ||
      !/^\d{6}$/.test(made.code ?? '') ||
      !made.id ||
      stranger !==
        '42501/only a clinician who treated the patient in this visit (or the manager) may edit it after it is finished' ||
      short !== '22023/' ||
      row.code_hash === made.code ||
      row.attempts !== 0 ||
      row.verified_at !== null ||
      wrong[0] !== 4 ||
      wrong[3] !== 1 ||
      wrong[4] !== 0 ||
      wrong[5] !== 'too many wrong codes: ask for a new one' ||
      right !== 'ok' ||
      active !== true ||
      other !== false ||
      status.active !== true ||
      status.grantId !== again.id ||
      grant.secs !== 1800 ||
      audit < 2
    )
      throw new Error(
        JSON.stringify({
          browser,
          made,
          stranger,
          short,
          row,
          wrong,
          right,
          status,
          other,
          grant,
          audit,
        }),
      )
    return `browser: no code; service: 6 digits (hash kept); stranger: refused; 5 wrong codes then "${wrong[5]}"; right code: window of ${grant.secs / 60} min, ${audit} audit rows`
  },
)
await step(
  '0104 C: inside the window every change is taken and written in the audit with the grant; after it, locked again',
  async () => {
    const enc = tLock.v.enc
    await as(d1)
    const dx2 = (
      await one(`select add_diagnosis($1, 'Typhoid', 'A01.0', 'secondary') as id`, [enc])
    ).id
    const note2 = (await one(`select add_clinical_note($1, 'added after close') as id`, [enc])).id
    const rx = (
      await one(
        `select prescribe($1, null, 10, '1 tab', 'oral', 'OD', 10, null, 'outside', null, null, 'Vitamin C 102') as j`,
        [enc],
      )
    ).j
    await db.query(`select record_vitals($1, '{"temp": 38.2}')`, [enc])
    await db.query(
      `select update_condition($1, 'Severe malaria', 'B50.0', null, null, 'the smear came back') as j`,
      [tLock.dx],
    )
    const clinic = await hintAs(
      d1,
      `select prescribe($1, $2, 5, null, null, null, null, null, 'pharmacy')`,
      [enc, t97.amox],
    )
    await as(d1)
    const vc = (await one(`select visit_clinical($1) as j`, [enc])).j
    await asAdmin()
    const audit = (
      await db.query(
        `select entity, action from audit_event where after ->> 'visit_edit_grant' = $1 and reason like 'finished visit edited under grant%' order by at`,
        [tLock.grant],
      )
    ).rows
    const atPharmacy = (
      await one(
        `select count(*)::int as n from queue_entry where encounter_id = $1 and station = 'pharmacy' and finished_at is null`,
        [enc],
      )
    ).n
    // the window ends
    await db.query(
      `update visit_edit_grant set expires_at = now() - interval '1 second' where id = $1`,
      [tLock.grant],
    )
    const after = await hintAs(d1, `select add_clinical_note($1, 'too late')`, [enc])
    await as(d1)
    const status = (await one(`select visit_edit_status($1) as j`, [enc])).j
    await asAdmin()
    const kinds = audit.map((a) => `${a.entity}:${a.action}`)
    if (
      !dx2 ||
      !note2 ||
      rx.supply !== 'outside' ||
      clinic !== '22023/' ||
      atPharmacy !== 0 ||
      vc.editLock?.active !== true ||
      vc.diagnoses.find((d) => d.id === tLock.dx)?.text !== 'Severe malaria' ||
      !kinds.includes('condition:create') ||
      !kinds.includes('observation:create') ||
      !kinds.includes('medication_request:create') ||
      !kinds.includes('condition:update') ||
      after !== 'P0002/' ||
      status.active !== false
    )
      throw new Error(
        JSON.stringify({
          dx2,
          note2,
          rx,
          clinic,
          atPharmacy,
          kinds,
          after,
          status,
          lock: vc.editLock,
        }),
      )
    return `${kinds.length} audit rows under the grant (${[...new Set(kinds)].join(', ')}); clinic medicine: ${clinic}; after the window: ${after}`
  },
)
await step(
  '0104 D: a diagnosis is edited or removed and a note edited by its author (or the manager), with a reason; the history keeps every version',
  async () => {
    const v = await visitAt('Hist 102')
    await as(d1)
    await db.query(`select take_patient($1)`, [v.queue])
    const dx = (await one(`select add_diagnosis($1, 'Malaria', 'B54', 'primary') as id`, [v.enc]))
      .id
    const dx2 = (
      await one(`select add_diagnosis($1, 'Anaemia', 'D64.9', 'secondary') as id`, [v.enc])
    ).id
    const note = (await one(`select add_clinical_note($1, 'Fever, chills') as id`, [v.enc])).id
    const r = {
      other: await hintAs(d2, `select update_condition($1, 'X', null, null, null, 'not mine')`, [
        dx,
      ]),
      noReason: await hintAs(d1, `select update_condition($1, 'X', null, null, null, '')`, [dx]),
      same: await hintAs(
        d1,
        `select update_condition($1, 'Malaria', null, null, null, 'nothing')`,
        [dx],
      ),
    }
    await as(d1)
    await db.query(
      `select update_condition($1, 'Severe malaria', 'B50.0', null, true, 'smear positive')`,
      [dx],
    )
    await db.query(`select update_condition($1, null, '', null, false, 'confirmed')`, [dx])
    await db.query(`select update_note($1, 'Fever, chills, headache', 'forgot the headache')`, [
      note,
    ])
    await db.query(`select remove_condition($1, 'haemoglobin was normal')`, [dx2])
    await as(staff.manager)
    await db.query(`select update_note($1, 'Fever, chills, headache for two days', 'clarified')`, [
      note,
    ])
    await as(d1)
    const vc = (await one(`select visit_clinical($1) as j`, [v.enc])).j
    await asAdmin()
    const d = vc.diagnoses.find((x) => x.id === dx)
    const gone = vc.diagnoses.find((x) => x.id === dx2)
    const n = vc.notes.find((x) => x.id === note)
    const removedRow = await one(`select deleted_at, edit_reason from condition where id = $1`, [
      dx2,
    ])
    // the record of care still has its primary diagnosis: the visit closes as usual
    await as(d1)
    await db.query(`select finish_visit($1)`, [v.enc])
    await asAdmin()
    if (
      r.other !== '42501/' ||
      r.noReason !== '22023/' ||
      r.same !== '22023/' ||
      d.text !== 'Severe malaria' ||
      d.icd10 !== null ||
      d.provisional !== false ||
      d.editReason !== 'confirmed' ||
      !d.editedAt ||
      d.history.length !== 2 ||
      d.history[0].text !== 'Severe malaria' ||
      d.history[0].icd10 !== 'B50.0' ||
      d.history[0].reason !== 'confirmed' ||
      d.history[1].text !== 'Malaria' ||
      d.history[1].icd10 !== 'B54' ||
      d.history[1].reason !== 'smear positive' ||
      !gone.removedAt ||
      gone.removeReason !== 'haemoglobin was normal' ||
      removedRow.deleted_at === null ||
      n.text !== 'Fever, chills, headache for two days' ||
      n.editReason !== 'clarified' ||
      n.history.length !== 2 ||
      n.history[1].text !== 'Fever, chills' ||
      n.history[0].text !== 'Fever, chills, headache'
    )
      throw new Error(JSON.stringify({ r, d, gone, removedRow, n }))
    tLock.hist = v
    return `${d.history.length} versions of the diagnosis, ${n.history.length} of the note (one by the manager); removed: ${gone.removeReason}`
  },
)
await step('0104 E: a finished visit keeps its primary diagnosis', async () => {
  const v = tLock.hist
  await asAdmin()
  const st = (await one(`select status from encounter where id = $1`, [v.enc])).status
  if (st !== 'closed') {
    await as(staff.manager)
    await db.query(`select end_visit($1, 'test 102')`, [v.enc])
    await asAdmin()
  }
  const dx = (
    await one(
      `select id from condition where encounter_id = $1 and type = 'primary' and deleted_at is null`,
      [v.enc],
    )
  ).id
  const made = await codeFor(v.enc, d1, 'wrong diagnosis')
  const opened = await tryAs(d1, `select verify_visit_edit($1, $2)`, [v.enc, made.code])
  const r = {
    remove: await codeAs(d1, `select remove_condition($1, 'wrong')`, [dx]),
    demote: await codeAs(
      d1,
      `select update_condition($1, null, null, 'secondary', null, 'wrong')`,
      [dx],
    ),
  }
  await as(d1)
  await db.query(`select add_diagnosis($1, 'Typhoid fever', 'A01.0', 'primary')`, [v.enc])
  const removed = await codeAs(d1, `select remove_condition($1, 'typhoid, not malaria')`, [dx])
  await asAdmin()
  if (opened !== 'ok' || r.remove !== '23514' || r.demote !== '23514' || removed !== null)
    throw new Error(JSON.stringify({ opened, r, removed }))
  return `last primary: remove ${r.remove}, demote ${r.demote}; with a new primary written: removed`
})
await step(
  '0104 F: a result is entered by the laboratory, never by the clinician who asked for it; the manager corrects',
  async () => {
    // a doctor of Consultation only (d1 may have been placed in a laboratory department above)
    const doc = await newStaff('doc.lock102', 'Dr. Lock 102', 'doctor', 'Consultation 4')
    const v = await visitAt('Result 102')
    await as(doc)
    await db.query(`select take_patient($1)`, [v.queue])
    await db.query(`select add_diagnosis($1, 'Fever', 'R50.9', 'primary')`, [v.enc])
    await asAdmin()
    const svc = await one(`select id from service where service_group = 'lab' and active limit 1`)
    // the order itself, written as the doctor's (no price needed for this check)
    const req = (
      await one(
        `insert into service_request (encounter_id, category, service_id, priority, station, requester_id)
         values ($1, 'lab', $2, 3, 'laboratory', $3) returning id`,
        [v.enc, svc.id, doc],
      )
    ).id
    await as(doc)
    const vc = (await one(`select visit_clinical($1) as j`, [v.enc])).j
    const r = {
      mine: vc.orders.find((o) => o.id === req)?.mine,
      doctor: await hintAs(doc, `select record_result($1, 'Positive', 'Malaria', true)`, [req]),
      lab: await hintAs(
        staff.lab_tech,
        `select record_result($1, 'Negative', 'No malaria', true)`,
        [req],
      ),
      doctorCorrect: await hintAs(
        doc,
        `select correct_result($1, 'Positive', 'Malaria', 'I know better')`,
        [req],
      ),
      manager: await hintAs(
        staff.manager,
        `select correct_result($1, 'Positive', 'Malaria', 'relabelled')`,
        [req],
      ),
    }
    if (
      r.mine !== true ||
      r.doctor !== '42501/no_desk' ||
      r.lab !== 'ok' ||
      r.doctorCorrect !== '42501/no_desk' ||
      r.manager !== 'ok'
    )
      throw new Error(JSON.stringify(r))
    return `requester: ${r.doctor} (enter) / ${r.doctorCorrect} (correct); laboratory: ${r.lab}; manager corrects: ${r.manager}`
  },
)

// ---------------------------------------------------------------- 0103 (20261214): packs and pieces; the rest of a prescription
// Earlier checks re-ran older migrations after every file: the 0103 definitions go back on top
// (the migration is idempotent).
const t103 = {}
await step('0103: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261214090000_packs_and_pieces.sql'), 'utf8'),
  )
  return 'no error'
})
await step(
  '0103 A: a whole-pack walk-in sale is charged at the pack price; pieces at the piece price; stock leaves in pieces',
  async () => {
    // Amoxicillin 97 sells at 350 a capsule; a pack of 20 at 6,000 (not 7,000)
    await as(staff.manager)
    await db.query(`select set_pack_size($1, 20)`, [t97.amox])
    const noSize = await hintAs(staff.manager, `select set_pack_price($1, 6000)`, [t97.gauze])
    await as(staff.manager)
    await db.query(`select set_pack_price($1, 6000)`, [t97.amox])
    const nurse = await codeAs(staff.nurse, `select set_pack_price($1, 5000)`, [t97.amox])
    await as(staff.pharmacist)
    await db.query(`select add_stock($1::jsonb)`, [
      JSON.stringify([
        {
          item_id: t97.amox,
          batch_no: 'AMX-103',
          expiry: t97.day.d,
          quantity: 200,
          unit_cost: 120,
        },
      ]),
    ])
    await asAdmin()
    const item = await one(`select pack_size, pack_price from item where id = $1`, [t97.amox])
    const before = (await one(`select usable_stock($1, $2) as n`, [t97.amox, t97.main])).n
    await as(staff.pharmacist)
    const whole = (
      await one(`select create_counter_sale($1::jsonb, 'Packs 103') as j`, [
        JSON.stringify([{ itemId: t97.amox, quantity: 40 }]),
      ])
    ).j
    const loose = (
      await one(`select create_counter_sale($1::jsonb, 'Pieces 103') as j`, [
        JSON.stringify([{ itemId: t97.amox, quantity: 23 }]),
      ])
    ).j
    const list = (await one(`select counter_sales('open') as j`)).j
    await db.query(`select take_counter_payment($1, 'cash')`, [whole.id])
    await db.query(`select hand_over_counter_sale($1)`, [whole.id])
    await db.query(`select cancel_counter_sale($1, 'pieces 103 not taken')`, [loose.id])
    const overview = (await one(`select stock_overview() as j`)).j
    await asAdmin()
    const after = (await one(`select usable_stock($1, $2) as n`, [t97.amox, t97.main])).n
    const w = list.find((s) => s.id === whole.id)?.lines[0]
    const l = list.find((s) => s.id === loose.id)?.lines[0]
    const ov = overview.items.find((x) => x.id === t97.amox)
    if (
      noSize !== '22023/pack_size' ||
      nurse !== '42501' ||
      item.pack_size !== 20 ||
      Number(item.pack_price) !== 6000 ||
      Number(whole.total) !== 12000 ||
      !w?.byPack ||
      w.packs !== 2 ||
      Number(w.packPrice) !== 6000 ||
      w.quantity !== 40 ||
      w.packSize !== 20 ||
      Number(w.unitPrice) !== 350 ||
      Number(loose.total) !== 8050 ||
      l?.byPack ||
      l?.packs != null ||
      after !== before - 40 ||
      ov?.packSize !== 20 ||
      Number(ov?.packPrice) !== 6000
    )
      throw new Error(
        JSON.stringify({
          noSize,
          nurse,
          item,
          whole,
          w,
          loose,
          l,
          before,
          after,
          ov,
        }),
      )
    t103.amoxBefore = after
    return `40 capsules = 2 packs × 6,000 = 12,000 (not 14,000); 23 capsules = 8,050; 40 pieces left the shelf`
  },
)
await step(
  '0103 B: a bill line of whole packs is written in packs at the pack price; pieces as before',
  async () => {
    const v = await visit87('Packs 103')
    await as(staff.pharmacist)
    const salesBefore = (await one(`select stock_sales(current_date, current_date) as j`)).j
    const pack = (await one(`select sell_medicine($1, $2, 20) as j`, [v.enc, t97.amox])).j
    const piece = (await one(`select sell_medicine($1, $2, 5) as j`, [v.enc, t97.amox])).j
    const salesAfter = (await one(`select stock_sales(current_date, current_date) as j`)).j
    await asAdmin()
    const lines = (
      await db.query(
        `select l.description, l.quantity::text as q, l.unit_price::text as p, l.pack_size, l.patient_share::text as share
         from invoice_line l where l.invoice_id = $1 and l.deleted_at is null order by l.created_at`,
        [v.inv],
      )
    ).rows
    const inv = await one(`select total::text as total from invoice where id = $1`, [v.inv])
    const given = await one(
      `select sum(m.quantity)::int as n from stock_movement m where m.item_id = $1 and m.type = 'dispense'
        and m.medication_request_id in ($2, $3) and m.deleted_at is null`,
      [t97.amox, pack.requestId, piece.requestId],
    )
    const name = 'Amoxicillin 97 500 mg'
    const unitsBefore = Number(salesBefore.items.find((x) => x.item === name)?.units ?? 0)
    const unitsAfter = Number(salesAfter.items.find((x) => x.item === name)?.units ?? 0)
    if (
      !pack.charged ||
      !piece.charged ||
      lines.length !== 2 ||
      !/ · B\/20$/.test(lines[0].description) ||
      Number(lines[0].q) !== 1 ||
      Number(lines[0].p) !== 6000 ||
      lines[0].pack_size !== 20 ||
      Number(lines[0].share) !== 6000 ||
      Number(lines[1].q) !== 5 ||
      Number(lines[1].p) !== 350 ||
      lines[1].pack_size !== null ||
      Number(inv.total) !== 7750 ||
      given.n !== 25 ||
      unitsAfter - unitsBefore !== 25
    )
      throw new Error(
        JSON.stringify({
          pack,
          piece,
          lines,
          inv,
          given,
          unitsBefore,
          unitsAfter,
        }),
      )
    return `"${lines[0].description}" × 1 at 6,000 and 5 × 350: bill 7,750; 25 capsules left the shelf; the sales report counts 25 pieces`
  },
)
await step(
  '0103 C: 30 prescribed, 12 given, rest not available: the prescriber sends only the 18 outside; the 12 stay charged',
  async () => {
    const v = await visitAt('Rest 103')
    await as(d1)
    await db.query(`select take_patient($1)`, [v.queue])
    await db.query(`select add_diagnosis($1, 'Tonsillitis', 'J03', 'primary')`, [v.enc])
    const rx = (
      await one(
        `select prescribe(p_encounter_id => $1, p_item_id => $2, p_quantity => 30, p_supply => 'pharmacy',
                p_dose => '1 cap', p_frequency => 'TDS', p_duration_days => 10) as j`,
        [v.enc, t97.amox],
      )
    ).j
    await db.query(`select finish_visit($1)`, [v.enc])
    await as(staff.pharmacist)
    const q0 = (await one(`select pharmacy_queue() as j`)).j.lines.find(
      (x) => x.requestId === rx.id,
    )
    const part = (await one(`select dispense_prescription($1, null, 12) as j`, [rx.id])).j
    await db.query(`select rx_not_given($1, 'Out of stock')`, [rx.id])
    await asAdmin()
    const told = await one(
      `select params from notification where kind = 'rx_not_given' and params ->> 'requestId' = $1`,
      [rx.id],
    )
    await as(d1)
    const out = (await one(`select rx_set_supply($1, 'outside', 'none left') as j`, [rx.id])).j
    const again = (await one(`select rx_set_supply($1, 'outside') as j`, [rx.id])).j
    await asAdmin()
    const orig = await one(
      `select supply, quantity::text as q, quantity_given, not_given_at is not null as ng, given_at is not null as g
         from medication_request where id = $1`,
      [rx.id],
    )
    const rest = await one(
      `select supply, quantity::text as q, quantity_given, split_from, medicine_name, prescriber_id, cancelled_at
         from medication_request where id = $1`,
      [out.id],
    )
    const billed = (
      await one(
        `select coalesce(sum(l.quantity * coalesce(l.pack_size, 1)), 0)::int as n from invoice_line l
          join medication_dispense d on d.id = l.source_id and l.source_type = 'medication_dispense'
         where d.medication_request_id = $1 and l.deleted_at is null`,
        [rx.id],
      )
    ).n
    // back to the pharmacy: the rest waits there as its own line, then outside again
    await as(d1)
    const back = (await one(`select rx_set_supply($1, 'pharmacy') as j`, [rx.id])).j
    await as(staff.pharmacist)
    const q1 = (await one(`select pharmacy_queue() as j`)).j.lines.find(
      (x) => x.requestId === out.id,
    )
    await as(d1)
    const outAgain = (await one(`select rx_set_supply($1, 'outside') as j`, [out.id])).j
    await as(staff.pharmacist)
    const report = (await one(`select rx_bought_outside(current_date, current_date) as j`)).j
    await asAdmin()
    const amox = report.find((x) => x.itemId === t97.amox)
    const pending = (
      await one(
        `select count(*)::int as n from medication_request m where m.encounter_id = $1 and rx_pending(m)`,
        [v.enc],
      )
    ).n
    if (
      q0?.packSize !== 20 ||
      Number(q0?.packPrice) !== 6000 ||
      part.given !== 12 ||
      part.remaining !== 18 ||
      told?.params.quantity !== 30 ||
      told?.params.given !== 12 ||
      told?.params.remaining !== 18 ||
      told?.params.outside !== true ||
      out.supply !== 'outside' ||
      out.splitFrom !== rx.id ||
      out.quantity !== 18 ||
      out.given !== 12 ||
      out.id === rx.id ||
      again.changed !== false ||
      again.splitFrom !== rx.id ||
      orig.supply !== 'pharmacy' ||
      Number(orig.q) !== 30 ||
      orig.quantity_given !== 12 ||
      !orig.ng ||
      orig.g ||
      rest.supply !== 'outside' ||
      Number(rest.q) !== 18 ||
      rest.quantity_given !== 0 ||
      rest.split_from !== rx.id ||
      !rest.medicine_name ||
      rest.prescriber_id !== d1 ||
      billed !== 12 ||
      back.id !== out.id ||
      back.supply !== 'pharmacy' ||
      !q1 ||
      q1.remaining !== 18 ||
      q1.splitFrom !== rx.id ||
      outAgain.supply !== 'outside' ||
      !amox ||
      !(amox.notGiven >= 2) ||
      pending !== 0
    )
      throw new Error(
        JSON.stringify({
          q0,
          part,
          told,
          out,
          again,
          orig,
          rest,
          billed,
          back,
          q1,
          outAgain,
          amox,
          pending,
        }),
      )
    return `12 given and billed; 18 sent outside as their own line (split from the original); back to the pharmacy's list and out again; "bought outside" counts it`
  },
)
// ---------------------------------------------------------------- 0107 (20261217): the package and how a medicine is sold
// The 0103 checks above ran that migration again (its definitions went back on top): this one
// goes back on top first (it is idempotent too).
const t107 = {}
const mig107 = async () =>
  db.exec(
    await readFile(path.join(migrationsDir, '20261217090000_packaging_and_charging.sql'), 'utf8'),
  )
/** The bill lines of a visit, in order. */
const lines107 = async (inv) =>
  (
    await db.query(
      `select l.description, l.quantity::text as q, l.unit_price::text as p, l.pack_size
         from invoice_line l where l.invoice_id = $1 and l.deleted_at is null and l.item_id is not null
        order by l.created_at, l.pack_size nulls last`,
      [inv],
    )
  ).rows.map((l) => ({ ...l, q: Number(l.q), p: Number(l.p) }))
await step(
  '0107: existing items: pack + pack price → both, pack alone → piece; run again, a choice made since is kept',
  async () => {
    await mig107()
    await as(staff.manager)
    const mk = async (name, price) =>
      (await one(`select upsert_item(null, $1, $2, null, 'tablet', 'tab') as id`, [name, price])).id
    t107.oldBoth = await mk('Old both 107', 50)
    t107.oldBox = await mk('Old box 107', 40)
    t107.oldPiece = await mk('Old piece 107', 30)
    await asAdmin()
    // as 0103 left them: a pack of 20 with a pack price, a pack of 24 without, no pack
    await db.query(`update item set pack_size = 20, pack_price = 900 where id = $1`, [t107.oldBoth])
    await db.query(`update item set pack_size = 24, pack_price = null where id = $1`, [t107.oldBox])
    // the database before 0107: no sale_mode
    await db.query(`alter table item drop column sale_mode`)
    await mig107()
    const mode = async (id) =>
      (await one(`select sale_mode from item where id = $1`, [id])).sale_mode
    const first = {
      both: await mode(t107.oldBoth),
      box: await mode(t107.oldBox),
      piece: await mode(t107.oldPiece),
      amox: await mode(t97.amox),
    }
    // chosen since: sold only by the box; the migration runs again and keeps it
    await as(staff.pharmacist)
    await db.query(`select set_item_packaging($1, 24, 'pack', null, 1000, null, 'box')`, [
      t107.oldBox,
    ])
    await asAdmin()
    await mig107()
    const again = await one(
      `select sale_mode, pack_price::text as pp, pack_unit,
              (select pf.price from price_for(null, i.id, null) pf)::text as piece
         from item i where i.id = $1`,
      [t107.oldBox],
    )
    const bad = await codeAs(staff.manager, `select set_pack_size($1, 1)`, [t107.oldBox])
    const after1 = await one(`select sale_mode, pack_price, pack_unit from item where id = $1`, [
      t107.oldBox,
    ])
    if (
      first.both !== 'both' ||
      first.box !== 'piece' ||
      first.piece !== 'piece' ||
      first.amox !== 'both' ||
      again.sale_mode !== 'pack' ||
      Number(again.pp) !== 1000 ||
      again.pack_unit !== 'box' ||
      Number(again.piece) !== 42 ||
      bad !== null ||
      after1.sale_mode !== 'piece' ||
      after1.pack_price !== null ||
      after1.pack_unit !== null
    )
      throw new Error(JSON.stringify({ first, again, bad, after1 }))
    return `pack 20 + pack price → both; pack 24 alone and no pack → piece; "only by the box" kept on a second run (piece price 1,000 / 24 = 42); pack size 1 → by the piece`
  },
)
await step(
  '0107 A: pieces only: added with no pack (40 bottles), sold by the piece at the counter and to a visit',
  async () => {
    await as(staff.pharmacist)
    const r = (
      await one(`select add_stock($1::jsonb) as j`, [
        JSON.stringify([
          {
            new_item: {
              name: 'Cough syrup 107',
              strength: '100 ml',
              unit: 'bottle',
              kind: 'medicine',
            },
            batch_no: 'CS-107',
            expiry: t97.day.d,
            quantity: 40,
            unit_cost: 900,
            sale_mode: 'piece',
            pack_size: null,
            sell_price: 1500,
          },
        ]),
      ])
    ).j
    t107.syrup = r.lines[0].item_id
    const sale = (
      await one(`select create_counter_sale($1::jsonb, 'Syrup 107') as j`, [
        JSON.stringify([{ itemId: t107.syrup, quantity: 3 }]),
      ])
    ).j
    await db.query(`select cancel_counter_sale($1, 'syrup 107 test')`, [sale.id])
    const v = await visit87('Syrup 107')
    await as(staff.pharmacist)
    const sold = (await one(`select sell_medicine($1, $2, 2) as j`, [v.enc, t107.syrup])).j
    const overview = (await one(`select stock_overview() as j`)).j
    await asAdmin()
    const it = await one(
      `select pack_size, sale_mode, pack_price, selling_unit,
              (select pf.price from price_for(null, i.id, null) pf)::text as price
         from item i where i.id = $1`,
      [t107.syrup],
    )
    const bill = await lines107(v.inv)
    const ov = overview.items.find((x) => x.id === t107.syrup)
    if (
      !r.lines[0].created ||
      it.pack_size !== null ||
      it.sale_mode !== 'piece' ||
      it.pack_price !== null ||
      it.selling_unit !== 'bottle' ||
      Number(it.price) !== 1500 ||
      Number(sale.total) !== 4500 ||
      !sold.charged ||
      bill.length !== 1 ||
      bill[0].q !== 2 ||
      bill[0].p !== 1500 ||
      bill[0].pack_size !== null ||
      ov?.saleMode !== 'piece' ||
      ov?.usable !== 38
    )
      throw new Error(JSON.stringify({ r, it, sale, sold, bill, ov }))
    return `new item, no pack, 1,500 a bottle: 3 at the counter = 4,500; 2 to a visit = 2 × 1,500; 38 bottles left`
  },
)
await step(
  '0107 B: by the pack only (box of 8 at 1,200): added in boxes; 3 tablets refused, 2 boxes sold at the pack price',
  async () => {
    await as(staff.pharmacist)
    const r = (
      await one(`select add_stock($1::jsonb) as j`, [
        JSON.stringify([
          {
            new_item: {
              name: 'Paracetamol 107',
              strength: '500 mg',
              unit: 'tablet',
              kind: 'medicine',
            },
            batch_no: 'PB-107',
            expiry: t97.day.d,
            quantity: 160,
            // the cost of one box: 800 (100 a tablet)
            pack_cost: 800,
            sale_mode: 'pack',
            pack_size: 8,
            pack_unit: 'box',
            pack_price: 1200,
          },
        ]),
      ])
    ).j
    t107.pack = r.lines[0].item_id
    await asAdmin()
    const it = await one(
      `select pack_size, sale_mode, pack_price::text as pp, pack_unit,
              (select pf.price from price_for(null, i.id, null) pf)::text as piece
         from item i where i.id = $1`,
      [t107.pack],
    )
    const grl = await one(
      `select unit, packs, pack_size, units, unit_cost::text as uc, pack_cost::text as pc, line_cost::text as lc
         from goods_receipt_line where receipt_id = $1`,
      [r.id],
    )
    const three = await hintAs(
      staff.pharmacist,
      `select create_counter_sale($1::jsonb, 'Three 107')`,
      [JSON.stringify([{ itemId: t107.pack, quantity: 3 }])],
    )
    let msg = ''
    await as(staff.pharmacist)
    try {
      await db.query(`select create_counter_sale($1::jsonb)`, [
        JSON.stringify([{ itemId: t107.pack, quantity: 3 }]),
      ])
    } catch (e) {
      msg = String(e.message)
    }
    const two = (
      await one(`select create_counter_sale($1::jsonb, 'Two boxes 107') as j`, [
        JSON.stringify([{ itemId: t107.pack, quantity: 16 }]),
      ])
    ).j
    const list = (await one(`select counter_sales('open') as j`)).j
    await db.query(`select cancel_counter_sale($1, 'boxes 107 test')`, [two.id])
    await asAdmin()
    const v = await visit87('Box 107')
    const sell3 = await hintAs(staff.pharmacist, `select sell_medicine($1, $2, 3)`, [
      v.enc,
      t107.pack,
    ])
    await as(staff.pharmacist)
    const sell8 = (await one(`select sell_medicine($1, $2, 8) as j`, [v.enc, t107.pack])).j
    await asAdmin()
    const bill = await lines107(v.inv)
    const line = list.find((s) => s.id === two.id)?.lines[0]
    if (
      !r.lines[0].created ||
      r.lines[0].sale_mode !== 'pack' ||
      it.pack_size !== 8 ||
      it.sale_mode !== 'pack' ||
      Number(it.pp) !== 1200 ||
      it.pack_unit !== 'box' ||
      Number(it.piece) !== 150 ||
      grl.unit !== 'box' ||
      Number(grl.packs) !== 20 ||
      grl.pack_size !== 8 ||
      grl.units !== 160 ||
      Number(grl.uc) !== 100 ||
      Number(grl.pc) !== 800 ||
      Number(grl.lc) !== 16000 ||
      three !== '22023/whole_packs' ||
      !/sold only in whole packs of 8: 3 is not a whole number of packs/.test(msg) ||
      Number(two.total) !== 2400 ||
      line?.packs !== 2 ||
      Number(line?.packPrice) !== 1200 ||
      line?.packSize !== 8 ||
      line?.pieces !== 0 ||
      line?.saleMode !== 'pack' ||
      line?.packUnit !== 'box' ||
      sell3 !== '22023/whole_packs' ||
      !sell8.charged ||
      bill.length !== 1 ||
      !/ · B\/8$/.test(bill[0].description) ||
      bill[0].q !== 1 ||
      bill[0].p !== 1200 ||
      bill[0].pack_size !== 8
    )
      throw new Error(JSON.stringify({ r, it, grl, three, msg, two, line, sell3, sell8, bill }))
    return `20 boxes at 800 a box (100 a tablet, 16,000); piece price 1,200 / 8 = 150; 3 tablets refused; 2 boxes = 2,400; "· B/8" × 1 at 1,200 on the bill`
  },
)
await step(
  '0107 C: both (box of 8 at 1,500, 200 a tablet): 1 box + 3 tablets = 2,100 at the counter and on the bill',
  async () => {
    await as(staff.manager)
    t107.both = (
      await one(
        `select upsert_item(null, 'Ibuprofen 107', 200, '400 mg', 'tablet', 'tablet') as id`,
      )
    ).id
    await as(staff.pharmacist)
    const set = (
      await one(`select set_item_packaging($1, 8, 'both', 200, 1500, 'tablet', 'box') as j`, [
        t107.both,
      ])
    ).j
    await db.query(`select add_stock($1::jsonb) as j`, [
      JSON.stringify([
        { item_id: t107.both, batch_no: 'IB-107', expiry: t97.day.d, quantity: 80, unit_cost: 90 },
      ]),
    ])
    const sale = (
      await one(`select create_counter_sale($1::jsonb, 'Both 107') as j`, [
        JSON.stringify([{ itemId: t107.both, quantity: 11 }]),
      ])
    ).j
    const loose = (
      await one(`select create_counter_sale($1::jsonb, 'Loose 107') as j`, [
        JSON.stringify([{ itemId: t107.both, quantity: 5 }]),
      ])
    ).j
    const list = (await one(`select counter_sales('open') as j`)).j
    await db.query(`select cancel_counter_sale($1, 'both 107 test')`, [sale.id])
    await db.query(`select cancel_counter_sale($1, 'loose 107 test')`, [loose.id])
    await asAdmin()
    const v = await visit87('Both 107')
    await as(staff.pharmacist)
    const sold = (await one(`select sell_medicine($1, $2, 11) as j`, [v.enc, t107.both])).j
    await asAdmin()
    const bill = await lines107(v.inv)
    const inv = await one(`select total::text as total from invoice where id = $1`, [v.inv])
    const line = list.find((s) => s.id === sale.id)?.lines[0]
    // a nurse has no price right; the item stays as it is
    const nurse = await codeAs(
      staff.nurse,
      `select set_item_packaging($1, 10, 'pack', null, 999, null, null)`,
      [t107.both],
    )
    const noPack = await hintAs(
      staff.pharmacist,
      `select set_item_packaging($1, null, 'pack', null, 999, null, null)`,
      [t107.both],
    )
    const noPrice = await codeAs(
      staff.pharmacist,
      `select set_item_packaging($1, 8, 'both', null, 1500, null, null)`,
      [t107.both],
    )
    if (
      set.saleMode !== 'both' ||
      set.packSize !== 8 ||
      Number(set.packPrice) !== 1500 ||
      Number(set.piecePrice) !== 200 ||
      Number(sale.total) !== 2100 ||
      Number(loose.total) !== 1000 ||
      line?.packs !== 1 ||
      line?.pieces !== 3 ||
      Number(line?.lineTotal) !== 2100 ||
      !sold.charged ||
      bill.length !== 2 ||
      !/ · B\/8$/.test(bill[0].description) ||
      bill[0].q !== 1 ||
      bill[0].p !== 1500 ||
      bill[1].q !== 3 ||
      bill[1].p !== 200 ||
      bill[1].pack_size !== null ||
      Number(inv.total) !== 2100 ||
      nurse !== '42501' ||
      noPack !== '22023/pack_size' ||
      noPrice !== '22023'
    )
      throw new Error(
        JSON.stringify({ set, sale, loose, line, sold, bill, inv, nurse, noPack, noPrice }),
      )
    return `1 box + 3 tablets = 1,500 + 3 × 200 = 2,100 (two bill lines); 5 tablets = 1,000; the nurse may not change it; "by the pack" needs a pack, "both" a piece price`
  },
)
await step(
  '0107 D: add stock without the price right: the package and prices of a known item stay as they are',
  async () => {
    await except87(t85.nurse, 'stock.write', true)
    await as(t85.nurse)
    const r = (
      await one(`select add_stock($1::jsonb) as j`, [
        JSON.stringify([
          {
            item_id: t107.both,
            batch_no: 'IB-107B',
            expiry: t97.day.d,
            quantity: 8,
            unit_cost: 90,
            sale_mode: 'pack',
            pack_size: 8,
            pack_price: 1,
          },
        ]),
      ])
    ).j
    await asAdmin()
    await except87(t85.nurse, 'stock.write', null)
    const it = await one(`select sale_mode, pack_price::text as pp from item where id = $1`, [
      t107.both,
    ])
    if (
      !r.lines[0].price_ignored ||
      r.lines[0].packaging_updated ||
      it.sale_mode !== 'both' ||
      Number(it.pp) !== 1500
    )
      throw new Error(JSON.stringify({ r, it }))
    return 'the 8 tablets are added; "by the pack at 1" is not applied (price_ignored)'
  },
)
await step(
  '0107 E: the hand-over of a pack-only medicine: 10 prescribed → due 2 boxes (16); 10 refused, 16 given and billed 2 × 1,200',
  async () => {
    const v = await visitAt('Hand 107')
    await as(d1)
    await db.query(`select take_patient($1)`, [v.queue])
    await db.query(`select add_diagnosis($1, 'Fever', 'R50.9', 'primary')`, [v.enc])
    const rx = (
      await one(
        `select prescribe(p_encounter_id => $1, p_item_id => $2, p_quantity => 10, p_supply => 'pharmacy',
                p_dose => '1 tab', p_frequency => 'TDS', p_duration_days => 3) as j`,
        [v.enc, t107.pack],
      )
    ).j
    await db.query(`select finish_visit($1)`, [v.enc])
    await as(staff.pharmacist)
    const q = (await one(`select pharmacy_queue() as j`)).j.lines.find((x) => x.requestId === rx.id)
    await asAdmin()
    const ten = await hintAs(staff.pharmacist, `select dispense_prescription($1, null, 10)`, [
      rx.id,
    ])
    const all = await hintAs(staff.pharmacist, `select dispense_prescription($1)`, [rx.id])
    const more = await hintAs(staff.pharmacist, `select dispense_prescription($1, null, 24)`, [
      rx.id,
    ])
    await as(staff.pharmacist)
    const given = (await one(`select dispense_prescription($1, null, 16) as j`, [rx.id])).j
    await asAdmin()
    const inv = (await one(`select id from invoice where encounter_id = $1`, [v.enc])).id
    const bill = await lines107(inv)
    const m = await one(
      `select quantity_given, given_at is not null as done from medication_request where id = $1`,
      [rx.id],
    )
    if (
      q?.saleMode !== 'pack' ||
      q?.due !== 16 ||
      q?.packs !== 2 ||
      Number(q?.lineTotal) !== 2400 ||
      q?.packUnit !== 'box' ||
      ten !== '22023/whole_packs' ||
      all !== '22023/whole_packs' ||
      more !== '22023/more_than_remaining' ||
      given.given !== 16 ||
      given.remaining !== 0 ||
      !given.charged ||
      bill.length !== 1 ||
      bill[0].q !== 2 ||
      bill[0].p !== 1200 ||
      m.quantity_given !== 16 ||
      !m.done
    )
      throw new Error(JSON.stringify({ q, ten, all, more, given, bill, m }))
    return `the desk says 2 boxes (16) for 2,400; 10 tablets refused; 24 is more than the last box; 16 given, 2 × 1,200 billed, the line is done`
  },
)
await step(
  '0107 F: a pack-only medicine sent to a room store in pieces; given there: 3 refused, 1 box charged at the pack price',
  async () => {
    await as(staff.pharmacist)
    const note = (
      await one(`select send_to_room($1, $2::jsonb, null, null, $3) as j`, [
        t82.room,
        JSON.stringify([{ itemId: t107.pack, quantity: 16 }]),
        t97.main,
      ])
    ).j
    await as(d1)
    await db.query(`select confirm_receipt($1)`, [note.id])
    const store = (await one(`select store_stock($1) as j`, [t82.room])).j
    await asAdmin()
    const row = store.items.find((x) => x.itemId === t107.pack)
    const v = await visitAt('Room 107')
    await as(d1)
    await db.query(`select take_patient($1)`, [v.queue])
    await asAdmin()
    const three = await hintAs(
      d1,
      `select prescribe($1, $2, 3, null, null, null, null, null, 'room', 'consultation', $3)`,
      [v.enc, t107.pack, t82.room],
    )
    await as(d1)
    const given = (
      await one(
        `select prescribe($1, $2, 8, null, null, null, null, null, 'room', 'consultation', $3) as j`,
        [v.enc, t107.pack, t82.room],
      )
    ).j
    const after = (await one(`select store_stock($1) as j`, [t82.room])).j
    await asAdmin()
    const left = after.items.find((x) => x.itemId === t107.pack)
    const inv = (await one(`select id from invoice where encounter_id = $1`, [v.enc])).id
    const bill = await lines107(inv)
    if (
      row?.usable !== 16 ||
      row?.saleMode !== 'pack' ||
      row?.packSize !== 8 ||
      row?.packUnit !== 'box' ||
      three !== '22023/whole_packs' ||
      !given.charged ||
      !given.stockTaken ||
      left?.usable !== 8 ||
      bill.length !== 1 ||
      !/ · B\/8$/.test(bill[0].description) ||
      bill[0].q !== 1 ||
      bill[0].p !== 1200
    )
      throw new Error(JSON.stringify({ row, three, given, left, bill }))
    return `16 tablets (2 boxes) received in the room store; given there: 3 refused, 8 = 1 box at 1,200; 8 left`
  },
)
await step(
  '0107 G: a transfer note in packs and in pieces keeps the cost and the selling prices of the day',
  async () => {
    await as(staff.pharmacist)
    const sent = (
      await one(`select send_to_room($1, $2::jsonb, null, null, $3) as j`, [
        t82.room,
        JSON.stringify([
          // 2 boxes of 8 of Ibuprofen 107 (sold both ways), 3 bottles of syrup (pieces only)
          { itemId: t107.both, quantity: 16, mode: 'packs' },
          { itemId: t107.syrup, quantity: 3, mode: 'pieces' },
        ]),
        t97.main,
      ])
    ).j
    // the price changes after: the note keeps the price of the day it was written
    await db.query(`select set_item_packaging($1, 8, 'both', 250, 1800, null, null)`, [t107.both])
    const note = (await one(`select transfer_note($1) as j`, [sent.id])).j
    const list = (await one(`select transfer_notes() as j`)).j
    await as(d1)
    await db.query(`select confirm_receipt($1)`, [sent.id])
    const store = (await one(`select store_stock($1) as j`, [t82.room])).j
    const holderNote = (await one(`select transfer_note($1) as j`, [sent.id])).j
    await asAdmin()
    // the 16 may come from two batches: one line each
    const ibs = note.items.filter((x) => x.itemId === t107.both)
    const ib = ibs[0]
    const ibQ = ibs.reduce((s, x) => s + x.quantity, 0)
    const ibSell = ibs.reduce((s, x) => s + Number(x.sellValue), 0)
    const sy = note.items.find((x) => x.itemId === t107.syrup)
    const row = store.items.find((x) => x.itemId === t107.both)
    const listed = list.find((x) => x.id === sent.id)
    if (
      Number(sent.units) !== 19 ||
      Number(sent.sellValue) !== 7500 ||
      Number(sent.value) !== 4140 ||
      ibQ !== 16 ||
      ib?.packSize !== 8 ||
      ib?.inPacks !== true ||
      Number(ib?.unitPrice) !== 200 ||
      Number(ib?.packPrice) !== 1500 ||
      ibSell !== 3000 ||
      ib?.packUnit !== 'box' ||
      Number(ib?.unitCost) !== 90 ||
      sy?.inPacks !== false ||
      sy?.packSize !== null ||
      Number(sy?.unitPrice) !== 1500 ||
      Number(sy?.sellValue) !== 4500 ||
      Number(note.sellValue) !== 7500 ||
      Number(note.value) !== 4140 ||
      Number(listed?.sellValue) !== 7500 ||
      Number(holderNote.sellValue) !== 7500 ||
      holderNote.value !== null ||
      row?.usable !== 16 ||
      Number(row?.sellValue) !== 3600 ||
      !(Number(store.sellValue) >= 3600)
    )
      throw new Error(JSON.stringify({ sent, note, listed, row, holderNote: holderNote.value }))
    return `2 boxes of 8 (16) + 3 bottles: cost 4,140, at selling price 7,500 (1,500 a box, 1,500 a bottle), kept after the price became 1,800; the room store values the 16 at today's 2 × 1,800`
  },
)
await step(
  '0107 H: a pack-only medicine moves in whole packs: 3 tablets refused (asked or sent), the pharmacy may split a pack; a return may bring loose pieces',
  async () => {
    const ask3 = await hintAs(d1, `select request_refill($1, $2::jsonb)`, [
      t82.room,
      JSON.stringify([{ itemId: t107.pack, quantity: 3 }]),
    ])
    const askSplit = await hintAs(d1, `select request_refill($1, $2::jsonb)`, [
      t82.room,
      JSON.stringify([{ itemId: t107.pack, quantity: 3, split: true }]),
    ])
    await as(d1)
    const asked = (
      await one(`select request_refill($1, $2::jsonb) as j`, [
        t82.room,
        JSON.stringify([{ itemId: t107.pack, quantity: 16, mode: 'packs' }]),
      ])
    ).j
    await asAdmin()
    const send3 = await hintAs(
      staff.pharmacist,
      `select send_to_room($1, $2::jsonb, null, null, $3)`,
      [t82.room, JSON.stringify([{ itemId: t107.pack, quantity: 3 }]), t97.main],
    )
    await as(staff.pharmacist)
    const requests = (await one(`select refill_requests('open') as j`)).j
    const split = (
      await one(`select send_to_room($1, $2::jsonb, null, null, $3) as j`, [
        t82.room,
        JSON.stringify([{ itemId: t107.pack, quantity: 3, mode: 'pieces', split: true }]),
        t97.main,
      ])
    ).j
    const fill = (
      await one(`select send_to_room($1, $2::jsonb, $3, null, $4) as j`, [
        t82.room,
        JSON.stringify([{ itemId: t107.pack, quantity: 16, mode: 'packs' }]),
        asked.id,
        t97.main,
      ])
    ).j
    const splitNote = (await one(`select transfer_note($1) as j`, [split.id])).j
    await as(d1)
    await db.query(`select confirm_receipt($1)`, [split.id])
    await db.query(`select confirm_receipt($1)`, [fill.id])
    const back = (
      await one(`select return_to_pharmacy($1, $2::jsonb, 'opened box') as j`, [
        t82.room,
        JSON.stringify([{ itemId: t107.pack, quantity: 3, mode: 'pieces' }]),
      ])
    ).j
    await asAdmin()
    const rq = requests.find((x) => x.id === asked.id)?.lines[0]
    const sl = splitNote.items[0]
    if (
      ask3 !== '22023/whole_packs' ||
      askSplit !== '42501/split_pack' ||
      send3 !== '22023/whole_packs' ||
      rq?.mode !== 'packs' ||
      rq?.packSize !== 8 ||
      rq?.saleMode !== 'pack' ||
      Number(split.units) !== 3 ||
      sl?.inPacks !== false ||
      Number(sl?.sellValue) !== 450 ||
      Number(fill.units) !== 16 ||
      Number(fill.sellValue) !== 2400 ||
      Number(back.units) !== 3
    )
      throw new Error(JSON.stringify({ ask3, askSplit, send3, rq, split, sl, fill, back }))
    return `asked or sent as 3 tablets: refused (whole boxes of 8); a holder may not split; the pharmacy splits (3 = 450 at 1,200 a box); 2 boxes requested and sent (2,400); 3 loose tablets come back`
  },
)
// ---------------------------------------------------------------- 0108: reception and the patient file's fields
const t108 = {}
/** A booking from the website: a name and a phone, no patient file. */
const booking108 = async (name, phone, minutes) => {
  await asAdmin()
  const pr = (await one(`select ensure_practitioner($1) as id`, [d2])).id
  return (
    await one(
      `insert into appointment (practitioner_id, starts_at, status, source, contact_name, contact_phone, reason)
       values ($1, now() + make_interval(mins => $4), 'confirmed', 'online', $2, $3, 'Fever 108') returning id`,
      [pr, name, phone, minutes],
    )
  ).id
}
const patients108 = async () => (await one(`select count(*)::int as n from patient`)).n
// (the checks above ran older migrations again: this one is applied again too, which also shows
// it runs on a database that already has it)
await step('0108: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261218090000_reception_and_fields.sql'), 'utf8'),
  )
  return 'no error'
})
await step(
  '0108 A: a booking without a file does not arrive without one (no bare file)',
  async () => {
    t108.appt = await booking108('Uwase Bare', '0788108100', 41)
    const before = await patients108()
    const bare = await tryAs(staff.receptionist, `select appointment_arrived($1)`, [t108.appt])
    const noAge = await tryAs(
      staff.receptionist,
      `select appointment_arrived($1, null, $2::jsonb)`,
      [
        t108.appt,
        JSON.stringify({
          surname: 'Uwase',
          given_names: 'Bare',
          sex: 'female',
          phone_1: '0788108100',
        }),
      ],
    )
    const after = await patients108()
    const a = await one(`select status::text, patient_id from appointment where id = $1`, [
      t108.appt,
    ])
    if (
      !/register the patient first/.test(bare) ||
      !/date of birth or the age/.test(noAge) ||
      after !== before ||
      a.status !== 'confirmed' ||
      a.patient_id
    )
      throw new Error(JSON.stringify({ bare, noAge, before, after, a }))
    return 'refused without a file; refused with an incomplete form; no file made'
  },
)
await step(
  '0108 B: arrival with the registration form makes a complete file, linked, visit opened',
  async () => {
    await as(staff.manager)
    await db.query(
      `select save_patient_builtins('{"national_id":"required","phone_1":"required","email":"shown"}'::jsonb)`,
    )
    const form = {
      surname: 'Uwase',
      given_names: 'Arrived 108',
      sex: 'female',
      age_years: 29,
      phone_1: '0788 108 101',
      sector: 'Kiramuruzi',
      email: 'Uwase.108@Example.rw',
    }
    const before = await patients108()
    const lacking = await tryAs(
      staff.receptionist,
      `select appointment_arrived($1, null, $2::jsonb)`,
      [t108.appt, JSON.stringify(form)],
    )
    const mid = await patients108()
    await as(staff.receptionist)
    const v = (
      await one(`select appointment_arrived($1, null, $2::jsonb) as v`, [
        t108.appt,
        JSON.stringify({ ...form, id_type: 'national_id', national_id: '1 1997 7 0108101 0 12' }),
      ])
    ).v
    await asAdmin()
    const a = await one(`select status::text, patient_id from appointment where id = $1`, [
      t108.appt,
    ])
    const p = await one(
      `select national_id, id_type, phone_1, email, file_number, patient_missing(p) as missing from patient p where id = $1`,
      [a.patient_id],
    )
    const e = await one(`select status::text, appointment_id from encounter where id = $1`, [
      v.encounter_id,
    ])
    const again = await tryAs(
      staff.receptionist,
      `select appointment_arrived($1, null, $2::jsonb)`,
      [t108.appt, JSON.stringify(form)],
    )
    if (
      !/fill in the required fields: national ID/.test(lacking) ||
      mid !== before ||
      a.status !== 'arrived' ||
      a.patient_id !== v.patient_id ||
      !v.new_file ||
      p.national_id !== '1199770108101012' ||
      p.id_type !== 'national_id' ||
      p.phone_1 !== '0788108101' ||
      p.email !== 'uwase.108@example.rw' ||
      p.missing.length !== 0 ||
      e.status !== 'open' ||
      e.appointment_id !== t108.appt ||
      !/not waiting|already has a patient file/.test(again)
    )
      throw new Error(JSON.stringify({ lacking, before, mid, a, v, p, e, again }))
    t108.patient = a.patient_id
    return `refused without the required national ID (no file); then ${p.file_number} made with the arrival, nothing missing`
  },
)
await step('0108 C: a booking without a file may be linked to an existing file', async () => {
  const appt = await booking108('Uwase Linked', '0788108102', 52)
  const other = await booking108('Someone Else', '0788108103', 63)
  await asAdmin()
  const fresh = (
    await one(
      `insert into patient (surname, given_names, sex, birth_date, phone_1, national_id)
       values ('Habimana', 'Linked 108', 'male', '1990-01-01', '0788108102', '1199080108102033') returning id`,
    )
  ).id
  await as(staff.receptionist)
  const v = (await one(`select appointment_arrived($1, $2) as v`, [appt, fresh])).v
  await asAdmin()
  const a = await one(`select status::text, patient_id from appointment where id = $1`, [appt])
  const gone = await tryAs(staff.receptionist, `select appointment_arrived($1, $2)`, [
    other,
    '00000000-0000-0000-0000-000000000108',
  ])
  if (
    a.status !== 'arrived' ||
    a.patient_id !== fresh ||
    v.new_file ||
    !/patient not found/.test(gone)
  )
    throw new Error(JSON.stringify({ a, v, gone }))
  t108.linked = appt
  t108.other = other
  return 'linked to the chosen file, no new file; an unknown file refused'
})
await step(
  '0108 C2: a request booked without a file; the day list says what a file still needs',
  async () => {
    await asAdmin()
    const req = (
      await one(
        `insert into appointment (starts_at, status, source, contact_name, contact_phone, reason)
         values (now() + interval '2 days 74 minutes', 'inquiry', 'online', 'Ingabire Web', '0788108109', 'Check-up')
         returning id`,
      )
    ).id
    await as(staff.receptionist)
    const pid = (
      await one(
        `select approve_inquiry_auto($1, null, $2, now() + interval '2 days 74 minutes', true) as id`,
        [req, d2],
      )
    ).id
    const day = (
      await one(
        `select appointments_day((select (starts_at at time zone 'Africa/Kigali')::date from appointment where id = $1)) as d`,
        [t108.linked],
      )
    ).d
    await asAdmin()
    const a = await one(`select status::text, patient_id from appointment where id = $1`, [req])
    const linked = day.find((x) => x.id === t108.linked)
    const other = day.find((x) => x.id === t108.other)
    if (
      pid !== null ||
      a.status !== 'approved' ||
      a.patient_id !== null ||
      JSON.stringify(linked?.missing) !== '["address"]' ||
      other?.missing !== null
    )
      throw new Error(JSON.stringify({ pid, a, linked, other }))
    return 'booked with the name and phone only; the linked file still needs: address; no file: nothing listed'
  },
)
await step(
  '0108 D: national ID exactly 16 digits; passport or other ID 6 to 20 letters or digits',
  async () => {
    const r = {}
    r.long = await tryAs(
      staff.receptionist,
      `select register_patient_file('Ndayisaba', 'Long 108', 'male', null, 40, null, '11998800123456789')`,
    )
    r.short = await tryAs(staff.receptionist, `select update_patient($1, $2::jsonb)`, [
      t108.patient,
      JSON.stringify({ national_id: '119977010810101' }),
    ])
    r.passportBad = await tryAs(
      staff.receptionist,
      `select register_patient_file('Smith', 'Pass 108', 'male', null, 40, '0788108104', null, null, $1::jsonb)`,
      [JSON.stringify({ id_type: 'passport', id_number: 'X1' })],
    )
    await as(staff.receptionist)
    const pass = (
      await one(
        `select register_patient_file('Smith', 'Pass 108', 'male', null, 40, '0788108104', null, null, $1::jsonb) as r`,
        [JSON.stringify({ id_type: 'passport', id_number: 'pa 1234-567' })],
      )
    ).r
    await db.query(`select update_patient($1, $2::jsonb)`, [
      t108.patient,
      JSON.stringify({ national_id: '1 1997 7 0108101 0 12' }),
    ])
    r.dup = await tryAs(staff.receptionist, `select update_patient($1, $2::jsonb)`, [
      pass.patient_id,
      JSON.stringify({ id_type: 'national_id', national_id: '1199770108101012' }),
    ])
    await asAdmin()
    const p = await one(`select id_type, id_number, national_id from patient where id = $1`, [
      pass.patient_id,
    ])
    const kept = await one(`select national_id from patient where id = $1`, [t108.patient])
    const old = await one(
      `select count(*)::int as n from patient where national_id is not null and national_id !~ '^[0-9]{16}$'`,
    )
    if (
      !/16 digits/.test(r.long) ||
      !/16 digits/.test(r.short) ||
      !/6 to 20 letters or digits/.test(r.passportBad) ||
      !/already exists/.test(r.dup) ||
      p.id_type !== 'passport' ||
      p.id_number !== 'PA1234567' ||
      p.national_id !== null ||
      kept.national_id !== '1199770108101012' ||
      old.n !== 0
    )
      throw new Error(JSON.stringify({ r, p, kept, old }))
    return '17 and 15 digits refused (create and edit); passport PA1234567 kept upper case; "X1" refused; a national ID on two files refused'
  },
)
await step('0108 E: reception may be named as the one who measured', async () => {
  await as(staff.receptionist)
  const f = (
    await one(
      `select register_patient_file('Mukamana', 'Vitals 108', 'female', null, 35, '0788108105', null, null, $1::jsonb) as r`,
      [JSON.stringify({ national_id: '1199170108105044' })],
    )
  ).r
  const enc = (
    await one(`select open_encounter($1, 'opd', 'reception', null) as id`, [f.patient_id])
  ).id
  const nobody = await tryAs(
    staff.receptionist,
    `select record_vitals($1, '{"pulse":"80"}'::jsonb)`,
    [enc],
  )
  const me = await tryAs(
    staff.receptionist,
    `select record_vitals($1, '{"pulse":"82"}'::jsonb, null, null, null, $2)`,
    [enc, staff.receptionist],
  )
  const o = await one(
    `select count(*)::int as n, bool_and(performer_id = $2) as by_rec, bool_and(created_by = $2) as typed_by_rec
     from observation where encounter_id = $1 and deleted_at is null`,
    [enc, staff.receptionist],
  )
  if (!/choose the nurse/.test(nobody) || me !== 'ok' || o.n !== 1 || !o.by_rec || !o.typed_by_rec)
    throw new Error(JSON.stringify({ nobody, me, o }))
  return 'naming nobody still asks; "Me" saves her as the one who measured (and typed)'
})
await step(
  '0108 F: a required custom field is enforced when a file is made, kept on edit',
  async () => {
    await asAdmin()
    t108.fields = (await one(`select value from setting where key = 'patient.fields'`))?.value ?? []
    await as(staff.manager)
    await db.query(`select save_patient_builtins('{}'::jsonb)`)
    await db.query(`select save_setting('patient.fields', $1::jsonb)`, [
      JSON.stringify([
        { key: 'religion', label: 'Religion', type: 'text', required: true },
        { key: 'kin', label: 'Next of kin', type: 'text' },
      ]),
    ])
    const before = await patients108()
    const lacking = await tryAs(
      staff.receptionist,
      `select register_patient_file('Required', 'Field 108', 'female', null, 30, '0788108106')`,
    )
    const mid = await patients108()
    await as(staff.receptionist)
    const ok = (
      await one(
        `select register_patient_file('Required', 'Field 108', 'female', null, 30, '0788108106', null, null, $1::jsonb) as r`,
        [JSON.stringify({ extra: { religion: 'Catholic', kin: '  ' } })],
      )
    ).r
    const urgent = (
      await one(
        `select register_patient_file('Urgent', 'Field 108', 'male', null, 50, null, null, null, null, true) as r`,
      )
    ).r
    const emptied = await tryAs(staff.receptionist, `select update_patient($1, $2::jsonb)`, [
      ok.patient_id,
      JSON.stringify({ extra: { religion: '' } }),
    ])
    // an older file without the value may still be edited (it stays listed as missing)
    const older = await tryAs(staff.receptionist, `select update_patient($1, $2::jsonb)`, [
      urgent.patient_id,
      JSON.stringify({ phone_1: '0788108107' }),
    ])
    await asAdmin()
    const p = await one(`select extra from patient where id = $1`, [ok.patient_id])
    const m = await one(`select patient_missing(p) as m from patient p where id = $1`, [
      urgent.patient_id,
    ])
    const bad = await tryAs(staff.manager, `select save_patient_builtins($1::jsonb)`, [
      JSON.stringify({ blood: 'required' }),
    ])
    // the clinic's settings as they were
    await as(staff.manager)
    await db.query(`select save_setting('patient.fields', $1::jsonb)`, [
      JSON.stringify(t108.fields),
    ])
    await db.query(`select save_patient_builtins('{}'::jsonb)`)
    await asAdmin()
    if (
      !/fill in the required fields: Religion/.test(lacking) ||
      mid !== before ||
      p.extra.religion !== 'Catholic' ||
      'kin' in p.extra ||
      !/cannot be emptied: Religion/.test(emptied) ||
      older !== 'ok' ||
      !m.m.includes('extra:religion') ||
      !/unknown patient field/.test(bad)
    )
      throw new Error(JSON.stringify({ lacking, before, mid, p, emptied, older, m, bad }))
    return 'refused without Religion (no file); saved with it; the emergency file lists it as missing; emptying refused'
  },
)

// ---------------------------------------------------------------- 0109: walk-in buyers from a room store
const t109 = {}
await step('0109: the migration runs again on a database that already has it', async () => {
  await asAdmin()
  await db.exec(
    await readFile(path.join(migrationsDir, '20261219090000_room_store_walkin.sql'), 'utf8'),
  )
  return 'no error'
})
await step(
  '0109 A: a room store holder sells to a walk-in buyer only with the manager’s switch',
  async () => {
    // a room store held by d2, with 5 bottles of the pieces-only syrup of 0107
    await as(staff.manager)
    t109.store = (await one(`select save_location(null, 'Ward 109', 'room') as id`)).id
    await db.query(`select set_store_holders($1, $2, $3)`, [t109.store, [d2], []])
    await db.query(`select set_staff_permission($1, 'payment.take', null)`, [staff.cashier])
    await as(staff.pharmacist)
    const note = (
      await one(`select send_to_room($1, $2::jsonb) as j`, [
        t109.store,
        JSON.stringify([{ itemId: t107.syrup, quantity: 5 }]),
      ])
    ).j
    await as(d2)
    await db.query(`select confirm_receipt($1)`, [note.id])
    const lines = JSON.stringify([{ itemId: t107.syrup, quantity: 2 }])
    // without the switch: refused, with the reason
    const before = await hintAs(
      d2,
      `select create_counter_sale($1::jsonb, 'Walk-in 109', null, $2)`,
      [lines, t109.store],
    )
    // the manager gives the switch to d2 only
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'stock.sell_walkin', true)`, [d2])
    await as(d2)
    const mine = (await one(`select my_permissions() as j`)).j
    const sale = (
      await one(`select create_counter_sale($1::jsonb, 'Walk-in 109', null, $2) as j`, [
        lines,
        t109.store,
      ])
    ).j
    t109.sale = sale.id
    // a doctor without "Take payments" does not take the money: the sale waits at the cashier
    const pay = await codeAs(d2, `select take_counter_payment($1, 'cash')`, [sale.id])
    await as(staff.cashier)
    const paid = (await one(`select take_counter_payment($1, 'cash') as j`, [sale.id])).j
    await asAdmin()
    const told = await one(
      `select count(*)::int as n from notification
        where kind = 'counter_sale_paid' and recipient_user = $1 and params ->> 'saleId' = $2::text`,
      [d2, sale.id],
    )
    await as(d2)
    const handed = (await one(`select hand_over_counter_sale($1) as j`, [sale.id])).j
    await asAdmin()
    const left = (await one(`select usable_stock($1, $2) as n`, [t107.syrup, t109.store])).n
    if (
      before !== '42501/not_permitted' ||
      !mine.includes('stock.sell_walkin') ||
      Number(sale.total) !== 3000 ||
      pay !== '42501' ||
      paid.status !== 'paid' ||
      told.n !== 1 ||
      handed.status !== 'handed_over' ||
      Number(left) !== 3
    )
      throw new Error(JSON.stringify({ before, mine, sale, pay, paid, told, handed, left }))
    return 'refused without the switch; with it 2 bottles = 3,000, paid at the cashier, the seller told, handed over; 3 left'
  },
)
await step(
  '0109 B: the switch is not enough without holding the store; the pharmacy desk does not sell from a room store',
  async () => {
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'stock.sell_walkin', true)`, [d1])
    const lines = JSON.stringify([{ itemId: t107.syrup, quantity: 1 }])
    const notHolder = await hintAs(d1, `select create_counter_sale($1::jsonb, null, null, $2)`, [
      lines,
      t109.store,
    ])
    const pharmacist = await hintAs(
      staff.pharmacist,
      `select create_counter_sale($1::jsonb, null, null, $2)`,
      [lines, t109.store],
    )
    // too many for the store: the store's own words
    const tooMany = await codeAs(d2, `select create_counter_sale($1::jsonb, null, null, $2)`, [
      JSON.stringify([{ itemId: t107.syrup, quantity: 9 }]),
      t109.store,
    ])
    // the manager may sell from any store
    await as(staff.manager)
    const byManager = (
      await one(`select create_counter_sale($1::jsonb, 'Manager 109', null, $2) as j`, [
        lines,
        t109.store,
      ])
    ).j
    await db.query(`select set_staff_permission($1, 'stock.sell_walkin', null)`, [d1])
    // the seller cancels an unpaid sale of the store
    await as(d2)
    await db.query(`select cancel_counter_sale($1, 'test 109 over')`, [byManager.id])
    // the list: the seller sees the store's sales, a doctor without rights does not
    const seen = (await one(`select counter_sales() as j`)).j
    await as(d1)
    const notSeen = (await one(`select counter_sales() as j`)).j
    await as(staff.manager)
    await db.query(`select set_staff_permission($1, 'stock.sell_walkin', null)`, [d2])
    await asAdmin()
    const mineRow = seen.find((x) => x.id === t109.sale)
    if (
      notHolder !== '42501/not_permitted' ||
      pharmacist !== '42501/not_permitted' ||
      tooMany !== '23514' ||
      byManager.status !== 'open' ||
      !mineRow ||
      mineRow.roomStore !== true ||
      notSeen.some((x) => x.id === t109.sale)
    )
      throw new Error(JSON.stringify({ notHolder, pharmacist, tooMany, byManager, mineRow }))
    return 'not a holder: refused; the pharmacist: refused; 9 > 3: refused; the manager sells; the seller sees and cancels'
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
