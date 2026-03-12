import {
  dynamicTool,
  embedMany,
  jsonSchema,
  stepCountIs,
  streamText,
  type ModelMessage,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type Message = ModelMessage & {
  localOnly?: boolean;
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: unknown) => Promise<string>;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ResponseChunk =
  | {
      type: "reasoning";
      reasoning: string;
    }
  | {
      type: "content";
      content: string;
    }
  | {
      type: "tool-call-start";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool-call-delta";
      toolCallId: string;
      toolName: string;
      argumentsDelta: string;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: unknown;
    }
  | {
      type: "finish";
      totalUsage: TokenUsage;
    };

function getStreamText(part: {
  text?: unknown;
  textDelta?: unknown;
  delta?: unknown;
}) {
  if (typeof part.text === "string" && part.text) {
    return part.text;
  }

  if (typeof part.textDelta === "string" && part.textDelta) {
    return part.textDelta;
  }

  if (typeof part.delta === "string" && part.delta) {
    return part.delta;
  }

  return null;
}

function normalizeOpenAIBaseURL(value: string) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

const openAIBase = process.env.OPENAI_API_BASE?.trim() || null;
const openAIKey = process.env.OPENAI_API_KEY?.trim() || null;
const ollamaBase = process.env.OLLAMA_API_BASE;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";
const OPENAI_COMPATIBLE_MODELS_PATH = "/models";
const OLLAMA_TAGS_PATH = "/api/tags";

const llmGateway =
  openAIBase && openAIKey
    ? createOpenAICompatible<string, never, string, never>({
        name: "llm-gateway",
        baseURL: normalizeOpenAIBaseURL(openAIBase),
        apiKey: openAIKey,
        includeUsage: true,
      })
    : null;

const ollamaGateway = createOpenAICompatible<string, never, string, never>({
  name: "ollama",
  baseURL: normalizeOpenAIBaseURL(ollamaBase?.trim() || DEFAULT_OLLAMA_BASE),
  includeUsage: true,
});

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function describeConnectionFailure(error: unknown, action: string) {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

function requireRemoteGateway() {
  if (!llmGateway) {
    throw new Error(
      "Remote model access is unavailable. Set OPENAI_API_BASE and OPENAI_API_KEY, or switch to an ollama:* model for offline/local use."
    );
  }

  return llmGateway;
}

function isOllamaModel(model: string) {
  return model.startsWith("ollama:");
}

function stripModelProviderPrefix(model: string) {
  const separatorIndex = model.indexOf(":");
  return separatorIndex === -1 ? model : model.slice(separatorIndex + 1);
}

function getChatModel(model: string) {
  if (isOllamaModel(model)) {
    return ollamaGateway.chatModel(stripModelProviderPrefix(model));
  }

  return requireRemoteGateway().chatModel(model);
}

export type EmbeddingBackend = "openai-compatible" | "ollama";

export type EmbeddingConfiguration = {
  backend: EmbeddingBackend;
  modelId: string;
};

export function getRemoteEmbeddingModelId() {
  return process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function getOllamaEmbeddingModelId() {
  return process.env.OLLAMA_EMBEDDING_MODEL?.trim() || DEFAULT_OLLAMA_EMBEDDING_MODEL;
}

export function getPreferredEmbeddingConfiguration(): EmbeddingConfiguration {
  if (llmGateway) {
    return {
      backend: "openai-compatible",
      modelId: getRemoteEmbeddingModelId(),
    };
  }

  return {
    backend: "ollama",
    modelId: getOllamaEmbeddingModelId(),
  };
}

type AvailableModel = {
  id: string;
  provider: "llm-gateway" | "ollama";
  label: string;
  description: string;
};

function normalizeApiBaseURL(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchOpenAICompatibleModels(options: {
  baseURL: string;
  headers?: Record<string, string>;
  provider: AvailableModel["provider"];
  prefix?: string;
}) {
  const response = await fetch(
    `${normalizeApiBaseURL(options.baseURL)}${OPENAI_COMPATIBLE_MODELS_PATH}`,
    {
      headers: options.headers,
    }
  );

  if (!response.ok) {
    throw new Error(
      `Model listing failed with ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{
      id?: unknown;
      owned_by?: unknown;
      object?: unknown;
    }>;
  };

  const models = Array.isArray(payload.data) ? payload.data : [];
  return models
    .map((entry) => {
      const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!rawId) {
        return null;
      }

      const id = options.prefix ? `${options.prefix}${rawId}` : rawId;
      const owner = typeof entry.owned_by === "string" ? entry.owned_by : null;
      const object = typeof entry.object === "string" ? entry.object : null;
      return {
        id,
        provider: options.provider,
        label: rawId,
        description: [owner, object].filter(Boolean).join(" • "),
      } satisfies AvailableModel;
    })
    .filter((model): model is AvailableModel => model !== null);
}

async function fetchOllamaModels(baseURL: string) {
  const response = await fetch(
    `${normalizeApiBaseURL(baseURL)}${OLLAMA_TAGS_PATH}`
  );

  if (!response.ok) {
    throw new Error(
      `Ollama model listing failed with ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as {
    models?: Array<{
      name?: unknown;
      model?: unknown;
      details?: {
        family?: unknown;
        parameter_size?: unknown;
        quantization_level?: unknown;
      } | null;
    }>;
  };

  const models = Array.isArray(payload.models) ? payload.models : [];
  return models
    .map((entry) => {
      const rawId =
        typeof entry.model === "string" && entry.model.trim()
          ? entry.model.trim()
          : typeof entry.name === "string" && entry.name.trim()
            ? entry.name.trim()
            : "";
      if (!rawId) {
        return null;
      }

      const details = entry.details ?? null;
      const family = typeof details?.family === "string" ? details.family : null;
      const parameterSize =
        typeof details?.parameter_size === "string" ? details.parameter_size : null;
      const quantization =
        typeof details?.quantization_level === "string"
          ? details.quantization_level
          : null;

      return {
        id: `ollama:${rawId}`,
        provider: "ollama",
        label: rawId,
        description: [family, parameterSize, quantization]
          .filter(Boolean)
          .join(" • "),
      } satisfies AvailableModel;
    })
    .filter((model) => model !== null);
}

export async function listAvailableModels() {
  const tasks: Promise<AvailableModel[]>[] = [];
  const configurationErrors: string[] = [];

  if (openAIBase && openAIKey) {
    tasks.push(
      fetchOpenAICompatibleModels({
        baseURL: openAIBase,
        headers: {
          Authorization: `Bearer ${openAIKey}`,
        },
        provider: "llm-gateway",
      })
    );
  } else {
    configurationErrors.push(
      "Remote models are unavailable because OPENAI_API_BASE and OPENAI_API_KEY are not both configured."
    );
  }

  tasks.push(fetchOllamaModels(ollamaBase?.trim() || DEFAULT_OLLAMA_BASE));

  const results = await Promise.allSettled(tasks);

  const models = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  const errors = [
    ...configurationErrors,
    ...results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : []
    ),
  ];

  const deduped = new Map<string, AvailableModel>();
  for (const model of models) {
    deduped.set(model.id, model);
  }

  return {
    models: [...deduped.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    errors,
  };
}

export async function embedValues(
  values: string[],
  configuration: EmbeddingConfiguration = getPreferredEmbeddingConfiguration()
) {
  if (!values.length) {
    return [] as number[][];
  }

  try {
    const model =
      configuration.backend === "openai-compatible"
        ? requireRemoteGateway().embeddingModel(configuration.modelId)
        : ollamaGateway.embeddingModel(configuration.modelId);
    const { embeddings } = await embedMany({
      model,
      values,
    });

    return embeddings;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    const backendLabel =
      configuration.backend === "openai-compatible"
        ? "OpenAI-compatible"
        : "Ollama";
    throw new Error(
      `${backendLabel} embedding request failed for model ${configuration.modelId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function sanitizeMessages(messages: Message[]): ModelMessage[] {
  return messages.flatMap((message) => {
    if (message.localOnly) {
      return [];
    }

    const { localOnly: _localOnly, ...modelMessage } = message;
    return [modelMessage as ModelMessage];
  });
}

export async function generateTextResponse({
  model,
  messages,
  abortSignal,
}: {
  model: string;
  messages: Message[];
  abortSignal?: AbortSignal;
}) {
  try {
    const result = streamText({
      model: getChatModel(model),
      messages: sanitizeMessages(messages),
      abortSignal,
    });

    return (await result.text).trim();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new Error(describeConnectionFailure(error, `Text generation with model ${model}`));
  }
}

export function streamResponse({
  model,
  messages,
  tools,
  abortSignal,
}: {
  model: string;
  messages: Message[];
  tools?: Tool[];
  abortSignal?: AbortSignal;
}) {
  try {
    const result = streamText({
      model: getChatModel(model),
      messages: sanitizeMessages(messages),
      abortSignal,
      tools: Object.fromEntries(
        (tools ?? []).map((tool) => [
          tool.name,
          dynamicTool({
            description: tool.description,
            inputSchema: jsonSchema(tool.inputSchema as any),
            execute: tool.execute,
          }),
        ])
      ),
      stopWhen: stepCountIs(10),
    });

    return {
      stream: (async function* (): AsyncGenerator<ResponseChunk> {
        const activeToolNames = new Map<string, string>();

        try {
          for await (const part of result.fullStream as AsyncIterable<any>) {
            switch (part.type) {
              case "error":
                throw part.error instanceof Error
                  ? part.error
                  : new Error(String(part.error));
              case "reasoning":
              case "reasoning-delta": {
                const reasoning = getStreamText(part);
                if (reasoning) {
                  yield {
                    type: "reasoning",
                    reasoning,
                  };
                }
                break;
              }
              case "text":
              case "text-delta": {
                const content = getStreamText(part);
                if (content) {
                  yield {
                    type: "content",
                    content,
                  };
                }
                break;
              }
              case "tool-input-start":
                activeToolNames.set(part.id, part.toolName);
                yield {
                  type: "tool-call-start",
                  toolCallId: part.id,
                  toolName: part.toolName,
                };
                break;
              case "tool-input-delta": {
                const argumentsDelta = getStreamText(part);
                if (argumentsDelta) {
                  yield {
                    type: "tool-call-delta",
                    toolCallId: part.id,
                    toolName: activeToolNames.get(part.id) ?? "",
                    argumentsDelta,
                  };
                }
                break;
              }
              case "tool-input-end":
                activeToolNames.delete(part.id);
                break;
              case "tool-call-streaming-start":
              case "tool-call":
                activeToolNames.set(part.toolCallId, part.toolName);
                yield {
                  type: "tool-call-start",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                };
                break;
              case "tool-call-delta": {
                const argumentsDelta = getStreamText(part) ?? part.argsTextDelta;
                if (typeof argumentsDelta === "string" && argumentsDelta) {
                  yield {
                    type: "tool-call-delta",
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    argumentsDelta,
                  };
                }
                break;
              }
              case "tool-result":
                yield {
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  output: part.output,
                };
                break;
              case "finish":
                yield {
                  type: "finish",
                  totalUsage: {
                    inputTokens: part.totalUsage?.inputTokens,
                    outputTokens: part.totalUsage?.outputTokens,
                    totalTokens: part.totalUsage?.totalTokens,
                  },
                };
                break;
            }
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }

          throw new Error(
            describeConnectionFailure(error, `Streaming response with model ${model}`)
          );
        }
      })(),
      responseMessages: Promise.resolve(result.response).then(
        (response: any) => response.messages as Message[]
      ),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new Error(describeConnectionFailure(error, `Streaming setup with model ${model}`));
  }
}
