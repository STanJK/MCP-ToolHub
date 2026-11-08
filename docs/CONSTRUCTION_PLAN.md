# MCP-ToolHub V2 Construction Plan

Status: **planning only — no V2 implementation has started**

This document defines the recommended construction order after the top-level architecture is accepted.

## Phase 0 — Archive and freeze V1

- Preserve the exact V1 tree under `deprecated/v1-2026-11-09/`.
- Keep V1 build manifests out of the V2 repository root.
- Treat the archive as read-only reference material.
- Do not import V1 source directly from V2.

Exit condition: V2 branch contains a clean architecture root and the V1 archive is build-isolated.

## Phase 1 — Define contracts before implementations

Freeze data contracts for:

- Project;
- Module descriptor;
- Capability descriptor;
- module-defined constraint schema;
- Access Profile + revision;
- Session;
- Session delta;
- SecretRef;
- audit event.

Do not build UI or module ports before these contracts are readable and reviewable.

Exit condition: the contracts can represent current Local Build, Chrome MCP, and Remote MCP without adding module-specific fields to Core.

## Phase 2 — Core authorization skeleton

Implement only the generic chain:

```text
Session authentication
-> profile/session effective access
-> module capability resolution
-> allow/deny
-> module constraint validation hook
-> execution hook
-> audit
```

No production module needs to be ported yet; use a trivial test module.

Exit condition: a test Session can be created, expire, be revoked, be attenuated, and cannot self-escalate.

## Phase 3 — Secret Store

Implement:

- configured root with repository example value `<自填>`;
- owner/scope/key namespace;
- explicit shared scopes;
- protected local storage;
- management operations without a Reveal function;
- exact secret binding into authorized execution;
- no secret values in audit/log output.

Exit condition: a test capability can consume a secret internally while the caller cannot retrieve it.

## Phase 4 — Control panel

Implement the human hierarchy:

```text
Project
-> Access Profile
-> Session
```

Required first-pass views:

- Project tree;
- Module bindings;
- capability selector generated from Module catalogs;
- Session state / TTL / last-used / revoked;
- visible Session delta markers;
- admin unlock for authority-changing operations;
- audit viewer.

Avoid implementation/runtime topology in the primary UI.

## Phase 5 — Port representative modules

Port in an order that tests the abstraction rather than maximizing feature count:

1. Local Build — simple exact capability set.
2. Remote MCP — credentials and downstream dynamic catalog.
3. Chrome MCP — persistent project state and richer constraints.

If these three fit without Core learning their business semantics, the Module contract is likely sound.

## Phase 6 — CC integration

Preserve the current CC architectural boundary:

- CC owns module hosting/lifecycle/transport integration.
- ToolHub owns capability authorization.
- design a stable AuthContext seam so future CC authentication can replace the initial local Session-token verifier without rewriting capability policy.

## Phase 7 — Remaining module ports

Only after the first three representative modules stabilize:

- IDA;
- JADX;
- LcEDA;
- other modules.

## Build-isolation rule

Future root build and test entry points must use explicit V2 paths and must not recurse into:

```text
deprecated/**
```

The V1 archive is documentation by preservation, not part of the V2 workspace.

## Review gate

Before starting implementation, review the architecture against these questions:

1. Can a Module add a new constrained capability without a Core code change?
2. Can a Session be revoked without understanding Module internals?
3. Can a Profile revision change without silently broadening active Sessions?
4. Can an authorized capability use a secret without exposing it to the caller?
5. Can Project metadata change without changing authority?
6. Can future CC authentication replace local token verification without changing Module semantics?
7. Can all V1 archived code remain completely outside V2 builds?

If any answer is no, refine the contracts before implementation.
