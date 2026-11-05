'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { editableAmount } from '@/components/TransactionForm';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay, formatMoney, parseUserAmount } from '@/lib/money';
import { loadOccurrences, type Occurrence } from '@/lib/plan';
import { active, loadAccounts, loadSummary, notifyDataChanged, todayLocal, useApiData, type Transaction } from '@/lib/use-api';

/** Older than this, overdue items are collapsed into a group (FR-11). */
const OLD_DAYS = 90;

/** Upcoming: what's overdue, then the next 30 days, each with confirm, match and skip (FR-11, BR-08.5). */
export default function PlanPage() {
  const t = useTranslations('plan');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [acting, setActing] = useState<{ id: string; mode: 'confirm' | 'match' } | null>(null);
  const [candidates, setCandidates] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, failed, reload } = useApiData(async () => {
    const [occurrences, accounts, summary] = await Promise.all([loadOccurrences(), loadAccounts(), loadSummary()]);
    return { occurrences, accounts: active(accounts), currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  const money = (minor: number) => formatMoney(minor, data?.currency ?? 'EUR', locale);
  const nameOf = (id: string | null) => data?.accounts.find((account) => account.id === id)?.name ?? '';

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      setActing(null);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  function confirm(event: React.FormEvent<HTMLFormElement>, item: Occurrence) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = parseUserAmount(String(form.get('amount') ?? ''));
    if (amount === null || amount <= 0) return setError(t('badAmount'));
    const changed = amount !== item.amount_minor;
    void run(
      () => api('POST', `/api/v1/occurrences/${item.id}/confirm`, { idempotencyKey: newIdempotencyKey(), body: { date: String(form.get('date')), ...(changed ? { amount_minor: amount } : {}) } }),
      t('confirmed', { name: item.name }),
    );
  }

  async function openMatch(item: Occurrence) {
    setActing({ id: item.id, mode: 'match' });
    setCandidates(null);
    const shift = (days: number) => new Date(Date.parse(`${item.dueDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const to = shift(10) > todayLocal() ? todayLocal() : shift(10);
    const found = await api<{ items: Transaction[] }>('GET', `/api/v1/transactions?accountId=${item.accountId}&from=${shift(-10)}&to=${to}&limit=50`);
    setCandidates(found.items.filter((tx) => tx.status === 'posted' && tx.kind !== 'opening_balance'));
  }

  const match = (event: React.FormEvent<HTMLFormElement>, item: Occurrence) => {
    event.preventDefault();
    const transactionId = String(new FormData(event.currentTarget).get('transactionId'));
    void run(() => api('POST', `/api/v1/occurrences/${item.id}/link`, { idempotencyKey: newIdempotencyKey(), body: { transactionId } }), t('linked', { name: item.name }));
  };

  const skip = (item: Occurrence) => run(() => api('POST', `/api/v1/occurrences/${item.id}/skip`, { idempotencyKey: newIdempotencyKey() }), t('skipped', { name: item.name }));

  const row = (item: Occurrence) => (
    <div className="import-row" key={item.id}>
      <div className="row" style={{ borderTop: 0 }}>
        <div className="row-main">
          <div className="row-title">
            {item.name}
            {item.overdue && <span className="badge">{t('overdue')}</span>}
            {item.isPayday && <span className="badge">{t('payday')}</span>}
            {item.amountType === 'estimated' && <span className="badge">{t('estimate')}</span>}
          </div>
          <div className="small muted">
            {formatDay(item.dueDate, locale)} · {nameOf(item.accountId)}
            {item.toAccountId ? ` → ${nameOf(item.toAccountId)}` : ''}
          </div>
        </div>
        <span className="amount">
          {item.kind === 'income' ? '+' : '−'}
          {money(item.amount_minor)}
        </span>
      </div>
      <div className="actions">
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('confirmNamed', { name: item.name })} onClick={() => setActing({ id: item.id, mode: 'confirm' })}>
          {t('confirm')}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('matchNamed', { name: item.name })} onClick={() => void openMatch(item)}>
          {t('match')}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('skipNamed', { name: item.name })} onClick={() => void skip(item)}>
          {t('skip')}
        </button>
        <Link className="btn btn-ghost" href={`/plan/rules/${item.ruleId}`} aria-label={t('editNamed', { name: item.name })}>
          {t('edit')}
        </Link>
      </div>
      {acting?.id === item.id && acting.mode === 'confirm' && (
        <form onSubmit={(event) => confirm(event, item)}>
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`amount-${item.id}`}>{t('actualAmount')}</label>
              <input id={`amount-${item.id}`} name="amount" type="text" inputMode="decimal" defaultValue={editableAmount(item.amount_minor)} required />
            </div>
            <div className="field">
              <label htmlFor={`date-${item.id}`}>{t('actualDate')}</label>
              <input id={`date-${item.id}`} name="date" type="date" max={todayLocal()} defaultValue={item.dueDate > todayLocal() ? todayLocal() : item.dueDate} required />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('confirmSave')}
            </button>
            <button className="btn" type="button" onClick={() => setActing(null)}>
              {tApp('cancel')}
            </button>
          </div>
        </form>
      )}
      {acting?.id === item.id && acting.mode === 'match' && (
        <form onSubmit={(event) => match(event, item)}>
          {!candidates ? (
            <p className="small muted">{tApp('loading')}</p>
          ) : candidates.length === 0 ? (
            <p className="small muted">{t('noCandidates')}</p>
          ) : (
            <div className="field">
              <label htmlFor={`match-${item.id}`}>{t('matchWith')}</label>
              <select id={`match-${item.id}`} name="transactionId">
                {candidates.map((tx) => (
                  <option key={tx.id} value={tx.id}>
                    {formatDay(tx.date, locale)} · {tx.description ?? tx.payee ?? t(`kinds.${tx.kind === 'debt_payment' || tx.kind === 'transfer' || tx.kind === 'income' ? tx.kind : 'expense'}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="actions">
            {candidates && candidates.length > 0 && (
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {t('linkSave')}
              </button>
            )}
            <button className="btn" type="button" onClick={() => setActing(null)}>
              {tApp('cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );

  const today = todayLocal();
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - OLD_DAYS * 86_400_000).toISOString().slice(0, 10);
  const overdue = data?.occurrences.filter((item) => item.overdue) ?? [];
  const old = overdue.filter((item) => item.dueDate < cutoff);
  const recent = overdue.filter((item) => item.dueDate >= cutoff);
  const coming = data?.occurrences.filter((item) => !item.overdue) ?? [];

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <div className="actions" style={{ marginBottom: '1rem' }}>
        <Link href="/plan/rules/new" className="btn btn-primary">
          {t('add')}
        </Link>
        <Link href="/plan/rules" className="btn">
          {t('rules')}
        </Link>
        <Link href="/budgets" className="btn">
          {t('budgets')}
        </Link>
        <Link href="/goals" className="btn">
          {t('goals')}
        </Link>
        <Link href="/debts" className="btn">
          {t('debts')}
        </Link>
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-info" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : (
        <>
          {overdue.length > 0 && (
            <section className="card" aria-labelledby="overdue-title">
              <h2 id="overdue-title">{t('overdueTitle')}</h2>
              {recent.map(row)}
              {old.length > 0 && (
                <details>
                  <summary>{t('olderOverdue', { count: old.length })}</summary>
                  {old.map(row)}
                </details>
              )}
            </section>
          )}
          <section className="card" aria-labelledby="coming-title">
            <h2 id="coming-title">{t('comingTitle')}</h2>
            {coming.length === 0 ? <p className="muted">{t('nothingComing')}</p> : coming.map(row)}
          </section>
        </>
      )}
    </AppShell>
  );
}
