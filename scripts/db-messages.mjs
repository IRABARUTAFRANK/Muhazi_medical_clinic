// The sentences the database can refuse with, turned into a table the web app translates.
//
//   node scripts/db-messages.mjs           → regenerates apps/web/src/lib/api/db-messages.generated.ts
//   node scripts/db-messages.mjs --check   → also fails when a sentence has no dbErrors.* text in en.json
//
// Every `raise exception '…'` in the LATEST definition of each SQL function (the last migration that
// defines it wins) is one entry: a regular expression built from the sentence (each `%` becomes a
// capture) and the i18n key `dbErrors.<8 hex of sha1(sentence)>`. Refusals that carry a hint or an
// MS0xx code are translated by errors.ts from its own table and are left out here.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'supabase', 'migrations')
const errorsTs = readFileSync(path.join(root, 'apps/web/src/lib/api/errors.ts'), 'utf8')
const out = path.join(root, 'apps/web/src/lib/api/db-messages.generated.ts')
const check = process.argv.includes('--check')

// the hints and codes errors.ts already translates
const known = new Set()
for (const m of errorsTs.matchAll(/^\s+([a-z_]+|[A-Z]{2}\d{3}): '[a-zA-Z]+',?$/gm)) known.add(m[1])

// --- SQL parsing (comments stripped; latest definition per function) ---
const stripComments = (sql) => {
  let o = '',
    i = 0,
    inStr = false
  while (i < sql.length) {
    const c = sql[i]
    if (inStr) {
      o += c
      if (c === "'") inStr = false
      i++
      continue
    }
    if (c === "'") {
      inStr = true
      o += c
      i++
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2)
      i = e < 0 ? sql.length : e + 2
      o += ' '
      continue
    }
    o += c
    i++
  }
  return o
}
const headerRe =
  /\b(create\s+(?:or\s+replace\s+)?function|drop\s+function(?:\s+if\s+exists)?)\s+(?:public\.)?("?)([a-z_][a-z0-9_]*)\2/gi
const raisesOf = (body, fn) => {
  const res = []
  const re = /raise\s+exception\s+'/gi
  let m
  while ((m = re.exec(body))) {
    let i = m.index + m[0].length,
      msg = ''
    while (i < body.length) {
      if (body[i] === "'") {
        if (body[i + 1] === "'") {
          msg += "'"
          i += 2
          continue
        }
        i++
        break
      }
      msg += body[i++]
    }
    let depth = 0,
      inStr = false,
      j = i,
      rest = ''
    while (j < body.length) {
      const c = body[j]
      if (inStr) {
        if (c === "'") inStr = false
        rest += c
        j++
        continue
      }
      if (c === "'") {
        inStr = true
        rest += c
        j++
        continue
      }
      if (c === '(') depth++
      if (c === ')') depth--
      if (c === ';' && depth <= 0) break
      rest += c
      j++
    }
    re.lastIndex = j
    const using = rest.slice(Math.max(0, rest.search(/\busing\b/i)))
    const errcode = (/errcode\s*=\s*'([^']*)'/i.exec(using) || [])[1] || null
    const hint = (/\bhint\s*=\s*'((?:[^']|'')*)'/i.exec(using) || [])[1] || null
    res.push({ message: msg, errcode, hint, fn })
  }
  return res
}
const fns = new Map()
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const sql = stripComments(readFileSync(path.join(dir, file), 'utf8'))
  headerRe.lastIndex = 0
  let m
  while ((m = headerRe.exec(sql))) {
    const name = m[3].toLowerCase()
    if (m[1].toLowerCase().startsWith('drop')) {
      fns.delete(name)
      continue
    }
    const open = sql.indexOf('$$', m.index)
    if (open < 0) continue
    const close = sql.indexOf('$$', open + 2)
    headerRe.lastIndex = close + 2
    fns.set(name, raisesOf(sql.slice(open + 2, close), name))
  }
}

// --- one entry per distinct sentence ---
const byMessage = new Map()
for (const raises of fns.values())
  for (const r of raises) {
    if ((r.hint && known.has(r.hint)) || (r.errcode && known.has(r.errcode))) continue
    const e = byMessage.get(r.message) ?? { message: r.message, fns: new Set() }
    e.fns.add(r.fn)
    byMessage.set(r.message, e)
  }
const entries = [...byMessage.values()]
  .map((e) => {
    const key = 'dbErrors.' + createHash('sha1').update(e.message).digest('hex').slice(0, 8)
    let n = 0
    const source = e.message
      .replace(/%%/g, '\u0000')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, () => (n++, '(.+?)'))
      .replace(/\u0000/g, '%')
    return {
      key,
      message: e.message,
      source: '^' + source + '$',
      params: n,
      fns: [...e.fns].sort(),
    }
  })
  // longer sentences first, so a capture never swallows a more specific sentence
  .sort((a, b) => b.message.length - a.message.length || a.message.localeCompare(b.message))

const lines = entries.map(
  (e) =>
    `  [/${e.source.replace(/\//g, '\\/')}/, '${e.key}', ${e.params}], // ${e.fns.slice(0, 3).join(', ')}${e.fns.length > 3 ? ', …' : ''}`,
)
writeFileSync(
  out,
  `// Generated by scripts/db-messages.mjs from supabase/migrations: do not edit.
// [sentence as a regular expression, i18n key, number of captures]. Captures become {{p1}}, {{p2}}…
export const DB_MESSAGES: ReadonlyArray<readonly [RegExp, string, number]> = [
${lines.join('\n')}
]
`,
)
console.log(`${entries.length} sentences → ${path.relative(root, out)}`)

if (check) {
  const en =
    JSON.parse(readFileSync(path.join(root, 'packages/shared/src/i18n/en.json'), 'utf8'))
      .dbErrors ?? {}
  const missing = entries.filter((e) => !en[e.key.slice('dbErrors.'.length)])
  if (missing.length) {
    console.log(
      `\n${missing.length} sentence(s) without a dbErrors text in en.json (they show in English):`,
    )
    for (const e of missing) console.log(`  ${e.key}  ${e.message}  (${e.fns[0]})`)
    process.exit(1)
  }
  console.log('every sentence has a dbErrors text')
}
