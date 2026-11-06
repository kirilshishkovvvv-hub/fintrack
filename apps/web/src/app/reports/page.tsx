'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { Lines, MonthColumns } from '@/components/Charts';
import { api, errorMessage } from '@/lib/api';
import { dateLocale, formatDay, formatMoney } from '@/lib/money';
import { currentMonth, loadSummary, useApiData } from '@/lib/use-api';

const TABS = ['income', 'categories', 'comparison', 'budget', 'netWorth', 'projection'] as const;
type Tab = (typeof TABS)[number];

const shiftMonth = (month: string, by: number) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + by, 1)).toISOString().slice(0, 7);
};
const monthEnd = (month: string) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};

/** Reports (FR-15): the same definitions as the dashboard, each with its table and its way to the lines behind it. */
function Reports() {
  const t = useTranslations('reports');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const params = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(requested && TABS.includes(requested) ? requested : 'income');
  const month = currentMonth().from.slice(0, 7);

  const [fromMonth, setFromMonth] = useState(shiftMonth(month, -11));
  const [toMonth, setToMonth] = useState(month);
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(monthEnd(month));
  const [aFrom, setAFrom] = useState(`${shiftMonth(month, -2)}-01`);
  const [aTo, setATo] = useState(monthEnd(shiftMonth(month, -2)));
  const [bFrom, setBFrom] = useState(`${shiftMonth(month, -1)}-01`);
  const [bTo, setBTo] = useState(monthEnd(shiftMonth(month, -1)));
  const [budgetMonth, setBudgetMonth] = useState(month);
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [days, setDays] = useState('30');

  const [report, setReport] = useState<{ tab: Tab; data: any } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: base } = useApiData(loadSummary);
  const currency = base?.currency ?? 'EUR';

  const path = useCallback(() => {
    switch (tab) {
      case 'income':
        return `/api/v1/reports/income-expenses?from=${fromMonth}&to=${toMonth}`;
      case 'categories':
        return `/api/v1/reports/categories?from=${from}&to=${to}&kind=${kind}`;
      case 'comparison':
        return `/api/v1/reports/comparison?aFrom=${aFrom}&aTo=${aTo}&bFrom=${bFrom}&bTo=${bTo}`;
      case 'budget':
        return `/api/v1/budgets?month=${budgetMonth}`;
      case 'netWorth':
        return `/api/v1/reports/net-worth?from=${fromMonth}&to=${toMonth}`;
      case 'projection':
        return `/api/v1/projection?days=${days}`;
    }
  }, [tab, fromMonth, toMonth, from, to, kind, aFrom, aTo, bFrom, bTo, budgetMonth, days]);

  useEffect(() => {
    let current = true;
    setProblem(null);
    api('GET', path())
      .then((data) => {
        if (current) setReport({ tab, data });
      })
      .catch((error: unknown) => {
        if (current) setProblem(errorMessage(error, tErrors));
      });
    return () => {
      current = false;
    };
    // tErrors is stable for a page; a change of filter is what reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tab]);

  const money = (minor: number) => `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), currency, locale)}`;
  const tick = (minor: number) => new Intl.NumberFormat(dateLocale(locale), { notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);
  const monthLabel = (value: string) => new Intl.DateTimeFormat(dateLocale(locale), { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`));
  const percent = (tenths: number | 'new' | null) => {
    if (tenths === 'new') return t('newLine');
    if (tenths === null || tenths === 0) return '0.0 %';
    const size = Math.abs(tenths);
    return `${tenths > 0 ? '+' : '−'}${Math.floor(size / 10)}.${size % 10} %`;
  };
  const dateInput = (id: string, label: string, value: string, set: (next: string) => void, type: 'date' | 'month' = 'date') => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} onChange={(event) => event.target.value && set(event.target.value)} />
    </div>
  );
  const csv = (
    <a className="small" href={`${path()}&format=csv`} download>
      {t('downloadCsv')}
    </a>
  );
  const drill = (query: string) => `/transactions?${query}`;
  const data = report?.tab === tab ? report.data : null;

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <div className="field">
        <label htmlFor="report">{t('choose')}</label>
        <select id="report" value={tab} onChange={(event) => setTab(event.target.value as Tab)}>
          {TABS.map((option) => (
            <option key={option} value={option}>
              {t(`tabs.${option}`)}
            </option>
          ))}
        </select>
      </div>
      {problem && (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      )}

      <div className="report-controls">
      {(tab === 'income' || tab === 'netWorth') && (
        <div className="grid-2">
          {dateInput('from-month', t('fromMonth'), fromMonth, setFromMonth, 'month')}
          {dateInput('to-month', t('toMonth'), toMonth, setToMonth, 'month')}
        </div>
      )}
      {tab === 'categories' && (
        <>
          <div className="grid-2">
            {dateInput('from', t('from'), from, setFrom)}
            {dateInput('to', t('to'), to, setTo)}
          </div>
          <div className="field">
            <label htmlFor="kind">{t('show')}</label>
            <select id="kind" value={kind} onChange={(event) => setKind(event.target.value as 'expense' | 'income')}>
              <option value="expense">{t('spending')}</option>
              <option value="income">{t('incomeWord')}</option>
            </select>
          </div>
        </>
      )}
      {tab === 'comparison' && (
        <div className="grid-2">
          {dateInput('a-from', t('aFrom'), aFrom, setAFrom)}
          {dateInput('a-to', t('aTo'), aTo, setATo)}
          {dateInput('b-from', t('bFrom'), bFrom, setBFrom)}
          {dateInput('b-to', t('bTo'), bTo, setBTo)}
        </div>
      )}
      {tab === 'budget' && dateInput('budget-month', t('month'), budgetMonth, setBudgetMonth, 'month')}
      {tab === 'projection' && (
        <div className="field">
          <label htmlFor="days">{t('horizon')}</label>
          <select id="days" value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="30">{t('days', { count: 30 })}</option>
            <option value="60">{t('days', { count: 60 })}</option>
            <option value="90">{t('days', { count: 90 })}</option>
          </select>
        </div>
      )}
      </div>

      {!data ? (
        !problem && <p aria-live="polite">{tApp('loading')}</p>
      ) : tab === 'income' ? (
        <section className="card" aria-label={t('tabs.income')}>
          <MonthColumns
            label={t('tabs.income')}
            labels={data.rows.map((row: any) => monthLabel(row.month))}
            series={[
              { name: t('incomeWord'), color: '--series-1', values: data.rows.map((row: any) => row.income_minor) },
              { name: t('expensesWord'), color: '--series-2', values: data.rows.map((row: any) => row.expenses_minor) },
            ]}
            money={money}
            tick={tick}
          />
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('monthColumn')}</th>
                  <th scope="col" className="num">{t('incomeWord')}</th>
                  <th scope="col" className="num">{t('expensesWord')}</th>
                  <th scope="col" className="num">{t('netResult')}</th>
                </tr>
              </thead>
              <tbody>
                {[...data.rows].reverse().map((row: any) => (
                  <tr key={row.month}>
                    <th scope="row">
                      <Link href={drill(`from=${row.month}-01&to=${monthEnd(row.month)}&measure=expense`)}>{monthLabel(row.month)}</Link>
                    </th>
                    <td className="num">{money(row.income_minor)}</td>
                    <td className="num">{money(row.expenses_minor)}</td>
                    <td className="num">{money(row.netResult_minor)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{t('total')}</th>
                  <td className="num">{money(data.total.income_minor)}</td>
                  <td className="num">{money(data.total.expenses_minor)}</td>
                  <td className="num">{money(data.total.netResult_minor)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {data.averageExpenses_minor !== null && <p className="small muted">{t('average', { amount: money(data.averageExpenses_minor) })}</p>}
          {data.savingsRateTenths !== null && <p className="small muted">{t('savingsRate', { rate: (data.savingsRateTenths / 10).toFixed(1) })}</p>}
          {csv}
        </section>
      ) : tab === 'categories' ? (
        <section className="card" aria-label={t('tabs.categories')}>
          {data.rows.length === 0 ? (
            <p className="muted">{t('empty')}</p>
          ) : (
            <>
              {data.rows.map((row: any) => (
                <div key={row.categoryId}>
                  <Link className="row row-link" href={drill(`from=${from}&to=${to}&measure=${kind}&categoryId=${row.categoryId}`)}>
                    <span className="row-title">{row.name}</span>
                    <span className="amount">{money(row.total_minor)}</span>
                  </Link>
                  <div className="split-bar" aria-hidden="true">
                    <span style={{ width: `${data.total_minor > 0 ? Math.max(0, (row.total_minor / data.total_minor) * 100) : 0}%`, background: 'var(--series-1)' }} />
                  </div>
                  {row.children.map((child: any) => (
                    <Link className="row row-sub row-link small" key={child.categoryId} href={drill(`from=${from}&to=${to}&measure=${kind}&categoryId=${child.categoryId}`)}>
                      <span>{child.name}</span>
                      <span className="amount">{money(child.total_minor)}</span>
                    </Link>
                  ))}
                  {row.own_minor !== 0 && row.children.length > 0 && (
                    <div className="row row-sub small muted">
                      <span>{t('ownLine', { name: row.name })}</span>
                      <span className="amount">{money(row.own_minor)}</span>
                    </div>
                  )}
                </div>
              ))}
              <div className="row">
                <strong>{t('total')}</strong>
                <strong className="amount" data-testid="category-total">
                  {money(data.total_minor)}
                </strong>
              </div>
            </>
          )}
          {csv}
        </section>
      ) : tab === 'comparison' ? (
        <section className="card" aria-label={t('tabs.comparison')}>
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('line')}</th>
                  <th scope="col" className="num">{t('periodA')}</th>
                  <th scope="col" className="num">{t('periodB')}</th>
                  <th scope="col" className="num">{t('change')}</th>
                </tr>
              </thead>
              <tbody>
                {data.totals.map((line: any) => (
                  <tr key={line.key}>
                    <th scope="row">{t(`lines.${line.key}`)}</th>
                    <td className="num">{money(line.a_minor)}</td>
                    <td className="num">{money(line.b_minor)}</td>
                    <td className="num">
                      {money(line.change_minor)}
                      <br />
                      <span className="muted">{percent(line.percentTenths)}</span>
                    </td>
                  </tr>
                ))}
                {data.categories.map((line: any) => (
                  <tr key={line.key}>
                    <th scope="row" style={{ fontWeight: 400, whiteSpace: 'normal' }}>{line.name}</th>
                    <td className="num">{money(line.a_minor)}</td>
                    <td className="num">{money(line.b_minor)}</td>
                    <td className="num">
                      {money(line.change_minor)}
                      <br />
                      <span className="muted">{percent(line.percentTenths)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {csv}
        </section>
      ) : tab === 'budget' ? (
        <section className="card" aria-label={t('tabs.budget')}>
          {data.items.length === 0 ? (
            <p className="muted">
              {t('noBudgets')} <Link href="/budgets">{t('setBudgets')}</Link>
            </p>
          ) : (
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('line')}</th>
                    <th scope="col" className="num">{t('limit')}</th>
                    <th scope="col" className="num">{t('spent')}</th>
                    <th scope="col" className="num">{t('left')}</th>
                    <th scope="col" className="num">{t('used')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row: any) => (
                    <tr key={row.categoryId}>
                      <th scope="row" style={{ fontWeight: 400 }}>
                        <Link href={drill(`from=${budgetMonth}-01&to=${monthEnd(budgetMonth)}&measure=expense&categoryId=${row.categoryId}`)}>{row.name}</Link>
                      </th>
                      <td className="num">{money(row.limit_minor)}</td>
                      <td className="num">{money(row.spent_minor)}</td>
                      <td className="num">{money(row.remaining_minor)}</td>
                      <td className="num">{row.utilization === 'over' ? t('over') : row.utilization}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row">
            <span>{t('unbudgeted')}</span>
            <span className="amount">{money(data.total.unbudgeted_minor)}</span>
          </div>
          <div className="row">
            <strong>{t('allSpending')}</strong>
            <strong className="amount">{money(data.total.expenses_minor)}</strong>
          </div>
        </section>
      ) : tab === 'netWorth' ? (
        <section className="card" aria-label={t('tabs.netWorth')}>
          <p className="small muted">{t('netWorthNote')}</p>
          <Lines label={t('tabs.netWorth')} labels={data.rows.map((row: any) => monthLabel(row.month))} series={[{ name: t('tabs.netWorth'), color: '--series-1', values: data.rows.map((row: any) => row.netWorth_minor) }]} money={money} tick={tick} />
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('monthColumn')}</th>
                  <th scope="col" className="num">{t('assets')}</th>
                  <th scope="col" className="num">{t('liabilities')}</th>
                  <th scope="col" className="num">{t('netWorth')}</th>
                  <th scope="col" className="num">{t('change')}</th>
                </tr>
              </thead>
              <tbody>
                {[...data.rows].reverse().map((row: any) => (
                  <tr key={row.month}>
                    <th scope="row">{monthLabel(row.month)}</th>
                    <td className="num">{money(row.assets_minor)}</td>
                    <td className="num">{money(row.liabilities_minor)}</td>
                    <td className="num">{money(row.netWorth_minor)}</td>
                    <td className="num">{money(row.change_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {csv}
        </section>
      ) : (
        <section className="card" aria-label={t('tabs.projection')}>
          <p className="small muted">{t('projectionNote')}</p>
          {data.lowest.amount_minor < data.protectedReserve_minor && (
            <p className="notice notice-warning small">{data.lowest.amount_minor < 0 ? t('goesBelowZero', { date: formatDay(data.lowest.date, locale) }) : t('goesBelowReserve', { date: formatDay(data.lowest.date, locale) })}</p>
          )}
          <Lines
            label={t('tabs.projection')}
            labels={data.days.map((day: any) => formatDay(day.date, locale).replace(/ \d{4}$/, ''))}
            series={[
              { name: t('commitmentsOnly'), color: '--series-2', values: data.days.map((day: any) => day.commitmentsOnly_minor) },
              { name: t('withIncome'), color: '--series-1', values: data.days.map((day: any) => day.withIncome_minor) },
            ]}
            money={money}
            tick={tick}
          />
          <p>{t('lowest', { amount: money(data.lowest.amount_minor), date: formatDay(data.lowest.date, locale) })}</p>
          {data.cards.map((card: any) => (
            <p className="small muted" key={`${card.name}-${card.date}`}>
              {t('cardLine', { name: card.name, amount: money(card.amount_minor), date: formatDay(card.date, locale) })}
            </p>
          ))}
          <details>
            <summary>{t('seeEveryDay')}</summary>
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('date')}</th>
                    <th scope="col" className="num">{t('commitmentsOnly')}</th>
                    <th scope="col" className="num">{t('withIncome')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((day: any) => (
                    <tr key={day.date}>
                      <th scope="row" style={{ fontWeight: 400 }}>{formatDay(day.date, locale)}</th>
                      <td className="num">{money(day.commitmentsOnly_minor)}</td>
                      <td className="num">{money(day.withIncome_minor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </AppShell>
  );
}

export default function ReportsPage() {
  return (
    <Suspense>
      <Reports />
    </Suspense>
  );
}
