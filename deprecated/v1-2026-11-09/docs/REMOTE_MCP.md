# Remote MCP proxy

## Purpose

`remote-mcp` is a fixed-facade Streamable HTTP MCP forwarder. The preferred
configuration model is now two-level:

```text
provider
  -> profile
```

A provider owns shared transport/authentication policy. A profile owns one fixed
remote environment URL and its tool policy.

For CloudBase this maps naturally to:

```text
CloudBase
  -> sleep-record
  -> edu-pulse-dev
```

ToolHub remains the only MCP surface registered in ChatGPT.

## Why profile-level environment routing

Some upstream tools, including CloudBase database tools such as
`queryPgDatabase`, do not accept an `envId` argument. Therefore environment
selection must not be delegated to each tool invocation.

Instead, each profile fixes the environment in its URL:

```text
remote_mcp_call(
  provider = cloudbase,
  profile  = edu-pulse-dev,
  tool     = queryPgDatabase
)
        |
        v
https://tcb-api.cloud.tencent.com/mcp/v1?env_id=edu-pulse-dev-d4gsaerix60a4ea6f
```

This prevents a call intended for one environment from silently falling back to
another environment.

## Provider/profile configuration

```yaml
version: 1

providers:
  cloudbase:
    enabled: true

    # Shared account-level AK/SK. Secrets remain in the ToolHub process
    # environment and are inherited by both profiles.
    headers:
      X-TencentCloud-SecretId:
        env: TOOLHUB_CLOUDBASE_SECRET_ID
      X-TencentCloud-SecretKey:
        env: TOOLHUB_CLOUDBASE_SECRET_KEY

    allow_tools:
      - '*'
    deny_tools: []

    profiles:
      sleep-record:
        enabled: true
        url: 'https://tcb-api.cloud.tencent.com/mcp/v1?env_id=<sleep-record-env-id>'

      edu-pulse-dev:
        enabled: true
        url: 'https://tcb-api.cloud.tencent.com/mcp/v1?env_id=edu-pulse-dev-d4gsaerix60a4ea6f'
```

Provider-level headers are inherited by every profile. Profile-level headers may
add additional headers, but duplicate header names are rejected instead of
silently overriding provider credentials.

`allow_tools` and `deny_tools` may be set at provider level and inherited by
profiles, or overridden per profile.

IDs must match:

```text
[a-z0-9][a-z0-9-]*
```

The remote caller cannot supply a URL, environment ID, credential header, or
unregistered profile.

## Connector-visible facade

ToolHub still exposes only:

```text
remote_mcp_status
remote_mcp_discover
remote_mcp_call
```

Preferred flow:

```text
remote_mcp_discover
  provider = cloudbase
  profile = edu-pulse-dev
  query = queryPgDatabase
  include_schema = true

remote_mcp_call
  provider = cloudbase
  profile = edu-pulse-dev
  tool = queryPgDatabase
  arguments = {...}
```

The tool arguments contain only the upstream tool arguments. Environment routing
is selected by the local profile, not by an `envId` field in `arguments`.

`remote_mcp_status` supports:

- no selector: all providers/profiles;
- `provider` only: every profile under that provider;
- `provider + profile`: one profile.

## Authentication

Headers are local static policy. Secret values should normally be resolved from
the ToolHub process environment:

```yaml
headers:
  X-TencentCloud-SecretId:
    env: TOOLHUB_CLOUDBASE_SECRET_ID
  X-TencentCloud-SecretKey:
    env: TOOLHUB_CLOUDBASE_SECRET_KEY
```

Literal non-secret headers remain supported.

The following transport-managed headers cannot be overridden:

- `Content-Type`
- `Mcp-Session-Id`
- `Mcp-Protocol-Version`

Credentials are resolved only when the selected profile is contacted. Missing
credentials therefore make that profile offline without changing ToolHub's
connector-visible fixed facade.

## Transport policy

HTTPS is required by default. Plain HTTP requires explicit local opt-in:

```yaml
allow_insecure_http: true
```

The Streamable HTTP client keeps redirects same-origin.

## Discovery and forwarding

At runtime:

1. `remote_mcp_status` checks one or more configured provider profiles;
2. `remote_mcp_discover` selects one provider/profile, calls `tools/list`,
   applies allow/deny policy, and returns matching metadata;
3. schemas are omitted unless `include_schema=true`;
4. `remote_mcp_call` revalidates the exact tool name against that selected
   profile's permitted catalog and forwards `tools/call`;
5. a failed call reconnects only that profile, refreshes its catalog,
   revalidates the tool, and retries once.

Each provider/profile has an independent runtime/cache even when two profiles
share the same account credentials.

## Legacy compatibility

Pre-provider configs using a flat `servers:` map are still accepted during
migration. They are represented internally as `legacy/<server-id>`, and the
deprecated `server=` selector remains accepted by the fixed facade.

New configuration should use `providers -> profiles`; do not add new flat
servers.

## Setup

Copy:

```powershell
Copy-Item .\modules\remote-mcp\remote-mcp.example.yaml `
          .\modules\remote-mcp\remote-mcp.local.yaml
```

Enable the module once:

```yaml
modules:
  remote-mcp:
    enabled: true
    config: ./modules/remote-mcp/remote-mcp.local.yaml
```

After changing provider/profile configuration, restart ToolHub because module
configuration is loaded when the module instance is created.
