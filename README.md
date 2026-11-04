# Fintrack (working name)

A multi-user personal finance tracker.

**Start here:** [PROGRESS.md](PROGRESS.md) (current state and next steps), [PROJECT_SPEC.md](PROJECT_SPEC.md), [DECISIONS.md](DECISIONS.md), [TECHNICAL_NOTES.md](TECHNICAL_NOTES.md). The full documents are in `docs/`:

- `docs/stage-1-specification.md` — requirements, accounting rules, golden tests (the source of truth for every financial rule)
- `docs/stage-2-architecture.md` — architecture and technical design
- `docs/progress-log.md` — what has been built and verified so far

## Layout

| Package | What it is |
|---|---|
| `packages/domain` | Every financial rule, as pure TypeScript with no I/O: money and rounding, ledger rules, builders, metrics, Safe to Spend |
| `packages/db` | PostgreSQL migrations, the workspace context (row-level security), data access |
| `packages/golden` | The Stage 1 golden test scenarios as data, and the harnesses that run them |

## Running the tests

Requires Node.js 24. No database install is needed: tests start their own temporary PostgreSQL.

```bash
npm install
npm test
npm run typecheck
```
