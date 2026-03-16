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

## What Each Provider Emits In The MVP

- `claude-code`: scripted repository-context and planning output
- `codex`: scripted workspace inspection and patch-application output
- `opencode`: scripted indexing and patch-generation output

The server and clients treat those providers through the same shared contract, so the operator workflow is the same regardless of provider choice.

## Limitations

- The current provider layer proves the shared session contract, not a production integration with upstream provider services.
- Approval prompts are part of the provider contract, but the default local smoke path does not force an approval request on every run.
- Real provider credential handling should be added in a future story before claiming production-ready upstream provider support.

## Related Docs

- [Root README](../README.md)
- [Architecture overview](architecture.md)
- [Security expectations](security.md)
