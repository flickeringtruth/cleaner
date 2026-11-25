/**
 * Repost Cleaner bookmarklet. Runs on tiktok.com inside the logged-in page.
 *
 * Use it with Safari's "Request Desktop Website" turned on for tiktok.com.
 * The desktop layout shows the Remove repost control; the mobile layout does not.
 *
 * Clipboard holds a batch from the dashboard -> remove that batch.
 * Otherwise -> scan the current Reposts tab and copy the list for the dashboard.
 *
 * For each video: look for a "Remove repost" control; if it is not visible, open
 * the Share panel once and look again. Only an element whose text is exactly
 * "Remove repost" is clicked. The run stops on rate-limit messages or after three
 * failures in a row.
 *
 * UNTESTED on a real account: the desktop control matching and speed must be verified.
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
const REMOVE_LABEL = /^remove repost$/i;
const SHARE_LABEL = /^share/i;
const RATE_LIMIT = /too many requests|try again later|rate limit/i;
const RATE_LIMIT_DETAIL = "rate limited";
const BTN =
  "background:#27272a;color:#fafafa;border:0;border-radius:10px;padding:9px 12px;font:600 13px system-ui,sans-serif;";

/** 16:9 desktop-sized frame so TikTok renders its desktop layout. */
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;

let stopRequested = false;
let paused = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
/** Pause between items: short enough to be practical, randomised to look less mechanical. */
const randomDelay = (): number => 1500 + Math.floor(Math.random() * 1300);

async function waitIfPaused(): Promise<void> {
  while (paused && !stopRequested) await sleep(300);
}

/** Polls until check() returns a truthy value, or the timeout passes (returns null). */
async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs: number, intervalMs = 200): Promise<T | null> {
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
    q<HTMLElement>("status").textContent = "Stopping after the current item…";
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

function waitForLoad(frame: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    window.setTimeout(() => resolve(), timeoutMs);
  });
}

function labelOf(node: HTMLElement): string {
  return (node.getAttribute("aria-label") ?? node.textContent ?? "").trim();
}

/** Finds the element whose visible text is exactly "Remove repost" (deepest match wins). */
function findRemoveButton(doc: Document): HTMLElement | null {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>("button, [role='button'], a, div, span"));
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (REMOVE_LABEL.test(labelOf(nodes[i]))) return nodes[i];
  }
  return null;
}

/** Finds a Share control (short label starting with "Share"). */
function findShareButton(doc: Document): HTMLElement | null {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>("button, [role='button'], a"));
  for (const node of nodes) {
    const label = labelOf(node);
    if (label.length <= 24 && SHARE_LABEL.test(label)) return node;
  }
  return null;
}

/** Text a user could see: page content only, without embedded scripts or styles. */
function visibleText(doc: Document): string {
  const clone = doc.body?.cloneNode(true) as HTMLElement | null;
  if (!clone) return "";
  clone.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
  return clone.textContent ?? "";
}

/** Short labels of repost- or share-related controls, to help diagnose layout changes. */
function relatedLabels(doc: Document): string {
  const labels = Array.from(doc.querySelectorAll<HTMLElement>("button, [role='button'], a"))
    .map(labelOf)
    .filter((t) => /repost|share/i.test(t) && t.length <= 40);
  const unique = [...new Set(labels)].slice(0, 8);
  return unique.length ? unique.join(" | ") : "none";
}

async function processItem(item: RepostItem, dryRun: boolean): Promise<ResultEntry> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute(
    "style",
    `position:fixed;width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;left:0;top:0;border:0;opacity:0;pointer-events:none;z-index:-1`,
  );
  document.body.appendChild(frame);
  try {
    const loaded = waitForLoad(frame, 20000);
    frame.src = item.url;
    await loaded;

    const doc = frame.contentDocument;
    if (!doc || doc.URL === "about:blank") {
      return { id: item.id, outcome: "failed", detail: "video page could not be opened" };
    }

    // Wait only as long as needed for the page to render its controls.
    await waitFor(() => findRemoveButton(doc) || findShareButton(doc), 6000, 250);

    let button: HTMLElement | null = findRemoveButton(doc);
    let openedShare = false;
    if (!button) {
      const share = findShareButton(doc);
      if (share) {
        share.click();
        openedShare = true;
        button = await waitFor(() => findRemoveButton(doc), 3000, 200);
      }
    }

    if (button) {
      if (dryRun) {
        return { id: item.id, outcome: "dry-run", detail: "Remove repost control found" };
      }
      button.click();
      const gone = await waitFor(() => !findRemoveButton(doc), 4000, 200);
      if (!gone) {
        return { id: item.id, outcome: "failed", detail: "control still present after click" };
      }
      return { id: item.id, outcome: "removed" };
    }

    if (RATE_LIMIT.test(visibleText(doc))) {
      return { id: item.id, outcome: "failed", detail: RATE_LIMIT_DETAIL };
    }
    const where = openedShare ? "after opening Share" : "(no Share control found)";
    return {
      id: item.id,
      outcome: "skipped",
      detail: `no Remove repost control ${where}. Labels: ${relatedLabels(doc)}`,
    };
  } catch (err) {
    return { id: item.id, outcome: "failed", detail: err instanceof Error ? err.message : "unknown error" };
  } finally {
    frame.remove();
  }
}

async function runRemove(payload: RemovePayload, panel: Panel): Promise<void> {
  const items = payload.items.slice(0, MAX_BATCH);
  const results: ResultEntry[] = [];
  panel.title(payload.dryRun ? "Test run · nothing will be clicked" : "Removing reposts");

  let consecutiveFailures = 0;
  for (let i = 0; i < items.length; i++) {
    await waitIfPaused();
    if (stopRequested) break;

    const item = items[i];
    panel.status(`${i + 1} of ${items.length} · ${item.id}`);
    panel.progress(i / items.length);

    const result = await processItem(item, payload.dryRun);
    results.push(result);

    if (result.outcome === "failed") consecutiveFailures++;
    else consecutiveFailures = 0;

    if (result.detail === RATE_LIMIT_DETAIL) {
      panel.status("TikTok is limiting actions. Stopped. Try again later.");
      break;
    }
    if (consecutiveFailures >= 3) {
      panel.status("Stopped after 3 failures in a row.");
      break;
    }
    if (i < items.length - 1 && !stopRequested) await sleep(randomDelay());
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
  await deliver(
    panel,
    JSON.stringify(out),
    `Processed ${results.length}. Open the dashboard and tap Read clipboard.`,
  );
}

async function main(): Promise<void> {
  if (!TIKTOK_HOST.test(location.hostname)) {
    window.alert("Repost Cleaner only works on tiktok.com. Open your Reposts tab and tap the bookmark again.");
    return;
  }
  const text = await readBatchText();
  const payload = text ? parsePayload(text) : null;
  const panel = openPanel();
  if (payload && payload.kind === "remove") {
    await runRemove(payload, panel);
  } else {
    await runScan(panel);
  }
}

void main();
