import "./styles.css";
import {
  APP_TAG,
  MAX_BATCH,
  PROTOCOL_VERSION,
  parsePayload,
  type RemovePayload,
  type RepostItem,
  type ResultEntry,
  type ResultPayload,
} from "../shared/protocol";
import { emptyLibrary, loadLibrary, saveLibrary, type Library, type LibraryItem, type Status } from "./state";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app element");

let lib: Library = loadLibrary();
let filter = "";
let toastMsg = "";
let toastTimer: number | undefined;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
const now = (): string => new Date().toISOString();
const persist = (): void => saveLibrary(lib);
const actionable = (i: LibraryItem): boolean => i.status === "pending" || i.status === "failed";
const countStatus = (s: Status): number => lib.items.filter((i) => i.status === s).length;

const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  removed: "Removed",
  failed: "Failed",
  skipped: "Skipped",
};

function visibleItems(): LibraryItem[] {
  const q = filter.trim().toLowerCase();
  if (!q) return lib.items;
  return lib.items.filter((i) => i.id.includes(q) || (i.author ?? "").toLowerCase().includes(q));
}

function toast(msg: string): void {
  toastMsg = msg;
  render();
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMsg = "";
    render();
  }, 4500);
}

/** Reads the clipboard. Falls back to a prompt when the browser blocks clipboard access. */
async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return window.prompt("Paste the text here:");
  }
}

