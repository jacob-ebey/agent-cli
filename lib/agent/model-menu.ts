import type { ModelMenuItem } from "./types.ts";

export function resolveModelCommand(options: {
  input: string;
  presets: Record<string, string>;
}) {
  const value = options.input.trim();
  if (!value) {
    return null;
  }

  if (value in options.presets) {
    return options.presets[value];
  }

  return value || null;
}

export function filterModelItems(items: ModelMenuItem[], filter: string) {
  const query = filter.trim().toLowerCase();
  if (!query) {
    return items;
  }

  return items.filter((item) =>
    [item.id, item.label, item.description, item.provider]
      .join("\n")
      .toLowerCase()
      .includes(query)
  );
}

export function normalizeModelSelection(options: {
  filteredItems: ModelMenuItem[];
  modelSelection: number;
}) {
  if (!options.filteredItems.length) {
    return 0;
  }

  if (options.modelSelection >= options.filteredItems.length) {
    return options.filteredItems.length - 1;
  }

  if (options.modelSelection < 0) {
    return 0;
  }

  return options.modelSelection;
}

export function moveModelSelection(options: {
  filteredItems: ModelMenuItem[];
  modelSelection: number;
  delta: number;
}) {
  if (!options.filteredItems.length) {
    return 0;
  }

  return (
    (options.modelSelection + options.delta + options.filteredItems.length) %
    options.filteredItems.length
  );
}

export function selectedModelItem(options: {
  filteredItems: ModelMenuItem[];
  modelSelection: number;
}) {
  if (!options.filteredItems.length) {
    return null;
  }

  return (
    options.filteredItems[
      Math.min(options.modelSelection, options.filteredItems.length - 1)
    ] ?? null
  );
}

export function computeModelViewportTop(options: {
  currentScrollTop: number;
  viewportHeight: number;
  modelSelection: number;
  filteredItems: ModelMenuItem[];
}) {
  if (!options.filteredItems.length) {
    return 0;
  }

  const headerLineCount = 4;
  const selectedTop = headerLineCount + options.modelSelection * 2;
  const selectedBottom = selectedTop + 1;
  const viewportTop = options.currentScrollTop;
  const viewportHeight = Math.max(1, options.viewportHeight);
  const viewportBottom = viewportTop + viewportHeight - 1;

  if (selectedTop < viewportTop) {
    return selectedTop;
  }

  if (selectedBottom > viewportBottom) {
    return Math.max(0, selectedBottom - viewportHeight + 1);
  }

  return viewportTop;
}

export function buildModelMenuContent(options: {
  currentModel: string;
  modelFilter: string;
  filteredItems: ModelMenuItem[];
  allItems: ModelMenuItem[];
  modelSelection: number;
  modelMenuErrors: string[];
  note?: string;
}) {
  const selected = selectedModelItem({
    filteredItems: options.filteredItems,
    modelSelection: options.modelSelection,
  });

  return [
    `Current model: ${options.currentModel}`,
    `Filter: ${options.modelFilter || "(none)"}`,
    `Matches: ${options.filteredItems.length}/${options.allItems.length}`,
    "",
    options.filteredItems.length
      ? options.filteredItems
          .map((item, index) => {
            const prefix = index === options.modelSelection ? ">" : " ";
            const current = item.id === options.currentModel ? " ✓" : "";
            const meta = [item.provider, item.description].filter(Boolean).join(" • ");
            return `${prefix} ${item.id}${current}${meta ? `\n    ${meta}` : ""}`;
          })
          .join("\n")
      : "No models match the current filter.",
    "",
    "Shortcuts",
    "j / k  change selection",
    ".      filter/search",
    "Enter  select model",
    "Esc    close menu",
    "",
    options.modelMenuErrors.length
      ? `Warnings:\n${options.modelMenuErrors.map((error) => `- ${error}`).join("\n")}`
      : null,
    options.note ?? (selected ? `Selected: ${selected.id}` : "Select a model."),
  ].filter((line): line is string => line !== null);
}
