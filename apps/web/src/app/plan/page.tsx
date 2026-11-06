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
/** ER-5: older than this, an overdue item asks to be resolved. */
const STILL_UNPAID_DAYS = 30;

interface MoveMoney {
  fromAccountId: string;
  fromName: string;
  toAccountId: string;
  toName: string;
  amount_minor: number;
}

/** Upcoming: what's overdue, then the next 30 days, each with confirm, match and skip (FR-11, BR-08.5). */
export default function PlanPage() {
  const t = useTranslations('plan');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [acting, setActing] = useState<{ id: string; mode: 'confirm' | 'match' | 'edit' } | null>(null);
  const [moveOffer, setMoveOffer] = useState<MoveMoney | null>(null);
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
  const stillUnpaidBefore = new Date(Date.parse(`${todayLocal()}T00:00:00Z`) - STILL_UNPAID_DAYS * 86_400_000).toISOString().slice(0, 10);
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
    void run(async () => {
      const result = await api<{ moveMoney?: MoveMoney }>('POST', `/api/v1/occurrences/${item.id}/confirm`, { idempotencyKey: newIdempotencyKey(), body: { date: String(form.get('date')), ...(changed ? { amount_minor: amount } : {}) } });
      setMoveOffer(result.moveMoney ?? null);
    }, t('confirmed', { name: item.name }));
  }

  function saveOne(event: React.FormEvent<HTMLFormElement>, item: Occurrence) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = parseUserAmount(String(form.get('amount') ?? ''));
    if (amount === null || amount <= 0) return setError(t('badAmount'));
    void run(() => api('PATCH', `/api/v1/occurrences/${item.id}`, { ifMatch: item.version, body: { amount_minor: amount, dueDate: String(form.get('date')) } }), t('changedOne', { name: item.name }));
  }

  const moveMoney = (offer: MoveMoney) =>
    run(async () => {
      await api('POST', '/api/v1/transfers', { idempotencyKey: newIdempotencyKey(), body: { date: todayLocal(), fromAccountId: offer.fromAccountId, toAccountId: offer.toAccountId, amount_minor: offer.amount_minor } });
      setMoveOffer(null);
    }, t('moved'));

  async function openMatch(item: Occurrence) {
    setActing({ id: item.id, mode: 'match' });
    setCandidates(null);
    setError(null);
    setNotice(null);
    const shift = (days: number) => new Date(Date.parse(`${item.dueDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const today = todayLocal();
    const from = shift(-10);
    // Due more than 10 days from now: the search window hasn't started yet, so nothing can match.
    if (from > today) return setCandidates([]);
    const to = shift(10) > today ? today : shift(10);
    setBusy(true);
    try {
      const found = await api<{ items: Transaction[] }>('GET', `/api/v1/transactions?accountId=${item.accountId}&from=${from}&to=${to}&limit=50`);
      setCandidates(found.items.filter((tx) => tx.status === 'posted' && tx.kind !== 'opening_balance'));
    } catch (problem) {
      setActing(null);
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
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
            {item.overdue && <span className="badge">{item.dueDate < stillUnpaidBefore ? t('stillUnpaid') : t('overdue')}</span>}
            {item.isEdited && <span className="badge">{t('editedBadge')}</span>}
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
      <div className="actions compact">
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('confirmNamed', { name: item.name })} onClick={() => setActing({ id: item.id, mode: 'confirm' })}>
          {t('confirm')}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('matchNamed', { name: item.name })} onClick={() => void openMatch(item)}>
          {t('match')}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('skipNamed', { name: item.name })} onClick={() => void skip(item)}>
          {t('skip')}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('changeNamed', { name: item.name })} onClick={() => setActing({ id: item.id, mode: 'edit' })}>
          {t('change')}
        </button>
      </div>
      {acting?.id === item.id && acting.mode === 'edit' && (
        <form onSubmit={(event) => saveOne(event, item)}>
          <p className="small muted">
            {t('changeHint')} <Link href={`/plan/rules/${item.ruleId}`}>{t('changeAll')}</Link>
          </p>
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`one-amount-${item.id}`}>{t('oneAmount')}</label>
              <input id={`one-amount-${item.id}`} name="amount" type="text" inputMode="decimal" defaultValue={editableAmount(item.amount_minor)} required />
            </div>
            <div className="field">
              <label htmlFor={`one-date-${item.id}`}>{t('oneDate')}</label>
              <input id={`one-date-${item.id}`} name="date" type="date" defaultValue={item.dueDate} required />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('oneSave')}
            </button>
            <button className="btn" type="button" onClick={() => setActing(null)}>
              {tApp('cancel')}
            </button>
          </div>
        </form>
      )}
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
        <Link href="/reports" className="btn">
          {t('reports')}
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
      {moveOffer && (
        <p className="notice notice-info">
          {t('moveOffer', { amount: money(moveOffer.amount_minor), from: moveOffer.fromName, to: moveOffer.toName })}{' '}
          <button className="btn" type="button" disabled={busy} onClick={() => void moveMoney(moveOffer)}>
            {t('moveIt')}
          </button>
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
