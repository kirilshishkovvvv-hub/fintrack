'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { accountBalance } from '@/components/AccountRow';
import { AppShell } from '@/components/AppShell';
import { useUndo } from '@/components/UndoToast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatMoney, parseUserAmount } from '@/lib/money';
import {
  active,
  loadAccounts,
  loadCategories,
  loadSummary,
  notifyDataChanged,
  todayLocal,
  useApiData,
  type Account,
  type Reconciliation,
  type Transaction,
} from '@/lib/use-api';

/** One account: its balance, reconciliations (FR-18), the quick balance update and archiving (FR-19). */
export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('account');
  const tTypes = useTranslations('accountTypes');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const offerUndo = useUndo();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUnlock, setConfirmUnlock] = useState<string | null>(null);
  const [choice, setChoice] = useState<'spent' | 'unexplained' | null>(null);
  const key = useRef(newIdempotencyKey());
  const { data, failed } = useApiData(async () => {
    const [accounts, categories, summary, reconciliations] = await Promise.all([
      loadAccounts(),
      loadCategories(),
      loadSummary(),
      api<{ items: Reconciliation[] }>('GET', `/api/v1/reconciliations?accountId=${id}`).then((r) => r.items),
    ]);
    return { account: accounts.find((account) => account.id === id) ?? null, categories, currency: summary.currency, reconciliations };
  });

  if (failed || (data && !data.account)) {
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

  const account: Account = data.account!;
  const { currency } = data;
  const updatable = account.class === 'cash' || account.class === 'investment' || account.class === 'other_asset';
  const expenseCategories = active(data.categories).filter((category) => category.kind === 'expense');
  const untracked = expenseCategories.find((category) => category.name === 'Untracked spending') ?? expenseCategories[0];
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(`${iso}T12:00:00`));

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      key.current = newIdempotencyKey();
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  const archive = (archived: boolean) =>
    run(async () => {
      await api('POST', `/api/v1/accounts/${account.id}/${archived ? 'archive' : 'unarchive'}`, { idempotencyKey: key.current });
      setNotice(archived ? t('archivedNotice') : t('unarchivedNotice'));
    });

  const unlock = (reconciliationId: string) =>
    run(async () => {
      await api('POST', `/api/v1/reconciliations/${reconciliationId}/unlock`, { idempotencyKey: key.current });
      setConfirmUnlock(null);
      setNotice(t('unlockedNotice'));
    });

  function updateBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actual = parseUserAmount(String(form.get('actual') ?? ''));
    if (actual === null) return setError(tErrors('invalidAmount'));
    if (account.class === 'cash' && !choice) return setError(t('chooseReason'));
    const categoryId = account.class === 'cash' && choice === 'spent' ? String(form.get('category')) : undefined;
    const target = event.currentTarget;
    void run(async () => {
      const result = await api<{ transaction: Transaction | null }>('POST', `/api/v1/accounts/${account.id}/balance-update`, {
        idempotencyKey: key.current,
        body: { date: String(form.get('date')), actual_minor: actual, ...(categoryId ? { categoryId } : {}) },
      });
      if (result.transaction) offerUndo(t('updatedToast'), result.transaction.undo);
      else setNotice(t('alreadyRight'));
      target.reset();
      setChoice(null);
    });
  }

  return (
    <AppShell>
      <h1>
        {account.name}
        {account.archived && <span className="badge">{t('archivedBadge')}</span>}
      </h1>
      <section className="card">
        <p className="eyebrow">{tTypes(account.type)}</p>
        <p className="hero-amount">{accountBalance(account, currency)}</p>
        <div className="actions">
          {!account.archived && (
            <Link href={`/accounts/${account.id}/reconcile`} className="btn btn-primary">
              {t('reconcile')}
            </Link>
          )}
          {!account.archived && (
            <Link href={`/import?account=${account.id}`} className="btn">
              {t('import')}
            </Link>
          )}
          <button className="btn" type="button" disabled={busy} onClick={() => void archive(!account.archived)}>
            {account.archived ? t('unarchive') : t('archive')}
          </button>
        </div>
        {!account.archived && <p className="small muted" style={{ marginTop: '0.75rem' }}>{t('archiveHint')}</p>}
      </section>

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

      {updatable && !account.archived && (
        <form className="card" onSubmit={updateBalance}>
          <h2>{t('updateTitle')}</h2>
          <p className="small muted">{account.class === 'cash' ? t('updateIntroCash') : t('updateIntroValue')}</p>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="actual">{account.class === 'cash' ? t('actualCash') : t('actualValue')}</label>
              <input id="actual" name="actual" type="text" inputMode="decimal" placeholder="0.00" required />
            </div>
            <div className="field">
              <label htmlFor="date">{t('date')}</label>
              <input id="date" name="date" type="date" defaultValue={todayLocal()} max={todayLocal()} required />
            </div>
          </div>
          {account.class === 'cash' && (
            <fieldset className="choice">
              <legend>{t('reason')}</legend>
              <label className="check">
                <input type="radio" name="reason" checked={choice === 'spent'} onChange={() => setChoice('spent')} />
                <span>
                  {t('spent')}
                  <span className="hint" style={{ display: 'block' }}>{t('spentHint')}</span>
                </span>
              </label>
              {choice === 'spent' && (
                <div className="field" style={{ marginLeft: '1.75rem' }}>
                  <label htmlFor="category">{t('category')}</label>
                  <select id="category" name="category" defaultValue={untracked?.id}>
                    {expenseCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className="check">
                <input type="radio" name="reason" checked={choice === 'unexplained'} onChange={() => setChoice('unexplained')} />
                <span>
                  {t('unexplained')}
                  <span className="hint" style={{ display: 'block' }}>{t('unexplainedHint')}</span>
                </span>
              </label>
            </fieldset>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('updateSubmit')}
          </button>
        </form>
      )}

      <section className="card" aria-labelledby="reconciliations-title">
        <h2 id="reconciliations-title">{t('history')}</h2>
        {data.reconciliations.length === 0 ? (
          <p className="muted">{t('noReconciliations')}</p>
        ) : (
          <ol className="history">
            {data.reconciliations.map((reconciliation) => (
              <li key={reconciliation.id}>
                <div>
                  {t('statementOn', { date: day(reconciliation.statementDate) })}
                  <span className="badge">{t(`status.${reconciliation.status}`)}</span>
                </div>
                <div className="small muted">
                  {t('statementBalance', { amount: formatMoney(reconciliation.statement_minor, currency) })}
                  {reconciliation.status === 'broken' && reconciliation.difference_minor !== 0 && (
                    <> · {t('differenceNow', { amount: `${reconciliation.difference_minor < 0 ? '−' : '+'}${formatMoney(Math.abs(reconciliation.difference_minor), currency)}` })}</>
                  )}
                </div>
                {reconciliation.status === 'completed' &&
                  (confirmUnlock === reconciliation.id ? (
                    <div className="notice notice-warning small" role="alert" style={{ marginTop: '0.5rem' }}>
                      <p>{t('unlockWarning')}</p>
                      <div className="actions">
                        <button className="btn" type="button" disabled={busy} onClick={() => void unlock(reconciliation.id)}>
                          {t('unlockConfirm')}
                        </button>
                        <button className="btn btn-ghost" type="button" onClick={() => setConfirmUnlock(null)}>
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn btn-ghost" type="button" onClick={() => setConfirmUnlock(reconciliation.id)}>
                      {t('unlock')}
                    </button>
                  ))}
              </li>
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}
