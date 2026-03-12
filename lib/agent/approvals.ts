import {
  prepareWorkspaceForEdit,
  relativeOriginalWorkspacePath,
  resolveOriginalWorkspacePath,
} from "../../worktree.ts";
import type {
  ApprovalDecision,
  ApprovalTarget,
  LoadedTool,
  PendingApproval,
} from "./types.ts";
import { readStringArgument } from "./utils.ts";

export function matchesApprovedShellCommandPattern(
  approvedCommand: string,
  requestedCommand: string
) {
  if (approvedCommand.endsWith("*")) {
    return requestedCommand.startsWith(approvedCommand.slice(0, -1));
  }

  return approvedCommand === requestedCommand;
}

function hasApprovedShellCommand(
  approvedCommands: Set<string>,
  requestedCommand: string
) {
  for (const approvedCommand of approvedCommands) {
    if (matchesApprovedShellCommandPattern(approvedCommand, requestedCommand)) {
      return true;
    }
  }

  return false;
}

export async function getApprovalTarget(
  toolName: string,
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>
): Promise<ApprovalTarget | null> {
  if (!tool.metadata.requiresApproval) {
    return null;
  }

  if (toolName === "apply-patch") {
    const session = await prepareWorkspaceForEdit();
    if (session.mode === "worktree") {
      return null;
    }
  }

  if (toolName === "remove-file") {
    const requestedPath = readStringArgument(argumentsObject, "path");
    if (!requestedPath) {
      return null;
    }

    const originalPath = resolveOriginalWorkspacePath(requestedPath);
    return {
      approvalKey: `${toolName}:${originalPath}:${Date.now()}:${Math.random()}`,
      displayLabel: "File deletion",
      displayValue: relativeOriginalWorkspacePath(originalPath),
      approvalPersistence: "session",
    };
  }

  if (toolName === "rename-file") {
    const requestedFromPath = readStringArgument(argumentsObject, "from");
    const requestedToPath = readStringArgument(argumentsObject, "to");
    if (!requestedFromPath || !requestedToPath) {
      return null;
    }

    const originalFromPath = resolveOriginalWorkspacePath(requestedFromPath);
    const originalToPath = resolveOriginalWorkspacePath(requestedToPath);
    return {
      approvalKey: `${toolName}:${originalFromPath}:${originalToPath}:${Date.now()}:${Math.random()}`,
      displayLabel: "File rename",
      displayValue: `${relativeOriginalWorkspacePath(originalFromPath)} → ${relativeOriginalWorkspacePath(originalToPath)}`,
      approvalPersistence: "session",
    };
  }

  if (tool.metadata.approvalScope === "command") {
    const command = readStringArgument(argumentsObject, "command");
    if (!command) {
      return null;
    }

    return {
      approvalKey: command,
      displayLabel: "Command",
      displayValue: command,
      approvalPersistence: tool.metadata.approvalPersistence,
    };
  }

  const requestedPath = readStringArgument(argumentsObject, "path");
  if (!requestedPath) {
    return null;
  }

  const originalPath = resolveOriginalWorkspacePath(requestedPath);
  return {
    approvalKey: originalPath,
    displayLabel: "File",
    displayValue: relativeOriginalWorkspacePath(originalPath),
    approvalPersistence: tool.metadata.approvalPersistence,
  };
}

export async function ensureToolApproval(
  toolName: string,
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>,
  options: {
    approvedEditTargets: Set<string>;
    approvedShellCommands: Set<string>;
    enqueueApproval: (request: PendingApproval) => void;
  }
) {
  const target = await getApprovalTarget(toolName, tool, argumentsObject);
  if (!target) {
    return;
  }

  if (
    target.approvalPersistence === "session" &&
    options.approvedEditTargets.has(target.approvalKey)
  ) {
    return;
  }

  if (
    target.approvalPersistence === "persisted" &&
    hasApprovedShellCommand(options.approvedShellCommands, target.approvalKey)
  ) {
    return;
  }

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    options.enqueueApproval({
      toolName,
      approvalKey: target.approvalKey,
      displayLabel: target.displayLabel,
      displayValue: target.displayValue,
      approvalPersistence: target.approvalPersistence,
      resolve,
    });
  });

  if (decision === "deny") {
    throw new Error(
      `${target.displayLabel} not approved: ${target.displayValue}.`
    );
  }
}

