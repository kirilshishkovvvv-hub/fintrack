/**
 * Passkeys in the browser. The device checks the face, fingerprint or PIN itself; only a signed
 * proof reaches the server, and no biometric data ever leaves the device.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';

export interface Passkey {
  id: string;
  name: string | null;
  createdAt: string | null;
}

export const passkeysSupported = () => browserSupportsWebAuthn();

/** The user closed the device's prompt, or it timed out: not an error worth reporting. */
export const cancelledByUser = (problem: unknown) => problem instanceof Error && problem.name === 'NotAllowedError';

export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('GET', '/api/auth/passkey/generate-authenticate-options');
  const response = await startAuthentication({ optionsJSON });
  await api('POST', '/api/auth/passkey/verify-authentication', { body: { response } });
}

export async function addPasskey(name: string): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('GET', `/api/auth/passkey/generate-register-options?name=${encodeURIComponent(name)}`);
  const response = await startRegistration({ optionsJSON });
  await api('POST', '/api/auth/passkey/verify-registration', { body: { response, name } });
}

export const listPasskeys = () => api<Passkey[]>('GET', '/api/auth/passkey/list-user-passkeys');
export const removePasskey = (id: string) => api('POST', '/api/auth/passkey/delete-passkey', { body: { id } });
