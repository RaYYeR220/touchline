export class TxlineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`TxLINE HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "TxlineHttpError";
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new TxlineHttpError(res.status, res.url, text);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function postJson<T = unknown>(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await parse(res)) as T;
}

export async function getJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {},
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const full = qs ? `${url}?${qs}` : url;
  const res = await fetch(full, { method: "GET", headers });
  return (await parse(res)) as T;
}
