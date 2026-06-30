import type { ArenaContext, Intent } from "../types.js";
import type { AgentConfig } from "../config.js";

/**
 * A pure, stateless strategy that maps an ArenaContext snapshot to a list of
 * Intents. Strategies must not mutate the context or perform I/O.
 *
 * The exec layer passes each returned Intent through risk guards (checkIntent)
 * before sending it on-chain. Strategies may emit Intents that will be
 * blocked by the guards — the guards act as the final safety net.
 */
export interface Strategy {
  name: string;
  onTick(ctx: ArenaContext, cfg: AgentConfig): Intent[];
}
