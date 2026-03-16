# RemoteAgentServer

RemoteAgentServer now starts from a pnpm monorepo baseline so the control plane, runtimes, clients, and shared packages can evolve in one TypeScript-first workspace.

## Quickstart

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm verify
```

`pnpm verify` is the root verification flow. It is intended to run both locally before commits and in CI on every push or pull request.

## Workspace Layout

```text
repo/
├── apps/
│   ├── desktop/
│   ├── mobile/
│   ├── server/
│   └── web/
├── packages/
│   ├── runtime/
│   └── shared/
├── .agents/
│   └── ralph/
├── eslint.config.mjs
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.package.json
└── prd.json
```

## Monorepo Commands

- `pnpm install` installs all workspace dependencies from the repo root.
- `pnpm build` builds every first-party workspace package with TypeScript.
- `pnpm lint` applies the centralized ESLint rules to the repo and all workspaces.
- `pnpm typecheck` runs root and workspace TypeScript checks.
- `pnpm test` runs repo-level monorepo contract tests and the existing Ralph runner tests.
- `pnpm verify` runs the full local and CI verification flow in one command.
- `pnpm verify:ralph` keeps Ralph pointed at the same root verification flow.
- `pnpm ralph` and `pnpm ralph:danger` continue to run the local Ralph automation.

## Centralized Tooling

- `pnpm-workspace.yaml` defines all first-party workspace packages.
- `tsconfig.base.json` and `tsconfig.package.json` provide shared TypeScript defaults for apps and packages.
- `eslint.config.mjs` centralizes lint rules for repo tooling and workspace code.
- `.prettierrc.json` centralizes formatting rules for the whole monorepo.

## CI

CI should execute `pnpm install --frozen-lockfile` followed by `pnpm verify`. A starter GitHub Actions workflow is included at `.github/workflows/verify.yml`.

## Notes

- `prd.json` remains the canonical execution spec.
- `.agents/ralph` still contains the repo-local runner, prompt rules, and verification artifacts.
- The current app and package code is intentionally minimal scaffold code for the monorepo story only.
