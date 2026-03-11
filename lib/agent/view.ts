import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
} from "@opentui/core";

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
