import { mergeSourceIntoWorktree, type ToolHandler } from "./runtime.ts";

export const execute: ToolHandler = async (argumentsObject) => {
  const sourceRef = argumentsObject.source_ref;
  const remote = argumentsObject.remote;
  const branch = argumentsObject.branch;

  if (sourceRef !== undefined && typeof sourceRef !== "string") {
    throw new Error("source_ref must be a string when provided.");
  }

  if (remote !== undefined && typeof remote !== "string") {
    throw new Error("remote must be a string when provided.");
  }

  if (branch !== undefined && typeof branch !== "string") {
    throw new Error("branch must be a string when provided.");
  }

  return await mergeSourceIntoWorktree({
    sourceRef,
    remote,
    branch,
  });
};
