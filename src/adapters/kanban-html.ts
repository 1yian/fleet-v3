export const KANBAN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet - cards</title>
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
    grid-template-columns: repeat(5, minmax(0, 1fr));
    align-items: start;
  }
  @media (max-width: 1360px) { .board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 820px) { .board { grid-template-columns: 1fr; padding: 12px; } .topbar { padding: 12px; } .filters { padding: 10px 12px 0; } }

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
    transition: border-color 120ms, background 120ms;
    min-width: 0;
  }
  .card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
  .card.captain { border-left: 3px solid var(--amber); }
  .card.held { border-left: 3px solid var(--violet); }
  .card.running { border-left: 3px solid var(--emerald); }
  .card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); }
  .card-domain { font-weight: 600; color: var(--sky); }
  .card-title { font-size: 14px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; line-height: 1.35; }
  .card-reason {
    font-size: 12px; color: #f7d794; background: var(--amber-bg);
    border-radius: 6px; padding: 7px 9px; overflow-wrap: anywhere; line-height: 1.4;
  }
  .card-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .chip {
    font-size: 11px; padding: 2px 7px; border-radius: 6px;
    background: rgba(255, 255, 255, 0.05); color: var(--muted); border: 1px solid var(--border);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip.waiting { color: var(--amber); border-color: rgba(245, 158, 11, 0.35); background: var(--amber-bg); }
  .card.waiting { border-left: 3px dashed var(--dim); }
  .notice { position: fixed; top: 12px; right: 12px; z-index: 60; max-width: min(420px, calc(100vw - 24px)); background: var(--rose-bg); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.45); border-radius: 10px; padding: 10px 14px; font-size: 13px; overflow-wrap: anywhere; backdrop-filter: blur(12px); }
  .notice[hidden] { display: none; }
  .chip.holder { color: var(--violet); border-color: rgba(167, 139, 250, 0.3); }

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
<div class="notice" id="notice" role="alert" hidden></div>
<div class="app">
  <header class="topbar">
    <div class="brand-row">
      <div class="brand"><span class="dot" id="live-dot"></span>fleet</div>
      <div class="hosts" id="hosts"></div>
    </div>
    <div class="top-actions">
      <input class="search" id="search" placeholder="Filter cards...">
      <button class="btn btn-primary" id="open-new">+ New card</button>
    </div>
  </header>

  <nav class="filters" id="filters"></nav>
  <main class="board" id="board"></main>
</div>

<div class="backdrop" id="drawer-backdrop">
  <aside class="drawer">
    <div class="drawer-head">
      <div style="min-width:0">
        <div class="card-top" id="drawer-meta"></div>
        <h2 class="drawer-title" id="drawer-title"></h2>
      </div>
      <button class="btn btn-ghost" data-action="close-drawer">Close</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
    <div class="drawer-foot" id="drawer-foot"></div>
  </aside>
</div>

<div class="modal-backdrop" id="new-modal">
  <form class="modal" id="new-form">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:16px">New card</strong>
      <button type="button" class="btn btn-ghost" data-action="close-new">Close</button>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>Mate</label>
        <input id="nc-mate" placeholder="home mate name" list="mate-list" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*" required>
        <datalist id="mate-list"></datalist>
      </div>
      <div class="field">
        <label>Host (optional)</label>
        <select id="nc-host"><option value="">None (mate handles)</option></select>
      </div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>Project (optional)</label>
        <input id="nc-project" placeholder="e.g. Cleo, fleet-v3" list="repo-list">
        <datalist id="repo-list"></datalist>
      </div>
      <div class="field">
        <label>Delivery</label>
        <select id="nc-delivery">
          <option value="no-mistakes">no-mistakes</option>
          <option value="direct-pr">direct-pr</option>
          <option value="local">local</option>
          <option value="ops">ops</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>Title / Intent</label>
      <input id="nc-title" placeholder="What outcome do you want?" required>
    </div>
    <div class="field">
      <label>Details / Spec (optional)</label>
      <textarea id="nc-body" rows="3" placeholder="Context, links, constraints..."></textarea>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button type="button" class="btn" data-action="close-new">Cancel</button>
      <button type="submit" class="btn btn-primary">Create card</button>
    </div>
  </form>
</div>

<script>
const API = "/api";
let allCards = [];
let hosts = [];
let parents = {};
let activeMate = null;
let openCardId = null;
let showInternal = false;
let footKey = "";
let refreshSeq = 0;
let drawerSeq = 0;

