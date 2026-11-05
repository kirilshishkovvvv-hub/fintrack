/**
 * Short-term cash-flow projection (FR-13, a Should; I-12, ER-4). Two lines over the spendable
 * accounts: commitments only, and with expected income. Card purchases don't reduce it directly:
 * a reserved card's balance comes off on its scheduled repayment, or on day 0 if there's none.
 */
import { addDays, type IsoDate } from './dates.ts';
import type { Ledger } from './metrics.ts';
import type { Cents } from './money.ts';
import type { PlannedItem } from './planning.ts';

export interface ProjectionDay {
  date: IsoDate;
  commitmentsOnly: Cents;
  withIncome: Cents;
}

export interface Projection {
  days: ProjectionDay[];
  lowest: { date: IsoDate; amount: Cents };
}

export function projection(input: { ledger: Ledger; today: IsoDate; days: number; planned: readonly PlannedItem[]; countSavingsTransfers?: boolean }): Projection {
  const { ledger, today, planned } = input;
  const chart = ledger.chart;
  const spendable = (id: string | null) => {
    const account = id ? chart.find(id) : undefined;
    return Boolean(account?.account && !account.archived && account.account.class === 'cash' && account.account.spendable);
  };
  const reservedCard = (id: string | null) => {
    const account = id ? chart.find(id) : undefined;
    return Boolean(account?.account && !account.archived && account.account.type === 'card' && account.account.cardReserve);
  };

  let start = 0;
  for (const account of chart.all()) if (spendable(account.id)) start += ledger.balance(account.id, today);

  const outflow = (item: PlannedItem) => {
    if (item.kind === 'income' || !spendable(item.fromAccountId) || spendable(item.toAccountId)) return false;
    const to = item.toAccountId ? chart.find(item.toAccountId) : undefined;
    if (item.kind === 'transfer' && to?.account?.class === 'cash' && input.countSavingsTransfers === false) return false;
    return true;
  };

  // A reserved card with no scheduled repayment comes off on day 0; with one, on that date.
  for (const account of chart.all()) {
    if (!reservedCard(account.id)) continue;
    const scheduled = planned.some((item) => item.toAccountId === account.id && outflow(item));
    if (!scheduled) start -= Math.max(0, ledger.balance(account.id, today));
  }

  const days: ProjectionDay[] = [];
  let commitments = start;
  let income = 0;
  for (let offset = 0; offset < input.days; offset += 1) {
    const date = addDays(today, offset);
    for (const item of planned) {
      // Overdue outflows land on day 0; overdue income isn't counted on.
      const landsToday = item.dueDate === date || (offset === 0 && item.dueDate < today);
      if (!landsToday) continue;
      if (outflow(item)) commitments -= item.amount;
      else if (item.kind === 'income' && item.dueDate >= today && spendable(item.toAccountId)) income += item.amount;
    }
    days.push({ date, commitmentsOnly: commitments, withIncome: commitments + income });
  }
  const low = days.reduce((lowest, day) => (day.commitmentsOnly < lowest.commitmentsOnly ? day : lowest), days[0]!);
  return { days, lowest: { date: low.date, amount: low.commitmentsOnly } };
}
