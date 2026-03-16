# Runtime Install Guide

The runtime install flow is for a Linux host that should enroll with the RemoteAgentServer control plane and then run sessions against managed repositories on that machine.

## Prerequisites

- Linux with Bash and standard coreutils
- Node.js 20+
- a checkout of this repository
- `pnpm install` already run in that checkout
- a reachable control-plane URL and bootstrap token

The current helper-driven installer is intended for modern Ubuntu, Debian, Fedora, and RHEL-derived systems that meet those prerequisites.

## Build And Install

From the repo root on the target Linux host:

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

The installer writes:

- `bin/remote-agent-runtime`
- `bin/remote-agent-runtime-enroll`
- `bin/remote-agent-runtime-status`
- `etc/remote-agent-runtime.env`
- `var/runtime-state.json` after enrollment succeeds

The helper is safe to rerun. Reinstalling refreshes the managed files in place and preserves host identity when the same `--host-id` is reused.

## Enroll And Verify

Enroll the installed runtime:

```bash
$HOME/.remote-agent-runtime/bin/remote-agent-runtime-enroll
```

Inspect its local state:

```bash
$HOME/.remote-agent-runtime/bin/remote-agent-runtime-status
```

Verify the enrolled host from the control plane:

```bash
curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  http://127.0.0.1:4318/api/hosts
```

The runtime reports its `runtimeVersion`, `status`, `health`, `connectivity`, and `lastSeenAt` through `POST /api/hosts`.

## Configuration

The control plane supports both environment variables and an optional JSON config file.

- `REMOTE_AGENT_SERVER_OPERATOR_TOKENS`: comma-separated bearer tokens for operator clients
- `REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS`: comma-separated bootstrap tokens for runtime enrollment
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

## Related Docs

- [Root README](../README.md)
- [Architecture overview](architecture.md)
- [Security expectations](security.md)
