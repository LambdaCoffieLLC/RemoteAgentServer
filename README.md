# RemoteAgentServer

RemoteAgentServer now starts from a pnpm monorepo baseline so the control plane, runtimes, clients, and shared packages can evolve in one TypeScript-first workspace.

## Quickstart

```bash
pnpm install
pnpm --filter @remote-agent-server/server build
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=operator-dev-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=bootstrap-dev-token \
pnpm --filter @remote-agent-server/server dev
pnpm --filter @remote-agent-server/web dev
pnpm --filter @remote-agent-server/web build
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
- workspaces at `/api/workspaces` and `/api/workspaces/:id`
- sessions at `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/changes`, `/api/sessions/:id/diff`, and `/api/sessions/:id/{pause,resume,cancel}`
- approvals at `/api/approvals`
- notifications at `/api/notifications`
- forwarded ports at `/api/ports`
- real-time server-sent events at `/api/events`

`GET /health` is public. The API surfaces require an operator token, except `POST /api/hosts`, which also accepts a bootstrap token so runtimes can enroll.

For the browser client, the control plane also sends permissive CORS headers for this single-user bearer-token setup so the web app can connect directly from a different origin during development or self-hosted deployment.

## Web Client

The web app at `apps/web` is now a runnable browser client. It lets an operator sign in with a control-plane URL plus operator token and then view:

- hosts
- workspaces
- sessions
- approvals
- forwarded ports
- detected ports

The UI also streams live session events, reviews changed files and paginated diffs, sends approval decisions, and exposes shared HTTP preview links.

### Local Run

Start the control plane first, then in a second terminal run:

```bash
pnpm --filter @remote-agent-server/web dev
```

Open the printed Vite URL in a browser and sign in with:

- server URL: `http://127.0.0.1:4318`
- operator token: `operator-dev-token`

### Build

```bash
pnpm --filter @remote-agent-server/web build
pnpm --filter @remote-agent-server/web preview
```

### Browser Smoke Path

With the control plane running and seeded with at least one host, workspace, and shared HTTP forward:

1. Open the web app and sign in with the operator token.
2. Confirm the dashboard lists hosts, workspaces, sessions, forwarded previews, and detected ports.
3. Start or wait for a session so the live event panel receives `session.*` or `approval.*` events.
4. Open a session review from the Sessions panel and page through its diff.
5. Approve or reject a pending privileged action from the Approvals panel.
6. Open a shared HTTP preview from the Forwarded previews panel.

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

### Workspace Registration

Managed workspaces are registered through `POST /api/workspaces`. The control plane requires:

- `hostId`: an existing registered host
- `path`: a repository path the control plane can access on disk
- `runtimeHostId`: optional, defaults to `hostId`
- `defaultBranch`: optional, auto-detected from the git repository when omitted

Workspace registration fails with a clear `400` error when the host is unknown, the path is inaccessible, or the target path is not a git repository. Operators can list workspaces with `GET /api/workspaces`, inspect one with `GET /api/workspaces/<workspace-id>`, and remove one with `DELETE /api/workspaces/<workspace-id>`.

### Session Lifecycle

Managed coding sessions are started through `POST /api/sessions` with:

- `workspaceId`: an existing registered workspace
- `provider`: one of `claude-code`, `codex`, or `opencode`
- `id`: optional, otherwise the control plane generates one
- `mode`: optional, defaults to `workspace`; set to `worktree` to create an isolated git worktree for the session before runtime launch
- `allowDirtyWorkspace`: optional, defaults to `false`; when omitted, session start rejects a workspace checkout with uncommitted or untracked changes

The runtime package now exposes a common provider adapter surface and ships built-in adapters for `claude-code`, `codex`, and `opencode`. The session manager launches every provider through that same adapter contract and turns provider launch/runtime failures into failed sessions with preserved logs and output instead of crashing the runtime.

The control plane starts the session against the workspace's runtime host, persists recoverable session state, and streams live runtime-originated events over `GET /api/events`:

- `session.upserted` when the session record is created
- `session.state.changed` for `queued`, `running`, `paused`, `completed`, `failed`, and `canceled`
- `session.log` for structured runtime log lines
- `session.output` for stdout or stderr chunks
- `session.snapshot` on a fresh SSE connection so reconnecting clients can recover active session state

Workspace mode keeps the execution path pointed at the registered repository for simple workflows. Worktree mode creates a sibling checkout under `.remote-agent-server-worktrees/<workspace-id>/...`, stores the worktree path and branch metadata on the session record, and points runtime execution at that isolated checkout instead. Clients can inspect the current recoverable session state, including accumulated logs, output, `executionPath`, and optional `worktree` metadata, with `GET /api/sessions/<session-id>`. Operators can pause, resume, and cancel active sessions with `POST /api/sessions/<session-id>/pause`, `POST /api/sessions/<session-id>/resume`, and `POST /api/sessions/<session-id>/cancel`. Reconnecting SSE clients can also send `Last-Event-ID` to replay missed session events from the in-memory backlog.

### Privileged Action Approvals

