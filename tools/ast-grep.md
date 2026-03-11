# `ast-grep`

## Description

Search code structure inside the workspace by spawning ast-grep. Prefer this when you need syntax-aware matching instead of plain-text search.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "The ast-grep pattern to search for."
    },
    "path": {
      "type": "string",
      "description": "Optional relative file or directory to search within. Defaults to the workspace root."
    },
    "language": {
      "type": "string",
      "description": "Optional ast-grep language, such as ts, tsx, js, or rust."
    },
    "selector": {
      "type": "string",
      "description": "Optional AST kind selector that extracts the sub-part of the pattern to match."
    },
    "strictness": {
      "type": "string",
      "description": "Optional ast-grep strictness, such as cst, smart, ast, relaxed, signature, or template."
    },
    "glob": {
      "type": "string",
      "description": "Optional ast-grep glob, such as *.ts or src/**/*.tsx."
    },
    "max_results": {
      "type": "integer",
      "description": "Optional maximum number of matches to return.",
      "minimum": 1
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```

## Notes

- Search results include file paths and line/column locations.
- Paths must stay within the current workspace.
- This tool uses `sg run --json=stream` so results are syntax-aware and machine-parseable.
