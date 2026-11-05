-- 0010 · Budgets, recurring rules, planned occurrences and goals (FR-07 to FR-09, Stage 2 §5).
-- None of these post: planned items and allocations live apart from postings (LR-07, LR-08).
-- Guarantees enforced here, independent of application code:
--   * an occurrence is generated once per rule and date, and links to one transaction (BR-08.2, BR-08.4)
--   * "completed" means linked, and linked means completed
--   * payday rules are income rules with a payer (SC-2)
--   * budgets exist at parent or subcategory level, never both (BR-07.2)
--   * a threshold alert fires once per budget and month (AC-07.2)
--   * dedicated accounts and dedicated goals hold no allocations (G-D3)

CREATE TABLE fin.goals (
  id                         uuid PRIMARY KEY,
  workspace_id               uuid NOT NULL REFERENCES fin.workspaces (id),
  name                       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  funding_method             text NOT NULL CHECK (funding_method IN ('dedicated', 'virtual')),
  target_minor               bigint CHECK (target_minor > 0),
  target_date                date,
  monthly_contribution_minor bigint CHECK (monthly_contribution_minor >= 0),
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  version                    integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id)
);

ALTER TABLE fin.accounts
  ADD FOREIGN KEY (workspace_id, dedicated_goal_id) REFERENCES fin.goals (workspace_id, id);

CREATE TABLE fin.goal_allocations (
  goal_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, account_id),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES fin.goals (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id)
);
CREATE INDEX goal_allocations_account_idx ON fin.goal_allocations (workspace_id, account_id);

CREATE FUNCTION fin.check_allocation_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_minor > 0 AND (TG_OP = 'INSERT' OR NEW.amount_minor > OLD.amount_minor) THEN
    IF NOT EXISTS (SELECT 1 FROM fin.goals WHERE id = NEW.goal_id AND funding_method = 'virtual') THEN
      RAISE EXCEPTION 'a dedicated goal holds no allocations (G-1)' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM fin.accounts WHERE ledger_account_id = NEW.account_id
                AND (dedicated_goal_id IS NOT NULL OR account_class <> 'cash')) THEN
      RAISE EXCEPTION 'allocations are only for cash accounts not dedicated to a goal (G-D3, G-V1)' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER goal_allocations_target BEFORE INSERT OR UPDATE ON fin.goal_allocations
  FOR EACH ROW EXECUTE FUNCTION fin.check_allocation_target();

CREATE TABLE fin.allocation_events (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES fin.workspaces (id),
  goal_id        uuid NOT NULL,
  account_id     uuid NOT NULL,
  event          text NOT NULL CHECK (event IN ('create', 'increase', 'decrease', 'release', 'move', 'use_goal_money')),
  delta_minor    bigint NOT NULL,
  reason         text CHECK (length(reason) <= 200),
  -- Kept without a foreign key: the history outlives a purged transaction.
  transaction_id uuid,
  created_by     text NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES fin.goals (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id)
);
CREATE INDEX allocation_events_goal_idx ON fin.allocation_events (workspace_id, goal_id, occurred_at);
CREATE TRIGGER allocation_events_append_only BEFORE UPDATE OR DELETE ON fin.allocation_events
  FOR EACH ROW WHEN (current_user <> 'fin_maintenance') EXECUTE FUNCTION fin.forbid_change();

CREATE TABLE fin.recurring_rules (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES fin.workspaces (id),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind               text NOT NULL CHECK (kind IN ('expense', 'income', 'transfer', 'debt_payment')),
  amount_type        text NOT NULL DEFAULT 'fixed' CHECK (amount_type IN ('fixed', 'estimated')),
  -- Where the money leaves from; for income, where it arrives.
  account_id         uuid NOT NULL,
  -- 'once' is a one-off planned item: every occurrence has a rule holding its template.
  frequency          text NOT NULL CHECK (frequency IN ('once', 'weekly', 'every_n_weeks', 'monthly_day', 'monthly_last', 'every_n_months', 'yearly')),
  interval_n         integer NOT NULL DEFAULT 1 CHECK (interval_n >= 1),
  anchor_day         integer CHECK (anchor_day BETWEEN 1 AND 31),
  start_date         date NOT NULL,
  end_date           date,
  max_count          integer CHECK (max_count >= 1),
  non_working_day    text NOT NULL DEFAULT 'on_date' CHECK (non_working_day IN ('on_date', 'previous', 'next')),
  is_payday          boolean NOT NULL DEFAULT false,
  payer_payee_id     uuid,
  expected_min_minor bigint CHECK (expected_min_minor >= 0),
  expected_max_minor bigint CHECK (expected_max_minor >= 0),
  reminder_days      integer NOT NULL DEFAULT 0 CHECK (reminder_days >= 0),
  goal_id            uuid,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  generated_until    date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  CHECK (NOT is_payday OR (kind = 'income' AND payer_payee_id IS NOT NULL)),
  CHECK (end_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (workspace_id, account_id) REFERENCES fin.accounts (workspace_id, ledger_account_id),
  FOREIGN KEY (workspace_id, payer_payee_id) REFERENCES fin.payees (workspace_id, id),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES fin.goals (workspace_id, id)
);

-- The template: categories for expenses and income, the other account for a transfer, and
-- the liability plus categories for a debt payment. Amounts are positive; the funding side
-- is their sum, so a template can't be unbalanced.
CREATE TABLE fin.recurring_rule_lines (
  rule_id           uuid NOT NULL,
  line_no           integer NOT NULL,
  workspace_id      uuid NOT NULL,
  ledger_account_id uuid NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (rule_id, line_no),
  FOREIGN KEY (workspace_id, rule_id) REFERENCES fin.recurring_rules (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, ledger_account_id) REFERENCES fin.ledger_accounts (workspace_id, id)
);

CREATE TABLE fin.planned_occurrences (
  id                      uuid PRIMARY KEY,
  workspace_id            uuid NOT NULL REFERENCES fin.workspaces (id),
  rule_id                 uuid NOT NULL,
  original_date           date NOT NULL,
  due_date                date NOT NULL,
  amount_minor            bigint NOT NULL CHECK (amount_minor > 0),
  status                  text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'skipped', 'cancelled')),
  linked_transaction_id   uuid UNIQUE,
  -- What it was linked to before a void or trash, so a restore can link it again (GT-44).
  previous_transaction_id uuid,
  goal_id                 uuid,
  is_edited               boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  UNIQUE (rule_id, original_date),
  CHECK ((status = 'completed') = (linked_transaction_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, rule_id) REFERENCES fin.recurring_rules (workspace_id, id),
  FOREIGN KEY (workspace_id, linked_transaction_id) REFERENCES fin.transactions (workspace_id, id),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES fin.goals (workspace_id, id)
);
CREATE INDEX planned_occurrences_due_idx ON fin.planned_occurrences (workspace_id, status, due_date);

