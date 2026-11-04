'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { active, loadCategories, notifyDataChanged, useApiData } from '@/lib/use-api';

interface Payee {
  id: string;
  name: string;
  defaultCategoryId: string | null;
  defaultIsExplicit: boolean;
  archived: boolean;
  version: number;
}

/** Payees (BR-05.6): rename, choose a default category, merge. They're created by naming them on a transaction. */
export default function PayeesPage() {
  const t = useTranslations('payees');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const [merging, setMerging] = useState<Payee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data, failed, reload } = useApiData(async () => {
    const [payees, categories] = await Promise.all([api<{ items: Payee[] }>('GET', '/api/v1/payees').then((r) => r.items), loadCategories()]);
    return { payees: payees.filter((payee) => !payee.archived), categories: active(categories) };
  });
  if (failed) return <LoadError retry={reload} />;

  async function run(work: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      setMerging(null);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      await reload();
    }
  }

  const update = (payee: Payee, body: object, done?: string) => run(() => api('PATCH', `/api/v1/payees/${payee.id}`, { ifMatch: payee.version, body }), done);

  function merge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!merging) return;
    const intoId = String(new FormData(event.currentTarget).get('into'));
    void run(() => api('POST', `/api/v1/payees/${merging.id}/merge`, { idempotencyKey: newIdempotencyKey(), body: { intoId } }), t('merged'));
  }

  return (
    <AppShell>
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
      {merging && data && (
        <form className="card" onSubmit={merge}>
          <h2>{t('mergeTitle', { name: merging.name })}</h2>
          <p className="small muted">{t('mergeIntro')}</p>
          <div className="field">
            <label htmlFor="into">{t('mergeInto')}</label>
            <select id="into" name="into" required>
              {data.payees.filter((payee) => payee.id !== merging.id).map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
            </select>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit">
              {t('merge')}
            </button>
            <button className="btn" type="button" onClick={() => setMerging(null)}>
              {tApp('cancel')}
            </button>
          </div>
        </form>
      )}
      <section className="card" aria-live="polite">
        {!data ? (
          <p>{tApp('loading')}</p>
        ) : data.payees.length === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          data.payees.map((payee) => (
            <div className="import-row" key={`${payee.id}-${payee.version}`}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={`name-${payee.id}`}>{t('name')}</label>
                  <input
                    id={`name-${payee.id}`}
                    type="text"
                    maxLength={100}
                    defaultValue={payee.name}
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name && name !== payee.name) void update(payee, { name });
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`category-${payee.id}`}>{t('defaultCategory')}</label>
                  <select id={`category-${payee.id}`} value={payee.defaultCategoryId ?? ''} onChange={(event) => void update(payee, { defaultCategoryId: event.target.value || null })}>
                    <option value="">{t('noDefault')}</option>
                    {data.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {data.payees.length > 1 && (
                <button className="btn btn-ghost" type="button" aria-label={t('mergeNamed', { name: payee.name })} onClick={() => setMerging(payee)}>
                  {t('merge')}
                </button>
              )}
            </div>
          ))
        )}
      </section>
    </AppShell>
  );
}
