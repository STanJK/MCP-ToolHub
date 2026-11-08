# chrome-mcp project profiles

This directory is the fixed persistent Chrome user-data root owned by ToolHub's
`chrome-mcp` module.

Runtime layout:

```text
project-profiles/
  <project-id>/
    ... Chrome user data ...
```

Each configured project receives exactly one directory derived from its local
project ID. The remote MCP caller cannot choose or override this path.

These directories may contain cookies, authenticated sessions, local storage,
browser history and other sensitive browser state. Runtime profile contents must
never be committed to Git.

The repository keeps only this README; actual profile directories are ignored.
