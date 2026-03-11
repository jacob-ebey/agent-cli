# `merge_source_into_worktree`

## Description

Merge a source repo or branch into the active agent worktree so the isolated session can catch up with upstream changes before you continue editing or upmerge files back to the main workspace.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "source_ref": {
      "type": "string",
      "description": "Explicit git ref to merge into the active agent worktree, such as `origin/main`, `main`, or a commit sha."
    },
    "remote": {
      "type": "string",
      "description": "Optional remote name used with `branch` when `source_ref` is omitted."
    },
    "branch": {
      "type": "string",
      "description": "Optional branch name used with `remote` when `source_ref` is omitted."
    }
  },
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

- This only affects the agent-managed git worktree, not the main workspace directly.
- If no arguments are provided, the tool tries to merge `origin/<current-branch>` into the active worktree.
- Use `source_ref` when you already know the exact ref you want.
- If the merge produces git conflicts inside the worktree, the tool returns the conflict summary so you can resolve them before continuing.
