/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand, PanelInput } from "@opencode/plugin/tui/context"
import type { InputRenderable, MouseEvent, RGBA, ScrollBoxRenderable } from "@opentui/core"
import { For, Show, createEffect, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
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
  inboxCursor: Record<string, number>
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

type InboxEntry =
  | { kind: "open"; item: QueueItem }
  | { kind: "closed"; item: QueueItem }
  | { kind: "other"; other: OtherSessionSummary }

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

const trimText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * Cross-realm check for whether an OpenTUI renderable is any editable text field
 * (main OpenCode composer Textarea, DISCUSS Input, dialog Input, command palette search).
 */
function isEditableRenderable(renderable: unknown): boolean {
  if (!renderable || typeof renderable !== "object") return false
  const r = renderable as Record<string, unknown>
  if (typeof r.insertText === "function" || r.editBuffer !== undefined || r.editorView !== undefined) {
    return true
  }
  const ctorName = (r.constructor as { name?: string } | undefined)?.name ?? ""
  return /input|textarea|edit/i.test(ctorName)
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
      inboxCursor: {},
      expandedDetails: {},
      expandedMessages: {},
      chatInput: {},
      inputFocused: {},
      panelFocused: {},
      now: Date.now(),
    })
    const [dialogOpen, setDialogOpen] = createSignal(false)

    // ponytail: Server holds durable queue & chat; this store holds only TUI view state.
    const requestVersions = new Map<string, number>()
    const inFlightSnapshots = new Map<string, Promise<void>>()
    const locationsBySession = new Map<string, { directory: string; workspaceID?: string }>()
    const inputRefs = new Map<string, InputRenderable>()
    const pendingInputFocus = new Set<string>()
    const scrollRefs = new Map<string, ScrollBoxRenderable>()
    const panelInputs = new Map<string, PanelInput>()
    const slotCleanups: Array<() => void> = []
    let pendingFocusOnOpen = false
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

    const rpcOpts = (sessionID: string) => ({
      location:
        context.data.session.get(sessionID)?.location ??
        locationsBySession.get(sessionID) ??
        context.location ??
        context.data.location.default(),
    })

    const blurChatInput = (sessionID: string): void => {
      pendingInputFocus.delete(sessionID)
      const input = inputRefs.get(sessionID)
      if (input?.focused) input.blur()
      if (state.inputFocused[sessionID]) setState("inputFocused", sessionID, false)
    }

    const focusPanel = (sessionID: string, keepInput = false): void => {
      const panel = panelInputs.get(sessionID)
      if (panel && !panel.focused) panel.focus()
      if (!keepInput) blurChatInput(sessionID)
    }

    const focusChatInput = (sessionID: string): void => {
      pendingInputFocus.add(sessionID)
      const panel = panelInputs.get(sessionID)
      if (panel && !panel.focused) panel.focus()
      const input = inputRefs.get(sessionID)
      if (input && !input.focused) input.focus()
      setState("inputFocused", sessionID, true)
      // Re-assert input focus once after microtask in case host panel.focus() moves focus to the panel wrapper
      queueMicrotask(() => {
        const stillWanted = pendingInputFocus.delete(sessionID)
        if (disposed || !stillWanted) return
        const latest = inputRefs.get(sessionID)
        if (latest && !latest.focused) latest.focus()
        if (!state.inputFocused[sessionID]) setState("inputFocused", sessionID, true)
      })
    }

    const scrollPanelTop = (sessionID: string): void => {
      scrollRefs.get(sessionID)?.scrollTo(0)
    }

    const scrollPanelBottom = (sessionID: string): void => {
      scrollRefs.get(sessionID)?.scrollTo(Infinity)
    }

    const scrollPanelBy = (sessionID: string, delta: number): void => {
      scrollRefs.get(sessionID)?.scrollBy(delta)
    }

    /**
     * Reusable hover-aware, drag-safe clickable control.
     * - Sets `selectable={false}` so clicking NEVER starts OpenTUI text selection.
     * - Requires left-button press AND release on the same control (prevents drag-select
     *   releases and right/middle-clicks from firing actions).
     * - Focuses the owning panel cleanly on left-press so keyboard shortcuts stay in sync.
     */
    function Clickable(props: {
      sessionID?: string
      disabled?: boolean
      bg?: RGBA
      hoverBg?: RGBA
      activeBg?: RGBA
      paddingX?: number
      width?: number | "auto" | `${number}%`
      border?: boolean
      borderColor?: RGBA
      onActivate: () => void
      children: JSX.Element
    }) {
      const [hovered, setHovered] = createSignal(false)
      const [pressed, setPressed] = createSignal(false)

      const bgColor = () => {
        if (props.disabled) return props.bg
        if (pressed()) return props.activeBg ?? props.hoverBg ?? theme.background.raised.max
        if (hovered()) return props.hoverBg ?? theme.background.raised.high
        return props.bg
      }

      return (
        <box
          flexDirection="row"
          alignItems="center"
          width={props.width}
          paddingX={props.paddingX ?? 1}
          backgroundColor={bgColor()}
          border={props.border}
          borderColor={props.borderColor}
          onMouseOver={() => {
            if (!props.disabled) setHovered(true)
          }}
          onMouseOut={() => {
            setHovered(false)
            setPressed(false)
          }}
          onMouseDown={(event: MouseEvent) => {
            if (props.disabled || event.button !== 0) return
            event.stopPropagation()
            // Clicking a panel button works with the mouse WITHOUT stealing keyboard focus
            // away from the main chat prompt; only blur our own DISCUSS input if it was active.
            if (props.sessionID && state.inputFocused[props.sessionID]) {
              blurChatInput(props.sessionID)
            }
            setPressed(true)
          }}
          onMouseUp={(event: MouseEvent) => {
            const wasPressed = pressed()
            setPressed(false)
            if (props.disabled || event.button !== 0 || !wasPressed) return
            event.stopPropagation()
            if (context.renderer.hasSelection) return
            props.onActivate()
          }}
        >
          {props.children}
        </box>
      )
    }

    const chipButton = (
      label: string,
      onActivate: () => void,
      opts: { sessionID?: string; color?: RGBA; disabled?: boolean; bold?: boolean; bg?: RGBA } = {},
    ) => (
      <Clickable
        sessionID={opts.sessionID}
        disabled={opts.disabled}
        bg={opts.bg}
        hoverBg={theme.background.raised.max}
        onActivate={onActivate}
      >
        <text selectable={false} fg={opts.disabled ? theme.text.faint : (opts.color ?? theme.text.feedback.info.base)}>
          {opts.bold ? <strong>{label}</strong> : label}
        </text>
      </Clickable>
    )

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
        const prevChatLen = state.snapshots[sessionID]?.chat.length ?? 0
        const focusedID = state.focusedItemID[sessionID] ?? ""
        setState("snapshots", sessionID, snapshot)
        const wasOpen = focusedID !== "" && prevOpen.some((item) => item.id === focusedID)
        const stillOpen = focusedID !== "" && snapshot.open.some((item) => item.id === focusedID)
        const stillClosed = focusedID !== "" && snapshot.closed.some((item) => item.id === focusedID)
        if (wasOpen && !stillOpen) {
          setState("focusedItemID", sessionID, successor(prevOpen, focusedID, snapshot.open))
          scrollPanelTop(sessionID)
        } else if (!focusedID || (!stillOpen && !stillClosed)) {
          setState("focusedItemID", sessionID, snapshot.open[0]?.id ?? "")
        } else if (snapshot.chat.length > prevChatLen && state.viewMode[sessionID] !== "inbox") {
          scrollPanelBottom(sessionID)
        }
        syncTicker()
      } catch (error) {
        if (!disposed && !state.snapshots[sessionID]) {
          const msg = errorMessage(error)
          if (msg.includes("rpc.unavailable") || msg.includes("RPC is unavailable")) {
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

    const routedSessionID = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const openPanel = (toggle = false, focus = true): void => {
      const panel = context.ui.panel.current()
      const sid = routedSessionID()
      if (toggle && panel?.name === PANEL_NAME) {
        // If panel is open but NOT focused, focus it first instead of closing unexpectedly!
        if (focus && state.panelFocused[panel.sessionID] !== true) {
          focusPanel(panel.sessionID)
          return
        }
        context.ui.panel.close()
        return
      }
      if (sid === undefined) {
        showToast("Open a session to view its attention queue.", "warning")
        return
      }
      pendingFocusOnOpen = focus
      context.ui.panel.open(PANEL_NAME)
      if (focus) focusPanel(sid)
    }

    const focusItem = (sessionID: string, itemID: string): void => {
      setState("focusedItemID", sessionID, itemID)
      scrollPanelTop(sessionID)
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

    const inboxEntriesFor = (snapshot: SessionSnapshot | undefined): InboxEntry[] => {
      if (!snapshot) return []
      const entries: InboxEntry[] = []
      for (const urgency of ["blocking", "normal", "low"] as const) {
        for (const item of snapshot.open) {
          if (item.urgency === urgency) entries.push({ kind: "open", item })
        }
      }
      for (const item of snapshot.closed) entries.push({ kind: "closed", item })
      for (const other of snapshot.otherSessions) entries.push({ kind: "other", other })
      return entries
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
      item: QueueItem,
      answer: string,
      typed = false,
    ): Promise<void> => {
      // Confirm destructive/irreversible choices so a stray click or keystroke cannot misfire
      if (!typed && (isRiskyOption(answer) || (item.reversible === false && item.kind === "approval"))) {
        setDialogOpen(true)
        try {
          const confirmed = await context.ui.dialog.confirm({
            title: "Confirm action",
            message: `${item.title}\n\nChoice: ${answer}${item.impact ? `\nImpact: ${item.impact}` : ""}`,
            label: { confirm: "Confirm", cancel: "Cancel" },
          })
          if (confirmed !== true) return
        } finally {
          setDialogOpen(false)
          focusPanel(sessionID)
        }
      }
      const result = await requestOk(sessionID, "Answer", () =>
        rpc.answer({ sessionID, itemID: item.id, answer, typed }, rpcOpts(sessionID)),
      )
      if (result?.silent === true) showToast("Acknowledged silently.", "success")
    }

    const answerOption = (sessionID: string, optionIndex: number): void => {
      const item = selectedOpenItem(sessionID)
      const option = item?.options[optionIndex]
      if (item && option !== undefined) void answerItem(sessionID, item, option)
    }

    const acknowledge = (sessionID: string): void => {
      const item = selectedOpenItem(sessionID)
      if (item?.kind === "ack") {
        void answerItem(sessionID, item, item.options[0] ?? "Acknowledge")
      }
    }

    const customAnswer = async (sessionID: string): Promise<void> => {
      const item = selectedOpenItem(sessionID)
      if (!item?.allowCustom) return
      setDialogOpen(true)
      try {
        const answer = await context.ui.dialog.prompt({
          title: item.kind === "ack" ? "Override / Comment (wakes agent)" : "Custom answer",
          description: item.title,
          placeholder: "Type your decision or comment",
        })
        if (answer?.trim()) void answerItem(sessionID, item, answer.trim(), true)
      } finally {
        setDialogOpen(false)
        focusPanel(sessionID)
      }
    }

    const snoozeItem = async (sessionID: string, itemID: string): Promise<void> => {
      const prevOpen = state.snapshots[sessionID]?.open ?? []
      const res = await requestOk(sessionID, "Snooze", () => rpc.snooze({ sessionID, itemID }, rpcOpts(sessionID)))
      if (res) {
        const nextOpen = state.snapshots[sessionID]?.open ?? []
        const remaining = nextOpen.filter((item) => item.id !== itemID)
        const nextID = remaining.length > 0 ? successor(prevOpen, itemID, remaining) : itemID
        focusItem(sessionID, nextID)
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
      const clean = text.trim()
      if (!clean) return
      const result = await requestOk(sessionID, "Send message", () =>
        rpc.sendChat({ sessionID, itemID, text: clean, ...(explainSimply ? { explainSimply: true } : {}) }, rpcOpts(sessionID)),
      )
      if (result) {
        setState("chatInput", sessionID, "")
        scrollPanelBottom(sessionID)
      }
    }

    const sendExplainSimply = (sessionID: string): void => {
      const item = selectedOpenItem(sessionID)
      if (!item) return
      const alreadyThinking = state.snapshots[sessionID]?.chat.some(
        (m) => m.kind === "you" && m.itemID === item.id && (m.status === "queued" || m.status === "thinking"),
      )
      if (alreadyThinking) return
      void sendChat(sessionID, item.id, STARTER_PROMPTS[0], true)
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
      blurChatInput(sessionID)
      const next: ViewMode = state.viewMode[sessionID] === "inbox" ? "focus" : "inbox"
      setState("viewMode", sessionID, next)
      if (next === "inbox") setState("inboxCursor", sessionID, 0)
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
      pendingFocusOnOpen = true
      context.ui.router.navigate({ type: "session", sessionID })
      context.ui.panel.open(PANEL_NAME)
    }

    // Global command only: /attention, /attn, command palette, <leader>d
    context.keymap.layer(() => ({
      mode: "global",
      bindings: ["attention.open"],
      commands: [
        {
          id: "attention.open",
          title: "Open Attention",
          description: "Open, focus, or close the Attention panel for this session.",
          group: "Attention",
          slash: { name: "attention", aliases: ["attn"] },
          palette: true,
          bind: "<leader>d",
          run: () => openPanel(true, true),
        },
      ],
    }))

    function AttentionPanel(props: { panel: PanelInput }) {
      const sessionID = (): string => props.panel.sessionID
      const snapshot = (): SessionSnapshot | undefined => state.snapshots[sessionID()]
      const isInbox = (): boolean => state.viewMode[sessionID()] === "inbox"
      const isInputFocused = (): boolean => state.inputFocused[sessionID()] === true

      createEffect(() => {
        const sid = sessionID()
        panelInputs.set(sid, props.panel)
        setState("panelFocused", sid, props.panel.focused)
        if (!state.snapshots[sid]) ensureSnapshot(sid)
        if (pendingFocusOnOpen) {
          pendingFocusOnOpen = false
          if (!props.panel.focused) props.panel.focus()
        }
        if (props.panel.focused && pendingInputFocus.has(sid)) {
          queueMicrotask(() => {
            if (disposed || !pendingInputFocus.delete(sid)) return
            const latest = inputRefs.get(sid)
            if (latest && !latest.focused) latest.focus()
          })
        }
        // When user clicks/tabs away from the panel, blur the chat input cleanly
        if (!props.panel.focused && !pendingInputFocus.has(sid)) blurChatInput(sid)
        onCleanup(() => {
          if (panelInputs.get(sid) === props.panel) panelInputs.delete(sid)
          setState("panelFocused", sid, false)
        })
      })

      const moveInboxCursor = (delta: number): void => {
        const entries = inboxEntriesFor(snapshot())
        if (entries.length === 0) return
        const sid = sessionID()
        const cur = state.inboxCursor[sid] ?? 0
        const next = (cur + delta + entries.length) % entries.length
        setState("inboxCursor", sid, next)
      }

      const activateInboxEntry = (entry: InboxEntry | undefined): void => {
        if (!entry) return
        const sid = sessionID()
        if (entry.kind === "other") {
          jumpToSession(entry.other.sessionID)
          return
        }
        focusItem(sid, entry.item.id)
        setState("viewMode", sid, "focus")
      }

      const handleEscape = (): void => {
        const sid = sessionID()
        if (isInputFocused()) {
          blurChatInput(sid)
          return
        }
        if (isInbox()) {
          setState("viewMode", sid, "focus")
          return
        }
        const cur = selectedItem(sid)
        if (cur && cur.status !== "open") {
          const firstOpen = snapshot()?.open[0]
          if (firstOpen) {
            focusItem(sid, firstOpen.id)
          } else {
            setState("focusedItemID", sid, "")
          }
          return
        }
        props.panel.close()
      }

      // Synchronous runtime guard checked on EVERY keypress inside `run()`:
      // Returning `false` hands the key straight back to OpenCode so typing in ANY text field
      // (main chat prompt, DISCUSS input, or dialog) can NEVER trigger a panel shortcut!
      const allowPanelKey = (event?: { ctrl?: boolean; meta?: boolean; option?: boolean }): boolean => {
        if (!props.panel.focused || isInputFocused() || dialogOpen()) return false
        if (event && (event.ctrl || event.meta || event.option)) return false
        if (isEditableRenderable(context.renderer.currentFocusedRenderable)) return false
        return true
      }

      const guardKey =
        (action: () => void | false): KeymapCommand["run"] =>
        (_input, event) => {
          if (!allowPanelKey(event)) return false
          return action()
        }

      // Panel-scoped keymap: NO `mode: "global"`, so dialogs & command palette never get hijacked!
      const buildCommands = (): KeymapCommand[] => {
        const cmds: KeymapCommand[] = [
          {
            id: "attention.escape",
            title: "Back / Close panel",
            group: "Attention",
            bind: "escape",
            run: guardKey(handleEscape),
          },
          {
            id: "attention.view",
            title: "Toggle Inbox / Focus",
            group: "Attention",
            bind: "i",
            run: guardKey(() => toggleView(sessionID())),
          },
          {
            id: "attention.fullscreen",
            title: "Toggle fullscreen",
            group: "Attention",
            bind: "f",
            run: guardKey(() => props.panel.toggleFullscreen()),
          },
          {
            id: "attention.down",
            title: "Scroll down / Next row",
            group: "Attention",
            bind: "j,down",
            run: guardKey(() => {
              if (isInbox()) moveInboxCursor(1)
              else scrollPanelBy(sessionID(), 3)
            }),
          },
          {
            id: "attention.up",
            title: "Scroll up / Previous row",
            group: "Attention",
            bind: "k,up",
            run: guardKey(() => {
              if (isInbox()) moveInboxCursor(-1)
              else scrollPanelBy(sessionID(), -3)
            }),
          },
          {
            id: "attention.page-down",
            title: "Page down",
            group: "Attention",
            bind: "pagedown",
            run: guardKey(() => scrollPanelBy(sessionID(), 10)),
          },
          {
            id: "attention.page-up",
            title: "Page up",
            group: "Attention",
            bind: "pageup",
            run: guardKey(() => scrollPanelBy(sessionID(), -10)),
          },
          {
            id: "attention.enter",
            title: "Select / Acknowledge",
            group: "Attention",
            bind: "return",
            run: guardKey(() => {
              const sid = sessionID()
              if (isInbox()) {
                const entries = inboxEntriesFor(snapshot())
                activateInboxEntry(entries[state.inboxCursor[sid] ?? 0])
                return
              }
              const item = selectedOpenItem(sid)
              if (item?.kind === "ack") acknowledge(sid)
              else return false
            }),
          },
          {
            id: "attention.previous",
            title: "Previous open item",
            group: "Attention",
            bind: "p,left",
            run: guardKey(() => {
              if (isInbox() || (snapshot()?.open.length ?? 0) === 0) return false
              moveFocus(sessionID(), -1)
            }),
          },
          {
            id: "attention.next",
            title: "Next open item",
            group: "Attention",
            bind: "n,right",
            run: guardKey(() => {
              if (isInbox() || (snapshot()?.open.length ?? 0) === 0) return false
              moveFocus(sessionID(), 1)
            }),
          },
          {
            id: "attention.ack",
            title: "Acknowledge (silent)",
            group: "Attention",
            bind: "a",
            run: guardKey(() => {
              const sid = sessionID()
              if (isInbox() || selectedOpenItem(sid)?.kind !== "ack") return false
              acknowledge(sid)
            }),
          },
          {
            id: "attention.custom",
            title: "Custom / Override",
            group: "Attention",
            bind: "t",
            run: guardKey(() => {
              const sid = sessionID()
              if (isInbox() || !selectedOpenItem(sid)?.allowCustom) return false
              void customAnswer(sid)
            }),
          },
          {
            id: "attention.explain",
            title: "Explain simply",
            group: "Attention",
            bind: "e",
            run: guardKey(() => {
              const sid = sessionID()
              if (isInbox() || !selectedOpenItem(sid)) return false
              sendExplainSimply(sid)
            }),
          },
          {
            id: "attention.snooze",
            title: "Snooze item",
            group: "Attention",
            bind: "s",
            run: guardKey(() => {
              if (isInbox()) return false
              const sid = sessionID()
              const item = selectedOpenItem(sid)
              if (!item) return false
              void snoozeItem(sid, item.id)
            }),
          },
          {
            id: "attention.details",
            title: "Toggle details",
            group: "Attention",
            bind: "d",
            run: guardKey(() => {
              if (isInbox()) return false
              const sid = sessionID()
              const item = selectedItem(sid)
              if (!item) return false
              toggleDetails(sid, item.id)
            }),
          },
          {
            id: "attention.chat",
            title: "Focus DISCUSS input",
            group: "Attention",
            bind: "c,tab",
            run: guardKey(() => {
              const sid = sessionID()
              if (isInbox() || !selectedOpenItem(sid)) return false
              focusChatInput(sid)
            }),
          },
          {
            id: "attention.undo",
            title: "Undo pending close",
            group: "Attention",
            bind: "u",
            run: guardKey(() => {
              if (!snapshot()?.pendingClose) return false
              undoClose(sessionID())
            }),
          },
          {
            id: "attention.batch-ack",
            title: "Batch-ack safe FYIs",
            group: "Attention",
            bind: "shift+a",
            run: guardKey(() => {
              const hasSafeAck = (snapshot()?.open ?? []).some((i) => i.kind === "ack" && i.reversible !== false)
              if (!hasSafeAck) return false
              void batchAck(sessionID())
            }),
          },
          {
            id: "attention.retry-chat",
            title: "Retry failed reply",
            group: "Attention",
            bind: "r",
            run: guardKey(() => retryLatestFailed(sessionID())),
          },
          {
            id: "attention.cancel-chat",
            title: "Cancel running reply",
            group: "Attention",
            bind: "x",
            run: guardKey(() => cancelLatestReply(sessionID())),
          },
        ]
        for (let option = 1; option <= 9; option += 1) {
          const index = option - 1
          cmds.push({
            id: `attention.option.${option}`,
            title: `Choose option ${option}`,
            group: "Attention",
            bind: String(option),
            run: guardKey(() => {
              const sid = sessionID()
              if (isInbox() || !selectedOpenItem(sid)?.options[index]) return false
              answerOption(sid, index)
            }),
          })
        }
        return cmds
      }

      const panelCmds = buildCommands()
      context.keymap.layer(() => ({
        enabled: () => props.panel.focused && !isInputFocused() && !dialogOpen(),
        bindings: panelCmds.map((c) => c.id).filter((id): id is string => id !== undefined),
        commands: panelCmds,
      }))

      // Dedicated high-priority layer while typing in DISCUSS input so Esc/Tab exit cleanly
      // without leaking Escape to OpenCode's session.interrupt!
      const inputExitCmds: KeymapCommand[] = [
        {
          id: "attention.input.blur",
          title: "Exit DISCUSS input",
          group: "Attention",
          bind: "escape,tab",
          run: () => blurChatInput(sessionID()),
        },
      ]
      context.keymap.layer(() => ({
        priority: 50,
        enabled: () => props.panel.focused && isInputFocused() && !dialogOpen(),
        bindings: ["attention.input.blur"],
        commands: inputExitCmds,
      }))

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
          total += context.data.session.permission.list(sid)?.length ?? 0
          total += context.data.session.form.list(sid)?.length ?? 0
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
          borderColor={props.panel.focused ? theme.text.feedback.info.base : theme.border.base}
          onMouseDown={(event: MouseEvent) => {
            // Do NOT steal keyboard focus away from the main chat prompt when the user clicks/selects in the panel;
            // only blur our own DISCUSS input if it was active.
            if (event.button === 0 && state.inputFocused[sessionID()]) {
              blurChatInput(sessionID())
            }
          }}
        >
          {/* Fixed Header Row */}
          <box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
            <box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
              {chipButton("ATTENTION", () => focusPanel(sessionID()), {
                color: props.panel.focused ? theme.text.feedback.info.base : theme.text.base,
                bold: true,
              })}
              <Show when={props.panel.focused && !isInputFocused()}>
                <text selectable={false} fg={theme.text.feedback.info.base}>
                  <strong>[KEYS]</strong>
                </text>
              </Show>
              <text selectable={false} fg={theme.text.muted}>
                {openCount()} open
                {otherCount() > 0 ? ` · +${otherCount()} other` : ""}
                {nativeAttentionCount() > 0 ? ` · ${nativeAttentionCount()} native` : ""}
              </text>
              <Show when={blockingCount() > 0}>
                <text selectable={false} fg={theme.text.feedback.error.base}>
                  <strong>· {blockingCount()} blocking</strong>
                </text>
              </Show>
            </box>
            <box flexDirection="row" alignItems="center" gap={1}>
              {chipButton(
                isInbox() ? "[i] Focus" : "[i] Inbox",
                () => toggleView(sessionID()),
                { sessionID: sessionID(), color: theme.text.feedback.info.base },
              )}
              {chipButton("[f]", props.panel.toggleFullscreen, { sessionID: sessionID(), color: theme.text.muted })}
              {chipButton("[×]", props.panel.close, { sessionID: sessionID(), color: theme.text.muted })}
            </box>
          </box>

          {/* Other Sessions Banner (clickable jump chips) */}
          <Show when={(snapshot()?.otherSessions.length ?? 0) > 0 && !isInbox()}>
            <box
              flexDirection="row"
              flexWrap="wrap"
              alignItems="center"
              gap={1}
              paddingX={1}
              backgroundColor={theme.background.raised.high}
            >
              <text selectable={false} fg={theme.text.feedback.warning.base}>Elsewhere:</text>
              <For each={snapshot()?.otherSessions ?? []}>
                {(other) =>
                  chipButton(
                    `${trimText(other.title, 22)} (${other.openCount})`,
                    () => jumpToSession(other.sessionID),
                    { sessionID: sessionID(), color: theme.text.feedback.info.base },
                  )
                }
              </For>
            </box>
          </Show>

          <Show
            when={snapshot()}
            fallback={<text selectable={false} fg={theme.text.muted}>Loading Attention…</text>}
          >
            {(currentSnapshot) => (
              <Show
                when={isInbox()}
                fallback={<FocusView sessionID={sessionID()} snapshot={currentSnapshot} />}
              >
                <InboxView
                  sessionID={sessionID()}
                  snapshot={currentSnapshot}
                  onActivate={activateInboxEntry}
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
        if (index >= 0) return `${index + 1}/${props.snapshot().open.length}`
        return activeItem() ? "Closed" : ""
      }

      return (
        <box flexDirection="column" flexGrow={1} gap={1}>
          {/* Only show item action bar when an item is actually displayed */}
          <Show when={activeItem()}>
            {(item) => (
              <box flexDirection="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
                <box flexDirection="row" alignItems="center" gap={1}>
                  <Show when={props.snapshot().open.length > 1}>
                    {chipButton("◂ [p]", () => moveFocus(props.sessionID, -1), {
                      sessionID: props.sessionID,
                      color: theme.text.muted,
                    })}
                  </Show>
                  <text selectable={false} fg={theme.text.base}>
                    <strong>{positionLabel()}</strong>
                  </text>
                  <Show when={props.snapshot().open.length > 1}>
                    {chipButton("[n] ▸", () => moveFocus(props.sessionID, 1), {
                      sessionID: props.sessionID,
                      color: theme.text.muted,
                    })}
                  </Show>
                  <Show when={item().status !== "open"}>
                    {chipButton("← Back", () => {
                      const firstOpen = props.snapshot().open[0]
                      setState("focusedItemID", props.sessionID, firstOpen?.id ?? "")
                    }, { sessionID: props.sessionID, color: theme.text.feedback.info.base })}
                  </Show>
                </box>

                <box flexDirection="row" alignItems="center" flexWrap="wrap" gap={1}>
                  <Show when={item().status === "open"}>
                    {chipButton("[e] Explain", () => sendExplainSimply(props.sessionID), {
                      sessionID: props.sessionID,
                      color: theme.text.feedback.info.base,
                    })}
                    {chipButton("[s] Snooze", () => void snoozeItem(props.sessionID, item().id), {
                      sessionID: props.sessionID,
                      color: theme.text.feedback.warning.base,
                    })}
                  </Show>
                  <Show when={item().details !== ""}>
                    {chipButton(
                      state.expandedDetails[`${props.sessionID}:${item().id}`] ? "[d] Hide" : "[d] Details",
                      () => toggleDetails(props.sessionID, item().id),
                      { sessionID: props.sessionID, color: theme.text.muted },
                    )}
                  </Show>
                  <Show when={item().autoCaptured === true && item().status === "open"}>
                    {chipButton("[Dismiss]", () => dismissItem(props.sessionID, item().id), {
                      sessionID: props.sessionID,
                      color: theme.text.feedback.error.base,
                    })}
                  </Show>
                </box>
              </box>
            )}
          </Show>

          <Show
            when={activeItem()}
            fallback={
              <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
                <text selectable={false} fg={theme.text.feedback.success.base}>
                  <strong>You're all caught up</strong>
                </text>
                <text selectable={false} fg={theme.text.muted}>
                  No open items waiting on you in this session.
                </text>
                <Show when={props.snapshot().closed.length > 0}>
                  {chipButton(
                    `[i] View ${props.snapshot().closed.length} closed item(s)`,
                    () => setState("viewMode", props.sessionID, "inbox"),
                    { sessionID: props.sessionID, color: theme.text.feedback.info.base },
                  )}
                </Show>
                <Show when={props.snapshot().otherSessions.length > 0}>
                  <box flexDirection="column" alignItems="center" gap={1} marginTop={1}>
                    <text selectable={false} fg={theme.text.feedback.warning.base}>
                      Other sessions waiting:
                    </text>
                    <For each={props.snapshot().otherSessions}>
                      {(other) =>
                        chipButton(
                          `→ ${other.title} (${other.openCount} open${other.blockingCount > 0 ? `, ${other.blockingCount} blocking` : ""})`,
                          () => jumpToSession(other.sessionID),
                          { sessionID: props.sessionID, color: theme.text.feedback.info.base },
                        )
                      }
                    </For>
                  </box>
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
          {/* Single unified vertical scrollbox: smooth mouse wheel & j/k scrolling with zero nested scroll traps */}
          <scrollbox
            ref={(el) => {
              scrollRefs.set(props.sessionID, el)
              onCleanup(() => {
                if (scrollRefs.get(props.sessionID) === el) scrollRefs.delete(props.sessionID)
              })
            }}
            flexGrow={1}
            scrollY
            scrollX={false}
            stickyScroll={false}
            paddingRight={1}
          >
            <box flexDirection="column" gap={1}>
              {/* DECIDE CARD */}
              <box
                flexDirection="column"
                gap={1}
                padding={1}
                backgroundColor={theme.background.raised.high}
                border
                borderColor={
                  props.item().urgency === "blocking"
                    ? theme.text.feedback.error.base
                    : theme.border.base
                }
              >
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  <text selectable={false} fg={urgencyColor(props.item().urgency)}>
                    <strong>{props.item().urgency.toUpperCase()}</strong>
                  </text>
                  <text selectable={false} fg={theme.text.muted}>
                    · {kindLabel(props.item().kind)}
                  </text>
                  <Show when={props.item().snoozedAt !== undefined && isOpen()}>
                    <text selectable={false} fg={theme.text.feedback.warning.base}>[snoozed]</text>
                  </Show>
                  <Show when={props.item().autoCaptured === true}>
                    <text selectable={false} fg={theme.text.feedback.info.base}>[auto]</text>
                  </Show>
                  <Show when={props.item().originAgent}>
                    <text selectable={false} fg={theme.text.feedback.info.base}>
                      [subagent: {props.item().originAgent}]
                    </text>
                  </Show>
                </box>

                {/* Readable card text stays selectable so users can drag-copy freely */}
                <text fg={theme.text.base}>
                  <strong>{props.item().title}</strong>
                </text>
                <Show when={props.item().plainSummary !== ""}>
                  <text fg={theme.text.muted}>{props.item().plainSummary}</text>
                </Show>
                <Show when={props.item().impact}>
                  <text fg={theme.text.feedback.warning.base}>
                    <strong>Impact:</strong> {props.item().impact}
                  </text>
                </Show>
                <Show when={props.item().reversible === false}>
                  <text fg={theme.text.feedback.error.base}>
                    <strong>Irreversible</strong> · Confirm carefully before choosing.
                  </text>
                </Show>
                <Show when={props.item().defaultAction}>
                  <text fg={theme.text.muted}>
                    <strong>While waiting:</strong> {props.item().defaultAction}
                  </text>
                </Show>
                <Show when={!isOpen()}>
                  <text fg={theme.text.feedback.success.base}>
                    <strong>Closed:</strong> {props.item().answer ?? props.item().withdrawnReason ?? "No answer"}
                    {props.item().silentAck ? " (silent)" : ""}
                  </text>
                </Show>
                <Show when={state.expandedDetails[itemKey()]}>
                  <box flexDirection="column" paddingTop={1}>
                    <text fg={theme.text.muted}>{props.item().details || "No additional details."}</text>
                  </box>
                </Show>
              </box>

              {/* OPTIONS (full-width hoverable, drag-safe clickable rows) */}
              <Show when={isOpen()}>
                <box flexDirection="column" gap={0}>
                  <Show when={props.item().kind === "ack"}>
                    <Clickable
                      sessionID={props.sessionID}
                      width="100%"
                      bg={theme.background.raised.base}
                      hoverBg={theme.background.raised.max}
                      onActivate={() =>
                        void answerItem(props.sessionID, props.item(), props.item().options[0] ?? "Acknowledge")
                      }
                    >
                      <text selectable={false} fg={theme.text.feedback.success.base}>
                        <strong>[a]</strong> {props.item().options[0] ?? "Acknowledge"}{" "}
                        <span style={{ fg: theme.text.muted }}>(silent · press Enter or a)</span>
                      </text>
                    </Clickable>
                  </Show>
                  <For each={props.item().options}>
                    {(option, index) => {
                      const idx = () => index()
                      const skipDupAck = () =>
                        props.item().kind === "ack" &&
                        idx() === 0 &&
                        option.trim().toLowerCase() === "acknowledge"
                      return (
                        <Show when={!skipDupAck()}>
                          {(() => {
                            const optionIdx = idx()
                            const recommended = props.item().recommended === optionIdx
                            const risky = isRiskyOption(option)
                            const color = risky
                              ? theme.text.feedback.warning.base
                              : recommended
                                ? theme.text.feedback.success.base
                                : theme.text.base
                            return (
                              <Clickable
                                sessionID={props.sessionID}
                                width="100%"
                                bg={theme.background.raised.base}
                                hoverBg={theme.background.raised.max}
                                onActivate={() => void answerItem(props.sessionID, props.item(), option)}
                              >
                                <text selectable={false} fg={color}>
                                  <strong>[{optionIdx + 1}]</strong>{" "}
                                  {recommended ? "★ " : ""}
                                  {risky ? "(!) " : ""}
                                  {option}
                                </text>
                              </Clickable>
                            )
                          })()}
                        </Show>
                      )
                    }}
                  </For>
                  <Show when={props.item().allowCustom}>
                    <Clickable
                      sessionID={props.sessionID}
                      width="100%"
                      bg={theme.background.raised.base}
                      hoverBg={theme.background.raised.max}
                      onActivate={() => void customAnswer(props.sessionID)}
                    >
                      <text selectable={false} fg={theme.text.feedback.info.base}>
                        <strong>[t]</strong>{" "}
                        {props.item().kind === "ack"
                          ? "Override / Comment (wakes agent)"
                          : "Custom answer…"}
                      </text>
                    </Clickable>
                  </Show>
                </box>
              </Show>

              {/* 5-SECOND CLOSING COUNTDOWN BANNER */}
              <Show when={pendingClose()}>
                {(closing) => (
                  <box
                    flexDirection="row"
                    flexWrap="wrap"
                    alignItems="center"
                    justifyContent="space-between"
                    gap={1}
                    padding={1}
                    backgroundColor={theme.background.raised.high}
                    border
                    borderColor={theme.text.feedback.warning.base}
                  >
                    <text selectable={false} fg={theme.text.feedback.warning.base}>
                      <strong>Closing:</strong> {closing().decision} ·{" "}
                      {Math.max(0, Math.ceil((closing().dueAt - state.now) / 1000))}s
                    </text>
                    {chipButton("[u] Undo", () => undoClose(props.sessionID), {
                      sessionID: props.sessionID,
                      color: theme.text.feedback.info.base,
                      bold: true,
                    })}
                  </box>
                )}
              </Show>

              {/* DISCUSS THREAD (inline in same continuous scrollbox!) */}
              <box flexDirection="column" gap={1} paddingTop={1}>
                <box flexDirection="row" alignItems="center" justifyContent="space-between">
                  <text selectable={false} fg={theme.text.feedback.info.base}>
                    <strong>DISCUSS</strong>{" "}
                    <span style={{ fg: theme.text.faint }}>
                      · read-only partner · separate from main chat
                    </span>
                  </text>
                </box>
                <Show when={thread().length === 0 && isOpen()}>
                  <box flexDirection="row" flexWrap="wrap" gap={1}>
                    <For each={STARTER_PROMPTS}>
                      {(starter) =>
                        chipButton(
                          starter,
                          () =>
                            void sendChat(
                              props.sessionID,
                              props.item().id,
                              starter,
                              starter === STARTER_PROMPTS[0],
                            ),
                          {
                            sessionID: props.sessionID,
                            color: theme.text.feedback.info.base,
                            bg: theme.background.raised.high,
                          },
                        )
                      }
                    </For>
                  </box>
                </Show>
                <For each={thread()}>
                  {(message) => (
                    <ThreadEntry
                      sessionID={props.sessionID}
                      message={message}
                      snapshot={props.snapshot}
                    />
                  )}
                </For>
              </box>
            </box>
          </scrollbox>

          {/* Pinned Bottom Composer (click anywhere on bar to focus!) */}
          <Show when={isOpen()}>
            <ChatComposer sessionID={props.sessionID} item={props.item} />
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
          return theme.text.faint
        }
        return (
          <box flexDirection="column" gap={0} paddingX={1}>
            <box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
              <text selectable={false} fg={theme.text.feedback.success.base}>
                <strong>You</strong>
              </text>
              <text selectable={false} fg={statusColor()}>{status()}</text>
              <Show when={msg().status === "thinking"}>
                {chipButton("[x] Cancel", () => cancelMessage(props.sessionID, msg().itemID, msg().id), {
                  sessionID: props.sessionID,
                  color: theme.text.feedback.error.base,
                })}
              </Show>
              <Show when={msg().status === "failed"}>
                {chipButton("[r] Retry", () => retryMessage(props.sessionID, msg().id), {
                  sessionID: props.sessionID,
                  color: theme.text.feedback.info.base,
                })}
                {chipButton("[x] Delete", () => cancelMessage(props.sessionID, msg().itemID, msg().id), {
                  sessionID: props.sessionID,
                  color: theme.text.muted,
                })}
              </Show>
            </box>
            <text fg={theme.text.base}>{msg().text}</text>
          </box>
        )
      }

      if (props.message.kind === "assistant") {
        const msg = props.message
        const key = `${props.sessionID}:${msg.id}`
        const isLong = msg.text.length > 800
        const expanded = (): boolean => state.expandedMessages[key] === true
        const checked = msg.checked?.join(" · ")
        return (
          <box flexDirection="column" gap={0} padding={1} backgroundColor={theme.background.raised.high}>
            <text selectable={false} fg={theme.text.feedback.info.base}>
              <strong>Partner</strong>
              {msg.model ? ` · ${msg.model}` : ""}
              {finiteNumber(msg.seconds) ? ` · ${msg.seconds.toFixed(1)}s` : ""}
            </text>
            <Show when={checked}>
              <text fg={theme.text.faint}>Checked: {checked}</text>
            </Show>
            <text fg={theme.text.base}>
              {isLong && !expanded() ? `${msg.text.slice(0, 800)}…` : msg.text}
            </text>
            <Show when={isLong}>
              {chipButton(
                expanded() ? "[less ▴]" : "[more ▾]",
                () => setState("expandedMessages", key, !expanded()),
                { sessionID: props.sessionID, color: theme.text.feedback.info.base },
              )}
            </Show>
          </box>
        )
      }

      return (
        <box flexDirection="column" gap={0} padding={1} backgroundColor={theme.background.raised.high}>
          <text selectable={false} fg={theme.text.feedback.success.base}>
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

      const focused = (): boolean => state.inputFocused[props.sessionID] === true
      const hasDraft = (): boolean => (state.chatInput[props.sessionID] ?? "").trim().length > 0

      return (
        <box
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingX={1}
          backgroundColor={theme.background.raised.high}
          border
          borderColor={focused() ? theme.text.feedback.info.base : theme.border.base}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== 0) return
            // Clicking ANYWHERE on the composer focuses both panel and <input> immediately
            event.stopPropagation()
            focusChatInput(props.sessionID)
          }}
        >
          <text selectable={false} fg={focused() ? theme.text.feedback.info.base : theme.text.muted}>
            {focused() ? "▸" : "[c]"}
          </text>
          <input
            ref={(element) => {
              input = element
              inputRefs.set(props.sessionID, element)
              element.on("focused", onFocused)
              element.on("blurred", onBlurred)
            }}
            flexGrow={1}
            value={state.chatInput[props.sessionID] ?? ""}
            placeholder={focused() ? "Type question · Enter sends · Esc exits" : "Click or press c to discuss…"}
            textColor={theme.text.base}
            backgroundColor={theme.background.raised.high}
            placeholderColor={theme.text.faint}
            onInput={(value) => setState("chatInput", props.sessionID, value)}
            onSubmit={submit}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== 0) return
              event.stopPropagation()
              focusChatInput(props.sessionID)
            }}
            onKeyDown={(event) => {
              const name = event.name.toLowerCase()
              if (name === "esc" || name === "escape" || name === "tab") {
                event.preventDefault()
                blurChatInput(props.sessionID)
              }
            }}
          />
          {chipButton("[Send]", () => submit(), {
            sessionID: props.sessionID,
            color: theme.text.feedback.info.base,
            disabled: !hasDraft(),
          })}
        </box>
      )
    }

    function InboxView(props: {
      sessionID: string
      snapshot: Accessor<SessionSnapshot>
      onActivate: (entry: InboxEntry) => void
    }) {
      const groups: ItemUrgency[] = ["blocking", "normal", "low"]
      const entries = (): InboxEntry[] => inboxEntriesFor(props.snapshot())
      const cursor = (): number => Math.min(state.inboxCursor[props.sessionID] ?? 0, Math.max(0, entries().length - 1))
      const safeAckCount = (): number =>
        props.snapshot().open.filter((item) => item.kind === "ack" && item.reversible !== false).length

      const entryIndexOf = (match: (entry: InboxEntry) => boolean): number => entries().findIndex(match)

      const itemRow = (item: QueueItem, closed: boolean) => {
        const idx = () =>
          entryIndexOf((e) => e.kind === (closed ? "closed" : "open") && e.item.id === item.id)
        const selected = () => idx() === cursor()
        const messages = props.snapshot().chat.filter(
          (message) => message.itemID === item.id && message.kind !== "sent",
        )
        const replying = messages.some((message) => message.kind === "you" && message.status === "thinking")
        return (
          <Clickable
            sessionID={props.sessionID}
            width="100%"
            bg={selected() ? theme.background.raised.high : undefined}
            hoverBg={theme.background.raised.max}
            onActivate={() => {
              const pos = idx()
              if (pos >= 0) setState("inboxCursor", props.sessionID, pos)
              props.onActivate(closed ? { kind: "closed", item } : { kind: "open", item })
            }}
          >
            <text selectable={false} fg={selected() ? theme.text.feedback.info.base : theme.text.base}>
              {selected() ? "▸ " : "  "}
              {closed ? "✓ " : ""}
              {item.kind.toUpperCase()} · {item.title}
              {item.snoozedAt !== undefined && !closed ? " [snoozed]" : ""}
              {closed ? ` → ${trimText(item.answer ?? "answered", 32)}` : ""}
              {messages.length > 0 ? ` · ${messages.length} chat` : ""}
              {replying ? " · replying…" : ""}
            </text>
          </Clickable>
        )
      }

      return (
        <box flexDirection="column" flexGrow={1} gap={1}>
          <box flexDirection="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
            <text selectable={false} fg={theme.text.faint}>
              ↑/↓ or j/k select · Enter open · Esc back
            </text>
            <Show when={safeAckCount() > 0}>
              {chipButton(
                `[A] Batch-Ack ${safeAckCount()} safe FYIs`,
                () => void batchAck(props.sessionID),
                { sessionID: props.sessionID, color: theme.text.feedback.success.base, bold: true },
              )}
            </Show>
          </box>

          <scrollbox
            ref={(el) => {
              scrollRefs.set(props.sessionID, el)
              onCleanup(() => {
                if (scrollRefs.get(props.sessionID) === el) scrollRefs.delete(props.sessionID)
              })
            }}
            flexGrow={1}
            scrollY
            scrollX={false}
            stickyScroll={false}
            paddingRight={1}
          >
            <box flexDirection="column" gap={1}>
              <For each={groups}>
                {(urgency) => {
                  const items = (): QueueItem[] => props.snapshot().open.filter((item) => item.urgency === urgency)
                  return (
                    <Show when={items().length > 0}>
                      <box flexDirection="column" gap={0}>
                        <text
                          selectable={false}
                          fg={
                            urgency === "blocking"
                              ? theme.text.feedback.error.base
                              : urgency === "normal"
                                ? theme.text.feedback.warning.base
                                : theme.text.muted
                          }
                        >
                          <strong>{urgency.toUpperCase()}</strong>
                        </text>
                        <For each={items()}>{(item) => itemRow(item, false)}</For>
                      </box>
                    </Show>
                  )
                }}
              </For>

              <Show when={props.snapshot().open.length === 0}>
                <text selectable={false} fg={theme.text.feedback.success.base}>
                  No open items in this session.
                </text>
              </Show>

              <Show when={props.snapshot().closed.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text selectable={false} fg={theme.text.feedback.info.base}>
                    <strong>CLOSED IN THIS SESSION</strong>
                  </text>
                  <For each={props.snapshot().closed}>{(item) => itemRow(item, true)}</For>
                </box>
              </Show>

              <Show when={props.snapshot().otherSessions.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text selectable={false} fg={theme.text.feedback.warning.base}>
                    <strong>OTHER SESSIONS</strong>
                  </text>
                  <For each={props.snapshot().otherSessions}>
                    {(other) => {
                      const idx = () => entryIndexOf((e) => e.kind === "other" && e.other.sessionID === other.sessionID)
                      const selected = () => idx() === cursor()
                      return (
                        <Clickable
                          sessionID={props.sessionID}
                          width="100%"
                          bg={selected() ? theme.background.raised.high : undefined}
                          hoverBg={theme.background.raised.max}
                          onActivate={() => props.onActivate({ kind: "other", other })}
                        >
                          <text selectable={false} fg={selected() ? theme.text.feedback.info.base : theme.text.base}>
                            {selected() ? "▸ " : "  "}
                            {other.title} · {other.openCount} open
                            {other.blockingCount > 0 ? ` · ${other.blockingCount} blocking` : ""}
                          </text>
                        </Clickable>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </box>
          </scrollbox>
        </box>
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
          <Show when={snapshot()} fallback={null}>
            {(currentSnapshot) => (
              <Clickable
                paddingX={props.sidebar ? 1 : 0}
                hoverBg={theme.background.raised.high}
                onActivate={() => openPanel(false, false)}
              >
                {props.sidebar ? (
                  <text
                    selectable={false}
                    fg={localBlockingCount() > 0 ? theme.text.feedback.error.base : theme.text.feedback.warning.base}
                  >
                    ● Attention · {localBlockingCount() > 0 ? `${localBlockingCount()} blocking · ` : ""}
                    {trimText(currentSnapshot().open[0]?.title ?? "Open panel", 28)}
                  </text>
                ) : (
                  <text
                    selectable={false}
                    fg={blockingCount() > 0 ? theme.text.feedback.error.base : theme.text.feedback.warning.base}
                  >
                    ● Attention: {totalCount()}
                    {otherCount() > 0 ? ` (+${otherCount()} other)` : ""}
                  </text>
                )}
              </Clickable>
            )}
          </Show>
        </Show>
      )
    }

    const unsubscribePluginUpdated = context.data.on("plugin.updated", () => {
      const sid = routedSessionID()
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

      if (context.options.autoOpenPanel !== false && routeSessionID === change.sessionID) {
        const currentFocused = selectedOpenItem(change.sessionID)
        if (change.itemID && (!currentFocused || (change.urgency === "blocking" && currentFocused.urgency !== "blocking"))) {
          focusItem(change.sessionID, change.itemID)
        }
        // Passive arrival opens the panel WITHOUT stealing keyboard focus from main prompt
        pendingFocusOnOpen = false
        context.ui.panel.open(PANEL_NAME)
      }
    })

    slotCleanups.push(
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (panel.name === PANEL_NAME ? <AttentionPanel panel={panel} /> : null),
      }),
      context.ui.slot({
        append: "prompt.footer.status",
        render: ({ sessionID }) => (sessionID ? <SessionStatus sessionID={sessionID} /> : null),
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
      pendingInputFocus.clear()
      scrollRefs.clear()
      panelInputs.clear()
    }
  },
})
