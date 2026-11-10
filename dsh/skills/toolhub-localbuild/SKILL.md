---
name: toolhub-localbuild
description: Use when a coding task should build, check, test, initialize, or inspect a project exposed through MCP-ToolHub Local Build. Prefer the allowlisted ToolHub workflow over arbitrary shell commands, minimize repeated discovery and validation calls, and treat build output as generated state.
---

# ToolHub LocalBuild

Use this skill whenever the current task targets a project exposed by the ToolHub Local Build MCP server.

## Preferred tools

Use the `mcp__toolhub__local_build_*` tools for project build lifecycle work:

- `local_build_list_projects`
- `local_build_list_operations`
- `local_build_list_directory`
- `local_build_run`
- `local_build_get_run`
- `local_build_list_runs`
- `local_build_cancel_run`

Do not use `pwsh` for a build, check, test, lockfile, or other operation when an equivalent Local Build operation exists.

## Discovery

1. If the project is already named by the user and is known from the current session, do not call `list_projects` again.
2. Otherwise call `local_build_list_projects` once.
3. Call `local_build_list_operations` once for the selected project and retain the returned operation names for the task.
4. Never invent an operation name.

If a required operation is absent, stop and report the missing capability instead of falling back to arbitrary shell execution.

## Workspace directory browsing

Use `local_build_list_directory` when the task needs to inspect the directory structure of a configured project, including Git-ignored local asset trees.

- `path` is relative to the configured project root and defaults to `.`.
- Browse one directory at a time; the action is non-recursive.
- Results contain only names, entry type, and file size metadata.
- At most 500 entries are returned; `truncated: true` means the directory is larger.
- The action never returns file contents.
- Absolute paths, path traversal outside the workspace, and symlink/junction escapes outside the real project root are refused.
- Do not fall back to shell `dir`, `ls`, `find`, or PowerShell filesystem enumeration when this action can satisfy the request.
- Directory listing does not consume the Local Build active-run slot and may be used while a build/test run is active.

## Fresh Rust projects

For an empty Rust project directory:

1. If `cargo-init` is available, call it before writing application code.
2. `cargo-init` owns project initialization and lockfile creation.
3. Never hand-write `Cargo.lock`.
4. Never delete or replace an existing `Cargo.toml` merely to make `cargo-init` succeed.
5. If `cargo-init` returns `refused` because `Cargo.toml` already exists, treat the project as already initialized and continue.

After initialization, edit only source/configuration files needed by the task.

## Running operations

When calling `local_build_run`:

1. Record the exact returned `run_id`.
2. Poll that exact id with `local_build_get_run`.
3. Do not guess or reconstruct run ids.
4. Do not start another operation for the same project while a previous run is active.
5. A completed run with nonzero `exit_code` is a build/test failure, not a transport failure.

Inspect retained stdout/stderr before changing code.

## Failure repair

On failure:

1. Identify the first actionable compiler, test, or tool error.
2. Make the smallest source/configuration edit that addresses that error.
3. Re-run only the operation that failed.
4. Do not switch to `pwsh` merely because the operation failed.
5. Do not modify generated build artifacts to repair source errors.

If the failure indicates a missing Local Build capability rather than a source defect, report that capability gap.

## Validation strategy

Use the smallest validation set that proves the requested result.

For Rust:

- Use `cargo-check` first for ordinary compile/type validation.
- Use `cargo-test` when tests exist or the user asks for behavioral verification.
- Use `cargo-build` when an executable/library artifact is required or the user explicitly asks for a build.
- Do not mechanically run check + test + build after every edit if one or two operations already prove the task.

After a successful final validation, stop. Do not repeat successful operations without a reason.

## Generated files

Treat these as generated state:

- `target/`
- compiler caches
- build intermediates

Do not read, edit, summarize, or count files under `target/` unless the user specifically asks about build artifacts.

If project source control is being initialized or maintained, prefer a `.gitignore` entry for `target/`.

## Communication

Keep tool narration short. Do not narrate routine internal decisions before every call.

At completion, report only:

- files intentionally created or changed,
- Local Build operations actually run,
- final exit status,
- any remaining failure or capability gap.
