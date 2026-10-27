export type RequestErrorFormatter = (status: number) => string;

const defaultRequestError: RequestErrorFormatter = (status) => `Request failed: ${status}`;

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  formatError: RequestErrorFormatter = defaultRequestError
): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? formatError(response.status));
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`接口返回了非 JSON 响应（${response.status}）：${url}`);
  }

  return response.json().catch(() => {
    throw new Error(`接口返回的 JSON 无法解析（${response.status}）：${url}`);
  }) as Promise<T>;
}

export function jsonRequest(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  };
}
