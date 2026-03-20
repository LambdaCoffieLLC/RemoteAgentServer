# RemoteAgentServer

RemoteAgentServer is reset to a Ralph-driven starting point. The repository keeps the product spec and the Ralph execution loop, but all generated app and package scaffolding has been removed so implementation can restart from story one.

## Commands

```bash
pnpm install
pnpm ralph:clean
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
- `.stignore` keeps SyncThing replicas from copying git internals, Ralph run artifacts, and local dev caches to another machine.
- `.agents/ralph/verification` stores per-story verification artifacts, including changed files and before/after automated-test counts for each attempt.
- `.agents/ralph/plans` stores the read-only planning artifact that Ralph captures before each execution attempt.
- `pnpm ralph` defaults to Codex `workspace-write`; `pnpm ralph:danger` uses the Codex bypass flag with no sandbox or approval gates for the execution phase.
- Ralph now does a read-only planning pass before execution by default so each story has a saved implementation plan.
- `pnpm ralph:clean` removes generated `apps/`, `packages/`, and Ralph run artifacts left behind from prior runs while preserving the root `node_modules`.
- `pnpm ralph:clean:all` also removes the root `node_modules` if you want a fully cold reset.
- `RALPH_AUTO_CLEAN=true pnpm ralph` lets Ralph run the same cleanup automatically before a fresh run.
- If you mirror this repo to another machine with SyncThing, commit `.stignore` but keep any `.stfolder` local to each device.
- All user stories are reset to unfinished so Ralph can re-execute the entire PRD from the beginning.
