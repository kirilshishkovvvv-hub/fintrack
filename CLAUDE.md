# Working on this project

Project memory lives in files, not in the conversation.

## At the start of a session, or after compaction

1. Read `PROGRESS.md` (start with "Handoff"), `DECISIONS.md`, `PROJECT_SPEC.md` and `TECHNICAL_NOTES.md`.
2. Check them against the code: `git log --oneline -10`, `git status`, and the relevant files. If they differ, say so; don't assume either is right.
3. Tell the user the status, confirmed requirements, open issues and next step, in short.
4. Continue from what exists. Don't redo finished work. If something essential is missing or contradictory, name the gap; don't invent an answer.

Read the Stage 1 or Stage 2 section for a topic before working on it. Those documents are the source of truth for rules and design.

## While working

- Update the relevant file whenever a requirement, decision, implementation detail or status changes, and at the end of every major stage.
- Never call something implemented, tested or working unless the code and actual test results support it. Say what wasn't verified. Check claims against the approved scope before reporting a stage as finished.
- Keep facts, assumptions, proposals and open questions apart. Mark decisions as confirmed, provisional or unresolved.
- Never silently drop, contradict or replace a confirmed requirement. Explain the reason and ask.
- Read existing code before changing it.
- Keep these files short. Link to the detail instead of copying it. History goes in `docs/progress-log.md`; `PROGRESS.md` holds only the current state.

## Before context runs out

Don't wait for 100%. Save new information to the right file, then update "Handoff" in `PROGRESS.md`: the current task, what's done, what remains, and the next concrete action. Include anything hard to reconstruct. Commit it. Then give the user a short handoff summary.

## Limits on acting alone

The working agreement is at the end of `PROJECT_SPEC.md`: when to stop and ask, and which stages need approval.
