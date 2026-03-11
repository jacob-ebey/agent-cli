import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
} from "@opentui/core";

import type { Mode } from "./types.ts";

export type DetailPanelKind = "upmerge" | "history" | "model";

export class ComposerTextarea extends TextareaRenderable {
  mode: string = "normal";

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "enter" || key.name === "return") {
      if (this.mode === "insert" && key.shift) {
        return this.newLine();
      }

      return this.submit();
    }

    return super.handleKeyPress(key);
  }
}

export type ComposerModeConfig = {
  title: string;
  borderColor: string;
  placeholder: string;
};

export const COMPOSER_MODE_CONFIG: Record<Mode, ComposerModeConfig> = {
  normal: {
    title: "-- NORMAL --",
    borderColor: "#334155",
    placeholder:
      "Press i to insert, : for commands, !/@ for shell, u for upmerge, or :history",
  },
  insert: {
    title: "-- INSERT -- [history]",
    borderColor: "#3b82f6",
    placeholder:
      "Type a message. Enter sends, Shift+Enter adds a new line, Up/Down browse history",
  },
  command: {
    title: ": [history]",
    borderColor: "#f59e0b",
    placeholder:
      "help  clear(c)  history(h)  model anthropic  index  plan  summarize  quit(q)  (Up/Down history)",
  },
  shell: {
    title: "-- SHELL -- [history]",
    borderColor: "#14b8a6",
    placeholder:
      "Type a shell command. Enter runs it locally. Up/Down browse history",
  },
  agent_shell: {
    title: "-- AGENT SHELL -- [history]",
    borderColor: "#8b5cf6",
    placeholder:
      "Type a shell command. Enter runs it and shares output with the agent. Up/Down history",
  },
};

