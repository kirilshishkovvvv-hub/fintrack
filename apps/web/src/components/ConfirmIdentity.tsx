'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TwoFactorCode } from '@/components/TwoFactorCode';
import { ApiProblem } from '@/lib/api';
import { signInWithPassword } from '@/lib/auth';
import { cancelledByUser, passkeysSupported, signInWithPasskey } from '@/lib/passkeys';

/** Asks who it is again before a sensitive action (BR-01.5, AC-01.6). Success starts a fresh session. */
export function ConfirmIdentity({ onConfirmed }: { onConfirmed: () => void | Promise<void> }) {
  const t = useTranslations('confirmIdentity');
  const tApp = useTranslations('app');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  useEffect(() => setCanUsePasskey(passkeysSupported()), []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (await signInWithPassword(String(form.get('email') ?? '').trim(), String(form.get('password') ?? ''))) setNeedsCode(true);
      else await onConfirmed();
    } catch (problem) {
      const status = problem instanceof ApiProblem ? problem.status : 0;
      setError(status === 401 || status === 403 ? t('invalid') : status === 429 ? t('tooMany') : tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  async function usePasskey() {
    setBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      await onConfirmed();
    } catch (problem) {
      if (!cancelledByUser(problem)) setError(t('passkeyFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (needsCode) {
    return (
      <div className="card">
        <TwoFactorCode onDone={onConfirmed} />
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <p>{t('prompt')}</p>
      <div className="field">
        <label htmlFor="confirm-email">{t('email')}</label>
        <input id="confirm-email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="confirm-password">{t('password')}</label>
        <input id="confirm-password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {t('submit')}
      </button>
      {canUsePasskey && (
        <button className="btn" type="button" disabled={busy} onClick={() => void usePasskey()}>
          {t('usePasskey')}
        </button>
      )}
    </form>
  );
}
