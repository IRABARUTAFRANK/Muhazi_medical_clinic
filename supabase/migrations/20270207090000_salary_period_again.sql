-- 0183 · A pay period settled again after an undo. Frank skipped a period, undid it and marked it
-- paid: "duplicate key value violates unique constraint salary_period_profile_id_period_start_key".
-- unpay_salary leaves the undone row in place (deleted_at set, kept for the history), and
-- pay_salary / skip_salary insert a new row for the same period: the table's plain unique
-- constraint refused it. The uniqueness now holds among the live rows only: one settled row per
-- employee and period at a time, the undone ones kept underneath.

alter table salary_period drop constraint if exists salary_period_profile_id_period_start_key;
create unique index if not exists salary_period_live_idx
  on salary_period (profile_id, period_start)
  where deleted_at is null;