-- A null category is the optional overall monthly limit (BR-07.3).
CREATE TABLE fin.budget_limits (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES fin.workspaces (id),
  category_id     uuid,
  effective_month date NOT NULL CHECK (EXTRACT(DAY FROM effective_month) = 1),
  -- Null means no budget from this month on (BR-07.1).
  limit_minor     bigint CHECK (limit_minor >= 0),
  thresholds      smallint[] NOT NULL DEFAULT '{80,100}' CHECK (cardinality(thresholds) BETWEEN 1 AND 3),
  FOREIGN KEY (workspace_id, category_id) REFERENCES fin.categories (workspace_id, ledger_account_id)
);
CREATE UNIQUE INDEX budget_limits_category_idx ON fin.budget_limits (workspace_id, category_id, effective_month) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX budget_limits_overall_idx ON fin.budget_limits (workspace_id, effective_month) WHERE category_id IS NULL;

-- BR-07.2. SQLSTATE FTL02 is mapped to BUDGET_BRANCH_CONFLICT by the API.
CREATE FUNCTION fin.check_budget_branch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent uuid;
BEGIN
  IF NEW.limit_minor IS NULL OR NEW.category_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT parent_id INTO parent FROM fin.categories WHERE ledger_account_id = NEW.category_id;
  IF EXISTS (
    SELECT 1 FROM fin.categories relative
     WHERE relative.workspace_id = NEW.workspace_id
       AND (relative.ledger_account_id = parent OR relative.parent_id = NEW.category_id)
       AND ((SELECT b.limit_minor FROM fin.budget_limits b
              WHERE b.workspace_id = NEW.workspace_id AND b.category_id = relative.ledger_account_id
                AND b.effective_month <= NEW.effective_month
              ORDER BY b.effective_month DESC LIMIT 1) IS NOT NULL
            OR EXISTS (SELECT 1 FROM fin.budget_limits b
                        WHERE b.workspace_id = NEW.workspace_id AND b.category_id = relative.ledger_account_id
                          AND b.effective_month > NEW.effective_month AND b.limit_minor IS NOT NULL))) THEN
    RAISE EXCEPTION 'a branch has budgets at parent or subcategory level, never both (BR-07.2)' USING ERRCODE = 'FTL02';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER budget_limits_branch BEFORE INSERT OR UPDATE ON fin.budget_limits
  FOR EACH ROW EXECUTE FUNCTION fin.check_budget_branch();

CREATE TABLE fin.budget_alert_events (
  workspace_id uuid NOT NULL REFERENCES fin.workspaces (id),
  category_id  uuid NOT NULL,
  month        date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  threshold    smallint NOT NULL,
  fired_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category_id, month, threshold),
  FOREIGN KEY (workspace_id, category_id) REFERENCES fin.categories (workspace_id, ledger_account_id)
);

-- An accepted match from an import review to a planned item (BR-16.10, GT-37).
ALTER TABLE fin.import_rows ADD COLUMN planned_occurrence_id uuid;
ALTER TABLE fin.import_rows
  ADD FOREIGN KEY (workspace_id, planned_occurrence_id) REFERENCES fin.planned_occurrences (workspace_id, id);

GRANT SELECT, INSERT, UPDATE ON fin.goals, fin.goal_allocations, fin.recurring_rules, fin.planned_occurrences TO fin_app;
GRANT SELECT, INSERT, DELETE ON fin.recurring_rule_lines, fin.budget_limits TO fin_app;
GRANT UPDATE ON fin.budget_limits TO fin_app;
GRANT SELECT, INSERT ON fin.allocation_events, fin.budget_alert_events TO fin_app;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goals', 'goal_allocations', 'allocation_events', 'recurring_rules', 'recurring_rule_lines',
    'planned_occurrences', 'budget_limits', 'budget_alert_events'
  ] LOOP
    EXECUTE format('ALTER TABLE fin.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE fin.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON fin.%I USING (workspace_id = fin.current_workspace()) '
      'WITH CHECK (workspace_id = fin.current_workspace())', table_name);
    EXECUTE format('GRANT SELECT, DELETE ON fin.%I TO fin_maintenance', table_name);
  END LOOP;
END
$$;
