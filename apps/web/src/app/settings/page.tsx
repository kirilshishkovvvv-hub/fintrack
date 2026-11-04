'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';

/** One place for what users can do with their own data (Annex L item 20, PRV-03). */
export default function SettingsPage() {
  const t = useTranslations('settings');
  const items = [
    { href: '/settings/security', title: t('security'), hint: t('securityHint') },
    { href: '/settings/passkeys', title: t('passkeys'), hint: t('passkeysHint') },
    { href: '/settings/payees', title: t('payees'), hint: t('payeesHint') },
    { href: '/export', title: t('export'), hint: t('exportHint') },
    { href: '/audit', title: t('audit'), hint: t('auditHint') },
    { href: '/delete-account', title: t('delete'), hint: t('deleteHint') },
  ];
  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <section className="card">
        {items.map((item) => (
          <Link key={item.href} href={item.href} className="row row-link">
            <div className="row-main">
              <div className="row-title">{item.title}</div>
              <div className="small muted">{item.hint}</div>
            </div>
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </section>
    </AppShell>
  );
}
