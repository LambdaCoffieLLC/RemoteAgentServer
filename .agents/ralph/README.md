# Ralph Runner

This repo keeps Ralph as repo-local agent tooling under `.agents/ralph`.

## Commands

```bash
pnpm install
pnpm verify:ralph
pnpm ralph
pnpm ralph:danger
pnpm ralph:worktree
```

Optional overrides:

```bash
RALPH_CODEX_SANDBOX=workspace-write
RALPH_CODEX_BYPASS=false
RALPH_CODEX_SEARCH=true
RALPH_PLAN_FIRST=true
RALPH_PLAN_SANDBOX=read-only
RALPH_VERIFY_COMMAND="pnpm verify:ralph"
```

## Files

- `ralph.ts` - execution controller
- `CODEX.md` - Codex instructions injected into each run
- `learnings.md` - append-only notes for future iterations
- `logs/` - logs grouped by user story, with timestamped files inside each story directory
- `plans/` - saved planning artifacts for each story attempt before execution starts
- `verification/` - per-story attempt artifacts with changed-file and automated-test signals
- `latest-run.json` - pointer to the current run's log files
- `tests/` - smoke coverage for PRD validation and prompt construction
- `../../scripts/ralph-worktree.mjs` - helper to create a separate git worktree for the current PRD branch

## Notes

- The canonical product spec remains the repo-root `prd.json`.
- This runner expects a clean git worktree before it starts.
- Codex is launched with `workspace-write` by default so implementation stories are not accidentally run in `read-only` mode.
- `pnpm ralph:danger` runs the same loop with `--dangerously-bypass-approvals-and-sandbox`.
- Ralph now runs in two phases by default: a read-only planning pass, then the execution pass against the saved plan artifact.
- If the planning phase edits files or mutates `prd.json` / `learnings.md`, Ralph rejects the attempt and rolls it back.
- `RALPH_PLAN_FIRST=false` disables the planning pass if you need to debug the old single-pass behavior.
- Current Codex CLI sandbox modes are `read-only`, `workspace-write`, and `danger-full-access`.
- `--dangerously-bypass-approvals-and-sandbox` is broader than `danger-full-access` because it removes both sandboxing and approval gates.
- Ralph now binds each Codex run to one explicit target story and rejects PRD updates for a different story.
- `pnpm verify:ralph` now runs the Ralph test suite and TypeScript check together instead of only one-off runner checks.
- Verification artifacts are written under `.agents/ralph/verification/<story-id>/` and record changed files plus before/after automated-test counts for each attempt.
- Codex and verification output are streamed to the current run log while they execute, so long sessions do not hit subprocess buffer limits.
- Runtime logs are written under `.agents/ralph/logs/<story-id>/` with timestamped files per invocation. Runner-level bootstrap logs go under `.agents/ralph/logs/_session/`.
- On mirrored dev servers, prefer running Ralph from `pnpm ralph:worktree` so the SyncThing-backed base folder can stay on `main` while the attempt branch runs in a separate checkout.
