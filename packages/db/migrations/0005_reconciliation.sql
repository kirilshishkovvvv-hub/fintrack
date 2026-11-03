-- 0005 · Reconciliation (FR-18, Stage 2 §5 and §7): statements, their items, and the lock.
-- Guarantees enforced here, independent of application code:
--   * a transaction in a completed reconciliation can't change its date, kind, status or
--     postings; only an unlock (which marks the reconciliation broken) releases it (AC-18.2)
--   * the one exception is a category merge: re-pointing a category line never changes an
--     account balance, so reconciled figures stay true (E-59)
--   * statements and their item lists are history: they can't be rewritten or deleted
-- Items are kept per transaction rather than per posting, because an edit replaces postings
-- (LR-10) and a broken reconciliation must still know which transactions it covered (GT-42).

ALTER TABLE fin.postings DROP COLUMN reconciliation_id;

CREATE TABLE fin.reconciliations (
  id                        uuid PRIMARY KEY,
  workspace_id              uuid NOT NULL REFERENCES fin.workspaces (id),
  account_id                uuid NOT NULL,
  statement_date            date NOT NULL,
  statement_balance_minor   bigint NOT NULL CHECK (statement_balance_minor BETWEEN -999999999999 AND 999999999999),
  status                    text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'broken', 'superseded')),
  adjustment_transaction_id uuid,
  completed_by              text NOT NULL,
  completed_at              timestamptz NOT NULL DEFAULT now(),
  unlocked_by               text,
  unlocked_at               timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id),
  FOREIGN KEY (workspace_id, adjustment_transaction_id) REFERENCES fin.transactions (workspace_id, id)
    ON DELETE SET NULL (adjustment_transaction_id),
  CHECK ((status = 'completed') = (unlocked_at IS NULL)),
  CHECK ((unlocked_at IS NULL) = (unlocked_by IS NULL))
);
CREATE INDEX reconciliations_account_idx ON fin.reconciliations (workspace_id, account_id, statement_date);

CREATE TABLE fin.reconciliation_items (
  reconciliation_id uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  transaction_id    uuid NOT NULL,
  PRIMARY KEY (reconciliation_id, transaction_id),
  FOREIGN KEY (workspace_id, reconciliation_id) REFERENCES fin.reconciliations (workspace_id, id),
  -- A transaction purged from the trash (only possible after an unlock) leaves the list.
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES fin.transactions (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX reconciliation_items_transaction_idx ON fin.reconciliation_items (transaction_id);

-- Statement facts never change; only the status moves forward (completed → broken → superseded).
CREATE FUNCTION fin.check_reconciliation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_id, NEW.statement_date, NEW.statement_balance_minor, NEW.adjustment_transaction_id,
      NEW.completed_by, NEW.completed_at)
     IS DISTINCT FROM
     (OLD.account_id, OLD.statement_date, OLD.statement_balance_minor, OLD.adjustment_transaction_id,
      OLD.completed_by, OLD.completed_at)
     AND NOT (NEW.adjustment_transaction_id IS NULL AND OLD.adjustment_transaction_id IS NOT NULL
              AND (NEW.account_id, NEW.statement_date, NEW.statement_balance_minor)
                  = (OLD.account_id, OLD.statement_date, OLD.statement_balance_minor)) THEN
    RAISE EXCEPTION 'a reconciliation''s statement can''t be rewritten' USING ERRCODE = '42501';
  END IF;
  IF NOT ((OLD.status = NEW.status)
          OR (OLD.status = 'completed' AND NEW.status = 'broken')
          OR (OLD.status = 'broken' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'a reconciliation can''t go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reconciliations_update BEFORE UPDATE ON fin.reconciliations
  FOR EACH ROW EXECUTE FUNCTION fin.check_reconciliation_update();
CREATE TRIGGER reconciliation_items_append_only BEFORE UPDATE OR DELETE ON fin.reconciliation_items
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION fin.forbid_change();

CREATE FUNCTION fin.is_reconciled(tx_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM fin.reconciliation_items i
      JOIN fin.reconciliations r ON r.id = i.reconciliation_id
     WHERE i.transaction_id = tx_id AND r.status = 'completed')
$$;

-- AC-18.2: the lock. SQLSTATE FTL01 is mapped to LOCKED_RECONCILED by the API.
CREATE FUNCTION fin.check_transaction_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The refund link isn't part of the lock: a purge may clear it (GAP-2) without changing any balance.
  IF (NEW.txn_date, NEW.kind, NEW.status) IS DISTINCT FROM (OLD.txn_date, OLD.kind, OLD.status)
     AND fin.is_reconciled(OLD.id) THEN
    RAISE EXCEPTION 'transaction % is reconciled and locked; unlock its reconciliation first (FR-18)', OLD.id
      USING ERRCODE = 'FTL01';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER transactions_lock BEFORE UPDATE ON fin.transactions
  FOR EACH ROW EXECUTE FUNCTION fin.check_transaction_lock();

CREATE FUNCTION fin.check_posting_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx_id uuid := COALESCE(OLD.transaction_id, NEW.transaction_id);
BEGIN
  IF NOT fin.is_reconciled(tx_id) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- A category merge: only a category line moves to another category (E-59).
  IF TG_OP = 'UPDATE'
     AND (NEW.transaction_id, NEW.amount_minor, NEW.txn_date, NEW.txn_status, NEW.line_no)
         = (OLD.transaction_id, OLD.amount_minor, OLD.txn_date, OLD.txn_status, OLD.line_no)
     AND EXISTS (SELECT 1 FROM fin.categories WHERE ledger_account_id = OLD.ledger_account_id)
     AND EXISTS (SELECT 1 FROM fin.categories WHERE ledger_account_id = NEW.ledger_account_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'transaction % is reconciled and locked; unlock its reconciliation first (FR-18)', tx_id
    USING ERRCODE = 'FTL01';
END
$$;
CREATE TRIGGER postings_lock BEFORE INSERT OR UPDATE OR DELETE ON fin.postings
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION fin.check_posting_lock();

GRANT SELECT, INSERT, UPDATE ON fin.reconciliations TO fin_app;
GRANT SELECT, INSERT ON fin.reconciliation_items TO fin_app;
GRANT EXECUTE ON FUNCTION fin.is_reconciled(uuid) TO fin_app;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['reconciliations', 'reconciliation_items'] LOOP
    EXECUTE format('ALTER TABLE fin.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE fin.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON fin.%I USING (workspace_id = fin.current_workspace()) '
      'WITH CHECK (workspace_id = fin.current_workspace())', table_name);
  END LOOP;
END
$$;
