# Muhazi Medical Clinic System

Clinic management software for Muhazi Medical Clinic, a private polyclinic in Kiramuruzi,
Gatsibo District, Eastern Province, Rwanda. The full specification is in
[assets/Muhazi_Medical_Clinic_System_Final_Project_Document.docx](assets/) and the design source
(tokens, screens, sample data) is in [mmc-design/mmc-design](mmc-design/mmc-design/).

## Status (15 October 2026)

| Part              | State                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Public site `/`   | Redesigned around the logo palette (blue, green, sky, gold): gradient hero, reveal-on-scroll, marquee of insurers, map embed, expanded footer |
| Booking `/book`   | Category chips, doctor list, 7-day calendar, request panel; sends a real inquiry when Supabase is configured                                  |
| Staff home `/app` | Receptionist, nurse, doctor, cashier (PC rail, tablet tabs, offline and quiet variants, dim theme)                                            |
| Dashboard         | Manager (five rows) and head-of-station variant                                                                                               |
| Database          | Full schema in [supabase/](supabase/README.md): 71 tables, RLS per role, business rules as SQL functions, verified by `pnpm db:check`         |
| Auth              | Supabase Auth (username → email, six-digit PIN) when configured; sample accounts otherwise                                                    |
| Employees         | Manager-only page `/app/staff`: create accounts, hand over and reset PINs, deactivate; forced PIN change at first sign-in; 5-minute idle lock |

Design documents: [docs/database-design.md](docs/database-design.md) (schema, flows, permissions,
function API) and [docs/security-and-access.md](docs/security-and-access.md) (accounts, sign-in,
controls). The whole database as one file: `supabase/all.sql`.

Not built yet: PowerSync offline sync, the Capacitor shell, the PWA service worker, messaging
adapters, and the screens of doc §12.5 (patient search and registration, queue board,
consultation, charge screen, cashier, pharmacy dispensing, insurer setup, claims). The staff
pages still read sample data; the database functions they will call already exist.

## Getting started

Requires Node ≥ 22.12 and pnpm 12 (`npm i -g pnpm`).

```sh
pnpm install
pnpm dev            # http://localhost:5173 (sample data unless apps/web/.env.local has a Supabase URL)
```

Other commands:

```sh
pnpm build          # typecheck + production build of apps/web
pnpm typecheck      # all packages
pnpm lint           # eslint (apps/web)
pnpm test           # vitest (packages/shared + apps/web)
pnpm db:check       # run all migrations + seed in an in-memory Postgres and walk the patient journey
pnpm db:bundle      # write supabase/all.sql (every migration + seed) for the Supabase SQL editor
pnpm db:apply       # apply pending migrations over SUPABASE_DB_URL (--seed adds the seed)
pnpm db:seed-staff  # create the sample staff accounts in Supabase Auth
pnpm db:verify      # smoke-test the live project with the publishable key (reads, sign-in, RLS)
pnpm format         # prettier
pnpm shots [dir]    # screenshots of every screen with the installed Microsoft Edge (dev server must run)
```

### Connecting Supabase

Done on 15 October 2026 for project `wwxmdqdrdekpzcbijsqo`: all migrations and the seed are
applied, the eight sample staff accounts exist, and `pnpm db:verify` passes. The steps below are
for a new project or the clinic hub.

1. Copy `.env.example` → `.env` and `apps/web/.env.example` → `apps/web/.env.local`, fill in the
   project URL and keys (the secret key never goes into `apps/web`).
2. Apply the schema: paste `supabase/all.sql` into the SQL editor once, or `pnpm db:apply --seed`
   with the database connection string (see [supabase/README.md](supabase/README.md)).
3. `pnpm db:seed-staff` creates the staff accounts below in Supabase Auth.
4. The public site then shows live data: practitioners and their calendars, service prices,
   insurers, opening hours, contact details and the "clinic now" status; booking inquiries are
   stored. The full database design is in [docs/database-design.md](docs/database-design.md).

### Sample accounts

Sample mode: any PIN. Live mode: the six-digit PINs printed by `seed-staff.mjs`.

| Username          | Who                                        | Lands on         |
| ----------------- | ------------------------------------------ | ---------------- |
| `j.uwimana`       | Uwimana Josiane, receptionist              | `/app`           |
| `c.nyirahabimana` | Nyirahabimana Chantal, nurse (Triage)      | `/app`           |
| `b.mukamana`      | Dr. Mukamana Béatrice, doctor (Consult. 1) | `/app`           |
| `s.mugisha`       | Mugisha Samuel, cashier                    | `/app`           |
| `t.mugabo`        | Mugabo Théogène, manager / owner           | `/app/dashboard` |
| `f.ndayisaba`     | Dr. Ndayisaba Félix, head of Dental        | `/app`           |

The clinic is open 24 hours a day, 7 days a week; opening hours live in the `clinic.hours`
setting and drive the open/closed status on the public site.

