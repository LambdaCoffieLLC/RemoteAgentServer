# Architecture Overview

RemoteAgentServer is organized as a pnpm TypeScript monorepo. The product is intentionally scoped to a single-user, self-hosted control plane with shared contracts across the server, runtime, and clients.

## Major Components

- `apps/server`: the control plane. It owns token auth, JSON APIs, JSON persistence, server-sent events, approvals, and managed port forwarding.
- `packages/runtime`: the runtime contract and session manager. It launches provider adapters, emits logs and output, and contains the Linux installer and status CLI.
- `apps/web`: browser operator client for hosts, workspaces, sessions, approvals, diffs, and previews.
- `apps/mobile`: Expo operator client for the same control-plane workflow on mobile devices.
- `apps/desktop`: Electron operator client for the same control-plane workflow on desktop, including stored connection settings, local and remote workspace switching, approvals, and previews.

## Shared Packages

- `packages/protocol`: control-plane envelopes and shared identifiers
- `packages/auth`: token policies and auth helpers
- `packages/sessions`: session lifecycle, worktree, and change-review contracts
- `packages/ports`: detected and forwarded port contracts
- `packages/providers`: provider kinds and approval models
- `packages/ui`: UI-safe shared presentation primitives

The dependency direction flows inward. Apps depend on the shared packages and, where needed, `packages/runtime`. Shared domain packages do not depend on app packages.

## Runtime Flow

1. An operator authenticates to `apps/server` with a bearer token.
2. A runtime host either enrolls with a bootstrap token through `POST /api/hosts` or is attached locally when the control plane runs in development mode.
3. Hosts carry shared runtime metadata: `hostMode` distinguishes local versus remote and `connectionMode` distinguishes attached versus registered runtimes.
4. A repository path is registered as a workspace on that host.
5. The operator starts a session for `claude-code`, `codex`, or `opencode`.
6. The runtime session manager emits logs, output, and state transitions through the same in-process runtime abstractions for both local and remote hosts.
7. The control plane persists recoverable metadata and streams live events through `GET /api/events`.
8. Web and mobile clients reconnect to the same control plane and recover active session state from the server.

## Persistence And Networking

- The control plane persists hosts, workspaces, sessions, approvals, audit entries, notifications, and forwarded ports to one JSON file.
- Real-time updates are delivered over server-sent events instead of WebSockets.
- Managed HTTP previews are proxied through `/ports/<port-id>`.
- Session diffs are read from git state at the execution path and paginated by the control plane when needed.

## Test Ownership

- Product-owned behavior is validated in `tests/**/*.test.ts`.
- Ralph runner checks live under `.agents/ralph/tests`.
- `pnpm verify` runs lint, build, typecheck, product-owned tests, and Ralph tests together.

## Related Docs

- [Root README](../README.md)
- [Self-hosting and deployment](self-hosting.md)
- [Runtime install guide](runtime-install.md)
- [Provider setup](provider-setup.md)
- [Security expectations](security.md)
