'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AccountRow } from '@/components/AccountRow';
import { AppShell } from '@/components/AppShell';
import { MonthColumns } from '@/components/Charts';
import { SafeToSpendCard } from '@/components/SafeToSpendCard';
import { TransactionRow } from '@/components/TransactionRow';
import { api } from '@/lib/api';
import { dateLocale, formatDay, formatMoney } from '@/lib/money';
import type { SafeToSpend } from '@/lib/plan';
import { active, currentMonth, useApiData, type Account, type Category, type Transaction } from '@/lib/use-api';

interface Dashboard {
  period: { from: string; to: string };
  asOf: string;
  currency: string;
  safeToSpend: SafeToSpend;
  cashBalance_minor: number;
  assets_minor: number;
  liabilities_minor: number;
  netWorth_minor: number;
  income_minor: number;
  expenses_minor: number;
  netResult_minor: number;
  spending: { categoryId: string; name: string; total_minor: number }[];
  budgets: { month: string; items: { categoryId: string; name: string; limit_minor: number; spent_minor: number; utilization: string; over: boolean; netRefund: boolean; alerted: number[] }[] };
  upcoming: { count: number; overdue: number; items: { id: string; name: string; kind: string; dueDate: string; amount_minor: number; overdue: boolean }[] };
  goals: { id: string; name: string; progress_minor: number; target_minor: number | null; shortfall_minor: number }[];
  recent: Transaction[];
  trend: { month: string; income_minor: number; expenses_minor: number; netResult_minor: number }[];
  uncategorized: { categoryId: string; kind: string; total_minor: number }[];
  hasPayday: boolean;
  hasPlans: boolean;
  accounts: Account[];
  categories: Category[];
}

type Preset = 'thisMonth' | 'lastMonth' | 'thisYear' | 'lastYear' | 'custom';

function rangeFor(preset: Preset, today: string): { from: string; to: string } | null {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  switch (preset) {
    case 'thisMonth':
      return { from: iso(year, month, 1), to: iso(year, month + 1, 0) };
    case 'lastMonth':
      return { from: iso(year, month - 1, 1), to: iso(year, month, 0) };
    case 'thisYear':
      return { from: iso(year, 1, 1), to: iso(year, 12, 31) };
    case 'lastYear':
      return { from: iso(year - 1, 1, 1), to: iso(year - 1, 12, 31) };
    case 'custom':
      return null;
  }
}

