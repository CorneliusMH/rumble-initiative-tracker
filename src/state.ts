import OBR from "@owlbear-rodeo/sdk";
import type { CoreState, Declaration, QueuedAction } from "./types";

export const NAMESPACE = "com.rumble.initiative";
export const CORE_KEY = `${NAMESPACE}/core`;
export const DECL_PREFIX = `${NAMESPACE}/decl/`;
export const PLAYER_INIT_PREFIX = `${NAMESPACE}/player/`;
export const PLAYER_PARTICIPANT_PREFIX = "player:";
export const ITEM_META_KEY = `${NAMESPACE}/initiative`;
export const LOG_KEY = `${NAMESPACE}/log`;
const HISTORY_KEY = `${NAMESPACE}/quick-history`;
const LOCAL_QUEUE_PREFIX = `${NAMESPACE}/local-queue/`;
const LOCAL_LOG_PREFIX = `${NAMESPACE}/local-log/`;

const MAX_DECL_TEXT = 240;
const MAX_LOG_TEXT = 400;
// Keep migrated and local logs bounded.
const MAX_LOG_ENTRIES = 250;

const DEFAULT_CORE: CoreState = {
  roundNumber: 1,
  rumbleNumber: 1,
  rumblesPerRound: 3,
  phase: "plan"
};

export function getDefaultCore(): CoreState {
  return structuredClone(DEFAULT_CORE);
}

export function sanitizeCore(input: unknown): CoreState {
  if (!input || typeof input !== "object") return getDefaultCore();
  const state = input as Partial<CoreState>;
  // Migrate legacy "reveal" phase (dropped in favor of Plan/Resolve only) to "resolve".
  const rawPhase = state.phase as string | undefined;
  return {
    roundNumber: Number.isFinite(state.roundNumber) ? Math.max(1, Number(state.roundNumber)) : 1,
    rumbleNumber:
      state.rumbleNumber === 1 || state.rumbleNumber === 2 || state.rumbleNumber === 3
        ? state.rumbleNumber
        : 1,
    rumblesPerRound: state.rumblesPerRound === 1 ? 1 : 3,
    phase: rawPhase === "resolve" || rawPhase === "reveal" ? "resolve" : "plan"
  };
}

export function sanitizeDeclaration(input: unknown): Declaration | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") return null;
  const value = input as Partial<Declaration>;

  let queue: QueuedAction[] | undefined;
  if (Array.isArray(value.queue)) {
    queue = value.queue
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        text: typeof item.text === "string" ? item.text.slice(0, MAX_DECL_TEXT) : "",
        timestamp: Number.isFinite(item.timestamp) ? Number(item.timestamp) : Date.now()
      }))
      .slice(0, 3);
  }

  return {
    text: typeof value.text === "string" ? value.text.slice(0, MAX_DECL_TEXT) : "",
    ready: Boolean(value.ready),
    revealed: Boolean(value.revealed),
    timestamp: Number.isFinite(value.timestamp) ? Number(value.timestamp) : Date.now(),
    ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
    queue: queue && queue.length > 0 ? queue : undefined
  };
}

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function getCoreState(): Promise<CoreState> {
  const metadata = await OBR.scene.getMetadata();
  return sanitizeCore(metadata[CORE_KEY]);
}

export function mutateCoreState(mutator: (state: CoreState) => CoreState): Promise<void> {
  return enqueue(async () => {
    const current = await getCoreState();
    const next = sanitizeCore(mutator(current));
    await OBR.scene.setMetadata({ [CORE_KEY]: next });
  });
}

export function readDeclarations(metadata: Record<string, unknown>): Record<string, Declaration> {
  const out: Record<string, Declaration> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(DECL_PREFIX)) continue;
    const sanitized = sanitizeDeclaration(value);
    if (sanitized) out[key.slice(DECL_PREFIX.length)] = sanitized;
  }
  return out;
}

export async function getAllDeclarations(): Promise<Record<string, Declaration>> {
  const metadata = await OBR.scene.getMetadata();
  return readDeclarations(metadata as Record<string, unknown>);
}

export function setDeclaration(tokenId: string, value: Declaration | null): Promise<void> {
  return enqueue(async () => {
    await OBR.scene.setMetadata({ [`${DECL_PREFIX}${tokenId}`]: value });
  });
}

