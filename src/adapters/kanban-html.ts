export const KANBAN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet - board</title>
<style>
  :root {
    --bg: #0b0d11;
    --surface: #12161d;
    --surface-2: #181d26;
    --surface-hover: #1e2430;
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.16);
    --text: #eef1f6;
    --muted: #8b95a7;
    --dim: #5d6678;
    --amber: #f59e0b;
    --amber-bg: rgba(245, 158, 11, 0.12);
    --rose: #f43f5e;
    --rose-bg: rgba(244, 63, 94, 0.12);
    --emerald: #10b981;
    --emerald-bg: rgba(16, 185, 129, 0.12);
    --sky: #38bdf8;
    --sky-bg: rgba(56, 189, 248, 0.12);
    --violet: #a78bfa;
    --radius: 10px;
    --font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
  a { color: var(--sky); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button, input, select, textarea { font: inherit; color: inherit; }
  .app { min-height: 100vh; display: flex; flex-direction: column; }

  .topbar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    padding: 14px 24px;
    background: rgba(11, 13, 17, 0.88); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .brand-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .brand { font-weight: 700; font-size: 16px; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--emerald); box-shadow: 0 0 0 3px var(--emerald-bg); }
  .dot.offline { background: var(--rose); box-shadow: 0 0 0 3px var(--rose-bg); }
  .hosts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .host-pill {
    font-size: 12px; color: var(--muted); background: var(--surface);
    border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .host-pill b { color: var(--text); font-weight: 600; }
  .top-actions { display: flex; align-items: center; gap: 10px; }
  .search {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 11px; width: 210px; font-size: 13px; color: var(--text); outline: none;
  }
  .search:focus { border-color: var(--border-strong); }
  .btn {
    border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
    border-radius: 8px; padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer;
    transition: background 120ms, border-color 120ms;
  }
  .btn:hover { background: var(--surface-hover); }
  .btn-primary { background: #e8edf5; color: #0b0d11; border-color: #e8edf5; font-weight: 600; }
  .btn-primary:hover { background: #ffffff; }
  .btn-amber { background: var(--amber-bg); color: var(--amber); border-color: rgba(245, 158, 11, 0.35); }
  .btn-amber:hover { background: rgba(245, 158, 11, 0.2); }
  .btn-danger { background: var(--rose-bg); color: var(--rose); border-color: rgba(244, 63, 94, 0.35); }
  .btn-ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .btn-ghost:hover { color: var(--text); background: var(--surface); }

  .filters {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 12px 24px 0;
  }
  .pill {
    font-size: 12px; font-weight: 500; color: var(--muted);
    background: transparent; border: 1px solid var(--border); border-radius: 999px;
    padding: 4px 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  }
  .pill:hover { color: var(--text); border-color: var(--border-strong); }
  .pill.active { background: var(--text); color: #0b0d11; border-color: var(--text); font-weight: 600; }
  .pill .cnt { opacity: 0.7; font-size: 11px; }

  .board {
    flex: 1; display: grid; gap: 16px; padding: 16px 24px 32px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    align-items: start;
  }
  @media (max-width: 1180px) { .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 680px) { .board { grid-template-columns: 1fr; padding: 12px; } .topbar { padding: 12px; } .filters { padding: 10px 12px 0; } }

  .col {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 12px; min-width: 0; display: flex; flex-direction: column; gap: 10px;
  }
  .col-head {
    display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px;
    border-bottom: 1px solid var(--border);
  }
  .col-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; display: flex; align-items: center; gap: 8px; }
  .col-dot { width: 7px; height: 7px; border-radius: 999px; }
  .col-count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .col-empty { font-size: 12px; color: var(--dim); padding: 18px 8px; text-align: center; }

  .card {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 8px;
    transition: border-color 120ms, transform 120ms, background 120ms;
    min-width: 0;
  }
  .card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
  .card.blocked { border-left: 3px solid var(--amber); }
  .card.failed { border-left: 3px solid var(--rose); }
  .card.claimed { border-left: 3px solid var(--emerald); }
  .card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); }
  .card-domain { font-weight: 600; color: var(--sky); }
  .card-title { font-size: 14px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; line-height: 1.35; }
  .card-reason {
    font-size: 12px; color: #f7d794; background: var(--amber-bg);
    border-radius: 6px; padding: 7px 9px; overflow-wrap: anywhere; line-height: 1.4;
  }
  .card.failed .card-reason { color: #fda4af; background: var(--rose-bg); }
  .card-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .chip {
    font-size: 11px; padding: 2px 7px; border-radius: 6px;
    background: rgba(255, 255, 255, 0.05); color: var(--muted); border: 1px solid var(--border);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip.pr { color: var(--violet); border-color: rgba(167, 139, 250, 0.3); }

  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 40;
    display: none; justify-content: flex-end;
  }
  .backdrop.open { display: flex; }
  .drawer {
    width: min(640px, 100vw); height: 100vh; background: var(--surface);
    border-left: 1px solid var(--border-strong); display: flex; flex-direction: column;
  }
  .drawer-head {
    padding: 16px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  }
  .drawer-body { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; }
  .drawer-title { font-size: 18px; font-weight: 700; margin: 4px 0 0; overflow-wrap: anywhere; }
  .prose { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; color: #d6dde8; line-height: 1.55; }
  .block-box {
    background: var(--amber-bg); border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px;
  }
  .block-box strong { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--amber); }
  .thread-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); }
  .reply {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
  }
  .reply.internal { opacity: 0.65; border-style: dashed; }
  .reply-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
  .drawer-foot {
    border-top: 1px solid var(--border); padding: 14px 20px;
    background: var(--bg); display: flex; flex-direction: column; gap: 10px;
  }
  .textarea {
    width: 100%; background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: 8px; padding: 9px 11px; min-height: 68px; resize: vertical; outline: none;
  }
  .textarea:focus { border-color: var(--sky); }
  .foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); z-index: 50;
    display: none; align-items: center; justify-content: center; padding: 16px;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    width: min(520px, 100%); background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px;
  }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field label { font-size: 12px; color: var(--muted); font-weight: 500; }
  .field input, .field select, .field textarea {
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 10px; outline: none;
  }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand-row">
      <div class="brand"><span class="dot" id="live-dot"></span>fleet</div>
      <div class="hosts" id="hosts"></div>
    </div>
    <div class="top-actions">
      <input class="search" id="search" placeholder="Filter tasks..." oninput="renderBoard()">
      <button class="btn btn-primary" onclick="openNewModal()">+ New task</button>
      <a class="btn btn-ghost" href="/inspect" target="_blank" rel="noreferrer">Raw inspector</a>
    </div>
  </header>

  <nav class="filters" id="filters"></nav>

  <main class="board" id="board"></main>
