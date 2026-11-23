import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { setupAttention } from "../src/index.js"
import type { SessionSnapshot } from "../src/types.js"
import { ANSWER_LOG } from "../src/queue.js"

const tempDirs: string[] = []
function makeTempDir(): string {
  const base = join(process.cwd(), "tmp")
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, "ny-server-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

interface MockPromptCall {
  sessionID: string
  text: string
  delivery?: string | null
  resume?: boolean | null
  metadata?: Record<string, unknown>
}

function createMockContext(opts: {
  queueDir: string
  idleCatcherEnabled?: boolean
  sessions?: Record<string, { id: string; parentID?: string; title?: string; agent?: string }>
  sessionContexts?: Record<string, any[]>
  discussReplyText?: string
  discussToolAttempt?: { tool: string; input: unknown }
  failPrompt?: boolean
  catcherOutput?: string
}) {
  const tools = new Map<string, any>()
  const rpcHandlers: Record<string, (input: any, ctx: any) => Promise<any>> = {}
  const rpcEvents: Array<{ type: string; data: any }> = []
  const hooks: Record<string, Array<(ev: any) => any>> = {}
  const promptCalls: MockPromptCall[] = []
  const createdSessions: any[] = []
  const removedSessions: string[] = []

  const sessions = { ...(opts.sessions ?? {}) }
  const sessionContexts: Record<string, any[]> = { ...(opts.sessionContexts ?? {}) }

  const ctx: any = {
    app: { name: "opencode", version: "2.4.0", channel: "prod" },
    location: {
      directory: process.cwd(),
      project: { id: "proj_1", directory: process.cwd(), canonical: process.cwd() },
    },
    options: {
      queueDir: opts.queueDir,
      idleCatcher: { enabled: opts.idleCatcherEnabled ?? false, minChars: 40 },
    },
    rpc: {
      register: async (_def: any, handlers: any) => {
        Object.assign(rpcHandlers, handlers)
        return {
          events: {
            emit: async (type: string, data: any) => {
              rpcEvents.push({ type, data })
            },
          },
          dispose: async () => {},
        }
      },
    },
    tool: {
      transform: async (cb: (editor: any) => void) => {
        cb({
          namespace: () => {},
          add: (def: any) => {
            const eff = def.options?.namespace ? `${def.options.namespace}_${def.name}` : def.name
            tools.set(eff, def)
          },
          list: () => [...tools.values()],
          get: (id: string) => tools.get(id),
          update: () => {},
          remove: (id: string) => tools.delete(id),
        })
        return { dispose: async () => {} }
      },
      hook: async (name: string, cb: any) => {
        hooks[`tool.${name}`] ??= []
        hooks[`tool.${name}`]!.push(cb)
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async (name: string, cb: any) => {
        hooks[`permission.${name}`] ??= []
        hooks[`permission.${name}`]!.push(cb)
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions[sessionID]
        if (!s) throw new Error("not found")
        return s
      },
      create: async (input: any) => {
        const id = `ses_scratch_${createdSessions.length + 1}`
        const info = { id, parentID: input.parentID, title: input.title }
        createdSessions.push(input)
        sessions[id] = info
        sessionContexts[id] = []
        return info
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        removedSessions.push(sessionID)
      },
      update: async () => {},
      interrupt: async () => ({ interrupted: true }),
      context: async ({ sessionID }: { sessionID: string }) => sessionContexts[sessionID] ?? [],
      prompt: async (input: MockPromptCall) => {
        // Scratch discuss session prompt simulates tool calls + assistant reply
        if (input.sessionID.startsWith("ses_scratch_")) {
          if (opts.discussToolAttempt) {
            for (const fn of hooks["tool.execute.before"] ?? []) {
              await fn({
                sessionID: input.sessionID,
                tool: opts.discussToolAttempt.tool,
                input: opts.discussToolAttempt.input,
              })
            }
          }
          sessionContexts[input.sessionID] = [
            {
              id: "msg_disc_1",
              type: "assistant",
              model: { providerID: "anthropic", id: "claude-haiku-4-5" },
              content: [{ type: "text", text: opts.discussReplyText ?? "Checked the code. Looks safe." }],
            },
          ]
          return { id: "inbox_scratch" }
        }
        if (opts.failPrompt) throw new Error("session unavailable")
        promptCalls.push(input)
        return { id: "inbox_1" }
      },
      wait: async () => {},
      hook: async (name: string, cb: any) => {
        hooks[`session.${name}`] ??= []
        hooks[`session.${name}`]!.push(cb)
        return { dispose: async () => {} }
      },
    },
    agent: {
      get: async ({ agentID }: { agentID: string }) => ({
        data: agentID === "explore"
          ? { id: "explore", model: { providerID: "anthropic", id: "claude-haiku-4-5" } }
          : { id: agentID, model: null },
      }),
    },
    model: {
      list: async () => [
        { id: "claude-haiku-4-5", providerID: "anthropic", enabled: true, capabilities: { tools: true } },
      ],
      default: async () => ({ data: { providerID: "anthropic", id: "claude-haiku-4-5" } }),
    },
    worktree: {
      list: async () => [{ directory: process.cwd() }],
    },
    experimental: {
      generate: {
        text: async () => ({ text: opts.catcherOutput ?? '{"needsAttention": false}' }),
      },
    },
    event: {
      subscribe: async function* () {
        // idle test stream
      },
    },
  }

  return { ctx, tools, rpcHandlers, rpcEvents, hooks, promptCalls, createdSessions, removedSessions, sessionContexts }
}

describe("opencode-attention server plugin", () => {
  test("posts, prioritizes, updates, withdraws, answers, and logs to 0600 answers-log.jsonl", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      sessions: { ses_root: { id: "ses_root", title: "Main Work" } },
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      const post = env.tools.get("attention_post")
      const update = env.tools.get("attention_update")
      const withdraw = env.tools.get("attention_withdraw")
      const list = env.tools.get("attention_list")

      expect(post).toBeDefined()
      expect(update).toBeDefined()
      expect(withdraw).toBeDefined()
      expect(list).toBeDefined()

      // Post normal decision first, then blocking approval second -> blocking must sort first
      await post.execute(
        {
          id: "pick-theme",
          kind: "decision",
          urgency: "normal",
          title: "Pick color palette?",
          plainSummary: "Choose default UI palette for dashboard.",
          options: ["Light", "Dark"],
          recommended: 1,
        },
        { sessionID: "ses_root", agent: "build" },
      )
      await post.execute(
        {
          id: "deploy-prod",
          kind: "approval",
          urgency: "blocking",
          title: "Deploy v2.1 to production?",
          plainSummary: "Staging checks passed; ready to push live.",
          impact: "Updates live customer traffic",
          reversible: false,
          options: ["Deploy now", "Hold"],
        },
        { sessionID: "ses_root", agent: "build" },
      )

      // Update an open item with extra details
      await update.execute(
        { id: "deploy-prod", appendDetails: "Rollback image verified." },
        { sessionID: "ses_root", agent: "build" },
      )

      const snap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(snap.open.map((i) => i.id)).toEqual(["deploy-prod", "pick-theme"])
      expect(snap.open[0]?.details).toContain("Rollback image verified.")

      // Snooze deploy-prod -> moves behind pick-theme
      await env.rpcHandlers.snooze!({ sessionID: "ses_root", itemID: "deploy-prod" }, {})
      const afterSnooze = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(afterSnooze.open.map((i) => i.id)).toEqual(["pick-theme", "deploy-prod"])

      // Withdraw pick-theme
      await withdraw.execute({ id: "pick-theme", reason: "Decided in doc" }, { sessionID: "ses_root", agent: "build" })
      const afterWithdraw = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(afterWithdraw.open.map((i) => i.id)).toEqual(["deploy-prod"])

      // Answer deploy-prod -> steers session and writes 0600 answers-log.jsonl
      const ansRes = await env.rpcHandlers.answer!(
        { sessionID: "ses_root", itemID: "deploy-prod", answer: "Deploy now", typed: false },
        {},
      )
      expect(ansRes).toEqual({ ok: true, silent: false })
      expect(env.promptCalls).toHaveLength(1)
      expect(env.promptCalls[0]?.text).toBe("[attention:deploy-prod] Deploy now")
      expect(env.promptCalls[0]?.delivery).toBe("steer")
      expect(env.promptCalls[0]?.resume).toBe(true)

      const logPath = join(queueDir, ANSWER_LOG)
      expect(existsSync(logPath)).toBe(true)
      const mode = statSync(logPath).mode & 0o777
      expect(mode).toBe(0o600)
      const records = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records).toHaveLength(1)
      expect(records[0].id).toBe("deploy-prod")
      expect(records[0].sent).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("silent ack records without enqueuing a session prompt and surfaces in context hook, while ack with comment wakes/steers session", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      sessions: { ses_root: { id: "ses_root", title: "Session" } },
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      const post = env.tools.get("attention_post")
      await post.execute(
        {
          id: "fyi-offline",
          kind: "ack",
          title: "Fallback: bash running offline",
          plainSummary: "Sandbox prevented network access; using fetch tool instead.",
        },
        { sessionID: "ses_root", agent: "build" },
      )
      await post.execute(
        {
          id: "fyi-skipped",
          kind: "ack",
          title: "Skipped flaky visual test",
          plainSummary: "Skipped 1 visual test due to missing font.",
        },
        { sessionID: "ses_root", agent: "build" },
      )

      // 1. Plain acknowledge -> truly silent (no session.prompt call at all, surfaced in context hook)
      const silentRes = await env.rpcHandlers.answer!(
        { sessionID: "ses_root", itemID: "fyi-offline", answer: "Acknowledge", typed: false },
        {},
      )
      expect(silentRes).toEqual({ ok: true, silent: true })
      expect(env.promptCalls).toHaveLength(0)

      const ctxEvent: any = { sessionID: "ses_root", system: [], tools: {} }
      for (const fn of env.hooks["session.context"] ?? []) await fn(ctxEvent)
      const injected = ctxEvent.system.map((s: any) => s.text).join("\n")
      expect(injected).toContain("[attention:fyi-offline] Acknowledge")

      // 2. Typed comment/override on ack -> NOT silent (enqueues prompt with resume: true, steer)
      const wakeRes = await env.rpcHandlers.answer!(
        { sessionID: "ses_root", itemID: "fyi-skipped", answer: "Don't skip it, install the font instead", typed: true },
        {},
      )
      expect(wakeRes).toEqual({ ok: true, silent: false })
      expect(env.promptCalls).toHaveLength(1)
      expect(env.promptCalls[0]?.resume).toBe(true)
      expect(env.promptCalls[0]?.delivery).toBe("steer")
    } finally {
      await cleanup()
    }
  })

  test("rolls up subagent items to root session and delivers answer back to subagent", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      sessions: {
        ses_root: { id: "ses_root", title: "Orchestrator" },
        ses_child: { id: "ses_child", parentID: "ses_root", agent: "explore" },
      },
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      const post = env.tools.get("attention_post")
      await post.execute(
        {
          id: "child-q",
          kind: "decision",
          title: "Keep legacy endpoint?",
          plainSummary: "Found unused v1 endpoint during cleanup.",
          options: ["Delete it", "Keep it"],
        },
        { sessionID: "ses_child", agent: "explore" },
      )

      // Visible in root session's panel, tagged with subagent
      const rootSnap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(rootSnap.open).toHaveLength(1)
      expect(rootSnap.open[0]?.originAgent).toBe("explore")
      expect(rootSnap.open[0]?.sessionID).toBe("ses_child")

      // Answering from root panel delivers directly to ses_child
      await env.rpcHandlers.answer!(
        { sessionID: "ses_root", itemID: "child-q", answer: "Keep it", typed: false },
        {},
      )
      expect(env.promptCalls[0]?.sessionID).toBe("ses_child")
    } finally {
      await cleanup()
    }
  })

  test("rolls back item to open when session.prompt fails", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      failPrompt: true,
      sessions: { ses_root: { id: "ses_root", title: "Main" } },
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      await env.tools.get("attention_post").execute(
        { id: "rb-item", title: "Proceed?", plainSummary: "Confirm step.", options: ["Yes"] },
        { sessionID: "ses_root", agent: "build" },
      )
      const res = await env.rpcHandlers.answer!(
        { sessionID: "ses_root", itemID: "rb-item", answer: "Yes", typed: false },
        {},
      )
      expect(res.ok).toBe(false)
      const snap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(snap.open).toHaveLength(1)
      expect(snap.open[0]?.id).toBe("rb-item")
      const logLines = readFileSync(join(queueDir, ANSWER_LOG), "utf8").trim().split("\n")
      expect(JSON.parse(logLines[0]!).rolledBack).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("DISCUSS runs read-only scratch session, verifies quote, triggers undoable 5s close, and cleans up scratch session", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      sessions: { ses_root: { id: "ses_root", title: "Main" } },
      discussReplyText: [
        "Option 1 keeps staging untouched.",
        "[attention-context:pick-env]",
        "- Verified staging config in src/config.ts:12",
        "[attention-close:pick-env] Use staging | quote: let us use staging",
      ].join("\n"),
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      await env.tools.get("attention_post").execute(
        { id: "pick-env", title: "Which env?", plainSummary: "Choose target.", options: ["Use staging", "Use prod"] },
        { sessionID: "ses_root", agent: "build" },
      )
      const sent = await env.rpcHandlers.sendChat!(
        { sessionID: "ses_root", itemID: "pick-env", text: "Okay, let us use staging." },
        {},
      )
      expect(sent.ok).toBe(true)

      // Wait briefly for async discuss run to settle
      await Bun.sleep(40)

      const snap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(snap.pendingClose).not.toBeNull()
      expect(snap.pendingClose?.decision).toBe("Use staging")
      // Scratch session must NOT have parentID (prevents <background-result> leak into main session)
      expect(env.createdSessions[0]?.parentID).toBeUndefined()
      // Scratch session was removed immediately after replying
      expect(env.removedSessions).toEqual(["ses_scratch_1"])
      // Snapshot must have zero own properties with value `undefined` (OpenCode strict RPC JSON validator)
      const hasUndefinedValue = (v: unknown): boolean => {
        if (v === undefined) return true
        if (Array.isArray(v)) return v.some(hasUndefinedValue)
        if (v && typeof v === "object") return Object.values(v).some(hasUndefinedValue)
        return false
      }
      expect(hasUndefinedValue(snap)).toBe(false)

      // Undo cancels the pending close before 5s passes
      const undone = await env.rpcHandlers.undoClose!({ sessionID: "ses_root" }, {})
      expect(undone.ok).toBe(true)
      const afterUndo = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(afterUndo.pendingClose).toBeNull()
      expect(afterUndo.open).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  test("DISCUSS guard blocks mutating tool call inside scratch session", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      sessions: { ses_root: { id: "ses_root", title: "Main" } },
      discussToolAttempt: { tool: "write", input: { path: "evil.txt", content: "x" } },
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      await env.tools.get("attention_post").execute(
        { id: "guard-test", title: "Check guard", plainSummary: "Test guard.", options: ["Ok"] },
        { sessionID: "ses_root", agent: "build" },
      )
      await env.rpcHandlers.sendChat!(
        { sessionID: "ses_root", itemID: "guard-test", text: "Check the file" },
        {},
      )
      await Bun.sleep(40)
      const snap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      const ownerMsg = snap.chat.find((m) => m.kind === "you")
      expect(ownerMsg?.kind === "you" && ownerMsg.status).toBe("failed")
      expect(ownerMsg?.kind === "you" && ownerMsg.reason).toContain("read-only DISCUSS chat refuses tool")
    } finally {
      await cleanup()
    }
  })

  test("Idle Attention Catcher auto-captures buried question when agent goes idle without posting", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      idleCatcherEnabled: true,
      sessions: { ses_root: { id: "ses_root", title: "Main" } },
      sessionContexts: {
        ses_root: [
          {
            id: "msg_asst_99",
            type: "assistant",
            content: [
              {
                type: "text",
                text: "I refactored the worker pool and verified unit tests. However, before I run the production migration, should I drop the legacy events table or keep it as a backup for 7 days?",
              },
            ],
          },
        ],
      },
      catcherOutput: JSON.stringify({
        needsAttention: true,
        kind: "approval",
        urgency: "blocking",
        id: "drop-legacy-table",
        title: "Drop legacy events table or keep 7-day backup?",
        plainSummary: "Migration is ready; decide whether to drop the old table now or retain it for 7 days.",
        reversible: false,
        options: ["Keep 7-day backup (recommended)", "Drop immediately"],
        recommended: 0,
      }),
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      const idleHooks = env.hooks["session.experimental.idle"] ?? []
      expect(idleHooks.length).toBe(1)
      await idleHooks[0]!({ sessionID: "ses_root", background: [] })

      const snap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(snap.open).toHaveLength(1)
      expect(snap.open[0]?.id).toBe("drop-legacy-table")
      expect(snap.open[0]?.autoCaptured).toBe(true)
      expect(snap.open[0]?.kind).toBe("approval")

      // Running idle hook again for the same assistant message must NOT duplicate
      await idleHooks[0]!({ sessionID: "ses_root", background: [] })
      const snap2 = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(snap2.open).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  test("batchAck clears safe ack items silently and leaves non-ack or irreversible items open", async () => {
    const queueDir = makeTempDir()
    const env = createMockContext({
      queueDir,
      sessions: { ses_root: { id: "ses_root", title: "Main" } },
    })
    const cleanup = await setupAttention(env.ctx)

    try {
      const post = env.tools.get("attention_post")
      await post.execute({ id: "ack-1", kind: "ack", title: "Note 1", plainSummary: "FYI 1" }, { sessionID: "ses_root", agent: "build" })
      await post.execute({ id: "ack-2", kind: "ack", title: "Note 2", plainSummary: "FYI 2" }, { sessionID: "ses_root", agent: "build" })
      await post.execute(
        { id: "dec-1", kind: "decision", title: "Choice", plainSummary: "Pick one", options: ["A", "B"] },
        { sessionID: "ses_root", agent: "build" },
      )

      const res = await env.rpcHandlers.batchAck!({ sessionID: "ses_root" }, {})
      expect(res).toEqual({ acked: 2, errors: [] })
      const snap = (await env.rpcHandlers.snapshot!({ sessionID: "ses_root" }, {})) as SessionSnapshot
      expect(snap.open.map((i) => i.id)).toEqual(["dec-1"])
      expect(env.promptCalls).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })
})
