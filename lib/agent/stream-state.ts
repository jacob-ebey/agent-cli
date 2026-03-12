import type { StreamPhase } from "./types.ts";

export type StreamStateMachineEvent =
  | "start-connection"
  | "connection-established"
  | "receive-reasoning"
  | "receive-content"
  | "await-approval"
  | "approval-resolved"
  | "complete"
  | "reset";

export function reduceStreamPhase(
  currentPhase: StreamPhase,
  event: StreamStateMachineEvent
): StreamPhase {
  switch (event) {
    case "start-connection":
      return "connecting";
    case "connection-established":
      return currentPhase === "responding" ? "responding" : "reasoning";
    case "receive-reasoning":
      return currentPhase === "responding" ? "responding" : "reasoning";
    case "receive-content":
      return "responding";
    case "await-approval":
      return "waiting";
    case "approval-resolved":
      return currentPhase === "responding" ? "responding" : "reasoning";
    case "complete":
    case "reset":
      return "idle";
  }
}

export function applyStreamStateEvent(
  currentPhase: StreamPhase,
  event: StreamStateMachineEvent
): StreamPhase {
  return reduceStreamPhase(currentPhase, event);
}
