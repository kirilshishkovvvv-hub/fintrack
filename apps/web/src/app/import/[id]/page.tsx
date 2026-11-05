'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api, ApiProblem, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { active, loadAccounts, loadCategories, notifyDataChanged, useApiData } from '@/lib/use-api';

type Decision = 'import' | 'skip' | 'link' | 'transfer';
type RowClass = 'new' | 'duplicate' | 'possible_duplicate' | 'already_recorded' | 'transfer' | 'rejected';

interface Row {
  id: string;
  rowNo: number;
  date: string | null;
  amount_minor: number | null;
  description: string | null;
  classification: RowClass;
  rejectReason: string | null;
  decision: Decision | null;
  categoryId: string | null;
  counterAccountId: string | null;
  candidateTransactionId: string | null;
  createdTransactionId: string | null;
  claimedTransactionId: string | null;
  state: string;
  occurrenceId: string | null;
  planSuggestions: { occurrenceId: string; name: string; dueDate: string; amount_minor: number; outsideExpectedRange: boolean }[];
}

interface Batch {
  id: string;
  accountId: string;
  status: 'review' | 'confirmed' | 'undone' | 'discarded';
  fileName: string | null;
  rowCount: number;
  currency: string;
  currencyAssumed: boolean;
  version: number;
  counts: Partial<Record<RowClass, number>>;
  states: Record<string, number>;
  undecided: number;
  rows: Row[];
}

const OPTIONS: Record<RowClass, Decision[]> = {
  new: ['import', 'transfer', 'skip'],
  duplicate: ['skip', 'import'],
  possible_duplicate: ['link', 'import', 'skip'],
  already_recorded: ['link', 'import', 'skip'],
  transfer: ['transfer', 'import', 'skip'],
  rejected: [],
};
const ORDER: RowClass[] = ['possible_duplicate', 'transfer', 'new', 'already_recorded', 'duplicate', 'rejected'];
const PAGE = 50;

