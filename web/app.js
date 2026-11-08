/* Harness queue app.
 * Sections: state · helpers · api · markdown · toasts · topbar · queue · evidence · answering ·
 * tasks · agents · brain · ideas · activity · new task modal · help/lightbox · keyboard · voice · sse · boot.
 */

// ---------------------------------------------------------------- state

const TABS = ["queue", "tasks", "agents", "brain", "ideas", "activity"];
const TAB_KEYS = { q: "queue", t: "tasks", a: "agents", b: "brain", i: "ideas", l: "activity" };
const KIND_DEFAULT_OPTIONS = {
  review: [
    { key: "approve", label: "Approve" },
    { key: "request_changes", label: "Request changes" },
    { key: "reject", label: "Reject" },
  ],
  permission: [
    { key: "allow", label: "Allow once" },
    { key: "allow_always", label: "Allow always" },
    { key: "deny", label: "Deny" },
  ],
  idea: [
    { key: "pursue", label: "Pursue" },
    { key: "park", label: "Park" },
    { key: "discard", label: "Discard" },
  ],
  info: [
    { key: "ack", label: "Acknowledge" },
    { key: "request_changes", label: "Request changes" },
  ],
  question: [{ key: "answer", label: "Answer" }],
  decision: [],
};
const COMMENT_REQUIRED = new Set(["answer", "request_changes"]);
const NEGATIVE_KEYS = ["reject", "deny", "discard"];
const POSITIVE_KEYS = ["approve", "allow", "pursue", "ack", "answer"];
const ACTIVITY_MAX = 300;
const UNDO_MS = 60_000;
const POLL_MS = 30_000;

const state = {
  tab: "queue",
  state: null, // GET /api/state
  queue: [], // open items (list)
  selectedId: null,
  detail: null, // { item, task, runs, children }
  selectedOption: null,
  filters: { kind: "", lead: "" },
  tasks: [],
  agents: null,
  brain: null,
  brainViewingVersion: null,
  ideas: [],
  activity: [],
  lastUndo: null, // { id, title, expires, timer }
  pendingChord: null, // "g" chord
  polling: null,
  sseErrors: 0,
  streamLost: false, // the SSE connection dropped; resync once it is back
  lastEventId: 0, // highest event id seen (SSE or activity list), for /api/events?since=
  micShown: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------- helpers


// The server reports open items as { total, byKind, byLead, stale }; older shapes were a plain number.
function openCount(s) {
  const q = s?.counts?.queue;
  if (typeof q === "number") return q;
  return Number(q?.total ?? 0);
}
function setOpenCount(s, n) {
  if (!s?.counts) return;
  if (typeof s.counts.queue === "number" || s.counts.queue == null) s.counts.queue = n;
  else s.counts.queue.total = n;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function ago(iso) {
  if (!iso) return "";
  const diff = Math.max(0, Date.now() - Date.parse(iso));
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function timeOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dateTimeOf(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function pct(rate) {
  return rate === null || rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}

function leadName(id) {
  if (!id) return "";
  const lead = state.state?.leads?.find((l) => l.id === id);
  return lead ? lead.name : id;
}

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function store(key, value) {
  try {
    localStorage.setItem(`harness.${key}`, JSON.stringify(value));
  } catch (err) {
    console.warn("localStorage unavailable", err);
  }
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(`harness.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function setDocumentTitle() {
  const n = openCount(state.state);
  document.title = n > 0 ? `(${n}) Harness` : "Harness";
}

// ---------------------------------------------------------------- api

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const type = res.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message = payload && typeof payload === "object" && payload.error ? payload.error : typeof payload === "string" && payload ? payload : `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return payload;
}

const get = (path) => api("GET", path);
const post = (path, body) => api("POST", path, body ?? {});

// ---------------------------------------------------------------- markdown

// Compared against localName.toUpperCase(), so lower-case names inside <svg>/<math> match too. Foreign-namespace
// elements (svg, math) are dropped outright: they are not needed for agent markdown and hide styling/script vectors.
const BLOCKED_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "STYLE", "LINK", "META", "BASE", "FORM", "SVG", "MATH"]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "srcset", "data", "ping", "background", "cite", "longdesc", "usemap"]);
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** True for http(s)/mailto URLs, relative paths and #anchors; rejects javascript:, data:, vbscript: and friends. */
function safeUrl(value) {
  // The parser already decoded entities ("java&#9;script:" is now "java<TAB>script:"); browsers ignore whitespace and
  // control characters inside a scheme, so strip them before looking at it.
  const v = String(value).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, "").toLowerCase();
  if (v === "" || v.startsWith("#")) return true;
  let parsed;
  try {
    parsed = new URL(v, document.baseURI);
  } catch {
    return false;
  }
  return SAFE_SCHEMES.has(parsed.protocol);
}

/** Render markdown to sanitised HTML: no scripts, frames or inline handlers survive. */
function renderMarkdown(src) {
  const text = typeof src === "string" ? src : "";
  let html = "";
  if (window.marked && typeof window.marked.parse === "function") {
    try {
      html = window.marked.parse(text, { breaks: true, gfm: true, async: false });
    } catch (err) {
      console.warn("markdown render failed", err);
      html = "";
    }
  }
  if (!html) {
    const pre = el("pre", { text });
    html = pre.outerHTML;
  }
  return sanitise(html);
}

function sanitise(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const node of Array.from(doc.body.querySelectorAll("*"))) {
    if (!node.isConnected) continue; // inside a subtree removed below
    const tag = String(node.localName || node.tagName || "").toUpperCase();
    if (BLOCKED_TAGS.has(tag) || node.namespaceURI !== XHTML_NS) {
      node.remove();
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || (URL_ATTRS.has(name) && !safeUrl(attr.value))) {
        node.removeAttribute(attr.name);
      }
    }
    if (tag === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
  return doc.body.innerHTML;
}

function markdownNode(src, cls = "markdown") {
  return el("div", { class: cls, html: renderMarkdown(src) });
}

// ---------------------------------------------------------------- toasts

function toast(message, { action, onAction, error = false, ttl = 4000 } = {}) {
  const box = $("#toasts");
  const node = el("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" }, [el("span", { text: message })]);
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    node.remove();
  };
  if (action) {
    node.append(
      el("button", {
        type: "button",
        text: action,
        onclick: () => {
          dismiss();
          if (onAction) onAction();
        },
      }),
    );
  }
  node.append(el("button", { type: "button", text: "×", "aria-label": "Dismiss", onclick: dismiss }));
  box.append(node);
  timer = setTimeout(dismiss, ttl);
  return dismiss;
}

function reportError(err, context) {
  console.error(context, err);
  toast(`${context}: ${err && err.message ? err.message : String(err)}`, { error: true, ttl: 7000 });
}

// ---------------------------------------------------------------- topbar

async function refreshState() {
  try {
    state.state = await get("/api/state");
  } catch (err) {
    reportError(err, "Could not load state");
    return;
  }
  renderTopbar();
}

function renderTopbar() {
  const s = state.state;
  if (!s) return;
  $("#principal-name").textContent = s.principal?.name ? `for ${s.principal.name}` : "";
  const open = openCount(s);
  const badge = $("#open-count");
  badge.textContent = String(open);
  badge.classList.toggle("zero", open === 0);
  $("#paused-indicator").classList.toggle("hidden", !s.paused);
  $("#paused-indicator").textContent = s.pausedByUser ? "Paused" : s.paused ? "Paused · budget" : "";
  $("#pause-toggle").textContent = s.pausedByUser ? "Resume" : "Pause";
  const spend = $("#spend");
  const cap = s.budget?.perDayUsd ?? 0;
  spend.textContent = `${money(s.costToday)} / ${money(cap)}`;
  spend.classList.toggle("over", cap > 0 && Number(s.costToday) >= cap);
  fillLeadSelects();
  setDocumentTitle();
}

function fillLeadSelects() {
  const leads = state.state?.leads ?? [];
  const filter = $("#filter-lead");
  clear(filter).append(el("option", { value: "", text: "All leads" }));
  for (const l of leads) filter.append(el("option", { value: l.id, text: l.name }));
  if (state.filters.lead && !leads.some((l) => l.id === state.filters.lead)) state.filters.lead = "";
  filter.value = state.filters.lead;

  const nt = $("#nt-lead");
  const chosen = nt.value;
  clear(nt).append(el("option", { value: "", text: "Let the chief decide" }));
  for (const l of leads) nt.append(el("option", { value: l.id, text: l.name }));
  nt.value = chosen;
}

