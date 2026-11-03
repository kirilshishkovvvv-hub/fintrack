import type { Scenario } from './scenario.ts';
import { basics } from './scenarios/basics.ts';
import { cardsAndDebts } from './scenarios/cards-and-debts.ts';
import { refunds } from './scenarios/refunds.ts';

export * from './scenario.ts';
export { MemoryBook, runInMemory } from './memory-runner.ts';
export { verifyCheck } from './verify.ts';

/** Golden scenarios that run in Stage 3 (pure ledger behaviour). */
export const scenarios: Scenario[] = [...basics, ...cardsAndDebts, ...refunds];

/**
 * Golden tests from §6 that aren't encoded yet, with the stage that brings the feature
 * they test. Listed so nothing is silently skipped; the test run reports each one as "todo".
 */
export const notYetEncoded: { id: string; reason: string; stage: number }[] = [
  { id: 'GT-09', reason: 'import transfer pairing (BR-16.5)', stage: 4 },
  { id: 'GT-10', reason: 'Transfers in Transit is a Should Have', stage: 4 },
  { id: 'GT-16', reason: 'planned card repayment and card-funded plans in Safe to Spend', stage: 5 },
  { id: 'GT-20', reason: 'planned instalment matched to an occurrence', stage: 5 },
  { id: 'GT-39 (b)', reason: 'import confirmation is all-or-nothing; part (a) is covered by the database tests', stage: 4 },
  { id: 'GT-59 (export, search)', reason: 'isolation of export and search; read, use and change are covered by the API tests', stage: 4 },
  { id: 'GT-71 (import rows)', reason: 'foreign-currency import rows; the currency lock is covered by the database tests', stage: 4 },
];
