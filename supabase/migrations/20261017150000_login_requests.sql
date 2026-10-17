-- Muhazi Medical Clinic System — 0012 PIN-gated sign-in codes
-- The `staff-otp` Edge Function verifies the PIN on the server and records a login request;
-- the `send-auth-email` hook only e-mails a code when a fresh, unconsumed request exists for
-- that user. Service role only: no policies, so neither anon nor authenticated can read it.

create table login_request (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  email text not null,
  requested_at timestamptz not null default now(),
  consumed_at timestamptz,
  client text
);
create index login_request_user_idx on login_request (user_id, requested_at desc);
comment on table login_request is 'PIN verified → code may be sent. Written and read by Edge Functions with the service role only.';

alter table login_request enable row level security;
revoke all on login_request from anon, authenticated;
