/**
 * Clipboard protocol shared by the dashboard and the bookmarklet.
 * Every payload is plain JSON tagged with APP_TAG, validated on read.
 */

export const APP_TAG = "repost-cleaner" as const;
export const PROTOCOL_VERSION = 1 as const;
export const MAX_BATCH = 25;

export interface RepostItem {
  id: string;
  url: string;
  author: string | null;
}

export interface ScanPayload {
  app: typeof APP_TAG;
  v: typeof PROTOCOL_VERSION;
  kind: "scan";
  createdAt: string;
  items: RepostItem[];
}

export interface RemovePayload {
  app: typeof APP_TAG;
  v: typeof PROTOCOL_VERSION;
  kind: "remove";
  createdAt: string;
  dryRun: boolean;
  items: RepostItem[];
}

export type ItemOutcome = "removed" | "failed" | "skipped" | "dry-run";

export interface ResultEntry {
  id: string;
  outcome: ItemOutcome;
  detail?: string;
}

export interface ResultPayload {
  app: typeof APP_TAG;
  v: typeof PROTOCOL_VERSION;
  kind: "result";
  createdAt: string;
  dryRun: boolean;
  results: ResultEntry[];
}

export type Payload = ScanPayload | RemovePayload | ResultPayload;

const ID_RE = /^\d{5,25}$/;
const OUTCOMES: readonly string[] = ["removed", "failed", "skipped", "dry-run"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { id, url, author } = value;
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  if (typeof url !== "string" || !url.startsWith("https://www.tiktok.com/@")) return false;
  if (!url.endsWith(`/video/${id}`)) return false;
  return author === null || typeof author === "string";
}

function isItems(value: unknown): value is RepostItem[] {
  return Array.isArray(value) && value.length <= 5000 && value.every(isItem);
}

function isResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    ID_RE.test(value.id) &&
    typeof value.outcome === "string" &&
    OUTCOMES.includes(value.outcome) &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

/** Returns a validated payload, or null if the text is not one of ours. */
export function parsePayload(text: string): Payload | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.app !== APP_TAG || data.v !== PROTOCOL_VERSION) return null;

  const createdAt = typeof data.createdAt === "string" ? data.createdAt : new Date(0).toISOString();

  if (data.kind === "scan" && isItems(data.items)) {
    return { app: APP_TAG, v: PROTOCOL_VERSION, kind: "scan", createdAt, items: data.items };
  }
  if (data.kind === "remove" && isItems(data.items) && typeof data.dryRun === "boolean") {
    return {
      app: APP_TAG,
      v: PROTOCOL_VERSION,
      kind: "remove",
      createdAt,
      dryRun: data.dryRun,
      items: data.items,
    };
  }
  if (
    data.kind === "result" &&
    Array.isArray(data.results) &&
    data.results.every(isResult) &&
    typeof data.dryRun === "boolean"
  ) {
    return {
      app: APP_TAG,
      v: PROTOCOL_VERSION,
      kind: "result",
      createdAt,
      dryRun: data.dryRun,
      results: data.results as ResultEntry[],
    };
  }
  return null;
}
