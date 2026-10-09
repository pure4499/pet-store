import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const ACCESS_TOKEN_KEY = "accessToken";
const REFRESH_TOKEN_KEY = "refreshToken";
const FACILITY_ID_KEY = "selectedFacilityId";
const FACILITY_NAME_KEY = "selectedFacilityName";
const ACCOUNT_KEY = "signedInAccount";

function accountFromAccessToken(accessToken: string) {
  try {
    const segment = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const encoded = segment.padEnd(segment.length + ((4 - segment.length % 4) % 4), "=");
    const claims = JSON.parse(globalThis.atob(encoded)) as { sub?: string; organizationId?: string };
    return claims.sub && claims.organizationId ? `${claims.organizationId}:${claims.sub}` : null;
  } catch {
    return null;
  }
}

// expo-secure-store has no web implementation at all (it's backed by Keychain/
// EncryptedSharedPreferences, neither of which exist in a browser) — it throws
// immediately on web rather than degrading gracefully. This app only ships to
// iOS/Android app stores, so web is purely a dev-convenience target (`npm run
// start` + press `w`), where plain localStorage is a fine stand-in.
const webStore = {
  async getItemAsync(key: string) {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  },
  async setItemAsync(key: string, value: string) {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  },
  async deleteItemAsync(key: string) {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  },
};

const store = Platform.OS === "web" ? webStore : SecureStore;

export const tokenStore = {
  async getAccessToken() {
    return store.getItemAsync(ACCESS_TOKEN_KEY);
  },
  async getRefreshToken() {
    return store.getItemAsync(REFRESH_TOKEN_KEY);
  },
  async setTokens(accessToken: string, refreshToken: string) {
    const account = accountFromAccessToken(accessToken);
    await Promise.all([
      store.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
      store.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
      ...(account ? [store.setItemAsync(ACCOUNT_KEY, account)] : []),
    ]);
  },
  async setAccessToken(accessToken: string) {
    await store.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  },
  async getSelectedFacility() {
    const [id, name] = await Promise.all([
      store.getItemAsync(FACILITY_ID_KEY),
      store.getItemAsync(FACILITY_NAME_KEY),
    ]);
    return id ? { id, name: name ?? "Facility" } : null;
  },
  async getAccountKey() {
    const stored = await store.getItemAsync(ACCOUNT_KEY);
    if (stored) return stored;
    const accessToken = await store.getItemAsync(ACCESS_TOKEN_KEY);
    const account = accessToken ? accountFromAccessToken(accessToken) : null;
    if (account) await store.setItemAsync(ACCOUNT_KEY, account);
    return account;
  },
  async setSelectedFacility(facility: { id: string; name: string }) {
    await Promise.all([
      store.setItemAsync(FACILITY_ID_KEY, facility.id),
      store.setItemAsync(FACILITY_NAME_KEY, facility.name),
    ]);
  },
  async clearSelectedFacility() {
    await Promise.all([
      store.deleteItemAsync(FACILITY_ID_KEY),
      store.deleteItemAsync(FACILITY_NAME_KEY),
      store.deleteItemAsync(ACCOUNT_KEY),
    ]);
  },
  async clear() {
    await Promise.all([
      store.deleteItemAsync(ACCESS_TOKEN_KEY),
      store.deleteItemAsync(REFRESH_TOKEN_KEY),
      store.deleteItemAsync(FACILITY_ID_KEY),
      store.deleteItemAsync(FACILITY_NAME_KEY),
    ]);
  },
};
