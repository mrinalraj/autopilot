let csrf = "";
export function setCSRF(value: string) {
  csrf = value;
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
  key?: string,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(text || "The server did not respond.");
  }
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
