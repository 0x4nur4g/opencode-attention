/// <reference types="vite/client" />
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  Style,
  type ComposerPillRow,
  type PanelProps,
  type PanelTab,
  type ServerRef,
} from "@opencode/plugin/gui"
import css from "./gui.css?inline"
import { EXPLAIN_SIMPLY_USER_TEXT, STARTER_PROMPTS, threadFor } from "./chat.js"
import { byPriority, focusIndex, isRiskyItem, isRiskyOption, successor } from "./queue.js"
import type {
  ChatMessage,
  ItemKind,
  ItemStatus,
  ItemUrgency,
  OtherSessionSummary,
  PendingClose,
  QueueItem,
  SessionSnapshot,
} from "./types.js"
import { AttentionRpc } from "./rpc.js"

type ViewMode = "focus" | "inbox"

interface GuiSessionState {
  serverID: string
  sessionID: string
  snapshot: SessionSnapshot | undefined
  loading: boolean
  error: string
  view: ViewMode
  focusID: string
  answerDraft: string
  chatDraft: string
  busy: boolean
}

interface SessionConnection {
  key: string
  serverID: string
  sessionID: string
  server: ServerRef
  version: number
  initialized: boolean
}

interface ServerFeed {
  client: object
  stop: () => void
  keys: Set<string>
}

interface PendingPanelOpen {
  focusItemID: string
  focusTab: boolean
}

const URGENCY_ORDER: readonly ItemUrgency[] = ["blocking", "normal", "low"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const isKind = (value: unknown): value is ItemKind =>
  value === "decision" || value === "approval" || value === "action" || value === "ack"

const isUrgency = (value: unknown): value is ItemUrgency =>
  value === "blocking" || value === "normal" || value === "low"

const isItemStatus = (value: unknown): value is ItemStatus =>
  value === "open" || value === "answered" || value === "withdrawn"

const isChatStatus = (value: unknown): value is Extract<ChatMessage, { kind: "you" }>["status"] =>
  value === "queued" || value === "thinking" || value === "answered" || value === "failed"

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") return undefined
    result.push(entry)
  }
  return result
}

function parseQueueItem(value: unknown): QueueItem | undefined {
  if (!isRecord(value)) return undefined
  const options = stringArray(value.options)
  if (
    typeof value.id !== "string" ||
    typeof value.sessionID !== "string" ||
    typeof value.rootSessionID !== "string" ||
    !isKind(value.kind) ||
    !isUrgency(value.urgency) ||
    typeof value.title !== "string" ||
    !isItemStatus(value.status) ||
    !isNumber(value.createdAt) ||
    !isNumber(value.updatedAt) ||
    typeof value.allowCustom !== "boolean" ||
    options === undefined
  ) {
    return undefined
  }

  const item: QueueItem = {
    id: value.id,
    sessionID: value.sessionID,
    rootSessionID: value.rootSessionID,
    kind: value.kind,
    urgency: value.urgency,
    title: value.title,
    plainSummary: typeof value.plainSummary === "string" ? value.plainSummary : "",
    details: typeof value.details === "string" ? value.details : "",
    options,
    allowCustom: value.allowCustom,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  if (typeof value.originAgent === "string") item.originAgent = value.originAgent
  if (typeof value.impact === "string") item.impact = value.impact
  if (typeof value.reversible === "boolean") item.reversible = value.reversible
  if (
    isNumber(value.recommended) &&
    Number.isInteger(value.recommended) &&
    value.recommended >= 0 &&
    value.recommended < options.length
  ) {
    item.recommended = value.recommended
  }
  if (typeof value.defaultAction === "string") item.defaultAction = value.defaultAction
  if (typeof value.autoCaptured === "boolean") item.autoCaptured = value.autoCaptured
  if (isNumber(value.snoozedAt)) item.snoozedAt = value.snoozedAt
  if (typeof value.answer === "string") item.answer = value.answer
  if (typeof value.answeredAt === "string") item.answeredAt = value.answeredAt
  if (typeof value.closedFromChat === "boolean") item.closedFromChat = value.closedFromChat
  if (typeof value.silentAck === "boolean") item.silentAck = value.silentAck
  if (typeof value.withdrawnReason === "string") item.withdrawnReason = value.withdrawnReason
  if (typeof value.withdrawnAt === "string") item.withdrawnAt = value.withdrawnAt
  return item
}

function parseChatMessage(value: unknown): ChatMessage | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.itemID !== "string" ||
    typeof value.text !== "string" ||
    !isNumber(value.at)
  ) {
    return undefined
  }

  if (value.kind === "you" && isChatStatus(value.status)) {
    return {
      id: value.id,
      kind: "you",
      itemID: value.itemID,
      text: value.text,
      at: value.at,
      status: value.status,
      ...(isNumber(value.since) ? { since: value.since } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.resent === "boolean" ? { resent: value.resent } : {}),
    }
  }

  if (value.kind === "assistant") {
    const checked = stringArray(value.checked)
    return {
      id: value.id,
      kind: "assistant",
      itemID: value.itemID,
      text: value.text,
      at: value.at,
      ...(typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(isNumber(value.seconds) ? { seconds: value.seconds } : {}),
      ...(checked ? { checked } : {}),
    }
  }

  if (
    value.kind === "sent" &&
    typeof value.title === "string" &&
    isNumber(value.count)
  ) {
    return {
      id: value.id,
      kind: "sent",
      itemID: value.itemID,
      title: value.title,
      text: value.text,
      at: value.at,
      count: value.count,
      ...(typeof value.silent === "boolean" ? { silent: value.silent } : {}),
      ...(typeof value.closedFromChat === "boolean" ? { closedFromChat: value.closedFromChat } : {}),
    }
  }

  return undefined
}