</div>

<div class="backdrop" id="drawer-backdrop" onclick="if(event.target===this)closeDrawer()">
  <aside class="drawer">
    <div class="drawer-head">
      <div style="min-width:0">
        <div class="card-top" id="drawer-meta"></div>
        <h2 class="drawer-title" id="drawer-title"></h2>
      </div>
      <button class="btn btn-ghost" onclick="closeDrawer()">Close</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
    <div class="drawer-foot" id="drawer-foot"></div>
  </aside>
</div>

<div class="modal-backdrop" id="new-modal" onclick="if(event.target===this)closeNewModal()">
  <form class="modal" onsubmit="submitNewTask(event)">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:16px">New task</strong>
      <button type="button" class="btn btn-ghost" onclick="closeNewModal()">Close</button>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>Domain channel</label>
        <input id="nt-channel" value="domains/personal" list="channel-list" required>
        <datalist id="channel-list"></datalist>
      </div>
      <div class="field">
        <label>Host (optional)</label>
        <select id="nt-host"><option value="">None (mate handles)</option></select>
      </div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>Project (optional)</label>
        <input id="nt-project" placeholder="e.g. Cleo, fleet-v3" list="repo-list">
        <datalist id="repo-list"></datalist>
      </div>
      <div class="field">
        <label>Delivery</label>
        <select id="nt-delivery">
          <option value="no-mistakes">no-mistakes</option>
          <option value="direct-pr">direct-pr</option>
          <option value="local">local</option>
          <option value="ops">ops</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>Title / Intent</label>
      <input id="nt-title" placeholder="What outcome do you want?" required>
    </div>
    <div class="field">
      <label>Details / Spec (optional)</label>
      <textarea id="nt-body" rows="3" placeholder="Context, links, constraints..."></textarea>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button type="button" class="btn" onclick="closeNewModal()">Cancel</button>
      <button type="submit" class="btn btn-primary">Create task</button>
    </div>
  </form>
</div>

<script>
const API = "/api/board";
let allTasks = [];
let hosts = [];
let activeDomain = "all";
let openTaskId = null;
let showInternal = false;

