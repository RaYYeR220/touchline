/**
 * Minimal, dependency-free Server-Sent Events parsing.
 *
 * The TxLINE odds/scores streams are standard SSE: `id` is `timestamp:index`
 * and `data` is a JSON object, events separated by a blank line. The parser
 * buffers across chunk boundaries so it is correct regardless of how the
 * transport splits bytes.
 */

export interface RawSseEvent {
  id?: string;
  event?: string;
  data: string;
}

/** Parse an async iterable of decoded text chunks into SSE events. */
export async function* parseSseStream(
  chunks: AsyncIterable<string>,
): AsyncGenerator<RawSseEvent> {
  let buffer = "";
  let dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  const take = (): RawSseEvent | undefined => {
    if (dataLines.length === 0 && id === undefined && event === undefined) {
      return undefined;
    }
    const ev: RawSseEvent = { id, event, data: dataLines.join("\n") };
    dataLines = [];
    id = undefined;
    event = undefined;
    return ev;
  };

  for await (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        const ev = take();
        if (ev && ev.data !== "") yield ev;
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
      else if (field === "event") event = value;
    }
  }

  const ev = take();
  if (ev && ev.data !== "") yield ev;
}

/** Adapt a fetch `Response` body (web ReadableStream) to text chunks. */
export async function* responseToTextChunks(
  res: Response,
): AsyncGenerator<string> {
  if (!res.body) throw new Error("responseToTextChunks: response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Safe JSON parse of an SSE data payload; returns undefined on failure. */
export function tryParseJson<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}
