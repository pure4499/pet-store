import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { ApiError, apiFetch } from "../api/client";
import { tokenStore } from "../api/tokenStore";

const STORAGE_KEY = "tail-tells.pending-check-ins.v1";

type CheckInKind = "single" | "batch" | "reservation";
type QueueState = "pending" | "needs_attention";

export interface PendingCheckIn {
  id: string;
  accountKey: string;
  facilityId: string;
  facilityName: string;
  kind: CheckInKind;
  petIds: string[];
  petNames: string[];
  reservationId?: string;
  body: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  state: QueueState;
  lastError?: string;
}

export type CheckInSubmission =
  | { status: "completed"; sessions: any[] }
  | { status: "queued"; job: PendingCheckIn };

let queueLock: Promise<void> = Promise.resolve();
let processing: Promise<ProcessResult> | null = null;

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    return (character === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

async function readQueue() {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [] as PendingCheckIn[];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as PendingCheckIn[] : [];
  } catch {
    return [] as PendingCheckIn[];
  }
}

async function updateQueue(update: (jobs: PendingCheckIn[]) => PendingCheckIn[]) {
  let output: PendingCheckIn[] = [];
  const operation = queueLock.then(async () => {
    output = update(await readQueue());
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(output));
  });
  queueLock = operation.catch(() => undefined);
  await operation;
  return output;
}

async function currentScope() {
  const [accountKey, facility] = await Promise.all([
    tokenStore.getAccountKey(),
    tokenStore.getSelectedFacility(),
  ]);
  if (!accountKey || !facility) throw new Error("Sign in and choose a facility before checking in a pet.");
  return { accountKey, facility };
}

async function send(job: PendingCheckIn) {
  const headers = { "x-facility-id": job.facilityId };
  if (job.kind === "reservation") {
    return [await apiFetch<any>(`/sessions/${job.reservationId}/check-in`, {
      method: "POST",
      headers,
      body: JSON.stringify(job.body),
    })];
  }
  if (job.kind === "batch") {
    return apiFetch<any[]>("/sessions/batch", {
      method: "POST",
      headers,
      body: JSON.stringify(job.body),
    });
  }
  return [await apiFetch<any>("/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(job.body),
  })];
}

interface ProcessResult {
  completed: Map<string, any[]>;
  remaining: PendingCheckIn[];
}

async function runQueue(): Promise<ProcessResult> {
  const completed = new Map<string, any[]>();
  const [network, accountKey] = await Promise.all([NetInfo.fetch(), tokenStore.getAccountKey()]);
  let jobs = await readQueue();
  if (!accountKey || network.isConnected === false || network.isInternetReachable === false) {
    return { completed, remaining: jobs };
  }

  for (const job of jobs.filter((candidate) => candidate.accountKey === accountKey && candidate.state === "pending")) {
    try {
      const sessions = await send(job);
      completed.set(job.id, sessions);
      jobs = await updateQueue((current) => current.filter((candidate) => candidate.id !== job.id));
    } catch (error) {
      const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500
        && ![401, 408, 429].includes(error.status);
      jobs = await updateQueue((current) => current.map((candidate) => candidate.id === job.id ? {
        ...candidate,
        attempts: candidate.attempts + 1,
        state: permanent ? "needs_attention" : "pending",
        lastError: error instanceof Error ? error.message : "Could not reach the server",
      } : candidate));
      if (!permanent) break;
    }
  }
  return { completed, remaining: jobs };
}

export function processPendingCheckIns() {
  processing ??= runQueue().finally(() => { processing = null; });
  return processing;
}

async function enqueue(job: Omit<PendingCheckIn, "id" | "accountKey" | "facilityId" | "facilityName" | "createdAt" | "attempts" | "state">) {
  const { accountKey, facility } = await currentScope();
  const queued: PendingCheckIn = {
    ...job,
    id: uuid(),
    accountKey,
    facilityId: facility.id,
    facilityName: facility.name,
    createdAt: new Date().toISOString(),
    attempts: 0,
    state: "pending",
  };
  await updateQueue((jobs) => [...jobs, queued]);
  const result = await processPendingCheckIns();
  const sessions = result.completed.get(queued.id);
  if (sessions) return { status: "completed", sessions } as const;
  const saved = result.remaining.find((candidate) => candidate.id === queued.id) ?? queued;
  if (saved.state === "needs_attention") throw new Error(saved.lastError ?? "Check-in needs attention");
  return { status: "queued", job: saved } as const;
}

export async function submitSingleCheckIn(input: {
  petId: string;
  petName: string;
  sessionType: "boarding" | "daycare";
  collarEnabled?: boolean;
  collarPaletteId?: string;
  collarLabel?: string;
}) {
  const clientCheckInId = uuid();
  return enqueue({
    kind: "single",
    petIds: [input.petId],
    petNames: [input.petName],
    body: { ...input, petName: undefined, clientCheckInId, checkInAt: new Date().toISOString() },
  });
}

export async function submitBatchCheckIn(input: {
  petIds: string[];
  petNames: string[];
  sessionType: "boarding" | "daycare";
}) {
  return enqueue({
    kind: "batch",
    petIds: input.petIds,
    petNames: input.petNames,
    body: {
      petIds: input.petIds,
      sessionType: input.sessionType,
      clientCheckInIds: input.petIds.map(() => uuid()),
      checkInAt: new Date().toISOString(),
    },
  });
}

export async function submitReservationCheckIn(input: {
  sessionId: string;
  petId: string;
  petName: string;
  collarEnabled?: boolean;
  collarPaletteId?: string;
  collarLabel?: string;
}) {
  return enqueue({
    kind: "reservation",
    reservationId: input.sessionId,
    petIds: [input.petId],
    petNames: [input.petName],
    body: {
      clientCheckInId: uuid(),
      checkInAt: new Date().toISOString(),
      collarEnabled: input.collarEnabled,
      collarPaletteId: input.collarPaletteId,
      collarLabel: input.collarLabel,
    },
  });
}

export async function getCurrentPendingCheckIns() {
  const [jobs, accountKey, facility] = await Promise.all([
    readQueue(),
    tokenStore.getAccountKey(),
    tokenStore.getSelectedFacility(),
  ]);
  return jobs.filter((job) => job.accountKey === accountKey && job.facilityId === facility?.id);
}

export async function retryCurrentPendingCheckIns() {
  const { accountKey, facility } = await currentScope();
  await updateQueue((jobs) => jobs.map((job) => job.accountKey === accountKey && job.facilityId === facility.id
    ? { ...job, state: "pending" as const, lastError: undefined }
    : job));
  return processPendingCheckIns();
}
