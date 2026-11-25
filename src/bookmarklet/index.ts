/**
 * Repost Cleaner bookmarklet. Runs on tiktok.com inside the logged-in page.
 *
 * Two modes:
 * - On a full-screen video: walk through reposts with the page's own next button,
 *   clicking the repost control on each video in the batch copied from the dashboard.
 * - On any other TikTok page: scan the page for videos and copy the list to the clipboard.
 *
 * Selectors come from TikTok's data-e2e attributes, as used by existing community
 * scripts (MIT-licensed, see README). Verify them on your own account before a real run.
 *
 * Safety: only videos listed in the copied batch are clicked. Test mode only reports.
 */
import {
  APP_TAG,
  MAX_BATCH,
  PROTOCOL_VERSION,
  parsePayload,
  type RemovePayload,
  type RepostItem,
  type ResultEntry,
  type ResultPayload,
  type ScanPayload,
} from "../shared/protocol";

const PANEL_ID = "rc-v2-panel";
const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;
const VIDEO_PATH = /^\/@([^/]+)\/video\/(\d+)/;
const CURRENT_ID = /\/video\/(\d+)/;
const BTN =
  "background:#27272a;color:#fafafa;border:0;border-radius:10px;padding:9px 12px;font:600 13px system-ui,sans-serif;";

const REPOST_SELECTOR = 'button[data-e2e="video-share-repost"]';
const REPOST_FALLBACK = '[data-e2e="video-share-repost"]';
const REPOST_ICON = 'svg[data-e2e="repost-icon"]';
const NEXT_SELECTOR = 'button[data-e2e="arrow-right"]';

/** Pause between videos, randomised a little. */
const DELAY_MIN = 500;
const DELAY_MAX = 900;

let stopRequested = false;
let paused = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
const randomDelay = (): number => DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));

async function waitIfPaused(): Promise<void> {
  while (paused && !stopRequested) await sleep(300);
}

/** Polls until check() returns a truthy value, or the timeout passes (returns null). */
async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs: number, intervalMs = 150): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

interface Panel {
  title(text: string): void;
  status(text: string): void;
  progress(ratio: number): void;
  manual(text: string): void;
}

function openPanel(): Panel {
  document.getElementById(PANEL_ID)?.remove();
  stopRequested = false;
  paused = false;

  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.setAttribute(
    "style",
    "position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147483647;" +
      "background:#18181b;color:#fafafa;border:1px solid #27272a;border-radius:16px;padding:14px;" +
      "font:14px -apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6)",
  );
  el.innerHTML = `
    <div data-role="title" style="font-weight:700;margin-bottom:4px"></div>
    <div data-role="status" style="color:#a1a1aa;margin-bottom:10px;min-height:1.2em"></div>
    <div style="height:6px;background:#27272a;border-radius:99px;overflow:hidden">
      <i data-role="bar" style="display:block;height:100%;width:0;background:linear-gradient(90deg,#a78bfa,#60a5fa);transition:width .3s"></i>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button data-role="pause" style="${BTN}">Pause</button>
      <button data-role="stop" style="${BTN}">Stop</button>
      <button data-role="close" style="${BTN}">Close</button>
    </div>
    <textarea data-role="manual" readonly style="display:none;width:100%;height:90px;margin-top:10px;background:#09090b;color:#e4e4e7;border:1px solid #27272a;border-radius:10px;padding:8px;font:12px ui-monospace,monospace"></textarea>`;
  document.body.appendChild(el);

  const q = <T extends HTMLElement>(role: string): T => el.querySelector(`[data-role="${role}"]`) as T;

  const pause = q<HTMLButtonElement>("pause");
  pause.addEventListener("click", () => {
    paused = !paused;
    pause.textContent = paused ? "Resume" : "Pause";
    q<HTMLElement>("status").textContent = paused ? "Paused" : "";
  });
  q<HTMLButtonElement>("stop").addEventListener("click", () => {
    stopRequested = true;
    q<HTMLElement>("status").textContent = "Stopping after the current video…";
  });
  q<HTMLButtonElement>("close").addEventListener("click", () => {
    stopRequested = true;
    el.remove();
  });

  return {
    title: (t) => {
      q<HTMLElement>("title").textContent = t;
    },
    status: (t) => {
      q<HTMLElement>("status").textContent = t;
    },
    progress: (r) => {
      q<HTMLElement>("bar").style.width = `${Math.round(Math.min(1, Math.max(0, r)) * 100)}%`;
    },
    manual: (t) => {
      const ta = q<HTMLTextAreaElement>("manual");
      ta.style.display = "block";
      ta.value = t;
      ta.select();
    },
  };
}

/** Writes a result to the clipboard, or shows it for manual copying if blocked. */
async function deliver(panel: Panel, text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    panel.status(success);
  } catch {
    panel.status("Clipboard blocked. Copy the text below, then open the dashboard.");
    panel.manual(text);
  }
}

/** Reads the clipboard for a batch. Falls back to a prompt if access is blocked. */
async function readBatchText(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()).trim();
  } catch {
    return (window.prompt("Paste the batch from the dashboard, or leave empty to scan this page:") ?? "").trim();
  }
}

// ---------- Full-screen video mode ----------

function currentVideoId(): string | null {
  const m = CURRENT_ID.exec(location.pathname);
  return m ? m[1] : null;
}

