'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ApiProblem } from '@/lib/api';
import { submitTwoFactorCode } from '@/lib/auth';

/** The second step of signing in with 2FA on: a code from the app, or a backup code. */
export function TwoFactorCode({ onDone }: { onDone: () => void | Promise<void> }) {
  const t = useTranslations('twoFactorCode');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '');
    setBusy(true);
    setError(null);
    try {
      await submitTwoFactorCode(code);
      await onDone();
    } catch (problem) {
      setError(problem instanceof ApiProblem && problem.status === 429 ? t('tooMany') : t('invalid'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p>{t('prompt')}</p>
      <div className="field">
        <label htmlFor="code">{t('code')}</label>
        <input id="code" name="code" type="text" inputMode="text" autoComplete="one-time-code" required autoFocus />
        <span className="hint">{t('hint')}</span>
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
