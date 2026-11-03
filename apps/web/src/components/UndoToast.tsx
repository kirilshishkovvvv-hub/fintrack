'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, newIdempotencyKey } from '@/lib/api';
import { notifyDataChanged } from '@/lib/use-api';

interface Offer {
  message: string;
  token: string;
  seconds: number;
}

const UndoContext = createContext<(message: string, undo: { token: string; expiresInSeconds: number } | undefined) => void>(() => undefined);

/** Shows "Undo" for the last create, edit or delete for 10 seconds (FR-19, GAP-4). */
export function useUndo() {
  return useContext(UndoContext);
}

export function UndoProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('undo');
  const [offer, setOffer] = useState<Offer | null>(null);
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'expired'>('idle');
  const key = useRef('');

  const show = useCallback((message: string, undo: { token: string; expiresInSeconds: number } | undefined) => {
    if (!undo) return;
    key.current = newIdempotencyKey();
    setStatus('idle');
    setOffer({ message, token: undo.token, seconds: undo.expiresInSeconds });
  }, []);

  // Counts down once a second; the toast closes on its own when the time is up.
  useEffect(() => {
    if (!offer || status === 'busy') return;
    if (offer.seconds <= 0 || status === 'done' || status === 'expired') {
      const close = setTimeout(() => setOffer(null), status === 'idle' ? 0 : 2500);
      return () => clearTimeout(close);
    }
    const tick = setTimeout(() => setOffer({ ...offer, seconds: offer.seconds - 1 }), 1000);
    return () => clearTimeout(tick);
  }, [offer, status]);

  async function undo() {
    if (!offer) return;
    setStatus('busy');
    try {
      await api('POST', `/api/v1/undo/${offer.token}`, { idempotencyKey: key.current });
      setStatus('done');
      notifyDataChanged();
    } catch {
      setStatus('expired');
    }
  }

  return (
    <UndoContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {offer && (
          <div className="toast">
            <span>{status === 'done' ? t('undone') : status === 'expired' ? t('expired') : offer.message}</span>
            {(status === 'idle' || status === 'busy') && (
              <button type="button" className="btn toast-action" onClick={() => void undo()} disabled={status === 'busy'}>
                {t('action', { seconds: offer.seconds })}
              </button>
            )}
          </div>
        )}
      </div>
    </UndoContext.Provider>
  );
}
