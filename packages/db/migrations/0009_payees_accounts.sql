-- 0009 · Payee defaults (BR-05.6), and account notes and display order (BR-03.1).
-- A default category is either set by the user, or learned from the last use until they set one.

ALTER TABLE fin.payees ADD COLUMN default_is_explicit boolean NOT NULL DEFAULT false;
ALTER TABLE fin.accounts ADD COLUMN notes text CHECK (length(notes) <= 1000);
ALTER TABLE fin.accounts ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
