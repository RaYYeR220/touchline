import { describe, it, expect } from "vitest";
import { parseSseStream, tryParseJson } from "../src/stream/sse.js";
import { parseStreamId } from "../src/types/domain.js";

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseSseStream", () => {
  it("parses events delimited by blank lines", async () => {
    const events = await collect(
      parseSseStream(
        fromChunks([
          'id: 1730000000000:0\ndata: {"a":1}\n\n',
          'id: 1730000000000:1\ndata: {"a":2}\n\n',
        ]),
      ),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ id: "1730000000000:0", event: undefined, data: '{"a":1}' });
    expect(tryParseJson<{ a: number }>(events[1]!.data)).toEqual({ a: 2 });
  });

  it("reassembles events split across chunk boundaries", async () => {
    const events = await collect(
      parseSseStream(fromChunks(["id: 5:0\nda", 'ta: {"x":', '"y"}\n', "\n"])),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("5:0");
    expect(tryParseJson(events[0]!.data)).toEqual({ x: "y" });
  });

  it("ignores comments and joins multi-line data", async () => {
    const events = await collect(
      parseSseStream(fromChunks([": keep-alive\ndata: line1\ndata: line2\n\n"])),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("line1\nline2");
  });
});

describe("parseStreamId", () => {
  it("splits timestamp:index", () => {
    expect(parseStreamId("1730000000000:3")).toEqual({
      timestampMs: 1730000000000,
      index: 3,
    });
    expect(parseStreamId(undefined)).toEqual({});
  });
});
