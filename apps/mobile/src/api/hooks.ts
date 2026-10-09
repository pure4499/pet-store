import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import {
  getCurrentPendingCheckIns,
  submitBatchCheckIn,
  submitReservationCheckIn,
  submitSingleCheckIn,
} from "../checkIn/offlineCheckInQueue";

// ── Organization / collar palette (feature 2) ───────────────────────────────

export function useOrganization() {
  return useQuery({ queryKey: ["organization"], queryFn: () => apiFetch<any>("/organizations/me") });
}

export function useFacilities() {
  return useQuery({
    queryKey: ["facilities"],
    queryFn: () => apiFetch<Array<{ id: string; name: string; is_default: boolean }>>("/organizations/me/facilities"),
  });
}

export function useCollarPalette() {
  return useQuery({
    queryKey: ["collar-palette"],
    queryFn: () => apiFetch<any[]>("/organizations/me/collar-palette"),
  });
}

// ── Owners & pets (feature 1) ──────────────────────────────────────────────

/**
 * `requireSearch` gates the query on a non-empty search string (used at
 * check-in, where showing nothing until staff start typing is the point).
 * The Pets directory tab wants the opposite — a full listing by default —
 * which the API already supports (an empty/absent `search` lists all pets),
 * so it passes `requireSearch: false`.
 */
export function usePets(search: string, options?: { requireSearch?: boolean }) {
  const requireSearch = options?.requireSearch ?? true;
  return useQuery({
    queryKey: ["pets", search],
    queryFn: () => apiFetch<any[]>(`/pets?search=${encodeURIComponent(search)}`),
    enabled: !requireSearch || search.length > 0,
  });
}

export function usePet(petId: string | undefined) {
  return useQuery({
    queryKey: ["pet", petId],
    queryFn: () => apiFetch<any>(`/pets/${petId}`),
    enabled: !!petId,
  });
}

export function usePetPublishedPhotos(petId: string | undefined) {
  return useQuery({
    queryKey: ["pet-photos", petId],
    queryFn: () => apiFetch<any[]>(`/pets/${petId}/photos`),
    enabled: !!petId,
  });
}

// ── Households (family grouping + daily reports) ────────────────────────────

export function useLinkHousehold(petId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { ownerId: string; otherOwnerId: string }) =>
      apiFetch<any>(`/owners/${input.ownerId}/link-household`, {
        method: "POST",
        body: JSON.stringify({ otherOwnerId: input.otherOwnerId }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pet", petId] }),
  });
}

export function useUnlinkHousehold(petId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ownerId: string) => apiFetch<void>(`/owners/${ownerId}/unlink-household`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pet", petId] }),
  });
}

export function useSendReport(householdId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date?: string) =>
      apiFetch<{ reportDate: string; recipients: string[] }>(`/households/${householdId}/send-report`, {
        method: "POST",
        body: JSON.stringify({ date }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["household-reports", householdId] }),
  });
}

export function useHouseholdReports(householdId: string | undefined) {
  return useQuery({
    queryKey: ["household-reports", householdId],
    queryFn: () => apiFetch<any[]>(`/households/${householdId}/reports`),
    enabled: !!householdId,
  });
}

export function useCreatePet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      species: "dog" | "cat" | "other";
      ownerId?: string;
      breed?: string;
    }) => apiFetch<any>("/pets", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pets"] }),
  });
}

export function useCreateOwner() {
  return useMutation({
    mutationFn: (input: { fullName: string; phone?: string; email?: string }) =>
      apiFetch<any>("/owners", { method: "POST", body: JSON.stringify(input) }),
  });
}

export function useOwners(search: string) {
  return useQuery({
    queryKey: ["owners", search],
    queryFn: () => apiFetch<any[]>(`/owners?search=${encodeURIComponent(search)}`),
    enabled: search.length > 0,
  });
}

// ── Sessions / check-in / collar (features 1 & 2) ──────────────────────────

