-- 0001 · Ledger core: workspaces, ledger accounts, transactions, postings, history.
-- Implements Stage 2 §5 (schema), §7 (integrity) and §8.3 (isolation).
-- Guarantees enforced here, independent of application code:
--   * every transaction balances at commit, with at least 2 postings and one user account (LR-01, LR-02)
--   * no reference can cross workspaces (composite foreign keys, BR-02.3)
--   * row-level security is forced on every workspace-owned table (FR-02, AD-05)
--   * the workspace currency is locked once transactions exist (BR-23.2)
--   * history tables are append-only (LR-10, FR-19)

CREATE SCHEMA IF NOT EXISTS fin;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fin_app') THEN
    CREATE ROLE fin_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA fin TO fin_app;

-- Request context, set with SET LOCAL by the application for each database transaction.
CREATE FUNCTION fin.current_workspace() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE FUNCTION fin.current_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

-- ---------------------------------------------------------------------------
-- Workspaces and memberships
-- ---------------------------------------------------------------------------

CREATE TABLE fin.workspaces (
  id                          uuid PRIMARY KEY,
  name                        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  currency                    char(3) NOT NULL CHECK (currency IN ('EUR', 'USD')),
  timezone                    text NOT NULL,
  protected_reserve_minor     bigint NOT NULL DEFAULT 0 CHECK (protected_reserve_minor >= 0),
  sts_count_savings_transfers boolean NOT NULL DEFAULT true,
  status                      text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'deletion_pending', 'purged')),
  deletion_requested_at       timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer NOT NULL DEFAULT 1,
  UNIQUE (id, currency)
);

CREATE TABLE fin.memberships (
  workspace_id uuid NOT NULL REFERENCES fin.workspaces (id),
  user_id      text NOT NULL,
  role         text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON fin.memberships (user_id);

-- ---------------------------------------------------------------------------
-- Ledger accounts: user accounts, categories and system accounts (§2.3)
-- ---------------------------------------------------------------------------

CREATE TABLE fin.ledger_accounts (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('asset', 'liability', 'income', 'expense', 'equity')),
  currency     char(3) NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  system_code  text CHECK (system_code IN ('OBE', 'ADJ', 'VAL', 'CNV', 'TIT')),
  is_archived  boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  FOREIGN KEY (workspace_id, currency) REFERENCES fin.workspaces (id, currency) ON UPDATE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, kind),
  CHECK (system_code IS NULL OR system_code = 'TIT' OR kind = 'equity'),
  CHECK (system_code IS DISTINCT FROM 'TIT' OR kind = 'asset'),
  CHECK (kind <> 'equity' OR system_code IS NOT NULL),
  CHECK (is_archived = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_accounts_system_idx ON fin.ledger_accounts (workspace_id, system_code)
  WHERE system_code IS NOT NULL;

CREATE TABLE fin.accounts (
  ledger_account_id  uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  ledger_kind        text NOT NULL CHECK (ledger_kind IN ('asset', 'liability')),
  account_class      text NOT NULL CHECK (account_class IN ('cash', 'investment', 'other_asset', 'liability')),
  account_type       text NOT NULL CHECK (account_type IN
                       ('current', 'savings', 'cash', 'investment', 'lent', 'other_asset',
                        'card', 'loan', 'other_liability')),
  spendable          boolean NOT NULL DEFAULT false,
  card_reserve       boolean NOT NULL DEFAULT false,
  opening_date       date NOT NULL,
  credit_limit_minor bigint CHECK (credit_limit_minor >= 0),
  institution_label  text CHECK (length(institution_label) <= 100),
  dedicated_goal_id  uuid,
  FOREIGN KEY (workspace_id, ledger_account_id, ledger_kind)
    REFERENCES fin.ledger_accounts (workspace_id, id, kind),
  UNIQUE (workspace_id, ledger_account_id),
  CHECK ((account_class = 'liability') = (ledger_kind = 'liability')),
  CHECK (
    (account_type IN ('current', 'savings', 'cash') AND account_class = 'cash') OR
    (account_type = 'investment' AND account_class = 'investment') OR
    (account_type IN ('lent', 'other_asset') AND account_class = 'other_asset') OR
    (account_type IN ('card', 'loan', 'other_liability') AND account_class = 'liability')
  ),
  CHECK (NOT spendable OR account_class = 'cash'),                -- LR-18
  CHECK (NOT card_reserve OR account_type = 'card'),              -- LR-18
  CHECK (dedicated_goal_id IS NULL OR NOT spendable)              -- §8.2 G-D3
);

CREATE TABLE fin.categories (
  ledger_account_id uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL,
  ledger_kind       text NOT NULL CHECK (ledger_kind IN ('income', 'expense')),
  parent_id         uuid,
  system_key        text,
  sort_order        integer NOT NULL DEFAULT 0,
  FOREIGN KEY (workspace_id, ledger_account_id, ledger_kind)
    REFERENCES fin.ledger_accounts (workspace_id, id, kind),
  UNIQUE (workspace_id, ledger_account_id),
  UNIQUE (workspace_id, ledger_account_id, ledger_kind),
  FOREIGN KEY (workspace_id, parent_id, ledger_kind)
    REFERENCES fin.categories (workspace_id, ledger_account_id, ledger_kind),
  CHECK (parent_id IS DISTINCT FROM ledger_account_id)
);

-- Two levels only: a parent can't have a parent, and a category with children can't get one (A-4).
CREATE FUNCTION fin.check_category_depth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM fin.categories WHERE ledger_account_id = NEW.parent_id AND parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'categories have two levels only' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM fin.categories WHERE parent_id = NEW.ledger_account_id) THEN
    RAISE EXCEPTION 'a category with subcategories cannot become a subcategory' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER categories_depth BEFORE INSERT OR UPDATE OF parent_id ON fin.categories
  FOR EACH ROW EXECUTE FUNCTION fin.check_category_depth();

