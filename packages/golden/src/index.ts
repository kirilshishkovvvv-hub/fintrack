import type { Scenario } from './scenario.ts';
import { basics } from './scenarios/basics.ts';
import { cardsAndDebts } from './scenarios/cards-and-debts.ts';
import { lifecycle } from './scenarios/lifecycle.ts';
import { reconciliation } from './scenarios/reconciliation.ts';
import { refunds } from './scenarios/refunds.ts';

export * from './scenario.ts';
export { MemoryBook, runInMemory, type BookEvent } from './memory-runner.ts';
export { verifyCheck } from './verify.ts';

/** Golden scenarios: pure ledger behaviour (Stage 3); the lifecycle and reconciliation (Stage 4). */
export const scenarios: Scenario[] = [...basics, ...cardsAndDebts, ...refunds, ...lifecycle, ...reconciliation];

/**
 * Golden tests from §6 that aren't encoded yet, with the stage that brings the feature
 * they test. Listed so nothing is silently skipped; the test run reports each one as "todo".
 */
export const notYetEncoded: { id: string; reason: string; stage: number }[] = [
  { id: 'GT-10', reason: 'Transfers in Transit is a Should Have', stage: 4 },
  { id: 'GT-16', reason: 'planned card repayment and card-funded plans in Safe to Spend', stage: 5 },
  { id: 'GT-20', reason: 'planned instalment matched to an occurrence', stage: 5 },
  { id: 'GT-37', reason: 'an import row matching a planned occurrence; the rest of FR-16 is covered by the API tests', stage: 5 },
  { id: 'GT-38 (occurrence)', reason: 'undoing an import returns a matched occurrence to Planned; the ledger part is covered by the API tests', stage: 5 },
  { id: 'GT-59 (search)', reason: 'isolation of search; read, use, change and export are covered by the API tests', stage: 4 },
];
