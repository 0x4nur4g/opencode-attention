/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand, PanelInput } from "@opencode/plugin/tui/context"
import type { InputRenderable } from "@opentui/core"
import { For, Show, createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { STARTER_PROMPTS, threadFor } from "./chat.js"
import { isRiskyOption, successor } from "./queue.js"
import { AttentionRpc } from "./rpc.js"
import type {
  ChatMessage,
  ItemKind,
  ItemUrgency,
  OtherSessionSummary,
  PendingClose,
  QueueItem,
  SessionSnapshot,
} from "./types.js"

const PANEL_NAME = "attention.panel"
type ViewMode = "focus" | "inbox"

interface UIState {
  snapshots: Record<string, SessionSnapshot>
  focusedItemID: Record<string, string>
  viewMode: Record<string, ViewMode>
  expandedDetails: Record<string, boolean>
  expandedMessages: Record<string, boolean>
  chatInput: Record<string, string>
  inputFocused: Record<string, boolean>
  panelFocused: Record<string, boolean>
  now: number
}

interface ChangedEvent {
  sessionID: string
  reason: string
  itemID?: string
  title?: string
  urgency?: string
  kind?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const optionalStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined

function readItem(value: unknown): QueueItem | undefined {
  if (!isRecord(value)) return undefined
  const { id, sessionID, rootSessionID, title, kind, urgency, status } = value
  if (
    typeof id !== "string" ||
    typeof sessionID !== "string" ||
    typeof rootSessionID !== "string" ||
    typeof title !== "string" ||
    (kind !== "decision" && kind !== "approval" && kind !== "action" && kind !== "ack") ||
    (urgency !== "blocking" && urgency !== "normal" && urgency !== "low") ||
    (status !== "open" && status !== "answered" && status !== "withdrawn") ||
    !Array.isArray(value.options)
  ) {
    return undefined
  }

  return {
    id,
    sessionID,
    rootSessionID,
    ...(typeof value.originAgent === "string" ? { originAgent: value.originAgent } : {}),
    kind,
    urgency,
    title,
    plainSummary: typeof value.plainSummary === "string" ? value.plainSummary : "",
    details: typeof value.details === "string" ? value.details : "",
    ...(typeof value.impact === "string" ? { impact: value.impact } : {}),
    ...(typeof value.reversible === "boolean" ? { reversible: value.reversible } : {}),
    options: value.options.filter((option): option is string => typeof option === "string"),
    ...(finiteNumber(value.recommended) ? { recommended: value.recommended } : {}),
    allowCustom: typeof value.allowCustom === "boolean" ? value.allowCustom : true,
    ...(typeof value.defaultAction === "string" ? { defaultAction: value.defaultAction } : {}),
    ...(value.autoCaptured === true ? { autoCaptured: true } : {}),
    status,
    createdAt: finiteNumber(value.createdAt) ? value.createdAt : 0,
    updatedAt: finiteNumber(value.updatedAt) ? value.updatedAt : 0,
    ...(finiteNumber(value.snoozedAt) ? { snoozedAt: value.snoozedAt } : {}),
    ...(typeof value.answer === "string" ? { answer: value.answer } : {}),
    ...(typeof value.answeredAt === "string" ? { answeredAt: value.answeredAt } : {}),
    ...(value.closedFromChat === true ? { closedFromChat: true } : {}),
    ...(value.silentAck === true ? { silentAck: true } : {}),
    ...(typeof value.withdrawnReason === "string" ? { withdrawnReason: value.withdrawnReason } : {}),
    ...(typeof value.withdrawnAt === "string" ? { withdrawnAt: value.withdrawnAt } : {}),
  }
}

function readChatMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value)) return undefined
  const { id, itemID, at, kind } = value
  if (typeof id !== "string" || typeof itemID !== "string" || !finiteNumber(at)) return undefined

  if (kind === "you") {
    const status = value.status
    if (
      typeof value.text !== "string" ||
      (status !== "queued" && status !== "thinking" && status !== "answered" && status !== "failed")
    ) {
      return undefined
    }
    return {
      id,
      kind,
      itemID,
      text: value.text,
      at,
      status,
      ...(finiteNumber(value.since) ? { since: value.since } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(value.resent === true ? { resent: true } : {}),
    }
  }

  if (kind === "assistant") {
    if (typeof value.text !== "string") return undefined
    const checked = optionalStrings(value.checked)
    return {
      id,
      kind,
      itemID,
      text: value.text,
      at,
      ...(typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(finiteNumber(value.seconds) ? { seconds: value.seconds } : {}),
      ...(checked ? { checked } : {}),
    }
  }

  if (kind === "sent") {
    if (typeof value.title !== "string" || typeof value.text !== "string" || !finiteNumber(value.count)) {
      return undefined
    }
    return {
      id,
      kind,
      itemID,
      title: value.title,
      text: value.text,
      at,
      count: value.count,
      ...(value.silent === true ? { silent: true } : {}),
      ...(value.closedFromChat === true ? { closedFromChat: true } : {}),
    }
  }
  return undefined
}

function readOtherSession(value: unknown): OtherSessionSummary | undefined {
  if (
    !isRecord(value) ||
    typeof value.sessionID !== "string" ||
    typeof value.title !== "string" ||
    !finiteNumber(value.openCount) ||
    !finiteNumber(value.blockingCount)
  ) {
    return undefined
  }
  return {
    sessionID: value.sessionID,
    title: value.title,
    openCount: value.openCount,
    blockingCount: value.blockingCount,
  }
}

function readPendingClose(value: unknown): PendingClose | null | undefined {
  if (value === null) return null
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    typeof value.itemID !== "string" ||
    typeof value.decision !== "string" ||
    typeof value.context !== "string" ||
    !finiteNumber(value.dueAt)
  ) {
    return undefined
  }
  return {
    token: value.token,
    itemID: value.itemID,
    decision: value.decision,
    context: value.context,
    dueAt: value.dueAt,
  }
}

