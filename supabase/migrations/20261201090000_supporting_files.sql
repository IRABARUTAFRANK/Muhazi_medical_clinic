-- 0089 · Supporting files on the patient file: photos, scans and PDFs (ultrasound images,
-- laboratory printouts, referral letters…), kept private and shown by the privacy levels (0088).
--
-- Frank: "the sonographer must be able to upload any supporting file in the patient file ... and
-- this must be an option in the patient file so that someone who treats or works on the patient
-- may see where he may upload some files".
--
--   * A  THE FILES (patient_file_doc): one row per file, attached to a visit (and to a test of the
--        visit when it is the laboratory or ultrasound's): a type (ultrasound image, laboratory
--        printout, scan, referral letter, photo, other), a title, who added it and when. JPEG, PNG,
--        WebP or PDF, at most 10 MB. The file itself is in the PRIVATE Storage bucket
--        'patient-files' at <patient id>/<visit id>/<file id>.<jpg|png|webp|pdf>.
--   * B  WHO ADDS ONE (may_attach_file): while the visit is open, anyone working on it who writes
--        in the record (clinical.write or orders.write, and visit_view = 'visit': holding the
--        patient, a task or help call, took part, the patient waits at their desk, the manager…),
--        and the laboratory / ultrasound desk on the tests of the visit at their desk. The file is
--        sent to Storage first, then registered (attach_file), which checks the object is there.
--        A test's requester is told when the laboratory or ultrasound adds a file to the test.
--   * C  WHO SEES ONE: the privacy levels of 0088: a file of the open visit is level 3 (the people
--        working on it), a file of a past visit is level 4 (the manager, the heads in charge, the
--        clinician who treated that visit, an approved request or emergency access). The lists
--        (list_patient_files, list_visit_files) give the files one may see and how many are
--        private. The person who added a file also sees it for 24 hours (to check or remove it
--        after the visit closed). file_open checks again, logs the opening of a past visit's file
--        (what = 'attachment'; the log now keeps one line per what was opened) and gives the
--        path; the screen then asks Storage for a link valid 5 minutes, which Storage gives only
--        when its own policy (below) agrees: for a past visit's file, only after that log line.
--   * D  REMOVING ONE (remove_file): the person who added it within 24 hours, or the manager,
--        always with a reason. The row stays (removed_at, by, reason) with an audit line; the
--        file in Storage may then be deleted by that person in the next 15 minutes (the screen
--        does it at once) or by the manager at any time ("storageLeft" says a copy is still there).
--   * E  STORAGE (only where the storage schema exists: Supabase; PGlite has none): the bucket is
--        created private with the size and type limits; its policies on storage.objects ask for
--        an approved session (0081 does not cover Storage) and the rules above: add to a visit one
--        may attach to, read a registered file one may see (or one's upload not registered yet, or
--        a removed file by the person deleting it), delete a removed file (by who removed it, 15
--        minutes, or the manager) or an upload never registered. No update: a file is never
--        replaced, a new one is added.
--
-- Errcodes: 42501 not allowed (hints: not_on_visit, remove_too_late, not_uploader, private),
-- 22023 bad input (hints: file_type, file_too_big, file_path, title_needed, file_kind,
-- reason_needed, file_visit_closed, already_removed, not_uploaded, wrong_test), P0002 not found
-- (hint: not_found).

-- ---------------------------------------------------------------- A the table
create table if not exists patient_file_doc (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patient (id),
  encounter_id uuid not null references encounter (id),
  -- the test it belongs to (an ultrasound image, a laboratory printout)
  service_request_id uuid references service_request (id),
  kind text not null check (kind in ('ultrasound', 'lab', 'scan', 'referral', 'photo', 'other')),
  title text not null check (length(trim(title)) between 1 and 200),
  note text check (note is null or length(note) <= 1000),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid not null default auth.uid() references profiles (id),
  uploaded_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references profiles (id),
  remove_reason text,
  check ((removed_at is null) = (removed_by is null)),
  check (removed_at is null or length(trim(coalesce(remove_reason, ''))) >= 3)
);
create index if not exists patient_file_doc_patient_idx on patient_file_doc (patient_id, uploaded_at desc);
create index if not exists patient_file_doc_encounter_idx on patient_file_doc (encounter_id);
create index if not exists patient_file_doc_request_idx on patient_file_doc (service_request_id)
  where service_request_id is not null;
