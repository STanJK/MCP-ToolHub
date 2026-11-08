# Chrome DevTools MCP facade

## Purpose

`chrome-mcp` wraps the upstream `chrome-devtools-mcp` server behind the same
ToolHub capability boundary used by the other local integrations.

The remote caller never receives a raw stdio server definition and cannot choose:

- the Chrome executable;
- the `npx` executable or package arguments;
- the remote-debugging port;
- the Chrome `--user-data-dir`;
- filesystem roots;
- URL allow/block policy;
- the upstream tool allowlist.

The caller selects only a locally configured project and one permitted upstream
tool.

## Architecture

```text
ChatGPT / Codex
      |
      v
MCP-ToolHub
      |
      +-- chrome_mcp_list_projects
      +-- chrome_mcp_status
      +-- chrome_mcp_start
      +-- chrome_mcp_stop
      +-- chrome_mcp_discover
      +-- chrome_mcp_call
              |
              | project = edu-pulse
              v
       project-scoped runtime
              |
              +-- Chrome.exe
              |     --remote-debugging-address=127.0.0.1
              |     --remote-debugging-port=<fixed local port>
              |     --user-data-dir=<module>/project-profiles/<project>
              |
              +-- npx chrome-devtools-mcp@latest
                    --browser-url=http://127.0.0.1:<port>
                    --no-usage-statistics
                    --no-performance-crux
                    --redact-network-headers
```

## Why project mode does not use --autoConnect

`--autoConnect` is useful when an MCP client intentionally attaches to an
already-running personal Chrome session.

That is not the ToolHub project model.

Each ToolHub project instead owns a dedicated Chrome user-data directory and
loopback remote-debugging endpoint. ToolHub starts that Chrome instance itself,
then starts `chrome-devtools-mcp` with `--browser-url`.

The upstream package treats `userDataDir` and `browserUrl` as conflicting
connection modes. Therefore ToolHub applies `--user-data-dir` to Chrome itself,
not to the upstream MCP process.

This also follows Chrome's security model: remote-debugging switches must use a
non-default user data directory on current Chrome releases.

## Persistent project profiles

The storage root is fixed in code:

```text
modules/chrome-mcp/project-profiles/
```

Each project ID maps to exactly one directory:

```text
modules/chrome-mcp/project-profiles/<project-id>/
```

For example:

```text
project-profiles/
  edu-pulse/
  toolhub-dev/
  osint/
```

This lets a project keep its own cookies, local storage and logged-in sessions
across ToolHub and browser restarts.

Profile contents are gitignored and must never be committed.

## Local configuration

Create the gitignored runtime config:

```powershell
Copy-Item .\modules\chrome-mcp\chrome-mcp.example.yaml `
          .\modules\chrome-mcp\chrome-mcp.local.yaml
```

Windows example:

```yaml
version: 1

chrome:
  executable: 'C:\Program Files\Google\Chrome\Application\chrome.exe'

mcp:
  command: 'C:\Program Files\nodejs\npx.cmd'
  args:
    - -y
    - chrome-devtools-mcp@latest
    - --no-usage-statistics
    - --no-performance-crux
    - --redact-network-headers

startup_timeout_ms: 20000

projects:
  edu-pulse:
    enabled: true
    remote_debugging_port: 9223
    javascript_evaluation: true

    workspace_roots: []

    allowed_url_patterns: []
    blocked_url_patterns: []

    allow_tools:
      - list_pages
      - new_page
      - select_page
      - close_page
      - navigate_page
      - wait_for
      - take_snapshot
      - take_screenshot
      - click
      - fill
      - fill_form
      - type_text
      - list_console_messages
      - get_console_message
      - get_css_styles
      - evaluate_script
      - list_network_requests
      - get_network_request
      - performance_start_trace
      - performance_stop_trace
      - performance_analyze_insight

    deny_tools: []
