import { API_URL } from "./config";
import { tokenStore } from "./tokenStore";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let refreshPromise: Promise<string | null> | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function expireSession() {
  await tokenStore.clear();
  unauthorizedHandler?.();
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await tokenStore.getRefreshToken();
  if (!refreshToken) return null;
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  await tokenStore.setAccessToken(body.accessToken);
  return body.accessToken as string;
}

/**
 * Thin fetch wrapper: attaches the access token, and on a single 401 tries a
 * refresh-then-retry before giving up (guards against a race where multiple
 * in-flight requests all see a 401 at once by sharing one refresh call).
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const [accessToken, selectedFacility] = await Promise.all([
    tokenStore.getAccessToken(),
    tokenStore.getSelectedFacility(),
  ]);
  const doFetch = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(selectedFacility ? { "x-facility-id": selectedFacility.id } : {}),
        ...init?.headers,
      },
    });

  let response = await doFetch(accessToken);

  if (response.status === 401) {
    refreshPromise ??= refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    const newToken = await refreshPromise;
    if (newToken) {
      response = await doFetch(newToken);
    }
  }

  if (response.status === 401) {
    await expireSession();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(response.status, body.error ?? "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