const COLS = [
  { key: "needs", title: "Needs you", color: "var(--amber)", states: new Set(["blocked", "failed"]) },
  { key: "running", title: "Running", color: "var(--emerald)", states: new Set(["claimed"]) },
  { key: "queued", title: "Queued", color: "var(--sky)", states: new Set(["ready", "waiting"]) },
  { key: "done", title: "Done", color: "var(--dim)", states: new Set(["completed"]) },
];

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function linkify(s) {
  return esc(s).replace(/(https?:\\/\\/[^\\s<)"']+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

function domainOf(ch) {
  return ch.startsWith("domains/") ? ch.slice("domains/".length) : ch;
}

function ago(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function firstLine(text) {
  const line = String(text || "").split("\\n").map(x => x.trim()).find(Boolean) || "";
  return line;
}

function extractPr(text, labels) {
  if (labels && labels.pr) return labels.pr;
  const m = String(text || "").match(/https:\\/\\/github\\.com\\/[^\\s)]+\\/pull\\/\\d+/);
  return m ? m[0] : "";
}

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function parseHosts(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (m.labels?.kind !== "host") continue;
    const h = m.labels?.host;
    if (!h) continue;
    const mode = (/\\bmode=(\\S+)/.exec(m.text) || [])[1] || "local";
    const reposRaw = (/\\brepos=(.+)$/.exec(m.text) || [])[1] || "";
    const repos = reposRaw.split(",").map(r => r.trim()).filter(Boolean);
    map.set(h, { host: h, mode, repos });
  }
  return [...map.values()].sort((a, b) => a.host.localeCompare(b.host));
}

async function refresh() {
  try {
    const [taskPage, metaPage] = await Promise.all([
      api("/tasks?state=all&limit=100"),
      api("/messages?channel=meta&limit=50").catch(() => ({ messages: [] })),
    ]);
    allTasks = (taskPage.tasks || []).filter(t => t.message?.task?.state !== "canceled");
    hosts = parseHosts(metaPage.messages || []);
    document.getElementById("live-dot").classList.remove("offline");
    renderHosts();
    renderFilters();
    renderBoard();
    if (openTaskId) await loadDrawer(openTaskId);
  } catch (err) {
    document.getElementById("live-dot").classList.add("offline");
  }
}

function renderHosts() {
  const el = document.getElementById("hosts");
  el.innerHTML = hosts.map(h =>
    '<span class="host-pill"><b>' + esc(h.host) + '</b> ' + h.repos.length + ' repos</span>'
  ).join("");
  const hostSel = document.getElementById("nt-host");
  const prev = hostSel.value;
  hostSel.innerHTML = '<option value="">None (mate handles)</option>' +
    hosts.map(h => '<option value="' + esc(h.host) + '">' + esc(h.host) + ' (' + esc(h.mode) + ')</option>').join("");
  hostSel.value = prev;
  const repoSet = new Set();
  for (const h of hosts) for (const r of h.repos) repoSet.add(r);
  document.getElementById("repo-list").innerHTML = [...repoSet].sort().map(r => '<option value="' + esc(r) + '">').join("");
}

function renderFilters() {
  const counts = new Map();
  const channels = new Set();
  for (const item of allTasks) {
    const ch = item.message.channel;
    channels.add(ch);
    const d = domainOf(ch);
    const open = item.message.task?.state !== "completed";
    counts.set(d, (counts.get(d) || 0) + (open ? 1 : 0));
  }
  document.getElementById("channel-list").innerHTML = [...channels].sort().map(c => '<option value="' + esc(c) + '">').join("");
  const domains = [...counts.keys()].sort();
  const totalOpen = allTasks.filter(t => t.message.task?.state !== "completed").length;
  const pills = ['<button class="pill ' + (activeDomain === "all" ? "active" : "") + '" onclick="setDomain(\\'all\\')">All <span class="cnt">' + totalOpen + '</span></button>'];
  for (const d of domains) {
    pills.push('<button class="pill ' + (activeDomain === d ? "active" : "") + '" onclick="setDomain(\\'' + esc(d) + '\\')">' + esc(d) + ' <span class="cnt">' + counts.get(d) + '</span></button>');
  }
  document.getElementById("filters").innerHTML = pills.join("");
}

function setDomain(d) {
  activeDomain = d;
  renderFilters();
  renderBoard();
}

function renderBoard() {
  const q = (document.getElementById("search").value || "").trim().toLowerCase();
  const filtered = allTasks.filter(item => {
    const m = item.message;
    if (activeDomain !== "all" && domainOf(m.channel) !== activeDomain) return false;
    if (q && !(m.text + " " + m.channel + " " + JSON.stringify(m.labels || {})).toLowerCase().includes(q)) return false;
    return true;
  });

  const boardEl = document.getElementById("board");
  boardEl.innerHTML = COLS.map(col => {
    const items = filtered.filter(item => col.states.has(item.message.task?.state));
    const sorted = col.key === "done" ? items.slice().reverse().slice(0, 20) : items;
    const cards = sorted.length === 0
      ? '<div class="col-empty">Nothing here</div>'
      : sorted.map(renderCard).join("");
    return '<section class="col">' +
      '<div class="col-head"><span class="col-title"><span class="col-dot" style="background:' + col.color + '"></span>' + col.title + '</span><span class="col-count">' + items.length + '</span></div>' +
      cards +
      '</section>';
  }).join("");
}

function renderCard(item) {
  const m = item.message;
  const t = m.task || {};
  const state = t.state || "ready";
  const reason = (state === "blocked" || state === "failed") && t.result ? '<div class="card-reason">' + esc(t.result) + '</div>' : "";
  const pr = extractPr(m.text + " " + (t.result || ""), m.labels);
  const chips = [];
  if (m.labels?.project) chips.push('<span class="chip">' + esc(m.labels.project) + '</span>');
  if (m.labels?.host) chips.push('<span class="chip">' + esc(m.labels.host) + '</span>');
  if (m.labels?.delivery) chips.push('<span class="chip">' + esc(m.labels.delivery) + '</span>');
  if (t.by && state === "claimed") chips.push('<span class="chip">' + esc(t.by) + '</span>');
  if (pr) chips.push('<span class="chip pr">PR #' + pr.split("/").pop() + '</span>');
  if (item.replies > 0) chips.push('<span class="chip">' + item.replies + ' replies</span>');

  return '<article class="card ' + esc(state) + '" onclick="openDrawer(\\'' + esc(m.id) + '\\')">' +
    '<div class="card-top"><span class="card-domain">' + esc(domainOf(m.channel)) + '</span><span>#' + esc(m.id) + ' · ' + ago(m.createdAt) + '</span></div>' +
    '<div class="card-title">' + esc(firstLine(m.text)) + '</div>' +
    reason +
    (chips.length ? '<div class="card-meta">' + chips.join("") + '</div>' : "") +
    '</article>';
}

async function openDrawer(id) {
  openTaskId = id;
  document.getElementById("drawer-backdrop").classList.add("open");
  await loadDrawer(id);
}

function closeDrawer() {
  openTaskId = null;
  document.getElementById("drawer-backdrop").classList.remove("open");
}

async function loadDrawer(id) {
  const data = await api("/messages/" + encodeURIComponent(id) + "?limit=100");
  const m = data.message;
  const t = m.task || {};
  const state = t.state || "ready";
  document.getElementById("drawer-meta").innerHTML =
    '<span class="card-domain">' + esc(domainOf(m.channel)) + '</span>' +
    '<span>#' + esc(m.id) + ' · ' + esc(state) + ' · ' + ago(m.createdAt) + '</span>';
  document.getElementById("drawer-title").textContent = firstLine(m.text);

  const restBody = m.text.split("\\n").slice(1).join("\\n").trim();
  const visibleReplies = (data.replies || []).filter(r => showInternal || !r.noSync);
  const hiddenCount = (data.replies || []).length - visibleReplies.length;
  const bodyParts = [];

  if (state === "blocked" || state === "failed") {
    bodyParts.push('<div class="block-box"><strong>' + (state === "blocked" ? "Needs your decision" : "Failed") + '</strong><div class="prose">' + linkify(t.result || "Waiting on input.") + '</div></div>');
  } else if (state === "completed" && t.result) {
    bodyParts.push('<div class="block-box" style="background:var(--emerald-bg);border-color:rgba(16,185,129,0.35)"><strong style="color:var(--emerald)">Completed</strong><div class="prose">' + linkify(t.result) + '</div></div>');
  }

  if (restBody) bodyParts.push('<div class="prose">' + linkify(restBody) + '</div>');

  const labelEntries = Object.entries(m.labels || {}).filter(([k]) => !k.startsWith("board."));
  if (labelEntries.length) {
    bodyParts.push('<div class="card-meta">' + labelEntries.map(([k, v]) => '<span class="chip">' + esc(k) + '=' + esc(v) + '</span>').join("") + '</div>');
  }

  bodyParts.push(
    '<div class="thread-head"><span>Thread (' + visibleReplies.length + ')</span>' +
    (hiddenCount > 0 || showInternal ? '<button class="btn btn-ghost" style="padding:2px 8px;font-size:11px" onclick="toggleInternal()">' + (showInternal ? "Hide internal" : "Show " + hiddenCount + " internal") + '</button>' : "") +
    '</div>'
  );

  if (visibleReplies.length === 0) {
    bodyParts.push('<div class="col-empty">No replies yet</div>');
  } else {
    for (const r of visibleReplies) {
      bodyParts.push(
        '<div class="reply ' + (r.noSync ? "internal" : "") + '">' +
        '<div class="reply-meta"><strong>' + esc(r.by?.actor || "agent") + (r.noSync ? " · internal" : "") + '</strong><span>' + ago(r.createdAt) + '</span></div>' +
        '<div class="prose">' + linkify(r.text) + '</div>' +
        '</div>'
      );
    }
  }
  document.getElementById("drawer-body").innerHTML = bodyParts.join("");

  const foot = document.getElementById("drawer-foot");
  foot.innerHTML =
    '<textarea class="textarea" id="reply-box" placeholder="' + (state === "blocked" ? "Type your answer to unblock..." : "Reply to thread...") + '"></textarea>' +
    '<div class="foot-row">' +
      '<div style="display:flex;gap:8px">' +
        (state !== "completed" && state !== "canceled" ? '<button class="btn btn-danger" onclick="cancelTask(\\'' + esc(m.id) + '\\')">Cancel task</button>' : "") +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn" onclick="sendReply(\\'' + esc(m.id) + '\\', false)">Reply</button>' +
        (state === "blocked" ? '<button class="btn btn-amber" onclick="sendReply(\\'' + esc(m.id) + '\\', true)">Reply &amp; unblock</button>' : "") +
      '</div>' +
    '</div>';
}

function toggleInternal() {
  showInternal = !showInternal;
  if (openTaskId) loadDrawer(openTaskId);
}

async function sendReply(id, unblock) {
  const box = document.getElementById("reply-box");
  const text = (box.value || "").trim();
  if (text) {
    await api("/messages", { method: "POST", body: JSON.stringify({ re: id, text }) });
  }
  if (unblock) {
    await api("/tasks/" + encodeURIComponent(id) + "/unblock", { method: "POST", body: JSON.stringify({}) });
  }
  box.value = "";
  await refresh();
}

async function cancelTask(id) {
  const reason = (document.getElementById("reply-box").value || "").trim() || "Canceled from board";
  await api("/tasks/" + encodeURIComponent(id) + "/cancel", { method: "POST", body: JSON.stringify({ reason }) });
  closeDrawer();
  await refresh();
}

function openNewModal() { document.getElementById("new-modal").classList.add("open"); }
function closeNewModal() { document.getElementById("new-modal").classList.remove("open"); }

async function submitNewTask(e) {
  e.preventDefault();
  const channel = document.getElementById("nt-channel").value.trim();
  const title = document.getElementById("nt-title").value.trim();
  const body = document.getElementById("nt-body").value.trim();
  const host = document.getElementById("nt-host").value.trim();
  const project = document.getElementById("nt-project").value.trim();
  const delivery = document.getElementById("nt-delivery").value.trim();
  const labels = {};
  if (host) labels.host = host;
  if (project) labels.project = project;
  if (delivery) labels.delivery = delivery;
  await api("/tasks", {
    method: "POST",
    body: JSON.stringify({
      channel,
      text: body ? title + "\\n\\n" + body : title,
      ...(Object.keys(labels).length ? { labels } : {}),
    }),
  });
  document.getElementById("nt-title").value = "";
  document.getElementById("nt-body").value = "";
  closeNewModal();
  await refresh();
}

function connectEvents() {
  const es = new EventSource(API + "/events");
  es.addEventListener("board", () => refresh());
  es.onerror = () => {
    document.getElementById("live-dot").classList.add("offline");
    setTimeout(() => { es.close(); connectEvents(); }, 4000);
  };
  es.onopen = () => document.getElementById("live-dot").classList.remove("offline");
}

refresh();
connectEvents();
setInterval(refresh, 15000);
</script>
</body>
</html>
`;
