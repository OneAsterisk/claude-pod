// Claude Pod harness frontend. Plain DOM, no build step.
// Server text goes through textContent, except message bodies, which are
// rendered as markdown with raw HTML escaped and the result sanitized.

import { Marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (sel, root = document) => root.querySelector(sel);

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Show tags like <bash-input> or <system-reminder> as text instead of HTML.
    html: ({ text }) => `<span class="tag">${escapeHtml(text)}</span>`,
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function md(text) {
  const div = document.createElement("div");
  div.className = "md";
  div.innerHTML = DOMPurify.sanitize(marked.parse(text));
  return div;
}

function toolSummary(name, input = {}) {
  const detail =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof detail !== "string") return name;
  const line = detail.split("\n")[0];
  return `${name}: ${line.length > 120 ? line.slice(0, 120) + "…" : line}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const post = (path, body = {}) => api(path, { method: "POST", body });

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const state = {
  repos: [],
  sessions: [],
  selected: null,
  eventSource: null,
  seen: new Set(),
  toolRows: new Map(), // tool_use id -> { row, body }, so results land under their call
};

// ---------- Repos / worktrees ----------

function repoForPath(p) {
  for (const r of state.repos) {
    if (r.worktrees.some((w) => w.path === p)) return r.name;
  }
  return null;
}

const GENERAL_LABEL = "General (no repo)";

function worktreeLabel(p) {
  if (p && p === state.generalDir) return GENERAL_LABEL;
  for (const r of state.repos) {
    const w = r.worktrees.find((w) => w.path === p);
    if (w) return `${r.name} · ${w.main ? "main checkout" : w.branch ?? w.path.split("/").pop()}`;
  }
  // Sessions from folders the harness does not manage: show just the tail of the path.
  return p ? p.split("/").filter(Boolean).slice(-2).join("/") : "unknown";
}

async function loadRepos() {
  const data = await api("/api/repos");
  state.repos = data.repos;
  state.generalDir = data.generalDir;
  const filter = $("#repo-filter");
  const current = filter.value;
  filter.replaceChildren(
    el("option", { value: "" }, "All repos"),
    ...state.repos.map((r) => el("option", { value: r.name }, r.name)),
    el("option", { value: "__general" }, GENERAL_LABEL),
  );
  filter.value = current;
  const wtRepo = $("#wt-repo");
  const wtCurrent = wtRepo.value;
  wtRepo.replaceChildren(...state.repos.map((r) => el("option", { value: r.name }, r.name)));
  if (wtCurrent) wtRepo.value = wtCurrent;
  renderWorktrees();
}

function renderWorktrees() {
  const root = $("#worktree-list");
  root.replaceChildren(
    ...state.repos.map((r) =>
      el(
        "div",
        { class: "repo" },
        el("h3", {}, r.name),
        ...r.worktrees.map((w) => worktreeCard(r.name, w)),
      ),
    ),
  );
  if (!state.repos.length) root.append(el("p", { class: "repo" }, "No repos found in the repos directory."));
}

function worktreeCard(repo, w) {
  const devRow = w.dev
    ? [
        el("a", { href: w.dev.url, target: "_blank", rel: "noopener" }, `Open :${w.dev.port}`),
        el("button", { onclick: () => post("/api/dev/stop", { path: w.path }).then(loadRepos).catch(alert) }, "Stop dev server"),
      ]
    : [el("button", { onclick: () => post("/api/dev/start", { path: w.path }).then(loadRepos).catch((e) => alert(e.message)) }, "Start dev server")];

  return el(
    "div",
    { class: "wt" },
    el(
      "div",
      { class: "row" },
      el("strong", {}, w.main ? "main checkout" : w.branch ?? "(detached)"),
      el("span", { class: "path" }, w.path),
    ),
    el(
      "div",
      { class: "row", style: "margin-top:8px" },
      el("button", { class: "primary", onclick: () => openNewSession(w.path) }, "New session here"),
      el("button", { onclick: () => openChanges(w.path) }, "View changes"),
      ...devRow,
      !w.main &&
        el(
          "button",
          {
            class: "danger",
            onclick: async () => {
              if (!confirm(`Remove worktree ${w.path}? Uncommitted changes block this unless you force it.`)) return;
              try {
                await post("/api/worktrees/remove", { repo, path: w.path });
              } catch (e) {
                if (!confirm(`${e.message}\n\nForce remove and discard changes?`)) return;
                await post("/api/worktrees/remove", { repo, path: w.path, force: true }).catch((e2) => alert(e2.message));
              }
              loadRepos();
            },
          },
          "Remove",
        ),
    ),
    w.dev && el("details", {}, el("summary", {}, "Dev server log"), el("pre", {}, w.dev.log.join("\n"))),
  );
}

$("#wt-add").addEventListener("click", async () => {
  const repo = $("#wt-repo").value;
  const name = $("#wt-name").value.trim();
  if (!repo || !name) return alert("Pick a repo and enter a name.");
  try {
    await post("/api/worktrees", { repo, name, base: $("#wt-base").value.trim() || undefined });
    $("#wt-name").value = "";
    await loadRepos();
  } catch (e) {
    alert(e.message);
  }
});

// ---------- Session list ----------

async function loadSessions() {
  state.sessions = await api("/api/sessions");
  renderSessionList();
}

function renderSessionList() {
  const filter = $("#repo-filter").value;
  const items = state.sessions.filter(
    (s) => !filter || (filter === "__general" ? s.cwd === state.generalDir : repoForPath(s.cwd) === filter),
  );
  $("#session-list").replaceChildren(
    ...items.map((s) =>
      el(
        "li",
        { class: s.sessionId === state.selected ? "selected" : "", onclick: () => openSession(s.sessionId) },
        el("div", { class: "title" }, s.customTitle || s.summary || s.firstPrompt || s.sessionId),
        el(
          "div",
          { class: "meta" },
          el("span", {}, worktreeLabel(s.cwd)),
          el("span", {}, ago(s.lastModified)),
          s.live && el("span", { class: `badge ${s.live}` }, s.live),
          s.pendingApprovals > 0 && el("span", { class: "badge approval" }, `${s.pendingApprovals} approval`),
        ),
      ),
    ),
  );
}

$("#repo-filter").addEventListener("change", renderSessionList);

// ---------- Image attachments ----------

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;

/** Attach button + thumbnail tray. Also wires paste and drag-drop onto a target. */
function createAttachments() {
  const items = []; // { mediaType, data, url }
  const tray = el("div", { class: "attachments" });
  const input = el("input", { type: "file", accept: IMAGE_TYPES.join(","), multiple: true, hidden: true });
  const button = el("button", { type: "button", title: "Attach images (or paste / drop them)", onclick: () => input.click() }, "Attach image");
  input.addEventListener("change", () => {
    add(input.files);
    input.value = "";
  });

  function render() {
    tray.replaceChildren(
      ...items.map((it, i) =>
        el(
          "div",
          { class: "thumb" },
          el("img", { src: it.url, alt: "" }),
          el("button", { type: "button", class: "remove", title: "Remove", onclick: () => (items.splice(i, 1), render()) }, "×"),
        ),
      ),
    );
    tray.hidden = !items.length;
  }

  async function add(files) {
    for (const f of [...files]) {
      if (!IMAGE_TYPES.includes(f.type)) {
        alert(`${f.name || "File"}: only PNG, JPEG, GIF, or WebP images.`);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        alert(`${f.name || "Image"} is over 5 MB.`);
        continue;
      }
      if (items.length >= MAX_IMAGES) {
        alert(`At most ${MAX_IMAGES} images per message.`);
        break;
      }
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      items.push({ mediaType: f.type, data: url.split(",")[1], url });
    }
    render();
  }

  function wire(target) {
    target.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    });
    target.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault();
    });
    target.addEventListener("drop", (e) => {
      if (e.dataTransfer?.files.length) {
        e.preventDefault();
        add(e.dataTransfer.files);
      }
    });
  }

  render();
  return {
    tray,
    input,
    button,
    wire,
    images: () => items.map(({ mediaType, data }) => ({ mediaType, data })),
    previews: () => items.map((it) => it.url),
    clear: () => ((items.length = 0), render()),
  };
}

// ---------- Thread ----------

function imageSrc(block) {
  const src = block.source;
  if (src?.type === "base64") return `data:${src.media_type};base64,${src.data}`;
  if (src?.type === "url" && /^https:/.test(src.url)) return src.url;
  return null;
}

function bubble(role, text, imageUrls = []) {
  if (role === "assistant") return text?.trim() ? el("div", { class: "assistant" }, md(text)) : null;
  return el(
    "div",
    { class: "msg user" },
    imageUrls.length > 0 && el("div", { class: "images" }, ...imageUrls.map((u) => el("img", { src: u, alt: "attached image" }))),
    text?.trim() && md(text),
  );
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text : "")).join("");
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Tool calls and thinking collect into one bordered box until text breaks the run. */
function stepsGroup(box) {
  const last = box.lastElementChild;
  if (last?.classList.contains("steps")) return last;
  const group = el("div", { class: "steps" });
  box.append(group);
  return group;
}

function stepRow(label, { muted = false } = {}) {
  const body = el("div", { class: "step-body" });
  const row = el("details", { class: `step${muted ? " muted" : ""}` }, el("summary", {}, el("span", { class: "label" }, label), el("span", { class: "chev" }, "›")), body);
  return { row, body };
}

function renderToolUse(box, block) {
  const { row, body } = stepRow(toolSummary(block.name, block.input));
  body.append(el("div", { class: "step-section" }, "Input"), el("pre", {}, JSON.stringify(block.input, null, 2)));
  state.toolRows.set(block.id, { row, body });
  stepsGroup(box).append(row);
}

function renderToolResult(box, block) {
  const text = textOf(block.content) || JSON.stringify(block.content ?? "");
  const shown = text.length > 20000 ? text.slice(0, 20000) + "\n…(truncated)" : text;
  let target = state.toolRows.get(block.tool_use_id);
  if (!target) {
    // Result without a visible call (for example, history paged out): give it its own row.
    target = stepRow(`Result: ${clip(text.split("\n").find((l) => l.trim()) ?? "", 80)}`);
    stepsGroup(box).append(target.row);
  }
  if (block.is_error) target.row.classList.add("error");
  target.body.append(el("div", { class: "step-section" }, block.is_error ? "Error" : "Output"), el("pre", {}, shown || "(empty)"));
}

function renderThinking(box, block) {
  const text = block.thinking?.trim();
  if (!text) return; // Thinking that was not saved (display omitted) has no text to show.
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  const { row, body } = stepRow(`Thinking: ${clip(firstLine.replace(/[*_#`]/g, ""), 90)}`, { muted: true });
  body.append(el("div", { class: "thinking" }, md(text)));
  stepsGroup(box).append(row);
}

/** Render one API message (user or assistant) into the thread container. */
function renderApiMessage(box, role, message) {
  const content = message?.content;
  if (typeof content === "string") {
    const node = bubble(role, content);
    if (node) box.append(node);
    return;
  }
  if (!Array.isArray(content)) return;
  let blocks = content;
  const images = blocks.filter((b) => b.type === "image").map(imageSrc).filter(Boolean);
  if (images.length) {
    // Show images and their caption together in one bubble.
    const caption = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
    box.append(bubble(role, caption, images));
    blocks = blocks.filter((b) => b.type !== "image" && b.type !== "text");
  }
  for (const block of blocks) {
    if (block.type === "text" && block.text?.trim()) {
      const node = bubble(role, block.text);
      if (node) box.append(node);
    } else if (block.type === "tool_use") renderToolUse(box, block);
    else if (block.type === "tool_result") renderToolResult(box, block);
    else if (block.type === "thinking") renderThinking(box, block);
  }
}

/** Render a SessionMessage from disk or an SDKMessage from the live stream. */
function renderEntry(box, entry) {
  if (entry.uuid) {
    if (state.seen.has(entry.uuid)) return;
    state.seen.add(entry.uuid);
  }
  if (entry.type === "assistant") renderApiMessage(box, "assistant", entry.message);
  else if (entry.type === "user") renderApiMessage(box, "user", entry.message);
  else if (entry.type === "result") {
    const cost = entry.total_cost_usd != null ? ` · $${entry.total_cost_usd.toFixed(4)}` : "";
    const secs = entry.duration_ms ? ` · ${Math.round(entry.duration_ms / 1000)}s` : "";
    box.append(el("div", { class: "result" }, `Turn ${entry.subtype}${secs}${cost}`));
  }
}

/** Append to the open thread, keeping the view pinned to the bottom if it was. */
function withAutoScroll(fn) {
  const box = $("#messages");
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  fn(box);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function appendToThread(nodes) {
  withAutoScroll((box) => box.append(...nodes.filter(Boolean)));
}

function renderApproval(sessionId, a) {
  const node = el(
    "div",
    { class: "approval", id: `approval-${a.id}` },
    el("strong", {}, a.title || `Claude wants to use ${a.toolName}`),
    el("pre", {}, JSON.stringify(a.input, null, 2)),
    el(
      "div",
      { class: "row", style: "display:flex;gap:8px" },
      el("button", { class: "primary", onclick: () => post(`/api/sessions/${sessionId}/approvals/${a.id}`, { allow: true }).catch((e) => alert(e.message)) }, "Allow"),
      el(
        "button",
        {
          class: "danger",
          onclick: () => {
            const message = prompt("Reason (sent to Claude), optional:") ?? "";
            post(`/api/sessions/${sessionId}/approvals/${a.id}`, { allow: false, message }).catch((e) => alert(e.message));
          },
        },
        "Deny",
      ),
    ),
  );
  return node;
}

function setLiveStatus(status) {
  const badge = $("#live-status");
  if (!badge) return;
  badge.textContent = status ?? "not running";
  badge.className = `badge ${status ?? "idle"}`;
  $("#interrupt-btn").disabled = status !== "running";
  $("#stop-btn").disabled = !status || status === "ended";
}

function showSessionList() {
  $("#view-sessions").classList.remove("show-thread");
}

async function openSession(sessionId) {
  state.selected = sessionId;
  $("#view-sessions").classList.add("show-thread");
  state.seen = new Set();
  state.toolRows = new Map();
  state.eventSource?.close();
  renderSessionList();

  const meta = state.sessions.find((s) => s.sessionId === sessionId);
  state.composerAtt = createAttachments();
  const thread = $("#thread");
  thread.replaceChildren(
    el(
      "div",
      { class: "thread-head" },
      el("button", { class: "back", title: "Back to sessions", onclick: showSessionList }, "‹"),
      el("div", { class: "grow" }, el("strong", {}, meta?.customTitle || meta?.summary || sessionId), el("div", { class: "meta" }, worktreeLabel(meta?.cwd), meta?.gitBranch && ` · ${meta.gitBranch}`)),
      el("span", { id: "live-status", class: "badge idle" }, "…"),
      meta?.cwd && meta.cwd !== state.generalDir && el("button", { onclick: () => openChanges(meta.cwd) }, "Changes"),
      el("button", { onclick: renameCurrent }, "Rename"),
      el("button", { id: "interrupt-btn", onclick: () => post(`/api/sessions/${sessionId}/interrupt`).catch((e) => alert(e.message)) }, "Interrupt"),
      el("button", { id: "stop-btn", class: "danger", onclick: () => post(`/api/sessions/${sessionId}/stop`).catch((e) => alert(e.message)) }, "Stop"),
    ),
    el("div", { class: "messages", id: "messages" }, el("div", { class: "result" }, "Loading…")),
    el(
      "div",
      { class: "composer" },
      el("textarea", { id: "composer-text", rows: 3, placeholder: "Message Claude (⌘/Ctrl+Enter to send). Paste or drop images." }),
      state.composerAtt.tray,
      el(
        "div",
        { class: "row" },
        state.composerAtt.button,
        state.composerAtt.input,
        el("span", { style: "flex:1" }),
        el(
          "select",
          { id: "composer-mode", title: "Permission mode (applies when resuming a session that is not running)" },
          ...["default", "acceptEdits", "auto", "plan", "bypassPermissions"].map((m) => el("option", { value: m }, m)),
        ),
        el("button", { class: "primary", onclick: sendCurrent }, "Send"),
      ),
    ),
  );
  state.composerAtt.wire($(".composer"));
  $("#composer-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendCurrent();
  });

  // Subscribe first so nothing is missed between the history fetch and the stream.
  const buffered = [];
  let historyLoaded = false;
  connectEvents(sessionId, (e) => (historyLoaded ? handleEvent(sessionId, e) : buffered.push(e)));

  const data = await api(`/api/sessions/${sessionId}`);
  if (state.selected !== sessionId) return;
  const box = $("#messages");
  box.replaceChildren();
  for (const m of data.messages) renderEntry(box, m);
  for (const a of data.approvals) box.append(renderApproval(sessionId, a));
  box.scrollTop = box.scrollHeight;
  setLiveStatus(data.live);
  historyLoaded = true;
  for (const e of buffered) handleEvent(sessionId, e);
}

function connectEvents(sessionId, onEvent) {
  const es = new EventSource(`/api/sessions/${sessionId}/events`);
  state.eventSource = es;
  for (const type of ["message", "status", "approval", "approval_resolved", "error"]) {
    es.addEventListener(type, (ev) => onEvent(JSON.parse(ev.data)));
  }
}

function handleEvent(sessionId, e) {
  if (state.selected !== sessionId) return;
  if (e.kind === "message") {
    // Our own typed prompts are rendered optimistically on send, so only
    // show live user messages that carry tool results.
    const m = e.message;
    const c = m.message?.content;
    if (m.type === "user" && !(Array.isArray(c) && c.some((b) => b.type === "tool_result"))) return;
    withAutoScroll((box) => renderEntry(box, m));
  } else if (e.kind === "status") {
    setLiveStatus(e.status === "ended" ? null : e.status);
    if (e.status === "ended") state.eventSource?.close();
    loadSessions();
  } else if (e.kind === "approval") {
    appendToThread([renderApproval(sessionId, e.approval)]);
    loadSessions();
  } else if (e.kind === "approval_resolved") {
    document.getElementById(`approval-${e.id}`)?.remove();
    loadSessions();
  } else if (e.kind === "error") {
    appendToThread([el("div", { class: "notice error" }, e.error)]);
  }
}

async function sendCurrent() {
  const sessionId = state.selected;
  const box = $("#composer-text");
  const text = box.value.trim();
  const att = state.composerAtt;
  const images = att.images();
  if (!sessionId || (!text && !images.length)) return;
  appendToThread([bubble("user", text, att.previews())]);
  box.value = "";
  att.clear();
  try {
    const wasLive = $("#live-status")?.textContent === "running" || $("#live-status")?.textContent === "idle";
    await post(`/api/sessions/${sessionId}/messages`, { text, images, permissionMode: $("#composer-mode").value });
    setLiveStatus("running");
    if (!wasLive) connectEvents(sessionId, (e) => handleEvent(sessionId, e));
  } catch (e) {
    appendToThread([el("div", { class: "notice error" }, e.message)]);
  }
}

async function renameCurrent() {
  const title = prompt("New title:");
  if (!title?.trim()) return;
  await post(`/api/sessions/${state.selected}/rename`, { title }).catch((e) => alert(e.message));
  loadSessions();
}

// ---------- New session dialog ----------

function openNewSession(cwd) {
  const select = $("#ns-cwd");
  select.replaceChildren(
    ...state.repos.flatMap((r) => r.worktrees.map((w) => el("option", { value: w.path }, worktreeLabel(w.path)))),
    state.generalDir && el("option", { value: state.generalDir }, GENERAL_LABEL),
  );
  if (cwd) select.value = cwd;
  $("#ns-new-wt").checked = false;
  $("#ns-wt-name-row").hidden = true;
  syncWorktreeOption();
  $("#ns-error").textContent = "";
  showView("sessions");
  $("#new-session").showModal();
}

const nsAtt = createAttachments();
$("#ns-attach").append(nsAtt.button, nsAtt.input, nsAtt.tray);
nsAtt.wire($("#new-session-form"));

$("#new-session-btn").addEventListener("click", () => openNewSession());
$("#ns-new-wt").addEventListener("change", (e) => ($("#ns-wt-name-row").hidden = !e.target.checked));

/** Worktrees only make sense inside a repo, so disable the option for General. */
function syncWorktreeOption() {
  const general = $("#ns-cwd").value === state.generalDir;
  $("#ns-new-wt").disabled = general;
  if (general) {
    $("#ns-new-wt").checked = false;
    $("#ns-wt-name-row").hidden = true;
  }
}
$("#ns-cwd").addEventListener("change", syncWorktreeOption);

$("#new-session-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const submit = $("#ns-submit");
  submit.disabled = true;
  $("#ns-error").textContent = "";
  try {
    let cwd = $("#ns-cwd").value;
    if ($("#ns-new-wt").checked) {
      const repo = repoForPath(cwd);
      const name = $("#ns-wt-name").value.trim();
      if (!name) throw new Error("Enter a worktree name.");
      cwd = (await post("/api/worktrees", { repo, name })).path;
      await loadRepos();
    }
    const { sessionId } = await post("/api/sessions", {
      cwd,
      prompt: $("#ns-prompt").value,
      images: nsAtt.images(),
      title: $("#ns-title").value,
      permissionMode: $("#ns-mode").value,
    });
    $("#new-session").close();
    $("#ns-prompt").value = "";
    $("#ns-title").value = "";
    nsAtt.clear();
    await loadSessions();
    await openSession(sessionId);
  } catch (err) {
    $("#ns-error").textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

// ---------- Changes (Monaco diff viewer) ----------

let monacoPromise = null;

/** Load Monaco's AMD build on first use. It is ~25 MB, so only fetch it when needed. */
function loadMonaco() {
  monacoPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/monaco/vs/loader.js";
    script.onerror = () => reject(new Error("Could not load the Monaco editor"));
    script.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => {
        const monaco = window.monaco;
        monaco.editor.defineTheme("runpod-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [],
          colors: {
            "editor.background": "#111111",
            "editorGutter.background": "#111111",
            "editorLineNumber.foreground": "#5a5670",
            "editor.selectionBackground": "#6d4aff55",
            "diffEditor.insertedTextBackground": "#3ccf9126",
            "diffEditor.removedTextBackground": "#ff7b7b26",
            "diffEditor.insertedLineBackground": "#3ccf9112",
            "diffEditor.removedLineBackground": "#ff7b7b12",
          },
        });
        resolve(monaco);
      }, reject);
    };
    document.head.append(script);
  });
  return monacoPromise;
}

const changesState = { cwd: null, files: [], selected: null, editor: null, models: [], seq: 0, inlineTouched: false };

const narrow = () => window.matchMedia("(max-width: 760px)").matches;

/** Pick the worktree the user most likely wants: the open session's, else the first non-main worktree. */
function defaultChangesCwd() {
  const session = state.sessions.find((s) => s.sessionId === state.selected);
  const known = new Set(state.repos.flatMap((r) => r.worktrees.map((w) => w.path)));
  if (session?.cwd && known.has(session.cwd)) return session.cwd;
  return state.repos.flatMap((r) => r.worktrees).find((w) => !w.main)?.path ?? state.repos[0]?.worktrees[0]?.path;
}

const STATUS_LABEL = { A: "added", M: "modified", D: "deleted", R: "renamed" };

async function openChanges(cwd) {
  if ($("#view-changes").hidden) showView("changes", { load: false });
  const select = $("#ch-wt");
  select.replaceChildren(
    ...state.repos.flatMap((r) => r.worktrees.map((w) => el("option", { value: w.path }, worktreeLabel(w.path)))),
  );
  const target = cwd ?? changesState.cwd ?? defaultChangesCwd();
  if (!target) {
    $("#ch-files").replaceChildren(el("li", { class: "diff-empty" }, "No repos found."));
    return;
  }
  select.value = target;
  if (changesState.cwd !== target) changesState.selected = null;
  changesState.cwd = target;
  // Side-by-side is unreadable on a phone, so start inline there unless the user chose otherwise.
  if (!changesState.inlineTouched) $("#ch-inline").checked = narrow();
  $(".changes").classList.remove("show-diff");
  await loadChangedFiles();
}

async function loadChangedFiles() {
  const { cwd } = changesState;
  const base = $("#ch-base").value;
  $("#ch-summary").textContent = "Loading…";
  try {
    const data = await api(`/api/changes?path=${encodeURIComponent(cwd)}&base=${base}`);
    changesState.files = data.files;
    $("#ch-summary").textContent = `${data.files.length} file${data.files.length === 1 ? "" : "s"} changed · vs ${data.ref.slice(0, 8)}`;
  } catch (e) {
    changesState.files = [];
    $("#ch-summary").textContent = e.message;
  }
  renderChangedFiles();
  const keep = changesState.files.find((f) => f.path === changesState.selected);
  if (keep) await showFileDiff(keep);
  else if (changesState.files[0] && !narrow()) await showFileDiff(changesState.files[0]);
  else if (changesState.files[0]) clearDiff("Pick a file to see its diff.");
  else {
    clearDiff(emptyChangesMessage());
    // On a phone the file list is the main view, so show the empty state there too.
    $("#ch-files").replaceChildren(el("li", { class: "diff-empty" }, narrow() ? emptyChangesMessage() : "No files changed."));
  }
}

function emptyChangesMessage() {
  const label = worktreeLabel(changesState.cwd);
  if ($("#ch-base").value === "uncommitted") {
    return el(
      "div",
      {},
      el("p", {}, `No uncommitted changes in ${label}.`),
      el(
        "button",
        {
          onclick: () => {
            $("#ch-base").value = "branch";
            loadChangedFiles();
          },
        },
        "Show the whole branch vs main",
      ),
    );
  }
  return `${label} has no changes compared to main.`;
}

function renderChangedFiles() {
  $("#ch-files").replaceChildren(
    ...changesState.files.map((f) =>
      el(
        "li",
        { class: f.path === changesState.selected ? "selected" : "", title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, onclick: () => showFileDiff(f) },
        el("span", { class: `st ${f.status}`, title: STATUS_LABEL[f.status] ?? f.status }, f.status),
        // RTL keeps the file name visible when a long path is truncated.
        el("span", { class: "p" }, "‎" + f.path),
      ),
    ),
  );
}

function disposeDiff() {
  changesState.editor?.setModel(null);
  for (const m of changesState.models) m.dispose();
  changesState.models = [];
}

function clearDiff(message) {
  disposeDiff();
  changesState.editor?.dispose();
  changesState.editor = null;
  $("#ch-file-title").textContent = "";
  $("#ch-editor").replaceChildren(el("div", { class: "diff-empty" }, message));
}

function sideText(side) {
  if (side.binary) return null;
  if (side.tooLarge) return null;
  return side.text;
}

async function showFileDiff(file) {
  changesState.selected = file.path;
  renderChangedFiles();
  const { cwd } = changesState;
  const base = $("#ch-base").value;
  const qs = `path=${encodeURIComponent(cwd)}&base=${base}&file=${encodeURIComponent(file.path)}` + (file.oldPath ? `&oldPath=${encodeURIComponent(file.oldPath)}` : "");
  $("#ch-file-title").textContent = `${STATUS_LABEL[file.status] ?? file.status} · ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`;
  $(".changes").classList.add("show-diff");
  let data, monaco;
  try {
    [data, monaco] = await Promise.all([api(`/api/changes/file?${qs}`), loadMonaco()]);
  } catch (e) {
    clearDiff(e.message);
    return;
  }
  if (changesState.selected !== file.path) return; // A newer click won.

  const original = sideText(data.original);
  const modified = sideText(data.modified);
  if (original === null || modified === null) {
    clearDiff(data.original.tooLarge || data.modified.tooLarge ? "File is over 2 MB, so it isn't shown." : "Binary file, not shown.");
    $("#ch-file-title").textContent = file.path;
    return;
  }

  if (!changesState.editor) {
    $("#ch-editor").replaceChildren();
    changesState.editor = monaco.editor.createDiffEditor($("#ch-editor"), {
      theme: "runpod-dark",
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: !$("#ch-inline").checked,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      renderOverviewRuler: true,
      hideUnchangedRegions: { enabled: true },
    });
  }
  disposeDiff();
  // Unique URIs per load so models never collide; the path's extension picks the language.
  const n = ++changesState.seq;
  const uri = (side, p) => monaco.Uri.from({ scheme: "harness", path: `/${n}/${side}/${p}` });
  const origModel = monaco.editor.createModel(original, undefined, uri("original", data.oldPath ?? data.file));
  const modModel = monaco.editor.createModel(modified, undefined, uri("modified", data.file));
  changesState.models = [origModel, modModel];
  changesState.editor.setModel({ original: origModel, modified: modModel });
}

$("#ch-wt").addEventListener("change", (e) => openChanges(e.target.value));
$("#ch-base").addEventListener("change", () => loadChangedFiles());
$("#ch-refresh").addEventListener("click", () => loadChangedFiles());
$("#ch-inline").addEventListener("change", (e) => {
  changesState.inlineTouched = true;
  changesState.editor?.updateOptions({ renderSideBySide: !e.target.checked });
});
$("#ch-back").addEventListener("click", () => $(".changes").classList.remove("show-diff"));

// ---------- Watcher (PR review automation) ----------

function when(ms) {
  return ms ? `${ago(ms)} (${new Date(ms).toLocaleTimeString()})` : "never";
}

function card(k, v, cls = "") {
  return el("div", { class: "wa-card" }, el("div", { class: "k" }, k), el("div", { class: `v ${cls}` }, v));
}

async function loadWatcher() {
  let w;
  try {
    w = await api("/api/watcher");
  } catch (e) {
    $("#wa-status").replaceChildren(card("Watcher", e.message, "bad"));
    return;
  }
  const slackState = !w.slack.configured ? ["No Slack token (see README)", "warn"] : w.slack.lastError ? [w.slack.lastError, "bad"] : [`OK · polled ${when(w.slack.lastPoll)}`, "ok"];
  const ghState = w.github.lastError ? [w.github.lastError, "bad"] : [`OK · polled ${when(w.github.lastPoll)}`, "ok"];
  $("#wa-status").replaceChildren(
    card("Watcher", w.enabled ? (w.dryRun ? "Enabled (dry run: logs only)" : "Enabled") : "Disabled", w.enabled ? (w.dryRun ? "warn" : "ok") : "bad"),
    card(`Slack DMs · every ${w.slack.intervalMs / 1000}s`, ...slackState),
    card(`GitHub · every ${w.github.intervalMs / 1000}s`, ...ghState),
    card("Limits", `${w.reviewsToday.count}/${w.maxReviewsPerDay} reviews today · max ${w.maxConcurrent} at once · orgs: ${w.allowedOwners.join(", ")}`),
  );

  $("#wa-prs").replaceChildren(
    ...w.prs.map((p) =>
      el(
        "div",
        { class: "wa-pr" },
        el(
          "div",
          { class: "row" },
          el("a", { href: p.url, target: "_blank", rel: "noopener" }, el("strong", {}, p.key)),
          p.running && el("span", { class: "badge running" }, "reviewing"),
          p.isDraft && el("span", { class: "badge idle" }, "draft"),
          p.fromSlack && el("span", { class: "badge approval" }, "from Slack"),
          el("span", { class: "sha" }, `head ${p.headSha?.slice(0, 8) ?? "?"} · last Claude round ${p.lastClaudeRoundSha ? p.lastClaudeRoundSha.slice(0, 8) : "none"}`),
          el("button", { onclick: () => reviewNow(p.url) }, "Review now"),
        ),
        p.runs.length > 0 &&
          el(
            "ul",
            { class: "runs" },
            ...p.runs
              .slice()
              .reverse()
              .slice(0, 5)
              .map((r) =>
                el(
                  "li",
                  {},
                  `${when(r.startedAt)} · ${r.trigger} · ${r.endedAt ? (r.ok ? "finished" : "failed") : "running"} · `,
                  el("a", { href: "#", onclick: (e) => (e.preventDefault(), showView("sessions"), openSession(r.sessionId)) }, "open session"),
                ),
              ),
          ),
      ),
    ),
  );
  if (!w.prs.length) $("#wa-prs").append(el("div", { class: "meta" }, "No PRs tracked yet. Reviews start from a Slack DM, a push to an already-reviewed PR, or the Review now button."));

  $("#wa-log").replaceChildren(
    ...w.log.map((l) => el("li", {}, el("time", {}, new Date(l.at).toLocaleTimeString()), l.msg)),
  );
}

async function reviewNow(url) {
  if (!url?.trim()) return alert("Paste a PR link first.");
  try {
    const r = await post("/api/watcher/review", { url: url.trim() });
    if (r.sessionId) {
      await loadSessions();
      showView("sessions");
      await openSession(r.sessionId);
    } else {
      alert(`Not started for ${r.pr}. Check Recent activity for the reason.`);
      loadWatcher();
    }
  } catch (e) {
    alert(e.message);
  }
}

$("#wa-review").addEventListener("click", () => reviewNow($("#wa-url").value));
$("#wa-poll").addEventListener("click", async () => {
  $("#wa-poll").disabled = true;
  await post("/api/watcher/poll").catch((e) => alert(e.message));
  $("#wa-poll").disabled = false;
  loadWatcher();
});
$("#wa-refresh").addEventListener("click", loadWatcher);

// ---------- Views ----------

function showView(name, { load = true } = {}) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("active", b.dataset.view === name);
  $("#view-sessions").hidden = name !== "sessions";
  $("#view-worktrees").hidden = name !== "worktrees";
  $("#view-changes").hidden = name !== "changes";
  $("#view-watcher").hidden = name !== "watcher";
  if (name === "watcher") loadWatcher();
  if (name === "worktrees") loadRepos();
  if (name === "changes" && load) openChanges();
}

for (const b of document.querySelectorAll("nav button")) b.addEventListener("click", () => showView(b.dataset.view));

await loadRepos();
await loadSessions();
setInterval(() => loadSessions().catch(() => {}), 5000);
