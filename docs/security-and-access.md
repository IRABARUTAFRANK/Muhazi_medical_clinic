# Security, accounts and sign-in

How employees get into the Muhazi Medical Clinic System, what each of them can reach, and how
the clinic manager controls it. Source: project document §1.4 (roles), §2.3 (file protection),
§5.11 (users, roles, devices), §5.12 (security, audit, Law 058/2021), §14 (auto-lock, privacy).

## 1. Who does what

| Actor              | Can                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clinic manager** | Create employee accounts, choose role / station / dashboard rights, hand over the first PIN, reset a PIN, deactivate or reactivate an employee, read the audit log. Cannot deactivate themself; the clinic always keeps at least one active manager. |
| **Employee**       | Sign in with username + PIN on any clinic device, must replace the handed-over PIN at first sign-in, can change it later, is locked after 5 minutes without activity and unlocks with the PIN.                                                       |
| **Public visitor** | Nothing that needs an account: reads practitioners, prices, insurers, hours; sends an appointment inquiry.                                                                                                                                           |

There is no self-registration anywhere. Accounts exist only because the manager created them.

## 2. Where the pieces live

```mermaid
flowchart LR
  M[Manager in the app] -->|session token| EF[Edge Function manage-staff<br/>service role]
  EF --> AUTH[(Supabase Auth<br/>users, passwords, bans)]
  AUTH -->|trigger handle_new_user| P[(profiles<br/>role, station, active, must_change_pin)]
  E[Employee in the app] -->|username+PIN → email+password| AUTH
  E -->|record_sign_in()| P
  P --> RLS{{Row-level security<br/>has_perm(role, key)}}
  RLS --> T[(clinic tables)]
  P --> A[(audit_event)]
```

- **Supabase Auth** stores credentials and sessions. A username becomes the email
  `username@staff.muhaziclinic.rw`; the PIN is the password (six digits, Supabase minimum 6).
- **`profiles`** (one row per employee, same id as the Auth user) carries the role, station,
  dashboard rights, `active`, `must_change_pin`, `last_sign_in_at`. It is created automatically
  by the `handle_new_user` trigger from the metadata the manager entered.
- **`role_permissions`** maps each role to permission keys; **row-level security** on every table
  calls `has_perm()` with the caller's role (see [database-design.md](database-design.md) §6).
- **`audit_event`** receives every write, every sign-in (`login`), every account change
  (`settings`) and break-glass reads.
- **Edge Function `manage-staff`** is the only code that holds the service role. It checks that
  the caller's session belongs to an active manager, validates input, then creates the Auth user,
  sets a password or bans / unbans the user. It never returns secrets.

## 3. Flows

### Manager creates an employee

1. Employees page → New employee: full name, username (suggested `j.uwimana`), **e-mail
   address** (where the sign-in code goes), role, station, dashboard access (none / head of
   station / manager), language, phone; a six-digit PIN is generated (CSPRNG) or typed.
2. The app calls `manage-staff` with `{action:"create"}` and the manager's session token.
3. The function refuses unless the caller is an active manager, validates
   (`^[a-z0-9._-]{3,32}$`, `^[0-9]{6}$`, e-mail syntax, e-mail not already used, known role),
   creates the Auth user with that e-mail, `email_confirm: true` and metadata, and writes an
   audit event.
4. The trigger creates the profile with `must_change_pin = true` and assigns the **staff ID**
   (`MMC-S-0001`, sequential, migration 0011).
5. The app shows the staff ID, username, PIN and e-mail **once**; the manager hands them over in
   person. The e-mail can be changed later with "Set e-mail" (`{action:"set_email"}`, which
   updates the Auth user and the profile).

### Employee signs in (three steps)

1. **Landing page → staff ID.** `public_staff_check(staff_id)` (anonymous, security definer)
   answers only true/false for an active ID. Unknown ID → "This staff ID is not known". A
   known ID opens `/login?staff=MMC-S-0001`.
2. **Login page → username + PIN.** `staff_login_email(staff_id, username)` returns the Auth
   e-mail only if both match an active profile; then `supabase.auth.signInWithPassword(email,
pin)`. Wrong PIN → "Wrong username or PIN". Banned (deactivated) user → "This account has
   been deactivated". On success the app immediately requests `signInWithOtp(email,
