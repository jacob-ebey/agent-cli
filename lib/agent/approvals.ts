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
    options.approvedShellCommands.has(target.approvalKey)
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
