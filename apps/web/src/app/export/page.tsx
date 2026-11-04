'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { ConfirmIdentity } from '@/components/ConfirmIdentity';

/**
 * Self-service export (FR-17, PRV-03). An encrypted file is the main path; a plain one stays
 * available for spreadsheets. The server asks for a recent sign-in first (BR-01.5).
 */
export default function ExportPage() {
  const t = useTranslations('export');
  const tApp = useTranslations('app');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept only until the download starts, in case the user must confirm who they are first.
  const filePassword = useRef<string | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);

  async function download() {
    setBusy(true);
    try {
      const password = filePassword.current;
      const response = await fetch('/api/v1/exports', {
        method: 'POST',
        credentials: 'same-origin',
        ...(password ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) } : {}),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { code?: string } | null;
        if (problem?.code === 'REAUTH_REQUIRED') {
          setNeedsPassword(true);
          setMessage(null);
        } else {
          setMessage({ kind: 'error', text: tApp('genericError') });
        }
        return;
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'fintrack-export.zip';
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      filePassword.current = undefined;
      form.current?.reset();
      setNeedsPassword(false);
      setMessage({ kind: 'info', text: t('done') });
    } catch {
      setMessage({ kind: 'error', text: tApp('genericError') });
    } finally {
      setBusy(false);
    }
  }

  function encrypted(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const password = String(fields.get('filePassword') ?? '');
    if (password.length < 12) return setMessage({ kind: 'error', text: t('tooShort') });
    if (password !== String(fields.get('filePasswordAgain') ?? '')) return setMessage({ kind: 'error', text: t('mismatch') });
    setMessage(null);
    filePassword.current = password;
    void download();
  }

  function plain() {
    setMessage(null);
    filePassword.current = undefined;
    void download();
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      {!needsPassword && (
        <>
          <form className="card" ref={form} onSubmit={encrypted}>
            <h2>{t('passwordTitle')}</h2>
            <p className="small muted">{t('passwordIntro')}</p>
            <div className="field">
              <label htmlFor="filePassword">{t('password')}</label>
              <input id="filePassword" name="filePassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required aria-describedby="file-password-hint" />
              <span id="file-password-hint" className="hint">
                {t('passwordHint')}
              </span>
            </div>
            <div className="field">
              <label htmlFor="filePasswordAgain">{t('confirmPassword')}</label>
              <input id="filePasswordAgain" name="filePasswordAgain" type="password" autoComplete="new-password" maxLength={128} required />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('download')}
            </button>
            <p className="small muted" style={{ margin: 0 }}>{t('openHint')}</p>
            <p className="small muted" style={{ margin: 0 }}>{t('afterOpen')}</p>
          </form>
          <section className="card">
            <h2>{t('plainTitle')}</h2>
            <p className="small muted">{t('plainIntro')}</p>
            <button className="btn" type="button" disabled={busy} onClick={plain}>
              {t('plain')}
            </button>
          </section>
        </>
      )}
      {needsPassword && <ConfirmIdentity onConfirmed={download} />}
      {message && (
        <p className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </AppShell>
  );
}
