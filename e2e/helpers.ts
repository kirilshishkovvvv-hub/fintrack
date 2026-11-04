/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

export const PASSWORD = 'a long password for browser tests';
const ORIGIN = 'http://localhost:3100';

let counter = 0;
export const nextEmail = () => `e2e-${Date.now()}-${++counter}@example.com`;

/** Today in the workspace's time zone, as the app sees it. */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());

/** Each test comes from its own address, so the per-source sign-in limit doesn't join up across tests. */
export const test = base.extend({
  context: async ({ browser, baseURL, viewport, timezoneId, locale, acceptDownloads, colorScheme }, use) => {
    const context = await browser.newContext({
      baseURL: baseURL!,
      viewport,
      timezoneId: timezoneId!,
      locale: locale!,
      acceptDownloads: acceptDownloads!,
      colorScheme,
      extraHTTPHeaders: { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    });
    const missing: string[] = [];
    context.on('console', (message) => {
      if (message.text().includes('MISSING_MESSAGE')) missing.push(message.text());
    });
    await use(context);
    await context.close();
    expect(missing, 'AC-22.1: no missing translation on screen').toEqual([]);
  },
});
export { expect, type Browser };

export function verificationLink(email: string): string {
  const log = readFileSync('.pgdata/e2e-server.log', 'utf8');
  const lines = log.split('\n').filter((line) => line.includes(`verify-email for ${email}:`));
  const line = lines.at(-1);
  if (!line) throw new Error(`No verification email for ${email}`);
  return line.slice(line.indexOf('http')).trim();
}

export async function waitForVerificationLink(email: string): Promise<string> {
  await expect.poll(() => readFileSync('.pgdata/e2e-server.log', 'utf8').includes(`verify-email for ${email}:`)).toBe(true);
  return verificationLink(email);
}

export async function withDatabase<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const { url } = JSON.parse(readFileSync('.pgdata/e2e-db.json', 'utf8')) as { url: string };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The fast way to a signed-in user with a workspace, for journeys that aren't about signing up. */
export async function signedInUser(page: Page, options: { account?: { name: string; opening: number } } = {}): Promise<string> {
  const email = nextEmail();
  const request = page.context().request;
  const headers = { origin: ORIGIN };
  const signUp = await request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password: PASSWORD, name: 'E2E', consents: { terms: true, privacy: true, age18: true } },
  });
  expect(signUp.status()).toBe(200);
  await request.get(await waitForVerificationLink(email));
  await signIn(page, email);
  await expect(page).toHaveURL(/onboarding/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/dashboard/);
  if (options.account) {
    const created = await request.post('/api/v1/accounts', {
      headers: { ...headers, 'idempotency-key': `e2e-${crypto.randomUUID()}` },
      data: { name: options.account.name, type: 'current', openingDate: '2026-01-01', openingAmount_minor: options.account.opening },
    });
    expect(created.status()).toBe(201);
  }
  return email;
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** No sideways scrolling at any width (FR-21). */
export async function expectFits(page: Page): Promise<void> {
  const [content, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(content, `page is ${content}px wide in a ${width}px window`).toBeLessThanOrEqual(width);
}

/** WCAG 2.1 AA basics (NFR-08, Annex L items 13 to 15), plus the width check, on the screen as it stands. */
export async function checkScreen(page: Page, name: string): Promise<void> {
  await expectFits(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const problems = results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).slice(0, 3).join(', ')}`);
  expect(problems, `${name} (${page.url()})`).toEqual([]);
}