const COLS = [
  { key: "captain", title: "Needs you", color: "var(--amber)", match: c => c.state === "held" && c.holder === "captain" },
  { key: "held", title: "With mates", color: "var(--violet)", match: c => c.state === "held" && c.holder !== "captain" },
  { key: "running", title: "Running", color: "var(--emerald)", match: c => c.state === "running" },
  { key: "queued", title: "Queued / waiting", color: "var(--sky)", match: c => c.state === "queued" || c.state === "waiting" },
  { key: "done", title: "Done", color: "var(--dim)", match: c => c.state === "done" },
];

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function linkify(s) {
  return esc(s).replace(/(https?:\\/\\/[^\\s<)"']+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).message || text; } catch {}
    throw new Error(message || "Request failed (" + res.status + ")");
  }
  return res.json();
}

function post(path, payload) {
  return api(path, { method: "POST", body: JSON.stringify(payload) });
}

async function refresh() {
  const seq = ++refreshSeq;
  try {
    const [overview, mates] = await Promise.all([api("/overview"), api("/mates")]);
    if (seq !== refreshSeq) return;
    allCards = overview.cards.concat(overview.recentDone);
    hosts = overview.hosts || [];
    parents = mates.parents || {};
    $("live-dot").classList.remove("offline");
    renderHosts();
    renderFilters();
    renderBoard();
    if (openCardId) await loadDrawer(openCardId);
  } catch {
    $("live-dot").classList.add("offline");
  }
}

function renderHosts() {
  $("hosts").innerHTML = hosts.map(h =>
    '<span class="host-pill"><b>' + esc(h.host) + '</b> ' + esc(h.mode) + ' · ' + h.repos.length + ' repos</span>'
  ).join("");
  const hostSel = $("nc-host");
  const current = hostSel.value;
  hostSel.innerHTML = '<option value="">None (mate handles)</option>' +
    hosts.map(h => '<option value="' + esc(h.host) + '">' + esc(h.host) + '</option>').join("");
  hostSel.value = current;
  const repoSet = new Set();
  for (const h of hosts) for (const r of h.repos) repoSet.add(r);
  $("repo-list").innerHTML = [...repoSet].sort().map(r => '<option value="' + esc(r) + '"></option>').join("");
}

function renderFilters() {
  const counts = new Map();
  for (const name of Object.keys(parents)) counts.set(name, 0);
  for (const c of allCards) {
    if (c.state === "done" || c.state === "canceled") continue;
    counts.set(c.mate, (counts.get(c.mate) || 0) + 1);
  }
  const mates = [...counts.keys()].sort();
  $("mate-list").innerHTML = mates.map(m => '<option value="' + esc(m) + '"></option>').join("");
  const totalOpen = allCards.filter(c => c.state !== "done" && c.state !== "canceled").length;
  const pills = ['<button class="pill ' + (activeMate === null ? "active" : "") + '" data-action="set-mate">All <span class="cnt">' + totalOpen + '</span></button>'];
  for (const m of mates) {
    pills.push('<button class="pill ' + (activeMate === m ? "active" : "") + '" data-action="set-mate" data-mate="' + esc(m) + '">' + esc(m) + ' <span class="cnt">' + counts.get(m) + '</span></button>');
  }
  $("filters").innerHTML = pills.join("");
}

function renderBoard() {
  const q = $("search").value.trim().toLowerCase();
  const visible = allCards.filter(c => {
    if (c.state === "canceled") return false;
    if (activeMate !== null && c.mate !== activeMate) return false;
    if (!q) return true;
    return (c.title + " " + c.body + " " + c.mate + " " + c.holder + " " + (c.project || "") + " #" + c.id).toLowerCase().includes(q);
  });

  $("board").innerHTML = COLS.map(col => {
    const items = visible.filter(col.match);
    const cardsHtml = items.length === 0
      ? '<div class="col-empty">Nothing here</div>'
      : items.map(c => {
          const cls = c.holder === "captain" ? "captain" : c.state;
          const chips = [];
          if (c.state === "waiting") chips.push('<span class="chip waiting">Waiting</span>');
          if (c.state === "held" && c.snoozeUntil && c.snoozeUntil > Date.now()) {
            const remMin = Math.max(1, Math.ceil((c.snoozeUntil - Date.now()) / 60000));
            chips.push('<span class="chip waiting">snoozed ' + remMin + 'm</span>');
          }
          if (c.holder) chips.push('<span class="chip holder">ball: ' + esc(c.holder) + '</span>');
          if (c.project) chips.push('<span class="chip">' + esc(c.project) + '</span>');
          if (c.host) chips.push('<span class="chip">' + esc(c.host) + '</span>');
          if (c.delivery) chips.push('<span class="chip">' + esc(c.delivery) + '</span>');
          const reasonHtml = c.state === "held" && c.result
            ? '<div class="card-reason">' + esc(c.result.slice(0, 180)) + '</div>'
            : "";
          return '<article class="card ' + esc(cls) + '" data-action="open-card" data-id="' + esc(c.id) + '">'
            + '<div class="card-top"><span class="card-domain">' + esc(c.mate) + '</span><span>#' + esc(c.id) + ' · ' + ago(c.updatedAt) + '</span></div>'
            + '<div class="card-title">' + esc(c.title) + '</div>'
            + reasonHtml
            + (chips.length ? '<div class="card-meta">' + chips.join("") + '</div>' : "")
            + '</article>';
        }).join("");
    return '<section class="col"><div class="col-head"><div class="col-title"><span class="col-dot" style="background:' + col.color + '"></span>' + col.title + '</div><span class="col-count">' + items.length + '</span></div>' + cardsHtml + '</section>';
  }).join("");
}

async function openDrawer(id) {
  openCardId = id;
  footKey = "";
  $("drawer-meta").innerHTML = "";
  $("drawer-title").textContent = "";
  $("drawer-body").innerHTML = "";
  $("drawer-foot").innerHTML = '<div style="color:var(--muted);font-size:12px">Loading...</div>';
  $("drawer-backdrop").classList.add("open");
  await loadDrawer(id);
}

function closeDrawer() {
  openCardId = null;
  footKey = "";
  $("drawer-backdrop").classList.remove("open");
}

async function loadDrawer(id) {
  const seq = ++drawerSeq;
  const { card, entries } = await api("/cards/" + encodeURIComponent(id));
  if (openCardId !== id || seq !== drawerSeq) return;
  $("drawer-meta").innerHTML =
    '<span class="card-domain">' + esc(card.mate) + '</span>'
    + '<span>#' + esc(card.id) + ' · ' + esc(card.state) + (card.holder ? ' · ball: ' + esc(card.holder) : '') + '</span>';
  $("drawer-title").textContent = card.title;

  const shownEntries = entries.filter(e => showInternal || !e.internal);
  const parts = [];
  if (card.state === "held" && card.result) {
    parts.push('<div class="block-box"><strong>Ball with ' + esc(card.holder) + '</strong><div class="prose">' + linkify(card.result) + '</div></div>');
  }
  if (card.body) {
    parts.push('<div class="prose">' + linkify(card.body) + '</div>');
  }
  parts.push(
    '<div class="thread-head"><span>Thread (' + shownEntries.length + '/' + entries.length + ')</span>'
    + '<button class="btn btn-ghost" style="padding:2px 8px;font-size:12px" data-action="toggle-internal">' + (showInternal ? "Hide internal" : "Show internal") + '</button></div>'
  );
  parts.push(shownEntries.map(e =>
    '<div class="reply ' + (e.internal ? "internal" : "") + '">'
    + '<div class="reply-meta"><span><b>' + esc(e.by) + '</b> · ' + esc(e.kind) + '</span><span>' + ago(e.createdAt) + '</span></div>'
    + '<div class="prose">' + linkify(e.text) + '</div>'
    + '</div>'
  ).join("") || '<div class="col-empty">No entries yet</div>');
  const bodyEl = $("drawer-body");
  const scrollTop = bodyEl.scrollTop;
  bodyEl.innerHTML = parts.join("");
  bodyEl.scrollTop = scrollTop;

  const isOpen = card.state !== "done" && card.state !== "canceled";
  const nextFootKey = card.id + ":" + card.mate + ":" + isOpen;
  if (nextFootKey === footKey) return;
  footKey = nextFootKey;
  const foot = $("drawer-foot");
  if (!isOpen) {
    foot.innerHTML = '<div style="color:var(--muted);font-size:12px">Card is ' + esc(card.state) + '.</div>';
    return;
  }
  foot.innerHTML =
    '<textarea class="textarea" id="drawer-reply" placeholder="Reply or answer..."></textarea>'
    + '<div class="foot-row">'
    + '<div style="display:flex;gap:8px">'
    + '<button class="btn btn-amber" data-action="answer" data-id="' + esc(card.id) + '">Answer &amp; hand to ' + esc(card.mate) + '</button>'
    + '<button class="btn" data-action="reply" data-id="' + esc(card.id) + '">Reply</button>'
    + '</div>'
    + '<div style="display:flex;gap:8px">'
    + '<button class="btn btn-ghost" data-action="close-card" data-id="' + esc(card.id) + '">Close</button>'
    + '<button class="btn btn-danger" data-action="cancel-card" data-id="' + esc(card.id) + '">Cancel</button>'
    + '</div>'
    + '</div>';
}

async function submitDraft(id, path, payload) {
  const editor = $("drawer-reply");
  const text = editor.value.trim();
  if (!text) return;
  await post("/cards/" + encodeURIComponent(id) + path, payload(text));
  if (editor.isConnected && editor.value.trim() === text) editor.value = "";
  await refresh();
}

function openNewModal() {
  $("new-modal").classList.add("open");
  $("nc-title").focus();
}

function closeNewModal() {
  $("new-modal").classList.remove("open");
}

async function submitNewCard(e) {
  e.preventDefault();
  const mate = $("nc-mate").value.trim();
  const title = $("nc-title").value.trim();
  const body = $("nc-body").value.trim();
  const host = $("nc-host").value.trim();
  const project = $("nc-project").value.trim();
  const delivery = $("nc-delivery").value;
  await post("/cards", {
    mate,
    title,
    ...(body ? { body } : {}),
    ...(host ? { host } : {}),
    ...(project ? { project } : {}),
    ...(host && project ? { delivery } : {}),
    actor: "captain",
  });
  $("nc-title").value = "";
  $("nc-body").value = "";
  closeNewModal();
  await refresh();
}

const ACTIONS = {
  "set-mate": data => { activeMate = data.mate ?? null; renderFilters(); renderBoard(); },
  "open-card": data => openDrawer(data.id),
  "close-drawer": () => closeDrawer(),
  "close-new": () => closeNewModal(),
  "toggle-internal": () => { showInternal = !showInternal; if (openCardId) return loadDrawer(openCardId); },
  "answer": data => submitDraft(data.id, "/answer", text => ({ text, actor: "captain" })),
  "reply": data => submitDraft(data.id, "/entries", text => ({ text, by: "captain" })),
  "close-card": async data => { await post("/cards/" + encodeURIComponent(data.id) + "/close", { actor: "captain" }); await refresh(); },
  "cancel-card": async data => {
    const answer = prompt("Cancel reason?");
    if (answer === null) return;
    const reason = answer.trim() || "Canceled from board";
    await post("/cards/" + encodeURIComponent(data.id) + "/cancel", { reason, actor: "captain" });
    await refresh();
  },
};

function showNotice(error) {
  const el = $("notice");
  el.textContent = "Not saved: " + (error && error.message ? error.message : String(error));
  el.hidden = false;
}

function hideNotice() {
  $("notice").hidden = true;
}

document.addEventListener("click", async e => {
  const el = e.target.closest("[data-action]");
  const action = el && ACTIONS[el.dataset.action];
  if (!action) return;
  hideNotice();
  try {
    await action(el.dataset);
  } catch (error) {
    showNotice(error);
  }
});
$("drawer-backdrop").addEventListener("click", e => { if (e.target === e.currentTarget) closeDrawer(); });
$("new-modal").addEventListener("click", e => { if (e.target === e.currentTarget) closeNewModal(); });
$("search").addEventListener("input", renderBoard);
$("open-new").addEventListener("click", openNewModal);
$("new-form").addEventListener("submit", async e => {
  hideNotice();
  try {
    await submitNewCard(e);
  } catch (error) {
    showNotice(error);
  }
});

function connectEvents() {
  const es = new EventSource(API + "/events");
  es.onmessage = () => { refresh(); };
  for (const type of ["card.created","card.queued","card.claimed","card.expired","card.returned","card.escalated","card.handed_off","card.answered","card.snoozed","card.done","card.canceled","entry.posted","host.seen"]) {
    es.addEventListener(type, () => { refresh(); });
  }
  es.onerror = () => {
    $("live-dot").classList.add("offline");
  };
  es.onopen = () => {
    $("live-dot").classList.remove("offline");
    refresh();
  };
}

refresh();
connectEvents();
</script>
</body>
</html>
`;