export function useActiveSessions() {
  return useQuery({
    queryKey: ["sessions", "active"],
    queryFn: () => apiFetch<any[]>("/sessions?status=active"),
    refetchOnMount: "always",
    refetchInterval: 30_000,
  });
}

export function useReservedSessions() {
  return useQuery({
    queryKey: ["sessions", "reserved"],
    queryFn: () => apiFetch<any[]>("/sessions?status=reserved"),
    refetchOnMount: "always",
    refetchInterval: 30_000,
  });
}

export function useSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => apiFetch<any>(`/sessions/${sessionId}`),
    enabled: !!sessionId,
  });
}

export function useCheckIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      petId: string;
      petName: string;
      sessionType: "boarding" | "daycare";
      collarEnabled?: boolean;
      collarPaletteId?: string;
      collarLabel?: string;
    }) => submitSingleCheckIn(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["pending-check-ins"] });
      if (result.status === "completed") queryClient.invalidateQueries({ queryKey: ["sessions", "active"] });
    },
  });
}

export function useBatchCheckIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      petIds: string[];
      petNames: string[];
      sessionType: "boarding" | "daycare";
    }) => submitBatchCheckIn(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["pending-check-ins"] });
      if (result.status === "completed") queryClient.invalidateQueries({ queryKey: ["sessions", "active"] });
    },
  });
}

export function useStartReservation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sessionId: string;
      petId: string;
      petName: string;
      collarEnabled?: boolean;
      collarPaletteId?: string;
      collarLabel?: string;
    }) => submitReservationCheckIn(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["pending-check-ins"] });
      if (result.status !== "completed") return;
      const session = result.sessions[0];
      queryClient.invalidateQueries({ queryKey: ["sessions", "reserved"] });
      queryClient.invalidateQueries({ queryKey: ["sessions", "active"] });
      queryClient.invalidateQueries({ queryKey: ["session", session.id] });
    },
  });
}

export function usePendingCheckIns() {
  return useQuery({
    queryKey: ["pending-check-ins"],
    queryFn: getCurrentPendingCheckIns,
    refetchInterval: 2_000,
  });
}

export function useCheckOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => apiFetch<any>(`/sessions/${sessionId}/check-out`, { method: "POST" }),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ["sessions", "active"] });
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
  });
}

// ── Daily log (feature 1) ───────────────────────────────────────────────────

export function useDailyLogs(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["logs", sessionId],
    queryFn: () => apiFetch<any[]>(`/sessions/${sessionId}/logs`),
    enabled: !!sessionId,
  });
}

export function useCreateLogEntry(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { entryType: string; entryAt?: string; title?: string; body?: string; structuredData?: Record<string, unknown> }) =>
      apiFetch<any>(`/sessions/${sessionId}/logs`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["logs", sessionId] }),
  });
}

// ── Photos (features 3, 4, 5) ───────────────────────────────────────────────

export function useSessionPhotos(sessionId: string | undefined, state?: string) {
  return useQuery({
    queryKey: ["session-photos", sessionId, state],
    queryFn: () => apiFetch<any[]>(`/sessions/${sessionId}/photos${state ? `?state=${state}` : ""}`),
    enabled: !!sessionId,
  });
}

export function useNeedsReviewPhotos() {
  return useQuery({
    queryKey: ["photos", "needs-review"],
    queryFn: () => apiFetch<any[]>("/photos/needs-review"),
  });
}

export function usePublishPhotos(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (photoLinkIds: string[]) =>
      apiFetch<any>(`/sessions/${sessionId}/photos/publish`, {
        method: "POST",
        body: JSON.stringify({ photoLinkIds }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-photos", sessionId] }),
  });
}

export function useAssignPhoto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { photoId: string; petId: string; sessionId: string; sourceDetectionId?: string }) =>
      apiFetch<any>("/photo-links", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["photos", "needs-review"] }),
  });
}

export function useAssignVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { videoId: string; petId: string; sessionId: string }) =>
      apiFetch<any>("/video-links", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (_data, input) => queryClient.invalidateQueries({ queryKey: ["session-videos", input.sessionId] }),
  });
}