export function currentApprovalPrompt(request: PendingApproval) {
  return request.approvalPersistence === "persisted"
    ? "Press `y` to approve this command once, `a` to always approve this command or a trailing-`*` prefix pattern, or `n` to deny."
    : "Press `y` to approve edits to this file for the rest of the session, or `n` to deny.";
}

export function isApprovalAlreadyGranted(
  request: PendingApproval,
  approvals: {
    approvedEditTargets: Set<string>;
    approvedShellCommands: Set<string>;
  }
) {
  return request.approvalPersistence === "persisted"
    ? hasApprovedShellCommand(approvals.approvedShellCommands, request.approvalKey)
    : approvals.approvedEditTargets.has(request.approvalKey);
}

export function shiftNextPendingApproval(options: {
  activeApproval: PendingApproval | null;
  queuedApprovals: PendingApproval[];
  approvedEditTargets: Set<string>;
  approvedShellCommands: Set<string>;
}): PendingApproval | null {
  if (options.activeApproval) {
    return options.activeApproval;
  }

  while (options.queuedApprovals.length) {
    const next = options.queuedApprovals.shift()!;
    if (
      isApprovalAlreadyGranted(next, {
        approvedEditTargets: options.approvedEditTargets,
        approvedShellCommands: options.approvedShellCommands,
      })
    ) {
      next.resolve(next.approvalPersistence === "persisted" ? "always" : "session");
      continue;
    }

    return next;
  }

  return null;
}

export function clearApprovalQueueState(options: {
  activeApproval: PendingApproval | null;
  queuedApprovals: PendingApproval[];
}) {
  if (options.activeApproval) {
    options.activeApproval.resolve("deny");
  }

  while (options.queuedApprovals.length) {
    options.queuedApprovals.shift()?.resolve("deny");
  }
}

export async function settleApprovalDecision(options: {
  decision: ApprovalDecision;
  request: PendingApproval | null;
  approvedEditTargets: Set<string>;
  approvedShellCommands: Set<string>;
  savePersistedShellApprovals: (approvedCommands: Set<string>) => Promise<void>;
  appendSystemMessage: (content: string) => void;
  appendErrorMessage: (content: string) => void;
  updateSidebar: (note?: string) => void;
  afterQueueAdvanced: () => void;
  updateComposerHint: () => void;
  requestRender: () => void;
}) {
  const request = options.request;
  if (!request) {
    return;
  }

  if (options.decision === "session") {
    options.approvedEditTargets.add(request.approvalKey);
    options.appendSystemMessage(
      `Approved edits to \`${request.displayValue}\` for the rest of this session.`
    );
    options.updateSidebar(`Approved edits to ${request.displayValue}.`);
  } else if (options.decision === "once") {
    options.appendSystemMessage(
      `Approved ${request.displayLabel.toLowerCase()} \`${
        request.displayValue
      }\` once.`
    );
    options.updateSidebar(`Approved ${request.displayLabel.toLowerCase()} once.`);
  } else if (options.decision === "always") {
    options.approvedShellCommands.add(request.approvalKey);
    try {
      await options.savePersistedShellApprovals(options.approvedShellCommands);
      options.appendSystemMessage(
        `Always approved command \`${request.displayValue}\`. Saved to \`.agents/shell.json\`.`
      );
      options.updateSidebar(`Saved approval for command ${request.displayValue}.`);
    } catch (error) {
      options.approvedShellCommands.delete(request.approvalKey);
      const message = error instanceof Error ? error.message : String(error);
      options.appendErrorMessage(
        `Failed to save shell approval for \`${request.displayValue}\`: ${message}`
      );
      options.updateSidebar(`Failed to save approval for ${request.displayValue}.`);
      options.afterQueueAdvanced();
      options.updateComposerHint();
      options.requestRender();
      request.resolve("deny");
      return;
    }
  } else {
    options.appendSystemMessage(
      `Denied ${request.displayLabel.toLowerCase()} \`${
        request.displayValue
      }\`.`
    );
    options.updateSidebar(
      `Denied ${request.displayLabel.toLowerCase()} ${request.displayValue}.`
    );
  }

  options.afterQueueAdvanced();
  options.updateComposerHint();
  options.requestRender();
  request.resolve(options.decision);
}