CREATE TABLE fin.payees (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES fin.workspaces (id),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  normalized_name     text NOT NULL,
  default_category_id uuid,
  is_archived         boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, normalized_name),
  FOREIGN KEY (workspace_id, default_category_id) REFERENCES fin.categories (workspace_id, ledger_account_id)
);

-- ---------------------------------------------------------------------------
-- Transactions and postings
-- ---------------------------------------------------------------------------

CREATE TABLE fin.transactions (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES fin.workspaces (id),
  txn_date     date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('expense', 'income', 'transfer', 'refund', 'debt_payment',
                                             'split', 'opening_balance', 'adjustment', 'valuation')),
  status       text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided', 'trashed')),
  origin       text NOT NULL CHECK (origin IN ('manual', 'import', 'occurrence', 'system')),
  description  text CHECK (length(description) <= 500),
  payee_id     uuid,
  memo         text CHECK (length(memo) <= 1000),
  refund_of_id uuid,
  voided_at    timestamptz,
  trashed_at   timestamptz,
  created_by   text,
  updated_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  UNIQUE (id, txn_date, status),
  FOREIGN KEY (workspace_id, payee_id) REFERENCES fin.payees (workspace_id, id),
  -- GAP-2: if the original is purged from the trash, the refund stays and its link is cleared.
  FOREIGN KEY (workspace_id, refund_of_id) REFERENCES fin.transactions (workspace_id, id)
    ON DELETE SET NULL (refund_of_id),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((status = 'trashed') = (trashed_at IS NOT NULL))
);
CREATE INDEX transactions_date_idx ON fin.transactions (workspace_id, txn_date DESC) WHERE status = 'posted';
CREATE INDEX transactions_trash_idx ON fin.transactions (trashed_at) WHERE status = 'trashed';

