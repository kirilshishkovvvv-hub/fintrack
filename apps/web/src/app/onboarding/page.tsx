'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiProblem } from '@/lib/api';

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  const tApp = useTranslations('app');
  const router = useRouter();
  const [timezone, setTimezone] = useState('Europe/Sofia');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) setTimezone(detected);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/v1/workspaces', {
        body: { name: String(form.get('name') ?? '').trim() || t('defaultName'), currency: form.get('currency'), timezone },
      });
      router.replace('/dashboard');
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.status === 401) return router.replace('/sign-in');
      setError(tApp('genericError'));
      setBusy(false);
    }
  }

  return (
    <main id="main" className="auth-wrap">
      <div className="card">
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="name">{t('name')}</label>
            <input id="name" name="name" type="text" defaultValue={t('defaultName')} maxLength={100} />
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 500, marginBottom: '0.35rem' }}>{t('currency')}</legend>
            <div className="segmented">
              <label>
                <input type="radio" name="currency" value="EUR" defaultChecked /> {t('eur')}
              </label>
              <label>
                <input type="radio" name="currency" value="USD" /> {t('usd')}
              </label>
            </div>
          </fieldset>
          <p className="small muted">
            {t('timezone')}: {timezone}
          </p>
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('submit')}
          </button>
        </form>
      </div>
    </main>
  );
}