shouldCreateUser:false)`: Supabase Auth e-mails a six-digit code. The app still holds **no
   user** at this point.
3. **Code.** `verifyOtp(email, token, type:"email")` exchanges the code for the session that the
   app actually uses; then `record_sign_in(device)` stamps `last_sign_in_at`, writes the `login`
   audit event and raises if `active = false` (the app signs the user out again).
4. If `must_change_pin` the app goes to **Change PIN** and nothing else in `/app` is reachable
   until the PIN is replaced (`auth.updateUser` after re-verifying the current PIN, then
   `mark_pin_changed()`).
5. Otherwise the employee lands on their role's home (managers on the dashboard).

**PIN gating on the server.** Step 2 goes through the `staff-otp` Edge Function (public
endpoint, 5 requests per account per 10 minutes): it resolves the e-mail, verifies the PIN with
Supabase Auth, inserts a `login_request` row and only then calls `signInWithOtp`. The
`send-auth-email` function is registered as the Auth **Send Email hook**: Supabase no longer
sends mail itself; the hook sends the code (Resend or Brevo API) only when an unconsumed
`login_request` for that user exists from the last three minutes, and logs an audit event
otherwise. So a code cannot be obtained without the PIN, even by calling `signInWithOtp`
directly. If the function is not deployed, the app falls back to the client-side flow (PIN
check in the browser, code sent by Supabase's mailer, template must contain `{{ .Token }}`).
The final session always comes from the code exchange. "Send a new code" repeats the same
PIN-gated request and is limited to one per 30 s in the app.

### Patient journey (MoH workflow)

- **Registration from any station.** `register_patient()` (new file + visit) and
  `start_visit()` (returning patient) need `patient.write` / `queue.write`: receptionist,
  nurse, doctor, lab technician, sonographer, pharmacist and manager all have them.
- **Triage first.** A normal visit is queued at `triage`; the nurse records vitals with
  `record_vitals()` (observations, triage colour, reason), which closes the triage entry and
  queues the patient at the chosen station with priority red = 1, yellow = 2, green = 3.
- **Emergency.** `register_patient(... p_emergency := true, p_station := …)` or
  `start_visit(patient, true, station)` skips triage: the visit opens at the treating station
  with `triage_level = 'red'`, queue priority 1 and a reason recorded on the encounter.
- Station screens read the `queue_board` view (security invoker, so RLS applies).

### Idle lock

No pointer, key, touch or wheel event for 5 minutes → the screen locks (session kept). Unlock
re-verifies the PIN with Supabase Auth. "Not you? Sign out" ends the session for the next person.

### Reset, deactivate, reactivate

- **Reset PIN**: manager generates a new PIN; `manage-staff` sets the password and flags
  `must_change_pin`; the new PIN is shown once.
- **Deactivate**: `manage-staff` bans the Auth user (no new sign-in, no token refresh) and sets
  `profiles.active = false`, so even a still-valid access token is refused by `record_sign_in()`
  and by every policy that checks `profiles.active`. Reactivate reverses both.
- **Role or station change**: `update_profile()` / `manage-staff update`; the next request uses
  the new permissions, no new sign-in needed.

## 4. Controls checklist

| Control                                | Where                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No public sign-up                      | Supabase Auth → "Allow new users to sign up" **off**; accounts only through `manage-staff`              |
| Email confirmation off, min password 6 | Supabase Auth → Email provider settings                                                                 |
| Brute-force protection                 | Supabase Auth rate limits on password sign-in; audit of every login; manager sees last sign-in          |
| Secrets never in the browser           | Publishable key only in `apps/web`; service role only inside the Edge Function; `.env` files gitignored |
| Least privilege per role               | `role_permissions` + RLS; `anon` reads two views, four public views/functions, one write function       |
| Sensitive data                         | `hiv_test` behind `sensitive.*` (nurse, doctor only); managers cannot read it                           |
| Immutability                           | Posted invoices, verified reports, submitted batches refuse updates                                     |
| Audit                                  | `audit_event` append-only, partitioned by month; `log_access()` for reads and break-glass               |
| Device lock                            | 5-minute idle lock with PIN; screens face away from the waiting room (physical)                         |
| Leavers                                | Deactivate = Auth ban + profile inactive; devices revocable in `device`                                 |
| Data location                          | Supabase region outside Rwanda: record the NCSA authorisation in `setting.compliance`                   |

## 5. Setting it up (one time)

1. Apply the migrations (`supabase/all.sql` or `pnpm db:apply --seed`).
2. Put a personal access token (dashboard → Account → Access Tokens) in the root `.env` as
   `SUPABASE_ACCESS_TOKEN`, plus a mail provider key (`RESEND_API_KEY` or `BREVO_API_KEY`,
   `MAIL_FROM`) and, optionally, `SMTP_*` values (see `.env.example`).
3. `pnpm sb:deploy` deploys `manage-staff`, `staff-otp` and `send-auth-email`.
4. `pnpm sb:configure` applies the Auth settings through the Management API: sign-ups off,
   e-mail confirmation off, minimum password length 6, site URL, Magic Link template with
   `{{ .Token }}`, code length 6 and expiry 600 s, custom SMTP when given, and (with a mail
   provider key) the Send Email hook plus the function secrets. Without a provider key the
   codes go through Supabase's built-in sender, which allows only a few e-mails per hour, and
   on the free plan the template cannot be changed: the e-mail then carries a **link**, which
   the app also accepts (opening it completes the sign-in on that device). A `RESEND_API_KEY`
   alone is enough: the script derives Resend's SMTP from it and enables the hook.
5. `pnpm sb:set-email t.mugabo <address>` gives the first manager a real address; the manager
   then sets the others from the Employees page.
6. Create the first manager with `pnpm db:seed-staff` (it creates the sample staff including
   `t.mugabo`, PIN printed), sign in as that manager, change the PIN, then create the real
   employees from the Employees page and delete or deactivate the samples.
