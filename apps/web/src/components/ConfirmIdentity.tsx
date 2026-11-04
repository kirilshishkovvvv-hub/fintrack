'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiProblem } from '@/lib/api';

/** Asks for the password again before a sensitive action (BR-01.5, AC-01.6). A correct one starts a fresh session. */
export function ConfirmIdentity({ onConfirmed }: { onConfirmed: () => void | Promise<void> }) {
  const t = useTranslations('confirmIdentity');
  const tApp = useTranslations('app');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/sign-in/email', { body: { email: String(form.get('email') ?? '').trim(), password: String(form.get('password') ?? '') } });
      await onConfirmed();
    } catch (problem) {
      const status = problem instanceof ApiProblem ? problem.status : 0;
      setError(status === 401 || status === 403 ? t('invalid') : status === 429 ? t('tooMany') : tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <p>{t('prompt')}</p>
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
  );
}
