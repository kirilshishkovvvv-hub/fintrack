'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { editableAmount } from '@/components/TransactionForm';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatMoney, parseUserAmount } from '@/lib/money';
import { currentMonth, loadCategories, loadSummary, notifyDataChanged, useApiData, type Category } from '@/lib/use-api';

interface BudgetRow {
  categoryId: string;
  name: string;
  archived: boolean;
  limit_minor: number;
  spent_minor: number;
  scheduled_minor: number;
  remaining_minor: number;
  utilization: string;
  over: boolean;
  netRefund: boolean;
  thresholds: number[];
  alerted: number[];
  instalments: { description: string | null; amount_minor: number }[];
}

interface Budgets {
  month: string;
  items: BudgetRow[];
  total: { limit_minor: number; spent_minor: number };
  overall: { limit_minor: number; spent_minor: number; budgetsExceedIt: boolean } | null;
}

/** Spent against limit, truncated to one decimal, with the planned amount apart (FR-07, wireframe 5). */
export default function BudgetsPage() {
  const t = useTranslations('budgets');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [month, setMonth] = useState(currentMonth().from.slice(0, 7));
  const shown = useRef(month);
  const [budgets, setBudgets] = useState<Budgets | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (on: string) => api<Budgets>('GET', `/api/v1/budgets?month=${on}`);
  const { data, failed, reload } = useApiData(async () => {
    const [categories, summary] = await Promise.all([loadCategories(), loadSummary()]);
    setBudgets(await load(shown.current));
    return { categories, currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  const money = (minor: number) => `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), data?.currency ?? 'EUR', locale)}`;

  async function changeMonth(value: string) {
    if (!value) return;
    shown.current = value;
    setMonth(value);
    setBudgets(null);
    setBudgets(await load(value));
  }

  async function put(categoryId: string, body: object) {
    setBusy(true);
    setError(null);
    try {
      setBudgets(await api<Budgets>('PUT', `/api/v1/budgets/${categoryId}/${month}`, { idempotencyKey: newIdempotencyKey(), body }));
      setEditing(null);
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  function saveRow(event: React.FormEvent<HTMLFormElement>, categoryId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const limit = parseUserAmount(String(form.get('limit') ?? ''));
    if (limit === null || limit < 0) return setError(t('badAmount'));
    const thresholds = String(form.get('thresholds') ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
    if (thresholds.length < 1 || thresholds.length > 3 || thresholds.some((value) => !Number.isInteger(value) || value < 1 || value > 200)) return setError(t('badThresholds'));
    void put(categoryId, { limit_minor: limit, thresholds, applyForward: form.get('onlyThisMonth') !== 'on' });
  }

  function saveOverall(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('overall') ?? '').trim();
    const limit = text ? parseUserAmount(text) : null;
    if (text && (limit === null || limit < 0)) return setError(t('badAmount'));
    void put('overall', { limit_minor: limit });
  }

  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const limit = parseUserAmount(String(form.get('limit') ?? ''));
    if (limit === null || limit < 0) return setError(t('badAmount'));
    void put(String(form.get('category')), { limit_minor: limit, applyForward: true }).then(() => target.reset());
  }

  const byId = new Map((data?.categories ?? []).map((category) => [category.id, category]));
  const label = (category: Category) => {
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const taken = new Set(budgets?.items.map((row) => row.categoryId));
  const available = (data?.categories ?? []).filter((category) => category.kind === 'expense' && !category.archived && !taken.has(category.id));
  const state = (row: BudgetRow) => (row.netRefund ? t('stateNetRefund') : row.over ? t('stateOver') : row.alerted.length > 0 && row.spent_minor * 100 >= row.limit_minor * Math.max(...row.alerted) ? t('stateNear') : t('stateOk'));
  const width = (row: BudgetRow) => (row.limit_minor === 0 ? (row.spent_minor > 0 ? 100 : 0) : Math.max(0, Math.min(100, (row.spent_minor / row.limit_minor) * 100)));

  return (
    <AppShell>
      <p className="small">
        <Link href="/plan">{t('backToPlan')}</Link>
      </p>
      <h1>{t('title')}</h1>
      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor="month">{t('month')}</label>
        <input id="month" type="month" value={month} onChange={(event) => void changeMonth(event.target.value)} />
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {budgets?.overall?.budgetsExceedIt && <p className="notice notice-warning small">{t('overallExceeded', { amount: money(budgets.overall.limit_minor) })}</p>}
      <section className="card" aria-live="polite">
        {!data || !budgets ? (
          <p>{tApp('loading')}</p>
        ) : budgets.items.length === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          <>
            {budgets.items.map((row) => (
              <div className="import-row" key={row.categoryId}>
                <div className="row" style={{ borderTop: 0 }}>
                  <div className="row-main">
                    <div className="row-title">
                      {row.name}
                      <span className="badge">{state(row)}</span>
                    </div>
                    <div className="small muted">
                      {t('spentOf', { spent: money(row.spent_minor), limit: money(row.limit_minor) })} · {row.utilization === 'over' ? t('overShort') : row.utilization}
                    </div>
                    <div className="small muted">
                      {row.remaining_minor < 0 ? t('overBy', { amount: money(-row.remaining_minor) }) : t('remaining', { amount: money(row.remaining_minor) })}
                      {row.scheduled_minor > 0 ? ` · ${t('scheduled', { amount: money(row.scheduled_minor) })}` : ''}
                    </div>
                  </div>
                  <button className="btn btn-ghost" type="button" aria-label={t('editNamed', { name: row.name })} onClick={() => setEditing(editing === row.categoryId ? null : row.categoryId)}>
                    {t('edit')}
                  </button>
                </div>
                {row.instalments.map((line, index) => (
                  <p className="small muted" key={index}>
                    {t('includesInstalment', { name: line.description ?? t('instalmentPurchase'), amount: money(line.amount_minor) })}
                  </p>
                ))}
                <div className="split-bar" aria-hidden="true">
                  <span style={{ width: `${width(row)}%`, background: row.over ? 'var(--danger)' : 'var(--brand)' }} />
                </div>
                {editing === row.categoryId && (
                  <form onSubmit={(event) => saveRow(event, row.categoryId)}>
                    <div className="field">
                      <label htmlFor={`limit-${row.categoryId}`}>{t('limit')}</label>
                      <input id={`limit-${row.categoryId}`} name="limit" type="text" inputMode="decimal" defaultValue={editableAmount(row.limit_minor)} required />
                    </div>
                    <div className="field">
                      <label htmlFor={`thresholds-${row.categoryId}`}>{t('thresholds')}</label>
                      <input id={`thresholds-${row.categoryId}`} name="thresholds" type="text" inputMode="numeric" defaultValue={row.thresholds.join(', ')} />
                    </div>
                    <label className="check">
                      <input type="checkbox" name="onlyThisMonth" /> <span>{t('onlyThisMonth')}</span>
                    </label>
                    <div className="actions">
                      <button className="btn btn-primary" type="submit" disabled={busy}>
                        {t('save')}
                      </button>
                      <button className="btn" type="button" disabled={busy} onClick={() => void put(row.categoryId, { limit_minor: null })}>
                        {t('remove')}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ))}
            <div className="row">
              <strong>{t('total')}</strong>
              <strong className="amount">{t('spentOf', { spent: money(budgets.total.spent_minor), limit: money(budgets.total.limit_minor) })}</strong>
            </div>
          </>
        )}
      </section>
      <p className="small muted">{t('notMoney')}</p>
      {budgets && (
        <form className="card" onSubmit={saveOverall} key={budgets.overall?.limit_minor ?? 'none'}>
          <div className="field">
            <label htmlFor="overall">{t('overall')}</label>
            <input id="overall" name="overall" type="text" inputMode="decimal" defaultValue={budgets.overall ? editableAmount(budgets.overall.limit_minor) : ''} aria-describedby="overall-hint" />
            <span id="overall-hint" className="hint">
              {budgets.overall ? t('overallSpent', { amount: money(budgets.overall.spent_minor) }) : t('overallHint')}
            </span>
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {t('overallSave')}
          </button>
        </form>
      )}
      {data && available.length > 0 && (
        <form className="card" onSubmit={add}>
          <h2>{t('addTitle')}</h2>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="category">{t('category')}</label>
              <select id="category" name="category">
                {available.map((category) => (
                  <option key={category.id} value={category.id}>
                    {label(category)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="new-limit">{t('limit')}</label>
              <input id="new-limit" name="limit" type="text" inputMode="decimal" required />
            </div>
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {t('add')}
          </button>
        </form>
      )}
    </AppShell>
  );
}
