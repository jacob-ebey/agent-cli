# `run-shell-command`

## Description

Run an arbitrary shell command inside the agent worktree and return its stdout, stderr, exit code, and timeout status.

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
      "description": "Optional relative or absolute worktree path to run the command from. Defaults to the worktree root for the current workspace."
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
- Always-approved commands are stored in `.agents/shell.json`.
- Entries may be exact command strings or trailing-`*` prefix patterns such as `bun test*`.
- Commands always run from the agent-managed worktree when one is available for the current git workspace.
- `cwd` must stay within the current worktree workspace root.
- Commands run through the user's shell when available, or a platform fallback shell otherwise.
