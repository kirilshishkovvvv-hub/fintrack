'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { signedMoney } from '@/components/TransactionRow';
import { useUndo } from '@/components/UndoToast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { loadAccounts, loadCategories, loadSummary, notifyDataChanged, useApiData, type Transaction } from '@/lib/use-api';

/** Deleted transactions, recoverable for 30 days and then removed for good (FR-19, OD-05). */
export default function TrashPage() {
  const t = useTranslations('trash');
  const tKinds = useTranslations('transactions.kinds');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const offerUndo = useUndo();
  const [error, setError] = useState<string | null>(null);
  const { data, failed, reload } = useApiData(async () => {
    const [trash, accounts, categories, summary] = await Promise.all([
      api<{ items: (Transaction & { purgeAfter: string })[] }>('GET', '/api/v1/trash').then((r) => r.items),
      loadAccounts(),
      loadCategories(),
      loadSummary(),
    ]);
    return { trash, accounts, categories, currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  async function restore(tx: Transaction) {
    setError(null);
    try {
      const result = await api<Transaction>('POST', `/api/v1/transactions/${tx.id}/restore`, { idempotencyKey: newIdempotencyKey() });
      offerUndo(t('restored'), result.undo);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    }
  }

  const accounts = new Map((data?.accounts ?? []).map((account) => [account.id, account]));
  const categories = new Map((data?.categories ?? []).map((category) => [category.id, category]));
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <section className="card" aria-live="polite">
        {!data ? (
          <p>{tApp('loading')}</p>
        ) : data.trash.length === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          data.trash.map((tx) => {
            const category = tx.lines.map((line) => categories.get(line.ledgerAccountId)).find(Boolean);
            return (
              <div className="row" key={tx.id}>
                <div className="row-main">
                  <div className="row-title">{tx.description ?? category?.name ?? tKinds(tx.kind)}</div>
                  <div className="small muted">
                    {tx.date} · {signedMoney(tx, accounts, data.currency)} · {t('removedOn', { date: day(tx.purgeAfter) })}
                  </div>
                </div>
                <button className="btn" type="button" onClick={() => void restore(tx)}>
                  {t('restore')}
                </button>
              </div>
            );
          })
        )}
      </section>
    </AppShell>
  );
}