async function togglePause() {
  const btn = $("#pause-toggle");
  btn.disabled = true;
  try {
    const pausedByUser = state.state?.pausedByUser;
    await post(pausedByUser ? "/api/resume" : "/api/pause");
    toast(pausedByUser ? "Agents resumed" : "Agents paused");
    await refreshState();
  } catch (err) {
    reportError(err, "Could not change pause state");
  } finally {
    btn.disabled = false;
  }
}

function switchTab(tab, { focus = false } = {}) {
  if (!TABS.includes(tab)) return;
  state.tab = tab;
  store("tab", tab);
  for (const b of $$(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of TABS) $(`#panel-${t}`).classList.toggle("hidden", t !== tab);
  if (focus) $(`.tab[data-tab="${tab}"]`).focus();
  return loadTab(tab);
}

/** Switch to the queue and show one specific item, even if the list refresh would have picked another. */
async function showQueueItem(id) {
  state.selectedId = id;
  await switchTab("queue");
  // refreshQueue() resets the selection to the first open item when `id` is not in the (filtered) list.
  state.selectedId = id;
  for (const li of $$(".queue-item")) li.setAttribute("aria-selected", String(li.dataset.id === id));
  if (!state.detail || state.detail.item.id !== id) await openItem(id);
}

async function loadTab(tab) {
  switch (tab) {
    case "queue":
      return refreshQueue();
    case "tasks":
      return refreshTasks();
    case "agents":
      return refreshAgents();
    case "brain":
      return refreshBrain();
    case "ideas":
      return refreshIdeas();
    case "activity":
      return refreshActivity();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- queue (list)

function queueUrl() {
  const q = new URLSearchParams({ status: "open" });
  if (state.filters.kind) q.set("kind", state.filters.kind);
  if (state.filters.lead) q.set("lead", state.filters.lead);
  return `/api/queue?${q.toString()}`;
}

async function refreshQueue({ keepSelection = true } = {}) {
  let items;
  try {
    items = await get(queueUrl());
  } catch (err) {
    reportError(err, "Could not load the queue");
    return;
  }
  state.queue = Array.isArray(items) ? items : [];
  const stillOpen = keepSelection && state.queue.some((i) => i.id === state.selectedId);
  if (!stillOpen) state.selectedId = state.queue[0]?.id ?? null;
  renderQueueList();
  if (state.selectedId) {
    if (!stillOpen || !state.detail || state.detail.item.id !== state.selectedId) await openItem(state.selectedId);
    else await openItem(state.selectedId, { quiet: true });
  } else {
    state.detail = null;
    renderDetail();
  }
}

function renderQueueList() {
  const list = clear($("#queue-list"));
  $("#queue-count").textContent = state.queue.length ? `${state.queue.length} open` : "";
  if (!state.queue.length) {
    list.append(el("li", { class: "empty", text: "Queue is clear." }));
    return;
  }
  for (const item of state.queue) {
    const blocking = item.kind === "permission" || item.meta?.blocking === true;
    const li = el(
      "li",
      {
        class: "queue-item",
        role: "option",
        id: `qi-${item.id}`,
        "aria-selected": String(item.id === state.selectedId),
        dataset: { id: item.id },
        onclick: () => selectItem(item.id),
      },
      [
        el("div", { class: `kind-bar bar-${item.kind}` }),
        el("div", {}, [
          el("div", { class: "qi-meta" }, [
            el("span", { class: `kind-tag kind-${item.kind}`, text: item.kind }),
            el("span", { class: `prio prio-${clampPrio(item.priority)}`, text: `P${clampPrio(item.priority)}` }),
            item.lead ? el("span", { class: "lead", text: leadName(item.lead) }) : null,
            el("span", { text: ago(item.created_at), title: dateTimeOf(item.created_at) }),
            blocking ? el("span", { class: "blocking", text: "BLOCKING" }) : null,
          ]),
          el("div", { class: "qi-title", text: item.title }),
          item.task_title && item.task_title !== item.title ? el("div", { class: "small muted", text: item.task_title }) : null,
        ]),
      ],
    );
    list.append(li);
  }
}

function clampPrio(p) {
  const n = Number(p);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3;
}

function selectItem(id) {
  state.selectedId = id;
  for (const li of $$(".queue-item")) li.setAttribute("aria-selected", String(li.dataset.id === id));
  const li = $(`#qi-${CSS.escape(id)}`);
  if (li) li.scrollIntoView({ block: "nearest" });
  void openItem(id);
}

function moveSelection(delta) {
  if (!state.queue.length) return;
  const idx = state.queue.findIndex((i) => i.id === state.selectedId);
  const next = Math.min(state.queue.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
  selectItem(state.queue[next].id);
}

// ---------------------------------------------------------------- queue (detail)

/** Disable the answer controls of the item currently shown (used while a different item is loading). */
function setAnswerControlsDisabled(disabled) {
  for (const b of $$(".answer-box button")) b.disabled = disabled;
  const ta = $("#comment");
  if (ta) ta.disabled = disabled;
}

async function openItem(id, { quiet = false } = {}) {
  if (!quiet && state.detail && state.detail.item.id !== id) setAnswerControlsDisabled(true);
  try {
    const detail = await get(`/api/queue/${encodeURIComponent(id)}`);
    if (state.selectedId !== id) return;
    if (quiet && state.detail?.item.id === id && JSON.stringify(state.detail.item) === JSON.stringify(detail.item)) {
      state.detail = detail;
      return;
    }
    const previousOption = quiet && state.detail?.item.id === id ? state.selectedOption : null;
    const previousComment = quiet ? $("#comment")?.value ?? "" : "";
    state.detail = detail;
    state.selectedOption = previousOption ?? detail.item.recommended ?? null;
    renderDetail();
    if (previousComment) $("#comment").value = previousComment;
  } catch (err) {
    if (err.status === 404) {
      toast("That item is gone; refreshing the queue");
      await refreshQueue({ keepSelection: false });
      return;
    }
    reportError(err, "Could not load the item");
  }
}

function optionsFor(item) {
  const given = Array.isArray(item.options) ? item.options.filter((o) => o && o.key) : [];
  if (given.length) return given;
  return KIND_DEFAULT_OPTIONS[item.kind] ?? [];
}

function renderDetail() {
  const pane = clear($("#queue-detail"));
  const detail = state.detail;
  if (!detail) {
    pane.append(el("div", { class: "empty", text: state.queue.length ? "Select an item." : "Nothing to review. Enjoy the quiet." }));
    return;
  }
  const { item, task, runs, children } = detail;
  const options = optionsFor(item);
  const blocking = item.kind === "permission" || item.meta?.blocking === true;

  pane.append(
    el("div", { class: "detail-head" }, [
      el("div", { class: "qi-meta" }, [
        el("span", { class: `kind-tag kind-${item.kind}`, text: item.kind }),
        el("span", { class: `prio prio-${clampPrio(item.priority)}`, text: `P${clampPrio(item.priority)}` }),
        blocking ? el("span", { class: "blocking", text: "BLOCKING AN AGENT" }) : null,
      ]),
      el("h1", { class: "detail-title", text: item.title }),
      el("div", { class: "detail-meta" }, [
        item.lead ? el("span", { text: leadName(item.lead) }) : null,
        el("span", { text: `opened ${ago(item.created_at)} ago`, title: dateTimeOf(item.created_at) }),
        task ? el("a", { href: "#", text: `task: ${task.title} (${task.status})`, onclick: (e) => { e.preventDefault(); void openTaskDrawer(task.id); } }) : null,
        item.deadline_at ? el("span", { text: `deadline ${dateTimeOf(item.deadline_at)}` }) : null,
        item.status !== "open" ? el("span", { class: "status-pill", text: item.status }) : null,
      ]),
    ]),
  );

  const body = el("div", { class: "detail-body" });
  body.append(markdownNode(item.body));
  if (item.kind === "permission" && item.meta && typeof item.meta.tool === "string") {
    body.append(el("pre", { class: "card", text: describePermission(item.meta) }));
  }
  if (Array.isArray(item.evidence) && item.evidence.length) {
    body.append(el("h3", { class: "h3", text: `Evidence (${item.evidence.length})` }));
    body.append(renderEvidence(item.evidence));
  }
  if (children && children.length) {
    body.append(el("h3", { class: "h3", text: "Subtasks" }));
    body.append(el("ul", { class: "plain-list" }, children.map((c) => el("li", { class: "item-row", onclick: () => openTaskDrawer(c.id) }, [statusPill(c.status), el("span", { text: c.title })]))));
  }
  if (runs && runs.length) {
    body.append(el("h3", { class: "h3", text: "Recent runs" }));
    body.append(el("div", {}, runs.map(runRow)));
  }
  if (item.recommended) {
    const rec = options.find((o) => o.key === item.recommended);
    body.append(
      el("div", { class: "card recommendation" }, [
        el("div", { class: "rec-label", text: "Lead recommends" }),
        el("div", { class: "rec-option", text: rec ? rec.label : item.recommended }),
        item.rationale ? markdownNode(item.rationale, "markdown small") : null,
      ]),
    );
  }
  body.append(renderAnswerBox(item, options));
  pane.append(body);
}

function describePermission(meta) {
  const parts = [`Tool: ${meta.tool}`];
  if (meta.input !== undefined) {
    const text = typeof meta.input === "string" ? meta.input : JSON.stringify(meta.input, null, 2);
    parts.push(text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
  }
  return parts.join("\n");
}

function statusPill(status) {
  return el("span", { class: `status-pill status-${status}`, text: String(status || "").replace("_", " ") });
}

function runRow(run) {
  return el("div", { class: "run-row" }, [
    el("span", { class: "dot" + (run.status === "running" ? " live" : "") }),
    el("span", { text: run.agent }),
    statusPill(run.status),
    el("span", { class: "muted", text: `${dateTimeOf(run.started_at)} · ${money(run.cost_usd)} · ${run.turns ?? 0} turns` }),
    run.summary ? el("span", { class: "muted", text: run.summary }) : null,
    el("a", { href: `/api/runs/${encodeURIComponent(run.id)}/log`, target: "_blank", rel: "noopener", text: "transcript" }),
  ]);
}

// ---------------------------------------------------------------- evidence

function attachmentUrl(ev) {
  if (ev.url) return ev.url;
  if (ev.path) return `/attachments/${ev.path.split("/").map(encodeURIComponent).join("/")}`;
  return null;
}

function renderEvidence(list) {
  const wrap = el("div", { class: "evidence" });
  const images = list.filter((e) => e.type === "image");
  const rest = list.filter((e) => e.type !== "image");
  if (images.length) {
    wrap.append(el("div", { class: "ev-gallery" }, images.map(renderImage)));
  }
  for (const ev of rest) wrap.append(renderOtherEvidence(ev));
  return wrap;
}

function evidenceCaption(ev, url) {
  const name = ev.caption || (ev.path ? ev.path.split("/").pop() : ev.url) || ev.type;
  return el("div", { class: "ev-caption" }, [el("span", { text: name }), url ? el("a", { href: url, target: "_blank", rel: "noopener", text: "open" }) : null]);
}

function renderImage(ev) {
  const url = attachmentUrl(ev);
  const caption = ev.caption || (ev.path ? ev.path.split("/").pop() : "image");
  return el("div", { class: "ev ev-image", role: "button", tabindex: "0", title: "Click to enlarge", onclick: () => openLightbox(url, caption), onkeydown: (e) => { if (e.key === "Enter") openLightbox(url, caption); } }, [
    el("img", { src: url, alt: caption, loading: "lazy" }),
    el("div", { class: "ev-caption" }, [el("span", { text: caption })]),
  ]);
}

function renderOtherEvidence(ev) {
  const url = attachmentUrl(ev);
  const box = el("div", { class: "ev" }, [evidenceCaption(ev, url)]);
  switch (ev.type) {
    case "video":
      box.append(el("video", { controls: true, preload: "metadata", src: url }));
      break;
    case "diff": {
      const holder = el("div", { class: "diff", text: "Loading diff…" });
      box.append(holder);
      loadDiff(url, holder);
      break;
    }
    case "text":
      box.append(el("pre", { text: ev.text ?? "" }));
      if (!ev.text && url) loadText(url, box);
      break;
    case "link":
      box.append(el("div", { class: "ev-note" }, [el("a", { href: url, target: "_blank", rel: "noopener", text: url })]));
      break;
    default:
      box.append(el("div", { class: "ev-note" }, url ? [el("a", { href: url, download: true, text: "Download file" })] : ["No file attached."]));
  }
  return box;
}

async function loadText(url, box) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    const pre = box.querySelector("pre");
    if (pre) pre.textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated; open the file for the rest)` : text;
  } catch (err) {
    console.warn("text evidence failed", err);
    box.append(el("div", { class: "ev-note", text: `Could not load the text file (${err.message}).` }));
  }
}

async function loadDiff(url, holder) {
  if (!url) {
    holder.textContent = "No diff file attached.";
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    renderDiff(await res.text(), holder);
  } catch (err) {
    console.warn("diff evidence failed", err);
    holder.textContent = `Could not load the diff (${err.message}).`;
  }
}

function renderDiff(text, holder) {
  clear(holder);
  const lines = text.split("\n");
  const MAX = 4000;
  let adds = 0;
  let dels = 0;
  for (const line of lines.slice(0, MAX)) {
    let cls = "diff-line";
    if (line.startsWith("diff --git") || line.startsWith("Index: ")) {
      const m = /b\/(.+)$/.exec(line);
      holder.append(el("div", { class: "diff-file", text: m ? m[1] : line }));
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename")) cls += " diff-meta";
    else if (line.startsWith("@@")) cls += " diff-hunk";
    else if (line.startsWith("+")) {
      cls += " diff-add";
      adds++;
    } else if (line.startsWith("-")) {
      cls += " diff-del";
      dels++;
    }
    holder.append(el("span", { class: cls, text: line || " " }));
  }
  if (lines.length > MAX) holder.append(el("div", { class: "ev-note", text: `Showing the first ${MAX} of ${lines.length} lines. Open the file for the rest.` }));
  holder.prepend(el("div", { class: "ev-note", text: `${adds} additions, ${dels} deletions` }));
}

// ---------------------------------------------------------------- answering

function renderAnswerBox(item, options) {
  const box = el("div", { class: "card answer-box" });
  if (item.status !== "open") {
    box.append(el("div", { class: "muted", text: `Answered: ${item.answer ? item.answer.option : item.status}${item.answer?.comment ? ` — ${item.answer.comment}` : ""}` }));
    return box;
  }
  const opts = el("div", { class: "options", role: "group", "aria-label": "Options" });
  options.forEach((o, i) => {
    const isRec = o.key === item.recommended;
    const btn = el(
      "button",
      {
        type: "button",
        class: `btn option-btn${isRec ? " btn-primary" : ""}${state.selectedOption === o.key ? " selected" : ""}`,
        dataset: { key: o.key },
        title: o.description || o.label,
        onclick: () => chooseOption(o.key),
      },
      [el("span", { class: "opt-label" }, [el("span", { class: "key", text: String(i + 1) }), o.label]), o.description ? el("span", { class: "opt-desc", text: o.description }) : null],
    );
    opts.append(btn);
  });
  if (!options.length) opts.append(el("span", { class: "muted", text: "This item has no options; write a comment and submit." }));
  box.append(opts);

  const wrap = el("div", { class: "comment-wrap" });
  const ta = el("textarea", {
    id: "comment",
    rows: "3",
    placeholder: commentPlaceholder(item),
    "aria-label": "Comment",
    onkeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submitAnswer();
      }
    },
  });
  wrap.append(ta);
  wrap.append(el("button", { type: "button", class: "btn btn-icon mic-btn", id: "mic-btn", title: "Dictate (v)", "aria-label": "Dictate comment", "aria-pressed": "false", text: "🎙" }));
  wrap.append(el("div", { class: "listening-note hidden", id: "listening-note", text: "Listening… speak your comment. Press v or the mic to stop." }));
  box.append(wrap);
  setupMicButton();

  box.append(
    el("div", { class: "actions" }, [
      el("button", { type: "button", class: "btn btn-primary", id: "submit-btn", onclick: () => void submitAnswer() }, ["Submit ", el("span", { class: "key", text: "⌘↵" })]),
      el("button", { type: "button", class: "btn", onclick: () => void deferItem() }, ["Defer 24h ", el("span", { class: "key", text: "d" })]),
      el("button", { type: "button", class: "btn", onclick: () => skipItem() }, ["Skip ", el("span", { class: "key", text: "s" })]),
      el("span", { class: "spacer" }),
      el("span", { class: "muted small", id: "selected-note", text: selectedNote(options) }),
    ]),
  );
  return box;
}

function commentPlaceholder(item) {
  if (item.kind === "question") return "Your answer (required)";
  if (item.kind === "review") return "Optional comment. Required when requesting changes.";
  return "Optional comment";
}

function selectedNote(options) {
  const o = options.find((x) => x.key === state.selectedOption);
  return o ? `Selected: ${o.label}` : options.length ? "Pick an option" : "";
}

function chooseOption(key) {
  state.selectedOption = key;
  for (const b of $$(".option-btn")) b.classList.toggle("selected", b.dataset.key === key);
  const note = $("#selected-note");
  if (note && state.detail) note.textContent = selectedNote(optionsFor(state.detail.item));
  if (COMMENT_REQUIRED.has(key)) {
    const ta = $("#comment");
    if (ta && !ta.value.trim()) ta.focus();
  }
}

function chooseOptionByIndex(n) {
  if (!state.detail) return;
  const options = optionsFor(state.detail.item);
  const o = options[n - 1];
  if (o) chooseOption(o.key);
}

function chooseByKeys(keys) {
  if (!state.detail) return false;
  const options = optionsFor(state.detail.item);
  const o = options.find((x) => keys.includes(x.key));
  if (!o) return false;
  chooseOption(o.key);
  return true;
}

function shakeComment() {
  const ta = $("#comment");
  if (!ta) return;
  ta.classList.remove("shake");
  void ta.offsetWidth;
  ta.classList.add("shake");
  ta.focus();
  setTimeout(() => ta.classList.remove("shake"), 500);
}

async function submitAnswer() {
  const detail = state.detail;
  if (!detail || detail.item.status !== "open") return;
  if (detail.item.id !== state.selectedId) {
    // The selection moved (j/k) and the new item has not loaded yet; never answer the previous one by accident.
    toast("Still loading the selected item; try again in a moment");
    return;
  }
  const item = detail.item;
  const options = optionsFor(item);
  let option = state.selectedOption ?? item.recommended ?? null;
  if (!option && options.length === 1) option = options[0].key;
  if (!option && (item.kind === "question" || options.length === 0)) option = "answer";
  if (!option) {
    toast("Pick an option first (press 1–9)");
    return;
  }
  const ta = $("#comment");
  const comment = ta ? ta.value.trim() : "";
  if (COMMENT_REQUIRED.has(option) && !comment) {
    shakeComment();
    toast(option === "answer" ? "Write your answer first" : "Say what should change");
    return;
  }
  const submit = $("#submit-btn");
  if (submit) submit.disabled = true;
  stopVoice();
  try {
    const result = await post(`/api/queue/${encodeURIComponent(item.id)}/answer`, { option, comment });
    const label = (options.find((o) => o.key === option) || {}).label || option;
    scheduleUndo(item.id, label);
    state.queue = state.queue.filter((i) => i.id !== item.id);
    if (state.state?.counts) setOpenCount(state.state, Math.max(0, openCount(state.state) - 1));
    renderTopbar();
    advanceTo(result && result.next ? result.next : null);
  } catch (err) {
    if (submit) submit.disabled = false;
    if (err.status === 409) {
      toast("This item was already answered elsewhere; refreshing");
      await refreshQueue({ keepSelection: false });
      return;
    }
    reportError(err, "Could not submit");
  }
}

function advanceTo(nextId) {
  const inList = Boolean(nextId) && state.queue.some((i) => i.id === nextId);
  state.selectedId = inList ? nextId : state.queue[0]?.id ?? null;
  state.detail = null;
  renderQueueList();
  renderDetail();
  void refreshQueue();
}

function scheduleUndo(id, label) {
  if (state.lastUndo) {
    // Only the latest answer can be undone: drop the previous toast so its Undo cannot act on the wrong item.
    clearTimeout(state.lastUndo.timer);
    if (state.lastUndo.dismiss) state.lastUndo.dismiss();
  }
  const dismiss = toast(`${label} · undo (u)`, { action: "Undo", onAction: () => void undoLast(), ttl: UNDO_MS });
  const timer = setTimeout(() => {
    if (state.lastUndo?.id === id) state.lastUndo = null;
  }, UNDO_MS);
  state.lastUndo = { id, label, timer, dismiss };
}

async function undoLast() {
  const last = state.lastUndo;
  if (!last) {
    toast("Nothing to undo");
    return;
  }
  state.lastUndo = null;
  clearTimeout(last.timer);
  if (last.dismiss) last.dismiss();
  try {
    await post(`/api/queue/${encodeURIComponent(last.id)}/undo`);
    toast("Answer undone; the item is open again");
    state.selectedId = last.id;
    await refreshQueue();
    await refreshState();
  } catch (err) {
    if (err.status === 409) toast(`Cannot undo: ${err.message}`, { error: true });
    else reportError(err, "Could not undo");
  }
}

async function deferItem() {
  const detail = state.detail;
  if (!detail || detail.item.status !== "open") return;
  try {
    await post(`/api/queue/${encodeURIComponent(detail.item.id)}/defer`, { hours: 24 });
    toast("Deferred for 24 hours");
    state.queue = state.queue.filter((i) => i.id !== detail.item.id);
    advanceTo(null);
    await refreshState();
  } catch (err) {
    reportError(err, "Could not defer");
  }
}

function skipItem() {
  if (!state.queue.length) return;
  const idx = state.queue.findIndex((i) => i.id === state.selectedId);
  const next = state.queue[(idx + 1) % state.queue.length];
  if (next) selectItem(next.id);
}

// ---------------------------------------------------------------- tasks

const BOARD_COLUMNS = [
  { key: "inbox", label: "Inbox", statuses: ["inbox", "triaged"] },
  { key: "queued", label: "Queued", statuses: ["queued"] },
  { key: "running", label: "Running", statuses: ["running"] },
  { key: "waiting_human", label: "Waiting on you", statuses: ["waiting_human"] },
  { key: "review", label: "In review", statuses: ["review"] },
  { key: "other", label: "Done / other", statuses: ["done", "rejected", "failed", "parked"] },
];

async function refreshTasks() {
  try {
    const tasks = await get("/api/tasks");
    state.tasks = Array.isArray(tasks) ? tasks : [];
  } catch (err) {
    reportError(err, "Could not load tasks");
    return;
  }
  renderTasks();
}

function renderTasks() {
  const board = clear($("#task-board"));
  for (const col of BOARD_COLUMNS) {
    const tasks = state.tasks.filter((t) => col.statuses.includes(t.status));
    const column = el("div", { class: "column" }, [el("div", { class: "column-head" }, [el("span", { text: col.label }), el("span", { text: String(tasks.length) })])]);
    if (!tasks.length) column.append(el("div", { class: "muted small", text: "—" }));
    for (const t of tasks) column.append(taskCard(t));
    board.append(column);
  }
}

function taskCard(t) {
  return el("button", { type: "button", class: "task-card", onclick: () => void openTaskDrawer(t.id) }, [
    el("div", { class: "tc-title", text: t.title }),
    el("div", { class: "tc-meta" }, [
      el("span", { class: `prio prio-${clampPrio(t.priority)}`, text: `P${clampPrio(t.priority)}` }),
      t.lead ? el("span", { text: leadName(t.lead) }) : el("span", { class: "muted", text: "unassigned" }),
      el("span", { text: ago(t.updated_at), title: dateTimeOf(t.updated_at) }),
      Number(t.cost_usd) > 0 ? el("span", { text: money(t.cost_usd) }) : null,
      t.open_items ? el("span", { class: "blocking", text: `${t.open_items} waiting` }) : null,
      col6Status(t.status),
    ]),
  ]);
}

function col6Status(status) {
  return ["done", "rejected", "failed", "parked", "triaged"].includes(status) ? statusPill(status) : null;
}

async function openTaskDrawer(id) {
  let data;
  try {
    data = await get(`/api/tasks/${encodeURIComponent(id)}`);
  } catch (err) {
    reportError(err, "Could not load the task");
    return;
  }
  renderTaskDrawer(data);
  $("#task-drawer").classList.remove("hidden");
  $("#task-drawer-backdrop").classList.remove("hidden");
  $("#task-drawer-close").focus();
}

function closeTaskDrawer() {
  $("#task-drawer").classList.add("hidden");
  $("#task-drawer-backdrop").classList.add("hidden");
}

function renderTaskDrawer({ task, runs = [], items = [], children = [], events = [] }) {
  $("#task-drawer-title").textContent = task.title;
  const body = clear($("#task-drawer-body"));
  body.dataset.taskId = task.id;
  const editable = ["inbox", "queued", "triaged", "parked"].includes(task.status);
  const retryable = ["failed", "rejected", "parked"].includes(task.status);

  body.append(
    el("dl", { class: "kv" }, [
      el("dt", { text: "Status" }), el("dd", {}, [statusPill(task.status)]),
      el("dt", { text: "Lead" }), el("dd", {}, [editable ? leadEditor(task) : el("span", { text: task.lead ? leadName(task.lead) : "unassigned" })]),
      el("dt", { text: "Priority" }), el("dd", {}, [editable ? priorityEditor(task) : el("span", { class: `prio prio-${clampPrio(task.priority)}`, text: `P${clampPrio(task.priority)}` })]),
      el("dt", { text: "Source" }), el("dd", { text: task.source }),
      task.repo ? el("dt", { text: "Repo" }) : null, task.repo ? el("dd", { text: task.repo }) : null,
      task.branch ? el("dt", { text: "Branch" }) : null, task.branch ? el("dd", { text: task.branch }) : null,
      el("dt", { text: "Cost" }), el("dd", { text: `${money(task.cost_usd)} · ${task.attempts ?? 0} attempt(s)` }),
      el("dt", { text: "Created" }), el("dd", { text: dateTimeOf(task.created_at) }),
      el("dt", { text: "Updated" }), el("dd", { text: dateTimeOf(task.updated_at) }),
      task.result_summary ? el("dt", { text: "Result" }) : null, task.result_summary ? el("dd", { text: task.result_summary }) : null,
    ]),
  );

  body.append(
    el("div", { class: "row row-wrap" }, [
      !["done", "rejected"].includes(task.status) ? el("button", { type: "button", class: "btn btn-danger", onclick: () => void cancelTask(task.id) }, ["Cancel task"]) : null,
      retryable ? el("button", { type: "button", class: "btn", onclick: () => void retryTask(task.id) }, ["Retry"]) : null,
    ]),
  );

  body.append(el("h3", { class: "h3", text: "Brief" }));
  body.append(markdownNode(task.brief || "_No brief._"));

  if (children.length) {
    body.append(el("h3", { class: "h3", text: "Subtasks" }));
    body.append(el("div", {}, children.map((c) => el("div", { class: "item-row", onclick: () => void openTaskDrawer(c.id) }, [statusPill(c.status), el("span", { text: c.title })]))));
  }

  body.append(el("h3", { class: "h3", text: `Queue items (${items.length})` }));
  if (!items.length) body.append(el("div", { class: "muted small", text: "None yet." }));
  for (const it of items) {
    body.append(
      el("div", { class: "item-row", onclick: () => { closeTaskDrawer(); void showQueueItem(it.id); } }, [
        el("span", { class: `kind-tag kind-${it.kind}`, text: it.kind }),
        statusPill(it.status),
        el("span", { text: it.title }),
        it.answer ? el("span", { class: "muted", text: `→ ${it.answer.option}` }) : null,
      ]),
    );
  }

  body.append(el("h3", { class: "h3", text: `Runs (${runs.length})` }));
  if (!runs.length) body.append(el("div", { class: "muted small", text: "No runs yet." }));
  for (const r of runs) body.append(runRow(r));

  body.append(el("h3", { class: "h3", text: "Timeline" }));
  const tl = el("ul", { class: "timeline" });
  for (const ev of events) tl.append(el("li", {}, [el("span", { class: "ts", text: timeOf(ev.ts), title: dateTimeOf(ev.ts) }), el("span", { text: describeEvent(ev) })]));
  if (!events.length) tl.append(el("li", {}, [el("span", { class: "ts" }), el("span", { class: "muted", text: "Nothing yet." })]));
  body.append(tl);
}

function leadEditor(task) {
  const sel = el("select", { "aria-label": "Lead" }, [el("option", { value: "", text: "unassigned" })]);
  for (const l of state.state?.leads ?? []) sel.append(el("option", { value: l.id, text: l.name }));
  sel.value = task.lead ?? "";
  sel.addEventListener("change", () => void patchTask(task.id, { lead: sel.value }));
  return sel;
}

function priorityEditor(task) {
  const sel = el("select", { "aria-label": "Priority" });
  for (let p = 1; p <= 5; p++) sel.append(el("option", { value: String(p), text: `P${p}` }));
  sel.value = String(clampPrio(task.priority));
  sel.addEventListener("change", () => void patchTask(task.id, { priority: Number(sel.value) }));
  return sel;
}

async function patchTask(id, patch) {
  try {
    await api("PATCH", `/api/tasks/${encodeURIComponent(id)}`, patch);
    toast("Task updated");
    await refreshTasks();
    await openTaskDrawer(id);
  } catch (err) {
    reportError(err, "Could not update the task");
  }
}

async function cancelTask(id) {
  if (!window.confirm("Cancel this task? Running agents are stopped and open items withdrawn.")) return;
  try {
    await post(`/api/tasks/${encodeURIComponent(id)}/cancel`);
    toast("Task cancelled");
    closeTaskDrawer();
    await refreshTasks();
  } catch (err) {
    reportError(err, "Could not cancel the task");
  }
}

async function retryTask(id) {
  try {
    await post(`/api/tasks/${encodeURIComponent(id)}/retry`);
    toast("Task queued again");
    closeTaskDrawer();
    await refreshTasks();
  } catch (err) {
    reportError(err, "Could not retry the task");
  }
}

// ---------------------------------------------------------------- agents

async function refreshAgents() {
  try {
    state.agents = await get("/api/agents");
  } catch (err) {
    reportError(err, "Could not load agents");
    return;
  }
  renderAgents();
}

function renderAgents() {
  const grid = clear($("#agents-grid"));
  const a = state.agents;
  if (!a) return;
  const chiefActive = Array.isArray(a.chief?.active) && a.chief.active.length > 0;
  grid.append(
    el("div", { class: "agent-card" }, [
      el("div", { class: "agent-head" }, [el("span", { class: "agent-name" }, [el("span", { class: `dot${chiefActive ? " live" : ""}` }), "Chief of Staff"]), el("span", { class: "muted small", text: chiefActive ? "running" : "idle" })]),
      el("div", { class: "agent-counts" }, [
        el("span", {}, ["last run ", el("b", { text: a.chief?.lastRun ? `${ago(a.chief.lastRun.started_at)} ago` : "never" })]),
        a.chief?.lastRun ? el("span", {}, ["status ", el("b", { text: a.chief.lastRun.status })]) : null,
        el("span", {}, ["today ", el("b", { text: money(a.chief?.costToday) })]),
      ]),
      a.chief?.lastRun?.summary ? el("div", { class: "muted small", text: a.chief.lastRun.summary }) : null,
      chiefActive ? el("div", { class: "running-task" }, [el("div", { class: "rt-text", dataset: { runId: a.chief.active[0].runId }, text: a.chief.active[0].lastText || "…" })]) : null,
    ]),
  );
  for (const lead of a.leads ?? []) {
    const running = Array.isArray(lead.running) ? lead.running : [];
    grid.append(
      el("div", { class: "agent-card", dataset: { lead: lead.id } }, [
        el("div", { class: "agent-head" }, [el("span", { class: "agent-name" }, [el("span", { class: `dot${running.length ? " live" : ""}` }), lead.name]), el("span", { class: "muted small", text: `${running.length}/${lead.concurrency} slots` })]),
        el("div", { class: "agent-counts" }, [
          el("span", {}, ["queued ", el("b", { text: String(lead.queued ?? 0) })]),
          el("span", {}, ["waiting ", el("b", { text: String(lead.waiting ?? 0) })]),
          el("span", {}, ["review ", el("b", { text: String(lead.review ?? 0) })]),
          el("span", {}, ["today ", el("b", { text: money(lead.costToday) })]),
        ]),
        ...running.map((r) =>
          el("div", { class: "running-task", dataset: { taskId: r.task_id ?? r.id } }, [
            el("div", { class: "rt-title" }, [el("a", { href: "#", text: r.title, onclick: (e) => { e.preventDefault(); void openTaskDrawer(r.task_id ?? r.id); } })]),
            el("div", { class: "muted small", text: r.startedAt ? `started ${ago(r.startedAt)} ago` : "" }),
            el("div", { class: "rt-text", dataset: { runId: r.runId ?? "" }, text: r.lastText || "…" }),
          ]),
        ),
      ]),
    );
  }
  const brainActive = Array.isArray(a.brain?.active) && a.brain.active.length > 0;
  grid.append(
    el("div", { class: "agent-card" }, [
      el("div", { class: "agent-head" }, [el("span", { class: "agent-name" }, [el("span", { class: `dot${brainActive ? " live" : ""}` }), "Principal brain"]), el("span", { class: "muted small", text: brainActive ? "distilling" : "idle" })]),
      el("div", { class: "agent-counts" }, [el("span", {}, ["today ", el("b", { text: money(a.brain?.costToday) })])]),
    ]),
  );
}

function applyRunProgress(ev) {
  const text = ev.payload?.text;
  if (typeof text !== "string") return;
  let node = null;
  if (ev.run_id) node = $(`.rt-text[data-run-id="${CSS.escape(ev.run_id)}"]`);
  if (!node && ev.task_id) node = $(`.running-task[data-task-id="${CSS.escape(ev.task_id)}"] .rt-text`);
  if (node) node.textContent = text || "…";
}

// ---------------------------------------------------------------- brain

async function refreshBrain() {
  try {
    state.brain = await get("/api/brain");
  } catch (err) {
    reportError(err, "Could not load the brain");
    return;
  }
  renderBrain();
}

function renderBrain() {
  const b = state.brain;
  if (!b) return;
  const ta = $("#brain-editor");
  const dirty = ta.dataset.touched === "1" && ta.value !== ta.dataset.loadedFor;
  if (!dirty) {
    ta.value = b.content ?? "";
    ta.dataset.loadedFor = b.content ?? "";
    ta.dataset.touched = "0";
    $("#brain-dirty").textContent = "";
  } else {
    const changedOnDisk = (b.content ?? "") !== ta.dataset.loadedFor;
    $("#brain-dirty").textContent = changedOnDisk ? "Unsaved changes (the document changed on disk; saving overwrites it)" : "Unsaved changes";
  }
  if (!state.brainViewingVersion) {
    const doc = $("#brain-doc");
    doc.innerHTML = renderMarkdown(b.content || "_The brain is empty. Answer the onboarding question or write it here._");
    $("#brain-version-note").textContent = "";
    $("#brain-back-current").classList.add("hidden");
  }
  renderBrainStats(b.stats);
  const list = clear($("#brain-versions"));
  if (!b.versions?.length) list.append(el("li", { class: "muted small", text: "No versions yet." }));
  for (const v of b.versions ?? []) {
    list.append(
      el("li", { class: `version-row${state.brainViewingVersion === v.id ? " current" : ""}`, onclick: () => void viewBrainVersion(v.id) }, [
        el("span", { text: dateTimeOf(v.created_at) }),
        el("span", { class: "muted", text: `${v.decisions_covered ?? 0} decisions · ${v.length ?? 0} chars` }),
        v.notes ? el("span", { class: "muted", text: v.notes }) : null,
      ]),
    );
  }
}

function renderBrainStats(stats) {
  const box = clear($("#brain-stats"));
  if (!stats) return;
  const ag = stats.agreement ?? {};
  box.append(el("h3", { class: "h3", text: "Agreement with recommendations" }));
  box.append(statRow("Overall", ag.overall?.rate, `${ag.overall?.agreed ?? 0}/${ag.overall?.total ?? 0}`));
  box.append(statRow("Last 20", ag.last20));
  for (const [lead, s] of Object.entries(ag.byLead ?? {})) box.append(statRow(leadName(lead), s.rate, `${s.agreed}/${s.total}`));
  box.append(el("div", { class: "stat-line", text: `${stats.undistilled ?? 0} undistilled decision(s) · ${stats.versions ?? 0} version(s) · last distilled ${stats.lastDistilled ? `${ago(stats.lastDistilled)} ago` : "never"}` }));
  if (stats.lastChangelog) box.append(el("div", { class: "stat-line", text: `Last change: ${stats.lastChangelog}` }));
}

function statRow(label, rate, detail) {
  const w = rate === null || rate === undefined ? 0 : Math.round(rate * 100);
  return el("div", { class: "stat-row", title: detail || "" }, [el("span", { text: label }), el("div", { class: "bar" }, [el("span", { style: `width:${w}%` })]), el("span", { class: "val", text: pct(rate) })]);
}

async function viewBrainVersion(id) {
  try {
    const v = await get(`/api/brain/versions/${encodeURIComponent(id)}`);
    state.brainViewingVersion = id;
    $("#brain-doc").innerHTML = renderMarkdown(v.content ?? "");
    $("#brain-version-note").textContent = `Viewing version from ${dateTimeOf(v.created_at)} (read-only)`;
    $("#brain-back-current").classList.remove("hidden");
    renderBrain();
  } catch (err) {
    reportError(err, "Could not load that version");
  }
}

function backToCurrentBrain() {
  state.brainViewingVersion = null;
  renderBrain();
}

async function saveBrain() {
  const ta = $("#brain-editor");
  const btn = $("#brain-save");
  btn.disabled = true;
  try {
    await api("PUT", "/api/brain", { content: ta.value });
    ta.dataset.touched = "0";
    ta.dataset.loadedFor = ta.value;
    toast("Brain saved");
    state.brainViewingVersion = null;
    await refreshBrain();
  } catch (err) {
    reportError(err, "Could not save the brain");
  } finally {
    btn.disabled = false;
  }
}

async function distillBrainNow() {
  const btn = $("#brain-distill");
  btn.disabled = true;
  btn.textContent = "Distilling…";
  try {
    const r = await post("/api/brain/distill");
    toast(r && r.changed ? `Brain updated: ${r.changelog || "new version"}` : `No change${r && r.reason ? `: ${r.reason}` : ""}`, { ttl: 8000 });
    await refreshBrain();
  } catch (err) {
    reportError(err, "Distill failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Distill now";
  }
}

// ---------------------------------------------------------------- ideas

async function refreshIdeas() {
  try {
    const ideas = await get("/api/ideas");
    state.ideas = Array.isArray(ideas) ? ideas : [];
  } catch (err) {
    reportError(err, "Could not load ideas");
    return;
  }
  const list = clear($("#ideas-list"));
  if (!state.ideas.length) list.append(el("li", { class: "empty", text: "No ideas yet. Leads submit them as they work." }));
  for (const idea of state.ideas) {
    list.append(
      el("li", { class: "idea-row" }, [
        el("div", { class: "idea-title" }, [statusPill(idea.status), el("span", { text: idea.title }), idea.lead ? el("span", { class: "muted small", text: leadName(idea.lead) }) : null, el("span", { class: "muted small", text: ago(idea.created_at), title: dateTimeOf(idea.created_at) })]),
        idea.body ? el("div", { class: "idea-body", text: idea.body }) : null,
        idea.item_id && idea.status === "new" ? el("div", {}, [el("a", { href: "#", text: "Decide in the queue", onclick: (e) => { e.preventDefault(); void showQueueItem(idea.item_id); } })]) : null,
      ]),
    );
  }
}

// ---------------------------------------------------------------- activity

async function refreshActivity() {
  try {
    const events = await get("/api/events?limit=200");
    const arr = Array.isArray(events) ? events : [];
    arr.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    state.activity = arr.slice(0, ACTIVITY_MAX);
    for (const ev of arr) if (typeof ev.id === "number" && ev.id > state.lastEventId) state.lastEventId = ev.id;
  } catch (err) {
    reportError(err, "Could not load activity");
    return;
  }
  renderActivity();
}

function renderActivity() {
  const list = clear($("#activity-list"));
  if (!state.activity.length) list.append(el("li", { class: "empty", text: "No activity yet." }));
  for (const ev of state.activity) list.append(activityRow(ev));
}

function activityRow(ev) {
  return el("li", { class: "activity-row" }, [
    el("span", { class: "ts", text: timeOf(ev.ts), title: dateTimeOf(ev.ts) }),
    el("span", { class: "type", text: ev.type }),
    el("span", { class: "desc", text: describeEvent(ev) }),
  ]);
}

function pushActivity(ev) {
  if (typeof ev.id === "number" && ev.id > state.lastEventId) state.lastEventId = ev.id;
  if (state.activity.some((e) => e.id === ev.id)) return;
  state.activity.unshift(ev);
  if (state.activity.length > ACTIVITY_MAX) state.activity.length = ACTIVITY_MAX;
  if (state.tab === "activity") {
    const list = $("#activity-list");
    const empty = list.querySelector(".empty");
    if (empty) empty.remove();
    list.prepend(activityRow(ev));
    while (list.children.length > ACTIVITY_MAX) list.lastChild.remove();
  }
}

function describeEvent(ev) {
  const p = ev.payload || {};
  const str = (v, max = 120) => {
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  switch (ev.type) {
    case "task.created":
      return `Task created: ${str(p.title)}${p.source ? ` (${p.source})` : ""}`;
    case "task.assigned":
      return `Assigned to ${leadName(p.lead) || str(p.lead)}${p.priority ? `, priority ${p.priority}` : ""}${p.title ? `: ${str(p.title)}` : ""}`;
    case "task.split":
      return `Split into ${Array.isArray(p.children) ? p.children.length : p.count ?? "several"} subtasks`;
    case "task.parked":
      return `Parked${p.reason ? `: ${str(p.reason)}` : ""}`;
    case "task.progress":
      return str(p.text || p.message || p.summary) || "Progress";
    case "task.done":
      return `Done${p.summary ? `: ${str(p.summary)}` : ""}`;
    case "task.failed":
      return `Failed${p.error || p.reason ? `: ${str(p.error || p.reason)}` : ""}`;
    case "task.cancelled":
      return `Cancelled${p.reason ? `: ${str(p.reason)}` : ""}`;
    case "task.status":
      return `Status → ${str(p.status)}${p.previous ? ` (was ${p.previous})` : ""}${p.reason ? ` · ${str(p.reason)}` : ""}`;
    case "item.created":
      return `${p.kind ? `${p.kind}: ` : ""}${str(p.title) || "new queue item"}`;
    case "item.answered":
      return `Answered ${p.kind || "item"}: ${str(p.option)}${p.comment ? ` — ${str(p.comment)}` : ""}`;
    case "item.undone":
      return "Answer undone";
    case "item.updated":
      return p.deferred_until ? `Deferred until ${dateTimeOf(p.deferred_until)}` : `Item updated ${str(p)}`;
    case "run.started":
      return `Run started: ${str(p.agent)}`;
    case "run.progress":
      return `${str(p.agent)}: ${str(p.text, 100)}`;
    case "run.finished": {
      const cost = p.cost ?? p.cost_usd; // the runner emits `cost`
      return `Run finished: ${str(p.agent)}${p.status ? ` (${p.status})` : ""}${cost !== undefined ? ` · ${money(cost)}` : ""}`;
    }
    case "brain.updated":
      return `Brain updated${p.source ? ` by ${p.source}` : ""}${p.changelog ? `: ${str(p.changelog)}` : ""}`;
    case "harness.paused":
      return "Agents paused";
    case "harness.resumed":
      return "Agents resumed";
    case "approval.applied":
      return `${p.ok ? "Approval applied" : "Approval failed"}: ${str(p.message)}${p.url ? ` ${p.url}` : ""}`;
    default:
      return str(p) || ev.type;
  }
}

// ---------------------------------------------------------------- new task modal

function openNewTask() {
  closeHelp();
  fillLeadSelects();
  updateRepoSelect();
  $("#new-task-modal").classList.remove("hidden");
  $("#nt-title").focus();
}

function closeNewTask() {
  $("#new-task-modal").classList.add("hidden");
}

function updateRepoSelect() {
  const leadId = $("#nt-lead").value;
  const lead = state.state?.leads?.find((l) => l.id === leadId);
  const label = $("#nt-repo-label");
  const sel = clear($("#nt-repo"));
  if (lead && Array.isArray(lead.repos) && lead.repos.length) {
    sel.append(el("option", { value: "", text: "No repo" }));
    for (const r of lead.repos) sel.append(el("option", { value: r, text: r }));
    label.classList.remove("hidden");
  } else {
    label.classList.add("hidden");
  }
}

async function submitNewTask(e) {
  if (e) e.preventDefault();
  const title = $("#nt-title").value.trim();
  if (!title) {
    $("#nt-title").focus();
    return;
  }
  const body = { title, brief: $("#nt-brief").value, priority: Number($("#nt-priority").value) || 3 };
  const lead = $("#nt-lead").value;
  if (lead) body.lead = lead;
  const repo = $("#nt-repo").value;
  if (lead && repo && !$("#nt-repo-label").classList.contains("hidden")) body.repo = repo;
  const btn = $("#nt-submit");
  btn.disabled = true;
  try {
    const task = await post("/api/tasks", body);
    toast(`Task created: ${task.title}${task.lead ? ` → ${leadName(task.lead)}` : " → chief will triage"}`);
    $("#new-task-form").reset();
    $("#nt-priority").value = "3";
    closeNewTask();
    switchTab("tasks");
    await refreshState();
  } catch (err) {
    reportError(err, "Could not create the task");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- help & lightbox

function openHelp() {
  $("#help-overlay").classList.remove("hidden");
  $("#help-close").focus();
}
function closeHelp() {
  $("#help-overlay").classList.add("hidden");
}
function helpOpen() {
  return !$("#help-overlay").classList.contains("hidden");
}
/** True while any dialog, drawer or lightbox is open; shortcuts must not act on what is hidden behind it. */
function overlayOpen() {
  return ["#lightbox", "#help-overlay", "#new-task-modal", "#task-drawer"].some((sel) => !$(sel).classList.contains("hidden"));
}

function openLightbox(url, caption) {
  $("#lightbox-img").src = url;
  $("#lightbox-img").alt = caption || "";
  $("#lightbox-caption").textContent = caption || "";
  $("#lightbox").classList.remove("hidden");
  $("#lightbox-close").focus();
}
function closeLightbox() {
  $("#lightbox").classList.add("hidden");
  $("#lightbox-img").src = "";
}

/** Close the topmost overlay; returns true if something was closed. */
function closeAnyOverlay() {
  if (!$("#lightbox").classList.contains("hidden")) return closeLightbox(), true;
  if (helpOpen()) return closeHelp(), true;
  if (!$("#new-task-modal").classList.contains("hidden")) return closeNewTask(), true;
  if (!$("#task-drawer").classList.contains("hidden")) return closeTaskDrawer(), true;
  return false;
}

// ---------------------------------------------------------------- keyboard

function onKeyDown(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    if (closeAnyOverlay()) e.preventDefault();
    else if (isTyping(e.target)) e.target.blur();
    return;
  }
  if (mod && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    openNewTask();
    return;
  }
  if (mod && e.key === "Enter") {
    if (!$("#new-task-modal").classList.contains("hidden")) {
      e.preventDefault();
      void submitNewTask();
      return;
    }
    if (overlayOpen()) return;
    if (state.tab === "queue" && !isTyping(e.target)) {
      e.preventDefault();
      void submitAnswer();
    }
    return;
  }
  if (isTyping(e.target) || mod || e.altKey) return;
  if (overlayOpen()) return;

  if (state.pendingChord === "g") {
    state.pendingChord = null;
    const tab = TAB_KEYS[e.key];
    if (tab) {
      e.preventDefault();
      switchTab(tab);
    }
    return;
  }

  switch (e.key) {
    case "?":
      e.preventDefault();
      openHelp();
      return;
    case "g":
      state.pendingChord = "g";
      setTimeout(() => {
        if (state.pendingChord === "g") state.pendingChord = null;
      }, 1500);
      return;
    case "n":
      e.preventDefault();
      openNewTask();
      return;
    case "u":
      e.preventDefault();
      void undoLast();
      return;
    default:
      break;
  }
  if (state.tab !== "queue") return;
  queueKey(e);
}

function queueKey(e) {
  const k = e.key;
  if (k === "j" || k === "ArrowDown") return e.preventDefault(), moveSelection(1);
  if (k === "k" || k === "ArrowUp") return e.preventDefault(), moveSelection(-1);
  if (k === "Enter") {
    // Only take over Enter on the page body or the list; a focused button or link must keep its native activation.
    const t = e.target;
    const onList = t === document.body || (t instanceof Element && t.closest("#queue-list") !== null);
    if (!onList) return;
    e.preventDefault();
    if (state.selectedId) {
      if (!state.detail || state.detail.item.id !== state.selectedId) void openItem(state.selectedId);
      const first = $(".option-btn.selected") || $(".option-btn");
      if (first) first.focus();
    }
    return;
  }
  if (/^[1-9]$/.test(k)) return e.preventDefault(), chooseOptionByIndex(Number(k));
  if (k === "a") {
    e.preventDefault();
    if (state.detail?.item.recommended) chooseOption(state.detail.item.recommended);
    else chooseByKeys(POSITIVE_KEYS);
    return;
  }
  if (k === "r") {
    e.preventDefault();
    if (!chooseByKeys(["request_changes", "answer"])) {
      const ta = $("#comment");
      if (ta) ta.focus();
    }
    return;
  }
  if (k === "x") return e.preventDefault(), void chooseByKeys(NEGATIVE_KEYS);
  if (k === "d") return e.preventDefault(), void deferItem();
  if (k === "s") return e.preventDefault(), skipItem();
  if (k === "c") {
    e.preventDefault();
    const ta = $("#comment");
    if (ta) ta.focus();
    return;
  }
  if (k === "v") return e.preventDefault(), toggleVoice();
  return undefined;
}

// ---------------------------------------------------------------- voice

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let voiceBase = "";

function setupMicButton() {
  const btn = $("#mic-btn");
  if (!btn) return;
  if (!SpeechRecognitionCtor) {
    btn.classList.add("hidden");
    if (!state.micShown) {
      state.micShown = true;
      const note = $("#listening-note");
      if (note) {
        note.textContent = "Voice dictation is not available in this browser; type your comment instead.";
        note.classList.remove("hidden");
        note.classList.add("muted");
        note.style.color = "";
      }
    }
    return;
  }
  btn.addEventListener("click", toggleVoice);
}

function toggleVoice() {
  if (!SpeechRecognitionCtor) {
    toast("Voice dictation is not available in this browser");
    return;
  }
  if (recognition) stopVoice();
  else startVoice();
}

function startVoice() {
  const ta = $("#comment");
  if (!ta) return;
  try {
    recognition = new SpeechRecognitionCtor();
  } catch (err) {
    reportError(err, "Could not start the microphone");
    recognition = null;
    return;
  }
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  voiceBase = ta.value ? `${ta.value.replace(/\s+$/, "")} ` : "";
  recognition.onresult = (event) => {
    let finalText = "";
    let interim = "";
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    ta.value = `${voiceBase}${finalText}${interim}`.replace(/\s+/g, " ");
  };
  recognition.onerror = (event) => {
    console.warn("speech recognition error", event.error);
    if (event.error !== "no-speech" && event.error !== "aborted") toast(`Microphone: ${event.error}`, { error: true });
    stopVoice();
  };
  recognition.onend = () => {
    if (recognition) stopVoice();
  };
  recognition.start();
  setListeningUi(true);
}

function stopVoice() {
  if (recognition) {
    const r = recognition;
    recognition = null;
    try {
      r.onend = null;
      r.stop();
    } catch (err) {
      console.warn("speech stop failed", err);
    }
  }
  setListeningUi(false);
}

function setListeningUi(on) {
  const btn = $("#mic-btn");
  const note = $("#listening-note");
  if (btn) {
    btn.classList.toggle("listening", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Stop dictating (v)" : "Dictate (v)";
  }
  if (note && SpeechRecognitionCtor) {
    note.textContent = "Listening… speak your comment. Press v or the mic to stop.";
    note.classList.toggle("hidden", !on);
  }
}

// ---------------------------------------------------------------- sse

const EVENT_TYPES = [
  "task.created", "task.assigned", "task.split", "task.parked", "task.progress", "task.done", "task.failed", "task.cancelled", "task.status",
  "item.created", "item.answered", "item.undone", "item.updated",
  "run.started", "run.progress", "run.finished",
  "brain.updated", "harness.paused", "harness.resumed", "approval.applied",
];
let source = null;
const refreshTimers = {};

/** Coalesce bursts of events into one refresh per key. */
function debounced(key, fn, ms = 250) {
  clearTimeout(refreshTimers[key]);
  refreshTimers[key] = setTimeout(() => void fn(), ms);
}

function handleEvent(ev) {
  pushActivity(ev);
  const t = ev.type;
  if (t.startsWith("item.")) {
    debounced("queue", () => (state.tab === "queue" ? refreshQueue() : Promise.resolve()));
    debounced("state", refreshState);
  } else if (t.startsWith("task.")) {
    if (state.tab === "tasks") debounced("tasks", refreshTasks);
    if (state.tab === "agents") debounced("agents", refreshAgents);
    debounced("state", refreshState);
    const drawer = $("#task-drawer");
    if (!drawer.classList.contains("hidden") && $("#task-drawer-body").dataset.taskId === ev.task_id) debounced("drawer", () => openTaskDrawer(ev.task_id));
  } else if (t === "run.progress") {
    if (state.tab === "agents") applyRunProgress(ev);
  } else if (t === "run.started" || t === "run.finished") {
    if (state.tab === "agents") debounced("agents", refreshAgents);
    debounced("state", refreshState, 1000);
  } else if (t === "brain.updated") {
    if (state.tab === "brain") debounced("brain", refreshBrain);
  } else if (t === "harness.paused" || t === "harness.resumed") {
    debounced("state", refreshState);
  }
}

function connectStream() {
  if (!("EventSource" in window)) {
    startPolling();
    return;
  }
  source = new EventSource("/api/events/stream");
  const onMessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch (err) {
      console.warn("bad event payload", err, msg.data);
      return;
    }
    if (!ev || typeof ev !== "object") return;
    if (!ev.type) ev.type = msg.type;
    handleEvent(ev);
  };
  for (const type of EVENT_TYPES) source.addEventListener(type, onMessage);
  source.addEventListener("message", onMessage);
  source.onopen = () => {
    state.sseErrors = 0;
    stopPolling();
    $("#offline-banner").classList.add("hidden");
    if (state.streamLost) {
      state.streamLost = false;
      void resync();
    }
  };
  source.onerror = () => {
    state.streamLost = true;
    state.sseErrors++;
    if (state.sseErrors >= 2) {
      source.close();
      source = null;
      startPolling();
      setTimeout(connectStream, POLL_MS);
    }
  };
}

/** After an outage: refetch what is on screen and replay the events missed meanwhile into the activity feed. */
async function resync() {
  await Promise.all([refreshState(), loadTab(state.tab)]);
  if (!state.lastEventId) return;
  try {
    const missed = await get(`/api/events?since=${encodeURIComponent(state.lastEventId)}`);
    const arr = Array.isArray(missed) ? missed : [];
    arr.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    for (const ev of arr) if (ev && typeof ev === "object" && ev.type) pushActivity(ev);
  } catch (err) {
    console.warn("could not catch up on events", err);
  }
}

function startPolling() {
  if (state.polling) return;
  $("#offline-banner").classList.remove("hidden");
  state.polling = setInterval(() => {
    void refreshState();
    void loadTab(state.tab);
  }, POLL_MS);
}

function stopPolling() {
  if (!state.polling) return;
  clearInterval(state.polling);
  state.polling = null;
  $("#offline-banner").classList.add("hidden");
}

// ---------------------------------------------------------------- boot

function bindUi() {
  for (const b of $$(".tab")) b.addEventListener("click", () => switchTab(b.dataset.tab));
  $("#pause-toggle").addEventListener("click", () => void togglePause());
  $("#new-task-btn").addEventListener("click", openNewTask);
  $("#help-btn").addEventListener("click", openHelp);
  $("#help-close").addEventListener("click", closeHelp);
  $("#help-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeHelp();
  });
  $("#new-task-close").addEventListener("click", closeNewTask);
  $("#new-task-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeNewTask();
  });
  $("#new-task-form").addEventListener("submit", (e) => void submitNewTask(e));
  $("#nt-lead").addEventListener("change", updateRepoSelect);
  $("#task-drawer-close").addEventListener("click", closeTaskDrawer);
  $("#task-drawer-backdrop").addEventListener("click", closeTaskDrawer);
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target === e.currentTarget || e.target.id === "lightbox-img") closeLightbox();
  });
  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#filter-kind").addEventListener("change", (e) => {
    state.filters.kind = e.target.value;
    store("filters", state.filters);
    void refreshQueue({ keepSelection: false });
  });
  $("#filter-lead").addEventListener("change", (e) => {
    state.filters.lead = e.target.value;
    store("filters", state.filters);
    void refreshQueue({ keepSelection: false });
  });
  $("#brain-save").addEventListener("click", () => void saveBrain());
  $("#brain-distill").addEventListener("click", () => void distillBrainNow());
  $("#brain-back-current").addEventListener("click", backToCurrentBrain);
  const ta = $("#brain-editor");
  ta.addEventListener("input", () => {
    ta.dataset.touched = "1";
    $("#brain-dirty").textContent = ta.value === ta.dataset.loadedFor ? "" : "Unsaved changes";
  });
  window.addEventListener("beforeunload", (e) => {
    if (ta.dataset.touched === "1" && ta.value !== ta.dataset.loadedFor) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  document.addEventListener("keydown", onKeyDown);
  setInterval(() => {
    if (state.tab === "queue" && !isTyping(document.activeElement)) renderQueueList();
  }, 60_000);
}

async function boot() {
  const filters = load("filters", { kind: "", lead: "" });
  state.filters = { kind: filters.kind || "", lead: filters.lead || "" };
  $("#filter-kind").value = state.filters.kind;
  bindUi();
  await refreshState();
  $("#filter-lead").value = state.filters.lead;
  const tab = load("tab", "queue");
  switchTab(TABS.includes(tab) ? tab : "queue");
  if (state.tab !== "queue") void refreshQueue();
  connectStream();
}

void boot();
