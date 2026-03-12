# `rename-file`

## Description

Rename or move a file or directory within the workspace.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "from": {
      "type": "string",
      "description": "Existing relative or absolute workspace path to rename."
    },
    "to": {
      "type": "string",
      "description": "Destination relative or absolute workspace path after the rename."
    }
  },
  "required": ["from", "to"],
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

- This tool always requires explicit user approval before it runs.
- Both paths must stay within the workspace.
- The source path must already exist.
- The destination path must not already exist.
- Parent directories for the destination are created automatically when needed.
- In git repositories, renames are performed inside the agent worktree when one is available.
