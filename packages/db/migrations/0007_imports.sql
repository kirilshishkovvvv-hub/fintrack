-- 0007 · CSV import (FR-16, Stage 1 §9.6, Stage 2 §5). The file itself is never stored (BR-16.7);
-- only parsed rows are. Guarantees enforced here, independent of application code:
--   * a fingerprint and ordinal can be imported into an account only once (BR-16.2, BR-16.3)
--   * an existing transaction can be claimed by one import row at most (BR-16.9, M-6)

CREATE TABLE fin.import_profiles (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES fin.workspaces (id),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  encoding          text NOT NULL,
  delimiter         text NOT NULL CHECK (length(delimiter) = 1),
  decimal_separator char(1) NOT NULL CHECK (decimal_separator IN ('.', ',')),
  date_format       text NOT NULL,
  header_row        integer,
  mapping           jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE fin.import_batches (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES fin.workspaces (id),
  account_id        uuid NOT NULL,
  profile_id        uuid,
  status            text NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'confirmed', 'undone', 'discarded')),
  file_sha256       text NOT NULL,
  file_name         text CHECK (length(file_name) <= 255),
  row_count         integer NOT NULL,
  -- BR-23.4: with no currency column the amounts are assumed, and the user must confirm that.
  currency_assumed  boolean NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  undone_at         timestamptz,
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES fin.import_profiles (workspace_id, id)
);
CREATE INDEX import_batches_account_idx ON fin.import_batches (workspace_id, account_id, created_at);

CREATE TABLE fin.import_rows (
  id                       uuid PRIMARY KEY,
  workspace_id             uuid NOT NULL,
  batch_id                 uuid NOT NULL,
  row_no                   integer NOT NULL,
  account_id               uuid NOT NULL,
  row_date                 date,
  amount_minor             bigint CHECK (amount_minor BETWEEN -999999999999 AND 999999999999),
  description              text CHECK (length(description) <= 500),
  counterparty             text CHECK (length(counterparty) <= 200),
  reference                text CHECK (length(reference) <= 200),
  currency_code            text CHECK (length(currency_code) <= 8),
  fingerprint              text,
  ordinal                  integer NOT NULL DEFAULT 0,
  classification           text NOT NULL CHECK (classification IN ('new', 'duplicate', 'possible_duplicate', 'already_recorded', 'transfer', 'rejected')),
  reject_reason            text,
  decision                 text CHECK (decision IN ('import', 'skip', 'link', 'transfer')),
  category_id              uuid,
  counter_account_id       uuid,
  candidate_transaction_id uuid,
  claimed_transaction_id   uuid,
  created_transaction_id   uuid,
  -- The transaction as it was before an import turned it into a transfer, for undo (BR-16.5, BR-16.6).
  replaced_snapshot        jsonb,
  state                    text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'imported', 'skipped', 'rejected', 'undone')),
  UNIQUE (batch_id, row_no),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES fin.import_batches (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id),
  FOREIGN KEY (workspace_id, category_id) REFERENCES fin.categories (workspace_id, ledger_account_id),
  FOREIGN KEY (workspace_id, counter_account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id),
  -- A transaction purged from the trash leaves the row's history without its link.
  FOREIGN KEY (workspace_id, candidate_transaction_id) REFERENCES fin.transactions (workspace_id, id) ON DELETE SET NULL (candidate_transaction_id),
  FOREIGN KEY (workspace_id, claimed_transaction_id) REFERENCES fin.transactions (workspace_id, id) ON DELETE SET NULL (claimed_transaction_id),
  FOREIGN KEY (workspace_id, created_transaction_id) REFERENCES fin.transactions (workspace_id, id) ON DELETE SET NULL (created_transaction_id)
);
CREATE INDEX import_rows_batch_idx ON fin.import_rows (workspace_id, batch_id, row_no);
CREATE UNIQUE INDEX import_rows_fingerprint_idx ON fin.import_rows (workspace_id, account_id, fingerprint, ordinal) WHERE state = 'imported';
CREATE UNIQUE INDEX import_rows_claim_idx ON fin.import_rows (claimed_transaction_id) WHERE state = 'imported';

GRANT SELECT, INSERT, UPDATE ON fin.import_profiles, fin.import_batches, fin.import_rows TO fin_app;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['import_profiles', 'import_batches', 'import_rows'] LOOP
    EXECUTE format('ALTER TABLE fin.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE fin.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON fin.%I USING (workspace_id = fin.current_workspace()) '
      'WITH CHECK (workspace_id = fin.current_workspace())', table_name);
  END LOOP;
END
$$;

-- Retention: the purge of a deleted workspace removes all of it, under its own workspace context;
-- batches abandoned in review, or discarded, are removed after 7 days across workspaces (§11.3).
GRANT SELECT, DELETE ON fin.import_profiles, fin.import_batches, fin.import_rows TO fin_maintenance;
CREATE POLICY maintenance_abandoned ON fin.import_batches FOR SELECT TO fin_maintenance USING (status IN ('review', 'discarded'));
CREATE POLICY maintenance_abandoned_delete ON fin.import_batches FOR DELETE TO fin_maintenance USING (status IN ('review', 'discarded'));
