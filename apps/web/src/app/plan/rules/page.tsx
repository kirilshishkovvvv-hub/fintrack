'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { formatDay, formatMoney } from '@/lib/money';
import { loadRules } from '@/lib/plan';
import { loadSummary, useApiData } from '@/lib/use-api';

/** Every rule and one-off plan, with what's next. */
export default function RulesPage() {
  const t = useTranslations('rules');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const { data, failed, reload } = useApiData(async () => {
    const [rules, summary] = await Promise.all([loadRules(), loadSummary()]);
    return { rules, currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  const money = (minor: number) => formatMoney(minor, data?.currency ?? 'EUR', locale);
  const activeRules = data?.rules.filter((rule) => rule.status === 'active') ?? [];
  const ended = data?.rules.filter((rule) => rule.status === 'ended') ?? [];
  const row = (rule: (typeof activeRules)[number]) => (
    <Link className="row row-link" key={rule.id} href={`/plan/rules/${rule.id}`}>
      <div className="row-main">
        <div className="row-title">
          {rule.name}
          {rule.isPayday && <span className="badge">{t('paydayBadge')}</span>}
        </div>
        <div className="small muted">
          {t(`frequencies.${rule.frequency}`)}
          {rule.nextDue ? ` · ${t('next', { date: formatDay(rule.nextDue, locale) })}` : ''}
          {rule.overdue > 0 ? ` · ${t('overdueCount', { count: rule.overdue })}` : ''}
        </div>
      </div>
      <span className="amount">
        {rule.kind === 'income' ? '+' : '−'}
        {money(rule.amount_minor)}
      </span>
    </Link>
  );

  return (
    <AppShell>
      <p className="small">
        <Link href="/plan">{t('backToPlan')}</Link>
      </p>
      <h1>{t('title')}</h1>
      <div className="actions" style={{ marginBottom: '1rem' }}>
        <Link href="/plan/rules/new" className="btn btn-primary">
          {t('add')}
        </Link>
      </div>
      <section className="card" aria-live="polite">
        {!data ? <p>{tApp('loading')}</p> : activeRules.length === 0 ? <p className="muted">{t('empty')}</p> : activeRules.map(row)}
      </section>
      {ended.length > 0 && (
        <section className="card" aria-labelledby="ended-title">
          <h2 id="ended-title">{t('ended')}</h2>
          {ended.map(row)}
        </section>
      )}
    </AppShell>
  );
}
