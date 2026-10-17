/**
 * Screenshot every designed screen with the locally installed Microsoft Edge,
 * at the same frame sizes as the Claude Design boards, so they can be compared.
 *
 *   pnpm dev                      # in one terminal
 *   pnpm shots [outDir]           # default ./screenshots
 *
 * Env: BASE_URL (default http://localhost:5173), EDGE_PATH (default Edge x86 install).
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT = path.resolve(process.argv[2] ?? 'screenshots')
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

/** Mirrors packages/shared/src/mocks/staff.ts (plain JS, no TS import here). */
const USERS = {
  'u-rec': { id: 'u-rec', username: 'j.uwimana', name: 'Uwimana Josiane', role: 'receptionist' },
  'u-nur': {
    id: 'u-nur',
    username: 'c.nyirahabimana',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    station: 'Triage',
  },
  'u-doc': {
    id: 'u-doc',
    username: 'b.mukamana',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    station: 'Consultation 1',
  },
  'u-cash': { id: 'u-cash', username: 's.mugisha', name: 'Mugisha Samuel', role: 'cashier' },
  'u-mgr': {
    id: 'u-mgr',
    username: 't.mugabo',
    name: 'Mugabo Théogène',
    role: 'manager',
    dashboard: 'manager',
  },
  'u-head': {
    id: 'u-head',
    username: 'f.ndayisaba',
    name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    station: 'Dental',
    dashboard: 'head',
    headOf: 'Dental',
  },
}

const PC = [1366, 768]
const TABLET = [800, 1280]

/** name, path, viewport, user id, theme, full-page capture */
const SHOTS = [
  { name: 'landing-1366', path: '/', vp: PC, full: true },
  { name: 'booking-1366', path: '/book', vp: PC, full: true },
  { name: 'landing-mobile', path: '/', vp: [390, 844], full: true },
  {
    name: 'landing-mobile-menu',
    path: '/',
    vp: [390, 844],
    click: 'button[aria-controls="site-menu"]',
  },
  { name: 'booking-dental', path: '/book?category=dental', vp: PC, full: true },
  { name: 'booking-lab', path: '/book?category=laboratory', vp: PC, full: true },
  { name: 'home-receptionist', path: '/app', vp: PC, user: 'u-rec' },
  { name: 'home-nurse', path: '/app', vp: PC, user: 'u-nur' },
  { name: 'home-doctor', path: '/app', vp: PC, user: 'u-doc' },
  { name: 'home-cashier', path: '/app', vp: PC, user: 'u-cash' },
  { name: 'home-offline', path: '/app?mode=offline', vp: PC, user: 'u-rec' },
  { name: 'home-empty', path: '/app?mode=empty', vp: PC, user: 'u-rec' },
  { name: 'home-dim', path: '/app', vp: PC, user: 'u-doc', theme: 'dim' },
  { name: 'tablet-receptionist', path: '/app', vp: TABLET, user: 'u-rec' },
  { name: 'tablet-nurse', path: '/app', vp: TABLET, user: 'u-nur' },
  { name: 'tablet-doctor', path: '/app', vp: TABLET, user: 'u-doc' },
  { name: 'tablet-cashier', path: '/app', vp: TABLET, user: 'u-cash' },
  { name: 'tablet-offline', path: '/app?mode=offline', vp: TABLET, user: 'u-rec' },
  { name: 'dashboard-1366', path: '/app/dashboard', vp: [1366, 1760], user: 'u-mgr' },
  { name: 'staff-1366', path: '/app/staff', vp: [1366, 900], user: 'u-mgr' },
  {
    name: 'staff-new-1366',
    path: '/app/staff',
    vp: [1366, 1100],
    user: 'u-mgr',
    click: 'main button.bg-primary',
  },
  { name: 'staff-tablet', path: '/app/staff', vp: TABLET, user: 'u-mgr' },
  {
    name: 'dashboard-1366-dim',
    path: '/app/dashboard',
    vp: [1366, 1760],
    user: 'u-mgr',
    theme: 'dim',
  },
  { name: 'dashboard-head', path: '/app/dashboard', vp: [1366, 1300], user: 'u-head' },
  { name: 'patients-1366', path: '/app/patients', vp: [1366, 900], user: 'u-mgr' },
  { name: 'patient-file-1366', path: '/app/patient?id=p-1', vp: [1366, 1100], user: 'u-mgr' },
  {
    name: 'patient-file-edit',
    path: '/app/patient?id=p-1',
    vp: [1366, 1500],
    user: 'u-mgr',
    click: 'main button:nth-of-type(2)',
  },
  {
    name: 'visit-clinical-1366',
    path: '/app/visit?encounter=e-1',
    vp: [1366, 1500],
    user: 'u-doc',
  },
  { name: 'register-1366', path: '/app/register', vp: [1366, 1000], user: 'u-mgr' },
  { name: 'settings-fields', path: '/app/settings', vp: [1366, 1900], user: 'u-mgr' },
  {
    name: 'visit-rx-1366',
    path: '/app/visit?encounter=e-1',
    vp: [1366, 1300],
    user: 'u-doc',
    click: 'main .flex.flex-wrap.gap-2 > button:nth-child(3)',
  },
  { name: 'dashboard-1920', path: '/app/dashboard', vp: [1920, 1320], user: 'u-mgr' },
  {
    name: 'dashboard-1920-dim',
    path: '/app/dashboard',
    vp: [1920, 1320],
    user: 'u-mgr',
    theme: 'dim',
  },
]

const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null

await mkdir(OUT, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox'],
})
try {
  for (const shot of SHOTS) {
    if (only && !only.has(shot.name)) continue
    const page = await browser.newPage()
    await page.setViewport({ width: shot.vp[0], height: shot.vp[1], deviceScaleFactor: 1 })
    const session = shot.user
      ? { state: { user: USERS[shot.user] }, version: 0 }
      : { state: { user: null }, version: 0 }
    const prefs = { state: { lang: 'en', theme: shot.theme ?? 'light' }, version: 0 }
    await page.evaluateOnNewDocument(
      (s, p) => {
        localStorage.setItem('mmc.session', s)
        localStorage.setItem('mmc.prefs', p)
      },
      JSON.stringify(session),
      JSON.stringify(prefs),
    )
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.goto(BASE + shot.path, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready)
    if (shot.click) {
      await page.click(shot.click)
      await new Promise((r) => setTimeout(r, 400))
    }
    if (shot.full) {
      // Walk down the page so reveal-on-scroll sections render, then return to the top.
      await page.evaluate(async () => {
        const step = Math.max(200, Math.floor(window.innerHeight * 0.6))
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y)
          await new Promise((r) => setTimeout(r, 60))
        }
        window.scrollTo(0, 0)
        await new Promise((r) => setTimeout(r, 700))
      })
    }
    await new Promise((r) => setTimeout(r, 150))
    const file = path.join(OUT, `${shot.name}.png`)
    await page.screenshot({ path: file, fullPage: Boolean(shot.full) })
    console.log(
      `${errors.length ? 'ERR ' : 'ok  '}${shot.name} → ${file}${errors.length ? '\n    ' + errors.join('\n    ') : ''}`,
    )
    await page.close()
  }
} finally {
  await browser.close()
}
