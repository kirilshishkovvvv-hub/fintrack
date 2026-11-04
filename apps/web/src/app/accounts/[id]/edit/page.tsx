'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { editableAmount } from '@/components/TransactionForm';
import { api, errorMessage } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { active, loadAccounts, notifyDataChanged, useApiData, type Account } from '@/lib/use-api';

interface AccountDetail extends Account {
  openingDate: string;
  institution: string | null;
  creditLimit_minor: number | null;
  notes: string | null;
  dedicatedToGoal: boolean;
  openingAmount_minor: number;
  openingHeldByReconciliation: boolean;
}

const TYPES_BY_CLASS: Record<string, string[]> = {
  cash: ['current', 'savings', 'cash'],
  investment: ['investment'],
  other_asset: ['lent', 'other_asset'],
  liability: ['card', 'loan', 'other_liability'],
};

/** Everything editable about an account (BR-03.1), and its opening balance (BR-03.2, E-03). The balance itself never is (BR-03.4). */
export default function EditAccountPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('editAccount');
  const tTypes = useTranslations('accountTypes');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenType, setChosenType] = useState<string | null>(null);
  const { data, failed, reload } = useApiData(async () => {
    const [account, accounts] = await Promise.all([api<AccountDetail>('GET', `/api/v1/accounts/${id}`), loadAccounts()]);
    return { account, accounts };
  });
  if (failed) return <LoadError retry={reload} />;
  if (!data) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }
  const { account, accounts } = data;
  const type = chosenType ?? account.type;
  const isCard = type === 'card';

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const limitText = String(form.get('creditLimit') ?? '').trim();
    const limit = limitText ? parseUserAmount(limitText) : null;
    if (limitText && (limit === null || limit < 0)) return setError(t('badAmount'));
    void run(
      () =>
        api('PATCH', `/api/v1/accounts/${id}`, {
          ifMatch: account.version,
          body: {
            name: String(form.get('name') ?? '').trim(),
            type,
            institution: String(form.get('institution') ?? '').trim() || null,
            notes: String(form.get('notes') ?? '').trim() || null,
            ...(account.class === 'cash' && !account.dedicatedToGoal ? { spendable: form.get('spendable') === 'on' } : {}),
            ...(isCard ? { cardReserve: form.get('cardReserve') === 'on', creditLimit_minor: limit } : {}),
          },
        }),
      t('saved'),
    );
  }

  function saveOpening(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = parseUserAmount(String(form.get('amount') ?? ''));
    if (amount === null) return setError(t('badAmount'));
    void run(
      () => api('POST', `/api/v1/accounts/${id}/opening`, { ifMatch: account.version, body: { openingAmount_minor: amount, openingDate: String(form.get('date')) } }),
      t('openingSaved'),
    );
  }

  /** Swaps the account with its neighbour among the accounts in use. */
  function move(by: -1 | 1) {
    const order = active(accounts).map((other) => other.id);
    const from = order.indexOf(account.id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    void run(() => api('POST', '/api/v1/accounts/order', { body: { ids: order } }), t('moved'));
  }

  return (
    <AppShell>
      <p className="small">
        <Link href={`/accounts/${id}`}>{tApp('back')}</Link>
      </p>
      <h1>{t('title', { name: account.name })}</h1>
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
      <form className="card" onSubmit={save} key={`details-${account.version}`}>
        <div className="field">
          <label htmlFor="name">{t('name')}</label>
          <input id="name" name="name" type="text" maxLength={100} defaultValue={account.name} required />
        </div>
        <div className="field">
          <label htmlFor="type">{t('type')}</label>
          <select id="type" value={type} onChange={(event) => setChosenType(event.target.value)}>
            {(TYPES_BY_CLASS[account.class] ?? [account.type]).map((option) => (
              <option key={option} value={option}>
                {tTypes(option)}
              </option>
            ))}
          </select>
        </div>
        {account.class === 'cash' &&
          (account.dedicatedToGoal ? (
            <p className="small muted">{t('spendableGoal')}</p>
          ) : (
            <label className="check">
              <input type="checkbox" name="spendable" defaultChecked={account.spendable} /> <span>{t('spendable')}</span>
            </label>
          ))}
        {isCard && (
          <>
            <label className="check">
              <input type="checkbox" name="cardReserve" defaultChecked={account.cardReserve} /> <span>{t('cardReserve')}</span>
            </label>
            <div className="field">
              <label htmlFor="creditLimit">{t('creditLimit')}</label>
              <input id="creditLimit" name="creditLimit" type="text" inputMode="decimal" defaultValue={account.creditLimit_minor === null ? '' : editableAmount(account.creditLimit_minor)} aria-describedby="limit-hint" />
              <span id="limit-hint" className="hint">
                {t('creditLimitHint')}
              </span>
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="institution">{t('institution')}</label>
          <input id="institution" name="institution" type="text" maxLength={100} defaultValue={account.institution ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="notes">{t('notes')}</label>
          <textarea id="notes" name="notes" maxLength={1000} rows={3} defaultValue={account.notes ?? ''} />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {t('save')}
        </button>
      </form>

      {!account.archived && (
        <section className="card">
          <div className="actions">
            <button className="btn" type="button" disabled={busy} onClick={() => move(-1)}>
              {t('moveUp')}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => move(1)}>
              {t('moveDown')}
            </button>
          </div>
        </section>
      )}

      <form className="card" onSubmit={saveOpening} key={`opening-${account.version}`}>
        <h2>{t('openingTitle')}</h2>
        {account.archived ? (
          <p className="muted">{t('archivedNote')}</p>
        ) : (
          <>
            <p className="small muted">{t('openingIntro')}</p>
            {account.openingHeldByReconciliation && <p className="notice notice-warning small">{t('openingHeld')}</p>}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="opening-amount">{account.class === 'liability' ? t('openingOwed') : t('openingAmount')}</label>
                <input id="opening-amount" name="amount" type="text" inputMode="decimal" defaultValue={editableAmount(account.openingAmount_minor)} required />
              </div>
              <div className="field">
                <label htmlFor="opening-date">{t('openingDate')}</label>
                <input id="opening-date" name="date" type="date" defaultValue={account.openingDate} required />
              </div>
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {t('openingSave')}
            </button>
          </>
        )}
      </form>
    </AppShell>
  );
}
