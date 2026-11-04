'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiProblem } from '@/lib/api';

/** Sets a new password from an emailed link: single use, 60 minutes (BR-01.4, AC-01.3). */
function ResetForm() {
  const t = useTranslations('resetPassword');
  const tApp = useTranslations('app');
  const params = useSearchParams();
  const token = params.get('token');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newPassword = String(new FormData(event.currentTarget).get('password') ?? '');
    if (newPassword.length < 12) return setError(t('tooShort'));
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/reset-password', { body: { token, newPassword } });
      setDone(true);
    } catch (problem) {
      setError(problem instanceof ApiProblem && problem.status === 400 ? t('invalid') : tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="auth-wrap">
      <div className="card">
        <h1>{t('title')}</h1>
        {done ? (
          <>
            <p role="status">{t('done')}</p>
            <Link href="/sign-in" className="btn btn-primary">
              {t('signIn')}
            </Link>
          </>
        ) : !token || params.get('error') ? (
          <>
            <p className="notice notice-error" role="alert">
              {t('invalid')}
            </p>
            <Link href="/forgot-password" className="btn">
              {t('again')}
            </Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="password">{t('password')}</label>
              <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required aria-describedby="password-hint" />
              <span id="password-hint" className="hint">
                {t('hint')}
              </span>
            </div>
            {error && (
              <p className="notice notice-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('submit')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
