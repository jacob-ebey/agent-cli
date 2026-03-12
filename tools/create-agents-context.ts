import type { ToolHandler } from "./runtime.ts";

export const execute: ToolHandler = async (argumentsObject) => {
  const markdown = argumentsObject.markdown;
  if (typeof markdown !== "string") {
    throw new Error("markdown must be a string.");
  }

  return JSON.stringify({ markdown }, null, 2);
};
