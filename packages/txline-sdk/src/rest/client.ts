import type { TxlineSession } from "../auth/session.js";
import { getJson, TxlineHttpError } from "./http.js";
import type {
  ApiFixture,
  ApiOddsUpdate,
  ApiScoresUpdate,
} from "../types/api.js";

/**
 * Authenticated REST client for the TxLINE data endpoints. Sends both the
 * `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>` headers and
 * transparently refreshes the JWT once on a 401.
 */
export class TxlineRestClient {
  constructor(private readonly session: TxlineSession) {}

  private get base(): string {
    return this.session.config.apiBaseUrl;
  }

  /** GET an authed endpoint, refreshing the JWT once on 401. */
  async get<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    try {
      return await getJson<T>(`${this.base}${path}`, this.session.authHeaders(), query);
    } catch (err) {
      if (err instanceof TxlineHttpError && err.status === 401) {
        await this.session.refreshJwt();
        return await getJson<T>(`${this.base}${path}`, this.session.authHeaders(), query);
      }
      throw err;
    }
  }

  // --- Fixtures ---------------------------------------------------------
  fixturesSnapshot(competitionId?: number): Promise<ApiFixture[]> {
    return this.get<ApiFixture[]>("/api/fixtures/snapshot", { competitionId });
  }

  // --- Odds -------------------------------------------------------------
  oddsSnapshot(fixtureId: number): Promise<ApiOddsUpdate[]> {
    return this.get<ApiOddsUpdate[]>(`/api/odds/snapshot/${fixtureId}`);
  }

  oddsUpdates(
    epochDay: number,
    hourOfDay: number,
    interval: number,
  ): Promise<ApiOddsUpdate[]> {
    return this.get<ApiOddsUpdate[]>(
      `/api/odds/updates/${epochDay}/${hourOfDay}/${interval}`,
    );
  }

  // --- Scores -----------------------------------------------------------
  scoresSnapshot(fixtureId: number): Promise<ApiScoresUpdate[]> {
    return this.get<ApiScoresUpdate[]>(`/api/scores/snapshot/${fixtureId}`);
  }

  scoresUpdates(fixtureId: number): Promise<ApiScoresUpdate[]> {
    return this.get<ApiScoresUpdate[]>(`/api/scores/updates/${fixtureId}`);
  }

  scoresUpdatesInterval(
    epochDay: number,
    hourOfDay: number,
    interval: number,
  ): Promise<ApiScoresUpdate[]> {
    return this.get<ApiScoresUpdate[]>(
      `/api/scores/updates/${epochDay}/${hourOfDay}/${interval}`,
    );
  }

  scoresHistorical(fixtureId: number): Promise<ApiScoresUpdate[]> {
    return this.get<ApiScoresUpdate[]>(`/api/scores/historical/${fixtureId}`);
  }
}
