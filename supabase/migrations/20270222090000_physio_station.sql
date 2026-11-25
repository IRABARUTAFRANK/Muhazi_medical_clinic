-- 0205 · Physiotherapy, a section of its own (Frank, 2026-11-25: "Replace HIV and testing with
-- Physiotherapy … the same as dental or minor surgery: a department where people are placed").
--
-- A new value of the station type is added alone, in its own file: Postgres does not let a value
-- added in a transaction be used in that same transaction. 20270222091000_physiotherapy_desk.sql
-- (the next file) uses it.
alter type station add value if not exists 'physio';
