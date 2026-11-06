'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { TransactionRow } from '@/components/TransactionRow';
import { api } from '@/lib/api';
import { formatDay, formatMoney, parseUserAmount } from '@/lib/money';
import { currentMonth, loadAccounts, loadCategories, loadSummary, useApiData, type Transaction } from '@/lib/use-api';

interface SearchResult {
  items: (Transaction & { effect_minor: number })[];
  count: number;
  total_minor: number;
  nextCursor: string | null;
}

interface Filters {
  from: string;
  to: string;
  q: string;
  accountId: string;
  categoryId: string;
  payeeId: string;
  kind: string;
  origin: string;
  reconciled: string;
  min: string;
  max: string;
}

const PAGE_SIZE = 50;
const KINDS = ['expense', 'income', 'transfer', 'refund', 'debt_payment', 'split', 'opening_balance', 'adjustment', 'valuation'];

/** Activity: search and filter on the server, with its total over all matches (BR-04.5, AC-04.5). */
function Activity() {
  const t = useTranslations('transactions');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const params = useSearchParams();
  const month = currentMonth();
  const [filters, setFilters] = useState<Filters>({
    from: params.get('from') ?? month.from,
    to: params.get('to') ?? month.to,
    q: '',
    accountId: params.get('accountId') ?? '',
    categoryId: params.get('categoryId') ?? '',
    payeeId: '',
    kind: '',
    origin: '',
    reconciled: '',
    min: '',
    max: '',
  });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Kept out of the filter form: it says what is being added up, not which lines to look at.
  const measure = params.get('measure') === 'income' ? 'income' : params.get('measure') === 'expense' ? 'expense' : null;
  // Read by the loader, which also runs again after any change elsewhere on the page.
  const shown = useRef(filters);

  function queryOf(current: Filters, cursor?: string | null): string {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    for (const key of ['from', 'to', 'q', 'accountId', 'categoryId', 'payeeId', 'kind', 'origin', 'reconciled'] as const) {
      if (current[key].trim()) query.set(key, current[key].trim());
    }
    const min = current.min.trim() ? parseUserAmount(current.min) : null;
    const max = current.max.trim() ? parseUserAmount(current.max) : null;
    if (min !== null) query.set('minAmount_minor', String(Math.abs(min)));
    if (max !== null) query.set('maxAmount_minor', String(Math.abs(max)));
    if (cursor) query.set('cursor', cursor);
    if (measure) query.set('measure', measure);
    return query.toString();
  }

  const search = (current: Filters, cursor?: string | null) => api<SearchResult>('GET', `/api/v1/transactions?${queryOf(current, cursor)}`);

  const { data, failed, reload } = useApiData(async () => {
    const [summary, accounts, categories, payees] = await Promise.all([
      loadSummary(),
      loadAccounts(),
      loadCategories(),
      api<{ items: { id: string; name: string; archived: boolean }[] }>('GET', '/api/v1/payees').then((r) => r.items),
    ]);
    setResult(await search(shown.current));
    return { currency: summary.currency, accounts, categories, payees };
  });
  if (failed) return <LoadError retry={reload} />;

  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ([filters.min, filters.max].some((value) => value.trim() !== '' && parseUserAmount(value) === null)) {
      setProblem(t('badAmount'));
      return;
    }
    if (filters.from && filters.to && filters.from > filters.to) {
      setProblem(t('badDates'));
      return;
    }
    setProblem(null);
    shown.current = filters;
    setResult(null);
    try {
      setResult(await search(filters));
    } catch {
      setProblem(tApp('genericError'));
    }
  }

  async function loadMore() {
    if (!result?.nextCursor) return;
    try {
      const next = await search(shown.current, result.nextCursor);
      setResult({ ...next, items: [...result.items, ...next.items] });
    } catch {
      setProblem(tApp('genericError'));
    }
  }

  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));
  const accounts = new Map((data?.accounts ?? []).map((account) => [account.id, account]));
  const categories = new Map((data?.categories ?? []).map((category) => [category.id, category]));
  const categoryLabel = (id: string) => {
    const category = categories.get(id)!;
    const parent = category.parentId ? categories.get(category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const groups: { date: string; items: SearchResult['items'] }[] = [];
  for (const tx of result?.items ?? []) {
    const last = groups.at(-1);
    if (last?.date === tx.date) last.items.push(tx);
    else groups.push({ date: tx.date, items: [tx] });
  }
  const total = result?.total_minor ?? 0;
  const money = (minor: number) => (measure ? `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), data?.currency ?? 'EUR')}` : `${minor < 0 ? '−' : minor > 0 ? '+' : ''}${formatMoney(Math.abs(minor), data?.currency ?? 'EUR')}`);
  const selectedAccount = shown.current.accountId;

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <form className="card" onSubmit={apply} role="search">
        <div className="field">
          <label htmlFor="q">{t('search')}</label>
          <input id="q" type="search" value={filters.q} maxLength={100} onChange={(event) => set({ q: event.target.value })} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="from">{t('fromDate')}</label>
            <input id="from" type="date" value={filters.from} onChange={(event) => set({ from: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="to">{t('toDate')}</label>
            <input id="to" type="date" value={filters.to} onChange={(event) => set({ to: event.target.value })} />
          </div>
        </div>
        <details>
          <summary>{t('moreFilters')}</summary>
          <div className="grid-2" style={{ marginTop: '0.75rem' }}>
            <div className="field">
              <label htmlFor="filter-account">{t('account')}</label>
              <select id="filter-account" value={filters.accountId} onChange={(event) => set({ accountId: event.target.value })}>
                <option value="">{t('any')}</option>
                {data?.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="filter-category">{t('category')}</label>
              <select id="filter-category" value={filters.categoryId} onChange={(event) => set({ categoryId: event.target.value })}>
                <option value="">{t('any')}</option>
                {data?.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {categoryLabel(category.id)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="filter-payee">{t('payee')}</label>
              <select id="filter-payee" value={filters.payeeId} onChange={(event) => set({ payeeId: event.target.value })}>
                <option value="">{t('any')}</option>
                {data?.payees.filter((payee) => !payee.archived).map((payee) => (
                  <option key={payee.id} value={payee.id}>
                    {payee.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="filter-kind">{t('kind')}</label>
              <select id="filter-kind" value={filters.kind} onChange={(event) => set({ kind: event.target.value })}>
                <option value="">{t('any')}</option>
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kinds.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="filter-min">{t('minAmount')}</label>
              <input id="filter-min" type="text" inputMode="decimal" value={filters.min} onChange={(event) => set({ min: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="filter-max">{t('maxAmount')}</label>
              <input id="filter-max" type="text" inputMode="decimal" value={filters.max} onChange={(event) => set({ max: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="filter-origin">{t('source')}</label>
              <select id="filter-origin" value={filters.origin} onChange={(event) => set({ origin: event.target.value })}>
                <option value="">{t('any')}</option>
                <option value="manual">{t('origins.manual')}</option>
                <option value="import">{t('origins.import')}</option>
                <option value="system">{t('origins.system')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="filter-reconciled">{t('reconciledState')}</label>
              <select id="filter-reconciled" value={filters.reconciled} onChange={(event) => set({ reconciled: event.target.value })}>
                <option value="">{t('any')}</option>
                <option value="true">{t('reconciledYes')}</option>
                <option value="false">{t('reconciledNo')}</option>
              </select>
            </div>
          </div>
        </details>
        {problem && (
          <p className="notice notice-error" role="alert">
            {problem}
          </p>
        )}
        <button className="btn btn-primary" type="submit">
          {t('apply')}
        </button>
      </form>

      <section className="card" aria-live="polite" aria-label={t('results')}>
        {!data || !result ? (
          <p>{tApp('loading')}</p>
        ) : result.count === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          <>
            <div className="row" style={{ borderTop: 0 }}>
              <span>{t('resultCount', { count: result.count })}</span>
              <strong className="amount" data-testid="search-total">
                {money(total)}
              </strong>
            </div>
            <p className="small muted">{measure ? t(measure === 'income' ? 'totalNoteIncome' : 'totalNoteSpending') : selectedAccount ? t('totalNoteAccount') : t('totalNote')}</p>
            {groups.map((group) => (
              <div key={group.date}>
                <h2 className="date-heading">{formatDay(group.date, locale)}</h2>
                {group.items.map((tx) => (
                  <TransactionRow key={tx.id} tx={tx} accounts={accounts} categories={categories} currency={data.currency} effect={measure ? (measure === 'expense' ? -tx.effect_minor : tx.effect_minor) : selectedAccount ? tx.effect_minor : undefined} hideDate />
                ))}
              </div>
            ))}
            {result.nextCursor && (
              <button className="btn" type="button" style={{ marginTop: '0.75rem' }} onClick={() => void loadMore()}>
                {t('more')}
              </button>
            )}
          </>
        )}
      </section>
      <div className="actions" style={{ alignItems: 'center' }}>
        <Link href="/import" className="btn">
          {t('importLink')}
        </Link>
        <Link href="/trash" className="small">
          {t('trashLink')}
        </Link>
      </div>
    </AppShell>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense>
      <Activity />
    </Suspense>
  );
}
