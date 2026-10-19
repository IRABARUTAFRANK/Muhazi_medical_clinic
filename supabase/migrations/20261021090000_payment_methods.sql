-- 0027 — Accepted payment methods: the clinic takes cash, MTN MoMo and Airtel Money only.
-- Card and bank transfer stay in the payment_method enum so older rows remain readable, but no
-- new payment may use them. NOT VALID: existing rows are not re-checked.
alter table payment drop constraint if exists payment_method_accepted;
alter table payment
  add constraint payment_method_accepted
  check (method not in ('card', 'bank')) not valid;
