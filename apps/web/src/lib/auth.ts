/** Sign-in steps shared by the sign-in screen and the "confirm it's you" step. */
import { api } from './api';

/** Returns true when the account has 2FA on, so a code is still needed before the session exists. */
export async function signInWithPassword(email: string, password: string, keepSignedIn = false): Promise<boolean> {
  const result = await api<{ twoFactorRedirect?: boolean }>('POST', '/api/auth/sign-in/email', { body: { email, password, rememberMe: keepSignedIn } });
  return result.twoFactorRedirect === true;
}

/** Six digits are an app code; anything else is treated as a backup code. */
export async function submitTwoFactorCode(code: string): Promise<void> {
  const value = code.replace(/\s/g, '');
  const path = /^\d{6}$/.test(value) ? '/api/auth/two-factor/verify-totp' : '/api/auth/two-factor/verify-backup-code';
  await api('POST', path, { body: { code: value } });
}

export interface CurrentUser {
  email: string;
  twoFactorEnabled?: boolean | null;
}

export const loadCurrentUser = () => api<{ user: CurrentUser } | null>('GET', '/api/auth/get-session').then((session) => session?.user ?? null);
