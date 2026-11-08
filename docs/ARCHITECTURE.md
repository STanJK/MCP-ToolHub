# MCP-ToolHub V2 Architecture

Status: **canonical top-level design draft**  
Branch: `V2`  
V1 archive: `deprecated/v1-2026-11-09/`

## 1. Purpose

MCP-ToolHub V2 is a personal capability control plane for exposing selected local and remote capabilities to an LLM-driven operator workflow without turning the LLM into an authority-bearing autonomous principal.

The governing model is:

> Human intent defines what should be done.  
> The LLM may reason about and compose operations.  
> Authority is defined outside the model and cannot be expanded by the model.

V2 is not an enterprise IAM system, not an autonomous-agent platform, and not a general remote shell.

Its job is narrower:

- organize real workstation projects and downstream capability bindings;
- let modules declare what they can do and how their capabilities can be constrained;
- let the operator create reusable access profiles;
- let the operator issue short-lived, revocable sessions to individual conversations or other clients;
- keep secrets outside model-visible configuration and model-visible results;
- execute only capabilities that survive the complete authorization chain;
- keep a compact audit trail of authorization and execution.

## 2. V1 archive and build isolation

The complete V1 repository tree is preserved under:

```text
deprecated/v1-2026-11-09/
```

The archive is historical source only.

V2 root-level build tooling MUST NOT discover, compile, package, test, stage, or otherwise treat `deprecated/` as active source.

During the architecture phase the V2 root intentionally contains no active V1 build manifest. Future V2 build systems MUST explicitly target V2 source directories and MUST exclude `deprecated/**`.

No V2 module may import code from `deprecated/**`. Reuse requires an explicit port into the V2 source tree.

## 3. Top-level user model

The operator-facing model contains five primary concepts:

```text
Project
Module
Access Profile
Session
Secret Store
```

Capabilities are declared by Modules and selected by Access Profiles / Sessions.

The normal human path is:

```text
Project
  -> Access Profile
      -> Session
```

Modules act as the capability library. Secret Store is system infrastructure.

## 4. Project

A Project is a human organizational object.

It answers:

> What am I working on, where does it live on the real machine, and which downstream capability objects belong to this work?

A Project may contain:

- a stable project ID;
- display name and description;
- working directory / workspace location;
- optional human notes;
- module bindings;
- access profiles.

Example:

```text
Project: EDU_PULSE
WD: <local absolute path>

Bindings:
  Local Build -> EDU_PULSE
  Chrome MCP  -> edu-pulse-dev
  Remote MCP  -> cloudbase / edu-pulse-dev
```

### Project invariants

A Project:

- is NOT an authentication principal;
- is NOT an authorization boundary by itself;
- does NOT grant capabilities merely because a module is bound;
- does NOT own secrets;
- does NOT replace the upstream ChatGPT Project/context system.

The upstream online harness remains responsible for its own project context. ToolHub only models the real-machine side needed to operate the project.

A Session MAY eventually reference capabilities from more than one Project. The data model must therefore not assume that a Session is cryptographically or structurally owned by exactly one Project, even if the primary UI presents Sessions under a Project tree.

## 5. Module

A Module is a capability provider.

Examples include:

- Local Build;
- Chrome MCP;
- Remote MCP;
- IDA;
- JADX;
- LcEDA;
- future integrations.

A Module owns the semantics of its own downstream system.

ToolHub Core MUST NOT learn Chrome-specific URL semantics, database-specific write semantics, IDA-specific operation semantics, or other module-specific policy details.

Each Module publishes a **Capability Catalog**.

Conceptually:

```text
Module
  -> Capability Catalog
      -> Capability
          -> optional constraint schema
```

Example:

```text
Chrome MCP
  take_snapshot
  navigate_page
    constraints: URL scope
  click
  evaluate_script

Remote MCP / CloudBase
  queryPgDatabase
    constraints: module-defined database/query restrictions

Local Build
  cargo-check
  cargo-build
  cargo-test
```

### Module responsibility

A Module is responsible for:

- declaring capability IDs;
- describing capabilities for the control panel;
- declaring module-defined constraint schemas when needed;
- translating a ToolHub request into its own downstream operation;
- validating module-specific constraints before side effects;
- enforcing its own hard capability boundary;
- executing or delegating execution of an already-authorized request;
- returning normalized results and module errors.

### Module non-responsibility

A Module does not own:

- Session token authentication;
- Session expiry;
- Session revocation;
- Access Profile membership;
- administrator authentication;
- global audit identity;
- cross-module authorization composition.