export function clearAllDeclarations(): Promise<void> {
  return enqueue(async () => {
    const metadata = await OBR.scene.getMetadata();
    const update: Record<string, null> = {};
    for (const key of Object.keys(metadata)) {
      if (key.startsWith(DECL_PREFIX)) update[key] = null;
    }
    if (Object.keys(update).length) await OBR.scene.setMetadata(update);
  });
}

export function advanceDeclarationsToResolve(): Promise<void> {
  return enqueue(async () => {
    const metadata = await OBR.scene.getMetadata();
    const current = sanitizeCore(metadata[CORE_KEY]);
    if (current.phase === "resolve") return;

    const update: Record<string, unknown> = {
      [CORE_KEY]: { ...current, phase: "resolve" },
    };
    for (const [key, value] of Object.entries(metadata)) {
      if (!key.startsWith(DECL_PREFIX)) continue;
      const declaration = sanitizeDeclaration(value);
      if (declaration && !declaration.revealed) {
        update[key] = { ...declaration, revealed: true };
      }
    }
    await OBR.scene.setMetadata(update);
  });
}

// Advance all declarations to the next rumble: pop each queue's first entry into
// the active declaration (auto-ready) and shift the queue; declarations without
// a queued action are cleared. Runs as a single atomic setMetadata call.
export function advanceDeclarationsToNextRumble(): Promise<void> {
  return enqueue(async () => {
    const metadata = await OBR.scene.getMetadata();
    const update: Record<string, Declaration | null> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!key.startsWith(DECL_PREFIX)) continue;
      const decl = sanitizeDeclaration(value);
      if (!decl) {
        update[key] = null;
        continue;
      }
      const queue = decl.queue ?? [];
      if (queue.length === 0) {
        update[key] = null;
        continue;
      }
      const [next, ...rest] = queue;
      update[key] = {
        text: next.text,
        ready: true,
        revealed: false,
        timestamp: Date.now(),
        ownerId: decl.ownerId,
        queue: rest.length > 0 ? rest : undefined,
      };
    }
    if (Object.keys(update).length) await OBR.scene.setMetadata(update);
  });
}

// Revert the current rumble to its planning phase: keep every declaration's
// text (so players can edit it) and its queue, but clear ready/revealed.
export function revertDeclarationsToPlanning(): Promise<void> {
  return enqueue(async () => {
    const metadata = await OBR.scene.getMetadata();
    const update: Record<string, Declaration> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!key.startsWith(DECL_PREFIX)) continue;
      const decl = sanitizeDeclaration(value);
      if (!decl) continue;
      update[key] = { ...decl, ready: false, revealed: false };
    }
    if (Object.keys(update).length) await OBR.scene.setMetadata(update);
  });
}

export interface LogEntry {
  timestamp: number;
  text: string;
}

export function readLog(metadata: Record<string, unknown>): LogEntry[] {
  const raw = metadata[LOG_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): LogEntry | null => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Partial<LogEntry>;
      if (typeof e.text !== "string") return null;
      return {
        text: e.text.slice(0, MAX_LOG_TEXT),
        timestamp: Number.isFinite(e.timestamp) ? Number(e.timestamp) : Date.now(),
      };
    })
    .filter((e): e is LogEntry => e !== null)
    .slice(-MAX_LOG_ENTRIES);
}

