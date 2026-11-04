'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiProblem } from '@/lib/api';

export default function SignUpPage() {
  const t = useTranslations('signUp');
  const tApp = useTranslations('app');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const consents = {
      terms: form.get('terms') === 'on',
      privacy: form.get('privacy') === 'on',
      age18: form.get('age18') === 'on',
      marketing: form.get('marketing') === 'on',
    };
    if (password.length < 12) return setError(t('passwordTooShort'));
    if (!consents.terms || !consents.privacy || !consents.age18) return setError(t('consentRequired'));
    setError(null);
    setBusy(true);
    try {
      await api('POST', '/api/auth/sign-up/email', {
        body: { email, password, name: email.split('@')[0], callbackURL: '/sign-in?verified=1', consents },
      });
      setSentTo(email);
    } catch (problem) {
      setError(problem instanceof ApiProblem && problem.status === 400 ? problem.message : tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <main id="main" className="auth-wrap">
        <div className="card">
          <h1>{t('checkInbox')}</h1>
          <p>{t('checkInboxBody', { email: sentTo })}</p>
          <Link href="/sign-in" className="btn btn-primary">
            {t('signIn')}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="auth-wrap">
      <div className="card">
        <h1>{t('title')}</h1>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="email">{t('email')}</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="password">{t('password')}</label>
            <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required aria-describedby="password-hint" />
            <span id="password-hint" className="hint">
              {t('passwordHint')}
            </span>
          </div>
          <label className="check">
            <input type="checkbox" name="terms" /> <span>{t.rich('acceptTerms', { link: (text) => <a href="/legal/terms" target="_blank" rel="noreferrer">{text}</a> })}</span>
          </label>
          <label className="check">
            <input type="checkbox" name="privacy" /> <span>{t.rich('acceptPrivacy', { link: (text) => <a href="/legal/privacy" target="_blank" rel="noreferrer">{text}</a> })}</span>
          </label>
          <label className="check">
            <input type="checkbox" name="age18" /> <span>{t('confirmAge')}</span>
          </label>
          <label className="check">
            <input type="checkbox" name="marketing" /> <span>{t('marketing')}</span>
          </label>
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
          {t('haveAccount')} <Link href="/sign-in">{t('signIn')}</Link>
        </p>
      </div>
    </main>
  );
}