comment on table patient_file_doc is
  'Supporting files (photos, scans, PDFs) of a patient''s visit; the file is in the private Storage bucket patient-files (0089).';
alter table patient_file_doc enable row level security;
-- read and written through the functions below only
revoke all on patient_file_doc from anon, authenticated;

-- The access log (0088) also says when a past visit's file was opened.
alter table record_access_entry drop constraint if exists record_access_entry_what_check;
alter table record_access_entry add constraint record_access_entry_what_check
  check (what in ('file', 'visit', 'results', 'journey', 'emergency', 'attachment'));

-- One line in the access log (0088), now once per half hour per person, patient, visit, way AND
-- what was opened: opening a past visit and then one of its files gives two lines ('visit',
-- 'attachment'); before, the file's line was swallowed by the visit's. The Storage rule below
-- relies on a fresh 'attachment' line.
create or replace function log_record_access(p_patient_id uuid, p_encounter_id uuid, p_via text, p_what text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req uuid;
begin
  if auth.uid() is null or p_via is null or p_patient_id is null then
    return;
  end if;
  if exists (select 1 from record_access_entry a
             where a.actor_id = auth.uid() and a.patient_id = p_patient_id
               and a.encounter_id is not distinct from p_encounter_id and a.via = p_via
               and a.what = p_what
               and a.at > now() - interval '30 minutes') then
    return;
  end if;
  if p_via in ('request', 'emergency') then
    select a.id into v_req from access_in_force(p_patient_id) a;
  end if;
  insert into record_access_entry (actor_id, patient_id, encounter_id, via, what, request_id)
  values (auth.uid(), p_patient_id, p_encounter_id, p_via, p_what, v_req);
end
$$;

-- ---------------------------------------------------------------- helpers
-- The limits, in one place (the screens read them from the lists).
create or replace function file_max_bytes()
returns integer
language sql immutable
as $$ select 10485760 $$;

create or replace function file_mime_ok(p_mime text)
returns boolean
language sql immutable
as $$ select coalesce(p_mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'), false) $$;

-- The extension a file of this type is stored under.
create or replace function file_ext_ok(p_mime text, p_ext text)
returns boolean
language sql immutable
as $$
  select case p_mime
    when 'image/jpeg' then p_ext in ('jpg', 'jpeg')
    when 'image/png' then p_ext = 'png'
    when 'image/webp' then p_ext = 'webp'
    when 'application/pdf' then p_ext = 'pdf'
    else false
  end
$$;

-- An approved session (0081), or the code switched off: Storage is not behind check_request.
create or replace function storage_session_ok()
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and (session_ok() or not enforce_code_on())
$$;

-- The visit a Storage path belongs to: '<patient id>/<visit id>/<file id>.<ext>', the visit being
-- the patient's. Null for any other name.
create or replace function file_path_encounter(p_name text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  m text[];
  v_enc uuid;
begin
  m := regexp_match(coalesce(p_name, ''),
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|pdf)$');
  if m is null then
    return null;
  end if;
  select e.id into v_enc from encounter e
  where e.id = m[2]::uuid and e.patient_id = m[1]::uuid and e.deleted_at is null;
  return v_enc;
end
$$;

-- May the signed-in person add a file to this visit (to this test of it, when given)?
-- The visit is open, and: they work on it and write in the record (clinical.write or
-- orders.write, visit_view = 'visit'), or a test of the visit is at their laboratory /
-- ultrasound desk (orders.write).
create or replace function may_attach_file(p_encounter_id uuid, p_service_request_id uuid default null)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.uid() is not null
    and exists (select 1 from encounter e
                where e.id = p_encounter_id and e.status = 'open' and e.deleted_at is null)
    and (p_service_request_id is null
         or exists (select 1 from service_request r
                    where r.id = p_service_request_id and r.encounter_id = p_encounter_id
                      and r.deleted_at is null and r.status <> 'cancelled'))
    and (
      ((has_perm('clinical.write') or has_perm('orders.write')) and clinical_reader()
       and may_work_on(p_encounter_id))
      or (has_perm('orders.write')
          and exists (select 1 from service_request r
                      where r.encounter_id = p_encounter_id and r.deleted_at is null
                        and r.status <> 'cancelled'
                        and (p_service_request_id is null or r.id = p_service_request_id)
                        and may_use_desk(request_desk(r.station, r.category))))
    ), false)
$$;

-- How the signed-in person sees one file, or null (private): the privacy level of its visit
-- (0088); and the person who added it, for 24 hours, whatever the visit (a laboratory printout
-- stays theirs to check and remove after the visit closes).
create or replace function file_view(d patient_file_doc)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    case when clinical_reader() or is_manager() then visit_view(d.encounter_id) end,
    case when d.removed_at is null and d.uploaded_by = auth.uid()
              and d.uploaded_at > now() - interval '24 hours' then 'own' end)
$$;

-- Is the file still in the bucket? Null where there is no Storage (PGlite).
create or replace function file_object_exists(p_path text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v boolean;
begin
  if to_regclass('storage.objects') is null then
    return null;
  end if;
  execute 'select exists (select 1 from storage.objects where bucket_id = ''patient-files'' and name = $1)'
    into v using p_path;
  return v;
end
$$;

-- What the screens show of one file.
create or replace function file_doc_json(f patient_file_doc, p_view text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', f.id, 'patientId', f.patient_id, 'encounterId', f.encounter_id,
    'visitReference', e.reference, 'visitOpen', e.status = 'open', 'visitAt', e.arrived_at,
    'serviceRequestId', f.service_request_id,
    'test', (select s.name_en from service_request r join service s on s.id = r.service_id
             where r.id = f.service_request_id),
    'kind', f.kind, 'title', f.title, 'note', f.note,
    'mimeType', f.mime_type, 'sizeBytes', f.size_bytes, 'path', f.storage_path,
    'uploadedById', f.uploaded_by, 'uploadedBy', u.full_name, 'uploadedByRole', u.role,
    'uploadedAt', f.uploaded_at,
    'removed', f.removed_at is not null, 'removedAt', f.removed_at,
    'removedBy', (select full_name from profiles where id = f.removed_by), 'removeReason', f.remove_reason,
    -- a removed file whose copy is still in storage (the delete failed): the manager finishes it
    'storageLeft', case when f.removed_at is not null then file_object_exists(f.storage_path) end,
    'canRemove', f.removed_at is null
                 and (is_manager() or (f.uploaded_by = auth.uid() and f.uploaded_at > now() - interval '24 hours')),
    'view', p_view)
  from encounter e
  left join profiles u on u.id = f.uploaded_by
  where e.id = f.encounter_id
$$;

-- The files of a patient (or of one visit / one test) that the signed-in person may see, how many
-- are private to them, and those removed (the manager only).
create or replace function files_list(p_patient_id uuid, p_encounter_id uuid, p_service_request_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_via text;
  v_reader boolean := clinical_reader();
  v_files jsonb;
  v_hidden integer;
  v_removed integer;
begin
  if auth.uid() is null or not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_via := history_via(p_patient_id);
  with f as (
    select d, coalesce(
             case when v_reader or is_manager() then visit_view_with(d.encounter_id, v_via, true) end,
             -- one's own upload, for 24 hours (as file_view)
             case when d.removed_at is null and d.uploaded_by = auth.uid()
                       and d.uploaded_at > now() - interval '24 hours' then 'own' end) as view
    from patient_file_doc d
    where d.patient_id = p_patient_id
      and (p_encounter_id is null or d.encounter_id = p_encounter_id)
      and (p_service_request_id is null or d.service_request_id = p_service_request_id)
  )
  select coalesce(jsonb_agg(file_doc_json(f.d, f.view) order by (f.d).uploaded_at desc)
                    filter (where f.view is not null and ((f.d).removed_at is null or is_manager())), '[]'::jsonb),
         count(*) filter (where f.view is null and (f.d).removed_at is null),
         count(*) filter (where f.view is not null and (f.d).removed_at is not null)
  into v_files, v_hidden, v_removed
  from f;
  return jsonb_build_object(
    'files', v_files,
    'hidden', v_hidden,
    'removed', v_removed,
    'maxBytes', file_max_bytes(),
    'types', jsonb_build_array('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));
end
$$;

-- The patient file's "Files": every visit's, and the open visit the person may add to.
create or replace function list_patient_files(p_patient_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_list jsonb := files_list(p_patient_id, null, null);
begin
  return v_list || jsonb_build_object(
    'attachTo', (select e.id from encounter e
                 where e.patient_id = p_patient_id and e.status = 'open' and e.deleted_at is null
                   and may_attach_file(e.id)
                 order by e.arrived_at desc limit 1));
end
$$;

-- One visit's files (the visit page), or one test's (the result entry); may the person add one.
create or replace function list_visit_files(p_encounter_id uuid, p_service_request_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_patient uuid;
begin
  select patient_id into v_patient from encounter where id = p_encounter_id and deleted_at is null;
  if v_patient is null then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  return files_list(v_patient, p_encounter_id, p_service_request_id)
    || jsonb_build_object('canAttach', may_attach_file(p_encounter_id, p_service_request_id),
                          'encounterId', p_encounter_id, 'patientId', v_patient);
end
$$;

-- ---------------------------------------------------------------- B adding a file
-- Registers a file already sent to Storage at p_path. Checks the rules again (the type, the
-- size, the path of this visit, the person may add to it) and, on Supabase, that the file is in
-- the bucket with that size and type.
create or replace function attach_file(
  p_encounter_id uuid,
  p_path text,
  p_kind text,
  p_title text,
  p_mime text,
  p_size integer,
  p_service_request_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_ext text := lower(substring(coalesce(p_path, '') from '\.([a-zA-Z]+)$'));
  v_obj_found boolean := false;
  v_obj_size bigint;
  v_obj_mime text;
  v_f patient_file_doc%rowtype;
  v_req service_request%rowtype;
  v_name text;
  v_file text;
  v_me text;
  v_test text;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_e.status <> 'open' then
    raise exception 'files are added while the visit is open' using errcode = '22023', hint = 'file_visit_closed';
  end if;
  if coalesce(p_kind, '') not in ('ultrasound', 'lab', 'scan', 'referral', 'photo', 'other') then
    raise exception 'unknown kind of file' using errcode = '22023', hint = 'file_kind';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 or length(trim(p_title)) > 200 then
    raise exception 'give the file a title' using errcode = '22023', hint = 'title_needed';
  end if;
  if not file_mime_ok(p_mime) then
    raise exception 'only photos (JPEG, PNG, WebP) and PDF files' using errcode = '22023', hint = 'file_type';
  end if;
  if p_size is null or p_size <= 0 or p_size > file_max_bytes() then
    raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
  end if;
  if file_path_encounter(p_path) is distinct from p_encounter_id
     or split_part(p_path, '/', 1) <> v_e.patient_id::text
     or not file_ext_ok(p_mime, v_ext) then
    raise exception 'the file is not stored where this visit''s files go' using errcode = '22023', hint = 'file_path';
  end if;
  if p_service_request_id is not null then
    select * into v_req from service_request
    where id = p_service_request_id and encounter_id = p_encounter_id and deleted_at is null;
    if not found or v_req.status = 'cancelled' then
      raise exception 'this test is not one of the visit' using errcode = '22023', hint = 'wrong_test';
    end if;
  end if;
  if not may_attach_file(p_encounter_id, p_service_request_id) then
    raise exception 'not allowed: only the people working on the visit add files'
      using errcode = '42501', hint = 'not_on_visit';
  end if;
  -- On Supabase: the file must be in the bucket, with the size and type said.
  if to_regclass('storage.objects') is not null then
    execute 'select true, (metadata ->> ''size'')::bigint, metadata ->> ''mimetype''
             from storage.objects where bucket_id = ''patient-files'' and name = $1'
      into v_obj_found, v_obj_size, v_obj_mime using p_path;
    if not coalesce(v_obj_found, false) then
      raise exception 'the file did not arrive: send it again' using errcode = '22023', hint = 'not_uploaded';
    end if;
    if v_obj_size is not null and v_obj_size > file_max_bytes() then
      raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
    end if;
    if v_obj_mime is not null and not file_mime_ok(v_obj_mime) then
      raise exception 'only photos (JPEG, PNG, WebP) and PDF files' using errcode = '22023', hint = 'file_type';
    end if;
  end if;
  insert into patient_file_doc (patient_id, encounter_id, service_request_id, kind, title, note,
                                storage_path, mime_type, size_bytes, uploaded_by)
  values (v_e.patient_id, p_encounter_id, p_service_request_id, p_kind, trim(p_title),
          nullif(trim(coalesce(p_note, '')), ''), p_path, p_mime,
          coalesce(v_obj_size::integer, p_size), auth.uid())
  returning * into v_f;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'patient_file_doc', v_f.id,
          jsonb_build_object('patient', v_f.patient_id, 'encounter', v_f.encounter_id, 'kind', v_f.kind,
                             'title', v_f.title, 'mime', v_f.mime_type, 'size', v_f.size_bytes));
  -- the laboratory or ultrasound added a file to a test: its requester is told
  if v_req.id is not null and v_req.requester_id is not null and v_req.requester_id <> auth.uid() then
    select p.surname || ' ' || p.given_names, p.file_number into v_name, v_file
    from patient p where p.id = v_e.patient_id;
    select full_name into v_me from profiles where id = auth.uid();
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
    values ('file_attached',
            jsonb_build_object('fileId', v_f.id, 'patientId', v_e.patient_id, 'encounterId', v_e.id,
                               'name', v_name, 'file', v_file, 'by', v_me, 'title', v_f.title,
                               'kind', v_f.kind, 'test', v_test),
            'File added to a test',
            coalesce(v_me, '') || ' added "' || v_f.title || '" to ' || coalesce(v_test, 'a test') || ' of ' || coalesce(v_name, ''),
            '/app/visit?encounter=' || v_e.id, false, v_req.requester_id, auth.uid());
  end if;
  return file_doc_json(v_f, 'visit');
end
$$;

-- ---------------------------------------------------------------- C opening a file
-- Checks the person may see the file, logs the opening of a past visit's file, and gives its
-- path; the screen then asks Storage for a link valid 5 minutes (createSignedUrl), which the
-- bucket's own policy checks again.
create or replace function file_open(p_file_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_f patient_file_doc%rowtype;
  v_view text;
begin
  if auth.uid() is null or not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_f from patient_file_doc where id = p_file_id;
  if not found or (v_f.removed_at is not null and not is_manager()) then
    raise exception 'file not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_f.removed_at is not null then
    raise exception 'this file was removed' using errcode = '22023', hint = 'already_removed';
  end if;
  v_view := file_view(v_f);
  if v_view is null then
    raise exception 'not allowed: this file belongs to records you may not see'
      using errcode = '42501', hint = 'private';
  end if;
  if v_view <> 'visit' then
    perform log_record_access(v_f.patient_id, v_f.encounter_id, v_view, 'attachment');
  end if;
  return jsonb_build_object('id', v_f.id, 'bucket', 'patient-files', 'path', v_f.storage_path,
                            'mimeType', v_f.mime_type, 'title', v_f.title, 'expiresIn', 300);
end
$$;

-- ---------------------------------------------------------------- D removing a file
-- The person who added it within 24 hours, or the manager; always with a reason. The row stays
-- (removed); the screen then deletes the file from Storage (only that person may: policy below).
create or replace function remove_file(p_file_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_f patient_file_doc%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the file is removed' using errcode = '22023', hint = 'reason_needed';
  end if;
  select * into v_f from patient_file_doc where id = p_file_id for update;
  if not found then
    raise exception 'file not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_f.removed_at is not null then
    raise exception 'this file was already removed' using errcode = '22023', hint = 'already_removed';
  end if;
  if not is_manager() then
    if v_f.uploaded_by <> auth.uid() then
      raise exception 'not allowed: the person who added the file or the manager removes it'
        using errcode = '42501', hint = 'not_uploader';
    end if;
    if v_f.uploaded_at <= now() - interval '24 hours' then
      raise exception 'not allowed: after 24 hours only the manager removes a file'
        using errcode = '42501', hint = 'remove_too_late';
    end if;
  end if;
  update patient_file_doc
  set removed_at = now(), removed_by = auth.uid(), remove_reason = trim(p_reason)
  where id = v_f.id
  returning * into v_f;
  insert into audit_event (actor_id, action, entity, entity_id, before, reason)
  values (auth.uid(), 'delete', 'patient_file_doc', v_f.id,
          jsonb_build_object('patient', v_f.patient_id, 'encounter', v_f.encounter_id, 'kind', v_f.kind,
                             'title', v_f.title, 'path', v_f.storage_path, 'uploadedBy', v_f.uploaded_by),
          v_f.remove_reason);
  return jsonb_build_object('id', v_f.id, 'bucket', 'patient-files', 'path', v_f.storage_path,
                            'removedAt', v_f.removed_at);
end
$$;

-- ---------------------------------------------------------------- E the Storage rules
-- Used by the policies on storage.objects for the bucket (and checked by db:check directly).
-- Send a file: an approved session, a path of a visit one may add to, not a registered file.
create or replace function file_object_insert_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok()
    and file_path_encounter(p_name) is not null
    and not exists (select 1 from patient_file_doc d where d.storage_path = p_name)
    and may_attach_file(file_path_encounter(p_name)), false)
$$;

-- Delete a file from Storage: a removed file, by the manager, or by the person who removed it in
-- the 15 minutes after (the screen deletes it at once; a failed delete is finished by the
-- manager); or an upload never registered (the screen cleans up when registering failed).
create or replace function file_object_delete_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok()
    and case
      when exists (select 1 from patient_file_doc d where d.storage_path = p_name) then
        exists (select 1 from patient_file_doc d
                where d.storage_path = p_name and d.removed_at is not null
                  and (is_manager()
                       or (d.removed_by = auth.uid() and d.removed_at > now() - interval '15 minutes')))
      else file_object_insert_ok(p_name)
    end, false)
$$;

-- Read a file (the 5-minute link): a registered file, not removed, that one may see (file_view):
-- of today's visit at once; of a past visit only after file_open wrote its 'attachment' line in
-- the access log, so that a link asked of Storage directly is never an unlogged look (35 minutes:
-- longer than the half hour in which file_open does not write the line again); one's own upload
-- not registered yet (Storage reads back what it has just written); a removed file, by the
-- person who may delete it.
create or replace function file_object_read_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok() and has_perm('patient.read')
    and case
      when exists (select 1 from patient_file_doc d where d.storage_path = p_name) then
        exists (select 1 from patient_file_doc d
                cross join lateral (select file_view(d) as v) x
                where d.storage_path = p_name and d.removed_at is null and x.v is not null
                  and (x.v = 'visit'
                       or exists (select 1 from record_access_entry a
                                  where a.actor_id = auth.uid() and a.patient_id = d.patient_id
                                    and a.encounter_id = d.encounter_id and a.what = 'attachment'
                                    and a.at > now() - interval '35 minutes')))
        -- Postgres deletes only the rows it may read: the person deleting a removed file
        or file_object_delete_ok(p_name)
      else file_object_insert_ok(p_name)
    end, false)
$$;

-- The bucket and its policies, where Storage exists (Supabase). Nothing to do by hand.
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'no storage schema here: the bucket patient-files is not created';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('patient-files', 'patient-files', false, 10485760,
          array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists patient_files_insert on storage.objects';
  execute 'drop policy if exists patient_files_select on storage.objects';
  execute 'drop policy if exists patient_files_delete on storage.objects';
  execute $p$create policy patient_files_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'patient-files' and public.file_object_insert_ok(name))$p$;
  execute $p$create policy patient_files_select on storage.objects for select to authenticated
    using (bucket_id = 'patient-files' and public.file_object_read_ok(name))$p$;
  execute $p$create policy patient_files_delete on storage.objects for delete to authenticated
    using (bucket_id = 'patient-files' and public.file_object_delete_ok(name))$p$;
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function file_doc_json(patient_file_doc, text), files_list(uuid, uuid, uuid),
  file_path_encounter(text), file_view(patient_file_doc), file_object_exists(text),
  log_record_access(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function storage_session_ok(), may_attach_file(uuid, uuid), list_patient_files(uuid),
  list_visit_files(uuid, uuid), attach_file(uuid, text, text, text, text, integer, uuid, text),
  file_open(uuid), remove_file(uuid, text), file_object_insert_ok(text), file_object_read_ok(text),
  file_object_delete_ok(text) from public, anon;
grant execute on function storage_session_ok(), may_attach_file(uuid, uuid), list_patient_files(uuid),
  list_visit_files(uuid, uuid), attach_file(uuid, text, text, text, text, integer, uuid, text),
  file_open(uuid), remove_file(uuid, text), file_object_insert_ok(text), file_object_read_ok(text),
  file_object_delete_ok(text) to authenticated;