function localStorageKey(prefix: string, scope: string, id = ""): string {
  return `${prefix}${encodeURIComponent(scope)}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getLocalQueuedActions(scope: string, participantId: string): QueuedAction[] {
  const raw = readLocalJson<unknown[]>(localStorageKey(LOCAL_QUEUE_PREFIX, scope, participantId), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const value = entry as Partial<QueuedAction>;
      return {
        text: typeof value.text === "string" ? value.text.slice(0, MAX_DECL_TEXT) : "",
        timestamp: Number.isFinite(value.timestamp) ? Number(value.timestamp) : Date.now(),
      };
    })
    .filter((entry) => entry.text.length > 0)
    .slice(0, 2);
}

export function setLocalQueuedActions(
  scope: string,
  participantId: string,
  actions: QueuedAction[]
): QueuedAction[] {
  const next = actions.slice(0, 2);
  const key = localStorageKey(LOCAL_QUEUE_PREFIX, scope, participantId);
  if (next.length > 0) localStorage.setItem(key, JSON.stringify(next));
  else localStorage.removeItem(key);
  return next;
}

export function getLocalLog(scope: string): LogEntry[] {
  return readLog({
    [LOG_KEY]: readLocalJson<unknown[]>(localStorageKey(LOCAL_LOG_PREFIX, scope), []),
  });
}

export function appendLocalLogEntries(scope: string, texts: string[]): LogEntry[] {
  const clean = texts.map((text) => text.trim()).filter(Boolean);
  if (clean.length === 0) return getLocalLog(scope);
  const current = getLocalLog(scope);
  const now = Date.now();
  const next = [
    ...current,
    ...clean.map((text) => ({ timestamp: now, text: text.slice(0, MAX_LOG_TEXT) })),
  ].slice(-MAX_LOG_ENTRIES);
  localStorage.setItem(localStorageKey(LOCAL_LOG_PREFIX, scope), JSON.stringify(next));
  return next;
}

export function clearLocalLog(scope: string): LogEntry[] {
  localStorage.removeItem(localStorageKey(LOCAL_LOG_PREFIX, scope));
  return [];
}

export function migrateSceneLogToLocal(scope: string, metadata: Record<string, unknown>): LogEntry[] {
  const legacy = readLog(metadata);
  const current = getLocalLog(scope);
  const next = [...current, ...legacy].slice(-MAX_LOG_ENTRIES);
  if (next.length > 0) {
    localStorage.setItem(localStorageKey(LOCAL_LOG_PREFIX, scope), JSON.stringify(next));
  }
  return next;
}

export interface PlayerInitiativeData {
  initiative: number;
  delay: number;
}

export function sanitizePlayerInit(input: unknown): PlayerInitiativeData | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Partial<PlayerInitiativeData>;
  return {
    initiative: Number.isFinite(v.initiative) ? Math.max(0, Number(v.initiative)) : 0,
    delay: Number.isFinite(v.delay) ? Math.max(0, Number(v.delay)) : 0,
  };
}

export function readPlayerInits(
  metadata: Record<string, unknown>
): Record<string, PlayerInitiativeData> {
  const out: Record<string, PlayerInitiativeData> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(PLAYER_INIT_PREFIX)) continue;
    const sanitized = sanitizePlayerInit(value);
    if (sanitized) out[key.slice(PLAYER_INIT_PREFIX.length)] = sanitized;
  }
  return out;
}

export function setPlayerInit(
  playerId: string,
  value: PlayerInitiativeData | null
): Promise<void> {
  return enqueue(async () => {
    await OBR.scene.setMetadata({ [`${PLAYER_INIT_PREFIX}${playerId}`]: value });
  });
}

export function onMetadataChange(
  callback: (metadata: Record<string, unknown>) => void
): () => void {
  return OBR.scene.onMetadataChange((metadata) => callback(metadata as Record<string, unknown>));
}

export interface QuickHistoryEntry {
  text: string;
  pinned?: boolean;
}

export function getQuickHistory(): QuickHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Accept legacy string entries and legacy object entries; ignore category.
    return parsed
      .map((entry): QuickHistoryEntry | null => {
        if (typeof entry === "string") return { text: entry };
        if (entry && typeof entry === "object" && typeof entry.text === "string") {
          return { text: entry.text, pinned: Boolean(entry.pinned) };
        }
        return null;
      })
      .filter((e): e is QuickHistoryEntry => e !== null)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      .slice(0, 10);
  } catch {
    return [];
  }
}

export function pushQuickHistory(text: string): QuickHistoryEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return getQuickHistory();
  const current = getQuickHistory();
  const existing = current.find((entry) => entry.text === trimmed);
  const merged: QuickHistoryEntry[] = [
    { text: trimmed, pinned: existing?.pinned },
    ...current.filter((entry) => entry.text !== trimmed),
  ]
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    .slice(0, 10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
  return merged;
}

export function removeQuickHistory(text: string): QuickHistoryEntry[] {
  const next = getQuickHistory().filter((entry) => entry.text !== text);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function toggleQuickHistoryPin(text: string): QuickHistoryEntry[] {
  const next = getQuickHistory()
    .map((entry) =>
      entry.text === text ? { ...entry, pinned: !entry.pinned } : entry
    )
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}
