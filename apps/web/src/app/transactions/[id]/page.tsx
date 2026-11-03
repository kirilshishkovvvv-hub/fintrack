'use client';

import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { signedMoney } from '@/components/TransactionRow';
import { useUndo } from '@/components/UndoToast';
import { api, ApiProblem, errorMessage, newIdempotencyKey } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import {
  loadAccounts,
  loadCategories,
  loadSummary,
  notifyDataChanged,
  todayLocal,
  useApiData,
  type Account,
  type Category,
  type Transaction,
  type TransactionDetail,
} from '@/lib/use-api';

/** "45.60" for 4560: an exact decimal string for the edit field, without floating point. */
function editableAmount(minor: number): string {
  const abs = Math.abs(minor);
  return `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The simple shapes the edit form handles: one account and one category, or a plain transfer. */
function editShape(tx: Transaction, accounts: Map<string, Account>, categories: Map<string, Category>) {
  if (tx.status !== 'posted' || tx.lines.some((line) => line.mark)) return null;
  const own = tx.lines.filter((line) => accounts.has(line.ledgerAccountId));
  const cats = tx.lines.filter((line) => categories.has(line.ledgerAccountId));
  if ((tx.kind === 'expense' || tx.kind === 'income') && own.length === 1 && cats.length === 1 && tx.lines.length === 2) {
    return { kind: tx.kind, accountId: own[0]!.ledgerAccountId, categoryId: cats[0]!.ledgerAccountId, amount: Math.abs(own[0]!.amount_minor) };
  }
  if (tx.kind === 'transfer' && own.length === 2 && tx.lines.length === 2) {
    const from = own.find((line) => line.amount_minor < 0)!;
    const to = own.find((line) => line.amount_minor > 0)!;
    return { kind: 'transfer' as const, fromId: from.ledgerAccountId, toId: to.ledgerAccountId, amount: to.amount_minor };
  }
  return null;
}

export default function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('transaction');
  const tKinds = useTranslations('transactions.kinds');
  const tNew = useTranslations('newTransaction');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const offerUndo = useUndo();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const { data, failed } = useApiData(async () => {
    const [tx, accounts, categories, summary] = await Promise.all([
      api<TransactionDetail>('GET', `/api/v1/transactions/${id}`),
      loadAccounts(),
      loadCategories(),
      loadSummary(),
    ]);
    return { tx, accounts, categories, currency: summary.currency };
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
  const shape = editShape(tx, accounts, categories);
  const title = tx.description ?? categoryNames[0] ?? tKinds(tx.kind);
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

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

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shape) return;
    const form = new FormData(event.currentTarget);
    const amount = parseUserAmount(String(form.get('amount') ?? ''));
    if (amount === null || amount <= 0) return setError(tErrors('invalidAmount'));
    const date = String(form.get('date'));
    const description = String(form.get('description') ?? '').trim() || undefined;
    const body =
      shape.kind === 'transfer'
        ? { kind: 'transfer', date, fromAccountId: form.get('from'), toAccountId: form.get('to'), amount_minor: amount, description }
        : { kind: shape.kind, date, accountId: form.get('account'), lines: [{ categoryId: form.get('category'), amount_minor: amount }], description };
    void run(() => api<Transaction>('PATCH', `/api/v1/transactions/${tx.id}`, { ifMatch: tx.version, body }), t('saved'));
  }

  const voidTx = () => run(() => api<Transaction>('POST', `/api/v1/transactions/${tx.id}/void`, { idempotencyKey: key.current }), t('voidedToast'));
  const restore = () => run(() => api<Transaction>('POST', `/api/v1/transactions/${tx.id}/restore`, { idempotencyKey: key.current }), t('restoredToast'));
  const trash = () =>
    run(
      () => api<Transaction>('DELETE', `/api/v1/transactions/${tx.id}`, { ifMatch: tx.version }),
      t('trashedToast'),
      () => router.replace('/transactions'),
    );

  const accountOptions = data.accounts
    .filter((account) => !account.archived)
    .map((account) => (
      <option key={account.id} value={account.id}>
        {account.name}
      </option>
    ));
  const categoryOptions =
    shape && shape.kind !== 'transfer'
      ? data.categories
          .filter((category) => category.kind === shape.kind)
          .map((category) => {
            const parent = category.parentId ? categories.get(category.parentId) : undefined;
            return (
              <option key={category.id} value={category.id}>
                {parent ? `${parent.name} › ${category.name}` : category.name}
              </option>
            );
          })
      : null;

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
        {categoryNames.length > 0 && (
          <div className="row">
            <span className="muted">{t('category')}</span>
            <span>{categoryNames.join(', ')}</span>
          </div>
        )}
        {tx.status === 'voided' && <p className="notice notice-warning small">{t('voidedNote')}</p>}
        {tx.status === 'trashed' && <p className="notice notice-warning small">{t('trashedNote')}</p>}
      </section>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {editing && shape ? (
        <form className="card" onSubmit={save}>
          <h2>{t('edit')}</h2>
          <div className="field">
            <label htmlFor="amount">{tNew('amount')}</label>
            <input id="amount" name="amount" type="text" inputMode="decimal" className="amount-input" defaultValue={editableAmount(shape.amount)} required />
          </div>
          {shape.kind === 'transfer' ? (
            <div className="grid-2">
              <div className="field">
                <label htmlFor="from">{tNew('from')}</label>
                <select id="from" name="from" defaultValue={shape.fromId}>
                  {accountOptions}
                </select>
              </div>
              <div className="field">
                <label htmlFor="to">{tNew('to')}</label>
                <select id="to" name="to" defaultValue={shape.toId}>
                  {accountOptions}
                </select>
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="account">{tNew('account')}</label>
                <select id="account" name="account" defaultValue={shape.accountId}>
                  {accountOptions}
                </select>
              </div>
              <div className="field">
                <label htmlFor="category">{tNew('category')}</label>
                <select id="category" name="category" defaultValue={shape.categoryId}>
                  {categoryOptions}
                </select>
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="date">{tNew('date')}</label>
            <input id="date" name="date" type="date" defaultValue={tx.date} max={todayLocal()} required />
          </div>
          <div className="field">
            <label htmlFor="description">{tNew('description')}</label>
            <input id="description" name="description" type="text" maxLength={500} defaultValue={tx.description ?? ''} />
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('saveChanges')}
            </button>
            <button className="btn" type="button" onClick={() => setEditing(false)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : (
        <section className="card actions" aria-label={t('actions')}>
          {tx.status === 'posted' && shape && (
            <button className="btn btn-primary" type="button" onClick={() => setEditing(true)} disabled={busy}>
              {t('edit')}
            </button>
          )}
          {tx.status === 'posted' && (
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
          {tx.status === 'posted' && !shape && <p className="small muted">{t('editLater')}</p>}
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
