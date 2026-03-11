import { expect, test } from "bun:test";

import { EventStreamDecoder } from "../lib/event-stream-decoder.ts";

async function collectDecodedEvents(chunks: string[], emitComments = false) {
  const source = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const stream = source.pipeThrough(new EventStreamDecoder({ emitComments }));

  const events: Array<unknown> = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("EventStreamDecoder parses multiline events across chunk boundaries", async () => {
  const events = await collectDecodedEvents([
    "event: update\n",
    "data: first\n",
    "data: second\n\n",
  ]);

  expect(events).toEqual([
    {
      type: "event",
      event: "update",
      data: "first\nsecond",
    },
  ]);
});

test("EventStreamDecoder strips BOM and can emit comments", async () => {
  const id = "42";
  const retry = 1000;
  const data = "payload";
  const events = await collectDecodedEvents([
    "\ufeff:hello\n",
    `id: ${id}\nretry: ${retry}\ndata: ${data}\n\n`,
  ], true);

  const [, decodedEvent] = events as [unknown, {
    type: "event";
    event: string;
    id?: string;
    retry?: number;
    data: string;
  }];

  expect(events).toEqual([
    { type: "comment", comment: "hello" },
    {
      type: "event",
      event: decodedEvent.event,
      id,
      retry,
      data,
    },
  ]);
});

test("EventStreamDecoder does not auto-dispatch unterminated trailing events", async () => {
  const events = await collectDecodedEvents(["data: pending"]);
  expect(events).toEqual([]);
});
