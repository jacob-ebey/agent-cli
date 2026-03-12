import type {
  ConstraintAccessPolicy,
  SessionConstraintState,
  SessionConstraints,
} from "./types.ts";

export const DEFAULT_SESSION_CONSTRAINTS: SessionConstraints = {
  readOnly: false,
  shellPolicy: "ask",
  networkPolicy: "allow",
  maxFiles: null,
  requireValidation: false,
};

export type ParsedConstraintsCommand =
  | { kind: "show" }
  | { kind: "reset" }
  | { kind: "update"; updates: Partial<SessionConstraints> };

function parseBoolean(value: string) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Expected true or false, received \`${value}\`.`);
}

function parsePolicy(value: string): ConstraintAccessPolicy {
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }

  throw new Error(`Expected allow, ask, or deny, received \`${value}\`.`);
}

function parseMaxFiles(value: string) {
  if (value === "none" || value === "null") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, none, or null, received \`${value}\`.`);
  }

  return parsed;
}

export function createSessionConstraintState(): SessionConstraintState {
  return {
    constraints: { ...DEFAULT_SESSION_CONSTRAINTS },
    editedFiles: new Set<string>(),
    validationFresh: true,
  };
}

export function parseConstraintsCommand(argument: string): ParsedConstraintsCommand {
  const trimmed = argument.trim();
  if (!trimmed) {
    return { kind: "show" };
  }

  if (trimmed === "reset") {
    return { kind: "reset" };
  }

  const updates: Partial<SessionConstraints> = {};
  for (const token of trimmed.split(/\s+/)) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`Expected key=value, received \`${token}\`.`);
    }

    const key = token.slice(0, separatorIndex).trim();
    const value = token.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      throw new Error(`Expected key=value, received \`${token}\`.`);
    }

    switch (key) {
      case "read-only":
      case "readOnly":
        updates.readOnly = parseBoolean(value);
        break;
      case "shell":
      case "shellPolicy":
        updates.shellPolicy = parsePolicy(value);
        break;
      case "network":
      case "networkPolicy":
        updates.networkPolicy = parsePolicy(value);
        break;
      case "max-files":
      case "maxFiles":
        updates.maxFiles = parseMaxFiles(value);
        break;
      case "require-validation":
      case "requireValidation":
        updates.requireValidation = parseBoolean(value);
        break;
      default:
        throw new Error(`Unknown constraint key: \`${key}\`.`);
    }
  }

  return { kind: "update", updates };
}

export function formatConstraintsSummary(constraints: SessionConstraints) {
  return [
    `read-only=${constraints.readOnly}`,
    `shell=${constraints.shellPolicy}`,
    `network=${constraints.networkPolicy}`,
    `max-files=${constraints.maxFiles ?? "none"}`,
    `require-validation=${constraints.requireValidation}`,
  ].join(", ");
}

export function formatConstraintsSidebarSummary(constraints: SessionConstraints) {
  const parts: string[] = [];
  if (constraints.readOnly) {
    parts.push("ro");
  }
  if (constraints.shellPolicy !== DEFAULT_SESSION_CONSTRAINTS.shellPolicy) {
    parts.push(`shell:${constraints.shellPolicy}`);
  }
  if (constraints.networkPolicy !== DEFAULT_SESSION_CONSTRAINTS.networkPolicy) {
    parts.push(`net:${constraints.networkPolicy}`);
  }
  if (constraints.maxFiles !== null) {
    parts.push(`files:${constraints.maxFiles}`);
  }
  if (constraints.requireValidation) {
    parts.push("validate");
  }

  return parts.length ? parts.join(", ") : null;
}

export function applyConstraintUpdates(
  current: SessionConstraints,
  updates: Partial<SessionConstraints>
): SessionConstraints {
  return {
    ...current,
    ...updates,
  };
}

export function isNetworkTool(toolName: string) {
  return toolName === "web-fetch" || toolName === "web-search";
}

export function isValidationCommand(command: string) {
  const trimmed = command.trim();
  return trimmed === "bun typecheck" || trimmed === "bun test";
}

export function checkToolConstraints(options: {
  toolName: string;
  targetPath: string | null;
  state: SessionConstraintState;
}) {
  const { toolName, targetPath, state } = options;
  const { constraints, editedFiles } = state;

  if (toolName === "apply-patch") {
    if (constraints.readOnly) {
      return "Blocked by session constraints: read-only mode prevents file edits.";
    }

    if (
      targetPath &&
      constraints.maxFiles !== null &&
      !editedFiles.has(targetPath) &&
      editedFiles.size >= constraints.maxFiles
    ) {
      return `Blocked by session constraints: max-files=${constraints.maxFiles} prevents editing additional files.`;
    }
  }

  if (toolName === "run-shell-command" && constraints.shellPolicy === "deny") {
    return "Blocked by session constraints: shell=deny prevents shell commands.";
  }

  if (isNetworkTool(toolName) && constraints.networkPolicy === "deny") {
    return `Blocked by session constraints: network=deny prevents ${toolName}.`;
  }

  return null;
}

export function checkManualShellConstraints(state: SessionConstraintState) {
  return state.constraints.shellPolicy === "deny"
    ? "Blocked by session constraints: shell=deny prevents shell commands."
    : null;
}

export function recordSuccessfulEdit(targetPath: string, state: SessionConstraintState) {
  state.editedFiles.add(targetPath);
  state.validationFresh = false;
}

export function recordSuccessfulShellCommand(command: string, state: SessionConstraintState) {
  if (isValidationCommand(command)) {
    state.validationFresh = true;
  }
}
