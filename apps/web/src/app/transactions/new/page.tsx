'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { TransactionForm, valuesFrom, type FormValues, type PayeeOption } from '@/components/TransactionForm';
import { useUndo } from '@/components/UndoToast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/money';
import { loadGoals } from '@/lib/plan';
import { active, loadAccounts, loadCategories, loadSummary, notifyDataChanged, todayLocal, useApiData, type Transaction, type TransactionDetail } from '@/lib/use-api';

/** Quick add (FR-04): amount first. Also opens as a copy of a transaction (BR-04.4) or a refund of one (FR-04). */
interface Suggestion {
  occurrenceId: string;
  name: string;
  dueDate: string;
  outsideExpectedRange: boolean;
}

function NewTransaction() {
  const [prompt, setPrompt] = useState<{ transactionId: string; suggestion: Suggestion } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const locale = useLocale();
  const tErrors = useTranslations('errors');
  const t = useTranslations('newTransaction');
  const tApp = useTranslations('app');
  const router = useRouter();
  const params = useSearchParams();
  const copyOf = params.get('copy');
  const refundOf = params.get('refundOf');
  const key = useRef(newIdempotencyKey());
  const offerUndo = useUndo();
  const { data, failed, reload } = useApiData(async () => {
    const [accounts, categories, summary, payees, goals, source] = await Promise.all([
      loadAccounts(),
      loadCategories(),
      loadSummary(),
      api<{ items: PayeeOption[] }>('GET', '/api/v1/payees').then((r) => r.items),
      loadGoals(),
      copyOf || refundOf ? api<TransactionDetail>('GET', `/api/v1/transactions/${copyOf ?? refundOf}`) : Promise.resolve(null),
    ]);
    const goalMoney = goals.filter((goal) => goal.status === 'active').flatMap((goal) => goal.allocations.map((row) => ({ goalId: goal.id, name: goal.name, accountId: row.accountId, amount_minor: row.amount_minor })));
    return { accounts, categories, currency: summary.currency, payees, goalMoney, source };
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
    const created = await api<Transaction & { suggestions?: Suggestion[] }>('POST', path, { idempotencyKey: key.current, body: body.kind === 'transfer' ? transfer : body });
    offerUndo(t('saved'), created.undo);
    // BR-08.10: it may be something already planned. The user decides (M-5).
    if (created.suggestions?.length) {
      setPrompt({ transactionId: created.id, suggestion: created.suggestions[0]! });
      return;
    }
    router.replace('/dashboard');
  }

  async function linkIt() {
    if (!prompt) return;
    setLinkError(null);
    try {
      await api('POST', `/api/v1/occurrences/${prompt.suggestion.occurrenceId}/link`, { idempotencyKey: newIdempotencyKey(), body: { transactionId: prompt.transactionId } });
      notifyDataChanged();
      router.replace('/dashboard');
    } catch (problem) {
      setLinkError(errorMessage(problem, tErrors));
    }
  }

  if (prompt) {
    return (
      <AppShell>
        <h1>{t('title')}</h1>
        <section className="card">
          <p>{t('matchPrompt', { name: prompt.suggestion.name, date: formatDay(prompt.suggestion.dueDate, locale) })}</p>
          {prompt.suggestion.outsideExpectedRange && <p className="small muted">{t('outsideRange')}</p>}
          {linkError && (
            <p className="notice notice-error" role="alert">
              {linkError}
            </p>
          )}
          <div className="actions">
            <button className="btn btn-primary" type="button" onClick={() => void linkIt()}>
              {t('matchLink')}
            </button>
            <button className="btn" type="button" onClick={() => router.replace('/dashboard')}>
              {t('matchKeep')}
            </button>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      {refundOf && data.source && <p className="small muted">{t('refundFor', { original: data.source.description ?? data.source.date })}</p>}
      <TransactionForm accounts={data.accounts} categories={data.categories} currency={data.currency} payees={data.payees} goalMoney={data.goalMoney} initial={initial} submitLabel={t('submit')} onSubmit={save} />
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