```

Every enabled project must use a unique `remote_debugging_port`.

Project IDs intentionally use the same conservative local capability-name shape:

```text
[a-z0-9][a-z0-9-]*
```

This prevents path traversal when deriving profile directories.

## Filesystem policy

The upstream Chrome DevTools MCP server restricts file operations to configured
filesystem roots (and the OS temporary directory).

ToolHub exposes this only as local static project configuration:

```yaml
workspace_roots:
  - 'C:\STanJK\Development\ExampleProject'
```

Tool calls cannot add or replace roots.

ToolHub also disables upstream automatic config-file discovery so a global
`cd4a.config.json` cannot silently change this project's runtime policy.

## URL policy

A project may set either an allow-list or a block-list:

```yaml
allowed_url_patterns:
  - 'https://example.com/*'
  - 'http://127.0.0.1:*/*'

blocked_url_patterns: []
```

or:

```yaml
allowed_url_patterns: []

blocked_url_patterns:
  - 'https://sensitive.example.com/*'
```

Do not set both. The upstream server itself enforces these URL patterns while it
is attached to targets.

These are browser-agent guardrails, not a replacement for an OS/VM network
sandbox.

## JavaScript evaluation

Per project:

```yaml
javascript_evaluation: false
```

adds upstream `--no-javascript-evaluation`, which removes direct
caller-provided JavaScript evaluation entry points such as `evaluate_script`
and also disables script-like navigation entry points handled by that option.

The default example keeps it enabled because DevTools debugging commonly
requires runtime JavaScript inspection. The ToolHub allowlist remains a separate
gate.

## Hard-denied upstream capabilities

ToolHub hard-denies these categories even if a project uses
`allow_tools: ['*']`:

- Chrome extension management;
- third-party developer-tool execution;
- WebMCP execution;
- PWA install/launch/uninstall and OS app-state tooling;
- virtual WebAuthn configuration.

They can be revisited later as separate explicit capabilities instead of
silently inheriting future upstream defaults.

## Lifecycle

### start

`chrome_mcp_start(project=...)`:

1. checks the configured loopback DevTools endpoint;
2. creates the project profile directory if required;
3. starts Chrome with the fixed project port and user-data directory;
4. waits for `/json/version` to become ready.

The first start opens a fresh Chrome profile. Log into required sites manually.
Those logins persist in that project's profile directory.

### discover / call

The first discovery or call also ensures the project browser is running.

ToolHub then launches one upstream stdio MCP process for that project with:

```text
--browser-url=http://127.0.0.1:<project-port>
```

Upstream tools are discovered dynamically and filtered through the project's
local allow/deny policy.

### stop

`chrome_mcp_stop` closes the upstream MCP connection and sends CDP
`Browser.close` to the project's loopback browser endpoint. The profile
directory is not deleted.

## Upstream process isolation details

The child MCP environment sets:

```text
CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1
CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1
CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
```

The first setting is especially important: ToolHub's local project config remains
the authority for security-sensitive browser-agent policy.

The current MCP TypeScript client transport uses hidden stdio child-process
windows on Windows, so spawning `npx.cmd` should not create a transient console
window.

## Current Windows development baseline

The first implementation targets the tested local environment:

```text
Windows
Node.js 26.13.0
npm / npx 11.20.0
Google Chrome 157.0.8103.38
```

Node 26.13.0 is an LTS release and meets the upstream Node LTS requirement.

## HIL checklist

1. Pull ToolHub main.
2. Copy `chrome-mcp.example.yaml` to `chrome-mcp.local.yaml`.
3. Add one real project with a unique port.
4. Enable `modules.chrome-mcp` in `toolhub.local.yaml`.
5. Start ToolHub.
6. Call `chrome_mcp_list_projects`.
7. Call `chrome_mcp_start` for the project.
8. Verify the opened Chrome uses the expected project profile.
9. Log into a test site manually.
10. Call `chrome_mcp_discover`.
11. Call `list_pages`, `take_snapshot`, then a simple navigation tool.
12. Stop and restart the project browser.
13. Verify the login/session persisted.
14. Verify a non-allowlisted upstream tool is rejected.
15. Verify two project profiles cannot share the same debugging port.

Do not use a real high-value account for the first HIL pass.
