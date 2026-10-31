export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Emoji-Request", "1");
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "تعذّر تنفيذ الطلب");
  return result;
}
export const post = (path: string, body: unknown = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path: string, body: unknown) =>
  api(path, { method: "PUT", body: JSON.stringify(body) });
export const number = (value: unknown) =>
  Number(value ?? 0).toLocaleString("ar-EG");
export const dateTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("ar-EG", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Cairo",
      })
    : "لم تتم بعد";
