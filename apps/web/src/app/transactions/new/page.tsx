'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { TransactionForm, valuesFrom, type FormValues } from '@/components/TransactionForm';
import { useUndo } from '@/components/UndoToast';
import { api, newIdempotencyKey } from '@/lib/api';
import { active, loadAccounts, loadCategories, loadSummary, todayLocal, useApiData, type Transaction, type TransactionDetail } from '@/lib/use-api';

/** Quick add (FR-04): amount first. Also opens as a copy of a transaction (BR-04.4) or a refund of one (FR-04). */
function NewTransaction() {
  const t = useTranslations('newTransaction');
  const tApp = useTranslations('app');
  const router = useRouter();
  const params = useSearchParams();
  const copyOf = params.get('copy');
  const refundOf = params.get('refundOf');
  const key = useRef(newIdempotencyKey());
  const offerUndo = useUndo();
  const { data, failed, reload } = useApiData(async () => {
    const [accounts, categories, summary, source] = await Promise.all([
      loadAccounts(),
      loadCategories(),
      loadSummary(),
      copyOf || refundOf ? api<TransactionDetail>('GET', `/api/v1/transactions/${copyOf ?? refundOf}`) : Promise.resolve(null),
    ]);
    return { accounts, categories, currency: summary.currency, source };
  });
  if (failed) return <LoadError retry={reload} />;
  if (!data) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }
  if (active(data.accounts).length === 0) {
    return (
      <AppShell>
        <p className="notice notice-info">
          {t('needAccount')} <Link href="/accounts/new">{t('account')}</Link>
        </p>
      </AppShell>
    );
  }

  const accounts = new Map(data.accounts.map((account) => [account.id, account]));
  const categories = new Map(data.categories.map((category) => [category.id, category]));
  let initial: Partial<FormValues> | undefined;
  if (data.source) {
    const values = valuesFrom(data.source, accounts, categories);
    if (values && copyOf) initial = { ...values, date: todayLocal(), refundOfId: null };
    if (values && refundOf) {
      // A refund reverses the original's categories, into the same account, dated today (BR-04.8).
      const lines = values.lines.map((line) => ({ ...line, amount: line.amount.replace('-', '') }));
      initial = { ...values, kind: 'refund', lines, date: todayLocal(), refundOfId: data.source.id };
    }
  }

  async function save(body: Record<string, unknown>) {
    const path = body.kind === 'transfer' ? '/api/v1/transfers' : '/api/v1/transactions';
    const { kind: _kind, ...transfer } = body;
    const created = await api<Transaction>('POST', path, { idempotencyKey: key.current, body: body.kind === 'transfer' ? transfer : body });
    offerUndo(t('saved'), created.undo);
    router.replace('/dashboard');
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      {refundOf && data.source && <p className="small muted">{t('refundFor', { original: data.source.description ?? data.source.date })}</p>}
      <TransactionForm accounts={data.accounts} categories={data.categories} currency={data.currency} initial={initial} submitLabel={t('submit')} onSubmit={save} />
    </AppShell>
  );
}

export default function NewTransactionPage() {
  return (
    <Suspense>
      <NewTransaction />
    </Suspense>
  );
}