/** Review, confirmation and undo (FR-16 steps 7 to 10, BR-16.6). Nothing is posted until "Confirm". */
export default function ImportReviewPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('import');
  const tErrors = useTranslations('errors');
  const tApp = useTranslations('app');
  const router = useRouter();
  const [saved, setSaved] = useState<Batch | null>(null);
  const [shown, setShown] = useState<Partial<Record<RowClass, number>>>({});
  const [currencyOk, setCurrencyOk] = useState(false);
  const [editedCount, setEditedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const { data, failed, reload } = useApiData(async () => {
    const [batch, accounts, categories] = await Promise.all([api<Batch>('GET', `/api/v1/imports/${id}`), loadAccounts(), loadCategories()]);
    setSaved(batch);
    return { accounts, categories };
  });
  if (failed) return <LoadError retry={reload} />;
  const batch = saved;
  if (!data || !batch) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }

  const review = batch.status === 'review';
  const money = (minor: number | null) => (minor === null ? '—' : `${minor < 0 ? '−' : '+'}${formatMoney(Math.abs(minor), batch.currency)}`);
  const categories = active(data.categories);
  const categoryName = new Map(data.categories.map((category) => {
    const parent = category.parentId ? data.categories.find((other) => other.id === category.parentId) : undefined;
    return [category.id, parent ? `${parent.name} › ${category.name}` : category.name];
  }));
  const others = active(data.accounts).filter((account) => account.id !== batch.accountId);
  const account = data.accounts.find((candidate) => candidate.id === batch.accountId);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.code === 'IMPORT_EDITED') {
        setEditedCount((problem.details as { transactionIds: string[] }).transactionIds.length);
      } else if (problem instanceof ApiProblem && problem.code === 'LOCKED_RECONCILED') {
        setError(t('undoLocked', { count: (problem.details as { transactionIds: string[] }).transactionIds.length }));
      } else {
        setError(errorMessage(problem, tErrors));
      }
      if (problem instanceof ApiProblem && problem.code === 'VERSION_CONFLICT') void reload();
    } finally {
      setBusy(false);
    }
  }

  const change = (decisions: { rowId: string; occurrenceId?: string | null; decision?: Decision; categoryId?: string | null; counterAccountId?: string | null }[]) =>
    run(async () => {
      setSaved(await api<Batch>('PATCH', `/api/v1/imports/${id}/rows`, { ifMatch: batch.version, body: { decisions } }));
    });

  const confirm = () =>
    run(async () => {
      await api('POST', `/api/v1/imports/${id}/confirm`, { idempotencyKey: key.current, body: { confirmCurrency: currencyOk } });
      key.current = newIdempotencyKey();
      notifyDataChanged();
    });

  const undo = (confirmEdited = false) =>
    run(async () => {
      await api('POST', `/api/v1/imports/${id}/undo`, { idempotencyKey: newIdempotencyKey(), body: { confirmEdited } });
      setEditedCount(null);
      notifyDataChanged();
    });

  const discard = () =>
    run(async () => {
      await api('DELETE', `/api/v1/imports/${id}`);
      router.replace('/import');
    });

  const groups = ORDER.map((kind) => ({ kind, rows: batch.rows.filter((row) => row.classification === kind) })).filter((group) => group.rows.length > 0);
  const transfers = batch.rows.filter((row) => row.classification === 'transfer' && row.state === 'pending' && !row.decision);
  const links = batch.rows.filter((row) => row.classification === 'possible_duplicate' && row.state === 'pending' && !row.decision);

  return (
    <AppShell>
      <h1>{batch.fileName ?? t('title')}</h1>
      <p className="small muted">
        {account?.name} · {t('rowCount', { rows: batch.rowCount })} · <span className="badge" style={{ marginLeft: 0 }}>{t(`statuses.${batch.status}`)}</span>
      </p>

      <section className="card" aria-labelledby="summary-title">
        <h2 id="summary-title">{review ? t('reviewTitle') : t('resultTitle')}</h2>
        {review
          ? ORDER.filter((kind) => batch.counts[kind]).map((kind) => (
              <div className="row" key={kind}>
                <span>{t(`classes.${kind}`)}</span>
                <span className="amount">{batch.counts[kind]}</span>
              </div>
            ))
          : Object.entries(batch.states).map(([state, count]) => (
              <div className="row" key={state}>
                <span>{t(`states.${state}`)}</span>
                <span className="amount">{count}</span>
              </div>
            ))}
      </section>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {review && batch.undecided > 0 && (
        <section className="notice notice-warning" style={{ marginBottom: '1rem' }}>
          <p>{t('needsDecision', { count: batch.undecided })}</p>
          <div className="actions">
            {transfers.length > 1 && (
              <button className="btn" type="button" disabled={busy} onClick={() => void change(transfers.map((row) => ({ rowId: row.id, decision: 'transfer' })))}>
                {t('acceptTransfers', { count: transfers.length })}
              </button>
            )}
            {links.length > 1 && (
              <button className="btn" type="button" disabled={busy} onClick={() => void change(links.map((row) => ({ rowId: row.id, decision: 'link' })))}>
                {t('linkAll', { count: links.length })}
              </button>
            )}
          </div>
        </section>
      )}

      {groups.map(({ kind, rows }) => (
        <section className="card" key={kind} aria-labelledby={`group-${kind}`}>
          <h2 id={`group-${kind}`}>{t(`classes.${kind}`)}</h2>
          <p className="small muted">{t(`classHints.${kind}`)}</p>
          {rows.slice(0, shown[kind] ?? PAGE).map((row) => {
            const open = review && OPTIONS[row.classification].length > 0;
            const txId = row.createdTransactionId ?? row.claimedTransactionId ?? row.candidateTransactionId;
            return (
              <div className="import-row" key={row.id}>
                <div className="row" style={{ borderTop: 0, paddingBottom: open ? 0 : undefined }}>
                  <div className="row-main">
                    <div className="row-title">{row.description ?? '—'}</div>
                    <div className="small muted">
                      {row.date ?? '—'}
                      {row.rejectReason ? ` · ${t(`reasons.${row.rejectReason}`)}` : ''}
                      {!open && row.state !== 'rejected' ? ` · ${t(`states.${row.state}`)}` : ''}
                      {txId && row.classification !== 'new' ? (
                        <>
                          {' · '}
                          <Link href={`/transactions/${txId}`}>{t('seeTransaction')}</Link>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="amount">{money(row.amount_minor)}</span>
                </div>
                {review && row.planSuggestions.length > 0 && (
                  <div className="field">
                    <label htmlFor={`plan-${row.id}`}>{t('matchesPlan')}</label>
                    <select id={`plan-${row.id}`} value={row.occurrenceId ?? ''} disabled={busy} onChange={(event) => void change([{ rowId: row.id, occurrenceId: event.target.value || null }])}>
                      <option value="">{t('notThePlan')}</option>
                      {row.planSuggestions.map((plan) => (
                        <option key={plan.occurrenceId} value={plan.occurrenceId}>
                          {plan.name} · {plan.dueDate} · {money(plan.amount_minor)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {open && (
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor={`decision-${row.id}`}>{t('whatToDo')}</label>
                      <select
                        id={`decision-${row.id}`}
                        value={row.decision ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const decision = event.target.value as Decision;
                          void change([{ rowId: row.id, decision, ...(decision === 'transfer' && !row.counterAccountId && others[0] ? { counterAccountId: others[0].id } : {}) }]);
                        }}
                      >
                        {!row.decision && <option value="">{t('choose')}</option>}
                        {OPTIONS[row.classification].map((option) => (
                          <option key={option} value={option}>
                            {t(`decisions.${option}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {row.decision === 'import' && (
                      <div className="field">
                        <label htmlFor={`category-${row.id}`}>{t('category')}</label>
                        <select id={`category-${row.id}`} value={row.categoryId ?? ''} disabled={busy} onChange={(event) => void change([{ rowId: row.id, categoryId: event.target.value || null }])}>
                          <option value="">{t('uncategorized')}</option>
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {categoryName.get(category.id)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {(row.decision === 'transfer' || (!row.decision && row.classification === 'transfer')) && (
                      <div className="field">
                        <label htmlFor={`counter-${row.id}`}>{(row.amount_minor ?? 0) < 0 ? t('transferTo') : t('transferFrom')}</label>
                        <select id={`counter-${row.id}`} value={row.counterAccountId ?? ''} disabled={busy} onChange={(event) => void change([{ rowId: row.id, counterAccountId: event.target.value }])}>
                          {others.map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length > (shown[kind] ?? PAGE) && (
            <button className="btn" type="button" style={{ marginTop: '0.75rem' }} onClick={() => setShown({ ...shown, [kind]: (shown[kind] ?? PAGE) + PAGE })}>
              {t('showMore', { count: rows.length - (shown[kind] ?? PAGE) })}
            </button>
          )}
        </section>
      ))}

      {review && (
        <section className="card" aria-label={t('confirmTitle')}>
          {batch.currencyAssumed && (
            <label className="check" style={{ marginBottom: '0.75rem' }}>
              <input type="checkbox" checked={currencyOk} onChange={(event) => setCurrencyOk(event.target.checked)} />
              <span>{t('currencyConfirm', { currency: batch.currency })}</span>
            </label>
          )}
          <div className="actions">
            <button className="btn btn-primary" type="button" disabled={busy || batch.undecided > 0 || (batch.currencyAssumed && !currencyOk)} onClick={() => void confirm()}>
              {t('confirm')}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void discard()}>
              {t('discard')}
            </button>
          </div>
          <p className="small muted" style={{ marginTop: '0.5rem' }}>{t('confirmNote')}</p>
        </section>
      )}

      {batch.status === 'confirmed' && (
        <section className="card">
          {editedCount !== null ? (
            <div className="notice notice-warning small" role="alert">
              <p>{t('undoEdited', { count: editedCount })}</p>
              <div className="actions">
                <button className="btn" type="button" disabled={busy} onClick={() => void undo(true)}>
                  {t('undoAnyway')}
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setEditedCount(null)}>
                  {t('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="small muted">{t('undoHint')}</p>
              <button className="btn" type="button" disabled={busy} onClick={() => void undo()}>
                {t('undo')}
              </button>
            </>
          )}
        </section>
      )}
    </AppShell>
  );
}
