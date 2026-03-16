# Provider Setup

RemoteAgentServer exposes one common provider interface across the current MVP:

- `claude-code`
- `codex`
- `opencode`

## Current MVP Behavior

The runtime ships built-in scripted provider adapters in `packages/runtime/src/provider-adapters.ts`. Those adapters are what the current control plane, smoke paths, and automated tests exercise.

That means:

- you can start sessions with any of the three provider kinds today
- no external provider CLI install is required for the current repo-owned smoke paths
- no provider-specific API key is required to boot the current MVP locally
- provider failures are surfaced as session failures instead of crashing the runtime session manager

Start a session by choosing one of the supported provider kinds:

```bash
curl -sS \
  -H 'Authorization: Bearer operator-dev-token' \
  -H 'content-type: application/json' \
  -d '{"id":"session-1","workspaceId":"workspace-1","provider":"codex"}' \
  http://127.0.0.1:4318/api/sessions
```

## Claude Code

- Provider id: `claude-code`
- Current setup: no external CLI install is required for the repo-owned MVP flow
- Current behavior: the scripted adapter emits repository-context and planning output through the shared runtime session manager
- Production status: MVP contract coverage only; real upstream Claude Code credential handling and process integration are still incomplete

## Codex

- Provider id: `codex`
- Current setup: no external CLI install is required for the repo-owned MVP flow
- Current behavior: the scripted adapter emits workspace inspection and patch-application output through the shared runtime session manager
- Production status: MVP contract coverage only; real upstream Codex credential handling and process integration are still incomplete

## OpenCode

- Provider id: `opencode`
- Current setup: no external CLI install is required for the repo-owned MVP flow
- Current behavior: the scripted adapter emits indexing and patch-generation output through the shared runtime session manager
- Production status: MVP contract coverage only; real upstream OpenCode credential handling and process integration are still incomplete

## What Each Provider Emits In The MVP

- `claude-code`: scripted repository-context and planning output
- `codex`: scripted workspace inspection and patch-application output
- `opencode`: scripted indexing and patch-generation output

The server and clients treat those providers through the same shared contract, so the operator workflow is the same regardless of provider choice.

## Setup Expectations

- Choose the provider name in the session payload or client UI. The server and clients reuse the same shared provider contract.
- The current production-ready story is the common adapter interface and the single-user operator workflow, not a hardened upstream provider integration.
- If you need real provider credentials, process supervision, or provider-specific secret storage, treat that as future work beyond the current MVP.

## Limitations

- The current provider layer proves the shared session contract, not a production integration with upstream provider services.
- Approval prompts are part of the provider contract, but the default local smoke path does not force an approval request on every run.
- Real provider credential handling should be added in a future story before claiming production-ready upstream provider support.

## Related Docs

- [Root README](../README.md)
- [Self-hosting and deployment](self-hosting.md)
- [Architecture overview](architecture.md)
- [Security expectations](security.md)
