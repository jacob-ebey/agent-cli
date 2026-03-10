# `run_shell_command`

## Description

Run an arbitrary shell command inside the workspace and return its stdout, stderr, exit code, and timeout status.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "Shell command to execute."
    },
    "cwd": {
      "type": "string",
      "description": "Optional relative or absolute workspace path to run the command from. Defaults to the workspace root."
    },
    "timeout_ms": {
      "type": "integer",
      "description": "Optional timeout in milliseconds before the command is terminated. Defaults to 30000."
    }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

## Metadata

```json
{
  "requiresApproval": true,
  "approvalScope": "command",
  "approvalPersistence": "persisted"
}
```

## Notes

- Every command requires user approval before it runs.
- Users can approve a command once or always.
- Always-approved commands are stored in `.agents/shell.json` using the exact command string.
- `cwd` must stay within the workspace.
- Commands run through the user's shell when available, or a platform fallback shell otherwise.
