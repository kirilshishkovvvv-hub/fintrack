'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { editableAmount } from '@/components/TransactionForm';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay, formatMoney, parseUserAmount } from '@/lib/money';
import { loadGoals, loadOccurrences, type Goal } from '@/lib/plan';
import { active, loadAccounts, loadSummary, notifyDataChanged, useApiData } from '@/lib/use-api';

type Action = 'allocate' | 'release' | 'move' | 'payment' | 'edit' | 'convert' | 'account';

interface HistoryLine {
  accountId: string;
  event: string;
  delta: number;
  occurredAt: string;
}

/** Goals: backed progress, shortfalls, the amount needed, and "Save for a bill" (§8, R5, wireframe 6). */
export default function GoalsPage() {
  const t = useTranslations('goals');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [adding, setAdding] = useState(false);
  const [funding, setFunding] = useState<'virtual' | 'dedicated'>('virtual');
  const [acting, setActing] = useState<{ goalId: string; action: Action } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Record<string, HistoryLine[]>>({});
  const key = useRef(newIdempotencyKey());
  const { data, failed, reload } = useApiData(async () => {
    const [goals, accounts, summary, occurrences] = await Promise.all([loadGoals(), loadAccounts(), loadSummary(), loadOccurrences(`?to=${new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10)}`)]);
    return { goals, accounts: active(accounts), currency: summary.currency, occurrences };
  });
  if (failed) return <LoadError retry={reload} />;

  const money = (minor: number) => formatMoney(Math.abs(minor), data?.currency ?? 'EUR', locale);
  const cash = data?.accounts.filter((account) => account.class === 'cash') ?? [];

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      setActing(null);
      setAdding(false);
      key.current = newIdempotencyKey();
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optionalAmount = (name: string) => {
      const text = String(form.get(name) ?? '').trim();
      return text ? parseUserAmount(text) : undefined;
    };
    const target = optionalAmount('target');
    const monthly = optionalAmount('monthly');
    if (target === null || monthly === null) return setError(t('badAmount'));
    const name = String(form.get('name') ?? '').trim();
    void run(
      () =>
        api('POST', '/api/v1/goals', {
          idempotencyKey: key.current,
          body: {
            name,
            funding,
            ...(target !== undefined ? { target_minor: target } : {}),
            ...(monthly !== undefined ? { monthly_minor: monthly } : {}),
            ...(String(form.get('targetDate') ?? '') ? { targetDate: String(form.get('targetDate')) } : {}),
            ...(funding === 'dedicated' ? { accountIds: [String(form.get('account'))] } : {}),
          },
        }),
      t('created', { name }),
    );
  }

  function allocation(event: React.FormEvent<HTMLFormElement>, goal: Goal, operation: 'allocate' | 'release' | 'move') {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = String(form.get('amount') ?? '').trim();
    const amount = text ? parseUserAmount(text) : null;
    if ((operation !== 'release' || text) && (amount === null || amount <= 0)) return setError(t('badAmount'));
    void run(
      () =>
        api('POST', `/api/v1/goals/${goal.id}/allocations`, {
          idempotencyKey: newIdempotencyKey(),
          body: {
            operation,
            accountId: String(form.get('account')),
            ...(amount !== null ? { amount_minor: amount } : {}),
            ...(operation === 'move' ? { toAccountId: String(form.get('toAccount')) } : {}),
          },
        }),
      t('changed', { name: goal.name }),
    );
  }

  function linkPayment(event: React.FormEvent<HTMLFormElement>, goal: Goal) {
    event.preventDefault();
    const occurrenceId = String(new FormData(event.currentTarget).get('occurrence'));
    void run(() => api('POST', `/api/v1/goals/${goal.id}/link-payment`, { idempotencyKey: newIdempotencyKey(), body: { occurrenceId } }), t('changed', { name: goal.name }));
  }

  function saveGoal(event: React.FormEvent<HTMLFormElement>, goal: Goal) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optional = (name: string) => {
      const text = String(form.get(name) ?? '').trim();
      return text ? parseUserAmount(text) : undefined;
    };
    const target = optional('target');
    const monthly = optional('monthly');
    if (target === null || monthly === null || target === 0) return setError(t('badAmount'));
    const name = String(form.get('name') ?? '').trim();
    void run(
      () =>
        api('PATCH', `/api/v1/goals/${goal.id}`, {
          ifMatch: goal.version,
          body: { name, target_minor: target ?? null, monthly_minor: monthly ?? null, targetDate: String(form.get('targetDate') ?? '') || null },
        }),
      t('changed', { name }),
    );
  }

  const unlink = (goal: Goal, accountId: string, spendable: boolean) =>
    run(() => api('POST', `/api/v1/goals/${goal.id}/unlink`, { idempotencyKey: newIdempotencyKey(), body: { accountId, spendable } }), t('changed', { name: goal.name }));

  function addAccount(event: React.FormEvent<HTMLFormElement>, goal: Goal) {
    event.preventDefault();
    const accountId = String(new FormData(event.currentTarget).get('account'));
    void run(() => api('POST', `/api/v1/goals/${goal.id}/accounts`, { idempotencyKey: newIdempotencyKey(), body: { accountId } }), t('changed', { name: goal.name }));
  }

  function convert(event: React.FormEvent<HTMLFormElement>, goal: Goal) {
    event.preventDefault();
    const accountId = String(new FormData(event.currentTarget).get('account') ?? '');
    const to = goal.funding === 'virtual' ? 'dedicated' : 'virtual';
    void run(() => api('POST', `/api/v1/goals/${goal.id}/convert`, { idempotencyKey: newIdempotencyKey(), body: { to, ...(accountId ? { accountId } : {}) } }), t('changed', { name: goal.name }));
  }

  async function loadHistory(goal: Goal) {
    if (history[goal.id]) return;
    const found = await api<{ items: HistoryLine[] }>('GET', `/api/v1/goals/${goal.id}/history`);
    setHistory((current) => ({ ...current, [goal.id]: found.items }));
  }

  const archive = (goal: Goal) => run(() => api('POST', `/api/v1/goals/${goal.id}/archive`, { idempotencyKey: newIdempotencyKey() }), t('archived', { name: goal.name }));

  const openAccounts = (goal: Goal) => goal.allocations.map((row) => (
    <option key={row.accountId} value={row.accountId}>
      {row.name} ({money(row.amount_minor)})
    </option>
  ));

  const card = (goal: Goal) => {
    const percent = goal.target_minor ? Math.min(100, (goal.progress_minor / goal.target_minor) * 100) : null;
    const isVirtual = goal.funding === 'virtual';
    const live = goal.status === 'active';
    const open = acting?.goalId === goal.id ? acting.action : null;
    const payable = (data?.occurrences ?? []).filter((item) => item.kind !== 'income' && !item.goalId);
    return (
      <section className="card" key={goal.id} aria-label={goal.name}>
        <h2>
          {goal.name}
          {goal.state !== 'active' && <span className="badge">{t(`states.${goal.state}`)}</span>}
        </h2>
        <p className="amount">
          {goal.target_minor ? t('progressOf', { progress: money(goal.progress_minor), target: money(goal.target_minor) }) : money(goal.progress_minor)}
          {percent !== null ? ` · ${Math.floor(percent * 10) / 10} %` : ''}
        </p>
        {percent !== null && (
          <div className="split-bar" aria-hidden="true">
            <span style={{ width: `${percent}%`, background: 'var(--brand)' }} />
          </div>
        )}
        {goal.shortfall_minor > 0 && <p className="notice notice-warning small">{t('short', { amount: money(goal.shortfall_minor) })}</p>}
        {goal.used_minor > 0 && <p className="small muted">{t('used', { amount: money(goal.used_minor) })}</p>}
        {goal.projection?.behindSchedule && goal.projection.requiredMonthly !== null && <p className="notice notice-warning small">{t('behind', { amount: money(goal.projection.requiredMonthly) })}</p>}
        {goal.projection?.estimatedCompletion && <p className="small muted">{t('estimated', { date: formatDay(goal.projection.estimatedCompletion, locale) })}</p>}
        {goal.allocations.map((row) => (
          <div className="row small" key={row.accountId}>
            <span>{row.name}</span>
            <span className="amount">{money(row.amount_minor)}</span>
          </div>
        ))}
        {goal.accounts.map((row) => (
          <div className="import-row small" key={row.accountId}>
            <div className="row" style={{ borderTop: 0 }}>
              <span>{t('wholeAccount', { name: row.name })}</span>
              <span className="amount">{money(row.balance_minor)}</span>
            </div>
            {live && (
              <div className="actions">
                <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('unlinkSpendable', { name: row.name })} onClick={() => void unlink(goal, row.accountId, true)}>
                  {t('unlinkSpendableShort')}
                </button>
                <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('unlinkSaving', { name: row.name })} onClick={() => void unlink(goal, row.accountId, false)}>
                  {t('unlinkSavingShort')}
                </button>
              </div>
            )}
          </div>
        ))}
        {goal.payments.length > 0 && <p className="small" style={{ marginTop: '0.5rem' }}>{t('saveForBill')}</p>}
        {goal.payments.map((payment) => (
          <div className="row small" key={payment.occurrenceId}>
            <span>
              {payment.name} · {formatDay(payment.dueDate, locale)}
            </span>
            <span className="amount">{t('covered', { covered: money(payment.covered_minor), amount: money(payment.amount_minor) })}</span>
          </div>
        ))}
        {live && (
          <div className="actions" style={{ marginTop: '0.75rem' }}>
            {isVirtual && (
              <button className="btn btn-primary" type="button" disabled={busy} aria-label={t('allocateNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'allocate' })}>
                {t('allocate')}
              </button>
            )}
            {isVirtual && goal.allocations.length > 0 && (
              <>
                <button className="btn" type="button" disabled={busy} aria-label={t('releaseNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'release' })}>
                  {t('release')}
                </button>
                <button className="btn" type="button" disabled={busy} aria-label={t('moveNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'move' })}>
                  {t('move')}
                </button>
              </>
            )}
            <button className="btn" type="button" disabled={busy} aria-label={t('linkNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'payment' })}>
              {t('linkBill')}
            </button>
            {!isVirtual && (
              <button className="btn" type="button" disabled={busy} aria-label={t('addAccountNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'account' })}>
                {t('addAccount')}
              </button>
            )}
            <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('editNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'edit' })}>
              {t('edit')}
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('convertNamed', { name: goal.name })} onClick={() => setActing({ goalId: goal.id, action: 'convert' })}>
              {t('convert')}
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('archiveNamed', { name: goal.name })} onClick={() => void archive(goal)}>
              {t('archive')}
            </button>
          </div>
        )}
        {open === 'edit' && (
          <form onSubmit={(event) => saveGoal(event, goal)}>
            <div className="field">
              <label htmlFor={`edit-name-${goal.id}`}>{t('name')}</label>
              <input id={`edit-name-${goal.id}`} name="name" type="text" maxLength={100} defaultValue={goal.name} required />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`edit-target-${goal.id}`}>{t('target')}</label>
                <input id={`edit-target-${goal.id}`} name="target" type="text" inputMode="decimal" defaultValue={goal.target_minor ? editableAmount(goal.target_minor) : ''} />
              </div>
              <div className="field">
                <label htmlFor={`edit-date-${goal.id}`}>{t('targetDate')}</label>
                <input id={`edit-date-${goal.id}`} name="targetDate" type="date" defaultValue={goal.targetDate ?? ''} />
              </div>
            </div>
            <div className="field">
              <label htmlFor={`edit-monthly-${goal.id}`}>{t('monthly')}</label>
              <input id={`edit-monthly-${goal.id}`} name="monthly" type="text" inputMode="decimal" defaultValue={goal.monthly_minor !== null ? editableAmount(goal.monthly_minor) : ''} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('editSave')}
            </button>
          </form>
        )}
        {open === 'account' && (
          <form onSubmit={(event) => addAccount(event, goal)}>
            <div className="field">
              <label htmlFor={`add-account-${goal.id}`}>{t('wholeAccountLabel')}</label>
              <select id={`add-account-${goal.id}`} name="account">
                {cash.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('addAccount')}
            </button>
          </form>
        )}
        {open === 'convert' && (
          <form onSubmit={(event) => convert(event, goal)}>
            <p className="small muted">{isVirtual ? t('convertToDedicated') : t('convertToVirtual')}</p>
            {isVirtual && (
              <div className="field">
                <label htmlFor={`convert-account-${goal.id}`}>{t('wholeAccountLabel')}</label>
                <select id={`convert-account-${goal.id}`} name="account">
                  {cash.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('convertSave')}
            </button>
          </form>
        )}
        {open === 'allocate' && (
          <form onSubmit={(event) => allocation(event, goal, 'allocate')}>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`alloc-account-${goal.id}`}>{t('fromAccount')}</label>
                <select id={`alloc-account-${goal.id}`} name="account">
                  {cash.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`alloc-amount-${goal.id}`}>{t('amount')}</label>
                <input id={`alloc-amount-${goal.id}`} name="amount" type="text" inputMode="decimal" required />
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('allocateSave')}
            </button>
          </form>
        )}
        {open === 'release' && (
          <form onSubmit={(event) => allocation(event, goal, 'release')}>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`release-account-${goal.id}`}>{t('account')}</label>
                <select id={`release-account-${goal.id}`} name="account">
                  {openAccounts(goal)}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`release-amount-${goal.id}`}>{t('amountOrAll')}</label>
                <input id={`release-amount-${goal.id}`} name="amount" type="text" inputMode="decimal" />
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('releaseSave')}
            </button>
          </form>
        )}
        {open === 'move' && (
          <form onSubmit={(event) => allocation(event, goal, 'move')}>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`move-from-${goal.id}`}>{t('fromAccount')}</label>
                <select id={`move-from-${goal.id}`} name="account">
                  {openAccounts(goal)}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`move-to-${goal.id}`}>{t('toAccount')}</label>
                <select id={`move-to-${goal.id}`} name="toAccount">
                  {cash.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor={`move-amount-${goal.id}`}>{t('amount')}</label>
              <input id={`move-amount-${goal.id}`} name="amount" type="text" inputMode="decimal" required />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('moveSave')}
            </button>
          </form>
        )}
        {open === 'payment' &&
          (payable.length === 0 ? (
            <p className="small muted">
              {t('noBills')} <Link href="/plan/rules/new">{t('addBill')}</Link>
            </p>
          ) : (
            <form onSubmit={(event) => linkPayment(event, goal)}>
              <div className="field">
                <label htmlFor={`payment-${goal.id}`}>{t('whichBill')}</label>
                <select id={`payment-${goal.id}`} name="occurrence">
                  {payable.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {formatDay(item.dueDate, locale)} · {money(item.amount_minor)}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {t('linkSave')}
              </button>
            </form>
          ))}
        {isVirtual && (
          <details onToggle={(event) => (event.currentTarget as HTMLDetailsElement).open && void loadHistory(goal)}>
            <summary>{t('history')}</summary>
            {(history[goal.id] ?? []).map((line, index) => (
              <div className="row small" key={index}>
                <span>
                  {t(`events.${line.event}`)} · {formatDay(line.occurredAt.slice(0, 10), locale)}
                </span>
                <span className="amount">
                  {line.delta < 0 ? '−' : '+'}
                  {money(line.delta)}
                </span>
              </div>
            ))}
          </details>
        )}
      </section>
    );
  };

  const live = data?.goals.filter((goal) => goal.status === 'active') ?? [];
  const old = data?.goals.filter((goal) => goal.status === 'archived') ?? [];

  return (
    <AppShell>
      <p className="small">
        <Link href="/plan">{t('backToPlan')}</Link>
      </p>
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
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
      <div className="actions" style={{ marginBottom: '1rem' }}>
        <button className="btn btn-primary" type="button" onClick={() => setAdding(!adding)}>
          {t('add')}
        </button>
      </div>
      {adding && (
        <form className="card" onSubmit={create}>
          <div className="field">
            <label htmlFor="name">{t('name')}</label>
            <input id="name" name="name" type="text" maxLength={100} required />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="target">{t('target')}</label>
              <input id="target" name="target" type="text" inputMode="decimal" />
            </div>
            <div className="field">
              <label htmlFor="targetDate">{t('targetDate')}</label>
              <input id="targetDate" name="targetDate" type="date" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="monthly">{t('monthly')}</label>
            <input id="monthly" name="monthly" type="text" inputMode="decimal" />
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 500, marginBottom: '0.35rem' }}>{t('funding')}</legend>
            <div className="segmented">
              <label>
                <input type="radio" name="funding" checked={funding === 'virtual'} onChange={() => setFunding('virtual')} /> {t('virtual')}
              </label>
              <label>
                <input type="radio" name="funding" checked={funding === 'dedicated'} onChange={() => setFunding('dedicated')} /> {t('dedicated')}
              </label>
            </div>
            <span className="hint">{funding === 'virtual' ? t('virtualHint') : t('dedicatedHint')}</span>
          </fieldset>
          {funding === 'dedicated' && (
            <div className="field">
              <label htmlFor="account">{t('wholeAccountLabel')}</label>
              <select id="account" name="account">
                {cash.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('createSave')}
          </button>
        </form>
      )}
      {!data ? <p aria-live="polite">{tApp('loading')}</p> : live.length === 0 && !adding ? <p className="muted">{t('empty')}</p> : live.map(card)}
      {old.length > 0 && (
        <details className="card">
          <summary>{t('archivedTitle', { count: old.length })}</summary>
          {old.map((goal) => (
            <div className="row small" key={goal.id}>
              <span>{goal.name}</span>
              <span className="amount">{t('used', { amount: money(goal.used_minor) })}</span>
            </div>
          ))}
        </details>
      )}
    </AppShell>
  );
}
