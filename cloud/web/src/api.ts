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
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      cache: "no-store",
      signal: path === "/snapshot" ? AbortSignal.timeout(10000) : undefined,
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Autopilot server unavailable. Start autopilot-cloud start or reconnect, then retry. Check the current state before repeating an action; it may already have reached the server.");
  }
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
