import { Plugin } from "@opencode/plugin"
import type { AttentionOptions, ChatMessage, PendingClose, QueueItem, ResolvedOptions, SessionSnapshot } from "./types.js"
import { parseModelSpec } from "./types.js"
import {
  applyItemUpdate,
  deliveryForAnswer,
  validateNewItem,
} from "./queue.js"
import {
  buildSessionMessage,
  CHAT_MESSAGE_CHARS,
  chatOf,
  CLOSE_WAIT_MS,
  EXPLAIN_SIMPLY_USER_TEXT,
  isTalk,
  messageId,
  protocolText,
  verifyOwnerQuote,
} from "./chat.js"
import { checkReadOnlyTool, isToolAllowedInDiscussSchema } from "./guard.js"
import { AttentionRpc } from "./rpc.js"
import { AttentionStore, resolveQueueDir } from "./store.js"
import { DiscussRunner } from "./discuss.js"
import { detectMissedAttention } from "./catcher.js"

type ServerContext = Parameters<Plugin.Plugin["setup"]>[0]

export function resolveOptions(raw: Record<string, unknown> | undefined): ResolvedOptions {
  const opts = (raw ?? {}) as AttentionOptions
  return {
    queueDir: resolveQueueDir(opts.queueDir),
    autoOpenPanel: opts.autoOpenPanel !== false,
    notifyOnArrival: opts.notifyOnArrival !== false,
    discuss: {
      model: parseModelSpec(opts.discuss?.model),
      maxTurns: typeof opts.discuss?.maxTurns === "number" && opts.discuss.maxTurns >= 1 ? Math.min(opts.discuss.maxTurns, 30) : 12,
      timeoutMs: typeof opts.discuss?.timeoutMs === "number" && opts.discuss.timeoutMs >= 10_000 ? opts.discuss.timeoutMs : 180_000,
    },
    idleCatcher: {
      enabled: opts.idleCatcher?.enabled !== false,
      model: parseModelSpec(opts.idleCatcher?.model),
      minChars: typeof opts.idleCatcher?.minChars === "number" && opts.idleCatcher.minChars >= 20 ? opts.idleCatcher.minChars : 120,
    },
  }
}

