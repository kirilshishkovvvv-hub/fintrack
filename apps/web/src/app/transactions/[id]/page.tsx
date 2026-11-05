'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { signedMoney } from '@/components/TransactionRow';
import { TransactionForm, valuesFrom, type PayeeOption } from '@/components/TransactionForm';
import { useUndo } from '@/components/UndoToast';
import { api, ApiProblem, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { loadGoals } from '@/lib/plan';
import {
  loadAccounts,
  loadCategories,
  loadSummary,
  notifyDataChanged,
  useApiData,
  type Transaction,
  type TransactionDetail,
} from '@/lib/use-api';

export default function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('transaction');
  const tKinds = useTranslations('transactions.kinds');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const offerUndo = useUndo();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [occurrenceTaken, setOccurrenceTaken] = useState(false);
  const [aroundNotice, setAroundNotice] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const { data, failed } = useApiData(async () => {
    const [tx, accounts, categories, summary, payees, goals] = await Promise.all([
      api<TransactionDetail>('GET', `/api/v1/transactions/${id}`),
      loadAccounts(),
      loadCategories(),
      loadSummary(),
      api<{ items: PayeeOption[] }>('GET', '/api/v1/payees').then((r) => r.items),
      loadGoals(),
    ]);
    return { tx, accounts, categories, currency: summary.currency, payees, goals };
  });

  if (failed) {
    return (
      <AppShell>
        <p className="notice notice-error" role="alert">
          {t('notFound')}
        </p>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }

  const { tx, currency } = data;
  const accounts = new Map(data.accounts.map((account) => [account.id, account]));
  const categories = new Map(data.categories.map((category) => [category.id, category]));
  const ownNames = tx.lines.filter((line) => accounts.has(line.ledgerAccountId)).map((line) => accounts.get(line.ledgerAccountId)!.name);
  const categoryNames = tx.lines.filter((line) => categories.has(line.ledgerAccountId)).map((line) => categories.get(line.ledgerAccountId)!.name);
  // A reconciled transaction is locked: nothing is offered until its reconciliation is unlocked (FR-18).
  const shape = tx.reconciled ? null : valuesFrom(tx, accounts, categories);
  const changeable = tx.status === 'posted' && !tx.reconciled && tx.kind !== 'opening_balance';
  const ownAccountId = tx.lines.find((line) => accounts.has(line.ledgerAccountId))?.ledgerAccountId;
  const title = tx.description ?? categoryNames[0] ?? tKinds(tx.kind);
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const heldGoals =
    tx.kind === 'expense'
      ? data.goals
          .filter((goal) => goal.status === 'active')
          .flatMap((goal) => goal.allocations.filter((row) => row.accountId === ownAccountId).map((row) => ({ key: `${goal.id}|${row.accountId}`, label: `${goal.name} (${formatMoney(row.amount_minor, currency, locale)})` })))
      : [];

  async function run(action: () => Promise<Transaction>, message: string, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      offerUndo(message, result.undo);
      key.current = newIdempotencyKey();
      setEditing(false);
      if (after) after();
      else notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      if (problem instanceof ApiProblem && problem.code === 'VERSION_CONFLICT') notifyDataChanged();
    } finally {
      setBusy(false);
    }
  }

  // Problems go back to the form, which knows how to ask about them.
  async function save(body: Record<string, unknown>) {
    const result = await api<Transaction>('PATCH', `/api/v1/transactions/${tx.id}`, { ifMatch: tx.version, body });
    offerUndo(t('saved'), result.undo);
    setEditing(false);
    notifyDataChanged();
  }

  /** Changes around the transaction, not to it, so there's nothing to undo here. */
  async function changeAround(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setAroundNotice(null);
    try {
      await action();
      setAroundNotice(message);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  const unlinkPlan = (occurrenceId: string) => changeAround(() => api('POST', `/api/v1/occurrences/${occurrenceId}/unlink`, { idempotencyKey: newIdempotencyKey() }), t('unlinkedPlan'));

  /** G-P3: spending recorded first can be connected to a goal later. */
  function releaseGoal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const [goalId, accountId] = String(new FormData(event.currentTarget).get('target')).split('|');
    void changeAround(() => api('POST', `/api/v1/goals/${goalId}/allocations`, { idempotencyKey: newIdempotencyKey(), body: { operation: 'use', accountId, transactionId: tx.id } }), t('releasedGoal'));
  }

  const voidTx = () => run(() => api<Transaction>('POST', `/api/v1/transactions/${tx.id}/void`, { idempotencyKey: key.current }), t('voidedToast'));
  const restore = () => run(async () => {
    const restored = await api<Transaction & { occurrenceTaken?: boolean }>('POST', `/api/v1/transactions/${tx.id}/restore`, { idempotencyKey: key.current });
    setOccurrenceTaken(restored.occurrenceTaken === true);
    return restored;
  }, t('restoredToast'));
  const trash = () =>
    run(
      () => api<Transaction>('DELETE', `/api/v1/transactions/${tx.id}`, { ifMatch: tx.version }),
      t('trashedToast'),
      () => router.replace('/transactions'),
    );

  return (
    <AppShell>
      <h1>
        {title}
        {tx.status !== 'posted' && <span className="badge">{t(`status.${tx.status}`)}</span>}
      </h1>

      <section className="card">
        <p className={`hero-amount${tx.status === 'voided' ? ' muted' : ''}`} style={tx.status === 'voided' ? { textDecoration: 'line-through' } : undefined}>
          {signedMoney(tx, accounts, currency)}
        </p>
        <div className="row">
          <span className="muted">{t('kind')}</span>
          <span>{tKinds(tx.kind)}</span>
        </div>
        <div className="row">
          <span className="muted">{t('date')}</span>
          <span>{tx.date}</span>
        </div>
        <div className="row">
          <span className="muted">{t('accounts')}</span>
          <span>{ownNames.join(' → ')}</span>
        </div>
        {tx.payee && (
          <div className="row">
            <span className="muted">{t('payee')}</span>
            <span>{tx.payee}</span>
          </div>
        )}
        {categoryNames.length > 0 && (
          <div className="row">
            <span className="muted">{t('category')}</span>
            <span>{categoryNames.join(', ')}</span>
          </div>
        )}
        {tx.refundOriginalStatus && tx.refundOriginalStatus !== 'posted' && <p className="notice notice-warning small">{t('refundOriginalGone')}</p>}
        {tx.status === 'voided' && <p className="notice notice-warning small">{t('voidedNote')}</p>}
        {tx.status === 'trashed' && <p className="notice notice-warning small">{t('trashedNote')}</p>}
        {tx.reconciled && (
          <p className="notice notice-info small">
            <span aria-hidden="true">🔒 </span>
            {t('reconciledNote')}{' '}
            {ownAccountId && <Link href={`/accounts/${ownAccountId}`}>{t('openAccount')}</Link>}
          </p>
        )}
      </section>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {occurrenceTaken && <p className="notice notice-warning">{t('occurrenceTaken')}</p>}
      {aroundNotice && (
        <p className="notice notice-info" role="status">
          {aroundNotice}
        </p>
      )}
      {tx.occurrence && (
        <section className="card">
          <p>{t('paidPlan', { name: tx.occurrence.name, date: tx.occurrence.dueDate })}</p>
          <button className="btn" type="button" disabled={busy} onClick={() => void unlinkPlan(tx.occurrence!.id)}>
            {t('unlinkPlan')}
          </button>
        </section>
      )}
      {changeable && heldGoals.length > 0 && (
        <form className="card" onSubmit={releaseGoal}>
          <div className="field">
            <label htmlFor="release-goal">{t('releaseGoal')}</label>
            <select id="release-goal" name="target">
              {heldGoals.map((goal) => (
                <option key={goal.key} value={goal.key}>
                  {goal.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {t('releaseGoalSave')}
          </button>
        </form>
      )}

      {editing && shape ? (
        <TransactionForm accounts={data.accounts} categories={data.categories} currency={currency} payees={data.payees} initial={shape} lockKind submitLabel={t('saveChanges')} onSubmit={save} onCancel={() => setEditing(false)} />
      ) : (
        <section className="card actions" aria-label={t('actions')}>
          {changeable && shape && (
            <button className="btn btn-primary" type="button" onClick={() => setEditing(true)} disabled={busy}>
              {t('edit')}
            </button>
          )}
          {changeable && (
            <>
              <button className="btn" type="button" onClick={() => void voidTx()} disabled={busy}>
                {t('void')}
              </button>
              <button className="btn btn-danger" type="button" onClick={() => void trash()} disabled={busy}>
                {t('delete')}
              </button>
            </>
          )}
          {tx.status !== 'posted' && (
            <button className="btn btn-primary" type="button" onClick={() => void restore()} disabled={busy}>
              {t('restore')}
            </button>
          )}
          {tx.status === 'posted' && (tx.kind === 'expense' || tx.kind === 'income') && (
            <Link href={`/transactions/new?refundOf=${tx.id}`} className="btn">
              {t('recordRefund')}
            </Link>
          )}
          {shape && (
            <Link href={`/transactions/new?copy=${tx.id}`} className="btn">
              {t('duplicate')}
            </Link>
          )}
          {changeable && !shape && <p className="small muted">{t('editLater')}</p>}
        </section>
      )}

      <section className="card" aria-labelledby="history-title">
        <h2 id="history-title">{t('history')}</h2>
        <ol className="history">
          {[...tx.versions].reverse().map((entry) => {
            const amounts =
              entry.changeType === 'edit' && entry.before?.lines && entry.after?.lines
                ? [entry.before, entry.after].map((snapshot) =>
                    signedMoney({ ...tx, kind: snapshot.kind ?? tx.kind, lines: snapshot.lines! }, accounts, currency),
                  )
                : null;
            const moved = entry.changeType === 'edit' && entry.before?.date !== entry.after?.date ? `${entry.before?.date} → ${entry.after?.date}` : null;
            return (
              <li key={entry.version}>
                <div>{t(`change.${entry.changeType}`)}</div>
                <div className="small muted">
                  {when(entry.changedAt)}
                  {amounts && amounts[0] !== amounts[1] ? ` · ${amounts[0]} → ${amounts[1]}` : ''}
                  {moved ? ` · ${moved}` : ''}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </AppShell>
  );
}
