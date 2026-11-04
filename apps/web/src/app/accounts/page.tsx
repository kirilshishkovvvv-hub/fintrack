'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AccountRow } from '@/components/AccountRow';
import { AppShell, LoadError } from '@/components/AppShell';
import { active, loadAccounts, loadSummary, useApiData } from '@/lib/use-api';

/** All accounts; archived ones are listed apart and keep their history (FR-19). */
export default function AccountsPage() {
  const t = useTranslations('accounts');
  const tApp = useTranslations('app');
  const { data, failed, reload } = useApiData(async () => {
    const [accounts, summary] = await Promise.all([loadAccounts(), loadSummary()]);
    return { accounts, currency: summary.currency };
  });
  if (failed) return <LoadError retry={reload} />;

  const archived = data?.accounts.filter((account) => account.archived) ?? [];

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <section className="card" aria-live="polite">
        {!data ? (
          <p>{tApp('loading')}</p>
        ) : (
          active(data.accounts).map((account) => <AccountRow key={account.id} account={account} currency={data.currency} />)
        )}
      </section>
      <div className="actions" style={{ marginBottom: '1rem' }}>
        <Link href="/accounts/new" className="btn btn-primary">
          {t('add')}
        </Link>
        <Link href="/categories" className="btn">
          {t('categories')}
        </Link>
        <Link href="/export" className="btn">
          {t('export')}
        </Link>
      </div>
      {data && archived.length > 0 && (
        <section className="card" aria-labelledby="archived-title">
          <h2 id="archived-title">{t('archived')}</h2>
          {archived.map((account) => (
            <AccountRow key={account.id} account={account} currency={data.currency} />
          ))}
        </section>
      )}
    </AppShell>
  );
}