/** FR-14: Safe to Spend first, then the period's figures, each one a link to the lines behind it. */
export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const today = currentMonth();
  const [preset, setPreset] = useState<Preset>('thisMonth');
  const [custom, setCustom] = useState(today);
  const period = useRef(today);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);

  const load = (range: { from: string; to: string }) => api<Dashboard>('GET', `/api/v1/dashboard?from=${range.from}&to=${range.to}`);
  const { data, failed, reload } = useApiData(async () => {
    setDashboard(await load(period.current));
    return true;
  });

  if (failed) {
    return (
      <AppShell>
        <p className="notice notice-error" role="alert">
          {tApp('genericError')}{' '}
          <button className="btn" type="button" onClick={() => void reload()}>
            {tApp('retry')}
          </button>
        </p>
      </AppShell>
    );
  }
  if (!data || !dashboard) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }

  async function show(range: { from: string; to: string }) {
    if (range.from > range.to) return;
    period.current = range;
    setDashboard(await load(range));
  }

  function choose(next: Preset) {
    setPreset(next);
    const range = rangeFor(next, dashboard!.safeToSpend.window.from);
    void show(range ?? custom);
  }

  const d = dashboard;
  const { accounts, categories } = d;
  const currency = d.currency;
  const money = (minor: number) => formatMoney(Math.abs(minor), currency, locale);
  const signed = (minor: number) => `${minor < 0 ? '−' : ''}${money(minor)}`;
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const span = `from=${d.period.from}&to=${d.period.to}`;
  const largest = Math.max(1, ...d.spending.map((row) => row.total_minor));
  const asOfToday = d.asOf === d.safeToSpend.window.from;
  const monthLabel = (value: string) => new Intl.DateTimeFormat(dateLocale(locale), { month: 'short', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`));
  const tick = (minor: number) => new Intl.NumberFormat(dateLocale(locale), { notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

  return (
    <AppShell>
      <SafeToSpendCard sts={d.safeToSpend} currency={currency} />

      {!d.hasPayday && (
        <p className="notice notice-info small">
          {t('whenPaid')} <Link href="/plan/rules/new?payday=1">{t('whenPaidLink')}</Link>
        </p>
      )}
      {!d.hasPlans && (
        <p className="notice notice-info small">
          {t('addBillsPrompt')} <Link href="/plan/rules/new">{t('addBillsLink')}</Link>
        </p>
      )}

      {d.uncategorized.map((item) => (
        <p className="notice notice-warning small" key={item.categoryId}>
          {t(item.kind === 'income' ? 'uncategorizedIncome' : 'uncategorizedExpense', { amount: money(item.total_minor) })}{' '}
          <Link href={`/transactions?categoryId=${item.categoryId}`}>{t('uncategorizedLink')}</Link>
        </p>
      ))}

      <section className="card" aria-labelledby="period-title">
        <h2 id="period-title">{t('periodTitle')}</h2>
        <div className="field">
          <label htmlFor="period">{t('period')}</label>
          <select id="period" value={preset} onChange={(event) => choose(event.target.value as Preset)}>
            {(['thisMonth', 'lastMonth', 'thisYear', 'lastYear', 'custom'] as const).map((option) => (
              <option key={option} value={option}>
                {t(`periods.${option}`)}
              </option>
            ))}
          </select>
        </div>
        {preset === 'custom' && (
          <div className="grid-2">
            <div className="field">
              <label htmlFor="period-from">{t('from')}</label>
              <input
                id="period-from"
                type="date"
                value={custom.from}
                onChange={(event) => {
                  const next = { ...custom, from: event.target.value };
                  setCustom(next);
                  if (next.from && next.to) void show(next);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="period-to">{t('to')}</label>
              <input
                id="period-to"
                type="date"
                value={custom.to}
                onChange={(event) => {
                  const next = { ...custom, to: event.target.value };
                  setCustom(next);
                  if (next.from && next.to) void show(next);
                }}
              />
            </div>
          </div>
        )}
        <Link className="row row-link" href={`/transactions?${span}&measure=income`}>
          <span>{t('income')}</span>
          <span className="amount" data-testid="income">
            {signed(d.income_minor)}
          </span>
        </Link>
        <Link className="row row-link" href={`/transactions?${span}&measure=expense`}>
          <span>{t('expenses')}</span>
          <span className="amount" data-testid="expenses">
            {signed(d.expenses_minor)}
          </span>
        </Link>
        <div className="row">
          <strong>{t('netResult')}</strong>
          <strong className="amount">{signed(d.netResult_minor)}</strong>
        </div>
      </section>

      <section className="card" aria-labelledby="worth-title">
        <h2 id="worth-title">{t('netWorth')}</h2>
        <p className="amount" style={{ fontSize: '1.35rem' }} data-testid="net-worth">
          {signed(d.netWorth_minor)}
        </p>
        <p className="small muted">{asOfToday ? t('asOfToday') : t('asOf', { date: formatDay(d.asOf, locale) })}</p>
        <div className="row">
          <span>{t('assets')}</span>
          <span className="amount">{signed(d.assets_minor)}</span>
        </div>
        <div className="row">
          <span>{t('liabilities')}</span>
          <span className="amount">{signed(d.liabilities_minor)}</span>
        </div>
        <div className="row">
          <span>{t('cashBalance')}</span>
          <span className="amount">{signed(d.cashBalance_minor)}</span>
        </div>
        <Link href="/reports?tab=netWorth" className="small">
          {t('seeNetWorth')}
        </Link>
      </section>

      <section className="card" aria-labelledby="spending-title">
        <h2 id="spending-title">{t('spendingByCategory')}</h2>
        {d.spending.length === 0 ? (
          <p className="muted">{t('noSpending')}</p>
        ) : (
          d.spending.map((row) => (
            <div key={row.categoryId}>
              <Link className="row row-link" style={{ borderTop: 0 }} href={`/transactions?${span}&measure=expense&categoryId=${row.categoryId}`}>
                <span>{row.name}</span>
                <span className="amount">{signed(row.total_minor)}</span>
              </Link>
              <div className="split-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(0, (row.total_minor / largest) * 100)}%`, background: 'var(--series-1)' }} />
              </div>
            </div>
          ))
        )}
        <Link href={`/reports?tab=categories`} className="small">
          {t('seeReports')}
        </Link>
      </section>

      <section className="card" aria-labelledby="trend-title">
        <h2 id="trend-title">{t('trend')}</h2>
        <MonthColumns
          label={t('trend')}
          labels={d.trend.map((row) => monthLabel(row.month))}
          series={[
            { name: t('income'), color: '--series-1', values: d.trend.map((row) => row.income_minor) },
            { name: t('expenses'), color: '--series-2', values: d.trend.map((row) => row.expenses_minor) },
          ]}
          money={signed}
          tick={tick}
        />
        <Link href="/reports?tab=income" className="small">
          {t('seeTrendTable')}
        </Link>
      </section>

      <section className="card" aria-labelledby="budget-title">
        <h2 id="budget-title">{t('budgetStatus')}</h2>
        {d.budgets.items.length === 0 ? (
          <p className="muted">{t('noBudgets')}</p>
        ) : (
          d.budgets.items.map((row) => (
            <div key={row.categoryId}>
              <div className="row" style={{ borderTop: 0 }}>
                <span>
                  {row.name}
                  {row.over && <span className="badge">{t('overBudget')}</span>}
                </span>
                <span className="amount small">{t('spentOf', { spent: signed(row.spent_minor), limit: money(row.limit_minor) })}</span>
              </div>
              <div className="split-bar" aria-hidden="true">
                <span style={{ width: `${row.limit_minor === 0 ? (row.spent_minor > 0 ? 100 : 0) : Math.max(0, Math.min(100, (row.spent_minor / row.limit_minor) * 100))}%`, background: row.over ? 'var(--danger)' : 'var(--series-1)' }} />
              </div>
            </div>
          ))
        )}
        <Link href="/budgets" className="small">
          {t('seeBudgets')}
        </Link>
      </section>

      <section className="card" aria-labelledby="upcoming-title">
        <h2 id="upcoming-title">{t('upcoming')}</h2>
        {d.upcoming.count === 0 ? (
          <p className="muted">{t('noUpcoming')}</p>
        ) : (
          d.upcoming.items.map((item) => (
            <div className="row" key={item.id}>
              <span>
                {item.name}
                {item.overdue && <span className="badge">{t('overdueBadge')}</span>}
                <br />
                <span className="small muted">{formatDay(item.dueDate, locale)}</span>
              </span>
              <span className="amount">
                {item.kind === 'income' ? '+' : '−'}
                {money(item.amount_minor)}
              </span>
            </div>
          ))
        )}
        <Link href="/plan" className="small">
          {d.upcoming.count > d.upcoming.items.length ? t('seeAllUpcoming', { count: d.upcoming.count }) : t('seePlan')}
        </Link>
      </section>

      <section className="card" aria-labelledby="goals-title">
        <h2 id="goals-title">{t('goals')}</h2>
        {d.goals.length === 0 ? (
          <p className="muted">{t('noGoals')}</p>
        ) : (
          d.goals.map((goal) => (
            <div key={goal.id}>
              <div className="row" style={{ borderTop: 0 }}>
                <span>
                  {goal.name}
                  {goal.shortfall_minor > 0 && <span className="badge">{t('goalShort', { amount: money(goal.shortfall_minor) })}</span>}
                </span>
                <span className="amount small">{goal.target_minor ? t('spentOf', { spent: money(goal.progress_minor), limit: money(goal.target_minor) }) : money(goal.progress_minor)}</span>
              </div>
              {goal.target_minor !== null && (
                <div className="split-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, (goal.progress_minor / goal.target_minor) * 100)}%`, background: 'var(--series-1)' }} />
                </div>
              )}
            </div>
          ))
        )}
        <Link href="/goals" className="small">
          {t('seeGoals')}
        </Link>
      </section>

      <section className="card" aria-labelledby="accounts-title">
        <h2 id="accounts-title">{t('accounts')}</h2>
        {accounts.length === 0 ? (
          <p className="muted">{t('noAccounts')}</p>
        ) : (
          active(accounts).map((account) => <AccountRow key={account.id} account={account} currency={currency} />)
        )}
        <div className="actions" style={{ marginTop: '0.75rem' }}>
          <Link href="/accounts/new" className="btn">
            {t('addAccount')}
          </Link>
          <Link href="/transactions/new" className="btn btn-primary">
            {t('addTransaction')}
          </Link>
        </div>
      </section>

      <section className="card" aria-labelledby="recent-title">
        <h2 id="recent-title">{t('recent')}</h2>
        {d.recent.length === 0 ? (
          <p className="muted">{t('noTransactions')}</p>
        ) : (
          d.recent.map((tx) => <TransactionRow key={tx.id} tx={tx} accounts={accountMap} categories={categoryMap} currency={currency} />)
        )}
        <Link href="/transactions" className="small">
          {t('seeAll')}
        </Link>
      </section>
    </AppShell>
  );
}
