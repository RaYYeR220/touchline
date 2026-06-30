import type { TxlineSession } from "@touchline/txline-sdk";
import { streamOdds, streamScores } from "@touchline/txline-sdk";
import type { StreamOptions } from "@touchline/txline-sdk";
import type { MatchState, MarketLine } from "../types.js";
import { reduceScore, lineFromOdds } from "./matchState.js";

export interface PerceiveOptions extends StreamOptions {
  fixtureId?: number;
}

export interface PerceiveEvent {
  state?: MatchState;
  line?: MarketLine;
}

/**
 * Merge the TxLINE scores and odds SSE streams into a single async generator
 * of normalised perception events.
 *
 * This is a thin glue layer — it does not perform model math or risk checks.
 * It is not unit tested (network-dependent); pure sub-functions are tested
 * directly in test/matchState.test.ts.
 *
 * @param session  Authenticated TxlineSession (carries JWT + API token).
 * @param opts     Optional fixtureId filter and AbortSignal.
 */
export async function* perceive(
  session: TxlineSession,
  opts: PerceiveOptions = {},
): AsyncGenerator<PerceiveEvent> {
  const { fixtureId, ...streamOpts } = opts;

  // Wrap each stream in a generator that tags its events, then interleave via
  // a shared queue driven by Promise racing.
  type Tagged =
    | { kind: "score"; val: Awaited<ReturnType<typeof streamScores.prototype.next>> }
    | { kind: "odds";  val: Awaited<ReturnType<typeof streamOdds.prototype.next>> };

  const scores = streamScores(session, streamOpts);
  const odds   = streamOdds(session, streamOpts);

  let scoresDone = false;
  let oddsDone   = false;

  let scoresPending: Promise<IteratorResult<(typeof scores extends AsyncGenerator<infer T> ? T : never)>> | null = null;
  let oddsPending:   Promise<IteratorResult<(typeof odds   extends AsyncGenerator<infer T> ? T : never)>> | null = null;

  let state: MatchState | undefined;
  const nowMs = () => Date.now();

  while (!scoresDone || !oddsDone) {
    if (!scoresDone && scoresPending === null) {
      scoresPending = scores.next();
    }
    if (!oddsDone && oddsPending === null) {
      oddsPending = odds.next();
    }

    const racers: Promise<Tagged>[] = [];
    if (scoresPending !== null) {
      racers.push(scoresPending.then((v) => ({ kind: "score" as const, val: v })));
    }
    if (oddsPending !== null) {
      racers.push(oddsPending.then((v) => ({ kind: "odds"  as const, val: v })));
    }

    if (racers.length === 0) break;

    const winner = await Promise.race(racers);

    if (winner.kind === "score") {
      scoresPending = null;
      if (winner.val.done) {
        scoresDone = true;
      } else {
        const msg = winner.val.value;
        const fid = (msg.data["FixtureId"] ?? msg.data["fixtureId"]) as number | undefined;
        if (fixtureId === undefined || fid === fixtureId) {
          state = reduceScore(state, msg, nowMs());
          yield { state };
        }
      }
    } else {
      oddsPending = null;
      if (winner.val.done) {
        oddsDone = true;
      } else {
        const msg = winner.val.value;
        const fid = (msg.data["FixtureId"] ?? msg.data["fixtureId"]) as number | undefined;
        if (fixtureId === undefined || fid === fixtureId) {
          const line = lineFromOdds(msg, nowMs());
          if (line !== undefined) yield { line };
        }
      }
    }
  }
}