export async function setupAttention(ctx: ServerContext) {
  const options = resolveOptions(ctx.options as Record<string, unknown>)
  const store = new AttentionStore(options.queueDir)
  const discuss = new DiscussRunner(ctx)

  const pendingCloseByRoot = new Map<string, PendingClose>()
  const closeTimersByRoot = new Map<string, ReturnType<typeof setTimeout>>()
  const liveActivityByRoot = new Map<string, Record<string, string>>()
  const inFlightAnswer = new Set<string>()
  const inFlightChat = new Set<string>()
  const recoveredRoots = new Set<string>()
  const postedInTurn = new Set<string>() // sessionIDs that already called attention_post since last idle
  const caughtMessageIds = new Set<string>() // assistantMessageIDs already evaluated by idle catcher
  const rootCache = new Map<string, string>()

  const emitChanged = async (payload: {
    sessionID: string
    reason: string
    itemID?: string
    title?: string
    urgency?: string
    kind?: string
  }) => {
    try {
      await rpcReg.events.emit("changed", payload)
    } catch {
      // ignore if unloading
    }
  }

  /** Resolves the root session ID (for subagent rollup) and caches session titles. */
  async function resolveRootSession(sessionID: string): Promise<{ rootID: string; isChild: boolean; agent?: string }> {
    const cached = rootCache.get(sessionID)
    if (cached) return { rootID: cached, isChild: cached !== sessionID }
    let cur = sessionID
    let firstAgent: string | undefined
    const seen = new Set<string>()
    for (let depth = 0; depth < 8; depth += 1) {
      if (seen.has(cur)) break
      seen.add(cur)
      try {
        const info = await ctx.session.get({ sessionID: cur })
        if (depth === 0 && info.agent) firstAgent = info.agent
        if (info.title) store.setSessionTitle(cur, info.title)
        const parent = (info as { parentID?: string | null }).parentID
        if (!parent) {
          rootCache.set(sessionID, cur)
          return { rootID: cur, isChild: cur !== sessionID, agent: firstAgent }
        }
        cur = parent
      } catch {
        break
      }
    }
    rootCache.set(sessionID, sessionID)
    return { rootID: sessionID, isChild: false, agent: firstAgent }
  }

  function clearPendingClose(rootID: string, onlyItemID?: string): boolean {
    const cur = pendingCloseByRoot.get(rootID)
    if (!cur) return false
    if (onlyItemID && cur.itemID !== onlyItemID) return false
    pendingCloseByRoot.delete(rootID)
    const timer = closeTimersByRoot.get(rootID)
    if (timer) clearTimeout(timer)
    closeTimersByRoot.delete(rootID)
    return true
  }

  function setLiveActivity(rootID: string, ownerMessageID: string, line?: string): void {
    const map = { ...(liveActivityByRoot.get(rootID) ?? {}) }
    if (line === undefined) delete map[ownerMessageID]
    else map[ownerMessageID] = line
    liveActivityByRoot.set(rootID, map)
    void emitChanged({ sessionID: rootID, reason: "activity" })
  }

  function updateChatList(rootID: string, fn: (list: ChatMessage[]) => ChatMessage[]): void {
    const next = fn(store.getChat(rootID))
    store.setChat(rootID, next)
    void emitChanged({ sessionID: rootID, reason: "chat" })
  }

  function setOwnMessage(
    rootID: string,
    ownerMessageID: string,
    patch: Partial<Extract<ChatMessage, { kind: "you" }>>,
  ): void {
    updateChatList(rootID, (list) =>
      list.map((m) => {
        if (m.id !== ownerMessageID || m.kind !== "you") return m
        const next: Record<string, unknown> = { ...m }
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete next[k]
          else next[k] = v
        }
        return next as Extract<ChatMessage, { kind: "you" }>
      }),
    )
  }

  async function deliverAnswer(input: {
    rootID: string
    itemID: string
    answerText: string
    typed: boolean
    fromChat: boolean
    context?: string
  }): Promise<{ ok: boolean; silent?: boolean; error?: string }> {
    const lockKey = `${input.rootID}:${input.itemID}`
    if (inFlightAnswer.has(lockKey)) return { ok: false, error: "Answer already being sent." }
    inFlightAnswer.add(lockKey)

    try {
      const item = store.getItem(input.rootID, input.itemID)
      if (!item) return { ok: false, error: "Item not found." }
      if (item.status !== "open") return { ok: false, error: `Item is already ${item.status}.` }

      clearPendingClose(input.rootID, item.id)
      discuss.stopForItem(item.id)

      const thread = chatOf(store.getChat(input.rootID), item.id)
      const talkCount = thread.filter(isTalk).length
      const policy = deliveryForAnswer(item, input.answerText, input.typed, talkCount > 0)
      const now = Date.now()
      const answeredAt = new Date(now).toISOString()

      const original = { ...item }
      const updated: QueueItem = {
        ...item,
        status: "answered",
        answer: input.answerText,
        answeredAt,
        updatedAt: now,
        ...(input.fromChat ? { closedFromChat: true } : {}),
        ...(policy.silentAck ? { silentAck: true } : {}),
      }
      store.putItem(updated)

      // Plain acks stay completely out of the session inbox (so OpenCode never drains them into a spurious turn);
      // instead they are surfaced in the context hook on the session's next real turn.
      if (!policy.silentAck) {
        const messageText = buildSessionMessage(item, input.answerText, thread, input.context ?? "")

        try {
          await ctx.session.prompt({
            sessionID: item.sessionID,
            text: messageText,
            delivery: policy.delivery,
            resume: policy.resume,
            metadata: {
              attentionItemID: item.id,
              attentionSilentAck: false,
              attentionClosedFromChat: input.fromChat,
            },
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          // Roll back item to open so the user never loses their pending decision
          store.putItem(original)
          store.appendAnswerLog({
            ts: answeredAt,
            sessionID: item.sessionID,
            rootSessionID: item.rootSessionID,
            cwd: ctx.location.directory,
            id: item.id,
            kind: item.kind,
            urgency: item.urgency,
            title: item.title,
            plainSummary: item.plainSummary,
            options: item.options,
            answer: input.answerText,
            ...(input.typed ? { custom: input.answerText } : {}),
            sent: false,
            rolledBack: true,
            reason,
            ...(input.fromChat ? { closedFromChat: true } : {}),
            ...(item.autoCaptured ? { autoCaptured: true } : {}),
          })
          await emitChanged({ sessionID: input.rootID, reason: "answered", itemID: item.id })
          return { ok: false, error: `Failed to deliver to session (${reason}). Item restored.` }
        }
      }

      store.appendAnswerLog({
        ts: answeredAt,
        sessionID: item.sessionID,
        rootSessionID: item.rootSessionID,
        cwd: ctx.location.directory,
        id: item.id,
        kind: item.kind,
        urgency: item.urgency,
        title: item.title,
        plainSummary: item.plainSummary,
        options: item.options,
        answer: input.answerText,
        ...(input.typed ? { custom: input.answerText } : {}),
        sent: true,
        ...(policy.silentAck ? { silentAck: true } : {}),
        ...(input.fromChat ? { closedFromChat: true } : {}),
        ...(item.autoCaptured ? { autoCaptured: true } : {}),
      })

      updateChatList(input.rootID, (list) => [
        ...list,
        {
          id: messageId(now),
          kind: "sent",
          itemID: item.id,
          title: item.title,
          text: input.answerText,
          at: now,
          count: talkCount,
          ...(policy.silentAck ? { silent: true } : {}),
          ...(input.fromChat ? { closedFromChat: true } : {}),
        },
      ])

      await emitChanged({ sessionID: input.rootID, reason: "answered", itemID: item.id })
      return { ok: true, silent: policy.silentAck }
    } finally {
      inFlightAnswer.delete(lockKey)
    }
  }

  function scheduleCloseFromChat(rootID: string, item: QueueItem, decision: string, context: string): void {
    clearPendingClose(rootID)
    const now = Date.now()
    const token = messageId(now)
    pendingCloseByRoot.set(rootID, {
      token,
      itemID: item.id,
      decision,
      context,
      dueAt: now + CLOSE_WAIT_MS,
    })
    void emitChanged({ sessionID: rootID, reason: "closing", itemID: item.id })

    const timer = setTimeout(() => {
      const cur = pendingCloseByRoot.get(rootID)
      if (!cur || cur.token !== token) return
      clearPendingClose(rootID)
      const latest = store.getItem(rootID, item.id)
      if (!latest || latest.status !== "open") return
      const matchedOpt = latest.options.find((o) => o.trim().toLowerCase() === decision.trim().toLowerCase())
      void deliverAnswer({
        rootID,
        itemID: latest.id,
        answerText: matchedOpt ?? decision,
        typed: matchedOpt === undefined,
        fromChat: true,
        context,
      })
    }, CLOSE_WAIT_MS)
    closeTimersByRoot.set(rootID, timer)
  }

  async function runDiscussForOwner(rootID: string, ownerMessageID: string): Promise<void> {
    if (inFlightChat.has(ownerMessageID)) return
    inFlightChat.add(ownerMessageID)

    try {
      const all = store.getChat(rootID)
      const idx = all.findIndex((m) => m.id === ownerMessageID)
      const owner = all[idx]
      if (!owner || owner.kind !== "you") return
      if (all.some((m) => m.kind === "assistant" && m.replyTo === ownerMessageID)) {
        setOwnMessage(rootID, ownerMessageID, { status: "answered" })
        return
      }
      const item = store.getItem(rootID, owner.itemID)
      if (!item || item.status !== "open") {
        setOwnMessage(rootID, ownerMessageID, { status: "failed", reason: "This item is no longer open." })
        return
      }

      const earlierThread = all.slice(0, idx).filter((m) => m.itemID === item.id)
      const siblingTitles = store
        .listOpen(rootID)
        .filter((other) => other.id !== item.id)
        .slice(0, 8)
        .map((other) => `[${other.urgency}/${other.kind}] ${other.id}: ${other.title}`)

      setOwnMessage(rootID, ownerMessageID, { status: "thinking", since: Date.now(), reason: undefined })

      const result = await discuss.run({
        item,
        ownerMessageID,
        earlierThread,
        siblingTitles,
        message: owner.text,
        modelSpec: options.discuss.model,
        maxTurns: options.discuss.maxTurns,
        timeoutMs: options.discuss.timeoutMs,
        onActivity: (line) => setLiveActivity(rootID, ownerMessageID, line),
      })

      setLiveActivity(rootID, ownerMessageID, undefined)

      if (!result.ok) {
        const stillOpen = store.getItem(rootID, item.id)?.status === "open"
        setOwnMessage(rootID, ownerMessageID, {
          status: "failed",
          reason: stillOpen ? result.reason : "The item closed before a reply arrived.",
        })
        return
      }

      const freshItem = store.getItem(rootID, item.id)
      if (!freshItem || freshItem.status !== "open") {
        setOwnMessage(rootID, ownerMessageID, {
          status: "failed",
          reason: "The item closed before a reply arrived.",
        })
        return
      }

      const replyMsg: ChatMessage = {
        id: messageId(Date.now()),
        kind: "assistant",
        itemID: item.id,
        text: result.replyText,
        at: Date.now(),
        replyTo: ownerMessageID,
        model: result.model,
        seconds: result.seconds,
        ...(result.checked.length > 0 ? { checked: result.checked } : {}),
      }
      updateChatList(rootID, (list) => [
        ...list.map((m) => (m.id === ownerMessageID && m.kind === "you" ? { ...m, status: "answered" as const } : m)),
        replyMsg,
      ])

      if (result.closing && result.closing.decision !== "") {
        const threadNow = chatOf(store.getChat(rootID), item.id)
        if (verifyOwnerQuote(threadNow, result.closing.quote)) {
          scheduleCloseFromChat(rootID, freshItem, result.closing.decision, result.closing.context)
        } else {
          // Append a quiet note on why it did not auto-close
          updateChatList(rootID, (list) => [
            ...list,
            {
              id: messageId(Date.now()),
              kind: "assistant",
              itemID: item.id,
              text: "Not closed automatically: the closing quote was not verbatim in your messages. Click an option or state your decision directly to close.",
              at: Date.now(),
            },
          ])
        }
      }
    } finally {
      inFlightChat.delete(ownerMessageID)
    }
  }

  // ── 1. RPC registration (server <-> TUI & Desktop GUI) ─────────────────────
  const rpcReg = await ctx.rpc.register(AttentionRpc, {
    snapshot: async (rawInput) => {
      const { sessionID } = rawInput as { sessionID: string }
      const { rootID } = await resolveRootSession(sessionID)
      if (!recoveredRoots.has(rootID)) {
        recoveredRoots.add(rootID)
        for (const waitingID of store.recoverChatOnReload(rootID)) {
          void runDiscussForOwner(rootID, waitingID).catch(() => undefined)
        }
      }
      const snap: SessionSnapshot = {
        sessionID: rootID,
        open: store.listOpen(rootID),
        closed: store.listClosed(rootID).slice(0, 20),
        chat: store.getChat(rootID),
        pendingClose: pendingCloseByRoot.get(rootID) ?? null,
        liveActivity: liveActivityByRoot.get(rootID) ?? {},
        otherSessions: store.otherSessionsWithOpen(rootID),
        now: Date.now(),
      }
      // Guarantee strict JSON-only output (no own keys with `undefined` values) for OpenCode's RPC validator
      return JSON.parse(JSON.stringify(snap)) as Record<string, unknown>
    },

    answer: async (rawInput) => {
      const input = rawInput as { sessionID: string; itemID: string; answer: string; typed?: boolean }
      const { rootID } = await resolveRootSession(input.sessionID)
      const text = input.answer.trim()
      if (!text) return { ok: false, error: "Answer cannot be empty." }
      return deliverAnswer({
        rootID,
        itemID: input.itemID,
        answerText: text,
        typed: input.typed === true,
        fromChat: false,
      })
    },

    batchAck: async (rawInput) => {
      const { sessionID } = rawInput as { sessionID: string }
      const { rootID } = await resolveRootSession(sessionID)
      const ackItems = store.listOpen(rootID).filter((i) => i.kind === "ack" && i.reversible !== false)
      let acked = 0
      const errors: string[] = []
      for (const item of ackItems) {
        const res = await deliverAnswer({
          rootID,
          itemID: item.id,
          answerText: item.options[0] ?? "Acknowledge",
          typed: false,
          fromChat: false,
        })
        if (res.ok) acked += 1
        else if (res.error) errors.push(`${item.id}: ${res.error}`)
      }
      return { acked, errors }
    },

    snooze: async (rawInput) => {
      const { sessionID, itemID } = rawInput as { sessionID: string; itemID: string }
      const { rootID } = await resolveRootSession(sessionID)
      const item = store.getItem(rootID, itemID)
      if (!item || item.status !== "open") return { ok: false }
      store.putItem({ ...item, snoozedAt: Date.now(), updatedAt: Date.now() })
      await emitChanged({ sessionID: rootID, reason: "snoozed", itemID })
      return { ok: true }
    },

    dismiss: async (rawInput) => {
      const { sessionID, itemID, reason } = rawInput as { sessionID: string; itemID: string; reason?: string }
      const { rootID } = await resolveRootSession(sessionID)
      const item = store.getItem(rootID, itemID)
      if (!item || item.status !== "open") return { ok: false }
      clearPendingClose(rootID, itemID)
      discuss.stopForItem(itemID)
      const now = Date.now()
      store.putItem({
        ...item,
        status: "withdrawn",
        withdrawnReason: reason?.trim() || "Dismissed by user",
        withdrawnAt: new Date(now).toISOString(),
        updatedAt: now,
      })
      await emitChanged({ sessionID: rootID, reason: "withdrawn", itemID })
      return { ok: true }
    },

    sendChat: async (rawInput) => {
      const input = rawInput as { sessionID: string; itemID: string; text: string; explainSimply?: boolean }
      const { rootID } = await resolveRootSession(input.sessionID)
      const text = (input.explainSimply ? EXPLAIN_SIMPLY_USER_TEXT : input.text).trim()
      if (!text) return { ok: false, error: "Message is empty." }
      if (text.length > CHAT_MESSAGE_CHARS) {
        return { ok: false, error: `Chat message exceeds ${CHAT_MESSAGE_CHARS} characters.` }
      }
      const item = store.getItem(rootID, input.itemID)
      if (!item || item.status !== "open") return { ok: false, error: "Item is not open." }

      const now = Date.now()
      const msg: ChatMessage = {
        id: messageId(now),
        kind: "you",
        itemID: item.id,
        text,
        at: now,
        status: "queued",
      }
      updateChatList(rootID, (list) => [...list, msg])
      void runDiscussForOwner(rootID, msg.id).catch(() => undefined)
      return { ok: true, messageID: msg.id }
    },

    retryChat: async (rawInput) => {
      const { sessionID, messageID } = rawInput as { sessionID: string; messageID: string }
      const { rootID } = await resolveRootSession(sessionID)
      setOwnMessage(rootID, messageID, { status: "queued", reason: undefined })
      void runDiscussForOwner(rootID, messageID).catch(() => undefined)
      return { ok: true }
    },

    cancelChat: async (rawInput) => {
      const { sessionID, itemID, messageID } = rawInput as { sessionID: string; itemID: string; messageID?: string }
      const { rootID } = await resolveRootSession(sessionID)
      discuss.stopForItem(itemID)
      if (messageID) {
        updateChatList(rootID, (list) => list.filter((m) => m.id !== messageID))
      }
      return { ok: true }
    },

    undoClose: async (rawInput) => {
      const { sessionID } = rawInput as { sessionID: string }
      const { rootID } = await resolveRootSession(sessionID)
      const undone = clearPendingClose(rootID)
      if (undone) await emitChanged({ sessionID: rootID, reason: "closing" })
      return { ok: undone }
    },
  })

  // ── 2. Native Agent Tools (attention_post / update / withdraw / list) ──────
  const toolReg = await ctx.tool.transform((editor) => {
    editor.namespace({
      name: "attention",
      description: "Non-blocking human attention queue (decisions, approvals, human actions, important acknowledgments).",
    })

    editor.add({
      name: "post",
      description:
        "Post an item to the Attention side panel when something genuinely requires the user's decision, approval, human-only action, or explicit acknowledgment. Keep working on independent tasks afterward.",
      options: { namespace: "attention", codemode: false },
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique lowercase kebab-case slug (e.g. deploy-staging, choose-auth)." },
          kind: {
            type: "string",
            enum: ["decision", "approval", "action", "ack"],
            description: "decision=tradeoff choice; approval=risky/irreversible/external gate; action=only the human can do it; ack=important FYI/caveat that must be acknowledged.",
          },
          urgency: {
            type: "string",
            enum: ["blocking", "normal", "low"],
            description: "blocking=work cannot continue without this; normal=standard priority; low=can wait.",
          },
          title: { type: "string", description: "Crisp one-line headline/question (max 160 chars)." },
          plainSummary: {
            type: "string",
            description: "1-2 plain, jargon-free sentences explaining what is needed and why it matters.",
          },
          details: { type: "string", description: "Optional deeper technical context (collapsed by default in UI)." },
          impact: { type: "string", description: "Short line describing concrete consequences or blast radius." },
          reversible: { type: "boolean", description: "Set false for irreversible/destructive/external actions." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Up to 9 concise answer choices. For kind='ack', defaults to ['Acknowledge']. Empty [] for free-text.",
          },
          recommended: { type: "number", description: "0-based index of your recommended option." },
          allowCustom: { type: "boolean", description: "Allow typed custom answer/override (default true)." },
          defaultAction: { type: "string", description: "What happens while waiting or if deferred." },
        },
        required: ["id", "title", "plainSummary"],
        additionalProperties: false,
      },
      execute: async (raw, toolCtx) => {
        const input = raw as Record<string, unknown>
        const { rootID, isChild, agent } = await resolveRootSession(toolCtx.sessionID)
        const existing = store.getItem(rootID, String(input.id ?? "").trim())
        if (existing) {
          return {
            content: `Item "${existing.id}" already exists (status: ${existing.status}). Use attention_update to edit an open item or pick a new unique id.`,
          }
        }
        const validated = validateNewItem(
          {
            id: String(input.id ?? ""),
            sessionID: toolCtx.sessionID,
            rootSessionID: rootID,
            originAgent: isChild ? (toolCtx.agent || agent || "subagent") : undefined,
            kind: typeof input.kind === "string" ? input.kind : undefined,
            urgency: typeof input.urgency === "string" ? input.urgency : undefined,
            title: String(input.title ?? ""),
            plainSummary: typeof input.plainSummary === "string" ? input.plainSummary : undefined,
            details: typeof input.details === "string" ? input.details : undefined,
            impact: typeof input.impact === "string" ? input.impact : undefined,
            reversible: typeof input.reversible === "boolean" ? input.reversible : undefined,
            options: input.options,
            recommended: typeof input.recommended === "number" ? input.recommended : undefined,
            allowCustom: typeof input.allowCustom === "boolean" ? input.allowCustom : undefined,
            defaultAction: typeof input.defaultAction === "string" ? input.defaultAction : undefined,
          },
          Date.now(),
        )
        if (!validated.ok) return { content: `Invalid attention item: ${validated.error}` }
        store.putItem(validated.item)
        postedInTurn.add(toolCtx.sessionID)
        await emitChanged({
          sessionID: rootID,
          reason: "posted",
          itemID: validated.item.id,
          title: validated.item.title,
          urgency: validated.item.urgency,
          kind: validated.item.kind,
        })
        return {
          content: `Posted to Attention panel: [${validated.item.urgency}/${validated.item.kind}] ${validated.item.id} — "${validated.item.title}". Continue with any work that does not depend on this answer.`,
        }
      },
    })

    editor.add({
      name: "update",
      description: "Clarify or append newly discovered facts to an already open Attention item instead of posting a duplicate.",
      options: { namespace: "attention", codemode: false },
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing open item id." },
          title: { type: "string" },
          plainSummary: { type: "string" },
          details: { type: "string", description: "Replace details text." },
          appendDetails: { type: "string", description: "Append new information to existing details." },
          impact: { type: "string" },
          urgency: { type: "string", enum: ["blocking", "normal", "low"] },
          options: { type: "array", items: { type: "string" } },
          recommended: { type: "number" },
          defaultAction: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (raw, toolCtx) => {
        const input = raw as Record<string, unknown>
        const { rootID } = await resolveRootSession(toolCtx.sessionID)
        const id = String(input.id ?? "").trim()
        const existing = store.getItem(rootID, id)
        if (!existing) return { content: `No item "${id}" found in this session.` }
        if (existing.status !== "open") return { content: `Item "${id}" is already ${existing.status} and cannot be updated.` }
        const updated = applyItemUpdate(existing, input, Date.now())
        store.putItem(updated)
        await emitChanged({ sessionID: rootID, reason: "updated", itemID: updated.id, title: updated.title })
        return { content: `Updated open Attention item "${updated.id}".` }
      },
    })

    editor.add({
      name: "withdraw",
      description: "Withdraw an open Attention item that became unnecessary or moot. Withdrawn items leave the panel immediately and send nothing.",
      options: { namespace: "attention", codemode: false },
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Open item id to withdraw." },
          reason: { type: "string", description: "One-line explanation of why it is no longer needed." },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      execute: async (raw, toolCtx) => {
        const input = raw as { id: string; reason: string }
        const { rootID } = await resolveRootSession(toolCtx.sessionID)
        const id = String(input.id ?? "").trim()
        const existing = store.getItem(rootID, id)
        if (!existing) return { content: `No item "${id}" found.` }
        if (existing.status !== "open") return { content: `Item "${id}" is already ${existing.status}.` }
        clearPendingClose(rootID, id)
        discuss.stopForItem(id)
        const now = Date.now()
        store.putItem({
          ...existing,
          status: "withdrawn",
          withdrawnReason: String(input.reason ?? "").trim() || "No longer needed",
          withdrawnAt: new Date(now).toISOString(),
          updatedAt: now,
        })
        await emitChanged({ sessionID: rootID, reason: "withdrawn", itemID: id })
        return { content: `Withdrew Attention item "${id}".` }
      },
    })

    editor.add({
      name: "list",
      description: "List Attention items in the current session (open, answered, or all).",
      options: { namespace: "attention", codemode: false },
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "answered", "all"] },
        },
        additionalProperties: false,
      },
      execute: async (raw, toolCtx) => {
        const status = (raw as { status?: string })?.status ?? "open"
        const { rootID } = await resolveRootSession(toolCtx.sessionID)
        const items =
          status === "open"
            ? store.listOpen(rootID)
            : status === "answered"
              ? store.listClosed(rootID)
              : store.listAll(rootID)
        if (items.length === 0) {
          return { content: status === "all" ? "No Attention items in this session." : `No ${status} Attention items in this session.` }
        }
        const lines = items.map(
          (i) =>
            `- [${i.status} · ${i.urgency}/${i.kind}] ${i.id}: ${i.title}${i.answer ? ` → ${i.answer}` : ""}`,
        )
        return { content: lines.join("\n") }
      },
    })
  })

  // ── 3. Context Hook (main protocol + DISCUSS sandbox prompt & tool pruning) ─
  const contextHookReg = await ctx.session.hook("context", async (event) => {
    const discussMeta = discuss.activeSessions.get(event.sessionID)
    if (discussMeta) {
      discussMeta.turnsUsed += 1
      // Replace system instructions with strict DISCUSS reasoning-partner prompt
      event.system.length = 0
      event.system.push({ type: "text", text: discussMeta.systemPrompt })
      // Prune all non-read-only tools from the model's visible schema
      for (const toolName of Object.keys(event.tools)) {
        if (!isToolAllowedInDiscussSchema(toolName)) delete event.tools[toolName]
      }
      // Enforce turn budget by stripping tools on the final allowed turn so model must reply with text
      if (discussMeta.turnsUsed >= discussMeta.maxTurns) {
        for (const toolName of Object.keys(event.tools)) delete event.tools[toolName]
        event.system.push({
          type: "text",
          text: "You have reached your step limit for this reply. Write your concise final answer now with what you already verified.",
        })
      }
      return
    }

    const { rootID } = await resolveRootSession(event.sessionID)
    const open = store.listOpen(rootID)
    const silentAcks = store
      .listClosed(rootID)
      .filter((i) => i.silentAck === true)
      .slice(0, 10)
    event.system.push({ type: "text", text: protocolText(open, silentAcks) })
  })

  // ── 4. Read-Only Enforcement Hooks for DISCUSS Scratch Sessions ────────────
  const permHookReg = await ctx.permission.hook("evaluate", async (event) => {
    if (!discuss.activeSessions.has(event.sessionID)) return
    const action = event.action
    if (action === "edit" || action === "write" || action === "subagent") {
      event.effect = "deny"
      event.message = `Read-only DISCUSS chat refuses "${action}".`
      return
    }
    if (action === "read" || action === "grep" || action === "glob") {
      const worktrees = await discuss.getAllowedWorktrees()
      for (const resource of event.resources) {
        const res = checkReadOnlyTool(action, { path: resource }, worktrees)
        if (!res.allow) {
          event.effect = "deny"
          event.message = res.reason
          return
        }
      }
      event.effect = "allow"
      return
    }
    if (action === "shell") {
      const worktrees = await discuss.getAllowedWorktrees()
      for (const resource of event.resources) {
        const res = checkReadOnlyTool("shell", { command: resource }, worktrees)
        if (!res.allow) {
          event.effect = "deny"
          event.message = res.reason
          return
        }
      }
      event.effect = "allow"
      return
    }
    if (action === "websearch" || action === "webfetch") {
      event.effect = "allow"
      return
    }
    // Never prompt the user from a DISCUSS scratch session
    if (event.effect === "ask") {
      event.effect = "deny"
      event.message = `Read-only DISCUSS chat cannot prompt for "${action}".`
    }
  })

  const toolBeforeReg = await ctx.tool.hook("execute.before", async (event) => {
    if (!discuss.activeSessions.has(event.sessionID)) return
    const worktrees = await discuss.getAllowedWorktrees()
    const check = checkReadOnlyTool(event.tool, event.input, worktrees)
    if (!check.allow) {
      throw new Error(check.reason)
    }
    discuss.observeToolCall(event.sessionID, event.tool, event.input)
  })

  // ── 5. Idle Attention Catcher (surfaces buried questions/caveats on idle) ──
  const idleHookReg = await ctx.session.hook("experimental.idle", async (event) => {
    if (!options.idleCatcher.enabled) return
    if (discuss.activeSessions.has(event.sessionID)) return
    // Don't interrupt while background work (subagents/shells) is still running
    if (event.background.length > 0) return

    const didPost = postedInTurn.delete(event.sessionID)
    if (didPost) return

    // Skip subagent child sessions for idle-catching (they report to their parent, not the user)
    const { rootID, isChild } = await resolveRootSession(event.sessionID)
    if (isChild) return

    try {
      const messages = await ctx.session.context({ sessionID: event.sessionID })
      const lastAssistant = [...messages].reverse().find((m) => m.type === "assistant")
      if (!lastAssistant || lastAssistant.type !== "assistant") return
      if (caughtMessageIds.has(lastAssistant.id)) return
      caughtMessageIds.add(lastAssistant.id)

      const assistantText = lastAssistant.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join("\n\n")

      const openItems = store.listOpen(rootID)
      const caught = await detectMissedAttention({
        ctx,
        sessionID: event.sessionID,
        assistantText,
        openItems,
        modelSpec: options.idleCatcher.model,
        minChars: options.idleCatcher.minChars,
      })
      if (!caught) return

      // Ensure unique ID within the session
      let finalId = caught.id
      let suffix = 2
      while (store.getItem(rootID, finalId)) {
        finalId = `${caught.id.slice(0, 58)}-${suffix}`
        suffix += 1
      }

      const validated = validateNewItem(
        {
          id: finalId,
          sessionID: event.sessionID,
          rootSessionID: rootID,
          kind: caught.kind,
          urgency: caught.urgency,
          title: caught.title,
          plainSummary: caught.plainSummary,
          details: assistantText.slice(0, 1500),
          impact: caught.impact,
          reversible: caught.reversible,
          options: caught.options,
          recommended: caught.recommended,
          allowCustom: true,
          autoCaptured: true,
        },
        Date.now(),
      )
      if (!validated.ok) return

      store.putItem(validated.item)
      await emitChanged({
        sessionID: rootID,
        reason: "posted",
        itemID: validated.item.id,
        title: validated.item.title,
        urgency: validated.item.urgency,
        kind: validated.item.kind,
      })
    } catch {
      // Idle catcher is strictly best-effort and must never disrupt the session
    }
  })

  // ── 6. Background Event Listener (track session titles & DISCUSS tools) ────
  const eventAbort = new AbortController()
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({
        types: ["session.renamed", "session.created", "session.deleted"],
        signal: eventAbort.signal,
      })) {
        if (ev.type === "session.renamed" || ev.type === "session.created") {
          const d = ev.data as { sessionID?: string; id?: string; title?: string; session?: { id?: string; title?: string } }
          const sid = d.sessionID ?? d.session?.id ?? d.id
          const title = d.title ?? d.session?.title
          if (sid && title) store.setSessionTitle(sid, title)
        } else if (ev.type === "session.deleted") {
          const d = ev.data as { sessionID?: string }
          if (d.sessionID) {
            clearPendingClose(d.sessionID)
            rootCache.delete(d.sessionID)
          }
        }
      }
    } catch {
      // stream aborted on cleanup
    }
  })()

  return async () => {
    eventAbort.abort()
    discuss.stopAll()
    for (const timer of closeTimersByRoot.values()) clearTimeout(timer)
    closeTimersByRoot.clear()
    await Promise.allSettled([
      rpcReg.dispose(),
      toolReg.dispose(),
      contextHookReg.dispose(),
      permHookReg.dispose(),
      toolBeforeReg.dispose(),
      idleHookReg.dispose(),
    ])
  }
}

export default Plugin.define({
  id: "attention",
  setup: setupAttention,
})
