# Muhazi Medical Clinic System — design handoff

This folder is the design source for the clinic web app. Put it in your repo at `design/`
(or anywhere) and point Claude Code at it. Everything a developer needs is here as plain
HTML/CSS/JS, so Claude Code can read the exact layout, copy, colours and sample data.

## What is in here

| Path | What it is |
|---|---|
| `tokens.css` | Design tokens (colours light + dim, type scale, spacing, radius, touch size). Use as-is. |
| `assets/logo.jpg` | Clinic logo. Screens reference it as `/_blob/95ac…` — replace with `assets/logo.jpg`. |
| `screens/*.dc.html` | One file per screen. Markup inside `<x-dc>` is ordinary HTML; the `<script type="text/x-dc">` block holds the sample data and interaction logic (`renderVals()` returns what the template shows). `<sc-for>` = loop, `<sc-if>` = conditional, `{{x}}` = value. |
| `screens/canvas.json` | Which screen is which, frame sizes, and the order. |

## Screens → routes (suggested)

| Screen file | Route | Who sees it | Notes |
|---|---|---|---|
| `Landing.dc.html` | `/` | Public | Front door: hero, find-a-doctor preview, services, booking steps + form, insurance, hours/location, staff sign-in card. Fluid page. |
| `Booking.dc.html` | `/book` | Public | Category chips → doctor list → 7-day calendar (free / booked / off) → request panel → confirmation. Laboratory = walk-in notice. |
| `Main.dc.html` | `/app` (home) | Staff | Role-aware home: top bar, left rail (≤5 items per role), Clinic-now strip, My queue, Today, Quick actions. Props: `role` receptionist/nurse/doctor/cashier, `mode` normal/offline/empty, `theme` light/dim. |
| `HomeNurse/Doctor/Cashier/Offline/Empty.dc.html` | — | — | Thin wrappers of `Main.dc.html` with different props; nothing new to implement. |
| `HomeTablet.dc.html` (+ `Tablet*.dc.html` wrappers) | `/app` at ≤ 900 px | Staff | Same content stacked: queue first, cards, sticky quick-action row, bottom tab bar + "More" sheet. |
| `Dashboard.dc.html` (+ `Dashboard*.dc.html` wrappers) | `/app/dashboard` | Manager; heads of station with `role=head` (money rows hidden) | Five rows: today's numbers, money, operations, clinical & stock, compliance & system. Date range, role filter, Export PDF/Excel. |
| `DesignSystem.dc.html` | — | — | Component sheet: colours, type, spacing, top bar, nav, tile, queue row, sync badges. |

Prototype flow: Landing → "Sign in" → Home → user menu / Reports → Dashboard → "Sign out" → Landing.

## Rules the design follows (keep them in code)

- Colour is never the only signal: triage, result flags and sync states always carry a dot, icon or word.
- Money: `RWF 18,300` (thousands separators, tabular numbers). Dates `dd/mm/yyyy`, 24-hour time.
- Every button/tap target ≥ 44 px; radius 8; elevation only on sheets and dialogs.
- Labels keep ~30 % spare width so Kinyarwanda / French fit; the top bar has a KIN / EN / FR switch.
- Top bar on every staff screen: logo + name, global patient search, sync badge (Synced / Syncing… / Offline since hh:mm · n pending), current user with one-tap switch, language switch.
- Offline: badge turns orange and a yellow banner reads "Working offline — changes will sync automatically".
- Charts: one measure per chart, values written on the chart, no 3-D, no pies, legends only with ≥ 2 series, same colour for the same subject (money teal, visits green, time slate).

## Sample data

All names, amounts, diagnoses and availability are realistic samples for a ~60-patient/day clinic in Kayonza. Contact details on the landing page are placeholders in square brackets — fill them in.

## Suggested first prompt for Claude Code

```
Read design/README.md, design/tokens.css and the screens in design/screens/.
Set up a Next.js (or React + Vite) app with Tailwind. Map the tokens in tokens.css to the
Tailwind theme. Implement the public landing page (Landing.dc.html) and the booking page
(Booking.dc.html) first as real routes, matching the design exactly, with the sample data
moved into typed mock files. Then implement the staff home (Main.dc.html) with the role,
mode and theme variants, and the dashboard (Dashboard.dc.html). Keep the 44 px touch
targets, the semantic colour pairing rules and the RWF / dd/mm/yyyy formats from the README.
```
