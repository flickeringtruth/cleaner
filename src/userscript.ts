/**
 * Repost Cleaner — capture stage.
 *
 * Records outgoing requests made by tiktok.com so the endpoints behind
 * "list my reposts" and "remove a repost" can be identified from an iPhone.
 *
 * Privacy: only sanitized paths and parameter NAMES are stored. Query values,
 * request bodies, headers, cookies and tokens are never read or saved.
 *
 * Removal is intentionally NOT implemented yet: it needs endpoints that
 * have been observed in real captures, not guessed.
 */

const STORAGE_KEY = "rc.captures.v1";
const MAX_CAPTURES = 300;
const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;

interface Capture {
  time: string;
  method: string;
  path: string;
  paramNames: string[];
  bodyKeys: string[];
}

/**
 * Masks anything that could identify the account or carry a credential:
 * numeric IDs and long opaque segments become ":id".
 */
function sanitizePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (/^\d{3,}$/.test(seg) || /^[A-Za-z0-9_-]{16,}$/.test(seg) ? ":id" : seg))
    .join("/");
}

function loadCaptures(): Capture[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Capture[];
  } catch {
    return [];
  }
}

function saveCaptures(list: Capture[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_CAPTURES)));
  } catch {
    // Storage full or unavailable; capture is best-effort.
  }
}

/** Returns only the key names of a JSON body. Values are never read into storage. */
function describeBody(body: unknown): string[] {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object") return Object.keys(parsed);
    } catch {
      return [];
    }
  }
  if (body instanceof URLSearchParams || body instanceof FormData) {
    return Array.from(body.keys());
  }
  return [];
}

function record(method: string, rawUrl: string, body: unknown): void {
  let url: URL;
  try {
    url = new URL(rawUrl, location.href);
  } catch {
    return;
  }
  if (!TIKTOK_HOST.test(url.hostname)) return;

  const entry: Capture = {
    time: new Date().toISOString(),
    method: method.toUpperCase(),
    path: sanitizePath(url.pathname),
    paramNames: Array.from(new Set(url.searchParams.keys())),
    bodyKeys: describeBody(body),
  };
  const list = loadCaptures();
  list.push(entry);
  saveCaptures(list);
  refreshPanel();
}

function installHooks(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      record(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"), url, init?.body);
    } catch {
      // Never break the page's own requests.
    }
    return originalFetch(input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    (this as XMLHttpRequest & { __rcMethod?: string; __rcUrl?: string }).__rcMethod = method;
    (this as XMLHttpRequest & { __rcUrl?: string }).__rcUrl = String(url);
    return (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const self = this as XMLHttpRequest & { __rcMethod?: string; __rcUrl?: string };
    try {
      if (self.__rcUrl) record(self.__rcMethod ?? "GET", self.__rcUrl, body);
    } catch {
      // Ignore capture errors.
    }
    return originalSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
  };
}

let panelBody: HTMLElement | null = null;

function refreshPanel(): void {
  if (!panelBody) return;
  const list = loadCaptures();
  const counter = document.getElementById("rc-count");
  if (counter) counter.textContent = `${list.length} captured`;
  panelBody.replaceChildren(
    ...list
      .slice(-40)
      .reverse()
      .map((c) => {
        const row = document.createElement("div");
        row.className = "rc-row";
        const params = c.paramNames.length ? `?${c.paramNames.join(" ")}` : "";
        const body = c.bodyKeys.length ? ` body:{${c.bodyKeys.join(", ")}}` : "";
        row.textContent = `${c.method} ${c.path}${params}${body}`;
        return row;
      }),
  );
}

const STYLE = `
#rc-fab{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483647;
  width:52px;height:52px;border-radius:26px;border:1px solid #27272a;background:#18181b;color:#fafafa;
  font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#rc-panel{position:fixed;left:8px;right:8px;bottom:76px;max-height:60vh;z-index:2147483647;display:none;
  flex-direction:column;background:#09090b;color:#e4e4e7;border:1px solid #27272a;border-radius:16px;
  font:12px ui-monospace,Menlo,monospace;box-shadow:0 16px 48px rgba(0,0,0,.6)}
#rc-panel.open{display:flex}
#rc-head{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #27272a;
  font:600 13px -apple-system,system-ui,sans-serif}
#rc-head span{flex:1;color:#a1a1aa}
#rc-head button{background:#27272a;color:#fafafa;border:0;border-radius:8px;padding:6px 10px;font:600 12px system-ui}
#rc-body{overflow:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.rc-row{padding:6px 8px;border-radius:8px;background:#18181b;word-break:break-all}
`;

function buildPanel(): void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const fab = document.createElement("button");
  fab.id = "rc-fab";
  fab.textContent = "RC";

  const panel = document.createElement("div");
  panel.id = "rc-panel";
  panel.innerHTML = `
    <div id="rc-head">
      <span id="rc-count">0 captured</span>
      <button id="rc-copy">Copy</button>
      <button id="rc-clear">Clear</button>
    </div>
    <div id="rc-body"></div>`;

  document.body.append(fab, panel);
  panelBody = panel.querySelector("#rc-body");

  fab.addEventListener("click", () => {
    panel.classList.toggle("open");
    refreshPanel();
  });
  panel.querySelector("#rc-clear")?.addEventListener("click", () => {
    saveCaptures([]);
    refreshPanel();
  });
  panel.querySelector("#rc-copy")?.addEventListener("click", async () => {
    const text = JSON.stringify(loadCaptures(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy captures:", text);
    }
  });
  refreshPanel();
}

installHooks();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", buildPanel);
} else {
  buildPanel();
}
