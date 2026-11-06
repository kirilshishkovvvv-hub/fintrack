/** Fires any threshold just crossed, reading only the month it can have changed (AC-07.2, NFR-03). */
import { Ledger, monthRange, type Chart } from '@fintrack/domain';
import { loadLedgerTotals, type Db, type RequestContext } from '@fintrack/db';
import { evaluateBudgetAlerts } from './budgets.ts';

export async function alertsForMonth(db: Db, context: RequestContext, chart: Chart, month: string): Promise<void> {
  await evaluateBudgetAlerts(db, context, new Ledger(chart, await loadLedgerTotals(db, context.workspaceId, monthRange(month))), month);
}