export function createAgentView(renderer: ConstructorParameters<typeof BoxRenderable>[0]) {
  const app = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0b1020",
    padding: 1,
    gap: 1,
  });

  const main = new BoxRenderable(renderer, {
    id: "main",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  });

  const transcriptPanel = new BoxRenderable(renderer, {
    id: "transcript-panel",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#334155",
    backgroundColor: "#111827",
    title: "Conversation",
    padding: 1,
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    viewportOptions: {
      backgroundColor: "#111827",
    },
    contentOptions: {
      flexDirection: "column",
      gap: 1,
      backgroundColor: "#111827",
    },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: "#64748b",
        backgroundColor: "#1f2937",
      },
    },
  });

  transcriptPanel.add(transcript);

  const sidebar = new BoxRenderable(renderer, {
    id: "sidebar",
    width: 32,
    border: true,
    borderStyle: "rounded",
    borderColor: "#334155",
    backgroundColor: "#0f172a",
    title: "Session",
    padding: 1,
  });

  const sidebarText = new TextRenderable(renderer, {
    id: "sidebar-text",
    content: "",
    fg: "#bfdbfe",
  });

  sidebar.add(sidebarText);

  const upmergePanel = new BoxRenderable(renderer, {
    id: "upmerge-panel",
    width: 72,
    border: true,
    borderStyle: "rounded",
    borderColor: "#22c55e",
    backgroundColor: "#052e2b",
    title: "Upmerge Diff",
    padding: 1,
  });

  const upmergePreview = new ScrollBoxRenderable(renderer, {
    id: "upmerge-preview",
    width: "100%",
    height: "100%",
    stickyScroll: false,
    viewportOptions: {
      backgroundColor: "#052e2b",
    },
    contentOptions: {
      flexDirection: "column",
      backgroundColor: "#052e2b",
    },
  });

  const upmergePreviewText = new TextRenderable(renderer, {
    id: "upmerge-preview-text",
    content: "No pending upmerges.",
    fg: "#dcfce7",
  });

  upmergePreview.add(upmergePreviewText);
  upmergePanel.add(upmergePreview);

  const historyPanel = new BoxRenderable(renderer, {
    id: "history-panel",
    width: 72,
    border: true,
    borderStyle: "rounded",
    borderColor: "#38bdf8",
    backgroundColor: "#082f49",
    title: "Conversation History",
    padding: 1,
  });

  const historyPreview = new ScrollBoxRenderable(renderer, {
    id: "history-preview",
    width: "100%",
    height: "100%",
    stickyScroll: false,
    viewportOptions: {
      backgroundColor: "#082f49",
    },
    contentOptions: {
      flexDirection: "column",
      backgroundColor: "#082f49",
    },
  });

  const historyPreviewText = new TextRenderable(renderer, {
    id: "history-preview-text",
    content: "No saved conversations.",
    fg: "#e0f2fe",
  });

  historyPreview.add(historyPreviewText);
  historyPanel.add(historyPreview);

  const modelPanel = new BoxRenderable(renderer, {
    id: "model-panel",
    width: 72,
    border: true,
    borderStyle: "rounded",
    borderColor: "#f59e0b",
    backgroundColor: "#1c1917",
    title: "Model Picker",
    padding: 1,
  });

  const modelPreview = new ScrollBoxRenderable(renderer, {
    id: "model-preview",
    width: "100%",
    height: "100%",
    stickyScroll: false,
    viewportOptions: {
      backgroundColor: "#1c1917",
    },
    contentOptions: {
      flexDirection: "column",
      backgroundColor: "#1c1917",
    },
  });

  const modelPreviewText = new TextRenderable(renderer, {
    id: "model-preview-text",
    content: "Loading available models...",
    fg: "#fde68a",
  });

  modelPreview.add(modelPreviewText);
  modelPanel.add(modelPreview);

  main.add(transcriptPanel);
  main.add(sidebar);

  const composer = new BoxRenderable(renderer, {
    id: "composer",
    border: true,
    borderStyle: "rounded",
    borderColor: "#334155",
    backgroundColor: "#111827",
    title: "Compose",
    padding: 1,
    flexDirection: "column",
    gap: 1,
  });

  const input = new ComposerTextarea(renderer, {
    id: "composer-input",
    width: "100%",
    height: 4,
    placeholder: "Type a message and press Enter",
    backgroundColor: "#0f172a",
    focusedBackgroundColor: "#172554",
    textColor: "#e5e7eb",
    cursorColor: "#60a5fa",
    placeholderColor: "#64748b",
    wrapMode: "word",
  });

  const composerHint = new TextRenderable(renderer, {
    id: "composer-hint",
    content: "",
    fg: "#94a3b8",
  });

  composer.add(input);
  composer.add(composerHint);

  app.add(main);
  app.add(composer);

  return {
    app,
    main,
    transcriptPanel,
    transcript,
    sidebar,
    sidebarText,
    upmergePanel,
    upmergePreview,
    upmergePreviewText,
    historyPanel,
    historyPreview,
    historyPreviewText,
    modelPanel,
    modelPreview,
    modelPreviewText,
    composer,
    input,
    composerHint,
  };
}

export function attachDetailPanel(options: {
  main: BoxRenderable;
  sidebar: BoxRenderable;
  upmergePanel: BoxRenderable;
  historyPanel: BoxRenderable;
  modelPanel: BoxRenderable;
  detailPanelAttached: DetailPanelKind | null;
  kind: DetailPanelKind;
}) {
  const {
    main,
    sidebar,
    upmergePanel,
    historyPanel,
    modelPanel,
    detailPanelAttached,
    kind,
  } = options;

  if (detailPanelAttached === kind) {
    return detailPanelAttached;
  }

  if (detailPanelAttached === "upmerge") {
    main.remove(upmergePanel.id);
  } else if (detailPanelAttached === "history") {
    main.remove(historyPanel.id);
  } else if (detailPanelAttached === "model") {
    main.remove(modelPanel.id);
  }

  main.remove(sidebar.id);
  main.add(
    kind === "upmerge"
      ? upmergePanel
      : kind === "history"
        ? historyPanel
        : modelPanel
  );
  main.add(sidebar);
  return kind;
}

export function detachDetailPanel(options: {
  main: BoxRenderable;
  upmergePanel: BoxRenderable;
  historyPanel: BoxRenderable;
  modelPanel: BoxRenderable;
  detailPanelAttached: DetailPanelKind | null;
  kind: DetailPanelKind;
}) {
  const { main, upmergePanel, historyPanel, modelPanel, detailPanelAttached, kind } =
    options;

  if (detailPanelAttached !== kind) {
    return detailPanelAttached;
  }

  main.remove(
    kind === "upmerge"
      ? upmergePanel.id
      : kind === "history"
        ? historyPanel.id
        : modelPanel.id
  );
  return null;
}
