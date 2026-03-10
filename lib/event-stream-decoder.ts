// EventStreamDecoder: TransformStream<string, EventChunk>
// Parses Server-Sent Events (SSE) from string chunks (already decoded).

export type EventChunk =
  | {
      type: "event";
      event: string; // default: "message"
      data: string; // data lines joined with "\n"
      id?: string;
      retry?: number;
    }
  | { type: "comment"; comment: string };

export class EventStreamDecoder extends TransformStream<string, EventChunk> {
  constructor(options?: { emitComments?: boolean }) {
    const emitComments = options?.emitComments ?? false;

    let buffer = "";
    let sawFirstChunk = false;

    // current (not-yet-dispatched) event fields
    let eventName: string | undefined;
    let eventId: string | undefined;
    let retry: number | undefined;
    let dataLines: string[] = [];

    const resetEvent = () => {
      eventName = undefined;
      eventId = undefined;
      retry = undefined;
      dataLines = [];
    };

    const dispatch = (
      controller: TransformStreamDefaultController<EventChunk>,
    ) => {
      const hasAny =
        eventName !== undefined ||
        eventId !== undefined ||
        retry !== undefined ||
        dataLines.length > 0;

      if (!hasAny) {
        resetEvent();
        return;
      }

      controller.enqueue({
        type: "event",
        event: eventName ?? "message",
        data: dataLines.join("\n"),
        ...(eventId !== undefined ? { id: eventId } : null),
        ...(retry !== undefined ? { retry } : null),
      });

      resetEvent();
    };

    const processLine = (
      line: string,
      controller: TransformStreamDefaultController<EventChunk>,
    ) => {
      // blank line => dispatch event
      if (line === "") {
        dispatch(controller);
        return;
      }

      // comment line
      if (line.startsWith(":")) {
        if (emitComments)
          controller.enqueue({ type: "comment", comment: line.slice(1) });
        return;
      }

      // field ":" [ " " ] value
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? "" : line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      switch (field) {
        case "event":
          eventName = value;
          break;
        case "data":
          dataLines.push(value);
          break;
        case "id":
          // ignore NUL-containing ids
          if (!value.includes("\u0000")) eventId = value;
          break;
        case "retry": {
          const n = Number.parseInt(value, 10);
          if (Number.isFinite(n)) retry = n;
          break;
        }
        default:
          // ignore unknown fields
          break;
      }
    };

    const consumeBuffer = (
      controller: TransformStreamDefaultController<EventChunk>,
    ) => {
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;

        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line, controller);
      }
    };

    super({
      transform(chunk, controller) {
        // strip UTF‑8 BOM on first chunk if present
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
        }

        buffer += chunk;
        consumeBuffer(controller);
      },
      flush(controller) {
        // process trailing unterminated line (does not auto-dispatch without blank line)
        if (buffer.length > 0) {
          const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
          buffer = "";
          processLine(line, controller);
        }
      },
    });
  }
}
