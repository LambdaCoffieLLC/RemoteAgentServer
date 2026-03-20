# RemoteAgentServer

RemoteAgentServer is reset to a Ralph-driven starting point. The repository keeps the product spec and the Ralph execution loop, but all generated app and package scaffolding has been removed so implementation can restart from story one.

## Commands

```bash
pnpm install
pnpm ralph:clean
pnpm repo:sync:config
pnpm repo:sync
pnpm test
pnpm verify:ralph
pnpm ralph
pnpm ralph:danger
```

## Layout

```text
repo/
├── prd.json
├── package.json
├── tsconfig.json
└── .agents/
    └── ralph/
        ├── CODEX.md
        ├── README.md
        ├── learnings.md
        ├── ralph.ts
        └── tests/
```

## Notes

- `prd.json` remains the canonical execution spec.
- `.agents/ralph` contains the agent-specific runner, prompt rules, tests, and runtime logs.
- `.agents/ralph/verification` stores per-story verification artifacts, including changed files and before/after automated-test counts for each attempt.
- `pnpm ralph` defaults to Codex `workspace-write`; `pnpm ralph:danger` uses the Codex bypass flag with no sandbox or approval gates.
- `pnpm ralph:clean` removes generated `apps/`, `packages/`, and Ralph run artifacts left behind from prior runs while preserving the root `node_modules`.
- `pnpm ralph:clean:all` also removes the root `node_modules` if you want a fully cold reset.
- `RALPH_AUTO_CLEAN=true pnpm ralph` lets Ralph run the same cleanup automatically before a fresh run.
- `pnpm repo:sync` pushes the current branch and hard-resets a dedicated dev-server clone to that same branch over SSH.
- All user stories are reset to unfinished so Ralph can re-execute the entire PRD from the beginning.

## Dev Server Sync

Set these env vars before running the sync helper:

```bash
export RAS_SYNC_HOST=your-dev-server-ssh-host
export RAS_SYNC_REPO_PATH=/absolute/path/on/dev/server/RemoteAgentServer
```

Optional overrides:

```bash
export RAS_SYNC_BRANCH=ralph-loop-attempt-7
export RAS_SYNC_REMOTE=origin
export RAS_SYNC_GIT_URL=git@github.com:LambdaCoffieLLC/RemoteAgentServer.git
```

Then run:

```bash
pnpm repo:sync:config
pnpm repo:sync
pnpm repo:sync:status
```

The sync flow intentionally requires a clean local worktree. It pushes the selected branch, ensures the repo exists on the dev server, checks out the same branch there, hard-resets it to the pushed commit, and cleans untracked files in that dedicated remote clone so the next Ralph run starts from a known state.
