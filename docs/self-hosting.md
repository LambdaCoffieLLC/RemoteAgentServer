# Self-Hosting And Deployment

RemoteAgentServer is built for a single operator who self-hosts the control plane, connects one or more runtimes, and uses the web, mobile, or desktop clients as remote control surfaces.

## Supported Deployment Model

- trusted single-user deployment on your own laptop, workstation, VM, or private server
- one control plane process with JSON persistence
- one or more registered runtimes on machines that hold the repositories and services you want to control
- operator clients that connect with a bearer token over your trusted network or reverse proxy

This is the production-ready deployment target for the current repo. Multi-user hosting, role-based access, and internet-hardened multi-tenant deployment are still incomplete.

## Deploy The Control Plane

Install and build from the repo root:

```bash
pnpm install
pnpm --filter @remote-agent-server/server build
```

Start the control plane with explicit bind settings, persistence path, and tokens:

```bash
REMOTE_AGENT_SERVER_HOST=127.0.0.1 \
REMOTE_AGENT_SERVER_PORT=4318 \
REMOTE_AGENT_SERVER_DATA_FILE=/srv/remote-agent-server/control-plane.json \
REMOTE_AGENT_SERVER_OPERATOR_TOKENS=replace-with-operator-token \
REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS=replace-with-bootstrap-token \
pnpm --filter @remote-agent-server/server start
```

The same settings can come from `REMOTE_AGENT_SERVER_CONFIG` pointing at a JSON file:

```json
{
  "host": "127.0.0.1",
  "port": 4318,
  "dataFile": "/srv/remote-agent-server/control-plane.json",
  "operatorTokens": ["replace-with-operator-token"],
  "bootstrapTokens": ["replace-with-bootstrap-token"]
}
```

## Reverse Proxy And Exposure Guidance

- Keep the control plane bound to `127.0.0.1` unless you intentionally want remote access.
- If clients connect from other devices, put the service behind your own reverse proxy and TLS termination.
- Treat permissive CORS support as an MVP convenience for your own deployment, not as a substitute for a hardened browser-facing security posture.
- Back up the JSON persistence file because it holds hosts, workspaces, sessions, approvals, audit entries, notifications, and forwarded-port metadata.

## Install And Connect Runtimes

For a remote Linux runtime host:

```bash
pnpm --filter @remote-agent-server/runtime build

./packages/runtime/scripts/install-linux-runtime.sh \
  --prefix "$HOME/.remote-agent-runtime" \
  --server-url "https://your-control-plane.example.com" \
  --bootstrap-token "replace-with-bootstrap-token" \
  --host-id "devbox-1" \
  --host-name "devbox"

$HOME/.remote-agent-runtime/bin/remote-agent-runtime-enroll
$HOME/.remote-agent-runtime/bin/remote-agent-runtime-status
```

For local development, you can instead:

- start the control plane with `REMOTE_AGENT_SERVER_DEVELOPMENT_MODE=true` for an attached local runtime
- or enroll the local machine with `remote-agent-runtime enroll --host-mode local`

See [runtime-install.md](runtime-install.md) for the detailed runtime workflow.

## Set Up Clients

All clients use the same two values:

- control-plane URL
- operator bearer token

Current client commands:

- web: `pnpm --filter @remote-agent-server/web dev`
- mobile: `pnpm --filter @remote-agent-server/mobile start`
- desktop: `pnpm --filter @remote-agent-server/desktop start`

Client notes:

- The web client stores its connection values in browser storage.
- The mobile client stores them with Expo SecureStore.
- The desktop client stores them in the app data directory with Electron `safeStorage` when available.
- For a physical phone or another machine, use a reachable LAN or reverse-proxied URL instead of `127.0.0.1`.

## Verify The Deployment

With the control plane running:

```bash
curl -sS http://127.0.0.1:4318/health

curl -sS \
  -H 'Authorization: Bearer replace-with-operator-token' \
  http://127.0.0.1:4318/api/hosts
```

Then follow the smoke path in the [root README](../README.md) to register a workspace, start a session, review a diff, inspect the audit log, and open a managed preview.

## Port Forwarding And Security Boundaries

- Detected ports are not exposed externally until you promote them into managed forwards.
- Shared forwarded ports are accessible to anyone who has the managed URL.
- Private forwarded ports still rely on operator bearer-token auth at the control plane.
- Operator APIs and runtime enrollment use different secrets and should stay separate.

## What Is Ready Versus Not Ready

Production-ready for the intended deployment:

- monorepo install and verification flow
- control-plane process with configurable tokens and JSON persistence
- runtime install helper and enrollment flow
- web, mobile, and desktop operator clients for a trusted single operator

MVP but not hardened for broader production:

- scripted provider adapters for `claude-code`, `codex`, and `opencode`
- permissive browser CORS for self-hosted operator access
- JSON-file persistence as the only first-party storage backend

Incomplete:

- multi-user auth and roles
- managed secret distribution and automatic credential rotation
- first-party containers, systemd units, or orchestration manifests
- real upstream provider credential and process integrations

## Related Docs

- [Root README](../README.md)
- [Runtime install guide](runtime-install.md)
- [Provider setup](provider-setup.md)
- [Security expectations](security.md)
