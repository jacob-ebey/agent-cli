# `apply-patch`

## Description

Apply a targeted exact-text edit to a single file in the workspace. In git repos, edits are written to an agent-managed worktree first so they can be reviewed and upmerged later.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Relative or absolute workspace path to the file to update."
    },
    "old_string": {
      "type": ["string", "null"],
      "description": "Exact existing text to replace. Must be unique unless replace_all is true. May be empty, null, or omitted when creating a new file or when writing full contents to an existing empty file."
    },
    "new_string": {
      "type": "string",
      "description": "Replacement text to write in place of old_string, or the full contents of a newly created file."
    },
    "replace_all": {
      "type": "boolean",
      "description": "When true, replace every exact match of old_string in the file."
    },
    "create_if_missing": {
      "type": "boolean",
      "description": "When true, create the file if it does not already exist. Requires old_string to be empty."
    }
  },
  "required": ["path", "new_string"],
  "additionalProperties": false
}
```

## Metadata

```json
{
  "requiresApproval": true
}
```

## Notes

This tool edits one file at a time; it does not parse unified diffs or rename/delete files.

Behavior:

- Paths may be relative or absolute, but they must resolve inside the workspace.
- In git repositories, edits are applied inside a session worktree that mirrors the current workspace state. The tool returns a diff and the UI can upmerge selected files back into the main workspace.
- When edits are isolated in that session worktree, they do not require a separate approval prompt. If worktrees are unavailable and edits apply directly, approval is still required.
- For existing non-empty files, `old_string` must match the current file contents exactly.
- For existing empty files, `old_string` may be `""`, `null`, or omitted; in that case `new_string` becomes the full file contents.
- By default, `old_string` must match exactly once. If it matches multiple times, the tool errors and asks for a more specific snippet.
- Set `replace_all` to `true` only when every exact match should be replaced.
- To create a new file, set `create_if_missing` to `true`, use an empty/null/omitted `old_string`, and put the full file contents in `new_string`.

Update example:

```json
{
  "path": "tools/apply-patch.md",
  "old_string": "Apply a structured multi-file patch.",
  "new_string": "Apply a targeted exact-text edit to a single file."
}
```

Create-file example:

```json
{
  "path": "hello.txt",
  "old_string": "",
  "new_string": "Hello, world!\n",
  "create_if_missing": true
}
```
