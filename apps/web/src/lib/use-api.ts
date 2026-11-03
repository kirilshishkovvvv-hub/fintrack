'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from './api';

export interface Account {
  id: string;
  name: string;
  type: string;
  class: string;
  spendable: boolean;
  cardReserve: boolean;
  archived: boolean;
  balance_minor: number;
}

export interface Category {
  id: string;
  name: string;
  kind: 'income' | 'expense';
  parentId: string | null;
  archived: boolean;
}

/** A finished reconciliation, with its figures as the ledger stands now (FR-18). */
export interface Reconciliation {
  id: string;
  accountId: string;
  statementDate: string;
  status: 'completed' | 'broken' | 'superseded';
  adjustmentTransactionId: string | null;
  completedAt: string;
  unlockedAt: string | null;
  transactionIds: string[];
  cleared_minor: number;
  statement_minor: number;
  difference_minor: number;
}

/** Accounts and categories that can still receive postings (LR-14): archived ones leave the pickers. */
export const active = <T extends { archived: boolean }>(items: T[]) => items.filter((item) => !item.archived);

export interface TransactionLine {
  ledgerAccountId: string;
  amount_minor: number;
  mark?: string | null;
}

export interface Transaction {
  id: string;
  date: string;
  kind: string;
  status: 'posted' | 'voided' | 'trashed';
  /** In a completed reconciliation, and so locked (FR-18). */
  reconciled: boolean;
  version: number;
  description: string | null;
  memo: string | null;
  trashedAt: string | null;
  lines: TransactionLine[];
  /** Present on the response to an action that can be undone for a few seconds (GAP-4). */
  undo?: { token: string; expiresInSeconds: number };
}

/** A status change stores only the status; a create or edit stores the whole transaction. */
export interface VersionSnapshot {
  status: string;
  kind?: string;
  date?: string;
  lines?: TransactionLine[];
}

export interface TransactionDetail extends Transaction {
  versions: {
    version: number;
    changeType: 'create' | 'edit' | 'void' | 'restore' | 'trash' | 'unlock';
    changedAt: string;
    before: VersionSnapshot | null;
    after: VersionSnapshot | null;
  }[];
}

/** Fired after any change, so every page on screen reloads its server figures. */
const DATA_CHANGED = 'fintrack:data-changed';

export function notifyDataChanged(): void {
  window.dispatchEvent(new Event(DATA_CHANGED));
}

export interface Summary {
  at: string;
  currency: 'EUR' | 'USD';
  netWorth_minor: number;
  safeToSpend: { value_minor: number; eligibleFunds_minor: number; cardReserve_minor: number; protectedReserve_minor: number };
}

/**
 * Loads data for a signed-in page. Sends the user to sign in (401) or to onboarding
 * (no workspace yet) instead of showing an error.
 */
export function useApiData<T>(load: () => Promise<T>) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      setFailed(false);
      setData(await load());
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.status === 401) return router.replace('/sign-in');
      if (problem instanceof ApiProblem && problem.code === 'NO_WORKSPACE') return router.replace('/onboarding');
      setFailed(true);
    }
    // `load` is defined inline by callers; reloading only on mount is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener(DATA_CHANGED, onChange);
    return () => window.removeEventListener(DATA_CHANGED, onChange);
  }, [reload]);

  return { data, failed, reload };
}

export const loadAccounts = () => api<{ items: Account[] }>('GET', '/api/v1/accounts').then((r) => r.items);
export const loadCategories = () => api<{ items: Category[] }>('GET', '/api/v1/categories').then((r) => r.items);
export const loadSummary = () => api<Summary>('GET', '/api/v1/summary');

export function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const last = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

export function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
