-- 0011 · Optional loan details (BR-10.5), for information only: nothing is computed from them
-- in the MVP (amortization is Later). And the instalment mark behind a budget's one-line note
-- (BR-07.13): it changes no figure, since the full price is an expense at purchase (D-15, I-6).

ALTER TABLE fin.accounts
  ADD COLUMN loan_principal_minor   bigint CHECK (loan_principal_minor >= 0),
  ADD COLUMN loan_rate_bp           integer CHECK (loan_rate_bp BETWEEN 0 AND 100000),
  ADD COLUMN loan_installment_minor bigint CHECK (loan_installment_minor >= 0),
  ADD COLUMN loan_term_months       integer CHECK (loan_term_months BETWEEN 1 AND 1200);

ALTER TABLE fin.transactions ADD COLUMN is_instalment boolean NOT NULL DEFAULT false;
