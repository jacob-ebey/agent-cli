import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Message } from "../llm.ts";
import {
  ACTIVE_CONVERSATION_PATH,
  CONVERSATION_HISTORY_DIRECTORY,
  PREVIOUS_CONVERSATION_PATH,
  SHOULD_RECALL_PREVIOUS_SESSION,
} from "./constants.ts";
import type {
  ChatRole,
  ConversationHistoryItem,
  ConversationMessage,
  PersistedConversationState,
  PersistedTranscriptEntry,
} from "./types.ts";
import { isRecord } from "./utils.ts";
import type { PersistedWorkspaceSession } from "../../worktree.ts";

function createConversationId() {
  return `${Date.now()}-${randomUUID()}`;
}

function normalizeChatRole(value: unknown): ChatRole | null {
  return value === "assistant" ||
    value === "user" ||
    value === "system" ||
    value === "error"
    ? value
    : null;
}

function parsePersistedTranscript(value: unknown): PersistedTranscriptEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const role = normalizeChatRole(entry.role);
    const content =
      typeof entry.content === "string" ? entry.content.trimEnd() : null;
    if (!role || content === null) {
      return [];
    }

    return [{ role, content, summary: entry.summary === true ? true : undefined }];
  });
}

function parsePersistedConversationMessages(
  value: unknown
): ConversationMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.role !== "string" || !("content" in entry)) {
      return [];
    }

    const localOnly =
      entry.localOnly === undefined
        ? undefined
        : entry.localOnly === true
          ? true
          : false;

    return [
      {
        ...(entry as Message),
        localOnly,
      },
    ];
  });
}

export function summarizeConversationTitleFromTranscript(
  transcriptEntries: PersistedTranscriptEntry[]
) {
  const source =
    transcriptEntries.find((entry) => entry.role === "user")?.content ??
    transcriptEntries.find((entry) => entry.role === "assistant")?.content ??
    transcriptEntries[0]?.content ??
    "New conversation";
  const firstLine = source
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "New conversation";
  }

  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}...`;
}

export function createInitialConversationState(
  initialMessages: ConversationMessage[]
): PersistedConversationState {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: createConversationId(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    workspaceSession: null,
    conversation: initialMessages,
    transcript: [],
  };
}

function parsePersistedConversationState(
  value: unknown
): PersistedConversationState | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" && value.id.trim() ? value.id : null;
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : null;
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim()
      ? value.createdAt
      : null;
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? value.updatedAt
      : null;
  const conversationMessages = parsePersistedConversationMessages(
    value.conversation
  );
  const transcriptEntries = parsePersistedTranscript(value.transcript);
  const workspaceSession =
    isRecord(value.workspaceSession) &&
    value.workspaceSession.mode === "worktree" &&
    Array.isArray(value.workspaceSession.trackedFiles) &&
    typeof value.workspaceSession.gitRoot === "string" &&
    typeof value.workspaceSession.sessionRoot === "string" &&
    typeof value.workspaceSession.worktreeRoot === "string" &&
    typeof value.workspaceSession.worktreeWorkspaceRoot === "string" &&
    typeof value.workspaceSession.baselinesRoot === "string"
      ? ({
          version: 1,
          mode: "worktree",
          note:
            typeof value.workspaceSession.note === "string"
              ? value.workspaceSession.note
              : "Agent edits are isolated in a git worktree until you upmerge them.",
          trackedFiles: value.workspaceSession.trackedFiles.flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.relativePath !== "string") {
              return [];
            }

            return [
              {
                relativePath: entry.relativePath,
                baselinePath:
                  typeof entry.baselinePath === "string" ? entry.baselinePath : null,
                exists: entry.exists === true,
              },
            ];
          }),
          conflicts: Array.isArray(value.workspaceSession.conflicts)
            ? value.workspaceSession.conflicts.flatMap((entry) => {
                if (
                  !isRecord(entry) ||
                  typeof entry.relativePath !== "string" ||
                  (entry.type !== "text" && entry.type !== "binary")
                ) {
                  return [];
                }

                return [
                  {
                    relativePath: entry.relativePath,
                    type: entry.type,
                    status: "pending" as const,
                  },
                ];
              })
            : [],
          gitRoot: value.workspaceSession.gitRoot,
          sessionRoot: value.workspaceSession.sessionRoot,
          worktreeRoot: value.workspaceSession.worktreeRoot,
          worktreeWorkspaceRoot: value.workspaceSession.worktreeWorkspaceRoot,
          baselinesRoot: value.workspaceSession.baselinesRoot,
        } satisfies PersistedWorkspaceSession)
      : null;

  if (!id || !title || !createdAt || !updatedAt || !conversationMessages.length) {
    return null;
  }

  return {
    version: 1,
    id,
    title,
    createdAt,
    updatedAt,
    workspaceSession,
    conversation: conversationMessages,
    transcript: transcriptEntries,
  };
}

export async function loadPersistedConversationState(
  filePath: string
): Promise<PersistedConversationState | null> {
  try {
    const source = await fs.readFile(filePath, "utf-8");
    return parsePersistedConversationState(JSON.parse(source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    console.warn(`Failed to load conversation state from ${filePath}:`, error);
    return null;
  }
}

export async function savePersistedConversationState(
  filePath: string,
  state: PersistedConversationState
) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export async function saveConversationStateToHistory(state: PersistedConversationState) {
  await savePersistedConversationState(
    path.join(CONVERSATION_HISTORY_DIRECTORY, `${state.id}.json`),
    state
  );
}

export async function loadConversationHistory() {
  try {
    const files = await fs.readdir(CONVERSATION_HISTORY_DIRECTORY);
    const loaded = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const filePath = path.join(CONVERSATION_HISTORY_DIRECTORY, file);
          const state = await loadPersistedConversationState(filePath);
          if (!state) {
            return null;
          }

          return {
            ...state,
            filePath,
          } satisfies ConversationHistoryItem;
        })
    );

    return loaded
      .filter((entry): entry is ConversationHistoryItem => entry !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [] as ConversationHistoryItem[];
    }

    console.warn(
      `Failed to load conversation history from ${CONVERSATION_HISTORY_DIRECTORY}:`,
      error
    );
    return [] as ConversationHistoryItem[];
  }
}

export function isMeaningfulConversationState(
  state: PersistedConversationState | null
): state is PersistedConversationState {
  if (!state) {
    return false;
  }

  return (
    state.workspaceSession !== null ||
    state.transcript.some(
      (entry) =>
        entry.role === "user" || entry.role === "assistant" || entry.role === "error"
    )
  );
}

export async function resolveInitialConversationState(
  initialMessages: ConversationMessage[]
) {
  const [activeState, previousState] = await Promise.all([
    loadPersistedConversationState(ACTIVE_CONVERSATION_PATH),
    loadPersistedConversationState(PREVIOUS_CONVERSATION_PATH),
  ]);

  if (SHOULD_RECALL_PREVIOUS_SESSION) {
    return activeState && isMeaningfulConversationState(activeState)
      ? activeState
      : previousState && isMeaningfulConversationState(previousState)
        ? previousState
        : activeState ?? previousState ?? createInitialConversationState(initialMessages);
  }

  if (activeState && isMeaningfulConversationState(activeState)) {
    await savePersistedConversationState(PREVIOUS_CONVERSATION_PATH, activeState);
    await saveConversationStateToHistory(activeState);
  }

  return createInitialConversationState(initialMessages);
}