CREATE TABLE fin.postings (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL,
  transaction_id    uuid NOT NULL,
  txn_date          date NOT NULL,
  txn_status        text NOT NULL,
  ledger_account_id uuid NOT NULL,
  amount_minor      bigint NOT NULL
                      CHECK (amount_minor <> 0 AND amount_minor BETWEEN -999999999999 AND 999999999999),
  currency          char(3) NOT NULL,
  line_no           smallint NOT NULL CHECK (line_no >= 1),
  mark              text CHECK (mark IN ('discount', 'deduction')),
  memo              text CHECK (length(memo) <= 500),
  reconciliation_id uuid,
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES fin.transactions (workspace_id, id) ON DELETE CASCADE,
  -- Keeps the copied date and status identical to the transaction's (Stage 2 §5.4).
  FOREIGN KEY (transaction_id, txn_date, txn_status) REFERENCES fin.transactions (id, txn_date, status)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, ledger_account_id) REFERENCES fin.ledger_accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, currency) REFERENCES fin.workspaces (id, currency),
  UNIQUE (transaction_id, line_no)
);
-- Balances are summed straight from this index (NFR-03).
CREATE INDEX postings_balance_idx ON fin.postings (workspace_id, ledger_account_id, txn_date)
  INCLUDE (amount_minor) WHERE txn_status = 'posted';
CREATE INDEX postings_transaction_idx ON fin.postings (transaction_id);

-- LR-01 and LR-02, checked when the database transaction commits.
CREATE FUNCTION fin.check_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx_id       uuid;
  line_count  integer;
  total       numeric;
  user_lines  integer;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    tx_id := NEW.id;
  ELSE
    tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.transactions WHERE id = tx_id) THEN
    RETURN NULL;  -- the whole transaction was deleted (trash purge)
  END IF;
  SELECT count(*), COALESCE(sum(p.amount_minor), 0), count(a.ledger_account_id)
    INTO line_count, total, user_lines
    FROM fin.postings p
    LEFT JOIN fin.accounts a ON a.ledger_account_id = p.ledger_account_id
   WHERE p.transaction_id = tx_id;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'transaction % needs at least 2 postings (LR-02)', tx_id USING ERRCODE = '23514';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'transaction % does not balance: postings sum to % (LR-01)', tx_id, total
      USING ERRCODE = '23514';
  END IF;
  IF user_lines = 0 THEN
    RAISE EXCEPTION 'transaction % touches no user account (LR-02)', tx_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER transactions_balanced AFTER INSERT ON fin.transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.check_transaction_balanced();
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT OR UPDATE OR DELETE ON fin.postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.check_transaction_balanced();

-- LR-04 (no future dates, in the workspace time zone).
CREATE FUNCTION fin.check_transaction_date() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  local_today date;
BEGIN
  SELECT (now() AT TIME ZONE w.timezone)::date INTO local_today FROM fin.workspaces w WHERE w.id = NEW.workspace_id;
  IF NEW.txn_date > local_today THEN
    RAISE EXCEPTION 'actual transactions cannot be dated in the future (A-8)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER transactions_date BEFORE INSERT OR UPDATE OF txn_date ON fin.transactions
  FOR EACH ROW EXECUTE FUNCTION fin.check_transaction_date();

