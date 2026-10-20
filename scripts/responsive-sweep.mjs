/**
 * Responsive sweep: every screen at phone and tablet widths, full page, plus a list of the
 * elements that poke past the screen edge (report.txt). Run the sample dev server first:
 *
 *   cd apps/web && npx vite --mode sample --port 5199
 *   pnpm shots:responsive [outDir] [widths] [names]     e.g. pnpm shots:responsive out 360,768
 *
 * Tables inside overflow-x-auto boxes are reported too; they scroll and are fine.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5199'
const OUT = path.resolve(process.argv[2] ?? 'sweep')
const WIDTHS = (process.argv[3] ?? '360,412,768,1024').split(',').map(Number)
const ONLY = process.argv[4] ? new Set(process.argv[4].split(',')) : null
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const U = {
  rec: { id: 'u-rec', username: 'j.uwimana', name: 'Uwimana Josiane', role: 'receptionist' },
  nur: {
    id: 'u-nur',
    username: 'c.nyirahabimana',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    station: 'Triage',
  },
  doc: {
    id: 'u-doc',
    username: 'b.mukamana',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    station: 'Consultation 1',
  },
  cash: { id: 'u-cash', username: 's.mugisha', name: 'Mugisha Samuel', role: 'cashier' },
  lab: {
    id: 'u-lab',
    username: 'u.lab',
    name: 'Uwera Diane',
    role: 'lab_tech',
    station: 'Laboratory',
  },
  mgr: {
    id: 'u-mgr',
    username: 't.mugabo',
    name: 'Mugabo Théogène',
    role: 'manager',
    dashboard: 'manager',
  },
}
const SHOTS = [
  ['landing', '/'],
  ['book', '/book'],
  ['login', '/login?staff=MMC-S-0001'],
  ['home-rec', '/app', 'rec'],
  ['home-nur', '/app', 'nur'],
  ['home-doc', '/app', 'doc'],
  ['home-cash', '/app', 'cash'],
  ['home-lab', '/app', 'lab'],
  ['dashboard', '/app/dashboard', 'mgr'],
  ['register', '/app/register', 'mgr'],
  ['vitals', '/app/vitals', 'nur'],
  ['visits', '/app/visits', 'mgr'],
  ['visit', '/app/visit?encounter=e-1', 'doc'],
  ['appointments', '/app/appointments', 'rec'],
  ['calendar', '/app/calendar', 'doc'],
  ['patients', '/app/patients', 'mgr'],
  ['patient', '/app/patient?id=p-1', 'mgr'],
  ['prices', '/app/prices', 'mgr'],
  ['staff', '/app/staff', 'mgr'],
  ['staff-new', '/app/staff', 'mgr', 'main button.bg-primary'],
  ['history', '/app/history', 'mgr'],
  ['notifications', '/app/notifications', 'mgr'],
  ['settings', '/app/settings', 'mgr'],
  ['lab', '/app/lab', 'lab'],
  ['bills', '/app/bills', 'cash'],
  ['payments', '/app/payments', 'cash'],
  ['stock', '/app/stock', 'mgr'],
  ['patient-visits', '/app/patient?id=p-1&tab=visits', 'mgr'],
]

await mkdir(OUT, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox'],
})
const report = []
try {
  for (const [name, p, user, click] of SHOTS) {
    if (ONLY && !ONLY.has(name)) continue
    for (const w of WIDTHS) {
      const page = await browser.newPage()
      await page.setViewport({
        width: w,
        height: Math.round(w * 1.9),
        deviceScaleFactor: 1,
        isMobile: w < 700,
        hasTouch: w < 700,
      })
      const session = { state: { user: user ? U[user] : null }, version: 0 }
      await page.evaluateOnNewDocument(
        (s, p) => {
          sessionStorage.setItem('mmc.session', s)
          localStorage.setItem('mmc.prefs', p)
        },
        JSON.stringify(session),
        JSON.stringify({ state: { lang: 'en', theme: 'light' }, version: 0 }),
      )
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(BASE + p, { waitUntil: 'networkidle0' })
      if (click) {
        try {
          await page.click(click)
          await new Promise((r) => setTimeout(r, 500))
        } catch (e) {
          errors.push('click: ' + e.message)
        }
      }
      await page.evaluate(() => document.fonts.ready)
      // reveal-on-scroll sections: force visible for the capture
      await page.evaluate(() => {
        document
          .querySelectorAll('[data-reveal]')
          .forEach((el) => el.classList.add('is-visible', 'revealed'))
        document.querySelectorAll('main').forEach((m) => (m.style.overflow = 'visible'))
        const shell = document.querySelector('.bg-surface.text-ink.relative')
        if (shell) {
          shell.style.height = 'auto'
          shell.style.overflow = 'visible'
        }
      })
      await new Promise((r) => setTimeout(r, 400))
      const over = await page.evaluate((vw) => {
        const out = []
        const seen = new Set()
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          if (r.right > vw + 2 || r.left < -2) {
            // report the outermost offender only
            let p = el.parentElement
            let inner = false
            while (p) {
              if (seen.has(p)) {
                inner = true
                break
              }
              p = p.parentElement
            }
            seen.add(el)
            if (inner) continue
            const cls = (el.className && typeof el.className === 'string' ? el.className : '')
              .split(' ')
              .slice(0, 6)
              .join(' ')
            out.push(
              `${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)} w=${Math.round(r.width)} text="${(el.textContent || '').trim().slice(0, 40)}"`,
            )
          }
          if (out.length > 8) break
        }
        return { docW: document.documentElement.scrollWidth, out }
      }, w)
      const file = path.join(OUT, `${name}-${w}.png`)
      await page.screenshot({ path: file, fullPage: true })
      const h = await page.evaluate(() => document.documentElement.scrollHeight)
      const line = `${name}@${w}: docW=${over.docW} h=${h}${errors.length ? ' ERR ' + errors.join(' | ') : ''}${over.out.length ? '\n   ' + over.out.join('\n   ') : ''}`
      report.push(line)
      console.log(line)
      await page.close()
    }
  }
} finally {
  await browser.close()
  await writeFile(path.join(OUT, 'report.txt'), report.join('\n'))
}
