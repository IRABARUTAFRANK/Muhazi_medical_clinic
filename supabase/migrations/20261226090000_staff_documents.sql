-- 0116 · Employee document files: the manager keeps, for each employee, their licence, the
-- contract signed, an identity document, certificates, a CV and other crucial papers, in the
-- clinic's private storage; the employee sees their own, nobody else sees anything.
--
-- Frank: "In the manager's portal for employees, make a file for each of them so that we can
-- upload documents: their licence, the contract we signed, and other crucial documents, for
-- privacy and security purposes."
--
--   * A  THE DOCUMENTS (staff_document): one row per file of one employee (profiles): a kind
--        (licence, contract, id, certificate, cv, other), a title, the date it expires (a licence,
--        a contract) when it has one, a note, who added it and when. PDF, photo (JPEG, PNG, WebP)
--        or Word (.doc, .docx), at most 10 MB. The file itself is in the PRIVATE Storage bucket
--        'staff-files' at <profile id>/<document id>.<ext>.
--   * B  WHO: the MANAGER adds, sees, opens and removes the documents of any employee; an
--        EMPLOYEE sees and opens their own, nothing more (they cannot add or remove). Nobody
--        else: a doctor does not see a nurse's papers, reception sees nothing.
--   * C  REVIEWABLE: every time the manager lists or opens the documents of another person, a
--        'read' line goes to the audit log (audit_event, entity staff_document: the employee's id
--        for a list, the document's id for an opening; once per half hour per thing), so the
--        looks can be reviewed. The rows are audited as every other table (trg_audit).
--   * D  REMOVING: the manager, always with a reason; the row stays (deleted_at, deleted_by,
--        delete_reason) and the file is then deleted from Storage by the screen (the bucket's own
--        rule allows that delete only for a removed row, or an upload never registered).
--   * E  EXPIRING (staff_documents_expiring): the licences and contracts of active employees
--        expired or expiring within p_days (60 by default), for the manager's dashboard.
--   * F  STORAGE (where the storage schema exists: Supabase; PGlite has none): the bucket is
--        created private with the size and type limits; its policies on storage.objects ask for
--        an approved session (0081 does not cover Storage) and the rules above. A file of another
--        person is read by the manager only after staff_document_open wrote its audit line (35
--        minutes), so that a link asked of Storage directly is never an unlogged look.
--
-- Errcodes: 42501 not allowed (plain sentences: "only the manager…", "an employee sees their
-- own documents…"), 22023 bad input (hints: file_type, file_too_big, file_path, title_needed,
-- file_kind, reason_needed, already_removed, not_uploaded), P0002 not found (hint: not_found).

-- ---------------------------------------------------------------- A the table
create table if not exists staff_document (
  like mmc_base including all,
  profile_id uuid not null references profiles (id),
  kind text not null check (kind in ('licence', 'contract', 'id', 'certificate', 'cv', 'other')),
  title text not null check (length(trim(title)) between 1 and 200),
  -- the object's name in the bucket staff-files
  path text not null unique,
  mime text not null,
  size integer not null check (size > 0 and size <= 10485760),
  expires_on date,
  note text check (note is null or length(note) <= 1000),
  uploaded_by uuid not null default auth.uid() references profiles (id),
  deleted_by uuid references profiles (id),
  delete_reason text,
  check ((deleted_at is null) = (deleted_by is null)),
  check (deleted_at is null or length(trim(coalesce(delete_reason, ''))) >= 3)
);
create index if not exists staff_document_profile_idx on staff_document (profile_id, created_at desc);
create index if not exists staff_document_expiry_idx on staff_document (expires_on)
  where deleted_at is null and expires_on is not null;
comment on table staff_document is
  'An employee''s documents (licence, contract, identity, certificates, CV…); the file is in the private Storage bucket staff-files (0116).';
alter table staff_document enable row level security;
-- read and written through the functions below only
revoke all on staff_document from anon, authenticated;
select install_common_triggers('staff_document');

-- ---------------------------------------------------------------- helpers
create or replace function staff_file_max_bytes()
returns integer
language sql immutable
as $$ select 10485760 $$;

-- PDF, photos and Word documents.
create or replace function staff_file_mime_ok(p_mime text)
returns boolean
language sql immutable
as $$
  select coalesce(p_mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp',
                             'application/msword',
                             'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false)
$$;

-- The extension a file of this type is stored under.
create or replace function staff_file_ext_ok(p_mime text, p_ext text)
returns boolean
language sql immutable
as $$
  select case p_mime
    when 'application/pdf' then p_ext = 'pdf'
    when 'image/jpeg' then p_ext in ('jpg', 'jpeg')
    when 'image/png' then p_ext = 'png'
    when 'image/webp' then p_ext = 'webp'
    when 'application/msword' then p_ext = 'doc'
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then p_ext = 'docx'
    else false
  end
$$;

-- The employee a Storage path belongs to: '<profile id>/<document id>.<ext>', the profile
-- existing. Null for any other name.
create or replace function staff_file_path_profile(p_name text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  m text[];
  v_id uuid;
begin
  m := regexp_match(coalesce(p_name, ''),
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|webp|doc|docx)$');
  if m is null then
    return null;
  end if;
  select p.id into v_id from profiles p where p.id = m[1]::uuid;
  return v_id;
end
$$;

-- May the signed-in person see this employee's documents? The manager: anyone; else: oneself.
create or replace function may_see_staff_documents(p_profile uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.uid() is not null and p_profile is not null
    and (is_manager() or p_profile = auth.uid()), false)
$$;

-- Is the file still in the bucket? Null where there is no Storage (PGlite).
create or replace function staff_file_object_exists(p_path text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v boolean;
begin
  if to_regclass('storage.objects') is null then
    return null;
  end if;
  execute 'select exists (select 1 from storage.objects where bucket_id = ''staff-files'' and name = $1)'
    into v using p_path;
  return v;
end
$$;

-- The manager looked at another person's documents: one 'read' line in the audit log, once per
-- half hour per thing (the employee's id for a list, the document's id for an opening). One's
-- own documents are not a recorded look.
create or replace function log_staff_document_access(p_entity_id uuid, p_what text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_entity_id is null then
    return;
  end if;
  if exists (select 1 from audit_event a
             where a.actor_id = auth.uid() and a.entity = 'staff_document' and a.action = 'read'
               and a.entity_id = p_entity_id and a.reason = p_what
               and a.at > now() - interval '30 minutes') then
    return;
  end if;
  perform log_access('staff_document', p_entity_id, 'read', p_what);
end
$$;

-- Kigali's today.
create or replace function staff_doc_today()
returns date
language sql stable
as $$ select (now() at time zone 'Africa/Kigali')::date $$;

-- What the screens show of one document.
create or replace function staff_document_json(d staff_document)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', d.id, 'profileId', d.profile_id, 'profileName', p.full_name,
    'kind', d.kind, 'title', d.title, 'note', d.note,
    'mimeType', d.mime, 'sizeBytes', d.size, 'path', d.path,
    'expiresOn', d.expires_on,
    'expired', d.expires_on is not null and d.expires_on < staff_doc_today(),
    'daysLeft', case when d.expires_on is null then null else d.expires_on - staff_doc_today() end,
    'uploadedById', d.uploaded_by, 'uploadedBy', u.full_name, 'uploadedAt', d.created_at,
    'removed', d.deleted_at is not null, 'removedAt', d.deleted_at,
    'removedBy', (select full_name from profiles where id = d.deleted_by), 'removeReason', d.delete_reason,
    -- a removed document whose copy is still in storage (the delete failed): the manager finishes it
    'storageLeft', case when d.deleted_at is not null then staff_file_object_exists(d.path) end,
    'canRemove', d.deleted_at is null and is_manager())
  from profiles p
  left join profiles u on u.id = d.uploaded_by
  where p.id = d.profile_id
$$;

-- ---------------------------------------------------------------- B the list
-- The documents of one employee (oneself when p_profile is null): the manager sees anyone's
-- (and the removed ones, with who and why), an employee their own; anyone else is refused.
create or replace function staff_documents(p_profile uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_profile uuid := coalesce(p_profile, auth.uid());
  v_name text;
  v_docs jsonb;
  v_removed integer;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not may_see_staff_documents(v_profile) then
    raise exception 'not allowed: an employee sees their own documents, the manager everyone''s'
      using errcode = '42501';
  end if;
  select full_name into v_name from profiles where id = v_profile;
  if v_name is null then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_profile <> auth.uid() then
    perform log_staff_document_access(v_profile, 'list');
  end if;
  select coalesce(jsonb_agg(staff_document_json(d) order by d.deleted_at is not null, d.created_at desc)
                    filter (where d.deleted_at is null or is_manager()), '[]'::jsonb),
         count(*) filter (where d.deleted_at is not null)
  into v_docs, v_removed
  from staff_document d
  where d.profile_id = v_profile;
  return jsonb_build_object(
    'profileId', v_profile, 'profileName', v_name,
    'documents', v_docs, 'removed', v_removed,
    'canAdd', is_manager(),
    'maxBytes', staff_file_max_bytes(),
    'types', jsonb_build_array('application/pdf', 'image/jpeg', 'image/png', 'image/webp',
                               'application/msword',
                               'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
end
$$;

-- ---------------------------------------------------------------- C adding one
-- The manager registers a file already sent to Storage at p_path. Checks the rules again (the
-- type, the size, the path of this employee) and, on Supabase, that the file is in the bucket
-- with that size and type.
create or replace function add_staff_document(
  p_profile uuid,
  p_kind text,
  p_title text,
  p_path text,
  p_mime text,
  p_size integer,
  p_expires_on date default null,
  p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ext text := lower(substring(coalesce(p_path, '') from '\.([a-zA-Z]+)$'));
  v_obj_found boolean := false;
  v_obj_size bigint;
  v_obj_mime text;
  v_d staff_document%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_manager() then
    raise exception 'not allowed: only the manager adds an employee''s documents'
      using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_profile) then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if coalesce(p_kind, '') not in ('licence', 'contract', 'id', 'certificate', 'cv', 'other') then
    raise exception 'unknown kind of document' using errcode = '22023', hint = 'file_kind';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 or length(trim(p_title)) > 200 then
    raise exception 'give the document a title' using errcode = '22023', hint = 'title_needed';
  end if;
  if not staff_file_mime_ok(p_mime) then
    raise exception 'only PDF, photos (JPEG, PNG, WebP) and Word documents'
      using errcode = '22023', hint = 'file_type';
  end if;
  if p_size is null or p_size <= 0 or p_size > staff_file_max_bytes() then
    raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
  end if;
  if staff_file_path_profile(p_path) is distinct from p_profile or not staff_file_ext_ok(p_mime, v_ext) then
    raise exception 'the file is not stored where this employee''s documents go'
      using errcode = '22023', hint = 'file_path';
  end if;
  -- On Supabase: the file must be in the bucket, with the size and type said.
  if to_regclass('storage.objects') is not null then
    execute 'select true, (metadata ->> ''size'')::bigint, metadata ->> ''mimetype''
             from storage.objects where bucket_id = ''staff-files'' and name = $1'
      into v_obj_found, v_obj_size, v_obj_mime using p_path;
    if not coalesce(v_obj_found, false) then
      raise exception 'the file did not arrive: send it again' using errcode = '22023', hint = 'not_uploaded';
    end if;
    if v_obj_size is not null and v_obj_size > staff_file_max_bytes() then
      raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
    end if;
    if v_obj_mime is not null and not staff_file_mime_ok(v_obj_mime) then
      raise exception 'only PDF, photos (JPEG, PNG, WebP) and Word documents'
        using errcode = '22023', hint = 'file_type';
    end if;
  end if;
  insert into staff_document (profile_id, kind, title, path, mime, size, expires_on, note, uploaded_by)
  values (p_profile, p_kind, trim(p_title), p_path, p_mime, coalesce(v_obj_size::integer, p_size),
          p_expires_on, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning * into v_d;
  return staff_document_json(v_d);
end
$$;

-- ---------------------------------------------------------------- D opening one
-- Checks the person may see the document, logs the manager's opening of another person's, and
-- gives its path; the screen then asks Storage for a link valid 5 minutes (createSignedUrl),
-- which the bucket's own policy checks again.
create or replace function staff_document_open(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_d staff_document%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_d from staff_document where id = p_id;
  if not found or not may_see_staff_documents(v_d.profile_id) then
    raise exception 'document not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_d.deleted_at is not null then
    raise exception 'this document was removed' using errcode = '22023', hint = 'already_removed';
  end if;
  if v_d.profile_id <> auth.uid() then
    perform log_staff_document_access(v_d.id, 'open');
  end if;
  return jsonb_build_object('id', v_d.id, 'bucket', 'staff-files', 'path', v_d.path,
                            'mimeType', v_d.mime, 'title', v_d.title, 'expiresIn', 300);
end
$$;

-- ---------------------------------------------------------------- E removing one
-- The manager, always with a reason. The row stays (removed); the screen then deletes the file
-- from Storage (policy below).
create or replace function remove_staff_document(p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_d staff_document%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_manager() then
    raise exception 'not allowed: only the manager removes an employee''s documents'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the document is removed' using errcode = '22023', hint = 'reason_needed';
  end if;
  select * into v_d from staff_document where id = p_id for update;
  if not found then
    raise exception 'document not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_d.deleted_at is not null then
    raise exception 'this document was already removed' using errcode = '22023', hint = 'already_removed';
  end if;
  update staff_document
  set deleted_at = now(), deleted_by = auth.uid(), delete_reason = trim(p_reason)
  where id = v_d.id
  returning * into v_d;
  return jsonb_build_object('id', v_d.id, 'bucket', 'staff-files', 'path', v_d.path,
                            'removedAt', v_d.deleted_at);
end
$$;

-- ---------------------------------------------------------------- F expiring
-- The manager's dashboard: the licences and contracts of active employees that have expired or
-- expire within p_days (60 by default), soonest first.
create or replace function staff_documents_expiring(p_days integer default 60)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not is_manager() then
    raise exception 'not allowed: only the manager sees the documents expiring'
      using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'profileId', d.profile_id, 'profileName', p.full_name, 'role', p.role,
             'kind', d.kind, 'title', d.title, 'expiresOn', d.expires_on,
             'daysLeft', d.expires_on - staff_doc_today(),
             'expired', d.expires_on < staff_doc_today())
           order by d.expires_on, p.full_name)
    from staff_document d
    join profiles p on p.id = d.profile_id and p.active
    where d.deleted_at is null
      and d.kind in ('licence', 'contract')
      and d.expires_on is not null
      and d.expires_on <= staff_doc_today() + greatest(coalesce(p_days, 60), 0)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- G the Storage rules
-- Used by the policies on storage.objects for the bucket (and checked by db:check directly).
-- Send a file: an approved session, the manager, a path of an employee, not a registered file.
create or replace function staff_file_object_insert_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok() and is_manager()
    and staff_file_path_profile(p_name) is not null
    and not exists (select 1 from staff_document d where d.path = p_name), false)
$$;

-- Delete a file from Storage: the manager, a removed document (the screen deletes it at once; a
-- failed delete is finished later) or an upload never registered (cleaned up when registering
-- failed).
create or replace function staff_file_object_delete_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok() and is_manager()
    and case
      when exists (select 1 from staff_document d where d.path = p_name) then
        exists (select 1 from staff_document d where d.path = p_name and d.deleted_at is not null)
      else staff_file_object_insert_ok(p_name)
    end, false)
$$;

-- Read a file (the 5-minute link): a registered document, not removed, one's own at once; another
-- person's by the manager only after staff_document_open wrote its 'open' line in the audit log
-- (35 minutes: longer than the half hour in which the line is not written again), so that a link
-- asked of Storage directly is never an unlogged look; the manager's own upload not registered
-- yet (Storage reads back what it has just written); a removed document, by who may delete it.
create or replace function staff_file_object_read_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok()
    and case
      when exists (select 1 from staff_document d where d.path = p_name) then
        exists (select 1 from staff_document d
                where d.path = p_name and d.deleted_at is null
                  and may_see_staff_documents(d.profile_id)
                  and (d.profile_id = auth.uid()
                       or exists (select 1 from audit_event a
                                  where a.actor_id = auth.uid() and a.entity = 'staff_document'
                                    and a.action = 'read' and a.entity_id = d.id and a.reason = 'open'
                                    and a.at > now() - interval '35 minutes')))
        -- Postgres deletes only the rows it may read: the manager deleting a removed document
        or staff_file_object_delete_ok(p_name)
      else staff_file_object_insert_ok(p_name)
    end, false)
$$;

-- The bucket and its policies, where Storage exists (Supabase). Nothing to do by hand.
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'no storage schema here: the bucket staff-files is not created';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('staff-files', 'staff-files', false, 10485760,
          array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists staff_files_insert on storage.objects';
  execute 'drop policy if exists staff_files_select on storage.objects';
  execute 'drop policy if exists staff_files_delete on storage.objects';
  execute $p$create policy staff_files_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'staff-files' and public.staff_file_object_insert_ok(name))$p$;
  execute $p$create policy staff_files_select on storage.objects for select to authenticated
    using (bucket_id = 'staff-files' and public.staff_file_object_read_ok(name))$p$;
  execute $p$create policy staff_files_delete on storage.objects for delete to authenticated
    using (bucket_id = 'staff-files' and public.staff_file_object_delete_ok(name))$p$;
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function staff_file_max_bytes(), staff_file_mime_ok(text), staff_file_ext_ok(text, text),
  staff_file_path_profile(text), may_see_staff_documents(uuid), staff_file_object_exists(text),
  log_staff_document_access(uuid, text), staff_doc_today(), staff_document_json(staff_document)
  from public, anon, authenticated;
revoke all on function staff_documents(uuid),
  add_staff_document(uuid, text, text, text, text, integer, date, text),
  staff_document_open(uuid), remove_staff_document(uuid, text), staff_documents_expiring(integer),
  staff_file_object_insert_ok(text), staff_file_object_read_ok(text), staff_file_object_delete_ok(text)
  from public, anon;
grant execute on function staff_documents(uuid),
  add_staff_document(uuid, text, text, text, text, integer, date, text),
  staff_document_open(uuid), remove_staff_document(uuid, text), staff_documents_expiring(integer),
  staff_file_object_insert_ok(text), staff_file_object_read_ok(text), staff_file_object_delete_ok(text)
  to authenticated;
