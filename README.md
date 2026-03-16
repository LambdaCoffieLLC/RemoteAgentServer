# RemoteAgentServer

RemoteAgentServer is a single-user, self-hosted remote development control plane. It gives one operator a central place to register hosts and repositories, start coding-agent sessions, review diffs, handle approval prompts, and open forwarded previews from web or mobile clients instead of managing everything over SSH.

The current MVP is runnable today for the control plane plus two operator clients:

- `apps/server`: Node.js control plane with JSON persistence, token auth, session APIs, approvals, and port forwarding
- `apps/web`: Vite web operator client for inventory, live session events, review, approvals, and previews
- `apps/mobile`: Expo mobile operator client for the same operator flow on iOS or Android
- `apps/desktop`: TypeScript package scaffold only; not yet a finished desktop operator app
- `packages/runtime`: runtime contract, Linux install helper, enrollment CLI, and provider session manager
- `packages/auth`, `packages/protocol`, `packages/sessions`, `packages/ports`, `packages/providers`, `packages/ui`: shared domain packages consumed by the apps

## Quickstart

### Prerequisites

- Node.js 20+
- pnpm 10+
- a shell that can run the commands below

Install the workspace once from the repo root:

```bash
pnpm install
```

### Boot The Control Plane

Run the control plane in one terminal:

```bash
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=operator-dev-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=bootstrap-dev-token \
pnpm --filter @remote-agent-server/server dev
```

The control plane listens on `http://127.0.0.1:4318` by default and persists state under `.remote-agent-server/control-plane.json`.

To attach a first-class local runtime in development mode instead of registering every host manually, run the control plane with local mode enabled:

```bash
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=operator-dev-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=bootstrap-dev-token \
REMOTE_AGENT_SERVER_DEVELOPMENT_MODE=true \
REMOTE_AGENT_SERVER_LOCAL_HOST_ID=local-dev-host \
REMOTE_AGENT_SERVER_LOCAL_HOST_NAME='Local development runtime' \
REMOTE_AGENT_SERVER_LOCAL_PLATFORM=darwin \
pnpm --filter @remote-agent-server/server dev
```

When development mode is enabled, `GET /api/hosts` includes that attached runtime as `hostMode: "local"` and `connectionMode: "attached"`. Registered runtimes continue to use `connectionMode: "registered"`.

### Local And Remote Runtime Modes

Local and remote runtimes now share the same workspace and session APIs. The distinction is carried in host metadata instead of separate provider or session implementations:

- `hostMode: "remote"` with `connectionMode: "registered"` for the normal enrolled runtime flow
- `hostMode: "local"` with `connectionMode: "registered"` when the same runtime CLI enrolls a local machine with the server
- `hostMode: "local"` with `connectionMode: "attached"` when the control plane starts in development mode

After `pnpm build`, the same runtime CLI used for remote enrollment can register a local machine with the server:

```bash
pnpm --filter @remote-agent-server/runtime exec remote-agent-runtime enroll \
  --server-url http://127.0.0.1:4318 \
  --bootstrap-token bootstrap-dev-token \
  --host-id laptop-local \
  --host-name 'Laptop runtime' \
  --platform darwin \
  --host-mode local
```

The web and mobile clients render those local versus remote host labels directly from the control-plane host records.

### Launch The Runnable Clients

Start the current browser client in a second terminal:

```bash
pnpm --filter @remote-agent-server/web dev
```

Start the current mobile client in a third terminal:

```bash
pnpm --filter @remote-agent-server/mobile start
```

Use these connection settings in the web UI or Expo app:

- server URL: `http://127.0.0.1:4318`
- operator token: `operator-dev-token`

When using a physical phone, replace `127.0.0.1` with a reachable LAN address such as `http://192.168.1.15:4318`.

### Build And Verify

These are the root commands contributors are expected to use:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm verify
```

`pnpm verify` is the full local and CI verification flow. CI should run `pnpm install --frozen-lockfile` and then `pnpm verify` via [.github/workflows/verify.yml](.github/workflows/verify.yml).

## MVP Smoke Test

This smoke path proves the current MVP from the repo root with the control plane already running.

### Seed A Host, Workspace, Session, And Preview

```bash
REPO_PATH=$(pwd)

curl -sS \
  -H 'x-bootstrap-token: bootstrap-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"host-1","name":"devbox","platform":"linux","runtimeVersion":"0.1.0","status":"online"}' \
  http://127.0.0.1:4318/api/hosts

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d "{\"id\":\"workspace-1\",\"hostId\":\"host-1\",\"path\":\"${REPO_PATH}\"}" \
  http://127.0.0.1:4318/api/workspaces

curl -N \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/events

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"session-1","workspaceId":"workspace-1","provider":"codex"}' \
  http://127.0.0.1:4318/api/sessions

printf 'smoke change\n' >> "${REPO_PATH}/.remote-agent-smoke.txt"

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/sessions/session-1/changes

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  "http://127.0.0.1:4318/api/sessions/session-1/diff?path=.remote-agent-smoke.txt&page=1&pageSize=40"

node --eval "import { createServer } from 'node:http'; createServer((_, res) => res.end('preview-ok')).listen(4173, '127.0.0.1')"

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  "http://127.0.0.1:4318/api/ports?workspaceId=workspace-1&includeDetected=true"

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"visibility":"shared"}' \
  http://127.0.0.1:4318/api/ports/detected-workspace-workspace-1-4173/open

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/ports