/** Writes to the clipboard. If blocked, shows the text so it can be copied by hand. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Copy this text:", text);
    return false;
  }
}

function mergeScan(items: RepostItem[]): number {
  const known = new Set(lib.items.map((i) => i.id));
  let added = 0;
  for (const it of items) {
    if (known.has(it.id)) continue;
    known.add(it.id);
    lib.items.push({ id: it.id, url: it.url, author: it.author, status: "pending", updatedAt: now() });
    added++;
  }
  persist();
  return added;
}

function applyResults(payload: ResultPayload): number {
  const byId = new Map(lib.items.map((i) => [i.id, i] as const));
  let touched = 0;
  for (const r of payload.results as ResultEntry[]) {
    const item = byId.get(r.id);
    if (!item) continue;
    touched++;
    item.updatedAt = now();
    if (r.outcome === "dry-run") {
      item.detail = `Test passed: ${r.detail ?? "control found"}`;
      continue;
    }
    item.status = r.outcome === "removed" ? "removed" : r.outcome === "failed" ? "failed" : "skipped";
    item.detail = r.detail;
  }
  lib.selected = [];
  persist();
  return touched;
}

async function importClipboard(): Promise<void> {
  const text = await readClipboard();
  if (!text || !text.trim()) return toast("Nothing to import.");
  const payload = parsePayload(text.trim());
  if (!payload) return toast("That text isn't from Repost Cleaner.");
  if (payload.kind === "scan") {
    const added = mergeScan(payload.items);
    return toast(`Imported ${payload.items.length} reposts · ${added} new`);
  }
  if (payload.kind === "result") {
    const n = applyResults(payload);
    return toast(`Applied ${n} results${payload.dryRun ? " (test run, nothing removed)" : ""}`);
  }
  return toast("That's a batch for TikTok, not a list to import.");
}

function selectNext(): void {
  lib.selected = lib.items.filter(actionable).slice(0, lib.batchSize).map((i) => i.id);
  persist();
  toast(`Selected ${lib.selected.length} for the next batch`);
}

function selectAllVisible(): void {
  lib.selected = visibleItems().filter(actionable).map((i) => i.id);
  persist();
  render();
}

function clearSelection(): void {
  lib.selected = [];
  persist();
  render();
}

function toggleSelect(id: string, checked: boolean): void {
  const set = new Set(lib.selected);
  if (checked) set.add(id);
  else set.delete(id);
  lib.selected = [...set];
  persist();
  renderStatsAndControls();
}

async function copyBatch(): Promise<void> {
  const byId = new Map(lib.items.map((i) => [i.id, i] as const));
  const limit = Math.min(lib.batchSize, MAX_BATCH);
  const batch = lib.selected
    .map((id) => byId.get(id))
    .filter((i): i is LibraryItem => !!i && actionable(i))
    .slice(0, limit);
  if (batch.length === 0) return toast("Select some reposts first.");

  const payload: RemovePayload = {
    app: APP_TAG,
    v: PROTOCOL_VERSION,
    kind: "remove",
    createdAt: now(),
    dryRun: lib.dryRun,
    items: batch.map((i) => ({ id: i.id, url: i.url, author: i.author })),
  };
  const ok = await writeClipboard(JSON.stringify(payload));
  toast(
    ok
      ? `Copied ${batch.length}. Open your Reposts tab on TikTok and tap the bookmark.`
      : `Copy the text from the prompt, then open your Reposts tab on TikTok.`,
  );
}

async function copySetupLink(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}bookmarklet.js`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const code = (await res.text()).trim();
    const url = `javascript:${encodeURIComponent(`(function(){${code}})();void 0;`)}`;
    const ok = await writeClipboard(url);
    toast(ok ? "Setup link copied. Paste it as a bookmark URL in Safari." : "Copy the setup link from the prompt.");
  } catch {
    toast("Bookmark file not found. Make sure the site has been deployed.");
  }
}

function exportCsv(): void {
  const rows: string[][] = [
    ["id", "author", "status", "detail", "updatedAt"],
    ...lib.items.map((i) => [i.id, i.author ?? "", i.status, i.detail ?? "", i.updatedAt]),
  ];
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "repost-cleaner.csv";
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetLibrary(): void {
  if (!window.confirm("Clear the whole library on this device? This cannot be undone.")) return;
  lib = emptyLibrary();
  persist();
  render();
}

function setBatchSize(n: number): void {
  lib.batchSize = Math.min(Math.max(1, n), MAX_BATCH);
  persist();
  render();
}

function itemRow(i: LibraryItem): string {
  const checked = lib.selected.includes(i.id) ? "checked" : "";
  const disabled = actionable(i) ? "" : "disabled";
  const detail = i.detail ? ` · ${esc(i.detail)}` : "";
  return `
    <label class="item">
      <input type="checkbox" data-id="${esc(i.id)}" ${checked} ${disabled} />
      <div class="meta">
        <b>${i.author ? `@${esc(i.author)}` : "Unknown creator"}</b>
        <small>${esc(i.id)}${detail}</small>
      </div>
      <span class="badge ${i.status}">${STATUS_LABEL[i.status]}</span>
    </label>`;
}

function listHtml(): string {
  const items = visibleItems();
  if (lib.items.length === 0) {
    return `<p class="empty">No reposts yet. Open your Reposts tab on TikTok, tap the bookmark, then come back and tap Read clipboard.</p>`;
  }
  if (items.length === 0) return `<p class="empty">Nothing matches that search.</p>`;
  const shown = items.slice(0, 500).map(itemRow).join("");
  const more = items.length > 500 ? `<p class="hint">Showing 500 of ${items.length}. Narrow your search to see more.</p>` : "";
  return shown + more;
}

function statsHtml(): string {
  const total = lib.items.length;
  const removed = countStatus("removed");
  const pct = total ? Math.round((removed / total) * 100) : 0;
  return `
    <section class="stats">
      <div class="stat"><b>${total}</b><span>Total</span></div>
      <div class="stat"><b>${countStatus("pending")}</b><span>Pending</span></div>
      <div class="stat"><b>${removed}</b><span>Removed</span></div>
      <div class="stat"><b>${countStatus("failed")}</b><span>Failed</span></div>
    </section>
    <div class="card">
      <div class="row" style="justify-content:space-between"><span>Progress</span><span>${pct}%</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
}

function controlsHtml(): string {
  const sizes = [5, 10, 25]
    .map((n) => `<button data-action="batch" data-size="${n}" aria-pressed="${lib.batchSize === n}">${n}</button>`)
    .join("");
  return `
    <div class="card">
      <div class="row">
        <button class="primary" data-action="import">Read clipboard</button>
      </div>
      <p class="hint">Copy the list from the bookmark on TikTok, then tap Read clipboard. Results from a batch are read the same way.</p>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <b>Next batch</b>
        <div class="row seg">${sizes}</div>
      </div>
      <label class="row toggle">
        <input id="dry" type="checkbox" ${lib.dryRun ? "checked" : ""} />
        Test mode: find the button, don't click it
      </label>
      <div class="row">
        <button data-action="select-next">Select next ${lib.batchSize}</button>
        <button data-action="clear">Clear selection</button>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" data-action="copy-batch">Copy batch to clipboard</button>
      </div>
      <p class="hint">${lib.selected.length} selected. ${
        lib.dryRun
          ? "Test mode is on: nothing will be removed. Run one batch first to confirm the button is found."
          : "Test mode is off: the bookmark will remove these reposts."
      }</p>
    </div>`;
}

function listCardHtml(): string {
  return `
    <div class="card">
      <input id="filter" type="search" placeholder="Search by id or creator" value="${esc(filter)}" />
      <div class="row" style="margin:10px 0">
        <button data-action="select-all">Select all shown</button>
      </div>
      <div id="list">${listHtml()}</div>
    </div>`;
}

const footerHtml = `
  <div class="card">
    <div class="row">
      <button data-action="copy-setup">Copy setup bookmark</button>
      <button data-action="export">Export CSV</button>
      <button data-action="reset">Reset library</button>
    </div>
    <p class="hint">One-time setup: in Safari, add a bookmark named Repost Cleaner, then paste the copied setup link as its URL.</p>
  </div>`;

function renderStatsAndControls(): void {
  const stats = root!.querySelector(".stats")?.parentElement;
  render();
  void stats;
}

function renderList(): void {
  const list = document.getElementById("list");
  if (list) list.innerHTML = listHtml();
}

function render(): void {
  root!.innerHTML = `
    <div class="wrap">
      <header>
        <h1>Repost Cleaner</h1>
        <p class="sub">Clear your TikTok reposts in small batches. Everything stays on this device.</p>
      </header>
      ${statsHtml()}
      ${controlsHtml()}
      ${listCardHtml()}
      ${footerHtml}
    </div>
    ${toastMsg ? `<div class="toast" role="status">${esc(toastMsg)}</div>` : ""}`;
}

root.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el) return;
  switch (el.dataset.action) {
    case "import":
      void importClipboard();
      break;
    case "select-next":
      selectNext();
      break;
    case "select-all":
      selectAllVisible();
      break;
    case "clear":
      clearSelection();
      break;
    case "copy-batch":
      void copyBatch();
      break;
    case "batch":
      setBatchSize(Number(el.dataset.size));
      break;
    case "copy-setup":
      void copySetupLink();
      break;
    case "export":
      exportCsv();
      break;
    case "reset":
      resetLibrary();
      break;
  }
});

root.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.id) {
    toggleSelect(t.dataset.id, t.checked);
  } else if (t.id === "dry") {
    lib.dryRun = t.checked;
    persist();
    render();
  }
});

root.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "filter") {
    filter = t.value;
    renderList();
  }
});

render();
