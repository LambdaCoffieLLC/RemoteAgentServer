# RemoteAgentServer

RemoteAgentServer now starts from a pnpm monorepo baseline so the control plane, runtimes, clients, and shared packages can evolve in one TypeScript-first workspace.

## Quickstart

```bash
pnpm install
pnpm --filter @remote-agent-server/server build
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=operator-dev-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=bootstrap-dev-token \
pnpm --filter @remote-agent-server/server dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm verify
```

`pnpm verify` is the root verification flow. It is intended to run both locally before commits and in CI on every push or pull request.

## Control Plane

The server app at `apps/server` is now a runnable control plane for the single-user self-hosted MVP. It exposes protected JSON APIs for:

- hosts at `/api/hosts`
- workspaces at `/api/workspaces`
- sessions at `/api/sessions`
- approvals at `/api/approvals`
- notifications at `/api/notifications`
- forwarded ports at `/api/ports`
- real-time server-sent events at `/api/events`

`GET /health` is public. The API surfaces require an operator token, except `POST /api/hosts`, which also accepts a bootstrap token so runtimes can enroll.

## Remote Linux Runtime Install

`US-004` is implemented as a helper-driven Linux install flow for hosts that have:

- Bash and standard coreutils
- Node.js 20+
- A checkout of this repository with `pnpm install` already run

This flow is intended for modern Linux distributions that satisfy those prerequisites, including Ubuntu, Debian, Fedora, and RHEL-derived hosts.

### Build And Install

On the remote Linux host:

```bash
pnpm install
pnpm --filter @remote-agent-server/runtime build

./packages/runtime/scripts/install-linux-runtime.sh \
  --prefix "$HOME/.remote-agent-runtime" \
  --server-url "http://127.0.0.1:4318" \
  --bootstrap-token "bootstrap-dev-token" \
  --host-id "devbox-1" \
  --host-name "devbox"
```

The installer stages the built runtime under the chosen prefix and writes:

- `bin/remote-agent-runtime`
- `bin/remote-agent-runtime-enroll`
- `bin/remote-agent-runtime-status`
- `etc/remote-agent-runtime.env`
- `var/runtime-state.json` after enrollment succeeds

The helper is safe to rerun. Reinstalling replaces the managed runtime files in place, refreshes the generated wrappers and environment file, and keeps the same host identity when you reuse the same `--host-id`.

### Enroll And Verify

Enroll the installed runtime with the control plane:

```bash
$HOME/.remote-agent-runtime/bin/remote-agent-runtime-enroll
```

Inspect the local runtime state:

```bash
$HOME/.remote-agent-runtime/bin/remote-agent-runtime-status
```

The runtime upserts its host record through `POST /api/hosts` using the bootstrap token and reports:

- `runtimeVersion`
- `status`
- `health`
- `connectivity`
- `lastSeenAt`

Verify the host from the control plane:

```bash
curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/hosts
```

Rerunning `$HOME/.remote-agent-runtime/bin/remote-agent-runtime-enroll` is also safe. The server upserts the same host record by `id` instead of creating duplicates.

### Local Run

Development:

```bash
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=operator-dev-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=bootstrap-dev-token \
pnpm --filter @remote-agent-server/server dev
```

Built runtime:

```bash
pnpm --filter @remote-agent-server/server build
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=operator-dev-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=bootstrap-dev-token \
pnpm --filter @remote-agent-server/server start
```

### Configuration

The control plane loads configuration from explicit environment variables and can also merge a JSON config file:

- `REMOTE_AGENT_SERVER_OPERATOR_TOKENS`: comma-separated operator tokens used with `Authorization: Bearer <token>`
- `REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS`: comma-separated bootstrap tokens used with `x-bootstrap-token`
- `REMOTE_AGENT_SERVER_HOST`: bind host, default `127.0.0.1`
- `REMOTE_AGENT_SERVER_PORT`: bind port, default `4318`
- `REMOTE_AGENT_SERVER_DATA_FILE`: JSON persistence path, default `.remote-agent-server/control-plane.json`
- `REMOTE_AGENT_SERVER_CONFIG`: optional path to a JSON config file

Example config file:

```json
{
  "host": "127.0.0.1",
  "port": 4318,
  "dataFile": ".remote-agent-server/control-plane.json",
  "operatorTokens": ["operator-dev-token"],
  "bootstrapTokens": ["bootstrap-dev-token"]
}
```

Core metadata for hosts, workspaces, sessions, approvals, notifications, and forwarded ports is persisted to the configured JSON file and reloaded on restart.

### Manual Smoke Test

Start the server, then register a host with the bootstrap token and inspect it with the operator token:

```bash
curl -sS \
  -H 'x-bootstrap-token: bootstrap-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"host-1","name":"devbox","platform":"linux","runtimeVersion":"0.1.0","status":"online"}' \
  http://127.0.0.1:4318/api/hosts

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/hosts

curl -N \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/events
```

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
