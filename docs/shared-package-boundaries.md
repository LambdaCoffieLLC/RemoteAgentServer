# Shared package boundaries

The monorepo keeps domain contracts in focused packages so every app and service compiles against the same model.

## Core packages

- `@remote-agent/protocol`: foundational identifiers, manifests, and protocol envelopes used everywhere else.
- `@remote-agent/auth`: authenticated actor and authorization policy types. Depends on `@remote-agent/protocol`.
- `@remote-agent/sessions`: provider-backed session lifecycle types. Depends on `@remote-agent/protocol`, `@remote-agent/auth`, and `@remote-agent/providers`.
- `@remote-agent/ports`: forwarded-port types and visibility rules. Depends on `@remote-agent/protocol`.
- `@remote-agent/providers`: shared provider descriptors and capabilities for Claude Code, Codex, and OpenCode.
- `@remote-agent/ui`: UI-facing primitives for client navigation and surface summaries. Depends on `@remote-agent/protocol`, `@remote-agent/auth`, `@remote-agent/sessions`, `@remote-agent/ports`, and `@remote-agent/providers`.

## Compatibility package

- `@remote-agent/shared`: barrel package that re-exports the core packages for compatibility while new code imports the focused packages directly.

## Consumption rules

- Server code consumes protocol, auth, sessions, ports, and provider types directly.
- Runtime code consumes protocol, sessions, ports, and provider types directly.
- Web, mobile, and desktop clients consume the same domain types plus `@remote-agent/ui` for client-facing primitives.
- Each shared package exposes its TypeScript types from `src/index.ts`, so `pnpm typecheck` validates downstream apps against current source definitions instead of stale build output.
