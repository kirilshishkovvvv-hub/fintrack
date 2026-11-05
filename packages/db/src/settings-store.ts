/** What the user can change about accounts, categories and the workspace (FR-03, FR-05). Figures are never stored here. */
import type { Db } from './context.ts';

export interface AccountDetails {
  institution: string | null;
  creditLimit: number | null;
  notes: string | null;
  loanPrincipal: number | null;
  loanRateBp: number | null;
  loanInstallment: number | null;
  loanTermMonths: number | null;
  dedicatedGoalId: string | null;
  sortOrder: number;
  version: number;
}

export async function accountDetails(db: Db, workspaceId: string): Promise<Map<string, AccountDetails>> {
  const result = await db.query<{
    id: string;
    institution_label: string | null;
    credit_limit_minor: string | null;
    notes: string | null;
    loan_principal_minor: string | null;
    loan_rate_bp: number | null;
    loan_installment_minor: string | null;
    loan_term_months: number | null;
    dedicated_goal_id: string | null;
    sort_order: number;
    version: number;
  }>(
    `SELECT a.ledger_account_id AS id, a.institution_label, a.credit_limit_minor::text, a.notes, a.loan_principal_minor::text, a.loan_rate_bp, a.loan_installment_minor::text, a.loan_term_months, a.dedicated_goal_id, a.sort_order, la.version
       FROM fin.accounts a JOIN fin.ledger_accounts la ON la.id = a.ledger_account_id
      WHERE a.workspace_id = $1 AND la.workspace_id = $1`,
    [workspaceId],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        institution: row.institution_label,
        creditLimit: row.credit_limit_minor === null ? null : Number(row.credit_limit_minor),
        notes: row.notes,
        loanPrincipal: row.loan_principal_minor === null ? null : Number(row.loan_principal_minor),
        loanRateBp: row.loan_rate_bp,
        loanInstallment: row.loan_installment_minor === null ? null : Number(row.loan_installment_minor),
        loanTermMonths: row.loan_term_months,
        dedicatedGoalId: row.dedicated_goal_id,
        sortOrder: row.sort_order,
        version: row.version,
      },
    ]),
  );
}

/** Takes the version the caller read; returns the new one, or null if the row changed meanwhile. */
export async function bumpLedgerAccount(db: Db, workspaceId: string, id: string, expectedVersion: number, name?: string): Promise<number | null> {
  const result = await db.query<{ version: number }>(
    `UPDATE fin.ledger_accounts SET name = COALESCE($4, name), version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $3
      RETURNING version`,
    [workspaceId, id, expectedVersion, name ?? null],
  );
  return result.rows[0]?.version ?? null;
}

export async function updateAccountFields(
  db: Db,
  workspaceId: string,
  id: string,
  fields: { type: string; spendable: boolean; cardReserve: boolean; institution: string | null; creditLimit: number | null; notes: string | null; loanPrincipal: number | null; loanRateBp: number | null; loanInstallment: number | null; loanTermMonths: number | null },
): Promise<void> {
  await db.query(
    `UPDATE fin.accounts
        SET account_type = $3, spendable = $4, card_reserve = $5, institution_label = $6, credit_limit_minor = $7, notes = $8,
            loan_principal_minor = $9, loan_rate_bp = $10, loan_installment_minor = $11, loan_term_months = $12
      WHERE workspace_id = $1 AND ledger_account_id = $2`,
    [workspaceId, id, fields.type, fields.spendable, fields.cardReserve, fields.institution, fields.creditLimit, fields.notes, fields.loanPrincipal, fields.loanRateBp, fields.loanInstallment, fields.loanTermMonths],
  );
}

export async function setOpeningDate(db: Db, workspaceId: string, id: string, date: string): Promise<void> {
  await db.query('UPDATE fin.accounts SET opening_date = $3 WHERE workspace_id = $1 AND ledger_account_id = $2', [workspaceId, id, date]);
}

export async function categoryMeta(db: Db, workspaceId: string): Promise<Map<string, { sortOrder: number; version: number }>> {
  const result = await db.query<{ id: string; sort_order: number; version: number }>(
    `SELECT c.ledger_account_id AS id, c.sort_order, la.version
       FROM fin.categories c JOIN fin.ledger_accounts la ON la.id = c.ledger_account_id
      WHERE c.workspace_id = $1 AND la.workspace_id = $1`,
    [workspaceId],
  );
  return new Map(result.rows.map((row) => [row.id, { sortOrder: row.sort_order, version: row.version }]));
}

export async function setCategoryParent(db: Db, workspaceId: string, id: string, parentId: string | null): Promise<void> {
  await db.query('UPDATE fin.categories SET parent_id = $3 WHERE workspace_id = $1 AND ledger_account_id = $2', [workspaceId, id, parentId]);
}

/** Display order is the position in the list. It isn't content, so no version changes. */
export async function setDisplayOrder(db: Db, workspaceId: string, table: 'accounts' | 'categories', ids: readonly string[]): Promise<number> {
  const name = table === 'accounts' ? 'fin.accounts' : 'fin.categories';
  const result = await db.query(
    `UPDATE ${name} t SET sort_order = x.position
       FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, position)
      WHERE t.workspace_id = $1 AND t.ledger_account_id = x.id`,
    [workspaceId, ids],
  );
  return result.rowCount ?? 0;
}

export async function hasTransactions(db: Db, workspaceId: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM fin.transactions WHERE workspace_id = $1 LIMIT 1', [workspaceId]);
  return (result.rowCount ?? 0) > 0;
}

export async function updateWorkspaceSettings(
  db: Db,
  workspaceId: string,
  change: { name?: string | undefined; timezone?: string | undefined; protectedReserveMinor?: number | undefined; stsCountSavingsTransfers?: boolean | undefined; currency?: string | undefined; expectedVersion: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE fin.workspaces
        SET name = COALESCE($2, name),
            timezone = COALESCE($3, timezone),
            protected_reserve_minor = COALESCE($4, protected_reserve_minor),
            sts_count_savings_transfers = COALESCE($5, sts_count_savings_transfers),
            currency = COALESCE($6, currency),
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $7`,
    [workspaceId, change.name ?? null, change.timezone ?? null, change.protectedReserveMinor ?? null, change.stsCountSavingsTransfers ?? null, change.currency ?? null, change.expectedVersion],
  );
  return result.rowCount === 1;
}
