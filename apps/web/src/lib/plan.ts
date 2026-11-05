/** The shapes the planning screens read. Every figure comes from the server (Stage 2 §4.1). */
import { api } from './api';

export interface PlannedLine {
  occurrenceId: string;
  name: string;
  kind: string;
  dueDate: string;
  amount_minor: number;
  accountId: string | null;
}

export interface SafeToSpend {
  value_minor: number;
  eligibleFunds_minor: number;
  cardReserve_minor: number;
  protectedReserve_minor: number;
  uco_minor: number;
  uga_minor: number;
  perDay_minor: number | null;
  window: { kind: 'payday' | 'fallback'; from: string; to: string; payday: string | null; days: number };
  elfItems: { accountId: string; name: string; amount_minor: number }[];
  ucoItems: { type: 'planned' | 'overdue' | 'card_expense' | 'card_reserve'; name: string; amount_minor: number; dueDate?: string; coveredByGoal_minor?: number }[];
  ugaItems: { type: 'allocation' | 'shortfall'; name: string; amount_minor: number }[];
  dueOnPayday: PlannedLine[];
  latePayday: PlannedLine[];
  expectedIncome: PlannedLine[];
  possibleDoubleCounts: (PlannedLine & { transactionId: string })[];
  availableCredit_minor: number;
  excludedAccounts: { accountId: string; name: string; amount_minor: number }[];
  lastImportAt: string | null;
}

export interface Occurrence {
  id: string;
  ruleId: string;
  name: string;
  kind: 'expense' | 'income' | 'transfer' | 'debt_payment';
  frequency: string;
  amountType: 'fixed' | 'estimated';
  accountId: string;
  toAccountId: string | null;
  originalDate: string;
  dueDate: string;
  amount_minor: number;
  status: string;
  overdue: boolean;
  isPayday: boolean;
  goalId: string | null;
  isEdited: boolean;
  linkedTransactionId: string | null;
  version: number;
  lines: { categoryId: string; amount_minor: number }[];
}

export interface Rule {
  id: string;
  name: string;
  kind: 'expense' | 'income' | 'transfer' | 'debt_payment';
  amountType: 'fixed' | 'estimated';
  accountId: string;
  frequency: string;
  interval: number;
  anchorDay: number | null;
  startDate: string;
  endDate: string | null;
  nonWorkingDay: 'on_date' | 'previous' | 'next';
  isPayday: boolean;
  payer: string | null;
  expectedMin_minor: number | null;
  expectedMax_minor: number | null;
  reminderDays: number;
  goalId: string | null;
  status: 'active' | 'ended';
  version: number;
  lines: { ledgerAccountId: string; amount_minor: number }[];
  amount_minor: number;
  nextDue: string | null;
  overdue: number;
}

export interface Goal {
  id: string;
  name: string;
  funding: 'dedicated' | 'virtual';
  target_minor: number | null;
  targetDate: string | null;
  monthly_minor: number | null;
  status: 'active' | 'archived';
  state: 'active' | 'reached' | 'used' | 'archived';
  version: number;
  allocated_minor: number;
  backed_minor: number;
  shortfall_minor: number;
  progress_minor: number;
  used_minor: number;
  allocations: { accountId: string; name: string; amount_minor: number; backed_minor: number }[];
  accounts: { accountId: string; name: string; balance_minor: number }[];
  projection: { remaining: number; reached: boolean; monthsNeeded: number | null; estimatedCompletion: string | null; requiredMonthly: number | null; behindSchedule: boolean } | null;
  payments: { occurrenceId: string; name: string; dueDate: string; amount_minor: number; covered_minor: number }[];
}

export const loadGoals = () => api<{ items: Goal[] }>('GET', '/api/v1/goals').then((r) => r.items);
export const loadRules = () => api<{ items: Rule[] }>('GET', '/api/v1/rules').then((r) => r.items);
export const loadOccurrences = (query = '') => api<{ items: Occurrence[] }>('GET', `/api/v1/occurrences${query}`).then((r) => r.items);
