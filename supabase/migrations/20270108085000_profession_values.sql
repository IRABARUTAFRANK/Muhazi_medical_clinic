-- 0128 (part 1) · Two new professions: midwife and administrator.
--
-- Only the enum values, in a file of their own: a value added by ALTER TYPE … ADD VALUE cannot be
-- used in the transaction that adds it, and 20270108090000_profession_manager.sql (part 2) uses
-- them (the desks and the switches of the new professions). Each migration file runs in its own
-- transaction (pnpm db:apply), so part 2 sees them committed.
--
--   midwife        a treating profession, like the nurse (triage, nursing care, family planning…)
--   administrator  a non-medical manager: no treating desk; reception only when placed and allowed
--
-- 'manager' stays in the enum for old rows and old callers only: from 0128 the manager is not a
-- profession but a flag (profiles.is_manager, "Also the clinic manager").

alter type role_key add value if not exists 'midwife';
alter type role_key add value if not exists 'administrator';
