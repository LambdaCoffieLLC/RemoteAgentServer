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
│   ├── auth/
│   ├── ports/
│   ├── protocol/
│   ├── providers/
│   ├── runtime/
│   ├── sessions/
│   └── ui/
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

## Shared Package Boundaries

The shared core model is split into focused workspace packages so server, runtime, and clients import the same domain contracts instead of re-declaring local copies.

- `@remote-agent-server/protocol`: shared control-plane envelopes, application kinds, and package identifiers.
- `@remote-agent-server/auth`: token schemes and auth policies used by the server, runtime enrollment, and clients.
- `@remote-agent-server/sessions`: session identifiers, lifecycle states, and workspace/worktree execution modes.
- `@remote-agent-server/ports`: detected and forwarded port metadata, visibility, and presentation labels.
- `@remote-agent-server/providers`: provider adapter identities and launch descriptors for Claude Code, Codex, and OpenCode.
- `@remote-agent-server/ui`: UI-safe primitives such as navigation items and status badges for client surfaces.

The intended dependency direction is from apps and feature packages inward to these shared packages. `packages/runtime` composes the shared domain packages, while app packages depend on the shared packages and the runtime package rather than redefining auth, session, port, provider, or UI models locally.

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
- The current app and package code is still minimal, but the shared core packages now define the canonical domain model for the monorepo.
