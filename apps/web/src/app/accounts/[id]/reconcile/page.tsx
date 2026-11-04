'use client';

import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatMoney, parseUserAmount } from '@/lib/money';
import { active, loadAccounts, loadCategories, loadSummary, notifyDataChanged, todayLocal, useApiData, type Transaction } from '@/lib/use-api';

interface Preview {
  cleared_minor: number;
  statement_minor: number;
  difference_minor: number;
  adjustment_minor: number;
  items: (Transaction & { effect_minor: number; ticked: boolean; automatic: boolean })[];
}

/**
 * Reconcile an account against a statement (FR-18): state the statement, tick what it shows,
 * and the server works out the difference. A difference is closed only by an explicit choice.
 */
export default function ReconcilePage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('reconcile');
  const tKinds = useTranslations('transactions.kinds');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [statement, setStatement] = useState<{ date: string; balance: number } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [counter, setCounter] = useState<string>('ADJ');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const { data, failed, reload } = useApiData(async () => {
    const [accounts, categories, summary] = await Promise.all([loadAccounts(), loadCategories(), loadSummary()]);
    return { account: accounts.find((account) => account.id === id) ?? null, categories, currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  if (!data) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }
  if (!data.account) {
    return (
      <AppShell>
        <p className="notice notice-error" role="alert">
          {t('notFound')}
        </p>
      </AppShell>
    );
  }

  const { account, currency } = data;
  const owed = account.class === 'liability';
  const money = (minor: number, signed = false) => `${signed && minor > 0 ? '+' : minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), currency)}`;

  async function load(next: { date: string; balance: number }, ids: string[] | null) {
    setError(null);
    try {
      const result = await api<Preview>('POST', '/api/v1/reconciliations/preview', {
        body: { accountId: id, statementDate: next.date, statementBalance_minor: next.balance, transactionIds: ids ?? [] },
      });
      if (ids === null) {
        // First load: everything the statement could show starts ticked; untick what's missing.
        const all = result.items.filter((item) => !item.automatic).map((item) => item.id);
        setTicked(new Set(all));
        return load(next, all);
      }
      setPreview(result);
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      setPreview(null);
    }
  }

  function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const balance = parseUserAmount(String(form.get('balance') ?? ''));
    if (balance === null) return setError(tErrors('invalidAmount'));
    const next = { date: String(form.get('date')), balance };
    setStatement(next);
    void load(next, null);
  }

  function toggle(itemId: string) {
    const next = new Set(ticked);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    setTicked(next);
    if (statement) void load(statement, [...next]);
  }

  async function finish() {
    if (!statement || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/v1/reconciliations', {
        idempotencyKey: key.current,
        body: {
          accountId: id,
          statementDate: statement.date,
          statementBalance_minor: statement.balance,
          transactionIds: [...ticked],
          ...(preview.difference_minor !== 0 ? { adjustment: counter === 'ADJ' ? {} : { categoryId: counter } } : {}),
        },
      });
      notifyDataChanged();
      router.replace(`/accounts/${id}`);
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      key.current = newIdempotencyKey();
      setBusy(false);
    }
  }

  const categoryOptions = active(data.categories);

  return (
    <AppShell>
      <h1>{t('title', { account: account.name })}</h1>
      <form className="card" onSubmit={start}>
        <p className="small muted">{t('intro')}</p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="date">{t('statementDate')}</label>
            <input id="date" name="date" type="date" defaultValue={todayLocal()} max={todayLocal()} required />
          </div>
          <div className="field">
            <label htmlFor="balance">{owed ? t('statementOwed') : t('statementBalance')}</label>
            <input id="balance" name="balance" type="text" inputMode="decimal" placeholder="0.00" required />
          </div>
        </div>
        <button className="btn btn-primary" type="submit">
          {statement ? t('update') : t('start')}
        </button>
      </form>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {preview && (
        <>
          <section className="card" aria-labelledby="items-title">
            <h2 id="items-title">{t('items')}</h2>
            {preview.items.length === 0 ? (
              <p className="muted">{t('noItems')}</p>
            ) : (
              preview.items.map((item) => (
                <label className="row check" key={item.id}>
                  <input type="checkbox" checked={item.automatic || ticked.has(item.id)} disabled={item.automatic} onChange={() => toggle(item.id)} />
                  <span className="row-main">
                    <span className="row-title" style={{ display: 'block' }}>
                      {item.description ?? tKinds(item.kind)}
                    </span>
                    <span className="small muted">
                      {item.date}
                      {item.automatic ? ` · ${t('alwaysCleared')}` : ''}
                    </span>
                  </span>
                  <span className="amount">{money(item.effect_minor, true)}</span>
                </label>
              ))
            )}
          </section>

          <section className="card" aria-live="polite" aria-labelledby="figures-title">
            <h2 id="figures-title">{t('figures')}</h2>
            <div className="row">
              <span>{t('cleared')}</span>
              <span className="amount">{money(preview.cleared_minor)}</span>
            </div>
            <div className="row">
              <span>{t('statement')}</span>
              <span className="amount">{money(preview.statement_minor)}</span>
            </div>
            <div className="row">
              <strong>{t('difference')}</strong>
              <strong className="amount">{preview.difference_minor === 0 ? t('none') : money(preview.difference_minor, true)}</strong>
            </div>

            {preview.difference_minor === 0 ? (
              <p className="small muted" style={{ marginTop: '0.75rem' }}>{t('balanced')}</p>
            ) : (
              <fieldset className="choice" style={{ marginTop: '0.75rem' }}>
                <legend>{t('adjustmentTitle', { amount: money(preview.adjustment_minor, true) })}</legend>
                <p className="small muted">{t('adjustmentIntro')}</p>
                <label className="check">
                  <input type="radio" name="counter" checked={counter === 'ADJ'} onChange={() => setCounter('ADJ')} />
                  <span>
                    {t('unexplained')}
                    <span className="hint" style={{ display: 'block' }}>{t('unexplainedHint')}</span>
                  </span>
                </label>
                <label className="check">
                  <input type="radio" name="counter" checked={counter !== 'ADJ'} onChange={() => setCounter(categoryOptions[0]?.id ?? 'ADJ')} />
                  <span>
                    {t('asCategory')}
                    <span className="hint" style={{ display: 'block' }}>{t('asCategoryHint')}</span>
                  </span>
                </label>
                {counter !== 'ADJ' && (
                  <div className="field">
                    <label htmlFor="counter-category">{t('category')}</label>
                    <select id="counter-category" value={counter} onChange={(event) => setCounter(event.target.value)}>
                      {categoryOptions.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </fieldset>
            )}
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void finish()} style={{ marginTop: '0.75rem' }}>
              {preview.difference_minor === 0 ? t('finish') : t('finishWithAdjustment')}
            </button>
            <p className="small muted" style={{ marginTop: '0.5rem' }}>{t('lockNote')}</p>
          </section>
        </>
      )}
    </AppShell>
  );
}
