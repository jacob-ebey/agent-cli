import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";

import type { ChatEntry, ChatRole, PersistedTranscriptEntry } from "./types.ts";

function roleTheme(role: ChatRole) {
  switch (role) {
    case "user":
      return {
        title: "You",
        border: "#3b82f6",
        background: "#0f172a",
        foreground: "#dbeafe",
      };
    case "system":
      return {
        title: "System",
        border: "#8b5cf6",
        background: "#1e1b4b",
        foreground: "#ede9fe",
      };
    case "error":
      return {
        title: "Error",
        border: "#ef4444",
        background: "#2b1120",
        foreground: "#fecaca",
      };
    case "assistant":
    default:
      return {
        title: "Agent",
        border: "#10b981",
        background: "#052e2b",
        foreground: "#d1fae5",
      };
  }
}

export function appendTranscriptEntry(options: {
  renderer: ConstructorParameters<typeof BoxRenderable>[0];
  transcript: ScrollBoxRenderable;
  entries: ChatEntry[];
  transcriptHistory: PersistedTranscriptEntry[];
  nextId: (prefix: string) => string;
  role: ChatRole;
  content: string;
  explicitLanguage?: string | null;
  recordInTranscript?: boolean;
  insertBeforeEntryId?: string;
  onEntryAdded?: () => void;
}): ChatEntry {
  const theme = roleTheme(options.role);
  const container = new BoxRenderable(options.renderer, {
    id: options.nextId("message"),
    width: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.background,
    title: theme.title,
    padding: 1,
  });

  const body = new TextRenderable(options.renderer, {
    id: options.nextId("message-body"),
    content: options.content || " ",
    fg: theme.foreground,
  });

  container.add(body);

  const entry: ChatEntry = {
    id: container.id,
    role: options.role,
    container,
    body,
    renderKind: "text",
  };

  if (options.insertBeforeEntryId) {
    const targetIndex = options.entries.findIndex(
      (existingEntry) => existingEntry.id === options.insertBeforeEntryId
    );
    if (targetIndex >= 0) {
      options.transcript.add(container, targetIndex);
      options.entries.splice(targetIndex, 0, entry);
      if (options.recordInTranscript !== false) {
        options.transcriptHistory.splice(targetIndex, 0, {
          role: options.role,
          content: options.content,
        });
      }
      options.onEntryAdded?.();
      return entry;
    }
  }

  options.transcript.add(container);
  options.entries.push(entry);
  if (options.recordInTranscript !== false) {
    options.transcriptHistory.push({ role: options.role, content: options.content });
  }
  options.onEntryAdded?.();
  return entry;
}

export function clearTranscriptEntries(options: {
  transcript: ScrollBoxRenderable;
  entries: ChatEntry[];
}) {
  for (const entry of [...options.entries]) {
    options.transcript.remove(entry.id);
  }
  options.entries.length = 0;
}

export function restoreTranscriptEntries(options: {
  rendererRequestRender: () => void;
  transcript: ScrollBoxRenderable;
  entries: ChatEntry[];
  transcriptHistory: PersistedTranscriptEntry[];
  appendEntry: (role: ChatRole, content: string, recordInTranscript: boolean) => ChatEntry;
  onRestored?: () => void;
}) {
  clearTranscriptEntries({
    transcript: options.transcript,
    entries: options.entries,
  });

  for (const entry of options.transcriptHistory) {
    options.appendEntry(entry.role, entry.content, false);
  }

  options.onRestored?.();
  options.rendererRequestRender();
}
