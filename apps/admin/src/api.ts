import type {
  DashboardData,
  ReviewFilter,
  ReviewPhoto,
  PetOption,
  SessionOption,
  SessionWorkspaceData,
  IdentityMediaStatus,
  OrganizationUser,
  RoleOption,
  UserProfile,
  CustomerDetail,
  CustomerDirectoryResponse,
  CatalogItem,
  ChargeSheet,
  CommerceOverview,
  CollarPaletteItem,
  FacilityOption,
} from "./types";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:3000").replace(/\/$/, "");
const ACCESS_KEY = "ucbarkley-admin-access";
const REFRESH_KEY = "ucbarkley-admin-refresh";

class ApiClient {
  get hasSession() {
    return Boolean(localStorage.getItem(ACCESS_KEY));
  }

  get currentRole() {
    const token = localStorage.getItem(ACCESS_KEY);
    if (!token) return null;
    try { return parseJwt(token).role; } catch { return null; }
  }

  get currentUserId() {
    const token = localStorage.getItem(ACCESS_KEY);
    if (!token) return null;
    try { return parseJwt(token).sub; } catch { return null; }
  }

  async login(email: string, password: string) {
    const response = await this.request<{ accessToken: string; refreshToken: string }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
      false
    );
    const claims = parseJwt(response.accessToken);
    if (claims.role !== "owner_admin" && claims.role !== "manager") {
      throw new Error("This account does not have manager access.");
    }
    localStorage.setItem(ACCESS_KEY, response.accessToken);
    localStorage.setItem(REFRESH_KEY, response.refreshToken);
    return claims;
  }

  logout() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }

  refreshSession() {
    return this.refresh();
  }

  dashboard() {
    return this.request<DashboardData>("/admin/dashboard");
  }

  sessions() {
    return this.request<SessionOption[]>("/sessions");
  }

  catalogItems(includeInactive = false) {
    return this.request<CatalogItem[]>(`/commerce/catalog-items${includeInactive ? "?includeInactive=true" : ""}`);
  }

  createCatalogItem(data: { itemType: "service" | "product"; name: string; description?: string; sku?: string; unitPriceCents: number; taxable?: boolean; trackInventory?: boolean }) {
    return this.request<CatalogItem>("/commerce/catalog-items", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  updateCatalogItem(itemId: string, data: { itemType: "service" | "product"; name: string; description?: string; sku?: string; unitPriceCents: number; taxable: boolean; trackInventory: boolean; isActive: boolean }) {
    return this.request<CatalogItem>(`/commerce/catalog-items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  commerceOverview() {
    return this.request<CommerceOverview>("/commerce/overview");
  }

  chargeSheet(sessionId: string) {
    return this.request<ChargeSheet>(`/sessions/${sessionId}/charge-sheet`);
  }

  addChargeItem(sessionId: string, data: { catalogItemId?: string; itemType?: "service" | "product"; name?: string; unitPriceCents?: number; quantity: number; notes?: string }) {
    return this.request<ChargeSheet>(`/sessions/${sessionId}/charge-sheet/items`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  updateChargeItem(sessionId: string, itemId: string, data: { quantity: number; notes?: string | null }) {
    return this.request<ChargeSheet>(`/sessions/${sessionId}/charge-sheet/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  deleteChargeItem(sessionId: string, itemId: string) {
    return this.request<ChargeSheet>(`/sessions/${sessionId}/charge-sheet/items/${itemId}`, { method: "DELETE" });
  }

  pets(search = "") {
    const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
    return this.request<PetOption[]>(`/pets${query}`);
  }

  customers(search = "", page = 1, pageSize = 25) {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) query.set("search", search.trim());
    return this.request<CustomerDirectoryResponse>(`/admin/customers?${query.toString()}`);
  }

  customer(customerId: string) {
    return this.request<CustomerDetail>(`/admin/customers/${customerId}`);
  }

  updateCustomer(customerId: string, data: {
    fullName: string;
    phone: string | null;
    email: string | null;
    notes: string | null;
    householdStatus: "active" | "inactive";
    address: {
      line1: string;
      line2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
      countryCode: string | null;
    } | null;
  }) {
    return this.request<CustomerDetail>(`/admin/customers/${customerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  updateCustomerPet(customerId: string, petId: string, data: {
    name: string;
    species: "dog" | "cat" | "other";
    breed: string | null;
    status: "active" | "inactive" | "deceased" | "transferred";
    dateOfBirth: string | null;
    sex: "male" | "female" | "unknown" | null;
    reproductiveStatus: "intact" | "spayed" | "neutered" | "unknown" | null;
    isMixedBreed: boolean | null;
    sizeClass: "toy" | "small" | "medium" | "large" | "giant" | "unknown" | null;
    weightKg: number | null;
    colorMarkings: string | null;
    temperament: string | null;
  }) {
    return this.request<CustomerDetail>(`/admin/customers/${customerId}/pets/${petId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  createPet(data: {
    name: string;
    species: "dog" | "cat" | "other";
    breed?: string;
    ownerId?: string;
    owner?: { fullName: string; phone?: string; email?: string };
  }) {
    return this.request<PetOption>("/pets", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  assignPetOwner(petId: string, owner: { fullName: string; phone?: string; email?: string }) {
    return this.request<PetOption>(`/pets/${petId}/owner`, {
      method: "PATCH",
      body: JSON.stringify({ owner }),
    });
  }

  users() {
    return this.request<OrganizationUser[]>("/organizations/me/users");
  }

  facilities() {
    return this.request<FacilityOption[]>("/organizations/me/facilities");
  }

  createFacility(name: string) {
    return this.request<FacilityOption>("/organizations/me/facilities", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  roles() {
    return this.request<RoleOption[]>("/organizations/me/roles");
  }

  profile() {
    return this.request<UserProfile>("/users/me");
  }

  collarPalette() {
    return this.request<CollarPaletteItem[]>("/organizations/me/collar-palette");
  }

  createCollarColor(data: { colorName: string; colorHex: string }) {
    return this.request<CollarPaletteItem>("/organizations/me/collar-palette", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  changeMyPassword(currentPassword: string, newPassword: string) {
    return this.request<{ updated: true }>("/users/me/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  resetUserPassword(userId: string, newPassword: string) {
    return this.request<{ updated: true }>(`/organizations/me/users/${userId}/password`, {
      method: "PUT",
      body: JSON.stringify({ newPassword }),
    });
  }

  createUser(data: {
    email: string;
    password: string;
    fullName: string;
    roleId: string;
    facilityIds: string[];
  }) {
    return this.request<OrganizationUser>("/organizations/me/users", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  updateUser(userId: string, data: { fullName?: string; email?: string; status?: "active" | "disabled" }) {
    return this.request(`/organizations/me/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  assignUserRole(userId: string, roleId: string) {
    return this.request(`/organizations/me/users/${userId}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId }),
    });
  }

  assignUserFacilities(userId: string, facilityIds: string[]) {
    return this.request(`/organizations/me/users/${userId}/facilities`, {
      method: "PUT",
      body: JSON.stringify({ facilityIds }),
    });
  }

  checkIn(data: {
    petId: string;
    sessionType: "boarding" | "daycare";
    checkInAt?: string;
    expectedCheckOutAt?: string;
    notes?: string;
  }) {
    return this.request<SessionOption>("/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  checkInBatch(data: {
    petIds: string[];
    sessionType: "boarding" | "daycare";
    checkInAt?: string;
    expectedCheckOutAt?: string;
    notes?: string;
  }) {
    return this.request<SessionOption[]>("/sessions/batch", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  createReservations(data: {
    petIds: string[];
    sessionType: "boarding" | "daycare";
    scheduledCheckInAt: string;
    expectedCheckOutAt: string;
    notes?: string;
  }) {
    return this.request<SessionOption[]>("/sessions/reservations", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  startReservation(sessionId: string, data: { checkInAt?: string; expectedCheckOutAt?: string } = {}) {
    return this.request<SessionOption>(`/sessions/${sessionId}/check-in`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  cancelReservation(sessionId: string) {
    return this.request<SessionOption>(`/sessions/${sessionId}/cancel`, { method: "POST" });
  }

  checkOut(sessionId: string) {
    return this.request<SessionOption>(`/sessions/${sessionId}/check-out`, { method: "POST" });
  }

  createCareLog(sessionId: string, data: {
    entryType: "note" | "feeding" | "medication" | "activity" | "incident" | "other";
    entryAt?: string;
    title?: string;
    body?: string;
    structuredData?: Record<string, unknown>;
  }) {
    return this.request(`/sessions/${sessionId}/logs`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  photos(filter: ReviewFilter, batchId?: string) {
    const query = new URLSearchParams({ filter });
    if (batchId) query.set("batchId", batchId);
    return this.request<{ filter: ReviewFilter; photos: ReviewPhoto[] }>(
      `/admin/photos?${query.toString()}`
    );
  }

  async uploadPhotoBatch(
    files: File[],
    onProgress: (completed: number) => void,
    reportAssignment?: { petId: string; sessionId: string },
  ) {
    const batch = await this.request<{ id: string }>("/photo-batches", { method: "POST" });
    const targets = await this.request<Array<{ photoId: string; uploadUrl: string }>>(
      "/photos/upload-urls",
      {
        method: "POST",
        body: JSON.stringify({
          batchId: batch.id,
          deferProcessing: true,
          files: files.map((file) => ({
            fileName: file.name,
            contentType: file.type || "image/jpeg",
            fileSizeBytes: file.size,
          })),
          reportAssignment,
        }),
      }
    );

    let cursor = 0;
    let completed = 0;
    const failures: string[] = [];
    const uploadWorker = async () => {
      while (cursor < files.length) {
        const index = cursor++;
        const file = files[index];
        const target = targets[index];
        try {
          const response = await fetch(target.uploadUrl, {
            method: "PUT",
            headers: { "content-type": file.type || "image/jpeg" },
            body: file,
          });
          if (!response.ok) throw new Error(`Storage upload failed (${response.status})`);
          await this.request(`/photos/${target.photoId}/confirm-upload`, {
            method: "POST",
            body: JSON.stringify({ fileSizeBytes: file.size }),
          });
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "upload failed"}`);
        } finally {
          completed += 1;
          onProgress(completed);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, files.length) }, uploadWorker));
    if (failures.length) throw new Error(failures.join("\n"));
    return batch.id;
  }

  async uploadReportPhotosForPet(
    files: File[],
    petId: string,
    sessionId: string,
    onProgress: (completed: number) => void,
  ) {
    const batchId = await this.uploadPhotoBatch(files, onProgress, { petId, sessionId });
    return { batchId, photoCount: files.length };
  }

  photoBatch(batchId: string) {
    return this.request<{
      id: string;
      statusCounts: Array<{ processing_status: string; count: string }>;
    }>(`/photo-batches/${batchId}`);
  }

  identityMedia(sessionId: string) {
    return this.request<IdentityMediaStatus>(`/sessions/${sessionId}/identity-media`);
  }

  removeIdentityPhoto(photoId: string) {
    return this.request<{ id: string; deactivatedEmbeddingCount: number }>(`/identity-reference-photos/${photoId}`, {
      method: "DELETE",
    });
  }

  promoteIdentityPhoto(photoId: string) {
    return this.request<{ photo_id: string; photo_link_id: string; review_state: string }>(`/identity-reference-photos/${photoId}/promote-to-report`, {
      method: "POST",
    });
  }

  async uploadIdentityPhotos(files: File[], petId: string, sessionId: string) {
    const batch = await this.request<{ id: string }>("/photo-batches", { method: "POST" });
    const targets = await this.request<Array<{ photoId: string; uploadUrl: string }>>(
      "/photos/upload-urls",
      {
        method: "POST",
        body: JSON.stringify({
          batchId: batch.id,
          deferProcessing: true,
          identityReference: { petId, sessionId },
          files: files.map((file) => ({
            fileName: file.name,
            contentType: file.type || "image/jpeg",
            fileSizeBytes: file.size,
          })),
        }),
      }
    );
    await Promise.all(targets.map(async (target, index) => {
      const file = files[index];
      const response = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type || "image/jpeg" },
        body: file,
      });
      if (!response.ok) throw new Error(`${file.name} upload failed (${response.status})`);
      await this.request(`/photos/${target.photoId}/confirm-upload`, {
        method: "POST",
        body: JSON.stringify({ fileSizeBytes: file.size }),
      });
    }));
  }

  async uploadIdentityVideo(file: File, petId: string, sessionId: string, durationSeconds?: number) {
    const contentType = file.type === "video/quicktime" || file.name.toLowerCase().endsWith(".mov")
      ? "video/quicktime"
      : "video/mp4";
    const target = await this.request<{ videoId: string; uploadUrl: string }>("/videos/upload-url", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        contentType,
        fileSizeBytes: file.size,
        durationSeconds,
        identityReference: { petId, sessionId },
      }),
    });
    const response = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: file,
    });
    if (!response.ok) throw new Error(`Video upload failed (${response.status})`);
    await this.request(`/videos/${target.videoId}/confirm-upload`, {
      method: "POST",
      body: JSON.stringify({ fileSizeBytes: file.size }),
    });
  }

  async uploadReportVideo(file: File, petId: string, sessionId: string, durationSeconds?: number) {
    const contentType = file.type === "video/quicktime" || file.name.toLowerCase().endsWith(".mov")
      ? "video/quicktime"
      : "video/mp4";
    const target = await this.request<{ videoId: string; uploadUrl: string }>("/videos/upload-url", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        contentType,
        fileSizeBytes: file.size,
        durationSeconds,
        reportAssignment: { petId, sessionId },
      }),
    });
    const response = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: file,
    });
    if (!response.ok) throw new Error(`Video upload failed (${response.status})`);
    await this.request(`/videos/${target.videoId}/confirm-upload`, {
      method: "POST",
      body: JSON.stringify({ fileSizeBytes: file.size }),
    });
    return this.request("/video-links", {
      method: "POST",
      body: JSON.stringify({ videoId: target.videoId, petId, sessionId }),
    });
  }

  workspace(sessionId: string) {
    return this.request<SessionWorkspaceData>(`/admin/sessions/${sessionId}/workspace`);
  }

  confirmAssignments(
    photoId: string,
    assignments: Array<{ petId: string; sessionId: string; sourceDetectionId?: string }>
  ) {
    return this.request(`/photos/${photoId}/confirm-assignments`, {
      method: "POST",
      body: JSON.stringify({ assignments }),
    });
  }

  reprocessPhoto(photoId: string) {
    return this.request(`/admin/photos/${photoId}/reprocess`, { method: "POST" });
  }

  reprocessAllPhotos(filter: "review" | "unmatched" | "failed" | "all") {
    return this.request<{ queuedCount: number }>("/admin/photos/reprocess-all", {
      method: "POST",
      body: JSON.stringify({ filter }),
    });
  }

  rejectPhoto(photoId: string) {
    return this.request(`/admin/photos/${photoId}/reject`, { method: "POST" });
  }

  deletePhoto(photoId: string, reason = "Deleted by manager") {
    return this.request<{ id: string; removedLinkCount: number; removedFromOwnerView: boolean; deactivatedEmbeddingCount: number }>(
      `/admin/photos/${photoId}`,
      { method: "DELETE", body: JSON.stringify({ reason }) }
    );
  }

  finalizePhotoSelection(sessionId: string, selectedPhotoLinkIds: string[]) {
    return this.request<{ publishedCount: number; excludedCount: number }>(
      `/admin/sessions/${sessionId}/photos/finalize-selection`,
      { method: "POST", body: JSON.stringify({ selectedPhotoLinkIds }) }
    );
  }

  reviewPhotoLink(linkId: string, reviewState: "candidate" | "rejected") {
    return this.request(`/photo-links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState }),
    });
  }

  publishPhotos(sessionId: string, photoLinkIds: string[]) {
    return this.request(`/sessions/${sessionId}/photos/publish`, {
      method: "POST",
      body: JSON.stringify({ photoLinkIds }),
    });
  }

  reviewVideoLink(linkId: string, reviewState: "candidate" | "rejected") {
    return this.request(`/video-links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState }),
    });
  }

  publishVideos(sessionId: string, videoLinkIds: string[]) {
    return this.request(`/sessions/${sessionId}/videos/publish`, {
      method: "POST",
      body: JSON.stringify({ videoLinkIds }),
    });
  }

  createReportVideo(
    sessionId: string,
    data: { reportDate: string; mediaWindow: import("./types").ReportMediaWindow; title?: string; closingCaption?: string; targetSeconds: number; template: import("./types").ReportTheme; musicStyle: import("./types").ReportMusicStyle; visualStyle: import("./types").ReportVisualStyle; mainPhotoLinkId?: string; photoLinkIds?: string[]; videoLinkIds?: string[]; includeQualityIdentityPhotos?: boolean }
  ) {
    return this.request(`/sessions/${sessionId}/report-videos`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  approveReportVideo(id: string) {
    return this.request(`/report-videos/${id}/approve`, { method: "POST" });
  }

  publishReportVideo(id: string) {
    return this.request(`/report-videos/${id}/publish`, { method: "POST" });
  }

  deleteReportVideo(id: string) {
    return this.request<{ deleted: boolean; id: string }>(`/report-videos/${id}`, { method: "DELETE" });
  }

  emailReportShare(id: string) {
    return this.request<{ shareUrl: string; recipients: string[]; ownerPhone: string | null; sentAt: string; testMode: boolean }>(
      `/report-videos/${id}/email-share`,
      { method: "POST" }
    );
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (auth) {
      const token = localStorage.getItem(ACCESS_KEY);
      if (token) headers.set("authorization", `Bearer ${token}`);
    }

    let response = await fetch(`${API_URL}${path}`, { ...init, headers });
    if (auth && response.status === 401 && (await this.refresh())) {
      headers.set("authorization", `Bearer ${localStorage.getItem(ACCESS_KEY)}`);
      response = await fetch(`${API_URL}${path}`, { ...init, headers });
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  private async refresh() {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return false;
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      this.logout();
      return false;
    }
    const payload = (await response.json()) as { accessToken: string };
    localStorage.setItem(ACCESS_KEY, payload.accessToken);
    return true;
  }
}

function parseJwt(token: string) {
  const rawPayload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const payload = rawPayload.padEnd(Math.ceil(rawPayload.length / 4) * 4, "=");
  return JSON.parse(atob(payload)) as {
    sub: string;
    organizationId: string;
    role: "owner_admin" | "manager" | "staff";
  };
}

export const api = new ApiClient();
export { API_URL };
