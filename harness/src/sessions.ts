import { randomUUID } from "node:crypto";
import {
  query,
  listSessions,
  getSessionMessages,
  getSessionInfo,
  renameSession,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type HarnessEvent =
  | { kind: "message"; message: SDKMessage }
  | { kind: "status"; status: LiveStatus }
  | { kind: "approval"; approval: PendingApproval }
  | { kind: "approval_resolved"; id: string }
  | { kind: "error"; error: string };

export type LiveStatus = "running" | "idle" | "ended";

export type ImageInput = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };

/** A user turn: text plus optional base64 images. */
export type UserInput = { text: string; images?: ImageInput[] };

function toContent({ text, images }: UserInput): SDKUserMessage["message"]["content"] {
  if (!images?.length) return text;
  return [
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    })),
    ...(text.trim() ? [{ type: "text" as const, text }] : []),
  ];
}

export type PendingApproval = {
  id: string;
  toolName: string;
  title?: string;
  input: Record<string, unknown>;
  createdAt: number;
};

/** Async queue that feeds user turns into a streaming-input query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(input: UserInput) {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: toContent(input) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else {
      this.items.push(msg);
    }
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

class LiveSession {
  status: LiveStatus = "running";
  readonly events: HarnessEvent[] = [];
  private listeners = new Set<(e: HarnessEvent) => void>();
  private approvals = new Map<string, { approval: PendingApproval; resolve: (r: PermissionResult) => void }>();
  private input = new InputQueue();
  private q: Query;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    firstInput: UserInput,
    permissionMode: PermissionMode,
    resume: boolean,
    title?: string,
  ) {
    this.input.push(firstInput);
    this.q = query({
      prompt: this.input,
      options: {
        cwd,
        permissionMode,
        // Only honored for new sessions; resumed ones keep their saved title.
        ...(title && !resume ? { title } : {}),
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        ...(resume ? { resume: sessionId } : { sessionId }),
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Save thinking summaries so the harness can show them.
        thinking: { type: "adaptive", display: "summarized" },
        canUseTool: (toolName, input, { signal, title }) =>
          this.requestApproval(toolName, input, title, signal),
        stderr: (data) => console.error(`[${sessionId.slice(0, 8)}] ${data.trimEnd()}`),
      },
    });
    void this.pump();
  }

  private emit(e: HarnessEvent) {
    // Keep memory bounded for long sessions; clients reload history from disk.
    this.events.push(e);
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    for (const l of this.listeners) l(e);
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.emit({ kind: "status", status: s });
  }

  private async pump() {
    try {
      for await (const message of this.q) {
        this.emit({ kind: "message", message });
        if (message.type === "result") this.setStatus("idle");
      }
    } catch (err) {
      this.emit({ kind: "error", error: String(err) });
    } finally {
      this.setStatus("ended");
      for (const { resolve } of this.approvals.values()) {
        resolve({ behavior: "deny", message: "Session ended" });
      }
      this.approvals.clear();
      live.delete(this.sessionId);
    }
  }

  private requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    title: string | undefined,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const approval: PendingApproval = { id: randomUUID(), toolName, title, input, createdAt: Date.now() };
    return new Promise((resolve) => {
      this.approvals.set(approval.id, { approval, resolve });
      signal.addEventListener("abort", () => {
        if (this.approvals.delete(approval.id)) {
          this.emit({ kind: "approval_resolved", id: approval.id });
          resolve({ behavior: "deny", message: "Aborted" });
        }
      });
      this.emit({ kind: "approval", approval });
    });
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()].map((a) => a.approval);
  }

  resolveApproval(id: string, allow: boolean, message?: string): boolean {
    const entry = this.approvals.get(id);
    if (!entry) return false;
    this.approvals.delete(id);
    entry.resolve(
      allow
        ? { behavior: "allow", updatedInput: entry.approval.input }
        : { behavior: "deny", message: message || "Denied by user in harness" },
    );
    this.emit({ kind: "approval_resolved", id });
    return true;
  }

  send(input: UserInput) {
    this.input.push(input);
    this.setStatus("running");
  }

  async interrupt() {
    await this.q.interrupt();
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
  }

  stop() {
    this.input.close();
    this.q.close();
  }

  subscribe(fn: (e: HarnessEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const live = new Map<string, LiveSession>();

export function getLive(sessionId: string): LiveSession | undefined {
  return live.get(sessionId);
}

export function startSession(opts: {
  cwd: string;
  input: UserInput;
  permissionMode: PermissionMode;
  title?: string;
}): LiveSession {
  const id = randomUUID();
  const s = new LiveSession(id, opts.cwd, opts.input, opts.permissionMode, false, opts.title);
  live.set(id, s);
  return s;
}

/** Send a message to a session, resuming it from disk if it is not live. */
export async function sendToSession(
  sessionId: string,
  input: UserInput,
  permissionMode: PermissionMode,
): Promise<LiveSession> {
  const existing = live.get(sessionId);
  if (existing) {
    existing.send(input);
    return existing;
  }
  const info = await getSessionInfo(sessionId);
  if (!info?.cwd) throw new Error("Session not found or has no working directory");
  const s = new LiveSession(sessionId, info.cwd, input, permissionMode, true);
  live.set(sessionId, s);
  return s;
}

export async function listAll(limit = 200) {
  const sessions = await listSessions({ limit });
  const onDisk = new Set(sessions.map((s) => s.sessionId));
  // Brand-new sessions have no transcript yet, so listSessions misses them.
  const fresh = [...live.values()]
    .filter((s) => !onDisk.has(s.sessionId))
    .map((s) => ({ sessionId: s.sessionId, summary: "(starting…)", lastModified: Date.now(), cwd: s.cwd }));
  return [...fresh, ...sessions].map((s) => ({
    ...s,
    live: live.get(s.sessionId)?.status ?? null,
    pendingApprovals: live.get(s.sessionId)?.pendingApprovals().length ?? 0,
  }));
}

export async function history(sessionId: string) {
  return getSessionMessages(sessionId);
}

export { renameSession };
