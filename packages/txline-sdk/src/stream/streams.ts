import type { TxlineSession } from "../auth/session.js";
import type { ApiOddsUpdate, ApiScoresUpdate } from "../types/api.js";
import {
  parseStreamId,
  type OddsMessage,
  type ScoresMessage,
  type StreamMessage,
} from "../types/domain.js";
import { parseSseStream, responseToTextChunks, tryParseJson } from "./sse.js";

export interface StreamOptions {
  /** Abort the stream. */
  signal?: AbortSignal;
  /** Reconnect after the stream ends or errors. Default true. */
  reconnect?: boolean;
  /** Delay (ms) before reconnecting. Default 1000. */
  reconnectDelayMs?: number;
}

async function openSse(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      ...headers,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    signal,
  });
  if (!res.ok) throw new Error(`stream failed: HTTP ${res.status}`);
  return res;
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

/**
 * Generic typed SSE consumer. Yields one normalized {@link StreamMessage} per
 * data event. Refreshes the JWT once if the initial connect 401s, and (by
 * default) reconnects after the stream drops.
 */
async function* streamEndpoint<T>(
  session: TxlineSession,
  path: string,
  opts: StreamOptions,
): AsyncGenerator<StreamMessage<T>> {
  const { signal, reconnect = true, reconnectDelayMs = 1000 } = opts;
  const url = `${session.config.apiBaseUrl}${path}`;

  for (;;) {
    let res: Response;
    try {
      res = await openSse(url, session.authHeaders(), signal);
    } catch (err) {
      // One JWT refresh attempt, then honor reconnect policy.
      await session.refreshJwt();
      res = await openSse(url, session.authHeaders(), signal);
    }

    for await (const ev of parseSseStream(responseToTextChunks(res))) {
      const data = tryParseJson<T>(ev.data);
      if (data === undefined) continue;
      const { timestampMs, index } = parseStreamId(ev.id);
      yield { id: ev.id, timestampMs, index, data };
    }

    if (!reconnect || signal?.aborted) return;
    await delay(reconnectDelayMs, signal);
  }
}

export function streamOdds(
  session: TxlineSession,
  opts: StreamOptions = {},
): AsyncGenerator<OddsMessage> {
  return streamEndpoint<ApiOddsUpdate>(session, "/api/odds/stream", opts);
}

export function streamScores(
  session: TxlineSession,
  opts: StreamOptions = {},
): AsyncGenerator<ScoresMessage> {
  return streamEndpoint<ApiScoresUpdate>(session, "/api/scores/stream", opts);
}
