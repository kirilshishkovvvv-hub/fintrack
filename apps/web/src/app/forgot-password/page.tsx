'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiProblem } from '@/lib/api';

/** Requests a reset link (BR-01.4). The answer is the same whether or not the address has an account. */
export default function ForgotPasswordPage() {
  const t = useTranslations('forgotPassword');
  const tApp = useTranslations('app');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } });
      setSent(true);
    } catch (problem) {
      setError(problem instanceof ApiProblem && problem.status === 429 ? t('tooMany') : tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="auth-wrap">
      <div className="card">
        <h1>{t('title')}</h1>
        {sent ? (
          <p role="status">{t('sent')}</p>
        ) : (
          <form onSubmit={submit}>
            <p>{t('intro')}</p>
            <div className="field">
              <label htmlFor="email">{t('email')}</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
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
        <p className="small muted" style={{ marginTop: '1rem' }}>
          <Link href="/sign-in">{t('back')}</Link>
        </p>
      </div>
    </main>
  );
}
