import { MAX_BATCH } from "../shared/protocol";

export type Status = "pending" | "removed" | "failed" | "skipped";

export interface LibraryItem {
  id: string;
  url: string;
  author: string | null;
  status: Status;
  detail?: string;
  updatedAt: string;
}

export interface Library {
  items: LibraryItem[];
  selected: string[];
  batchSize: number;
  dryRun: boolean;
}

const KEY = "rc.library.v2";

export function emptyLibrary(): Library {
  return { items: [], selected: [], batchSize: 10, dryRun: true };
}

/** Loads the saved library. Anything malformed falls back to defaults. */
export function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyLibrary();
    const saved = JSON.parse(raw) as Partial<Library>;
    const base = emptyLibrary();
    return {
      items: Array.isArray(saved.items) ? saved.items : base.items,
      selected: Array.isArray(saved.selected) ? saved.selected : base.selected,
      batchSize:
        typeof saved.batchSize === "number"
          ? Math.min(Math.max(1, Math.floor(saved.batchSize)), MAX_BATCH)
          : base.batchSize,
      dryRun: typeof saved.dryRun === "boolean" ? saved.dryRun : base.dryRun,
    };
  } catch {
    return emptyLibrary();
  }
}

export function saveLibrary(lib: Library): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lib));
  } catch {
    // Storage full or unavailable. The library stays in memory for this session.
  }
}