Design variants are reachable by URL: `/app?mode=offline`, `/app?mode=empty`,
`/app/dashboard?view=head`, `/book?category=dental`. The dim theme is in the user menu ("Night
use"). Tablet layout applies below 901 px.

## Repository layout

```
apps/web/               React 19 + Vite 8 PWA (public site and staff app)
  src/routes/           TanStack Router file routes (routeTree.gen.ts is generated)
  src/pages/            landing, booking, home, dashboard, placeholder
  src/components/ui/    button, badge, card, chip, seg, field, avatar, icon
  src/components/staff/ top bar, rail, tablet nav, more sheet, sync badge, shell
  src/components/charts line chart and horizontal bars (one subject, one colour)
  src/lib/supabase.ts   browser client (null → sample data); lib/api/* data modules
  src/store/            zustand: prefs (lang, theme), session (user), sync state
  src/styles/           tokens.css (design tokens), brand.css (public-site palette + motion), Tailwind mapping
packages/shared/        types, formatters, booking slot rules, i18n (en, fr, rw), sample data
supabase/               migrations, seed, README (schema, permissions, how to apply)
scripts/                screenshots.mjs (Edge), db-check.mjs (PGlite), seed-staff.mjs (Auth admin)
mmc-design/             Claude Design handoff (read-only reference)
assets/                 Project document
```

## Architecture

- **Frontend**: React + Vite PWA, TanStack Router, Tailwind 4 on the design tokens, i18next
  (Kinyarwanda, English, French), zustand stores. Every data module (`src/lib/api/*`) calls
  Supabase when `VITE_SUPABASE_URL` is set and falls back to `@mmc/shared` sample data otherwise.
- **Backend**: Supabase. Postgres holds the schema of doc §10 with row-level security driven by
  `role_permissions`; atomic business rules (`add_charge`, `post_invoice`, `dispense_fefo`,
  `create_appointment_inquiry`, …) are SQL functions called through `supabase.rpc()`. The
  anonymous public site can only read two views and create an inquiry. Supabase Auth signs staff
  in; Storage will hold scans and consents; Edge Functions will send WhatsApp/SMS later.
- **Offline**: all tables already carry the UUID/device/version columns PowerSync needs; sync
  rules per role come with the phase-1 offline gate.

## Conventions that must survive

- **Tokens.** `apps/web/src/styles/tokens.css` is a verbatim copy of `mmc-design/tokens.css`;
  Tailwind utilities map onto it in `globals.css` (`bg-card`, `text-ink-2`, `bg-green-bg`,
  `text-c-money`, …). Tailwind's default palette is disabled so no off-system colour can slip in.
  `brand.css` adds the logo palette and motion for the public site under `.theme-public` only;
  the staff app keeps the calmer tokens.
- **Semantic colour is never alone.** Triage, result flags, sync and appointment states always
  carry a dot, icon or word (`Badge`).
- **Formats.** `RWF 18,300` with tabular numbers, dates `dd/mm/yyyy`, 24-hour time, through
  `formatRwf`, `formatDate`, `formatTime` in `@mmc/shared`.
- **Touch targets ≥ 44 px, radius 8, elevation only on sheets and dialogs.**
- **Motion.** Animations are CSS only, respect `prefers-reduced-motion`, and reveal-on-scroll
  never hides content when JavaScript or IntersectionObserver is missing.
- **Languages.** i18next uses BCP-47 codes `rw`, `en`, `fr`; the database enum from doc §10.2 is
  `kin`, `en`, `fr` (`LANG_DB_CODE`). English is the source of truth, French is complete, the
  Kinyarwanda file is a draft the clinical champion must review in the translation editor.
- **Demo clock.** Sample screens are frozen at Thursday 15/10/2026 12:45 (`DEMO_NOW`) so that
  queue times, calendars and charts stay coherent. Replace `demoNow()` once real data flows.
- **Breakpoints.** The custom `pc` breakpoint (901 px) is declared in rem like Tailwind's own;
  mixing units makes Tailwind sort variants alphabetically and `sm:` would override `pc:`.
- **Secrets.** `.env` and `apps/web/.env.local` are gitignored. Only the publishable key may
  reach the browser.

## Known deviations from the design boards

- The public site no longer follows the handoff's teal, white-hero layout: it uses the logo
  palette, a gradient hero without the clinic illustration, and an expanded footer (requested
  change, October 2026).
- The design's queue row has fixed columns that overflow the card at 1366 px (the patient name
  collapsed to zero width and the action button was clipped). The code uses container queries:
  insurer chip under the name on narrow cards, separate insurer column on wide ones.
- Bar lists in narrow dashboard cards stack label and value above a full-width bar instead of
  squeezing the bar to a few pixels.
- The nurse bed board counts beds being cleaned as neither free nor occupied.