The principle is:

> Core owns authority composition. Module owns capability semantics.

## 6. Capability

A Capability is the smallest operator-visible unit of authorization that a Module chooses to expose.

Capability IDs must be stable within a Module version.

Examples:

```text
local-build / cargo-check
chrome-mcp  / take_snapshot
remote-mcp  / queryPgDatabase
```

A capability may define no constraints, or a module-defined set of constraints.

ToolHub V2 deliberately does not introduce a global policy DSL in the first architecture.

Instead:

- simple modules may expose exact capabilities only;
- complex modules may expose capability-specific constraint controls;
- the control panel renders the constraint schema supplied by the module;
- the module remains responsible for interpreting and enforcing those constraints.

This keeps complexity local to the module that creates it.

## 7. Access Profile

An Access Profile is a reusable operator-defined authorization template.

It is normally created inside the human view of a Project.

Example:

```text
Profile: normal-dev

Local Build
  [x] cargo-check
  [x] cargo-build
  [x] cargo-test
  [ ] git-push

Chrome
  [x] take_snapshot
  [x] click
  [x] navigate_page
  [ ] evaluate_script

CloudBase
  [x] queryPgDatabase
  [ ] write operation
```

An Access Profile contains selections from Module Capability Catalogs plus any module-defined constraints.

An Access Profile does not contain a bearer credential.

### Profile revisions

Profiles are revisioned.

A Session records the profile revision from which it was created.

Changing a profile to a new revision MUST NOT silently grant newly-added authority to already-active Sessions.

Normal behavior:

```text
normal-dev@12
  -> existing sessions remain on rev 12

normal-dev edited
  -> normal-dev@13
  -> new sessions use rev 13
```

Security emergency changes, module hard-denies, global revocation, or module disablement may take effect immediately regardless of profile revision.

## 8. Session

A Session is a temporary authorization instance intended to be handed to one conversation or one client context.

A Session contains at minimum:

- session ID;
- display name / human label;
- credential verifier;
- creation time;
- expiry time;
- status;
- revocation state;
- last-used time;
- source Access Profile and profile revision;
- optional per-session authorization delta.

The credential is proof of the Session, not the authority definition itself.

A Session token SHOULD be an opaque high-entropy bearer token. Only a verifier/hash is persisted. The plaintext token is shown once at creation and is not recoverable from ToolHub afterward.

### Session states

Minimum states:

```text
ACTIVE
EXPIRED
REVOKED
```

### Session delta

A Session may temporarily differ from its source Access Profile.

The UI must make this visible.

Example:

```text
ChatGPT / database-inspection
ACTIVE · expires 01:12:44
MODIFIED
  - chrome.click
  + cloudbase.explain-query
```

A Session delta is not a hidden copy of the full profile. It represents the deliberate difference from the referenced profile revision.

### No self-escalation

A request using a Session cannot change:

- its own grants;
- its own expiry;
- its source profile;
- another Session;
- secrets;
- administrator state.

A denied request is denied. The execution path does not present an automatic "Allow All" or model-triggered privilege-escalation path.

Authority changes occur only through the Management Plane.

## 9. Authorization composition

The effective authorization for an operation is the intersection of independent boundaries.

Conceptually:

```text
Module hard boundary
        INTERSECT
Access Profile revision
        INTERSECT
Session delta
        =
Session effective access
```

The operator UI may present this simply; the implementation must preserve the invariant.

A Session can attenuate authority. It cannot create authority that the Module does not expose or that a higher boundary hard-denies.

For a concrete request the flow is:

```text
1. Resolve Session.
2. Resolve requested Module capability.
3. Check Core-managed Session/Profile authorization.
4. Check Module-managed capability constraints.
5. Execute only if all checks allow.
6. Audit the decision and result.
```

Authorization MUST complete before side effects.

Unauthorized capabilities should not be advertised to that Session where practical. Discovery/catalog responses should be filtered by effective access rather than revealing a complete hidden tool surface.

## 10. Secret Store

Secret Store is independent infrastructure.

Secrets are not owned by Projects, Access Profiles, or Sessions.

A Session may receive permission to use a capability whose implementation requires a secret. This does not give the Session permission to read that secret.

The intended model is:

```text
authorized capability
  -> module execution
      -> exact secret binding resolved internally
          -> downstream system
```

The LLM/client must not receive raw secret values.

### Namespace

V2 uses the conceptual namespace:

