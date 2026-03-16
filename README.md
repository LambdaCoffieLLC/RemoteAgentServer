# RemoteAgentServer

RemoteAgentServer is reset to a Ralph-driven starting point. The repository keeps the product spec and the Ralph execution loop, but all generated app and package scaffolding has been removed so implementation can restart from story one.

## Commands

```bash
pnpm install
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
- All user stories are reset to unfinished so Ralph can re-execute the entire PRD from the beginning.