function parsePendingClose(value: unknown): PendingClose | undefined {
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    typeof value.itemID !== "string" ||
    typeof value.decision !== "string" ||
    typeof value.context !== "string" ||
    !isNumber(value.dueAt)
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

function parseOtherSession(value: unknown): OtherSessionSummary | undefined {
  if (
    !isRecord(value) ||
    typeof value.sessionID !== "string" ||
    typeof value.title !== "string" ||
    !isNumber(value.openCount) ||
    !isNumber(value.blockingCount)
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

function parseArray<T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const entry of value) {
    const parsed = parse(entry)
    if (parsed !== undefined) result.push(parsed)
  }
  return result
}

function parseSnapshot(value: unknown): SessionSnapshot | undefined {
  if (!isRecord(value) || typeof value.sessionID !== "string") return undefined
  const liveActivity: Record<string, string> = {}
  if (isRecord(value.liveActivity)) {
    for (const [id, activity] of Object.entries(value.liveActivity)) {
      if (typeof activity === "string") liveActivity[id] = activity
    }
  }
  const pendingClose =
    value.pendingClose === null ? null : (parsePendingClose(value.pendingClose) ?? null)
  return {
    sessionID: value.sessionID,
    open: parseArray(value.open, parseQueueItem),
    closed: parseArray(value.closed, parseQueueItem),
    chat: parseArray(value.chat, parseChatMessage),
    pendingClose,
    liveActivity,
    otherSessions: parseArray(value.otherSessions, parseOtherSession),
    now: isNumber(value.now) ? value.now : Date.now(),
  }
}

function parseChangedEvent(value: unknown):
  | {
      sessionID: string
      reason: string
      itemID?: string
      title?: string
      urgency?: ItemUrgency
      kind?: ItemKind
    }
  | undefined {
  if (!isRecord(value) || typeof value.sessionID !== "string" || typeof value.reason !== "string") {
    return undefined
  }
  return {
    sessionID: value.sessionID,
    reason: value.reason,
    ...(typeof value.itemID === "string" ? { itemID: value.itemID } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(isUrgency(value.urgency) ? { urgency: value.urgency } : {}),
    ...(isKind(value.kind) ? { kind: value.kind } : {}),
  }
}

function responseError(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" ? value.error : ""
}

function responseOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true
}

function errorMessage(error: unknown): string {
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

function sessionKey(serverID: string, sessionID: string): string {
  return `${serverID}\n${sessionID}`
}

export default Plugin.define({
  i18n: {
    en: {
      title: "Attention",
      openCommand: "Open Attention",
      commandDescription: "Open or close the Attention panel",
      focus: "Focus",
      inbox: "Inbox",
      "openCount.one": "{{count}} open item",
      "openCount.other": "{{count}} open items",
      "attention.one": "{{count}} item needs attention",
      "attention.other": "{{count}} items need attention",
      "blockingCount.one": "{{count}} blocking",
      "blockingCount.other": "{{count}} blocking",
      "sessionItems.one": "{{count}} item waiting",
      "sessionItems.other": "{{count}} items waiting",
      blocking: "Blocking",
      normal: "Normal",
      low: "Low",
      decision: "Decision",
      approval: "Approval",
      action: "Action",
      ack: "FYI",
      autoCaptured: "Auto-captured",
      subagent: "Subagent · {{name}}",
      snooze: "Snooze",
      explainSimply: "Explain simply",
      refresh: "Refresh",
      prev: "Prev",
      next: "Next",
      impact: "Impact",
      irreversible: "Irreversible — review the consequences before choosing.",
      defaultIfDeferred: "Default if deferred",
      details: "Details",
      options: "Choose an option",
      recommended: "Recommended",
      acknowledgeSilent: "Acknowledge (silent)",
      customOverride: "Custom override",
      customAnswer: "Custom answer",
      answerPlaceholder: "Type an answer or add context…",
      submit: "Submit",
      dismissCaptured: "Dismiss captured item",
      discuss: "DISCUSS",
      discussIntro: "Ask a read-only partner to explain or verify this item.",
      whatIfOne: "What happens if I pick 1?",
      isReversible: "Is this reversible?",
      checkCode: "Check the code for this",
      you: "You",
      partner: "Partner",
      queued: "Queued",
      thinking: "Thinking",
      answered: "Answered",
      failed: "Failed",
      withdrawn: "Withdrawn",
      cancel: "Cancel",
      retry: "Retry",
      checked: "Checked",
      sent: "Sent",
      sentCount: "{{count}} response(s) sent",
      silent: "Recorded silently",
      closedFromChat: "Closed from DISCUSS",
      askPlaceholder: "Ask about this item…",
      send: "Send",
      loading: "Loading your queue…",
      loadError: "Could not load this session.",
      retryLoad: "Try again",
      caughtUp: "You’re all caught up",
      caughtUpDescription: "New decisions and requests will appear here.",
      otherSessions: "Other sessions",
      otherSessionsWaiting: "Other sessions need attention",
      batchAck: "Batch-Ack safe FYIs ({{count}})",
      closedInSession: "Closed in this session",
      nothingClosed: "Nothing has been closed yet.",
      emptyInbox: "No open items in this session.",
      arrived: "New item needs attention",
      snoozed: "Item snoozed",
      dismissed: "Captured item dismissed",
      answeredToast: "Answer sent",
      answerFailed: "Could not send the answer",
      chatFailed: "Could not send the message",
      batchAckDone: "Acknowledged {{count}} FYI(s)",
      closeIn: "Closing in {{seconds}}s",
      undo: "Undo",
      openSession: "Open session",
      sessionNotAvailable: "Open a session to use Attention.",
      urgencyLabel: "Urgency",
      kindLabel: "Kind",
      noDetails: "No additional details.",
      noImpact: "No impact note was provided.",
      noDefault: "No default action was provided.",
      unknownError: "The request did not complete.",
    },
  },
  setup(ctx) {
    ctx.add(Style, css)

    const [sessionStates, setSessionStates] = createStore<Record<string, GuiSessionState>>({})
    const [clock, setClock] = createSignal(Date.now())
    const connections = new Map<string, SessionConnection>()
    const feeds = new Map<string, ServerFeed>()
    const pendingPanelOpens = new Map<string, PendingPanelOpen>()
    const seenArrivals = new Set<string>()
    const panelKey = `${ctx.id}:attention`

    // ponytail: Server snapshots persist queue data; this store holds only window-local presentation state.
    function emptyState(serverID: string, sessionID: string): GuiSessionState {
      return {
        serverID,
        sessionID,
        snapshot: undefined,
        loading: true,
        error: "",
        view: "focus",
        focusID: "",
        answerDraft: "",
        chatDraft: "",
        busy: false,
      }
    }

    function ensureConnection(server: ServerRef, sessionID: string): SessionConnection {
      const key = sessionKey(server.id, sessionID)
      let connection = connections.get(key)
      if (connection === undefined) {
        connection = {
          key,
          serverID: server.id,
          sessionID,
          server,
          version: 0,
          initialized: false,
        }
        connections.set(key, connection)
        setSessionStates(key, emptyState(server.id, sessionID))
      } else {
        connection.server = server
      }

      ensureFeed(server)
      feeds.get(server.id)?.keys.add(key)
      if (!connection.initialized) {
        connection.initialized = true
        void refresh(connection)
      }
      return connection
    }

    function ensureFeed(server: ServerRef): void {
      const client = server.client
      const current = feeds.get(server.id)
      if (current && current.client === client) return
      current?.stop()
      const keys = current?.keys ?? new Set<string>()
      try {
        const rpc = client.rpc(AttentionRpc)
        const stop = rpc.events.on("changed", (event) => handleChanged(server.id, event))
        feeds.set(server.id, { client, stop, keys })
        if (current) {
          for (const key of keys) {
            const connection = connections.get(key)
            if (connection?.initialized) void refresh(connection)
          }
        }
      } catch (error) {
        feeds.set(server.id, { client, stop: () => undefined, keys })
        ctx.toast.show({
          title: ctx.t("title"),
          description: errorMessage(error),
          variant: "error",
        })
      }
    }

    function locationFor(serverID: string, sessionID: string): { directory: string; workspaceID?: string } | undefined {
      const current = ctx.sessions.current()
      if (current && current.server.id === serverID && current.id === sessionID) {
        return current.location ?? { directory: current.directory }
      }
      const listed = ctx.sessions.list().find((s) => s.server.id === serverID && s.id === sessionID)
      return listed?.location
    }

    async function refresh(connection: SessionConnection): Promise<void> {
      const version = ++connection.version
      setSessionStates(connection.key, "loading", true)
      try {
        const loc = locationFor(connection.serverID, connection.sessionID)
        const raw = await connection.server.client.rpc(AttentionRpc).snapshot(
          { sessionID: connection.sessionID },
          loc ? { location: loc } : undefined,
        )
        if (version !== connection.version) return
        const snapshot = parseSnapshot(raw)
        if (snapshot === undefined) throw new Error("The server returned an invalid Attention snapshot.")
        const prevOpen = sessionStates[connection.key]?.snapshot?.open ?? []
        const currentFocus = sessionStates[connection.key]?.focusID ?? ""
        setSessionStates(connection.key, "snapshot", snapshot)
        setSessionStates(connection.key, "error", "")
        if (currentFocus && prevOpen.some((item) => item.id === currentFocus) && !snapshot.open.some((item) => item.id === currentFocus)) {
          setSessionStates(connection.key, "focusID", successor(prevOpen, currentFocus, snapshot.open))
        } else if (!snapshot.open.some((item) => item.id === currentFocus)) {
          setSessionStates(connection.key, "focusID", snapshot.open[0]?.id ?? "")
        }
        for (const other of snapshot.otherSessions) {
          if (other.openCount > 0 && other.sessionID !== snapshot.sessionID) {
            ensureConnection(connection.server, other.sessionID)
          }
        }
      } catch (error) {
        if (version === connection.version) {
          setSessionStates(connection.key, "error", errorMessage(error))
        }
      } finally {
        if (version === connection.version) setSessionStates(connection.key, "loading", false)
      }
    }

    function handleChanged(
      serverID: string,
      event: { id: string; data: unknown },
    ): void {
      const change = parseChangedEvent(event.data)
      if (change === undefined) return

      if (change.reason === "posted" && change.itemID !== undefined) {
        const arrivalKey = `${serverID}\n${change.sessionID}\n${change.itemID}`
        if (!seenArrivals.has(arrivalKey)) {
          seenArrivals.add(arrivalKey)
          const title = change.title ?? ctx.t("arrived")
          ctx.toast.show({
            title: ctx.t("arrived"),
            description: title,
            variant: change.urgency === "blocking" ? "error" : "default",
          })
          if (ctx.options.notifyOnArrival !== false) {
            void ctx.attention.notify({
              title,
              message: change.urgency ? ctx.t(change.urgency) : undefined,
              session: { server: serverID, id: change.sessionID },
              id: "attention:" + change.sessionID + ":" + change.itemID,
            })
          }
          if (ctx.options.autoOpenPanel !== false && change.urgency !== "low") {
            openPanelFor(serverID, change.sessionID, change.itemID)
          }
        }
      }

      const refreshAll =
        change.reason === "posted" ||
        change.reason === "answered" ||
        change.reason === "withdrawn" ||
        change.reason === "snoozed" ||
        change.reason === "updated"
      for (const key of feeds.get(serverID)?.keys ?? []) {
        const connection = connections.get(key)
        if (connection === undefined) continue
        const snapshotSessionID = sessionStates[key]?.snapshot?.sessionID
        if (refreshAll || connection.sessionID === change.sessionID || snapshotSessionID === change.sessionID) {
          void refresh(connection)
        }
      }
    }

    function openPanelFor(
      serverID: string,
      sessionID: string,
      focusItemID = "",
      focusTab = false,
    ): void {
      const key = sessionKey(serverID, sessionID)
      const target = ctx.sessions
        .list()
        .find((session) => session.server.id === serverID && session.id === sessionID)

      if (target !== undefined) {
        ensureConnection(target.server, target.id)
        if (focusItemID) setSessionStates(target.key, "focusID", focusItemID)
        if (focusTab) ctx.tabs.open({ server: serverID, id: sessionID }, { focus: true })
        ctx.layout.open(panelKey, target, { background: !focusTab })
        return
      }

      pendingPanelOpens.set(key, { focusItemID, focusTab })
      ctx.tabs.open({ server: serverID, id: sessionID }, { focus: focusTab })
    }

    function toggleCurrentPanel(): void {
      const session = ctx.sessions.current()
      if (session === undefined) {
        ctx.toast.show({ title: ctx.t("sessionNotAvailable") })
        return
      }
      ensureConnection(session.server, session.id)
      ctx.layout.toggle(panelKey, session)
    }

    const timer = setInterval(() => setClock(Date.now()), 500)
    onCleanup(() => {
      clearInterval(timer)
      for (const feed of feeds.values()) feed.stop()
      feeds.clear()
    })

    createEffect(() => {
      const openSessions = ctx.sessions.list()
      for (const session of openSessions) {
        ensureConnection(session.server, session.id)
        const pending = pendingPanelOpens.get(session.key)
        if (pending === undefined) continue
        pendingPanelOpens.delete(session.key)
        if (pending.focusItemID) setSessionStates(session.key, "focusID", pending.focusItemID)
        ctx.layout.open(panelKey, session, { background: !pending.focusTab })
      }
    })

    const panelTab: PanelTab = {
      id: "attention",
      title: ctx.t("title"),
      pinned: true,
      closable: false,
      fallback: false,
      label: (tabState) => {
        const openItems = () => sessionStates[tabState.session.key]?.snapshot?.open ?? []
        const count = () => openItems().length
        const blocking = () => openItems().some((item) => item.urgency === "blocking")
        return (
          <span class="ny-root ny-tab-label">
            <span>{ctx.t("title")}</span>
            <Show when={count() > 0}>
              <span
                class={`ny-tab-badge ${blocking() ? "ny-tab-badge--blocking" : "ny-tab-badge--normal"}`}
              >
                {count()}
              </span>
            </Show>
          </span>
        )
      },
    }

    function AttentionPanel(input: { panel: PanelProps }) {
      createEffect(() => {
        ensureConnection(input.panel.session.server, input.panel.session.id)
      })

      const key = () => input.panel.session.key
      const state = () => sessionStates[key()]
      const snapshot = () => state()?.snapshot
      const openItems = createMemo(() => [...(snapshot()?.open ?? [])].sort(byPriority))
      const index = () => focusIndex(openItems(), state()?.focusID ?? "")
      const currentItem = () => openItems()[index()]
      const others = () => snapshot()?.otherSessions.filter((other) => other.openCount > 0) ?? []
      const safeAckCount = () =>
        openItems().filter((item) => item.kind === "ack" && item.reversible !== false).length

      function focusItem(itemID: string): void {
        setSessionStates(key(), "focusID", itemID)
        setSessionStates(key(), "answerDraft", "")
      }

      function setView(view: ViewMode): void {
        setSessionStates(key(), "view", view)
      }

      const sessionOpts = (session: { location?: { directory: string; workspaceID?: string }; directory: string }) => ({
        location: session.location ?? { directory: session.directory },
      })

      async function submitAnswer(itemID: string, answer: string, typed: boolean): Promise<void> {
        const text = answer.trim()
        if (!text) return
        const session = input.panel.session
        const sessionStateKey = session.key
        setSessionStates(sessionStateKey, "busy", true)
        try {
          const result = await session.server.client.rpc(AttentionRpc).answer(
            {
              sessionID: session.id,
              itemID,
              answer: text,
              typed,
            },
            sessionOpts(session),
          )
          if (!responseOk(result)) {
            ctx.toast.show({
              title: ctx.t("answerFailed"),
              description: responseError(result) || ctx.t("unknownError"),
              variant: "error",
            })
            return
          }
          const wasSilent = isRecord(result) && result.silent === true
          ctx.toast.show({
            title: wasSilent ? ctx.t("silent") : ctx.t("answeredToast"),
            variant: "success",
          })
          setSessionStates(sessionStateKey, "answerDraft", "")
          const connection = ensureConnection(session.server, session.id)
          void refresh(connection)
        } catch (error) {
          ctx.toast.show({
            title: ctx.t("answerFailed"),
            description: errorMessage(error),
            variant: "error",
          })
        } finally {
          setSessionStates(sessionStateKey, "busy", false)
        }
      }

      async function snoozeItem(itemID: string): Promise<void> {
        const session = input.panel.session
        const prevOpen = openItems()
        try {
          const result = await session.server.client.rpc(AttentionRpc).snooze(
            {
              sessionID: session.id,
              itemID,
            },
            sessionOpts(session),
          )
          if (!responseOk(result)) {
            ctx.toast.show({ title: ctx.t("unknownError"), variant: "error" })
            return
          }
          ctx.toast.show({ title: ctx.t("snoozed"), variant: "success" })
          const remaining = prevOpen.filter((item) => item.id !== itemID)
          if (remaining.length > 0) {
            setSessionStates(session.key, "focusID", successor(prevOpen, itemID, remaining))
          }
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("unknownError"), description: errorMessage(error), variant: "error" })
        }
      }

      async function dismissItem(itemID: string): Promise<void> {
        const session = input.panel.session
        try {
          const result = await session.server.client.rpc(AttentionRpc).dismiss(
            {
              sessionID: session.id,
              itemID,
            },
            sessionOpts(session),
          )
          if (!responseOk(result)) {
            ctx.toast.show({ title: ctx.t("unknownError"), variant: "error" })
            return
          }
          ctx.toast.show({ title: ctx.t("dismissed"), variant: "success" })
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("unknownError"), description: errorMessage(error), variant: "error" })
        }
      }

      async function sendDiscuss(itemID: string, text: string, explainSimply = false): Promise<void> {
        const message = text.trim()
        if (!message) return
        const session = input.panel.session
        const sessionStateKey = session.key
        setSessionStates(sessionStateKey, "busy", true)
        try {
          const result = await session.server.client.rpc(AttentionRpc).sendChat(
            {
              sessionID: session.id,
              itemID,
              text: message,
              ...(explainSimply ? { explainSimply: true } : {}),
            },
            sessionOpts(session),
          )
          if (!responseOk(result)) {
            ctx.toast.show({
              title: ctx.t("chatFailed"),
              description: responseError(result) || ctx.t("unknownError"),
              variant: "error",
            })
            return
          }
          setSessionStates(sessionStateKey, "chatDraft", "")
          setSessionStates(sessionStateKey, "view", "focus")
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("chatFailed"), description: errorMessage(error), variant: "error" })
        } finally {
          setSessionStates(sessionStateKey, "busy", false)
        }
      }

      async function retryMessage(messageID: string): Promise<void> {
        const session = input.panel.session
        try {
          await session.server.client.rpc(AttentionRpc).retryChat(
            {
              sessionID: session.id,
              messageID,
            },
            sessionOpts(session),
          )
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("chatFailed"), description: errorMessage(error), variant: "error" })
        }
      }

      async function cancelMessage(itemID: string, messageID: string): Promise<void> {
        const session = input.panel.session
        try {
          await session.server.client.rpc(AttentionRpc).cancelChat(
            {
              sessionID: session.id,
              itemID,
              messageID,
            },
            sessionOpts(session),
          )
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("chatFailed"), description: errorMessage(error), variant: "error" })
        }
      }

      async function undoClosing(): Promise<void> {
        const session = input.panel.session
        try {
          const result = await session.server.client.rpc(AttentionRpc).undoClose(
            { sessionID: session.id },
            sessionOpts(session),
          )
          if (!responseOk(result)) {
            ctx.toast.show({ title: ctx.t("unknownError"), variant: "error" })
            return
          }
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("unknownError"), description: errorMessage(error), variant: "error" })
        }
      }

      async function batchAcknowledge(): Promise<void> {
        const session = input.panel.session
        try {
          const result = await session.server.client.rpc(AttentionRpc).batchAck(
            { sessionID: session.id },
            sessionOpts(session),
          )
          if (!isRecord(result)) throw new Error(ctx.t("unknownError"))
          const acked = isNumber(result.acked) ? result.acked : 0
          const errors = stringArray(result.errors) ?? []
          ctx.toast.show({
            title: ctx.t("batchAckDone", { count: acked }),
            ...(errors.length > 0
              ? { description: errors.join("\n"), variant: "error" }
              : { variant: "success" }),
          })
          void refresh(ensureConnection(session.server, session.id))
        } catch (error) {
          ctx.toast.show({ title: ctx.t("unknownError"), description: errorMessage(error), variant: "error" })
        }
      }

      function renderMessage(message: ChatMessage, item: QueueItem) {
        if (message.kind === "you") {
          const activity = () => sessionStates[key()]?.snapshot?.liveActivity[message.id]
          return (
            <article class="ny-message ny-message--you">
              <div class="ny-message-meta">
                <strong>{ctx.t("you")}</strong>
                <span class={`ny-outbox-status ny-outbox-status--${message.status}`}>
                  {ctx.t(message.status)}
                </span>
              </div>
              <p class="ny-message-text">{message.text}</p>
              <Show when={activity()}>
                <div class="ny-live-activity">
                  <ctx.ui.Loader size="small" />
                  <span>{activity()}</span>
                </div>
              </Show>
              <Show when={message.reason}>
                <p class="ny-message-error">{message.reason}</p>
              </Show>
              <div class="ny-message-actions">
                <Show when={message.status === "queued" || message.status === "thinking"}>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost-muted"
                    onClick={() => void cancelMessage(item.id, message.id)}
                  >
                    {ctx.t("cancel")}
                  </ctx.ui.Button>
                </Show>
                <Show when={message.status === "failed"}>
                  <ctx.ui.Button
                    size="small"
                    variant="neutral"
                    icon="outline-rotate-clockwise"
                    onClick={() => void retryMessage(message.id)}
                  >
                    {ctx.t("retry")}
                  </ctx.ui.Button>
                </Show>
              </div>
            </article>
          )
        }

        if (message.kind === "assistant") {
          const meta = [
            message.model,
            message.seconds === undefined ? undefined : `${message.seconds.toFixed(1)}s`,
          ].filter((value): value is string => value !== undefined)
          return (
            <article class="ny-message ny-message--assistant">
              <div class="ny-message-meta">
                <strong>{ctx.t("partner")}</strong>
                <Show when={meta.length > 0}>
                  <span>{meta.join(" · ")}</span>
                </Show>
              </div>
              <ctx.ui.Markdown text={message.text} class="ny-markdown" />
              <Show when={(message.checked?.length ?? 0) > 0}>
                <details class="ny-checked">
                  <summary>
                    {ctx.t("checked")} · {message.checked?.length ?? 0}
                  </summary>
                  <ul>
                    <For each={message.checked ?? []}>{(entry) => <li>{entry}</li>}</For>
                  </ul>
                </details>
              </Show>
            </article>
          )
        }

        return (
          <article class="ny-sent-card">
            <div class="ny-sent-heading">
              <ctx.ui.Icon name="check" size="small" />
              <strong>{ctx.t("sent")}</strong>
            </div>
            <strong class="ny-sent-title">{message.title}</strong>
            <p>{message.text}</p>
            <div class="ny-sent-meta">
              <span>{ctx.t("sentCount", { count: message.count })}</span>
              <Show when={message.silent}>
                <span>{ctx.t("silent")}</span>
              </Show>
              <Show when={message.closedFromChat}>
                <span>{ctx.t("closedFromChat")}</span>
              </Show>
            </div>
          </article>
        )
      }

      function focusView() {
        const item = currentItem()
        if (item === undefined) return null
        const currentIndex = index()
        const itemThread = () => threadFor(snapshot()?.chat ?? [], item.id)
        const isRisky = isRiskyItem(item)
        const answerCustom = (value: string) => void submitAnswer(item.id, value, true)

        return (
          <>
            <div class="ny-stepper">
              <ctx.ui.Button
                size="small"
                variant="ghost-muted"
                icon="arrow-left"
                disabled={currentIndex <= 0}
                onClick={() => focusItem(openItems()[Math.max(0, currentIndex - 1)]?.id ?? item.id)}
              >
                {ctx.t("prev")}
              </ctx.ui.Button>
              <span class="ny-step-count">
                {openItems().length === 0 ? 0 : currentIndex + 1} / {openItems().length}
              </span>
              <ctx.ui.Button
                size="small"
                variant="ghost-muted"
                icon="arrow-right"
                disabled={currentIndex < 0 || currentIndex >= openItems().length - 1}
                onClick={() => focusItem(openItems()[Math.min(openItems().length - 1, currentIndex + 1)]?.id ?? item.id)}
              >
                {ctx.t("next")}
              </ctx.ui.Button>
            </div>

            <div class="ny-item-card">
              <div class="ny-item-tags">
                <span class={`ny-tag ny-tag--${item.urgency}`}>{ctx.t(item.urgency)}</span>
                <span class="ny-tag ny-tag--kind">{ctx.t(item.kind)}</span>
                <Show when={item.autoCaptured}>
                  <span class="ny-tag ny-tag--auto">{ctx.t("autoCaptured")}</span>
                </Show>
                <Show when={item.originAgent}>
                  <span class="ny-tag ny-tag--agent">{ctx.t("subagent", { name: item.originAgent ?? "" })}</span>
                </Show>
              </div>

              <h2 class="ny-item-title">{item.title}</h2>
              <p class="ny-summary">{item.plainSummary || ctx.t("noDetails")}</p>

              <Show when={item.impact}>
                <div class="ny-impact">
                  <strong>{ctx.t("impact")}</strong>
                  <p>{item.impact}</p>
                </div>
              </Show>
              <Show when={item.reversible === false}>
                <div class="ny-irreversible">
                  <ctx.ui.Icon name="circle-exclamation" size="small" />
                  <span>{ctx.t("irreversible")}</span>
                </div>
              </Show>
              <Show when={item.defaultAction}>
                <div class="ny-default-action">
                  <strong>{ctx.t("defaultIfDeferred")}</strong>
                  <p>{item.defaultAction}</p>
                </div>
              </Show>
              <Show when={item.details}>
                <details class="ny-details">
                  <summary>{ctx.t("details")}</summary>
                  <ctx.ui.Markdown text={item.details || ""} class="ny-markdown" />
                </details>
              </Show>

              <div class="ny-answer-area">
                <Show when={item.kind === "ack"}>
                  <ctx.ui.Button
                    variant="contrast"
                    icon="check"
                    busy={state()?.busy ?? false}
                    onClick={() => void submitAnswer(item.id, item.options[0] ?? "Acknowledge", false)}
                  >
                    {ctx.t("acknowledgeSilent")}
                  </ctx.ui.Button>
                </Show>
                <Show when={item.options.length > 0 && (item.kind !== "ack" || item.options.length > 1)}>
                  <h3 class="ny-section-heading">{ctx.t("options")}</h3>
                  <div class="ny-option-list">
                    <For each={item.options.map((option, optionIndex) => ({ option, optionIndex }))}>
                      {(choice) => {
                        const risky = isRiskyOption(choice.option) || isRisky
                        const recommended = item.recommended === choice.optionIndex
                        return (
                          <ctx.ui.Button
                            class={`ny-option ny-option--${risky ? "risky" : "safe"} ${recommended ? "ny-option--recommended" : ""}`}
                            variant={risky ? "danger" : recommended ? "contrast" : "neutral"}
                            busy={state()?.busy ?? false}
                            onClick={() => void submitAnswer(item.id, choice.option, false)}
                          >
                            <span class="ny-option-number">{choice.optionIndex + 1}</span>
                            <span class="ny-option-label">
                              <Show when={risky}>
                                <strong class="ny-risk-mark">(!)</strong>
                              </Show>
                              <Show when={recommended}>
                                <strong class="ny-recommended-mark">★</strong>
                              </Show>
                              {choice.option}
                            </span>
                          </ctx.ui.Button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
                <Show when={item.allowCustom}>
                  <div class="ny-custom-answer">
                    <ctx.ui.TextInput
                      label={item.kind === "ack" ? ctx.t("customOverride") : ctx.t("customAnswer")}
                      placeholder={ctx.t("answerPlaceholder")}
                      value={state()?.answerDraft ?? ""}
                      onInput={(value) => setSessionStates(key(), "answerDraft", value)}
                      onSubmit={answerCustom}
                      disabled={state()?.busy ?? false}
                    />
                    <ctx.ui.Button
                      variant="neutral"
                      disabled={!state()?.answerDraft.trim() || (state()?.busy ?? false)}
                      busy={state()?.busy ?? false}
                      onClick={() => answerCustom(state()?.answerDraft ?? "")}
                    >
                      {ctx.t("submit")}
                    </ctx.ui.Button>
                  </div>
                </Show>
                <Show when={item.autoCaptured}>
                  <ctx.ui.Button
                    variant="ghost-muted"
                    icon="circle-x"
                    onClick={() => void dismissItem(item.id)}
                  >
                    {ctx.t("dismissCaptured")}
                  </ctx.ui.Button>
                </Show>
              </div>
            </div>

            <Show when={snapshot()?.pendingClose}>
              <div class="ny-closing-banner">
                <div>
                  <strong>
                    {ctx.t("closeIn", {
                      seconds: Math.max(
                        0,
                        Math.ceil(((snapshot()?.pendingClose?.dueAt ?? clock()) - clock()) / 1000),
                      ),
                    })}
                  </strong>
                  <span>{snapshot()?.pendingClose?.decision}</span>
                </div>
                <ctx.ui.Button size="small" variant="neutral" onClick={() => void undoClosing()}>
                  {ctx.t("undo")}
                </ctx.ui.Button>
              </div>
            </Show>

            <section class="ny-discuss">
              <div class="ny-discuss-heading">
                <div>
                  <h3 class="ny-section-heading">{ctx.t("discuss")}</h3>
                  <p>{ctx.t("discussIntro")}</p>
                </div>
                <ctx.ui.Icon name="comment" size="normal" />
              </div>
              <div class="ny-starters">
                <For each={STARTER_PROMPTS}>
                  {(prompt) => (
                    <ctx.ui.Button
                      size="small"
                      variant="ghost-muted"
                      class="ny-starter"
                      disabled={state()?.busy ?? false}
                      onClick={() => void sendDiscuss(item.id, prompt, prompt === "Explain simply")}
                    >
                      {prompt === "What happens if I pick 1?"
                        ? ctx.t("whatIfOne")
                        : prompt === "Is this reversible?"
                          ? ctx.t("isReversible")
                          : prompt === "Check the code for this"
                            ? ctx.t("checkCode")
                            : ctx.t("explainSimply")}
                    </ctx.ui.Button>
                  )}
                </For>
              </div>
              <div class="ny-chat-list">
                <For each={itemThread()}>{(message) => renderMessage(message, item)}</For>
              </div>
              <div class="ny-chat-composer">
                <ctx.ui.TextInput
                  label={ctx.t("askPlaceholder")}
                  placeholder={ctx.t("askPlaceholder")}
                  value={state()?.chatDraft ?? ""}
                  onInput={(value) => setSessionStates(key(), "chatDraft", value)}
                  onSubmit={(value) => void sendDiscuss(item.id, value)}
                  disabled={state()?.busy ?? false}
                />
                <ctx.ui.Button
                  variant="contrast"
                  icon="arrow-up"
                  disabled={!state()?.chatDraft.trim() || (state()?.busy ?? false)}
                  busy={state()?.busy ?? false}
                  onClick={() => void sendDiscuss(item.id, state()?.chatDraft ?? "")}
                >
                  {ctx.t("send")}
                </ctx.ui.Button>
              </div>
            </section>
          </>
        )
      }

      function inboxView() {
        const groups = () => URGENCY_ORDER.map((urgency) => ({
          urgency,
          items: openItems().filter((item) => item.urgency === urgency),
        }))
        const closedItems = () => snapshot()?.closed ?? []

        return (
          <div class="ny-inbox">
            <div class="ny-inbox-toolbar">
              <span>{ctx.plural("openCount", openItems().length)}</span>
              <ctx.ui.Button
                size="small"
                variant="neutral"
                icon="check"
                disabled={safeAckCount() === 0 || (state()?.busy ?? false)}
                busy={state()?.busy ?? false}
                onClick={() => void batchAcknowledge()}
              >
                {ctx.t("batchAck", { count: safeAckCount() })}
              </ctx.ui.Button>
            </div>

            <Show when={openItems().length > 0} fallback={<p class="ny-empty">{ctx.t("emptyInbox")}</p>}>
              <For each={groups()}>
                {(group) => (
                  <Show when={group.items.length > 0}>
                    <section class="ny-urgency-group">
                      <h3 class={`ny-group-heading ny-group-heading--${group.urgency}`}>
                        {ctx.t(group.urgency)}
                        <span>{group.items.length}</span>
                      </h3>
                      <div class="ny-inbox-cards">
                        <For each={group.items}>
                          {(item) => (
                            <ctx.ui.Button
                              variant="neutral"
                              class="ny-inbox-card"
                              onClick={() => {
                                setView("focus")
                                focusItem(item.id)
                              }}
                            >
                              <span class="ny-inbox-card-top">
                                <span class={`ny-tag ny-tag--${item.urgency}`}>{ctx.t(item.urgency)}</span>
                                <span class="ny-inbox-kind">{ctx.t(item.kind)}</span>
                              </span>
                              <strong>{item.title}</strong>
                              <span class="ny-inbox-summary">{item.plainSummary}</span>
                              <Show when={item.originAgent}>
                                <span class="ny-inbox-origin">{ctx.t("subagent", { name: item.originAgent ?? "" })}</span>
                              </Show>
                            </ctx.ui.Button>
                          )}
                        </For>
                      </div>
                    </section>
                  </Show>
                )}
              </For>
            </Show>

            <Show when={others().length > 0}>
              <section class="ny-other-sessions">
                <h3 class="ny-section-heading">{ctx.t("otherSessions")}</h3>
                <For each={others()}>
                  {(other) => (
                    <ctx.ui.Button
                      variant="neutral"
                      class="ny-other-session"
                      icon={other.blockingCount > 0 ? "circle-exclamation" : "arrow-up-right"}
                      onClick={() => openPanelFor(input.panel.session.server.id, other.sessionID, "", true)}
                    >
                      <span class="ny-other-session-copy">
                        <strong>{other.title}</strong>
                        <span>{ctx.plural("openCount", other.openCount)}</span>
                      </span>
                      <Show when={other.blockingCount > 0}>
                        <span class="ny-other-blocking">
                          {ctx.plural("blockingCount", other.blockingCount)}
                        </span>
                      </Show>
                    </ctx.ui.Button>
                  )}
                </For>
              </section>
            </Show>

            <details class="ny-closed-viewer">
              <summary>{ctx.t("closedInSession")}</summary>
              <Show when={closedItems().length > 0} fallback={<p class="ny-empty">{ctx.t("nothingClosed")}</p>}>
                <div class="ny-closed-list">
                  <For each={closedItems()}>
                    {(item) => (
                      <article class="ny-closed-item">
                        <strong>{item.title}</strong>
                        <span class={`ny-closed-status ny-closed-status--${item.status}`}>
                          {ctx.t(item.status)}
                        </span>
                        <p>{item.answer || item.withdrawnReason || item.plainSummary}</p>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </details>
          </div>
        )
      }

      return (
        <div class="ny-root ny-panel">
          <header class="ny-header">
            <div class="ny-header-top">
              <div class="ny-brand">
                <span class="ny-brand-mark">
                  <ctx.ui.Icon name="circle-exclamation" size="normal" />
                </span>
                <div class="ny-brand-copy">
                  <h1>{ctx.t("title")}</h1>
                  <span>{ctx.plural("openCount", openItems().length)}</span>
                </div>
              </div>
              <div class="ny-header-tools">
                <div class="ny-view-switch">
                  <ctx.ui.Button
                    size="small"
                    variant={state()?.view === "focus" ? "contrast" : "ghost-muted"}
                    onClick={() => setView("focus")}
                  >
                    {ctx.t("focus")}
                  </ctx.ui.Button>
                  <ctx.ui.Button
                    size="small"
                    variant={state()?.view === "inbox" ? "contrast" : "ghost-muted"}
                    onClick={() => setView("inbox")}
                  >
                    {ctx.t("inbox")}
                  </ctx.ui.Button>
                </div>
                <ctx.ui.Tooltip value={ctx.t("refresh")}>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost-muted"
                    icon="outline-rotate-clockwise"
                    busy={state()?.loading ?? false}
                    onClick={() => void refresh(ensureConnection(
                      input.panel.session.server,
                      input.panel.session.id,
                    ))}
                  >
                    {ctx.t("refresh")}
                  </ctx.ui.Button>
                </ctx.ui.Tooltip>
              </div>
            </div>

            <div class="ny-header-actions">
              <ctx.ui.Button
                size="small"
                variant="ghost-muted"
                icon="archive"
                disabled={!currentItem() || (state()?.busy ?? false)}
                onClick={() => {
                  const item = currentItem()
                  if (item) void snoozeItem(item.id)
                }}
              >
                {ctx.t("snooze")}
              </ctx.ui.Button>
              <ctx.ui.Button
                size="small"
                variant="ghost-muted"
                icon="brain"
                disabled={!currentItem() || (state()?.busy ?? false)}
                onClick={() => {
                  const item = currentItem()
                  if (item) void sendDiscuss(item.id, EXPLAIN_SIMPLY_USER_TEXT, true)
                }}
              >
                {ctx.t("explainSimply")}
              </ctx.ui.Button>
            </div>

            <Show when={others().length > 0}>
              <div class="ny-cross-banner">
                <div class="ny-cross-copy">
                  <ctx.ui.Icon name="notifications" size="small" />
                  <strong>{ctx.t("otherSessionsWaiting")}</strong>
                </div>
                <For each={others()}>
                  {(other) => (
                    <ctx.ui.Button
                      size="small"
                      variant="ghost-muted"
                      onClick={() => openPanelFor(input.panel.session.server.id, other.sessionID, "", true)}
                    >
                      {other.title} · {other.openCount}
                    </ctx.ui.Button>
                  )}
                </For>
              </div>
            </Show>
          </header>

          <Show when={state()?.error}>
            <div class="ny-error" role="alert">
              <span>{state()?.error}</span>
              <ctx.ui.Button
                size="small"
                variant="neutral"
                onClick={() => void refresh(ensureConnection(
                  input.panel.session.server,
                  input.panel.session.id,
                ))}
              >
                {ctx.t("retryLoad")}
              </ctx.ui.Button>
            </div>
          </Show>

          <Show when={!snapshot() && (state()?.loading ?? true)} fallback={
            <Show
              when={!snapshot() && state()?.error}
              fallback={
                <main class="ny-content">
                  {state()?.view === "inbox"
                    ? inboxView()
                    : openItems().length > 0
                      ? focusView()
                      : (
                        <div class="ny-empty-state">
                          <span class="ny-empty-mark"><ctx.ui.Icon name="check" size="large" /></span>
                          <h2>{ctx.t("caughtUp")}</h2>
                          <p>{ctx.t("caughtUpDescription")}</p>
                        </div>
                      )}
                </main>
              }
            >
              <div class="ny-empty-state">
                <span class="ny-empty-mark"><ctx.ui.Icon name="circle-exclamation" size="large" /></span>
                <h2>{ctx.t("loadError")}</h2>
                <ctx.ui.Button
                  variant="neutral"
                  onClick={() => void refresh(ensureConnection(
                    input.panel.session.server,
                    input.panel.session.id,
                  ))}
                >
                  {ctx.t("retryLoad")}
                </ctx.ui.Button>
              </div>
            </Show>
          }>
            <div class="ny-loading">
              <ctx.ui.Loader size="large" />
              <span>{ctx.t("loading")}</span>
            </div>
          </Show>
        </div>
      )
    }

    function pillRows(serverID: string, snapshot: SessionSnapshot): ComposerPillRow[] {
      const rows = new Map<string, ComposerPillRow>()
      const addItem = (item: QueueItem) => {
        const rowKey = `${item.rootSessionID}:${item.id}`
        if (rows.has(rowKey)) return
        rows.set(rowKey, makePillRow(serverID, item))
      }
      for (const item of snapshot.open) addItem(item)
      for (const other of snapshot.otherSessions) {
        if (other.openCount <= 0) continue
        const otherState = sessionStates[sessionKey(serverID, other.sessionID)]
        if (otherState?.snapshot) {
          for (const item of otherState.snapshot.open) addItem(item)
        } else {
          const rowKey = `session:${other.sessionID}`
          rows.set(rowKey, {
            id: rowKey,
            label: other.title,
            icon: "circle-exclamation",
            tone: other.blockingCount > 0 ? "danger" : "warning",
            detail: ctx.plural("sessionItems", other.openCount),
            run: () => openPanelFor(serverID, other.sessionID, "", true),
          })
        }
      }
      return [...rows.values()]
    }

    function makePillRow(serverID: string, item: QueueItem): ComposerPillRow {
      return {
        id: `${item.rootSessionID}:${item.id}`,
        label: item.title,
        icon: "circle-exclamation",
        tone: item.urgency === "blocking" ? "danger" : "warning",
        detail: item.originAgent ?? ctx.t(item.urgency),
        run: () => openPanelFor(serverID, item.rootSessionID, item.id, item.rootSessionID !== ctx.sessions.current()?.id),
      }
    }

    ctx.add(Panel, {
      id: "attention",
      region: "side",
      width: 440,
      list: () => [panelTab],
      render: (props) => <AttentionPanel panel={props} />,
    })

    ctx.add(ComposerPill, {
      id: "attention",
      show(input) {
        ensureConnection(input.session.server, input.session.id)
        const state = () => sessionStates[input.session.key]
        const snapshot = () => state()?.snapshot
        const ownItems = () => snapshot()?.open ?? []
        const others = () => snapshot()?.otherSessions ?? []
        const count = () => ownItems().length + others().reduce((sum, other) => sum + other.openCount, 0)
        const blocking = () =>
          ownItems().some((item) => item.urgency === "blocking") ||
          others().some((other) => other.blockingCount > 0)
        const currentSnapshot = snapshot()
        if (!currentSnapshot || count() === 0) return undefined
        return {
          label: ctx.plural("attention", count()),
          icon: "circle-exclamation",
          tone: blocking() ? "danger" : "warning",
          title: ctx.t("title"),
          rows: pillRows(input.session.server.id, currentSnapshot),
        }
      },
    })

    ctx.add(Command, {
      id: "open",
      title: ctx.t("openCommand"),
      description: ctx.t("commandDescription"),
      bind: "mod+shift+a",
      slash: { name: "attention" },
      run: () => toggleCurrentPanel(),
    })

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "open",
      title: ctx.t("title"),
      icon: "circle-exclamation",
      keybind: `${ctx.id}.open`,
      run: () => toggleCurrentPanel(),
    })
  },
})
