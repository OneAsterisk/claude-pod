import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { checkPassword, clearCookie, issueCookie, rateLimited, requireAuth } from "./auth.ts";
import * as sessions from "./sessions.ts";
import type { ImageInput, UserInput } from "./sessions.ts";
import * as wt from "./worktrees.ts";
import * as dev from "./devservers.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

function mode(value: unknown): PermissionMode {
  return MODES.includes(value as PermissionMode) ? (value as PermissionMode) : "default";
}

function clientIp(c: Context): string {
  // Runpod's proxy sits behind Cloudflare.
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    getConnInfo(c).remote.address ??
    "unknown"
  );
}

async function body<T>(c: Context): Promise<T> {
  if (!c.req.header("content-type")?.includes("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  return (await c.req.json()) as T;
}

class HttpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415, message: string) {
    super(message);
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic API per-image limit

function userInput(text: unknown, images: unknown): UserInput {
  const t = typeof text === "string" ? text : "";
  const list = Array.isArray(images) ? images : [];
  if (list.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per message`);
  const parsed: ImageInput[] = list.map((img, i) => {
    if (!img || !IMAGE_TYPES.has(img.mediaType) || typeof img.data !== "string") {
      throw new HttpError(400, `Image ${i + 1}: must be PNG, JPEG, GIF, or WebP`);
    }
    if (Buffer.byteLength(img.data, "base64") > MAX_IMAGE_BYTES) {
      throw new HttpError(413, `Image ${i + 1} is over 5 MB`);
    }
    return { mediaType: img.mediaType, data: img.data };
  });
  if (!t.trim() && !parsed.length) throw new HttpError(400, "Message is required");
  return { text: t, images: parsed };
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err.message || "Internal error" }, 500);
});

// ---- Auth ----

app.get("/login", serveStatic({ path: "./public/login.html" }));

app.post("/login", async (c) => {
  if (rateLimited(clientIp(c))) return c.text("Too many attempts. Wait a minute.", 429);
  const form = await c.req.parseBody();
  if (typeof form.password === "string" && checkPassword(form.password)) {
    issueCookie(c);
    return c.redirect("/");
  }
  return c.redirect("/login?error=1");
});

app.post("/logout", (c) => {
  clearCookie(c);
  return c.redirect("/login");
});

app.use("*", requireAuth);
// 10 images x 5 MB, base64-encoded, plus text.
app.use("/api/sessions/*", bodyLimit({ maxSize: 75 * 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

// ---- Repos, worktrees, dev servers ----

app.get("/api/repos", async (c) => {
  const repos = await Promise.all(
    wt.listRepos().map(async (r) => ({
      name: r.name,
      worktrees: (await wt.listWorktrees(r.name)).map((w) => ({ ...w, dev: dev.devServerStatus(w.path) })),
    })),
  );
  return c.json({ repos, podId: config.podId });
});

app.post("/api/worktrees", async (c) => {
  const { repo, name, base } = await body<{ repo: string; name: string; base?: string }>(c);
  return c.json(await wt.addWorktree(repo, name, base));
});

app.post("/api/worktrees/remove", async (c) => {
  const { repo, path, force } = await body<{ repo: string; path: string; force?: boolean }>(c);
  dev.stopDevServer(path);
  await wt.removeWorktree(repo, path, !!force);
  return c.json({ ok: true });
});

async function assertAllowedCwd(path: string) {
  if (!(await wt.allowedCwds()).has(path)) throw new HttpError(403, "Not a known repo checkout or worktree");
}

app.post("/api/dev/start", async (c) => {
  const { path } = await body<{ path: string }>(c);
  await assertAllowedCwd(path);
  return c.json(dev.startDevServer(path));
});

app.post("/api/dev/stop", async (c) => {
  const { path } = await body<{ path: string }>(c);
  return c.json({ stopped: dev.stopDevServer(path) });
});

app.get("/api/dev", (c) => c.json(dev.devServerStatus(c.req.query("path") ?? "")));

// ---- Sessions ----

app.get("/api/sessions", async (c) => c.json(await sessions.listAll()));

app.post("/api/sessions", async (c) => {
  const b = await body<{ cwd: string; prompt: string; images?: unknown; permissionMode?: string; title?: string }>(c);
  const input = userInput(b.prompt, b.images);
  await assertAllowedCwd(b.cwd);
  const s = sessions.startSession({
    cwd: b.cwd,
    input,
    permissionMode: mode(b.permissionMode),
    title: b.title?.trim() || undefined,
  });
  return c.json({ sessionId: s.sessionId });
});

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const live = sessions.getLive(id);
  const messages = await sessions.history(id).catch(() => []);
  return c.json({
    sessionId: id,
    messages,
    live: live?.status ?? null,
    approvals: live?.pendingApprovals() ?? [],
  });
});

app.get("/api/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const live = sessions.getLive(id);
    if (!live) {
      await stream.writeSSE({ event: "status", data: JSON.stringify({ kind: "status", status: "ended" }) });
      return;
    }
    let closed = false;
    const unsubscribe = live.subscribe((e) => {
      void stream.writeSSE({ event: e.kind, data: JSON.stringify(e) });
      if (e.kind === "status" && e.status === "ended") closed = true;
    });
    stream.onAbort(() => {
      closed = true;
    });
    await stream.writeSSE({ event: "status", data: JSON.stringify({ kind: "status", status: live.status }) });
    // Cloudflare drops idle connections at 100s, so ping well inside that.
    while (!closed) {
      await stream.sleep(25_000);
      if (!closed) await stream.writeSSE({ event: "ping", data: "{}" });
    }
    unsubscribe();
  });
});

app.post("/api/sessions/:id/messages", async (c) => {
  const { text, images, permissionMode } = await body<{ text: string; images?: unknown; permissionMode?: string }>(c);
  const s = await sessions.sendToSession(c.req.param("id"), userInput(text, images), mode(permissionMode));
  return c.json({ sessionId: s.sessionId, live: s.status });
});

function requireLive(c: Context) {
  const s = sessions.getLive(c.req.param("id") ?? "");
  if (!s) throw new HttpError(404, "Session is not running in this harness");
  return s;
}

app.post("/api/sessions/:id/interrupt", async (c) => {
  await requireLive(c).interrupt();
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/stop", (c) => {
  requireLive(c).stop();
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/mode", async (c) => {
  const { permissionMode } = await body<{ permissionMode: string }>(c);
  await requireLive(c).setPermissionMode(mode(permissionMode));
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/rename", async (c) => {
  const { title } = await body<{ title: string }>(c);
  if (!title?.trim()) throw new HttpError(400, "Title is required");
  await sessions.renameSession(c.req.param("id"), title.trim());
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/approvals/:approvalId", async (c) => {
  const { allow, message } = await body<{ allow: boolean; message?: string }>(c);
  const ok = requireLive(c).resolveApproval(c.req.param("approvalId"), !!allow, message);
  if (!ok) throw new HttpError(404, "Approval not pending");
  return c.json({ ok: true });
});

// ---- Frontend ----

// Always revalidate, so a restart with new frontend code is picked up on reload.
app.use("/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-cache");
});

app.get("/vendor/marked.js", serveStatic({ path: "./node_modules/marked/lib/marked.esm.js" }));
app.get("/vendor/purify.js", serveStatic({ path: "./node_modules/dompurify/dist/purify.es.mjs" }));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Harness listening on http://${info.address}:${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    dev.stopAll();
    process.exit(0);
  });
}
