# Security Expectations

RemoteAgentServer is currently an MVP for a single-user, self-hosted deployment. The security model is intentionally simple and should be treated as operator-owned infrastructure, not a multi-tenant hosted service.

## Deployment Trust Model

- Production-ready means a trusted single-user deployment that you control end to end.
- MVP means the current service is useful and documented, but not hardened for hostile networks or multi-tenant use.
- Incomplete means internet-exposed hardening, role separation, managed secret distribution, and upstream provider credential flows are not delivered yet.

## Auth Boundaries

- `GET /health` is public.
- Operator APIs require `Authorization: Bearer <token>`.
- Runtime enrollment uses `x-bootstrap-token`.
- Operator tokens and bootstrap tokens must come from environment variables or a config file; the example tokens in the README are development values, not fixed production secrets.

## Storage And Secrets

- The control plane persists state to a JSON file at `.remote-agent-server/control-plane.json` by default.
- Protect that file with local filesystem permissions because it contains operational metadata.
- The web client stores the control-plane URL and operator token in browser storage for this single-user setup.
- The mobile client stores the same settings with Expo SecureStore.
- The desktop client stores the same settings in the app data directory, using Electron `safeStorage` when available and a user-scoped fallback otherwise.

## Network Expectations

- The control plane binds to `127.0.0.1` by default.
- The web client relies on permissive CORS headers so a self-hosted operator can connect from another local origin; do not treat that as a hardened browser-security posture for an internet-exposed deployment.
- Shared forwarded ports are intentionally reachable by anyone who has the managed URL.
- Private forwarded ports still require the operator bearer token when requesting `/ports/<port-id>`.

## Port Forwarding Boundaries

- Detected ports are only local metadata until the operator explicitly opens them as managed forwards.
- Opening a managed forward creates the URL exposed through `/ports/<port-id>`.
- Shared visibility is appropriate only for trusted collaborators or private networks because possession of the URL is sufficient access.
- Private visibility still depends on bearer-token auth at the control plane boundary; it does not create a separate end-to-end network tunnel auth layer.

## Operational Guidance

- Keep the control plane on a trusted network or behind your own reverse proxy and TLS termination.
- Use distinct operator and bootstrap tokens.
- Rotate tokens manually if a browser profile, mobile device, or runtime host is compromised.
- Treat registered workspaces and optional session worktrees as code-execution surfaces that can modify the target repository.

## Current Limitations

- This repo does not yet implement multi-user auth, role separation, or hardened secret distribution.
- The current provider setup is contract-focused and not a fully hardened upstream provider integration.
- Review the current MVP boundaries before exposing the service beyond a trusted environment.

## Related Docs

- [Root README](../README.md)
- [Self-hosting and deployment](self-hosting.md)
- [Runtime install guide](runtime-install.md)
- [Provider setup](provider-setup.md)
