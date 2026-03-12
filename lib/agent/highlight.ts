import {
  CodeRenderable,
  DiffRenderable,
  SyntaxStyle,
  TextRenderable,
  type BoxRenderable,
} from "@opentui/core";
import {
  bundledLanguages,
  bundledThemes,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from "shiki";

import type { ChatRole, ChatEntry } from "./types.ts";

const DARK_THEME = "github-dark";
const LIGHT_THEME = "github-light";
const DEFAULT_CODE_FG = "#d1fae5";

let highlighterPromise: Promise<Highlighter> | null = null;
let syntaxStylePromise: Promise<SyntaxStyle> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [DARK_THEME, LIGHT_THEME],
      langs: Object.keys(bundledLanguages),
    });
  }

  return highlighterPromise;
}

async function getSyntaxStyle() {
  if (!syntaxStylePromise) {
    syntaxStylePromise = (async () => {
      const themeLoader = bundledThemes[DARK_THEME];
      if (!themeLoader) {
        throw new Error(`Missing bundled Shiki theme: ${DARK_THEME}`);
      }

      const themeModule = await themeLoader();
      const theme = "default" in themeModule ? themeModule.default : themeModule;
      const tokenColors = Array.isArray(theme.tokenColors) ? theme.tokenColors : [];
      const normalizedTheme = tokenColors
        .filter((entry) => typeof entry === "object" && entry !== null)
        .map((entry) => ({
          scope: Array.isArray(entry.scope)
            ? entry.scope.filter((scope): scope is string => typeof scope === "string")
            : typeof entry.scope === "string"
              ? [entry.scope]
              : [],
          style: {
            foreground:
              typeof entry.settings?.foreground === "string" ? entry.settings.foreground : undefined,
            background:
              typeof entry.settings?.background === "string" ? entry.settings.background : undefined,
            bold: entry.settings?.fontStyle === "bold" || entry.settings?.fontStyle === "bold italic",
            italic:
              entry.settings?.fontStyle === "italic" || entry.settings?.fontStyle === "bold italic",
            underline: entry.settings?.fontStyle === "underline",
          },
        }))
        .filter((entry) => entry.scope.length > 0);
      return SyntaxStyle.fromTheme(normalizedTheme);
    })();
  }

  return syntaxStylePromise;
}

function normalizeLanguage(language: string | null | undefined) {
  if (!language) {
    return null;
  }

  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "ts") return "typescript";
  if (normalized === "js") return "javascript";
  if (normalized === "md") return "markdown";
  if (normalized === "sh") return "bash";
  if (normalized === "yml") return "yaml";
  if (normalized === "rb") return "ruby";
  if (normalized === "py") return "python";
  return normalized in bundledLanguages ? (normalized as BundledLanguage) : null;
}

export function inferLanguageFromPath(filePath: string | null | undefined) {
  if (!filePath) {
    return null;
  }

  const extension = filePath.split(".").pop()?.toLowerCase();
  return normalizeLanguage(extension ?? null);
}

function detectFencedCodeBlock(content: string) {
  const match = content.match(/^```([\w.+-]*)\n([\s\S]*?)\n```\s*$/);
  if (!match) {
    return null;
  }

  return {
    language: normalizeLanguage(match[1] || null),
    code: match[2],
  };
}

function looksLikeDiff(content: string) {
  return (
    /^diff --git /m.test(content) ||
    /^@@ /m.test(content) ||
    (/^[+\- ].*/m.test(content) && /^(---|\+\+\+) /m.test(content))
  );
}

function inferRenderableType(content: string, explicitLanguage?: string | null) {
  if (looksLikeDiff(content)) {
    return "diff" as const;
  }

  const fenced = detectFencedCodeBlock(content);
  if (fenced) {
    return "code" as const;
  }

  if (explicitLanguage) {
    return "code" as const;
  }

  return "text" as const;
}

export function isDiffLikeContent(content: string) {
  return looksLikeDiff(content);
}

export async function applySyntaxStyleToDiffRenderable(renderable: DiffRenderable) {
  renderable.syntaxStyle = await getSyntaxStyle();
}

export async function renderEntryBody(options: {
  renderer: ConstructorParameters<typeof TextRenderable>[0];
  container: BoxRenderable;
  entryId: string;
  role: ChatRole;
  content: string;
  previousBody?: ChatEntry["body"];
  explicitLanguage?: string | null;
}): Promise<{ body: ChatEntry["body"]; renderKind: ChatEntry["renderKind"] }> {
  const renderKind = inferRenderableType(options.content, options.explicitLanguage);

  if (options.previousBody) {
    options.container.remove(options.previousBody.id);
  }

  if (renderKind === "diff") {
    const syntaxStyle = await getSyntaxStyle();
    const diffFiletype = normalizeLanguage(options.explicitLanguage) ?? "diff";
    const body = new DiffRenderable(options.renderer, {
      id: `${options.entryId}-diff`,
      diff: options.content,
      filetype: diffFiletype,
      syntaxStyle,
      width: "100%",
      height: "100%",
      fg: DEFAULT_CODE_FG,
      wrapMode: "none",
      showLineNumbers: true,
    });
    options.container.add(body);
    return { body, renderKind };
  }

  if (renderKind === "code") {
    const fenced = detectFencedCodeBlock(options.content);
    const code = fenced?.code ?? options.content;
    const filetype = fenced?.language ?? normalizeLanguage(options.explicitLanguage) ?? "text";
    const syntaxStyle = await getSyntaxStyle();
    const body = new CodeRenderable(options.renderer, {
      id: `${options.entryId}-code`,
      content: code || " ",
      filetype,
      syntaxStyle,
      width: "100%",
      height: "100%",
      fg: DEFAULT_CODE_FG,
      wrapMode: "none",
      drawUnstyledText: true,
    });
    options.container.add(body);
    return { body, renderKind };
  }

  const body = new TextRenderable(options.renderer, {
    id: `${options.entryId}-text`,
    content: options.content || " ",
    fg:
      options.role === "user"
        ? "#dbeafe"
        : options.role === "system"
          ? "#ede9fe"
          : options.role === "error"
            ? "#fecaca"
            : "#d1fae5",
  });
  options.container.add(body);
  return { body, renderKind };
}

export async function highlightReadFileSlice(options: {
  header: string[];
  path: string;
  languageHint?: string | null;
  numberedContent: string;
}) {
  const highlighter = await getHighlighter();
  const language = normalizeLanguage(options.languageHint) ?? inferLanguageFromPath(options.path);

  if (!language) {
    return [...options.header, options.numberedContent].join("\n");
  }

  const lines = options.numberedContent.split("\n");
  const code = lines
    .map((line) => {
      const separatorIndex = line.indexOf("|");
      return separatorIndex >= 0 ? line.slice(separatorIndex + 1) : line;
    })
    .join("\n");

  const tokens = highlighter.codeToTokens(code, {
    lang: language,
    theme: DARK_THEME,
  });

  const highlighted = tokens.tokens
    .map((lineTokens, index) => {
      const original = lines[index] ?? "";
      const separatorIndex = original.indexOf("|");
      const prefix = separatorIndex >= 0 ? original.slice(0, separatorIndex + 1) : "";
      const rendered = lineTokens
        .map((token) => token.content)
        .join("");
      return `${prefix}${rendered}`;
    })
    .join("\n");

  return [...options.header, highlighted].join("\n");
}