'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AccountRow } from '@/components/AccountRow';
import { AppShell } from '@/components/AppShell';
import { SafeToSpendCard } from '@/components/SafeToSpendCard';
import { TransactionRow } from '@/components/TransactionRow';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { loadRules } from '@/lib/plan';
import { active, currentMonth, loadAccounts, loadCategories, loadSummary, useApiData, type Transaction } from '@/lib/use-api';

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tApp = useTranslations('app');
  const { data, failed, reload } = useApiData(async () => {
    const month = currentMonth();
    const [summary, accounts, categories, transactions, rules] = await Promise.all([
      loadSummary(),
      loadAccounts(),
      loadCategories(),
      api<{ items: Transaction[] }>('GET', `/api/v1/transactions?from=${month.from}&to=${month.to}`).then((r) => r.items),
      loadRules(),
    ]);
    // §7.6: without a payday the figure looks 30 days ahead, so ask once.
    return { summary, accounts, categories, transactions, hasPayday: rules.some((rule) => rule.isPayday && rule.status === 'active') };
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

  return (
    <AppShell>
      <SafeToSpendCard sts={sts} currency={currency} />

      {!data.hasPayday && (
        <p className="notice notice-info small">
          {t('whenPaid')} <Link href="/plan/rules/new?payday=1">{t('whenPaidLink')}</Link>
        </p>
      )}

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
