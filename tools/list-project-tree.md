# `list-project-tree`

## Description

List the visible project structure as an ASCII tree. It respects `.gitignore` automatically and also applies the workspace root `.agentsignore` file when present.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Optional relative file or directory to render. Defaults to the workspace root."
    },
    "max_depth": {
      "type": "integer",
      "description": "Optional maximum directory depth to expand in the tree.",
      "minimum": 1
    },
    "max_entries": {
      "type": "integer",
      "description": "Optional maximum number of tree entries to render before truncating.",
      "minimum": 1
    }
  },
  "additionalProperties": false
}
```

## Notes

- Hidden files are included unless they are ignored.
- The tree is rendered from visible files, so empty directories are not shown.
- Paths must stay within the current workspace.
