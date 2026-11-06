-- 0137 · RSSB's lists are the lists of both its schemes: RAMA and Mutuelle de santé (CBHI).
--
-- RSSB runs two health insurance schemes, RAMA (the RSSB medical scheme) and CBHI ("Mutuelle de
-- santé"); MMI is not RSSB's (it is run under the Ministry of Defence). The system knows it from
-- the insurer's kind: payer_body(payer) = 'RSSB' for the kinds rssb_rama and cbhi.
--
-- An insurer's own list (scope 'insurer') whose insurer is one of RSSB's schemes is the list of
-- every RSSB scheme:
--   * they all follow it, first, like its insurer (a new list; an RSSB scheme added later or whose
--     kind becomes RSSB's follows RSSB's lists at once); one that stopped following stays stopped
--     when a new version comes;
--   * they all pay the list's own column (the column of the version in effect, as its insurer);
--   * the file's instructions (not covered, approval needed, notes) are the exceptions of every RSSB
--     scheme; exceptions typed by hand stay each scheme's own.
-- Done when a version is kept or its column changes (a trigger at the end of the transaction, so
-- after import_tariff has written the instructions), and when an insurer is added or its kind
-- changes. The lists of the other insurers are not shared.
-- tariff_books: + payerBody (RSSB for RSSB's lists) and each follower's body.

-- ---------------------------------------------------------------- who runs a scheme
create or replace function payer_body_of(p_type payer_type)
returns text
language sql immutable
as $$
  select case when p_type in ('rssb_rama', 'cbhi') then 'RSSB' end
$$;

create or replace function payer_body(p_payer uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select payer_body_of(p.type) from payer p where p.id = p_payer
$$;

-- ---------------------------------------------------------------- the price a scheme pays
-- tariff_price_for (from 20270115090000_clinic_price_lists): an insurer's own list is paid in its
-- own column by its insurer and by the other schemes of the same body (RSSB: RAMA and CBHI).
create or replace function tariff_price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, book_id uuid, code text, note text)
language sql stable security definer set search_path = public
as $$
  select round((l.prices ->> c.col)::numeric), pt.book_id, l.code, l.note
  from payer_tariff pt
  join tariff_book b on b.id = pt.book_id and b.deleted_at is null
    and b.kind = case when p_service_id is not null then 'treatments' else 'medicines' end
  join tariff_version v on v.id = tariff_version_at(pt.book_id, p_at)
  -- an insurer's own list (or its body's): the column of that version; any other list: the column it chose
  cross join lateral (select coalesce(case when b.scope = 'insurer'
                                             and (b.payer_id = pt.payer_id
                                                  or payer_body(b.payer_id) = payer_body(pt.payer_id))
                                           then v.payer_column end,
                                      pt.column_key) as col) c
  join tariff_line l on l.version_id = v.id
    and l.code = tariff_line_code(pt.book_id, p_service_id, p_item_id) and l.removed_at is null
  where pt.payer_id = p_payer_id and p_payer_id is not null
    and jsonb_typeof(l.prices -> c.col) = 'number'
  order by pt.priority, pt.created_at
  limit 1
$$;

-- ---------------------------------------------------------------- sharing a list in its body
-- tariff_share_body(list, scheme, follow): the other schemes of the body of the list's insurer
-- (all of them, or only p_payer) take the list as their own: with p_follow they follow it (first,
-- in its column), otherwise only those that follow it get its column again; and every one of them
-- gets the exceptions the file's instructions gave (those of the scheme the instructions were
-- written for, else of the list's insurer). Typed exceptions are never touched. Answers how many
-- schemes share it.
create or replace function tariff_share_body(p_book uuid, p_payer uuid default null, p_follow boolean default false)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_book tariff_book%rowtype;
  v_body text;
  v_own payer_tariff%rowtype;
  v_from uuid;
  v_n integer := 0;
  r record;
begin
  select * into v_book from tariff_book where id = p_book and deleted_at is null;
  if not found or v_book.scope <> 'insurer' or v_book.payer_id is null then
    return 0;
  end if;
  v_body := payer_body(v_book.payer_id);
  if v_body is null then
    return 0;
  end if;
  select * into v_own from payer_tariff where book_id = p_book and payer_id = v_book.payer_id;
  -- the scheme the file's instructions were written for (the version uploaded last), else the owner
  select v.instructions_payer_id into v_from
  from tariff_version v
  where v.book_id = p_book
  order by v.uploaded_at desc nulls last, v.effective_from desc
  limit 1;
  if v_from is null or payer_body(v_from) is distinct from v_body then
    v_from := v_book.payer_id;
  end if;
  for r in
    select p.id from payer p
    where p.deleted_at is null and p.type <> 'cash' and payer_body_of(p.type) = v_body
      and (p_payer is null or p.id = p_payer)
  loop
    -- it follows the list as its insurer does
    if r.id <> v_book.payer_id and v_own.payer_id is not null then
      if coalesce(p_follow, false) then
        insert into payer_tariff (payer_id, book_id, column_key, priority, created_by)
        values (r.id, p_book, v_own.column_key, v_own.priority, auth.uid())
        on conflict (payer_id, book_id) do update set column_key = excluded.column_key;
      else
        update payer_tariff set column_key = v_own.column_key
        where payer_id = r.id and book_id = p_book and column_key is distinct from v_own.column_key;
      end if;
    end if;
    -- the file's instructions are its exceptions too
    if r.id <> v_from then
      delete from tariff_exception e
      where e.payer_id = r.id and e.book_id = p_book and e.source = 'upload'
        and not exists (select 1 from tariff_exception o
                        where o.payer_id = v_from and o.book_id = p_book and o.source = 'upload' and o.code = e.code);
      insert into tariff_exception (payer_id, code, book_id, cover, price, note, source, version_id, updated_by, updated_at)
      select r.id, o.code, o.book_id, o.cover, o.price, o.note, 'upload', o.version_id, o.updated_by, now()
      from tariff_exception o
      where o.payer_id = v_from and o.book_id = p_book and o.source = 'upload'
      on conflict (payer_id, code) do update
        set cover = excluded.cover, price = excluded.price, note = excluded.note, book_id = excluded.book_id,
            version_id = excluded.version_id, updated_by = excluded.updated_by, updated_at = now()
        where tariff_exception.source = 'upload';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- a version kept (the first: the other schemes follow) or its column changed: at the end of the
-- transaction, when import_tariff has written the instructions
create or replace function tariff_version_share_body()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform tariff_share_body(
    new.book_id, null,
    tg_op = 'INSERT' and not exists (select 1 from tariff_version v where v.book_id = new.book_id and v.id <> new.id));
  return null;
end
$$;
drop trigger if exists trg_tariff_version_share_body on tariff_version;
create constraint trigger trg_tariff_version_share_body
  after insert or update of payer_column on tariff_version
  deferrable initially deferred
  for each row execute function tariff_version_share_body();

-- an insurer added, or its kind changed: it takes the lists of its body (RSSB's lists for RAMA / CBHI)
create or replace function payer_share_body_lists()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  if new.deleted_at is not null or payer_body_of(new.type) is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.type = new.type then
    return null;
  end if;
  for r in
    select b.id from tariff_book b
    where b.deleted_at is null and b.scope = 'insurer' and b.payer_id is not null and b.payer_id <> new.id
      and payer_body(b.payer_id) = payer_body_of(new.type)
  loop
    perform tariff_share_body(r.id, new.id, true);
  end loop;
  return null;
end
$$;
drop trigger if exists trg_payer_share_body_lists on payer;
create trigger trg_payer_share_body_lists
  after insert or update of type on payer
  for each row execute function payer_share_body_lists();

-- the RSSB lists already kept: the other scheme follows them now
select tariff_share_body(b.id, null, true)
from tariff_book b
where b.deleted_at is null and b.scope = 'insurer' and payer_body(b.payer_id) is not null;

-- ---------------------------------------------------------------- reading the lists
-- tariff_books (from 20270115090000_clinic_price_lists): + payerBody (the body of the list's insurer:
-- RSSB for RAMA and CBHI) and each follower's body.
create or replace function tariff_books()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'publisher', b.publisher, 'kind', b.kind, 'payerId', b.payer_id, 'payer', bp.name, 'payerBody', payer_body_of(bp.type),
      'scope', b.scope, 'privateColumn', b.private_column, 'priority', b.priority,
      'createdAt', b.created_at,
      'versions', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'name', v.name, 'effectiveFrom', v.effective_from, 'rows', v.rows, 'status', v.status,
            'columns', v.columns, 'uploadedAt', v.uploaded_at, 'uploadedBy', pr.full_name, 'fileName', v.file_name,
            'notes', v.notes, 'summary', v.summary, 'instructionsPayer', ip.name,
            'inEffect', v.id = tariff_version_at(b.id, current_date),
            'edited', (select count(*)::int from tariff_line l where l.version_id = v.id and l.edited_at is not null
                         and l.removed_at is null),
            'removedLines', (select count(*)::int from tariff_line l where l.version_id = v.id and l.removed_at is not null)
          ) order by v.effective_from desc, v.uploaded_at desc), '[]'::jsonb)
        from tariff_version v
        left join profiles pr on pr.id = v.uploaded_by
        left join payer ip on ip.id = v.instructions_payer_id
        where v.book_id = b.id),
      'followers', (
        select coalesce(jsonb_agg(jsonb_build_object('payerId', pt.payer_id, 'payer', py.name, 'column', pt.column_key,
                                                     'priority', pt.priority, 'body', payer_body_of(py.type)) order by py.name), '[]'::jsonb)
        from payer_tariff pt join payer py on py.id = pt.payer_id and py.deleted_at is null
        where pt.book_id = b.id),
      'exceptions', (select count(*)::int from tariff_exception e where e.book_id = b.id),
      'linked', on_list.n,
      'ownPriced', on_list.own
    ) order by b.kind desc, case b.scope when 'clinic' then 0 when 'insurer' then 1 else 2 end, b.priority, b.name), '[]'::jsonb)
  from tariff_book b
  left join payer bp on bp.id = b.payer_id
  left join lateral (
    select count(*)::int as n, count(*) filter (where x.own is not null)::int as own
    from (
      select own_cash_price(s.id, null) as own
      from service s
      join tariff_line l on l.code = tariff_line_code(b.id, s.id, null) and l.removed_at is null
      join tariff_version v on v.id = l.version_id and v.book_id = b.id and v.status = 'current'
      where b.kind = 'treatments' and s.deleted_at is null and s.active
      union all
      select own_cash_price(null, i.id)
      from item i
      join tariff_line l on l.code = tariff_line_code(b.id, null, i.id) and l.removed_at is null
      join tariff_version v on v.id = l.version_id and v.book_id = b.id and v.status = 'current'
      where b.kind = 'medicines' and i.deleted_at is null and i.active
    ) x
  ) on_list on true
  where b.deleted_at is null and auth.uid() is not null
$$;

-- ---------------------------------------------------------------- grants
revoke all on function payer_body(uuid), tariff_share_body(uuid, uuid, boolean), tariff_version_share_body(),
  payer_share_body_lists() from public, anon, authenticated;
grant execute on function payer_body(uuid) to authenticated;
