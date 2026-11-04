'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { loadCurrentUser } from '@/lib/auth';
import { useApiData } from '@/lib/use-api';

/** The address, the language (read-only while only English is on) and the marketing choice (Annex L item 6). */
export default function ProfilePage() {
  const t = useTranslations('profile');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, failed, reload } = useApiData(async () => {
    const [user, consents] = await Promise.all([loadCurrentUser(), api<{ marketing: boolean }>('GET', '/api/v1/me/consents')]);
    return { email: user?.email ?? '', marketing: consents.marketing };
  });
  if (failed) return <LoadError retry={reload} />;

  async function changeMarketing(accepted: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('POST', '/api/v1/me/consents', { idempotencyKey: newIdempotencyKey(), body: { document: 'marketing', accepted } });
      setNotice(t('saved'));
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-info" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : (
        <section className="card">
          <div className="row" style={{ borderTop: 0 }}>
            <span className="muted">{t('email')}</span>
            <span>{data.email}</span>
          </div>
          <p className="small">
            <Link href="/settings/security">{t('changeEmail')}</Link>
          </p>
          <div className="row">
            <span className="muted">{t('language')}</span>
            <span>{t('languageValue')}</span>
          </div>
          <p className="small muted">{t('languageHint')}</p>
          <label className="check">
            <input type="checkbox" checked={data.marketing} disabled={busy} onChange={(event) => void changeMarketing(event.target.checked)} /> <span>{t('marketing')}</span>
          </label>
          <p className="small muted">{t('marketingHint')}</p>
        </section>
      )}
    </AppShell>
  );
}
