'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AccountRow } from '@/components/AccountRow';
import { AppShell } from '@/components/AppShell';
import { TransactionRow } from '@/components/TransactionRow';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { active, currentMonth, loadAccounts, loadCategories, loadSummary, useApiData, type Transaction } from '@/lib/use-api';

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tApp = useTranslations('app');
  const { data, failed, reload } = useApiData(async () => {
    const month = currentMonth();
    const [summary, accounts, categories, transactions] = await Promise.all([
      loadSummary(),
      loadAccounts(),
      loadCategories(),
      api<{ items: Transaction[] }>('GET', `/api/v1/transactions?from=${month.from}&to=${month.to}`).then((r) => r.items),
    ]);
    return { summary, accounts, categories, transactions };
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
  if (!data) {
    return (
      <AppShell>
        <p aria-live="polite">{tApp('loading')}</p>
      </AppShell>
    );
  }

  const { summary, accounts, categories } = data;
  const currency = summary.currency;
  const sts = summary.safeToSpend;
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const recent = data.transactions.filter((tx) => tx.kind !== 'opening_balance').slice(0, 5);
  const available = Math.max(sts.eligibleFunds_minor, 0);
  const reservedShare = available > 0 ? Math.min(100, ((sts.cardReserve_minor + sts.protectedReserve_minor) / available) * 100) : 0;

  return (
    <AppShell>
      <section className="card card-hero" aria-labelledby="sts-title">
        <p className="eyebrow" id="sts-title">
          {t('safeToSpend')}
        </p>
        <p className="hero-amount">
          {sts.value_minor < 0 ? '−' : ''}
          {formatMoney(Math.abs(sts.value_minor), currency)}
        </p>
        <p className="small muted">{t('safeToSpendNote')}</p>
        <div className="split-bar" aria-hidden="true">
          <span style={{ width: `${100 - reservedShare}%`, background: 'var(--brand)' }} />
          <span style={{ width: `${reservedShare}%`, background: 'var(--warning)' }} />
        </div>
        <details>
          <summary>{t('howCalculated')}</summary>
          <div className="row">
            <span>{t('available')}</span>
            <span className="amount">{formatMoney(sts.eligibleFunds_minor, currency)}</span>
          </div>
          <div className="row">
            <span>{t('cardReserve')}</span>
            <span className="amount">−{formatMoney(sts.cardReserve_minor, currency)}</span>
          </div>
          <div className="row">
            <span>{t('protectedReserve')}</span>
            <span className="amount">−{formatMoney(sts.protectedReserve_minor, currency)}</span>
          </div>
          <p className="small muted" style={{ marginTop: '0.5rem' }}>
            {t('plannedComing')}
          </p>
        </details>
      </section>

      {summary.uncategorized.map((item) => (
        <p className="notice notice-warning small" key={item.categoryId}>
          {t(item.kind === 'income' ? 'uncategorizedIncome' : 'uncategorizedExpense', { amount: formatMoney(Math.abs(item.total_minor), currency) })}{' '}
          <Link href={`/transactions?categoryId=${item.categoryId}`}>{t('uncategorizedLink')}</Link>
        </p>
      ))}

      <div className="grid-2">
        <section className="card">
          <p className="eyebrow">{t('netWorth')}</p>
          <p className="amount" style={{ fontSize: '1.35rem' }}>
            {summary.netWorth_minor < 0 ? '−' : ''}
            {formatMoney(Math.abs(summary.netWorth_minor), currency)}
          </p>
        </section>
        <section className="card" style={{ display: 'grid', alignContent: 'center' }}>
          <Link href="/transactions/new" className="btn btn-primary">
            {t('addTransaction')}
          </Link>
        </section>
      </div>

      <section className="card" aria-labelledby="accounts-title">
        <h2 id="accounts-title">{t('accounts')}</h2>
        {accounts.length === 0 ? (
          <p className="muted">{t('noAccounts')}</p>
        ) : (
          active(accounts).map((account) => <AccountRow key={account.id} account={account} currency={currency} />)
        )}
        <Link href="/accounts/new" className="btn" style={{ marginTop: '0.75rem' }}>
          {t('addAccount')}
        </Link>
      </section>

      <section className="card" aria-labelledby="recent-title">
        <h2 id="recent-title">{t('recent')}</h2>
        {recent.length === 0 ? (
          <p className="muted">{t('noTransactions')}</p>
        ) : (
          recent.map((tx) => <TransactionRow key={tx.id} tx={tx} accounts={accountMap} categories={categoryMap} currency={currency} />)
        )}
        <Link href="/transactions" className="small">
          {t('seeAll')}
        </Link>
      </section>
    </AppShell>
  );
}
