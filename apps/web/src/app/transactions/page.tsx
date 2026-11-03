'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { TransactionRow } from '@/components/TransactionRow';
import { api } from '@/lib/api';
import { currentMonth, loadAccounts, loadCategories, loadSummary, useApiData, type Transaction } from '@/lib/use-api';

function monthRange(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const last = new Date(year, monthNumber, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export default function TransactionsPage() {
  const t = useTranslations('transactions');
  const tApp = useTranslations('app');
  const [month, setMonth] = useState(currentMonth().from.slice(0, 7));
  const [items, setItems] = useState<Transaction[] | null>(null);
  // Read by the loader, which also runs again after any change elsewhere on the page.
  const shownMonth = useRef(month);
  const { data } = useApiData(async () => {
    const [summary, accounts, categories] = await Promise.all([loadSummary(), loadAccounts(), loadCategories()]);
    const range = monthRange(shownMonth.current);
    setItems((await api<{ items: Transaction[] }>('GET', `/api/v1/transactions?from=${range.from}&to=${range.to}`)).items);
    return { currency: summary.currency, accounts, categories };
  });

  async function changeMonth(value: string) {
    shownMonth.current = value;
    setMonth(value);
    setItems(null);
    const range = monthRange(value);
    setItems((await api<{ items: Transaction[] }>('GET', `/api/v1/transactions?from=${range.from}&to=${range.to}`)).items);
  }

  const accounts = new Map((data?.accounts ?? []).map((account) => [account.id, account]));
  const categories = new Map((data?.categories ?? []).map((category) => [category.id, category]));

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <div className="field" style={{ maxWidth: 220, marginBottom: '1rem' }}>
        <label htmlFor="month">{t('month')}</label>
        <input id="month" type="month" value={month} onChange={(event) => void changeMonth(event.target.value)} />
      </div>
      <section className="card" aria-live="polite">
        {!data || !items ? (
          <p>{tApp('loading')}</p>
        ) : items.length === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          items.map((tx) => <TransactionRow key={tx.id} tx={tx} accounts={accounts} categories={categories} currency={data.currency} />)
        )}
      </section>
      <Link href="/trash" className="small">
        {t('trashLink')}
      </Link>
    </AppShell>
  );
}
