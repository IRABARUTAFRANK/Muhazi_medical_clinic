-- 0084 · Sign-in trace reports, and the two sign-in functions missing on the live database.
--
-- Some staff are sent back to the PIN step a few seconds after the e-mailed code was accepted,
-- while the database shows a healthy sign-in (approved, browser key made, never ended). The web
-- app now keeps a short trace of the sign-in in the browser and, when a tab loses its signed-in
-- person without the person choosing it, sends that trace here:
--   * client_event: one row per report (when, who if known, what kind, the trace, the browser).
--     Read by the manager only; nobody writes it directly.
--   * report_client_event(p_kind, p_detail): callable by visitors (anon) too, since the sign-in
--     may already be gone when the report is sent. It refuses a detail over 8 KB and stops taking
--     reports once 300 arrived in the last hour (abuse cap). It never answers anything back.
--   * check_request() (the 0081 gate) lets report_client_event through for a session that is not
--     (or no longer) approved; everything else in the gate is unchanged.
--
-- REPAIR: the live database ran an early draft of 0079 (20261120090000_session_hours.sql), so
-- extend_this_device(text) and signed_in_with_code() are missing there. They are created again
-- here exactly as committed in 0079 (no later migration redefines them), with the same grants.
-- Safe on a database that already has them (create or replace).

-- ---------------------------------------------------------------- 0079 repair
create or replace function signed_in_with_code()
returns boolean
language sql stable set search_path = public
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end
    ) a
    where a ->> 'method' in ('otp', 'magiclink', 'email/signup', 'invite', 'recovery')
  )
$$;

create or replace function extend_this_device(p_token text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_end timestamptz;
begin
  if auth.uid() is null then
    return null;
  end if;
  update trusted_device
     set expires_at = now() + make_interval(hours => session_hours()), last_used_at = now()
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and user_id = auth.uid() and revoked_at is null and expires_at > now()
  returning expires_at into v_end;
  return v_end;
end
$$;

grant execute on function signed_in_with_code(), extend_this_device(text) to authenticated;
revoke execute on function signed_in_with_code(), extend_this_device(text) from anon, public;

-- ---------------------------------------------------------------- reports from the browser
create table if not exists client_event (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  -- the signed-in person when the request still carried a valid sign-in, else null
  user_id uuid,
  -- the username the tab held (said by the browser, not checked)
  username text,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  user_agent text
);
create index if not exists client_event_at_idx on client_event (at desc);
alter table client_event enable row level security;
revoke all on client_event from anon, authenticated;
grant select on client_event to authenticated;
drop policy if exists client_event_manager_reads on client_event;
create policy client_event_manager_reads on client_event
  for select to authenticated using (is_manager());

create or replace function report_client_event(p_kind text, p_detail jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_agent text;
begin
  if coalesce(p_kind, '') !~ '^[a-z0-9_.-]{1,40}$' then
    raise exception 'unknown kind' using errcode = '22023';
  end if;
  if octet_length(v_detail::text) > 8192 then
    raise exception 'detail too large (8 KB at most)' using errcode = '22023';
  end if;
  if (select count(*) from client_event where at > now() - interval '1 hour') >= 300 then
    raise exception 'too many reports, try later' using errcode = '54000';
  end if;
  begin
    v_agent := left(current_setting('request.headers', true)::jsonb ->> 'user-agent', 300);
  exception when others then
    v_agent := null; -- no request headers (SQL editor, tests)
  end;
  insert into client_event (user_id, username, kind, detail, user_agent)
  values (
    auth.uid(),
    left(nullif(trim(case when jsonb_typeof(v_detail -> 'username') = 'string'
                          then v_detail ->> 'username' end), ''), 60),
    p_kind,
    v_detail,
    v_agent
  );
  -- housekeeping: reports are kept 90 days
  delete from client_event where at < now() - interval '90 days';
end
$$;

revoke all on function report_client_event(text, jsonb) from public;
grant execute on function report_client_event(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------- the gate (0081) + report_client_event
-- Copied from 20261122090000_session_approval.sql; the only change is report_client_event in
-- the list of calls allowed before the approval or after the end.
create or replace function check_request()
returns void
language plpgsql stable set search_path = public
as $$
declare
  v_reason text;
begin
  if current_user is distinct from 'authenticated' then
    return; -- anon (visitors, public forms) and service_role (Edge Functions) are not touched
  end if;
  if not enforce_code_on() then
    return; -- kill switch
  end if;
  -- The only calls the app makes before the approval or after the end: sign-in (record_sign_in,
  -- use_trusted_device), the first PIN (my_must_change_pin, mark_pin_changed), activity and
  -- sign-out (touch_session, end_session, revoke_this_device, session_status), and the sign-in
  -- trace sent when a tab lost its sign-in (report_client_event). Each of them checks for itself
  -- what it may do; none of them reads or changes clinic data.
  if coalesce(current_setting('request.path', true), '') ~
     '^(/rest/v1)?/rpc/(record_sign_in|use_trusted_device|my_must_change_pin|mark_pin_changed|touch_session|end_session|revoke_this_device|session_status|report_client_event)/?$'
  then
    return;
  end if;
  v_reason := session_reason();
  if v_reason = 'ok' then
    return;
  end if;
  if v_reason = 'idle' then
    raise exception 'signed out after % hours without activity', session_hours()
      using errcode = 'PT401', hint = 'idle';
  end if;
  if v_reason = 'ended' then
    raise exception 'signed out: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = 'ended';
  end if;
  raise exception 'sign-in not approved: sign in again with the e-mailed code'
    using errcode = 'PT401', hint = 'code_required';
end
$$;

grant execute on function check_request() to anon, authenticated, service_role;
