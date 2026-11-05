'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api } from '@/lib/api';
import { formatDay, formatMoney } from '@/lib/money';
import { currentMonth, loadSummary, useApiData } from '@/lib/use-api';

interface Debts {
  total_minor: number;
  items: { accountId: string; name: string; type: string; owed_minor: number; change_minor: number; creditLimit_minor: number | null; availableCredit_minor: number | null }[];
  upcoming: { occurrenceId: string; name: string; dueDate: string; amount_minor: number }[];
  interestPaid_minor: number;
}

/** FR-10: what's owed, how it moved in a month, what's coming, and the interest paid. */
export default function DebtsPage() {
  const t = useTranslations('debts');
  const tTypes = useTranslations('accountTypes');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const month = currentMonth();
  const [period, setPeriod] = useState(month.from.slice(0, 7));
  const shown = useRef(period);
  const [debts, setDebts] = useState<Debts | null>(null);
  const load = (on: string) => {
    const [year, number] = on.split('-').map(Number) as [number, number];
    const to = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
    return api<Debts>('GET', `/api/v1/debts?from=${on}-01&to=${to}`);
  };
  const { data, failed, reload } = useApiData(async () => {
    const summary = await loadSummary();
    setDebts(await load(shown.current));
    return { currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  const money = (minor: number) => `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), data?.currency ?? 'EUR', locale)}`;
  const change = (minor: number) => (minor === 0 ? t('noChange') : minor < 0 ? t('downBy', { amount: money(-minor) }) : t('upBy', { amount: money(minor) }));

  async function changeMonth(value: string) {
    if (!value) return;
    shown.current = value;
    setPeriod(value);
    setDebts(null);
    setDebts(await load(value));
  }

  return (
    <AppShell>
      <p className="small">
        <Link href="/plan">{t('backToPlan')}</Link>
      </p>
      <h1>{t('title')}</h1>
      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor="month">{t('month')}</label>
        <input id="month" type="month" value={period} onChange={(event) => void changeMonth(event.target.value)} />
      </div>
      {!data || !debts ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : (
        <>
          <section className="card" aria-labelledby="owed-title">
            <h2 id="owed-title">{t('owedTitle')}</h2>
            {debts.items.length === 0 ? (
              <p className="muted">{t('empty')}</p>
            ) : (
              <>
                {debts.items.map((item) => (
                  <Link className="row row-link" href={`/accounts/${item.accountId}`} key={item.accountId}>
                    <div className="row-main">
                      <div className="row-title">{item.name}</div>
                      <div className="small muted">
                        {tTypes(item.type)} · {change(item.change_minor)}
                        {item.availableCredit_minor !== null ? ` · ${t('available', { amount: money(item.availableCredit_minor) })}` : ''}
                      </div>
                    </div>
                    <span className="amount">{money(item.owed_minor)}</span>
                  </Link>
                ))}
                <div className="row">
                  <strong>{t('total')}</strong>
                  <strong className="amount">{money(debts.total_minor)}</strong>
                </div>
              </>
            )}
            <p className="small muted" style={{ marginTop: '0.5rem' }}>
              {t('interestPaid', { amount: money(debts.interestPaid_minor) })}
            </p>
          </section>
          <section className="card" aria-labelledby="upcoming-title">
            <h2 id="upcoming-title">{t('upcomingTitle')}</h2>
            {debts.upcoming.length === 0 ? (
              <p className="muted">{t('noUpcoming')}</p>
            ) : (
              debts.upcoming.map((item) => (
                <div className="row" key={item.occurrenceId}>
                  <div className="row-main">
                    <div className="row-title">{item.name}</div>
                    <div className="small muted">{formatDay(item.dueDate, locale)}</div>
                  </div>
                  <span className="amount">{money(item.amount_minor)}</span>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
