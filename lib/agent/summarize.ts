import type {
  ConversationMessage,
  PersistedTranscriptEntry,
} from "./types.ts";

export function hasMeaningfulTranscript(
  transcriptHistory: PersistedTranscriptEntry[]
) {
  return transcriptHistory.some(
    (entry) =>
      entry.role === "user" || entry.role === "assistant" || entry.role === "error"
  );
}

export function formatTranscriptEntryForSummary(
  entry: PersistedTranscriptEntry
) {
  const label = entry.summary ? `${entry.role} summary` : entry.role;
  return `${label}:\n${entry.content}`;
}

export function buildConversationSummaryPrompt(
  transcriptHistory: PersistedTranscriptEntry[]
) {
  const transcript = transcriptHistory
    .map((entry) => formatTranscriptEntryForSummary(entry))
    .join("\n\n");

  return [
    "Summarize this chat for future continuation after context compression.",
    "Keep only information that must survive in chat history. Assume anything on disk can be re-read later.",
    "Prioritize:",
    "- current user goal and constraints",
    "- decisions made and why",
    "- unresolved questions or next steps",
    "- important runtime findings not guaranteed to exist on disk",
    "- concise summaries of tool activity and outcomes",
    "- any temporary state the assistant should remember",
    "",
    "Omit or compress aggressively:",
    "- full file contents",
    "- verbose tool logs",
    "- details that can be rediscovered from the repository",
    "- repetitive back-and-forth",
    "",
    "Output plain text using this structure exactly:",
    "Summary:",
    "<short paragraph>",
    "",
    "Relevant context to retain:",
    "- ...",
    "",
    "Open questions / next steps:",
    "- ...",
    "",
    "Transcript:",
    transcript || "(empty)",
  ].join("\n");
}

export function createSummarizedConversationState(options: {
  summary: string;
  createInitialConversationMessages: () => ConversationMessage[];
}) {
  return {
    conversation: options.createInitialConversationMessages(),
    transcript: [
      {
        role: "system",
        content: "Previous conversation context was compressed into the following summary.",
        summary: true,
      },
      {
        role: "assistant",
        content: options.summary,
        summary: true,
      },
    ] satisfies PersistedTranscriptEntry[],
  };
}
