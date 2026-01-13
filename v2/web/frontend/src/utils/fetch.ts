export type FetchResult<T> = {
  ok: boolean;
  status: number;
  data: T;
};

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<FetchResult<T>> {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}
