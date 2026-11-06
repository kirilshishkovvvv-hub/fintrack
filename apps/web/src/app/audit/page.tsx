'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api } from '@/lib/api';
import { dateLocale } from '@/lib/money';
import { useApiData } from '@/lib/use-api';

interface AuditPage {
  items: { id: string; type: string; occurredAt: string }[];
  nextBefore: string | null;
}

/** The user-visible audit view (FR-19): what happened and when, never amounts (Stage 2 §9.2). */
export default function AuditPage() {
  const t = useTranslations('audit');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const [older, setOlder] = useState<AuditPage | null>(null);
  const [olderFailed, setOlderFailed] = useState(false);
  const { data, failed, reload } = useApiData(() => api<AuditPage>('GET', '/api/v1/audit'));
  if (failed) return <LoadError retry={reload} />;

  const items = [...(data?.items ?? []), ...(older?.items ?? [])];
  const next = older ? older.nextBefore : data?.nextBefore;
  const when = (iso: string) => new Intl.DateTimeFormat(dateLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const label = (type: string) => {
    const key = `events.${type.replaceAll('.', '_')}`;
    return t.has(key) ? t(key) : t('other');
  };

  async function showOlder() {
    setOlderFailed(false);
    try {
      const page = await api<AuditPage>('GET', `/api/v1/audit?before=${next}`);
      setOlder({ items: [...(older?.items ?? []), ...page.items], nextBefore: page.nextBefore });
    } catch {
      setOlderFailed(true);
    }
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <section className="card" aria-live="polite">
        {!data ? (
          <p>{tApp('loading')}</p>
        ) : items.length === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          <ol className="history">
            {items.map((item) => (
              <li key={item.id}>
                <div>{label(item.type)}</div>
                <div className="small muted">{when(item.occurredAt)}</div>
              </li>
            ))}
          </ol>
        )}
        {olderFailed && (
          <p className="notice notice-error" role="alert" style={{ marginTop: '0.75rem' }}>
            {tApp('genericError')}
          </p>
        )}
        {next && (
          <button className="btn" type="button" style={{ marginTop: '0.75rem' }} onClick={() => void showOlder()}>
            {t('more')}
          </button>
        )}
      </section>
    </AppShell>
  );
}
