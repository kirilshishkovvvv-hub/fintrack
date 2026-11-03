'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { useUndo } from '@/components/UndoToast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { active, loadAccounts, loadCategories, todayLocal, useApiData, type Category, type Transaction } from '@/lib/use-api';

type Kind = 'expense' | 'income' | 'transfer';

/** Quick add (FR-04): amount first, then account, category and date (today by default). */
export default function NewTransactionPage() {
  const t = useTranslations('newTransaction');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('expense');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const offerUndo = useUndo();
  const { data } = useApiData(async () => ({ accounts: await loadAccounts(), categories: await loadCategories() }));

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

  const categories = active(data.categories).filter((category) => category.kind === (kind === 'income' ? 'income' : 'expense'));
  const label = (category: Category) => {
    const parent = category.parentId ? data.categories.find((candidate) => candidate.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = parseUserAmount(String(form.get('amount') ?? ''));
    if (amount === null || amount <= 0) return setError(tErrors('invalidAmount'));
    const date = String(form.get('date'));
    const description = String(form.get('description') ?? '').trim() || undefined;
    setBusy(true);
    setError(null);
    try {
      const created =
        kind === 'transfer'
          ? await api<Transaction>('POST', '/api/v1/transfers', {
              idempotencyKey: key.current,
              body: { date, fromAccountId: form.get('from'), toAccountId: form.get('to'), amount_minor: amount, description },
            })
          : await api<Transaction>('POST', '/api/v1/transactions', {
              idempotencyKey: key.current,
              body: { kind, date, accountId: form.get('account'), lines: [{ categoryId: form.get('category'), amount_minor: amount }], description },
            });
      offerUndo(t('saved'), created.undo);
      router.replace('/dashboard');
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      setBusy(false);
    }
  }

  const accountOptions = active(data.accounts).map((account) => (
    <option key={account.id} value={account.id}>
      {account.name}
    </option>
  ));

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <form className="card" onSubmit={submit}>
        <div className="segmented" role="radiogroup" aria-label={t('title')}>
          {(['expense', 'income', 'transfer'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} /> {t(value)}
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor="amount">{t('amount')}</label>
          <input id="amount" name="amount" type="text" inputMode="decimal" placeholder="0.00" className="amount-input" required autoFocus />
        </div>
        {kind === 'transfer' ? (
          <div className="grid-2">
            <div className="field">
              <label htmlFor="from">{t('from')}</label>
              <select id="from" name="from" required>
                {accountOptions}
              </select>
            </div>
            <div className="field">
              <label htmlFor="to">{t('to')}</label>
              <select id="to" name="to" required defaultValue={active(data.accounts)[1]?.id}>
                {accountOptions}
              </select>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="account">{t('account')}</label>
              <select id="account" name="account" required>
                {accountOptions}
              </select>
            </div>
            <div className="field">
              <label htmlFor="category">{t('category')}</label>
              <select id="category" name="category" required>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {label(category)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="date">{t('date')}</label>
          <input id="date" name="date" type="date" defaultValue={todayLocal()} max={todayLocal()} required />
        </div>
        <div className="field">
          <label htmlFor="description">{t('description')}</label>
          <input id="description" name="description" type="text" maxLength={500} />
        </div>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {t('submit')}
        </button>
      </form>
    </AppShell>
  );
}
