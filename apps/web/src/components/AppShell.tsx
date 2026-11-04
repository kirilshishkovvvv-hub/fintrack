'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';

const NAV = [
  { href: '/dashboard', key: 'dashboard', icon: '⌂' },
  { href: '/transactions', key: 'transactions', icon: '≡' },
  { href: '/transactions/new', key: 'add', icon: '+', className: 'nav-add' },
  { href: '/accounts', key: 'accounts', icon: '◫' },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await api('POST', '/api/auth/sign-out', { body: {} }).catch(() => undefined);
    router.replace('/sign-in');
  }

  return (
    <>
      <header className="topbar">
        <Link href="/dashboard" className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          {t('app.name')}
        </Link>
        <button type="button" className="btn btn-ghost" onClick={signOut}>
          {t('app.signOut')}
        </button>
      </header>
      <main id="main" className="shell">
        {children}
        <p className="footer-note">
          {t('app.notFinancialAdvice')} <Link href="/legal/terms">{t('app.legalLink')}</Link>
        </p>
      </main>
      <nav className="bottom-nav" aria-label={t('nav.label')}>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={'className' in item ? item.className : undefined}
            aria-current={pathname === item.href ? 'page' : undefined}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            {t(`nav.${item.key}`)}
          </Link>
        ))}
      </nav>
    </>
  );
}

/** Shown when a page's data can't load, so it never stays on "Loading…". */
export function LoadError({ retry }: { retry: () => void }) {
  const t = useTranslations('app');
  return (
    <AppShell>
      <p className="notice notice-error" role="alert">
        {t('genericError')}{' '}
        <button className="btn" type="button" onClick={retry}>
          {t('retry')}
        </button>
      </p>
    </AppShell>
  );
}
