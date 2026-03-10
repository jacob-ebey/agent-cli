import { EventStreamDecoder, type EventChunk } from "./event-stream-decoder.ts";

export type Message =
  | {
      role: "system";
      content: string;
    }
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name: string;
      arguments: string;
    };

export type Tool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

export type ToolCall = {
  index: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type PartialToolCall = {
  index: number;
  function: { arguments: string };
};

export type ResponseChunk = {
  reasoning?: string;
  content?: string;
  toolCall?: ToolCall | PartialToolCall;
};

export async function streamResponse({
  messages,
  tools,
  abortSignal,
}: {
  messages: Message[];
  tools?: Tool[];
  abortSignal?: AbortSignal;
}) {
  const response = await fetch("http://localhost:8080/v1/chat/completions", {
    method: "POST",
    signal: abortSignal,
    body: JSON.stringify({
      stream: true,
      messages,
      tools,
    }),
  });

  if (!response.body) throw new Error("Invalid response");

  return response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventStreamDecoder())
    .pipeThrough(
      new TransformStream<EventChunk, ResponseChunk>({
        transform(chunk, controller) {
          if (
            chunk.type !== "event" ||
            chunk.event !== "message" ||
            !chunk.data ||
            chunk.data === "[DONE]"
          )
            return;

          const data = JSON.parse(chunk.data);
          const { choices } = data;
          const { delta } = choices[0];

          controller.enqueue({
            reasoning: delta.reasoning_content,
            content: delta.content,
            toolCall: delta.tool_calls?.[0],
          });
        },
      }),
    );
}

export class ResponseLogger extends TransformStream<
  ResponseChunk,
  ResponseChunk
> {
  constructor() {
    let mode: "unknown" | "reasoning" | "content" | "tool" = "unknown";
    const seenTools = new Set<string>();

    super({
      transform(chunk, controller) {
        if (chunk.reasoning) {
          if (mode === "unknown") {
            console.log("<think>");
            process.stdout.write("\x1b[90m");
          }
          mode = "reasoning";
          process.stdout.write(chunk.reasoning);
        } else if (chunk.content) {
          if (mode !== "unknown" && mode !== "content")
            process.stdout.write("\x1b[0m");
          if (mode === "reasoning") console.log("\n</think>\n");
          if (mode === "tool") console.log("\n</tool>\n");

          mode = "content";
          process.stdout.write(chunk.content);
        } else if (chunk.toolCall) {
          if ("id" in chunk.toolCall) {
            if (mode === "tool") console.log("\n</tool>");
            console.log(`\n<tool name=${chunk.toolCall.function.name}>`);
          }
          mode = "tool";
          process.stdout.write(chunk.toolCall.function.arguments);
        }

        controller.enqueue(chunk);
      },
      flush() {
        if (mode === "tool") console.log("\n</tool>");
        else console.log();
      },
    });
  }
}
