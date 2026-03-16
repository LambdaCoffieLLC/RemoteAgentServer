# RemoteAgentServer

RemoteAgentServer is a Ralph-driven TypeScript monorepo for the server, runtime, clients, and shared packages that make up the Remote Dev Console product.

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
├── apps/
│   ├── server
│   ├── runtime
│   ├── web
│   ├── mobile
│   └── desktop
├── packages/
│   ├── protocol
│   ├── auth
│   ├── sessions
│   ├── ports
│   ├── providers
│   ├── ui
│   └── shared
├── docs/
│   └── shared-package-boundaries.md
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
- Shared package boundaries are documented in `docs/shared-package-boundaries.md`.
- `.agents/ralph` contains the agent-specific runner, prompt rules, tests, and runtime logs.
- `.agents/ralph/verification` stores per-story verification artifacts, including changed files and before/after automated-test counts for each attempt.
- `pnpm ralph` defaults to Codex `workspace-write`; `pnpm ralph:danger` uses the Codex bypass flag with no sandbox or approval gates.