Providers can now raise privileged actions through a shared approval interface. When a provider requests approval, the runtime moves the session to `blocked`, the control plane persists a pending record under `GET /api/approvals`, and the server broadcasts `approval.requested`.

Operators can then decide the pending action with:

- `POST /api/approvals/<approval-id>/decision` and body `{"status":"approved"}`
- `POST /api/approvals/<approval-id>/decision` and body `{"status":"rejected"}`

Approved actions return the session to `running` and let the provider continue. Rejected actions are surfaced back into the runtime as a clean session failure with an explicit rejection message. Every approval decision is also appended to the persisted JSON audit log with actor, target, timestamp, and outcome metadata.

### Session Change Review

Operators can review git-backed session changes without leaving the control plane:

- `GET /api/sessions/<session-id>/changes` returns the changed-file list for the session execution path, including whether each file was added, modified, renamed, or removed plus a compact patch summary.
- `GET /api/sessions/<session-id>/diff` returns diff text for the full session or a single file. Use the optional `path`, `page`, and `pageSize` query parameters to focus the review and page through large diffs.

Large diffs degrade gracefully through pagination. The diff response includes `page`, `pageSize`, `totalLines`, `totalPages`, `previousPage`, `nextPage`, and `truncated` so clients can progressively load more of a patch instead of rendering the full diff at once.

If stale worktrees need to be cleaned up manually, list them from the registered repository and then remove or prune them with git:

```bash
git -C "$REPO_PATH" worktree list
git -C "$REPO_PATH" worktree remove --force "$WORKTREE_PATH"
git -C "$REPO_PATH" worktree prune
```

### Port Forwarding

Operators can manually register forwarded ports through `POST /api/ports`. A forwarded port must reference a registered `hostId` and can also be scoped to a `workspaceId` or `sessionId`.

- `GET /api/ports` returns active forwarded ports by default and supports `hostId`, `workspaceId`, and `sessionId` filters.
- Add `includeInactive=true` to include closed or expired forwards in the response.
- Add `includeDetected=true` to include detected-but-not-forwarded ports in the response for browser or other client inventory views.
- `POST /api/ports/<port-id>/open` reopens a forward and can optionally update `expiresAt`.
- `POST /api/ports/<port-id>/close` closes a forward without deleting it.
- `POST /api/ports/<port-id>/expire` forces an immediate transition to `expired`.

HTTP forwards receive a managed URL at `/ports/<port-id>`. Shared forwards can be opened directly by any client with the URL. Private forwards require the operator bearer token on the managed URL request. In this MVP, the control plane proxies the configured `targetHost:port`, so that target must be reachable from the control-plane machine.

### Manual Smoke Test

Start the server, then register a host with the bootstrap token, register the current checkout as a workspace, start a session, monitor it over SSE, and exercise pause, resume, cancel, and recovery with the operator token:

```bash
REPO_PATH=$(pwd)

curl -sS \
  -H 'x-bootstrap-token: bootstrap-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"host-1","name":"devbox","platform":"linux","runtimeVersion":"0.1.0","status":"online"}' \
  http://127.0.0.1:4318/api/hosts

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/hosts

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d "{\"id\":\"workspace-1\",\"hostId\":\"host-1\",\"path\":\"${REPO_PATH}\"}" \
  http://127.0.0.1:4318/api/workspaces

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/workspaces

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/workspaces/workspace-1

curl -N \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/events

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"session-1","workspaceId":"workspace-1","provider":"codex"}' \
  http://127.0.0.1:4318/api/sessions

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"session-worktree","workspaceId":"workspace-1","provider":"codex","mode":"worktree"}' \
  http://127.0.0.1:4318/api/sessions

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/sessions/session-1

printf 'review change\n' >> "${REPO_PATH}/README.md"

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/sessions/session-1/changes

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  "http://127.0.0.1:4318/api/sessions/session-1/diff?path=README.md&page=1&pageSize=40"

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/sessions/session-1/pause

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/sessions/session-1/resume

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/sessions/session-1/cancel

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/approvals

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"status":"approved"}' \
  http://127.0.0.1:4318/api/approvals/<approval-id>/decision

curl -N \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'Last-Event-ID: <event-id-from-earlier-stream>' \
  http://127.0.0.1:4318/api/events

node --eval "import { createServer } from 'node:http'; createServer((_, res) => res.end('preview-ok')).listen(4173, '127.0.0.1')"

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"preview-1","hostId":"host-1","workspaceId":"workspace-1","sessionId":"session-1","port":4173,"protocol":"http","visibility":"shared","label":"Preview","targetHost":"127.0.0.1"}' \
  http://127.0.0.1:4318/api/ports

curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  'http://127.0.0.1:4318/api/ports?workspaceId=workspace-1'

curl -sS \
  http://127.0.0.1:4318/ports/preview-1

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/ports/preview-1/close

curl -sS -X POST \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"expiresAt":"2099-01-01T00:00:00.000Z"}' \
  http://127.0.0.1:4318/api/ports/preview-1/open

curl -sS -X DELETE \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/workspaces/workspace-1
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
