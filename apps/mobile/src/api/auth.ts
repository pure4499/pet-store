import { API_URL } from "./config";
import { ApiError } from "./client";
import { tokenStore } from "./tokenStore";

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? "Request failed");
  return data;
}

export async function login(email: string, password: string) {
  const data = await postJson("/auth/login", { email, password });
  await tokenStore.setTokens(data.accessToken, data.refreshToken);
}

export async function signUpOrganization(input: {
  orgName: string;
  orgSlug: string;
  adminEmail: string;
  adminPassword: string;
  adminFullName: string;
}) {
  const data = await postJson("/organizations", input);
  await tokenStore.setTokens(data.accessToken, data.refreshToken);
}

export async function logout() {
  await tokenStore.clear();
}
