import { postJson } from "../rest/http.js";

export interface GuestSession {
  /** Bearer JWT (guest claims). Expires after 30 days. */
  token: string;
}

/**
 * Start an anonymous guest session: `POST /auth/guest/start`.
 * The returned JWT is used as the `Authorization: Bearer` token for the
 * activation call and all data endpoints.
 */
export async function startGuestSession(apiBaseUrl: string): Promise<string> {
  const res = await postJson<GuestSession>(`${apiBaseUrl}/auth/guest/start`);
  if (!res?.token) {
    throw new Error("startGuestSession: no token in response");
  }
  return res.token;
}
