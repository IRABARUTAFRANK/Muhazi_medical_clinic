/**
 * Translation check: every English text must exist in Kinyarwanda and French, and must not
 * simply be the English text copied over (except names, codes and formats listed below).
 *
 *   pnpm i18n:check
 *
 * Run it before every commit that adds screen text; it fails (exit 1) with the keys to translate.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'shared',
  'src',
  'i18n',
)
const load = (l) => JSON.parse(readFileSync(path.join(dir, `${l}.json`), 'utf8'))
const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]],
  )

/** Texts that are rightly identical in every language: names, codes, units, formats. */
const SAME_OK =
  /^(\{\{[^}]+\}\}[\s·–:.,-]*)+$|^[\d\s/:.x…-]+$|Muhazi Medical Clinic|MMC-|Excel|PDF|WhatsApp|SMS|RSSB|RAMA|MMI|MoMo|Airtel|TIN|RWF|PIN|SpO₂|Kiramuruzi|Mutuelle de Santé|Uwase Claudine|Uwimana Josiane|Mukamana Alice|07xx/

const en = Object.fromEntries(flat(load('en')).filter(([k]) => !k.startsWith('_')))
let failed = false
for (const lang of ['rw', 'fr']) {
  const other = Object.fromEntries(flat(load(lang)))
  const missing = Object.keys(en).filter((k) => other[k] === undefined)
  const copied = Object.keys(en).filter(
    (k) =>
      other[k] === en[k] &&
      /[a-z]{4}/i.test(en[k]) &&
      !SAME_OK.test(en[k]) &&
      // French shares many words with English (Patients, Notes, Type…); only flag sentences there.
      (lang === 'rw' || en[k].trim().split(/\s+/).length > 2),
  )
  const placeholders = Object.keys(en).filter((k) => {
    if (other[k] === undefined) return false
    const ph = (s) =>
      (String(s).match(/{{\s*\w+\s*}}/g) ?? [])
        .map((x) => x.replace(/\s/g, ''))
        .sort()
        .join()
    return ph(en[k]) !== ph(other[k])
  })
  const problems = [
    ...missing.map((k) => `missing   ${k} = ${en[k]}`),
    ...copied.map((k) => `english   ${k} = ${en[k]}`),
    ...placeholders.map((k) => `{{ }}     ${k}: ${en[k]}  →  ${other[k]}`),
  ]
  console.log(`${lang}: ${Object.keys(en).length - problems.length}/${Object.keys(en).length} ok`)
  for (const p of problems) console.log(`  ${p}`)
  if (problems.length) failed = true
}
process.exit(failed ? 1 : 0)
