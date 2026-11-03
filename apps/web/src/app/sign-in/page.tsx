'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiProblem } from '@/lib/api';

function SignInForm() {
  const t = useTranslations('signIn');
  const router = useRouter();
  const verified = useSearchParams().get('verified') === '1';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/sign-in/email', {
        body: { email: String(form.get('email') ?? '').trim(), password: String(form.get('password') ?? ''), callbackURL: '/sign-in?verified=1' },
      });
      router.replace('/dashboard');
    } catch (problem) {
      const status = problem instanceof ApiProblem ? problem.status : 0;
      setError(status === 403 ? t('unverified') : status === 429 ? t('tooMany') : t('invalid'));
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>{t('title')}</h1>
      {verified && <p className="notice notice-info">{t('verified')}</p>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">{t('email')}</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">{t('password')}</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
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
      <p className="small muted" style={{ marginTop: '1rem' }}>
        {t('noAccount')} <Link href="/sign-up">{t('createAccount')}</Link>
      </p>
    </div>
  );
}

export default function SignInPage() {
  return (
    <main id="main" className="auth-wrap">
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
