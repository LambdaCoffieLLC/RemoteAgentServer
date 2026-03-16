# Security Expectations

RemoteAgentServer is currently an MVP for a single-user, self-hosted deployment. The security model is intentionally simple and should be treated as operator-owned infrastructure, not a multi-tenant hosted service.

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

## Network Expectations

- The control plane binds to `127.0.0.1` by default.
- The web client relies on permissive CORS headers so a self-hosted operator can connect from another local origin; do not treat that as a hardened browser-security posture for an internet-exposed deployment.
- Shared forwarded ports are intentionally reachable by anyone who has the managed URL.
- Private forwarded ports still require the operator bearer token when requesting `/ports/<port-id>`.

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
- [Runtime install guide](runtime-install.md)
- [Provider setup](provider-setup.md)