```text
owner / scope / key
```

Examples:

```text
remote-mcp / cloudbase-account / tencent-secret-id
remote-mcp / cloudbase-account / tencent-secret-key
chrome-mcp / edu-pulse-dev / test-account-token
core / tunnel-main / control-plane-api-key
```

Shared secrets require an explicit shared scope. There is no implicit "look in broader scope if missing" fallback.

### Repository configuration

Git-tracked configuration contains only a placeholder:

```yaml
secret_store:
  root: '<自填>'
```

No personal absolute Secret Store path is committed to the repository.

The local operator may later configure a machine-specific path outside the repository.

### V2 Windows direction

The intended Windows V2 storage backend is user-scoped protected storage, with DPAPI CurrentUser as the initial design direction.

This is a local workstation boundary, not a defense against a process that has already fully compromised the same Windows user.

## 11. Management Plane

The Management Plane is for the human operator.

It manages:

- Projects;
- module bindings;
- Access Profiles;
- profile revisions;
- Sessions;
- Session TTL;
- Session revocation;
- Session deltas;
- Secret Store metadata and secret replacement;
- audit inspection.

Authority-expanding mutations require explicit administrator authentication / unlock.

The initial target is local-only management on loopback plus CC integration compatibility.

A future CC-level global authentication layer may provide trusted authentication context to ToolHub, but ToolHub retains capability authorization semantics.

## 12. Execution Plane

The Execution Plane is used by LLM clients and other callers.

Its conceptual path is intentionally small:

```text
request
  -> authenticate Session
  -> determine requested capability
  -> authorize against Profile + Session
  -> validate module-specific constraints
  -> execute
  -> audit
  -> return result
```

Implementation details such as process creation, worker queues, MCP child lifetimes, HTTP connection reuse, CDP sessions, retries, or pooling are below this architecture boundary.

The top-level architecture MUST NOT depend on any particular implementation of those details.

## 13. Audit

Audit is a cross-cutting Core service.

At minimum the system should correlate:

- timestamp;
- Session ID;
- Project context when applicable;
- Module;
- capability;
- allow/deny decision;
- result class;
- duration;
- error class when present.

Secret values, authorization tokens, and unnecessarily sensitive payloads must not be logged.

The audit model should make it possible to answer:

> Which Session used which capability, when, and with what result?

without reconstructing events from unrelated module logs.

## 14. Control Center boundary

Current phase:

```text
CC
  -> hosting / lifecycle / transport integration
  -> ToolHub authentication and authorization
```

Future direction:

```text
CC
  -> global authentication / trusted caller context
  -> ToolHub capability authorization
```

CC should not need to understand Chrome operations, database query semantics, IDA semantics, or other Module-specific capability rules.

## 15. Architecture invariants

The following are V2 top-level invariants:

1. **Automate execution, not authority.**
2. **Project is organizational context, not a security principal.**
3. **A Module defines capability semantics; Core composes authority.**
4. **A Session cannot expand its own authority.**
5. **A denied request does not automatically open an elevation flow.**
6. **Secrets are execution dependencies, never Session-readable data.**
7. **Module hard boundaries override Profile and Session configuration.**
8. **Profile changes do not silently broaden existing Sessions.**
9. **Authorization completes before side effects.**
10. **The active V2 build never consumes `deprecated/**`.**
11. **Implementation complexity stays below the top-level architecture boundary.**
12. **Complexity belongs to the Module that creates it.**

## 16. Deliberate non-goals for the first V2 implementation

V2 does not initially require:

- enterprise tenants;
- organizations or department hierarchy;
- SAML;
- SCIM;
- a general ABAC language;
- OPA/Cedar policy deployment;
- PKI-based workload identity;
- an OAuth authorization server implemented by ToolHub;
- automatic model-driven privilege escalation;
- a general-purpose remote shell;
- a universal Module constraint DSL.

These may be reconsidered only when a real use case requires them.

## 17. Canonical operator view

The intended default control-panel hierarchy is:

```text
Project
  |
  +-- Module Bindings
  |
  +-- Access Profiles
       |
       +-- normal-dev
       |    +-- Session A  ACTIVE
       |    +-- Session B  ACTIVE · MODIFIED
       |
       +-- inspect-only
            +-- Session C  REVOKED
```

Module catalogs and Secret Store remain available as system-level views.

The operator should not need to reason about process topology, worker ownership, transport lifetime, queue topology, or child-process reuse to understand or administer authority.