function findRepostButton(): HTMLElement | null {
  const direct =
    document.querySelector<HTMLElement>(REPOST_SELECTOR) ?? document.querySelector<HTMLElement>(REPOST_FALLBACK);
  if (direct) return direct;
  const icon = document.querySelector<SVGElement>(REPOST_ICON);
  return icon?.closest<HTMLElement>("button") ?? null;
}

async function processCurrent(id: string, inBatch: boolean, dryRun: boolean): Promise<ResultEntry | null> {
  if (!inBatch) return null; // not part of the copied batch: do nothing, just move on
  const button = findRepostButton();
  if (!button) return { id, outcome: "skipped", detail: "repost control not found on this video" };
  if (dryRun) return { id, outcome: "dry-run", detail: "repost control found" };
  button.click();
  await sleep(700);
  return { id, outcome: "removed", detail: "clicked; confirm on your Reposts tab" };
}

async function runPlayer(payload: RemovePayload, panel: Panel): Promise<void> {
  const batchIds = new Set(payload.items.map((i) => i.id));
  const limit = Math.min(payload.items.length, MAX_BATCH);
  const results: ResultEntry[] = [];
  const visited = new Set<string>();
  let processed = 0;
  let failures = 0;

  panel.title(payload.dryRun ? "Test run · nothing will be clicked" : "Removing reposts");

  for (let step = 0; step < 200 && processed < limit; step++) {
    await waitIfPaused();
    if (stopRequested) break;

    const id = currentVideoId();
    if (!id) {
      panel.status("Not on a video page. Stopped.");
      break;
    }
    if (visited.has(id)) {
      panel.status("Reached a video already visited. Stopped.");
      break;
    }
    visited.add(id);

    panel.status(`${processed + 1} of ${limit} · ${id}`);
    panel.progress(processed / limit);

    const inBatch = batchIds.has(id);
    const result = await processCurrent(id, inBatch, payload.dryRun);
    if (result) {
      results.push(result);
      processed++;
      failures = result.outcome === "failed" ? failures + 1 : 0;
      if (failures >= 3) {
        panel.status("Stopped after 3 failures in a row.");
        break;
      }
    }

    if (processed >= limit) break;
    const next = document.querySelector<HTMLElement>(NEXT_SELECTOR);
    if (!next) {
      panel.status("No next video found. Stopped.");
      break;
    }
    next.click();
    const moved = await waitFor(() => currentVideoId() !== id, 6000);
    if (!moved) {
      panel.status("The next video did not load. Stopped.");
      break;
    }
    await sleep(randomDelay());
  }

  panel.progress(1);
  panel.title("Batch finished");
  const out: ResultPayload = {
    app: APP_TAG,
    v: PROTOCOL_VERSION,
    kind: "result",
    createdAt: new Date().toISOString(),
    dryRun: payload.dryRun,
    results,
  };
  await deliver(panel, JSON.stringify(out), `Processed ${results.length}. Open the dashboard and tap Read clipboard.`);
}

// ---------- Scan mode ----------

function collect(seen: Map<string, RepostItem>): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]').forEach((a) => {
    let path: string;
    try {
      path = new URL(a.href, location.href).pathname;
    } catch {
      return;
    }
    const match = VIDEO_PATH.exec(path);
    if (!match) return;
    const author = match[1];
    const id = match[2];
    if (seen.has(id)) return;
    seen.set(id, { id, url: `https://www.tiktok.com/@${author}/video/${id}`, author });
  });
}

async function runScan(panel: Panel): Promise<void> {
  panel.title("Scanning your reposts");
  if (!/repost/i.test(location.pathname)) {
    if (!window.confirm("This doesn't look like your Reposts tab. Scan this page anyway?")) {
      panel.title("Cancelled");
      return;
    }
  }

  const seen = new Map<string, RepostItem>();
  collect(seen);
  let idle = 0;
  for (let round = 0; round < 80 && !stopRequested && idle < 3; round++) {
    await waitIfPaused();
    const before = seen.size;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(1400);
    collect(seen);
    idle = seen.size === before ? idle + 1 : 0;
    panel.status(`Found ${seen.size} so far…`);
  }
  window.scrollTo(0, 0);

  const items = [...seen.values()];
  const payload: ScanPayload = {
    app: APP_TAG,
    v: PROTOCOL_VERSION,
    kind: "scan",
    createdAt: new Date().toISOString(),
    items,
  };
  const success =
    items.length === 0
      ? "No reposts found on this page. Open your Reposts tab and try again."
      : `Found ${items.length} reposts. Open the dashboard and tap Read clipboard.`;
  panel.title(items.length ? "Scan complete" : "Nothing found");
  await deliver(panel, JSON.stringify(payload), success);
}

// ---------- Entry point ----------

async function main(): Promise<void> {
  if (!TIKTOK_HOST.test(location.hostname)) {
    window.alert("Repost Cleaner only works on tiktok.com. Open your Reposts tab and tap the bookmark again.");
    return;
  }
  const text = await readBatchText();
  const payload = text ? parsePayload(text) : null;
  const panel = openPanel();
  const onVideo = currentVideoId() !== null;

  if (payload && payload.kind === "remove") {
    if (!onVideo) {
      panel.title("Open a video first");
      panel.status("Open the first repost from your Reposts tab, then tap the bookmark again.");
      return;
    }
    await runPlayer(payload, panel);
    return;
  }

  if (onVideo) {
    panel.title("Copy a batch first");
    panel.status("Copy a batch in the dashboard, then tap the bookmark on this video.");
    return;
  }
  await runScan(panel);
}

void main();