function readSnapshot(value: unknown, requestedSessionID: string): SessionSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.open) ||
    !Array.isArray(value.closed) ||
    !Array.isArray(value.chat) ||
    !Array.isArray(value.otherSessions)
  ) {
    return undefined
  }
  const pendingClose = readPendingClose(value.pendingClose)
  if (pendingClose === undefined) return undefined

  const liveActivity: Record<string, string> = {}
  if (isRecord(value.liveActivity)) {
    for (const [id, activity] of Object.entries(value.liveActivity)) {
      if (typeof activity === "string") liveActivity[id] = activity
    }
  }

  return {
    sessionID: typeof value.sessionID === "string" ? value.sessionID : requestedSessionID,
    open: value.open.map(readItem).filter((item): item is QueueItem => item !== undefined),
    closed: value.closed.map(readItem).filter((item): item is QueueItem => item !== undefined),
    chat: value.chat.map(readChatMessage).filter((message): message is ChatMessage => message !== undefined),
    pendingClose,
    liveActivity,
    otherSessions: value.otherSessions
      .map(readOtherSession)
      .filter((session): session is OtherSessionSummary => session !== undefined),
    now: finiteNumber(value.now) ? value.now : Date.now(),
  }
}

function readChangedEvent(value: unknown): ChangedEvent | undefined {
  if (!isRecord(value) || typeof value.sessionID !== "string" || typeof value.reason !== "string") {
    return undefined
  }
  return {
    sessionID: value.sessionID,
    reason: value.reason,
    ...(typeof value.itemID === "string" ? { itemID: value.itemID } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.urgency === "string" ? { urgency: value.urgency } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
  }
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (isRecord(error)) {
    const msg = typeof error.message === "string" ? error.message : undefined
    const type = typeof error.type === "string" ? error.type : undefined
    if (msg && type && !msg.includes(type)) return `${msg} (${type})`
    if (msg) return msg
    if (type) return type
    try {
      return JSON.stringify(error)
    } catch {
      return "Unknown error"
    }
  }
  return String(error)
}

export default Plugin.define({
  id: "attention.tui",
  setup(context) {
    const rpc = context.client.rpc(AttentionRpc)
    const theme = context.theme
    const [state, setState] = createStore<UIState>({
      snapshots: {},
      focusedItemID: {},
      viewMode: {},
      expandedDetails: {},
      expandedMessages: {},
      chatInput: {},
      inputFocused: {},
      panelFocused: {},
      now: Date.now(),
    })

    // ponytail: Keep snapshots ephemeral; the server remains the source of truth for queue and chat state.
    const requestVersions = new Map<string, number>()
    const inFlightSnapshots = new Map<string, Promise<void>>()
    const inputRefs = new Map<string, InputRenderable>()
    const panelInputs = new Map<string, PanelInput>()
    const slotCleanups: Array<() => void> = []
    let ticker: ReturnType<typeof setInterval> | undefined
    let disposed = false

    const showToast = (
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
      title = "Attention",
    ): void => {
      context.ui.toast.show({ title, message, variant, duration: 3500 })
    }

    const syncTicker = (): void => {
      const active = Object.values(state.snapshots).some(
        (snapshot) =>
          snapshot.pendingClose !== null ||
          snapshot.chat.some((message) => message.kind === "you" && message.status === "thinking"),
      )
      if (active && ticker === undefined) {
        ticker = setInterval(() => setState("now", Date.now()), 1000)
      } else if (!active && ticker !== undefined) {
        clearInterval(ticker)
        ticker = undefined
      }
    }

    const locationsBySession = new Map<string, { directory: string; workspaceID?: string }>()

    const rpcOpts = (sessionID: string) => ({
      location:
        context.data.session.get(sessionID)?.location ??
        locationsBySession.get(sessionID) ??
        context.location ??
        context.data.location.default(),
    })

    const refreshSnapshot = async (sessionID: string): Promise<void> => {
      const version = (requestVersions.get(sessionID) ?? 0) + 1
      requestVersions.set(sessionID, version)
      try {
        if (!context.data.session.get(sessionID)?.location && !locationsBySession.has(sessionID)) {
          await context.data.session.sync(sessionID).catch(() => undefined)
        }
        const raw: unknown = await rpc.snapshot({ sessionID }, rpcOpts(sessionID))
        const snapshot = readSnapshot(raw, sessionID)
        if (disposed || version !== requestVersions.get(sessionID)) return
        if (!snapshot) {
          if (!state.snapshots[sessionID]) showToast("Could not read the session snapshot.", "error")
          return
        }
        const prevOpen = state.snapshots[sessionID]?.open ?? []
        const focusedID = state.focusedItemID[sessionID] ?? ""
        setState("snapshots", sessionID, snapshot)
        const wasOpen = focusedID !== "" && prevOpen.some((item) => item.id === focusedID)
        const stillOpen = focusedID !== "" && snapshot.open.some((item) => item.id === focusedID)
        const stillClosed = focusedID !== "" && snapshot.closed.some((item) => item.id === focusedID)
        if (wasOpen && !stillOpen) {
          // Item was answered, dismissed, or withdrawn: auto-advance to next open item (or "" if caught up)
          setState("focusedItemID", sessionID, successor(prevOpen, focusedID, snapshot.open))
        } else if (!focusedID || (!stillOpen && !stillClosed)) {
          setState("focusedItemID", sessionID, snapshot.open[0]?.id ?? "")
        }
        syncTicker()
      } catch (error) {
        if (!disposed && !state.snapshots[sessionID]) {
          const msg = errorMessage(error)
          if (msg.includes("rpc.unavailable") || msg.includes("RPC is unavailable")) {
            // Server plugin may still be booting for this location; retry quietly once
            setTimeout(() => {
              if (!disposed && !state.snapshots[sessionID]) void refreshSnapshot(sessionID)
            }, 1200)
          } else {
            showToast(`Could not load this session: ${msg}`, "error")
          }
        }
      }
    }

    const ensureSnapshot = (sessionID: string): void => {
      if (state.snapshots[sessionID] || inFlightSnapshots.has(sessionID)) return
      const pending = refreshSnapshot(sessionID)
      inFlightSnapshots.set(sessionID, pending)
      void pending.finally(() => {
        if (inFlightSnapshots.get(sessionID) === pending) inFlightSnapshots.delete(sessionID)
      })
    }

    const button = (
      label: string,
      onActivate: () => void,
      color = theme.text.feedback.info.base,
      disabled = false,
    ) => (
      <text fg={disabled ? theme.text.faint : color} onMouseUp={disabled ? undefined : onActivate}>
        {label}
      </text>
    )

    const routedSessionID = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const activePanelSessionID = (): string | undefined => {
      const panel = context.ui.panel.current()
      if (panel?.name === PANEL_NAME) return panel.sessionID
      return routedSessionID()
    }

    const openPanel = (toggle = false): void => {
      const panel = context.ui.panel.current()
      if (toggle && panel?.name === PANEL_NAME) {
        context.ui.panel.close()
        return
      }
      if (routedSessionID() === undefined) {
        showToast("Open a session to view its attention queue.", "warning")
        return
      }
      context.ui.panel.open(PANEL_NAME)
    }

    const focusItem = (sessionID: string, itemID: string): void => {
      setState("focusedItemID", sessionID, itemID)
    }

    const selectedItem = (sessionID: string): QueueItem | undefined => {
      const snapshot = state.snapshots[sessionID]
      if (!snapshot) return undefined
      const itemID = state.focusedItemID[sessionID] ?? ""
      if (itemID !== "") {
        const direct =
          snapshot.open.find((item) => item.id === itemID) ??
          snapshot.closed.find((item) => item.id === itemID)
        if (direct) return direct
      }
      return snapshot.open[0]
    }

    const selectedOpenItem = (sessionID: string): QueueItem | undefined => {
      const item = selectedItem(sessionID)
      return item?.status === "open" ? item : undefined
    }

    const requestOk = async (
      sessionID: string,
      action: string,
      request: () => Promise<unknown>,
    ): Promise<Record<string, unknown> | undefined> => {
      try {
        const raw = await request()
        if (!isRecord(raw) || raw.ok !== true) {
          const reason = isRecord(raw) && typeof raw.error === "string" ? raw.error : `${action} failed.`
          showToast(reason, "error")
          await refreshSnapshot(sessionID)
          return undefined
        }
        await refreshSnapshot(sessionID)
        return raw
      } catch (error) {
        showToast(`${action} failed: ${errorMessage(error)}`, "error")
        await refreshSnapshot(sessionID)
        return undefined
      }
    }

    const answerItem = async (
      sessionID: string,
      itemID: string,
      answer: string,
      typed = false,
    ): Promise<void> => {
      const result = await requestOk(sessionID, "Answer", () =>
        rpc.answer({ sessionID, itemID, answer, typed }, rpcOpts(sessionID)),
      )
      if (result?.silent === true) showToast("Acknowledged silently.", "success")
    }

    const answerOption = (sessionID: string, optionIndex: number): void => {
      const item = selectedOpenItem(sessionID)
      const option = item?.options[optionIndex]
      if (item && option !== undefined) void answerItem(sessionID, item.id, option)
    }

    const acknowledge = (sessionID: string): void => {
      const item = selectedOpenItem(sessionID)
      if (item?.kind === "ack") {
        void answerItem(sessionID, item.id, item.options[0] ?? "Acknowledge")
      }
    }

    const customAnswer = async (sessionID: string): Promise<void> => {
      const item = selectedOpenItem(sessionID)
      if (!item?.allowCustom) return
      const answer = await context.ui.dialog.prompt({
        title: "Custom / Override",
        description: item.title,
        placeholder: "Type your decision or comment",
      })
      if (answer?.trim()) void answerItem(sessionID, item.id, answer.trim(), true)
    }

    const snoozeItem = async (sessionID: string, itemID: string): Promise<void> => {
      const prevOpen = state.snapshots[sessionID]?.open ?? []
      const res = await requestOk(sessionID, "Snooze", () => rpc.snooze({ sessionID, itemID }, rpcOpts(sessionID)))
      if (res) {
        const nextOpen = state.snapshots[sessionID]?.open ?? []
        const remaining = nextOpen.filter((item) => item.id !== itemID)
        const nextID = remaining.length > 0 ? successor(prevOpen, itemID, remaining) : itemID
        setState("focusedItemID", sessionID, nextID)
      }
    }

    const dismissItem = (sessionID: string, itemID: string): void => {
      void requestOk(sessionID, "Dismiss", () =>
        rpc.dismiss({ sessionID, itemID, reason: "Dismissed by user" }, rpcOpts(sessionID)),
      )
    }

    const sendChat = async (
      sessionID: string,
      itemID: string,
      text: string,
      explainSimply = false,
    ): Promise<void> => {
      const result = await requestOk(sessionID, "Send message", () =>
        rpc.sendChat({ sessionID, itemID, text, ...(explainSimply ? { explainSimply: true } : {}) }, rpcOpts(sessionID)),
      )
      if (result) setState("chatInput", sessionID, "")
    }

    const sendExplainSimply = (sessionID: string): void => {
      const item = selectedOpenItem(sessionID)
      if (item) void sendChat(sessionID, item.id, STARTER_PROMPTS[0], true)
    }

    const retryMessage = (sessionID: string, messageID: string): void => {
      void requestOk(sessionID, "Retry", () => rpc.retryChat({ sessionID, messageID }, rpcOpts(sessionID)))
    }

    const cancelMessage = (sessionID: string, itemID: string, messageID: string): void => {
      void requestOk(sessionID, "Cancel reply", () =>
        rpc.cancelChat({ sessionID, itemID, messageID }, rpcOpts(sessionID)),
      )
    }

    const retryLatestFailed = (sessionID: string): void => {
      const item = selectedOpenItem(sessionID)
      const message = item
        ? state.snapshots[sessionID]?.chat
            .filter(
              (entry): entry is Extract<ChatMessage, { kind: "you" }> =>
                entry.kind === "you" && entry.itemID === item.id && entry.status === "failed",
            )
            .at(-1)
        : undefined
      if (message) retryMessage(sessionID, message.id)
    }

    const cancelLatestReply = (sessionID: string): void => {
      const item = selectedOpenItem(sessionID)
      const message = item
        ? state.snapshots[sessionID]?.chat
            .filter(
              (entry): entry is Extract<ChatMessage, { kind: "you" }> =>
                entry.kind === "you" && entry.itemID === item.id && entry.status === "thinking",
            )
            .at(-1)
        : undefined
      if (item && message) cancelMessage(sessionID, item.id, message.id)
    }

    const batchAck = async (sessionID: string): Promise<void> => {
      try {
        const raw: unknown = await rpc.batchAck({ sessionID }, rpcOpts(sessionID))
        if (!isRecord(raw) || !finiteNumber(raw.acked)) {
          showToast("Batch acknowledgment returned an invalid response.", "error")
        } else {
          const errors = optionalStrings(raw.errors) ?? []
          showToast(
            errors.length > 0
              ? `Acknowledged ${raw.acked}; ${errors.length} item(s) failed.`
              : `Acknowledged ${raw.acked} safe FYI item(s).`,
            errors.length > 0 ? "warning" : "success",
          )
        }
        await refreshSnapshot(sessionID)
      } catch (error) {
        showToast(`Batch acknowledgment failed: ${errorMessage(error)}`, "error")
        await refreshSnapshot(sessionID)
      }
    }

    const undoClose = (sessionID: string): void => {
      void requestOk(sessionID, "Undo close", () => rpc.undoClose({ sessionID }, rpcOpts(sessionID)))
    }

    const toggleView = (sessionID: string): void => {
      setState(
        "viewMode",
        sessionID,
        state.viewMode[sessionID] === "inbox" ? "focus" : "inbox",
      )
    }

    const toggleDetails = (sessionID: string, itemID: string): void => {
      const key = `${sessionID}:${itemID}`
      setState("expandedDetails", key, !state.expandedDetails[key])
    }

    const moveFocus = (sessionID: string, direction: -1 | 1): void => {
      const items = state.snapshots[sessionID]?.open ?? []
      if (items.length === 0) return
      const currentID = state.focusedItemID[sessionID]
      const currentIndex = items.findIndex((item) => item.id === currentID)
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + items.length) % items.length
      const next = items[nextIndex]
      if (next) focusItem(sessionID, next.id)
    }

    const jumpToSession = (sessionID: string): void => {
      context.ui.router.navigate({ type: "session", sessionID })
      context.ui.panel.open(PANEL_NAME)
    }

    const toggleFullscreen = (sessionID: string): void => {
      panelInputs.get(sessionID)?.toggleFullscreen()
    }

    const focusChatInput = (sessionID: string): void => {
      const input = inputRefs.get(sessionID)
      if (!input) return
      input.focus()
      setState("inputFocused", sessionID, true)
    }

    const panelCommands: KeymapCommand[] = [
      {
        id: "attention.close",
        title: "Close Attention panel",
        group: "Attention",
        bind: "esc",
        run: () => context.ui.panel.close(),
      },
      {
        id: "attention.ack",
        title: "Acknowledge",
        group: "Attention",
        bind: "a",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) acknowledge(sessionID)
        },
      },
      {
        id: "attention.custom",
        title: "Custom answer",
        group: "Attention",
        bind: "t",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) void customAnswer(sessionID)
        },
      },
      {
        id: "attention.explain",
        title: "Explain simply",
        group: "Attention",
        bind: "e",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) sendExplainSimply(sessionID)
        },
      },
      {
        id: "attention.snooze",
        title: "Snooze item",
        group: "Attention",
        bind: "s",
        run: () => {
          const sessionID = activePanelSessionID()
          const item = sessionID ? selectedOpenItem(sessionID) : undefined
          if (sessionID && item) snoozeItem(sessionID, item.id)
        },
      },
      {
        id: "attention.previous",
        title: "Previous item",
        group: "Attention",
        bind: "p",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) moveFocus(sessionID, -1)
        },
      },
      {
        id: "attention.next",
        title: "Next item",
        group: "Attention",
        bind: "n",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) moveFocus(sessionID, 1)
        },
      },
      {
        id: "attention.view",
        title: "Toggle Inbox / Focus",
        group: "Attention",
        bind: "i",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) toggleView(sessionID)
        },
      },
      {
        id: "attention.details",
        title: "Toggle details",
        group: "Attention",
        bind: "d",
        run: () => {
          const sessionID = activePanelSessionID()
          const item = sessionID ? selectedItem(sessionID) : undefined
          if (sessionID && item) toggleDetails(sessionID, item.id)
        },
      },
      {
        id: "attention.chat",
        title: "Focus chat input",
        group: "Attention",
        bind: "c",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) focusChatInput(sessionID)
        },
      },
      {
        id: "attention.undo",
        title: "Undo pending close",
        group: "Attention",
        bind: "u",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) undoClose(sessionID)
        },
      },
      {
        id: "attention.batch-ack",
        title: "Batch-ack safe FYIs",
        group: "Attention",
        bind: "shift+a",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) void batchAck(sessionID)
        },
      },
      {
        id: "attention.fullscreen",
        title: "Toggle fullscreen",
        group: "Attention",
        bind: "f",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) toggleFullscreen(sessionID)
        },
      },
      {
        id: "attention.retry-chat",
        title: "Retry failed reply",
        group: "Attention",
        bind: "r",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) retryLatestFailed(sessionID)
        },
      },
      {
        id: "attention.cancel-chat",
        title: "Cancel running reply",
        group: "Attention",
        bind: "x",
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) cancelLatestReply(sessionID)
        },
      },
    ]

    for (let option = 1; option <= 9; option += 1) {
      const index = option - 1
      panelCommands.push({
        id: `attention.option.${option}`,
        title: `Choose option ${option}`,
        group: "Attention",
        bind: String(option),
        run: () => {
          const sessionID = activePanelSessionID()
          if (sessionID) answerOption(sessionID, index)
        },
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      bindings: ["attention.open"],
      commands: [
        {
          id: "attention.open",
          title: "Open Attention",
          description: "Open or close the Attention panel for this session.",
          group: "Attention",
          slash: { name: "attention", aliases: ["attn"] },
          palette: true,
          bind: "<leader>d",
          run: () => openPanel(true),
        },
      ],
    }))

    context.keymap.layer(() => ({
      mode: "global",
      bindings: panelCommands
        .map((command) => command.id)
        .filter((id): id is string => id !== undefined),
      enabled: () => {
        const panel = context.ui.panel.current()
        return (
          panel?.name === PANEL_NAME &&
          state.panelFocused[panel.sessionID] === true &&
          state.inputFocused[panel.sessionID] !== true
        )
      },
      commands: panelCommands,
    }))

    const renderPanel = (panel: PanelInput) => {
      if (panel.name !== PANEL_NAME) return null
      return <AttentionPanel panel={panel} />
    }

    function AttentionPanel(props: { panel: PanelInput }) {
      const sessionID = (): string => props.panel.sessionID
      const snapshot = (): SessionSnapshot | undefined => state.snapshots[sessionID()]

      createEffect(() => {
        const sid = sessionID()
        panelInputs.set(sid, props.panel)
        setState("panelFocused", sid, props.panel.focused)
        if (!state.snapshots[sid]) ensureSnapshot(sid)
        onCleanup(() => {
          if (panelInputs.get(sid) === props.panel) panelInputs.delete(sid)
          setState("panelFocused", sid, false)
        })
      })

      const otherCount = (): number =>
        snapshot()?.otherSessions.reduce((total, other) => total + other.openCount, 0) ?? 0
      const openCount = (): number => snapshot()?.open.length ?? 0
      const blockingCount = (): number =>
        (snapshot()?.open.filter((item) => item.urgency === "blocking").length ?? 0) +
        (snapshot()?.otherSessions.reduce((total, other) => total + other.blockingCount, 0) ?? 0)
      const nativeAttentionCount = (): number => {
        const family = context.data.session.family(sessionID())
        let total = 0
        for (const sid of family) {
          total += (context.data.session.permission.list(sid)?.length ?? 0)
          total += (context.data.session.form.list(sid)?.length ?? 0)
        }
        return total
      }

      return (
        <box
          flexDirection="column"
          flexGrow={1}
          width="100%"
          height="100%"
          gap={1}
          padding={1}
          backgroundColor={theme.background.raised.base}
          border
          borderColor={theme.border.base}
        >
          <box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
            <text fg={theme.text.base}>
              <strong>ATTENTION</strong>
            </text>
            <text fg={theme.text.muted}>
              {openCount()} open{otherCount() > 0 ? ` · ${otherCount()} elsewhere` : ""}
              {nativeAttentionCount() > 0 ? ` · ${nativeAttentionCount()} native` : ""}
            </text>
            <Show when={blockingCount() > 0}>
              <text fg={theme.text.feedback.error.base}>
                <strong>BLOCKING {blockingCount()}</strong>
              </text>
            </Show>
            <box flexDirection="row" gap={1}>
              {button(
                state.viewMode[sessionID()] === "inbox" ? "[i] Focus" : "[i] Inbox",
                () => toggleView(sessionID()),
                theme.text.feedback.info.base,
              )}
              {button("[f] Fullscreen", props.panel.toggleFullscreen, theme.text.muted)}
              {button("[Esc] Close", props.panel.close, theme.text.muted)}
            </box>
          </box>

          <Show when={(snapshot()?.otherSessions.length ?? 0) > 0}>
            <box
              flexDirection="row"
              flexWrap="wrap"
              gap={1}
              paddingX={1}
              backgroundColor={theme.background.raised.high}
            >
              <text fg={theme.text.feedback.warning.base}>Other sessions need attention:</text>
              <For each={snapshot()?.otherSessions ?? []}>
                {(other) =>
                  button(
                    `${other.title} · ${other.openCount} open`,
                    () => jumpToSession(other.sessionID),
                    theme.text.feedback.info.base,
                  )
                }
              </For>
            </box>
          </Show>

          <Show
            when={snapshot()}
            fallback={<text fg={theme.text.muted}>Loading Attention…</text>}
          >
            {(currentSnapshot) => (
              <Show
                when={state.viewMode[sessionID()] === "inbox"}
                fallback={
                  <FocusView
                    sessionID={sessionID()}
                    snapshot={currentSnapshot}
                  />
                }
              >
                <InboxView
                  sessionID={sessionID()}
                  snapshot={currentSnapshot}
                />
              </Show>
            )}
          </Show>
        </box>
      )
    }

    function FocusView(props: {
      sessionID: string
      snapshot: Accessor<SessionSnapshot>
    }) {
      const activeItem = (): QueueItem | undefined => {
        const current = props.snapshot()
        const focusedID = state.focusedItemID[props.sessionID] ?? ""
        if (focusedID !== "") {
          const direct =
            current.open.find((item) => item.id === focusedID) ??
            current.closed.find((item) => item.id === focusedID)
          if (direct) return direct
        }
        return current.open[0]
      }

      const openIndex = (): number => {
        const item = activeItem()
        return item ? props.snapshot().open.findIndex((openItem) => openItem.id === item.id) : -1
      }

      const positionLabel = (): string => {
        const index = openIndex()
        if (index >= 0) return `${index + 1} of ${props.snapshot().open.length}`
        return activeItem() ? "Closed item" : `0 of ${props.snapshot().open.length}`
      }

      const navigate = (direction: -1 | 1): void => moveFocus(props.sessionID, direction)

      return (
        <box flexDirection="column" flexGrow={1} gap={1}>
          <box flexDirection="row" alignItems="center" flexWrap="wrap" gap={1}>
            {button("[p] Prev", () => navigate(-1), theme.text.muted, props.snapshot().open.length === 0)}
            <text fg={theme.text.base}>{positionLabel()}</text>
            {button("[n] Next", () => navigate(1), theme.text.muted, props.snapshot().open.length === 0)}
            {button(
              "[s] Snooze",
              () => {
                const item = selectedOpenItem(props.sessionID)
                if (item) snoozeItem(props.sessionID, item.id)
              },
              theme.text.feedback.warning.base,
              selectedOpenItem(props.sessionID) === undefined,
            )}
            {button("[e] Explain simply", () => sendExplainSimply(props.sessionID))}
            {button(
              "[d] Details",
              () => {
                const item = activeItem()
                if (item) toggleDetails(props.sessionID, item.id)
              },
              theme.text.muted,
              activeItem() === undefined,
            )}
            <Show when={activeItem()?.autoCaptured === true && activeItem()?.status === "open"}>
              <>{button(
                "[Dismiss]",
                () => {
                  const item = activeItem()
                  if (item) dismissItem(props.sessionID, item.id)
                },
                theme.text.feedback.error.base,
              )}</>
            </Show>
          </box>

          <Show
            when={activeItem()}
            fallback={
              <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
                <text fg={theme.text.feedback.success.base}>
                  <strong>You're all caught up</strong>
                </text>
                <text fg={theme.text.muted}>No open items waiting on you in this session.</text>
                <Show when={props.snapshot().closed.length > 0}>
                  <>{button(
                    `[i] View ${props.snapshot().closed.length} closed item(s)`,
                    () => setState("viewMode", props.sessionID, "inbox"),
                    theme.text.feedback.info.base,
                  )}</>
                </Show>
              </box>
            }
          >
            {(item) => (
              <FocusCard
                sessionID={props.sessionID}
                item={item}
                snapshot={props.snapshot}
              />
            )}
          </Show>
        </box>
      )
    }

    function FocusCard(props: {
      sessionID: string
      item: Accessor<QueueItem>
      snapshot: Accessor<SessionSnapshot>
    }) {
      const isOpen = (): boolean => props.item().status === "open"
      const itemKey = (): string => `${props.sessionID}:${props.item().id}`
      const thread = (): ChatMessage[] => threadFor(props.snapshot().chat, props.item().id)
      const pendingClose = (): PendingClose | undefined => {
        const closing = props.snapshot().pendingClose
        return closing?.itemID === props.item().id ? closing : undefined
      }
      const urgencyColor = (urgency: ItemUrgency) =>
        urgency === "blocking"
          ? theme.text.feedback.error.base
          : urgency === "normal"
            ? theme.text.feedback.warning.base
            : theme.text.muted
      const kindLabel = (kind: ItemKind): string => kind.toUpperCase()

      return (
        <box flexDirection="column" flexGrow={1} gap={1}>
          <scrollbox flexGrow={1} stickyScroll={false} paddingRight={1}>
            <box flexDirection="column" gap={1}>
              <box
                flexDirection="column"
                gap={1}
                padding={1}
                backgroundColor={theme.background.raised.high}
                border
                borderColor={theme.border.base}
              >
                <text fg={theme.text.feedback.info.base}>DECIDE</text>
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  <text fg={urgencyColor(props.item().urgency)}>{props.item().urgency.toUpperCase()}</text>
                  <text fg={theme.text.muted}>{kindLabel(props.item().kind)}</text>
                  <Show when={props.item().autoCaptured === true}>
                    <text fg={theme.text.feedback.info.base}>[auto]</text>
                  </Show>
                  <Show when={props.item().originAgent}>
                    <text fg={theme.text.feedback.info.base}>[subagent: {props.item().originAgent}]</text>
                  </Show>
                </box>
                <text fg={theme.text.base}>
                  <strong>{props.item().title}</strong>
                </text>
                <text fg={theme.text.muted}>{props.item().plainSummary}</text>
                <Show when={props.item().impact}>
                  <text fg={theme.text.feedback.warning.base}>
                    <strong>Impact:</strong> {props.item().impact}
                  </text>
                </Show>
                <Show when={props.item().reversible === false}>
                  <text fg={theme.text.feedback.error.base}>
                    <strong>Irreversible</strong> · Review this action carefully.
                  </text>
                </Show>
                <Show when={props.item().defaultAction}>
                  <text fg={theme.text.muted}>
                    <strong>Default:</strong> {props.item().defaultAction}
                  </text>
                </Show>
                <Show when={props.item().status !== "open"}>
                  <text fg={theme.text.feedback.success.base}>
                    Closed · {props.item().answer ?? props.item().withdrawnReason ?? "No answer recorded"}
                  </text>
                </Show>
                <Show when={state.expandedDetails[itemKey()]}>
                  <text fg={theme.text.muted}>{props.item().details || "No additional details."}</text>
                </Show>
              </box>

              <Show when={isOpen()}>
                <box flexDirection="column" gap={1}>
                  <Show when={props.item().kind === "ack"}>
                    <>{button(
                      `[a] ${props.item().options[0] ?? "Acknowledge"} (silent)`,
                      () => void answerItem(props.sessionID, props.item().id, props.item().options[0] ?? "Acknowledge"),
                      theme.text.feedback.success.base,
                    )}</>
                  </Show>
                  <For each={props.item().options}>
                    {(option, index) => {
                      const optionIndex = () => index()
                      const skipDupAck = () =>
                        props.item().kind === "ack" && optionIndex() === 0 && option.trim().toLowerCase() === "acknowledge"
                      return (
                        <Show when={!skipDupAck()}>
                          {(() => {
                            const idx = optionIndex()
                            const recommended = props.item().recommended === idx
                            const risky = isRiskyOption(option)
                            return button(
                              `[${idx + 1}] ${recommended ? "★ " : ""}${risky ? "(!) " : ""}${option}`,
                              () => void answerItem(props.sessionID, props.item().id, option),
                              risky
                                ? theme.text.feedback.warning.base
                                : recommended
                                  ? theme.text.feedback.success.base
                                  : theme.text.base,
                            )
                          })()}
                        </Show>
                      )
                    }}
                  </For>
                  <Show when={props.item().allowCustom}>
                    <>{button(
                      props.item().kind === "ack" ? "[t] Override / Comment (wakes agent)" : "[t] Custom / Override",
                      () => void customAnswer(props.sessionID),
                      theme.text.feedback.info.base,
                    )}</>
                  </Show>
                </box>
              </Show>

              <Show when={pendingClose()}>
                {(closing) => (
                  <box
                    flexDirection="row"
                    flexWrap="wrap"
                    alignItems="center"
                    gap={1}
                    paddingX={1}
                    backgroundColor={theme.background.raised.high}
                  >
                    <text fg={theme.text.feedback.warning.base}>
                      Closing with: {closing().decision} · Sending in{" "}
                      {Math.max(0, Math.ceil((closing().dueAt - state.now) / 1000))}s
                    </text>
                    {button(
                      "[u] Undo",
                      () => undoClose(props.sessionID),
                      theme.text.feedback.info.base,
                    )}
                  </box>
                )}
              </Show>

              <box flexDirection="column" gap={1}>
                <text fg={theme.text.feedback.info.base}>DISCUSS</text>
                <Show when={thread().length === 0}>
                  <box flexDirection="row" flexWrap="wrap" gap={1}>
                    <For each={STARTER_PROMPTS}>
                      {(starter) => button(
                        starter,
                        () => void sendChat(
                          props.sessionID,
                          props.item().id,
                          starter,
                          starter === STARTER_PROMPTS[0],
                        ),
                        theme.text.feedback.info.base,
                        !isOpen(),
                      )}
                    </For>
                  </box>
                </Show>
                <scrollbox height={10} flexGrow={1} stickyScroll stickyStart="bottom">
                  <For each={thread()}>
                    {(message) => (
                      <ThreadEntry
                        sessionID={props.sessionID}
                        message={message}
                        snapshot={props.snapshot}
                      />
                    )}
                  </For>
                </scrollbox>
              </box>
            </box>
          </scrollbox>

          <Show when={isOpen()}>
            <ChatComposer
              sessionID={props.sessionID}
              item={props.item}
            />
          </Show>
        </box>
      )
    }

    function ThreadEntry(props: {
      sessionID: string
      message: ChatMessage
      snapshot: Accessor<SessionSnapshot>
    }) {
      if (props.message.kind === "you") {
        const msg = () => props.message as Extract<ChatMessage, { kind: "you" }>
        const status = (): string => {
          const m = msg()
          if (m.status === "queued") return "Queued"
          if (m.status === "thinking") {
            const elapsed = Math.max(0, Math.floor((state.now - (m.since ?? m.at)) / 1000))
            const activity = props.snapshot().liveActivity[m.id] ?? "working"
            return `Thinking · ${elapsed}s · ${activity}`
          }
          if (m.status === "failed") return `Failed: ${m.reason ?? "Unknown error"}`
          return "Answered"
        }
        const statusColor = () => {
          const m = msg()
          if (m.status === "failed") return theme.text.feedback.error.base
          if (m.status === "thinking") return theme.text.feedback.warning.base
          return theme.text.muted
        }
        return (
          <box flexDirection="column" gap={1} paddingX={1}>
            <box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
              <text fg={theme.text.base}>
                <strong>You</strong>
              </text>
              <text fg={statusColor()}>{status()}</text>
              <Show when={msg().status === "thinking"}>
                <>{button(
                  "[x] Cancel",
                  () => cancelMessage(props.sessionID, msg().itemID, msg().id),
                  theme.text.feedback.error.base,
                )}</>
              </Show>
              <Show when={msg().status === "failed"}>
                <>{button(
                  "[r] Retry",
                  () => retryMessage(props.sessionID, msg().id),
                  theme.text.feedback.info.base,
                )}</>
                <>{button(
                  "[x] Delete",
                  () => cancelMessage(props.sessionID, msg().itemID, msg().id),
                  theme.text.muted,
                )}</>
              </Show>
            </box>
            <text fg={theme.text.base}>{msg().text}</text>
          </box>
        )
      }

      if (props.message.kind === "assistant") {
        const key = `${props.sessionID}:${props.message.id}`
        const isLong = props.message.text.length > 800
        const expanded = (): boolean => state.expandedMessages[key] === true
        const checked = props.message.checked?.join(" · ")
        return (
          <box flexDirection="column" gap={1} paddingX={1} backgroundColor={theme.background.raised.high}>
            <text fg={theme.text.feedback.info.base}>
              <strong>Partner</strong>
              {props.message.model ? ` · ${props.message.model}` : ""}
              {finiteNumber(props.message.seconds) ? ` · ${props.message.seconds.toFixed(1)}s` : ""}
            </text>
            <Show when={checked}>
              <text fg={theme.text.muted}>
                <strong>Checked:</strong> {checked}
              </text>
            </Show>
            <text fg={theme.text.base}>
              {isLong && !expanded() ? `${props.message.text.slice(0, 800)}…` : props.message.text}
            </text>
            <Show when={isLong}>
              {button(
                expanded() ? "[less]" : "[more]",
                () => setState("expandedMessages", key, !expanded()),
                theme.text.feedback.info.base,
              )}
            </Show>
          </box>
        )
      }

      return (
        <box flexDirection="column" gap={1} paddingX={1} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.feedback.success.base}>
            <strong>Sent to session</strong> ·{" "}
            {props.message.silent
              ? "silent acknowledgment"
              : `${props.message.count} chat message${props.message.count === 1 ? "" : "s"}`}
          </text>
          <text fg={theme.text.muted}>{props.message.text}</text>
        </box>
      )
    }

    function ChatComposer(props: {
      sessionID: string
      item: Accessor<QueueItem>
    }) {
      let input: InputRenderable | undefined
      const onFocused = (): void => setState("inputFocused", props.sessionID, true)
      const onBlurred = (): void => setState("inputFocused", props.sessionID, false)

      createEffect(() => {
        if (state.inputFocused[props.sessionID] && input && !input.focused) input.focus()
      })

      onCleanup(() => {
        if (input) {
          input.off("focused", onFocused)
          input.off("blurred", onBlurred)
        }
        if (inputRefs.get(props.sessionID) === input) inputRefs.delete(props.sessionID)
        setState("inputFocused", props.sessionID, false)
      })

      const submit = (raw?: string): void => {
        const text = (raw ?? state.chatInput[props.sessionID] ?? "").trim()
        if (text) void sendChat(props.sessionID, props.item().id, text)
      }

      return (
        <box flexDirection="row" alignItems="center" gap={1}>
          <text fg={theme.text.muted}>[c] Discuss</text>
          <input
            ref={(element) => {
              input = element
              inputRefs.set(props.sessionID, element)
              element.on("focused", onFocused)
              element.on("blurred", onBlurred)
            }}
            flexGrow={1}
            value={state.chatInput[props.sessionID] ?? ""}
            placeholder="Ask a question…"
            textColor={theme.text.base}
            backgroundColor={theme.background.raised.high}
            placeholderColor={theme.text.faint}
            onInput={(value) => setState("chatInput", props.sessionID, value)}
            onSubmit={submit}
            onKeyDown={(event) => {
              if (event.name.toLowerCase() === "esc" || event.name.toLowerCase() === "escape") {
                event.preventDefault()
                input?.blur()
                setState("inputFocused", props.sessionID, false)
              }
            }}
          />
        </box>
      )
    }

    function InboxView(props: {
      sessionID: string
      snapshot: Accessor<SessionSnapshot>
    }) {
      const groups: ItemUrgency[] = ["blocking", "normal", "low"]
      const safeAckCount = (): number =>
        props.snapshot().open.filter((item) => item.kind === "ack" && item.reversible !== false).length

      const row = (item: QueueItem, closed = false) => {
        const messages = props.snapshot().chat.filter(
          (message) => message.itemID === item.id && message.kind !== "sent",
        )
        const replying = messages.some(
          (message) => message.kind === "you" && message.status === "thinking",
        )
        return (
          <text
            fg={theme.text.base}
            onMouseUp={() => {
              focusItem(props.sessionID, item.id)
              setState("viewMode", props.sessionID, "focus")
            }}
          >
            {closed ? "✓ " : ""}
            {item.kind.toUpperCase()} · {item.title}
            {item.snoozedAt !== undefined && !closed ? " [snoozed]" : ""}
            {closed ? ` · ${item.answer ?? "answered"}` : ""}
            {` · ${messages.length} chat${replying ? " · replying" : ""}`}
          </text>
        )
      }

      return (
        <scrollbox flexGrow={1} stickyScroll={false} paddingRight={1}>
          <box flexDirection="column" gap={1}>
            <For each={groups}>
              {(urgency) => {
                const items = (): QueueItem[] => props.snapshot().open.filter((item) => item.urgency === urgency)
                return (
                  <Show when={items().length > 0}>
                    <box flexDirection="column" gap={1}>
                      <text fg={
                        urgency === "blocking"
                          ? theme.text.feedback.error.base
                          : urgency === "normal"
                            ? theme.text.feedback.warning.base
                            : theme.text.muted
                      }>
                        {urgency.toUpperCase()}
                      </text>
                      <For each={items()}>{(item) => row(item)}</For>
                    </box>
                  </Show>
                )
              }}
            </For>

            <Show when={safeAckCount() > 0}>
              {button(
                `[A] Batch-Ack ${safeAckCount()} safe FYIs`,
                () => void batchAck(props.sessionID),
                theme.text.feedback.success.base,
              )}
            </Show>

            <box flexDirection="column" gap={1}>
              <text fg={theme.text.feedback.info.base}>Closed in this session</text>
              <Show
                when={props.snapshot().closed.length > 0}
                fallback={<text fg={theme.text.faint}>No closed items yet.</text>}
              >
                <For each={props.snapshot().closed}>{(item) => row(item, true)}</For>
              </Show>
            </box>

            <box flexDirection="column" gap={1}>
              <text fg={theme.text.feedback.info.base}>Other sessions needing attention</text>
              <Show
                when={props.snapshot().otherSessions.length > 0}
                fallback={<text fg={theme.text.faint}>No other sessions have open items.</text>}
              >
                <For each={props.snapshot().otherSessions}>
                  {(other) => (
                    <text
                      fg={theme.text.base}
                      onMouseUp={() => jumpToSession(other.sessionID)}
                    >
                      {other.title} · {other.openCount} open · {other.blockingCount} blocking
                    </text>
                  )}
                </For>
              </Show>
            </box>
          </box>
        </scrollbox>
      )
    }

    function SessionStatus(props: { sessionID: string; sidebar?: boolean }) {
      createEffect(() => {
        if (!state.snapshots[props.sessionID]) ensureSnapshot(props.sessionID)
      })
      const snapshot = (): SessionSnapshot | undefined => state.snapshots[props.sessionID]
      const localCount = (): number => snapshot()?.open.length ?? 0
      const otherCount = (): number =>
        snapshot()?.otherSessions.reduce((total, session) => total + session.openCount, 0) ?? 0
      const totalCount = (): number => localCount() + otherCount()
      const blockingCount = (): number =>
        (snapshot()?.open.filter((item) => item.urgency === "blocking").length ?? 0) +
        (snapshot()?.otherSessions.reduce((total, session) => total + session.blockingCount, 0) ?? 0)
      const localBlockingCount = (): number =>
        snapshot()?.open.filter((item) => item.urgency === "blocking").length ?? 0

      return (
        <Show when={props.sidebar ? localCount() > 0 : totalCount() > 0}>
          <Show
            when={snapshot()}
            fallback={null}
          >
            {(currentSnapshot) =>
              props.sidebar ? (
                <text
                  fg={localBlockingCount() > 0 ? theme.text.feedback.error.base : theme.text.feedback.warning.base}
                  onMouseUp={() => context.ui.panel.open(PANEL_NAME)}
                >
                  ● Attention · {localBlockingCount()} blocking · {currentSnapshot().open[0]?.title ?? "Open panel"}
                </text>
              ) : (
                <text
                  fg={blockingCount() > 0 ? theme.text.feedback.error.base : theme.text.feedback.warning.base}
                  onMouseUp={() => context.ui.panel.open(PANEL_NAME)}
                >
                  ● Attention: {totalCount()}
                  {otherCount() > 0 ? ` (${otherCount()} elsewhere)` : ""}
                </text>
              )
            }
          </Show>
        </Show>
      )
    }

    const unsubscribePluginUpdated = context.data.on("plugin.updated", () => {
      const sid = activePanelSessionID() ?? routedSessionID()
      if (sid && !state.snapshots[sid]) void refreshSnapshot(sid)
    })

    const unsubscribeChanged = rpc.events.on("changed", (event) => {
      const change = readChangedEvent(event.data)
      if (!change || disposed) return
      if (event.location) locationsBySession.set(change.sessionID, event.location)

      const routeSessionID = routedSessionID()
      const panel = context.ui.panel.current()
      const visibleSessionID = panel?.name === PANEL_NAME ? panel.sessionID : routeSessionID
      if (visibleSessionID) void refreshSnapshot(visibleSessionID)
      if (change.sessionID !== visibleSessionID && state.snapshots[change.sessionID]) {
        void refreshSnapshot(change.sessionID)
      }

      if (change.reason !== "posted") return
      const alreadyFocused =
        panel?.name === PANEL_NAME &&
        panel.sessionID === change.sessionID &&
        state.panelFocused[change.sessionID] === true
      if (!alreadyFocused) {
        context.ui.toast.show({
          title: "Attention",
          message: change.title ?? "A new item needs your attention.",
          variant: change.urgency === "blocking" ? "error" : "warning",
          sessionID: change.sessionID,
        })
      }

      if (context.options.notifyOnArrival !== false) {
        void context.attention
          .notify({
            title: "Attention",
            message: change.title ?? "A new item needs your attention.",
            notification: { when: "blurred" },
            sound: { name: "question", when: "blurred" },
          })
          .catch(() => undefined)
      }

      if (
        context.options.autoOpenPanel !== false &&
        routeSessionID === change.sessionID
      ) {
        const currentFocused = selectedOpenItem(change.sessionID)
        // Do not yank focus away from an item the user is already viewing unless a blocking item arrives over a non-blocking one
        if (change.itemID && (!currentFocused || (change.urgency === "blocking" && currentFocused.urgency !== "blocking"))) {
          focusItem(change.sessionID, change.itemID)
        }
        context.ui.panel.open(PANEL_NAME)
      }
    })

    slotCleanups.push(
      context.ui.slot({
        append: "session.panel",
        render: renderPanel,
      }),
      context.ui.slot({
        append: "prompt.footer.status",
        render: ({ sessionID }) =>
          sessionID ? <SessionStatus sessionID={sessionID} /> : null,
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => <SessionStatus sessionID={sessionID} sidebar />,
      }),
    )

    return () => {
      disposed = true
      unsubscribePluginUpdated()
      unsubscribeChanged()
      for (const cleanup of slotCleanups) cleanup()
      if (ticker !== undefined) clearInterval(ticker)
      ticker = undefined
      inFlightSnapshots.clear()
      inputRefs.clear()
      panelInputs.clear()
    }
  },
})
