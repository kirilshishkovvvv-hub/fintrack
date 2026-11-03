'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { loadCategories, notifyDataChanged, useApiData, type Category } from '@/lib/use-api';

/** Categories: archive, unarchive and merge (FR-05, E-59). Nothing is deleted; history stays. */
export default function CategoriesPage() {
  const t = useTranslations('categories');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const [merging, setMerging] = useState<Category | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const { data } = useApiData(loadCategories);

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      key.current = newIdempotencyKey();
      setMerging(null);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  const archive = (category: Category) =>
    run(async () => {
      await api('POST', `/api/v1/categories/${category.id}/${category.archived ? 'unarchive' : 'archive'}`, { idempotencyKey: key.current });
      return category.archived ? t('unarchived', { name: category.name }) : t('archivedNotice', { name: category.name });
    });

  function merge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!merging) return;
    const intoId = String(new FormData(event.currentTarget).get('into'));
    const into = data?.find((category) => category.id === intoId);
    void run(async () => {
      await api('POST', `/api/v1/categories/${merging.id}/merge`, { idempotencyKey: key.current, body: { intoId } });
      return t('merged', { from: merging.name, into: into?.name ?? '' });
    });
  }

  const byId = new Map((data ?? []).map((category) => [category.id, category]));
  const label = (category: Category) => {
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const groups = (['expense', 'income'] as const).map((kind) => ({
    kind,
    items: (data ?? []).filter((category) => category.kind === kind).sort((a, b) => label(a).localeCompare(label(b))),
  }));

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
      {merging && (
        <form className="card" onSubmit={merge}>
          <h2>{t('mergeTitle', { name: merging.name })}</h2>
          <p className="small muted">{t('mergeIntro')}</p>
          <div className="field">
            <label htmlFor="into">{t('mergeInto')}</label>
            <select id="into" name="into" required>
              {(data ?? [])
                .filter((category) => category.kind === merging.kind && category.id !== merging.id && !category.archived)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {label(category)}
                  </option>
                ))}
            </select>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('mergeSubmit')}
            </button>
            <button className="btn" type="button" onClick={() => setMerging(null)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      )}
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : (
        groups.map((group) => (
          <section className="card" key={group.kind} aria-labelledby={`${group.kind}-title`}>
            <h2 id={`${group.kind}-title`}>{t(group.kind)}</h2>
            {group.items.map((category) => (
              <div className={`row${category.archived ? ' muted' : ''}`} key={category.id}>
                <div className="row-main">
                  <div className="row-title">
                    {label(category)}
                    {category.archived && <span className="badge">{t('archivedBadge')}</span>}
                  </div>
                </div>
                <div className="actions">
                  {!category.archived && (
                    <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setMerging(category)}>
                      {t('merge')}
                    </button>
                  )}
                  <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void archive(category)}>
                    {category.archived ? t('unarchive') : t('archive')}
                  </button>
                </div>
              </div>
            ))}
          </section>
        ))
      )}
    </AppShell>
  );
}
