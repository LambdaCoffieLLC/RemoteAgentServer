# Remote Linux Runtime Install

The runtime install flow in this repository supports systemd-based Linux hosts in these families:

- Ubuntu/Debian: Ubuntu 22.04+ and Debian 12+
- RHEL/Fedora: RHEL 9+, Rocky Linux 9+, and Fedora 40+

## Prerequisites

- A running RemoteAgentServer control plane
- A bootstrap token configured on the server
- Node.js 20+ on the remote host
- A writable install directory such as `/opt/remote-agent-runtime`

## Install Flow

1. Copy the runtime package or repository to the remote host.
2. Run the Linux installer helper with the control-plane origin and bootstrap token.
3. Write the generated environment file and systemd unit to the host.
4. Start or restart the `remote-agent-runtime` service.
5. The runtime enrolls with `POST /v1/runtime/enroll` by sending the bootstrap token in the `x-bootstrap-token` header.
6. After enrollment, the runtime reports version, health, and connectivity with `POST /v1/runtime/status`.

## Rerun Safety

The install flow is safe to rerun on an already configured host:

- The installer reuses the saved `hostId`, `runtimeId`, and original `installedAt` timestamp from `remote-agent-runtime.json`.
- Rewriting the environment file or systemd unit is idempotent.
- Re-enrollment returns an update for the existing host record instead of creating duplicates.

## Example

```ts
import { enrollInstalledRuntime, installLinuxRuntime, reportInstalledRuntimeStatus } from '@remote-agent/runtime'

const install = await installLinuxRuntime({
  installRoot: '/opt/remote-agent-runtime',
  serverOrigin: 'https://control-plane.example.com',
  bootstrapToken: process.env.REMOTE_AGENT_BOOTSTRAP_TOKEN!,
  hostLabel: 'build-linux-01',
  hostname: 'build-linux-01',
  version: '1.2.3',
})

await enrollInstalledRuntime({ install })

await reportInstalledRuntimeStatus({
  install,
  version: '1.2.3',
  health: 'healthy',
  connectivity: 'connected',
})
```
