import type { Scenario } from './scenario.ts';
import { basics } from './scenarios/basics.ts';
import { cardsAndDebts } from './scenarios/cards-and-debts.ts';
import { lifecycle } from './scenarios/lifecycle.ts';
import { planning } from './scenarios/planning.ts';
import { reconciliation } from './scenarios/reconciliation.ts';
import { refunds } from './scenarios/refunds.ts';

export * from './scenario.ts';
export { MemoryBook, runInMemory, type BookEvent, type PlanningState } from './memory-runner.ts';
export { verifyCheck } from './verify.ts';

/** Golden scenarios: pure ledger behaviour (Stage 3); the lifecycle and reconciliation (Stage 4); plans and goals (Stage 5). */
export const scenarios: Scenario[] = [...basics, ...cardsAndDebts, ...refunds, ...lifecycle, ...reconciliation, ...planning];

/**
 * Golden tests from §6 that aren't encoded yet, with the stage that brings the feature
 * they test. Listed so nothing is silently skipped; the test run reports each one as "todo".
 */
export const notYetEncoded: { id: string; reason: string; stage: number }[] = [
  { id: 'GT-10', reason: 'Transfers in Transit is a Should Have', stage: 4 },
  { id: 'GT-46', reason: 'investment contribution and valuation; investment accounts are a Should', stage: 6 },
  { id: 'GT-47', reason: 'reinvested dividend with a valuation; investment accounts are a Should', stage: 6 },
];