curl -sS http://127.0.0.1:4318/ports/detected-workspace-workspace-1-4173
```

### Confirm The Runnable Clients

1. Open the web client, sign in, and confirm it shows the enrolled host, workspace, session, and the detected preview suggestion before you promote it.
2. Open the Expo app, sign in with the same URL and token, and confirm it shows the host and live session state.
3. In the web client, open the session review and confirm the diff includes `.remote-agent-smoke.txt`.
4. Promote the detected preview from the web client and confirm the managed preview returns `preview-ok`.

### Clean Up The Smoke Test

```bash
rm -f "${REPO_PATH}/.remote-agent-smoke.txt"

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/ports/detected-workspace-workspace-1-4173/close

curl -sS -X DELETE \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/workspaces/workspace-1
```

## Ralph Loop Workflow

Ralph uses one repo branch per loop attempt. The branch Ralph works on is defined by `prd.json` in the top-level `branchName` field, which is currently `ralph-loop-attempt-2`.

- `pnpm ralph` requires a clean git worktree before it starts.
- The runner checks out `prd.json.branchName`, creating that branch if it does not already exist.
- Ralph then works one story at a time and commits successful stories onto that attempt branch with commit messages like `US-022: Improve the README for operators and contributors`.

To start a new attempt branch:

```bash
git checkout main
git checkout -b ralph-loop-attempt-3
node --eval "const fs = require('node:fs'); const file = 'prd.json'; const prd = JSON.parse(fs.readFileSync(file, 'utf8')); prd.branchName = 'ralph-loop-attempt-3'; fs.writeFileSync(file, JSON.stringify(prd, null, 2) + '\n')"
pnpm verify:ralph
pnpm ralph
```

If you are resuming an existing attempt instead of creating a new one, leave `prd.json.branchName` unchanged and rerun `pnpm ralph` from a clean worktree.

## Deeper Docs

- [Runtime install guide](docs/runtime-install.md)
- [Architecture overview](docs/architecture.md)
- [Provider setup](docs/provider-setup.md)
- [Security expectations](docs/security.md)
- [Ralph runner details](.agents/ralph/README.md)

## Monorepo Commands

- `pnpm install` installs all workspace dependencies from the repo root.
- `pnpm build` builds every first-party workspace package with TypeScript.
- `pnpm lint` applies the centralized ESLint rules to the repo and all workspaces.
- `pnpm typecheck` runs root and workspace TypeScript checks.
- `pnpm test` runs the product-owned repo test suites first and then the Ralph loop tests.
- `pnpm verify` runs the full local and CI verification flow in one command, including product-owned tests plus Ralph loop tests.
- `pnpm verify:ralph` keeps Ralph pointed at the same root verification flow.
- `pnpm ralph` and `pnpm ralph:danger` run the local Ralph automation.

## Product Test Coverage

Product behavior is owned by the repo-level `tests/` suite. Ralph-specific checks stay in `.agents/ralph/tests` and are not the sole proof for story completion.

- Unit coverage: `tests/shared-packages.test.ts` exercises the shared package business logic and package contracts.
- Integration coverage: `tests/server-control-plane.test.ts`, `tests/runtime-install.test.ts`, `tests/runtime-provider-adapters.test.ts`, `tests/session-diff-review.test.ts`, and `tests/session-recovery-clients.test.ts` cross real package boundaries for the server, runtime, and client wrappers.
- Smoke coverage: `tests/web-client-smoke.test.ts` and `tests/mobile-app-smoke.test.ts` cover the primary operator journeys on the current client surfaces.
- Command ownership: `pnpm run test:repo` executes the product-owned suites in `tests/**/*.test.ts`, `pnpm run test:ralph` executes `.agents/ralph/tests/*.test.ts`, and `pnpm test` or `pnpm verify` runs both layers.
- Extension rule: future stories should add the lowest-layer product-owned test that proves the behavior change, then add or extend smoke coverage when the change is user-facing.

## Shared Package Boundaries

The shared core model is split into focused workspace packages so server, runtime, and clients import the same domain contracts instead of re-declaring local copies.

- `@remote-agent-server/protocol`: shared control-plane envelopes, application kinds, and package identifiers.
- `@remote-agent-server/auth`: token schemes and auth policies used by the server, runtime enrollment, and clients.
- `@remote-agent-server/sessions`: session identifiers, lifecycle states, and workspace/worktree execution modes.
- `@remote-agent-server/ports`: detected and forwarded port metadata, visibility, and presentation labels.
- `@remote-agent-server/providers`: provider adapter identities and launch descriptors for Claude Code, Codex, and OpenCode.
- `@remote-agent-server/ui`: UI-safe primitives such as navigation items and status badges for client surfaces.

The intended dependency direction is from apps and feature packages inward to these shared packages. `packages/runtime` composes the shared domain packages, while app packages depend on the shared packages and the runtime package rather than redefining auth, session, port, provider, or UI models locally.

## Repo Layout

```text
repo/
├── apps/
│   ├── desktop/
│   ├── mobile/
│   ├── server/
│   └── web/
├── docs/
│   ├── architecture.md
│   ├── provider-setup.md
│   ├── runtime-install.md
│   └── security.md
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
├── .github/
│   └── workflows/
├── eslint.config.mjs
├── package.json
├── pnpm-workspace.yaml
├── prd.json
└── tsconfig.package.json
```

## Centralized Tooling

- `pnpm-workspace.yaml` defines all first-party workspace packages.
- `tsconfig.base.json` and `tsconfig.package.json` provide shared TypeScript defaults for apps and packages.
- `eslint.config.mjs` centralizes lint rules for repo tooling and workspace code.
- `.prettierrc.json` centralizes formatting rules for the whole monorepo.

## Notes

- `prd.json` remains the canonical execution spec.
- The current MVP is intentionally scoped to a single operator and self-hosted deployment.
- The root `README` is the fast path; the linked docs above hold the deeper runtime, architecture, provider, and security detail.
