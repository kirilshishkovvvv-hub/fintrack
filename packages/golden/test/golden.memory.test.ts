import { describe, test } from 'vitest';
import { notYetEncoded, runInMemory, scenarios, verifyCheck } from '@fintrack/golden';

describe('golden scenarios (in-memory domain runner)', () => {
  for (const scenario of scenarios) {
    test(`${scenario.id} · ${scenario.title}`, () => {
      const book = runInMemory(scenario);
      for (const check of scenario.checks) verifyCheck(book.ledger, check, undefined, (at) => book.planningAt(at));
    });
    for (const part of scenario.deferred ?? []) {
      test.todo(`${scenario.id} · ${part.what} (Stage ${part.stage})`);
    }
  }
  for (const pending of notYetEncoded) {
    test.todo(`${pending.id} · ${pending.reason} (Stage ${pending.stage})`);
  }
});
