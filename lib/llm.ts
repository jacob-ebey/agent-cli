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

const openAIBase = process.env.OPENAI_API_BASE;
const openAIKey = process.env.OPENAI_API_KEY;
const ollamaBase = process.env.OLLAMA_API_BASE;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

if (!openAIBase) {
  throw new Error("Missing OPENAI_API_BASE environment variable.");
}

if (!openAIKey) {
  throw new Error("Missing OPENAI_API_KEY environment variable.");
}

const shopifyGateway = createOpenAICompatible<string, never, string, never>({
  name: "shopify-llm-gateway",
  baseURL: normalizeOpenAIBaseURL(openAIBase),
  apiKey: openAIKey,
  includeUsage: true,
});

const ollamaGateway = createOpenAICompatible<string, never, string, never>({
  name: "ollama",
  baseURL: normalizeOpenAIBaseURL(ollamaBase?.trim() || DEFAULT_OLLAMA_BASE),
  includeUsage: true,
});

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

  return shopifyGateway.chatModel(model);
}

export function getEmbeddingModelId() {
  return process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export async function embedValues(values: string[]) {
  if (!values.length) {
    return [] as number[][];
  }

  const { embeddings } = await embedMany({
    model: shopifyGateway.embeddingModel(getEmbeddingModelId()),
    values,
  });

  return embeddings;
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

      for await (const part of result.fullStream as AsyncIterable<any>) {
        switch (part.type) {
          case "error":
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          case "reasoning":
          case "reasoning-delta":
            {
              const reasoning = getStreamText(part);
              if (reasoning) {
                yield {
                  type: "reasoning",
                  reasoning,
                };
              }
            }
            break;
          case "text":
          case "text-delta":
            {
              const content = getStreamText(part);
              if (content) {
                yield {
                  type: "content",
                  content,
                };
              }
            }
            break;
          case "tool-input-start":
            activeToolNames.set(part.id, part.toolName);
            yield {
              type: "tool-call-start",
              toolCallId: part.id,
              toolName: part.toolName,
            };
            break;
          case "tool-input-delta":
            {
              const argumentsDelta = getStreamText(part);
              if (argumentsDelta) {
                yield {
                  type: "tool-call-delta",
                  toolCallId: part.id,
                  toolName: activeToolNames.get(part.id) ?? "",
                  argumentsDelta,
                };
              }
            }
            break;
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
          case "tool-call-delta":
            {
              const argumentsDelta = getStreamText(part) ?? part.argsTextDelta;
              if (typeof argumentsDelta === "string" && argumentsDelta) {
                yield {
                  type: "tool-call-delta",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  argumentsDelta,
                };
              }
            }
            break;
          case "tool-result":
            yield {
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              output: part.output,
            };
            break;
        }
      }
    })(),
    responseMessages: Promise.resolve(result.response).then((response: any) => response.messages as Message[]),
  };
}
