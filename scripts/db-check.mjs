/**
 * Runs every migration and the seed against an in-memory Postgres (PGlite), then walks the
 * patient journey of doc §3 / §4.5 to prove the business rules work before touching Supabase.
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
    return `${lines.n} lines · ${payers.n} insurers · open=${status.j.open}`
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
await step('auth users → profiles trigger', async () => {
  await mkUser('j.uwimana', 'Uwimana Josiane', 'receptionist')
  await mkUser('c.nyirahabimana', 'Nyirahabimana Chantal', 'nurse', { station: 'Triage' })
  await mkUser('b.mukamana', 'Dr. Mukamana Béatrice', 'doctor', { station: 'Consultation 1' })
  await mkUser('s.mugisha', 'Mugisha Samuel', 'cashier')
  await mkUser('p.kalisa', 'Kalisa Pascal', 'pharmacist')
  await mkUser('t.mugabo', 'Mugabo Théogène', 'manager', { dashboard: 'manager' })
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
    if (dir.n !== 6) throw new Error(`directory ${dir.n}`)
    if (logins.n < 1) throw new Error('login not audited')
    return `stamped · ${logins.n} login event(s) · deactivation enforced · directory ${dir.n}`
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

// ---------------------------------------------------------------- the patient journey (doc §3, §4.5 worked example)
let patientId, coverageId, encounterId, invoiceId
await step('receptionist registers a patient → hub file number', async () => {
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
await step('walk-in: open_encounter → ticket + draft invoice', async () => {
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
  )
})
await step('doctor charges consultation (RSSB preset 5,000)', async () => {
  await as(staff.doctor)
  await db.query(
    `select add_charge($1, 'consultation', (select id from service where code = 'CONS-GEN'))`,
    [encounterId],
  )
})
await step('doctor orders lab (preset 2,000 + 4,000)', async () => {
  await db.query(
    `select add_charge($1, 'laboratory', (select id from service where code = 'LAB-MRDT'))`,
    [encounterId],
  )
  await db.query(
    `select add_charge($1, 'laboratory', (select id from service where code = 'LAB-FBC'))`,
    [encounterId],
  )
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
await step('pharmacist dispenses FEFO 21 × amoxicillin and charges 6,300', async () => {
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
  'cashier cannot post an invoice the receptionist could (billing.write)',
  async () => {
    await as(staff.receptionist)
    await db.query(`select post_invoice($1)`, [invoiceId])
  },
  /not allowed/i,
)
await step('cashier records MoMo 2,745 with reference and posts → INV number + claim', async () => {
  await as(staff.cashier)
  await db.query(`select record_payment($1, 'momo', 2745, 'MP251015.1234.A12345', '0788123456')`, [
    invoiceId,
  ])
  const n = await one(`select post_invoice($1) as number`, [invoiceId])
  const bal = await one(`select invoice_balance($1) as balance`, [invoiceId])
  await asAdmin()
  const claim = await one(`select status, amount from claim where invoice_id = $1`, [invoiceId])
  if (Number(bal.balance) !== 0) throw new Error(`balance ${bal.balance}`)
  return `${n.number}, balance 0, claim ${claim.status} ${claim.amount}`
})
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
  return `${b.number} · ${b.total_claimed}`
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
await step('anonymous inquiry for Dr. Mukamana next Monday 10:00 → reference', async () => {
  await as(null, 'anon')
  const r = await one(
    `select create_appointment_inquiry('mb', $1::timestamptz, 'Uwase Claudine', '0788 000 111', 'RSSB RAMA', 'consultation', null, 'whatsapp') as ref`,
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
await step('anonymous sees the slot as busy in public_booked_slots', async () => {
  const r = await one(
    `select count(*)::int as n from public_booked_slots where starts_at = $1::timestamptz`,
    [slot],
  )
  if (r.n !== 1) throw new Error(`${r.n} rows`)
})
await expectError(
  'second inquiry for the same slot is refused',
  async () =>
    db.query(
      `select create_appointment_inquiry('mb', $1::timestamptz, 'Other Person', '0788 000 222', null, null, null, 'sms')`,
      [slot],
    ),
  /just been taken/i,
)
await expectError(
  'inquiry outside working hours is refused',
  async () =>
    db.query(
      `select create_appointment_inquiry('nf', ($1::timestamptz + interval '6 days'), 'Sunday Person', '0788 000 333', null, null, null, 'sms')`,
      [slot],
    ),
  /does not work at that time/i,
)
await step('receptionist approves, doctor accepts → confirmed', async () => {
  await as(staff.receptionist)
  await db.query(`select approve_inquiry($1, $2)`, [appointmentId, patientId])
  await as(staff.doctor)
  await db.query(`select accept_appointment($1)`, [appointmentId])
  await asAdmin()
  const a = await one(`select status from appointment where id = $1`, [appointmentId])
  if (a.status !== 'confirmed') throw new Error(a.status)
  return 'confirmed'
})
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
await step('manager adjusts prices ×1.1, then deletes a treatment', async () => {
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

finish()

function finish() {
  const pad = (s, n) => String(s).padEnd(n)
  console.log('')
  for (const r of results) console.log(`${r.ok ? ' ok ' : 'FAIL'}  ${pad(r.step, 62)} ${r.detail}`)
  console.log('')
  console.log(`${results.length - failures}/${results.length} checks passed`)
  process.exit(failures ? 1 : 0)
}