-- LR-04 (not before an account's opening date), LR-05 (equity only through its system kind),
-- LR-14 (archived accounts and categories receive no postings).
CREATE FUNCTION fin.check_posting_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target    fin.ledger_accounts%ROWTYPE;
  tx_kind   text;
  opened_on date;
BEGIN
  SELECT * INTO target FROM fin.ledger_accounts WHERE id = NEW.ledger_account_id;
  SELECT kind INTO tx_kind FROM fin.transactions WHERE id = NEW.transaction_id;
  IF target.is_archived THEN
    RAISE EXCEPTION '% is archived (LR-14)', target.name USING ERRCODE = '23514';
  END IF;
  IF target.kind = 'equity' AND NOT (
       (target.system_code = 'OBE' AND tx_kind = 'opening_balance') OR
       (target.system_code = 'ADJ' AND tx_kind = 'adjustment') OR
       (target.system_code = 'VAL' AND tx_kind = 'valuation')) THEN
    RAISE EXCEPTION '% transactions cannot post to % (LR-05)', tx_kind, target.system_code USING ERRCODE = '23514';
  END IF;
  SELECT opening_date INTO opened_on FROM fin.accounts WHERE ledger_account_id = NEW.ledger_account_id;
  IF opened_on IS NOT NULL AND NEW.txn_date < opened_on THEN
    RAISE EXCEPTION '% was opened on %, after % (LR-04)', target.name, opened_on, NEW.txn_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER postings_target BEFORE INSERT OR UPDATE OF ledger_account_id, txn_date ON fin.postings
  FOR EACH ROW EXECUTE FUNCTION fin.check_posting_target();

-- BR-23.2: the workspace currency can't change once any transaction exists.
CREATE FUNCTION fin.check_currency_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency
     AND EXISTS (SELECT 1 FROM fin.transactions WHERE workspace_id = OLD.id) THEN
    RAISE EXCEPTION 'the workspace currency is locked once transactions exist (BR-23.2)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspaces_currency_lock BEFORE UPDATE OF currency ON fin.workspaces
  FOR EACH ROW EXECUTE FUNCTION fin.check_currency_lock();

-- ---------------------------------------------------------------------------
-- History, audit and idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE fin.transaction_versions (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL,
  transaction_id uuid NOT NULL,
  version        integer NOT NULL,
  change_type    text NOT NULL CHECK (change_type IN ('create', 'edit', 'void', 'restore', 'trash', 'unlock')),
  before         jsonb,
  after          jsonb,
  changed_by     text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES fin.transactions (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (transaction_id, version)
);

CREATE TABLE fin.audit_events (
  id           uuid PRIMARY KEY,
  workspace_id uuid REFERENCES fin.workspaces (id),
  user_id      text,
  event_type   text NOT NULL,
  object_type  text,
  object_id    uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  ip_prefix    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_workspace_idx ON fin.audit_events (workspace_id, occurred_at);

CREATE FUNCTION fin.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON fin.audit_events
  FOR EACH ROW EXECUTE FUNCTION fin.forbid_change();
CREATE TRIGGER transaction_versions_append_only BEFORE UPDATE ON fin.transaction_versions
  FOR EACH ROW EXECUTE FUNCTION fin.forbid_change();

CREATE TABLE fin.idempotency_records (
  user_id      text NOT NULL,
  idem_key     text NOT NULL CHECK (length(idem_key) BETWEEN 8 AND 200),
  workspace_id uuid NOT NULL REFERENCES fin.workspaces (id),
  request_hash text NOT NULL,
  status_code  smallint NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (user_id, idem_key)
);

-- ---------------------------------------------------------------------------
-- Privileges and row-level security (Stage 2 §8.3)
-- ---------------------------------------------------------------------------

-- The application role can read and write, but never delete financial history.
GRANT SELECT, INSERT, UPDATE ON
  fin.workspaces, fin.memberships, fin.ledger_accounts, fin.accounts, fin.categories,
  fin.payees, fin.transactions, fin.postings, fin.idempotency_records
  TO fin_app;
GRANT DELETE ON fin.postings TO fin_app;  -- edits replace postings atomically (LR-10)
GRANT SELECT, INSERT ON fin.transaction_versions, fin.audit_events TO fin_app;
GRANT EXECUTE ON FUNCTION fin.current_workspace(), fin.current_user_id() TO fin_app;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ledger_accounts', 'accounts', 'categories', 'payees', 'transactions', 'postings',
    'transaction_versions', 'idempotency_records'
  ] LOOP
    EXECUTE format('ALTER TABLE fin.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE fin.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON fin.%I USING (workspace_id = fin.current_workspace()) '
      'WITH CHECK (workspace_id = fin.current_workspace())', table_name);
  END LOOP;
END
$$;

ALTER TABLE fin.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON fin.workspaces
  USING (id = fin.current_workspace()) WITH CHECK (id = fin.current_workspace());

ALTER TABLE fin.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY own_memberships ON fin.memberships
  USING (user_id = fin.current_user_id() OR workspace_id = fin.current_workspace())
  WITH CHECK (workspace_id = fin.current_workspace());

ALTER TABLE fin.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_audit_events ON fin.audit_events
  USING (workspace_id = fin.current_workspace()
         OR (workspace_id IS NULL AND user_id = fin.current_user_id()))
  WITH CHECK (workspace_id = fin.current_workspace()
              OR (workspace_id IS NULL AND user_id = fin.current_user_id()));
