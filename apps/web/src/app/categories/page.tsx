'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { loadCategories, notifyDataChanged, useApiData, type Category } from '@/lib/use-api';

/** Categories: add, rename, move, reorder, archive and merge (FR-05, E-59). Nothing is deleted; history stays. */
export default function CategoriesPage() {
  const t = useTranslations('categories');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const [merging, setMerging] = useState<Category | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [addKind, setAddKind] = useState<'expense' | 'income'>('expense');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const { data, failed, reload } = useApiData(loadCategories);
  if (failed) return <LoadError retry={reload} />;

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      key.current = newIdempotencyKey();
      setMerging(null);
      setEditing(null);
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

  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const name = String(form.get('name') ?? '').trim();
    const parentId = String(form.get('parent') ?? '');
    if (!name) return setError(t('nameRequired'));
    void run(async () => {
      await api('POST', '/api/v1/categories', { idempotencyKey: key.current, body: { name, kind: addKind, ...(parentId ? { parentId } : {}) } });
      target.reset();
      return t('added', { name });
    });
  }

  function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const parentId = String(form.get('parent') ?? '') || null;
    if (!name) return setError(t('nameRequired'));
    const moved = parentId !== editing.parentId;
    void run(async () => {
      await api('PATCH', `/api/v1/categories/${editing.id}`, { ifMatch: editing.version, body: { name, ...(moved ? { parentId } : {}) } });
      return t('saved', { name });
    });
  }

  /** Swaps a category with its neighbour among the categories under the same parent. */
  function move(category: Category, by: -1 | 1) {
    const siblings = (data ?? []).filter((other) => other.kind === category.kind && other.parentId === category.parentId);
    const from = siblings.indexOf(category);
    const to = from + by;
    if (to < 0 || to >= siblings.length) return;
    [siblings[from], siblings[to]] = [siblings[to]!, siblings[from]!];
    void run(async () => {
      await api('POST', '/api/v1/categories/order', { body: { ids: siblings.map((other) => other.id) } });
      return t('moved', { name: category.name });
    });
  }

  const byId = new Map((data ?? []).map((category) => [category.id, category]));
  const parents = (kind: string, except?: string) => (data ?? []).filter((category) => category.kind === kind && !category.parentId && !category.archived && category.id !== except);
  const hasChildren = (category: Category) => (data ?? []).some((other) => other.parentId === category.id);
  const label = (category: Category) => {
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const groups = (['expense', 'income'] as const).map((kind) => ({
    kind,
    items: (data ?? []).filter((category) => category.kind === kind),
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
      <form className="card" onSubmit={add}>
        <h2>{t('addTitle')}</h2>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="new-name">{t('name')}</label>
            <input id="new-name" name="name" type="text" maxLength={100} required />
          </div>
          <div className="field">
            <label htmlFor="new-kind">{t('kind')}</label>
            <select id="new-kind" value={addKind} onChange={(event) => setAddKind(event.target.value as 'expense' | 'income')}>
              <option value="expense">{t('expense')}</option>
              <option value="income">{t('income')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-parent">{t('parent')}</label>
            <select id="new-parent" name="parent" key={addKind}>
              <option value="">{t('noParent')}</option>
              {parents(addKind).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {t('add')}
        </button>
      </form>
      {editing && (
        <form className="card" onSubmit={saveEdit} key={editing.id}>
          <h2>{t('editTitle', { name: editing.name })}</h2>
          <div className="field">
            <label htmlFor="edit-name">{t('name')}</label>
            <input id="edit-name" name="name" type="text" maxLength={100} defaultValue={editing.name} required />
          </div>
          {!hasChildren(editing) && (
            <div className="field">
              <label htmlFor="edit-parent">{t('parent')}</label>
              <select id="edit-parent" name="parent" defaultValue={editing.parentId ?? ''}>
                <option value="">{t('noParent')}</option>
                {parents(editing.kind, editing.id).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <span className="hint">{t('moveWarning')}</span>
            </div>
          )}
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('save')}
            </button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>
              {t('cancel')}
            </button>
          </div>
        </form>
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
              <div className={`row row-stack${category.archived ? ' muted' : ''}`} key={category.id}>
                <div className="row-main">
                  <div className="row-title">
                    {label(category)}
                    {category.archived && <span className="badge">{t('archivedBadge')}</span>}
                  </div>
                </div>
                <div className="actions">
                  {!category.archived && (
                    <>
                      <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('moveUp', { name: category.name })} onClick={() => move(category, -1)}>
                        ↑
                      </button>
                      <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('moveDown', { name: category.name })} onClick={() => move(category, 1)}>
                        ↓
                      </button>
                      <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('editNamed', { name: category.name })} onClick={() => setEditing(category)}>
                        {t('edit')}
                      </button>
                    </>
                  )}
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
