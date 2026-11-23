export type ItemKind = "decision" | "approval" | "action" | "ack"
export type ItemUrgency = "blocking" | "normal" | "low"
export type ItemStatus = "open" | "answered" | "withdrawn"

export interface QueueItem {
  id: string
  /** The session that posted this item (may be a subagent child session). */
  sessionID: string
  /** The root session whose panel owns display (equals sessionID for root sessions). */
  rootSessionID: string
  /** Optional label for the posting subagent when rolled up from a child session. */
  originAgent?: string
  kind: ItemKind
  urgency: ItemUrgency
  /** One-line question or attention headline. */
  title: string
  /** 1-2 plain-English sentences: what is needed and why it matters. */
  plainSummary: string
  /** Optional deeper technical details (collapsed by default in UI). */
  details: string
  /** Optional short line describing concrete consequences or blast radius. */
  impact?: string
  /** Explicit reversibility hint (false highlights caution and disables autofocus). */
  reversible?: boolean
  /** Up to 9 answer choices; empty for free-text action/question or ack-only. */
  options: string[]
  /** 0-based index of the agent's recommended option, if any. */
  recommended?: number
  /** Whether the user may type a custom answer or override comment. */
  allowCustom: boolean
  /** What the agent will do (or keep doing) while waiting or if deferred. */
  defaultAction?: string
  /** True when surfaced automatically by the Idle Attention Catcher. */
  autoCaptured?: boolean
  status: ItemStatus
  createdAt: number
  updatedAt: number
  /** Non-zero timestamp when snoozed/deferred; pushes item behind non-snoozed items. */
  snoozedAt?: number
  answer?: string
  answeredAt?: string
  closedFromChat?: boolean
  silentAck?: boolean
  withdrawnReason?: string
  withdrawnAt?: string
}

export type ChatMessage =
  | {
      id: string
      kind: "you"
      itemID: string
      text: string
      at: number
      status: "queued" | "thinking" | "answered" | "failed"
      since?: number
      reason?: string
      resent?: boolean
    }
  | {
      id: string
      kind: "assistant"
      itemID: string
      text: string
      at: number
      replyTo?: string
      model?: string
      seconds?: number
      checked?: string[]
    }
  | {
      id: string
      kind: "sent"
      itemID: string
      title: string
      text: string
      at: number
      count: number
      silent?: boolean
      closedFromChat?: boolean
    }

export interface PendingClose {
  token: string
  itemID: string
  decision: string
  context: string
  dueAt: number
}

export interface OtherSessionSummary {
  sessionID: string
  title: string
  openCount: number
  blockingCount: number
}

export interface SessionSnapshot {
  sessionID: string
  open: QueueItem[]
  closed: QueueItem[]
  chat: ChatMessage[]
  pendingClose: PendingClose | null
  liveActivity: Record<string, string>
  otherSessions: OtherSessionSummary[]
  now: number
}

export interface ModelSpec {
  providerID: string
  id: string
  variant?: string
}

export interface AttentionOptions {
  /** Override storage directory (default: ~/.local/share/opencode/attention). */
  queueDir?: string
  /** Auto-open the panel when a new blocking/normal item arrives (default: true). */
  autoOpenPanel?: boolean
  /** Send system notification when blurred on arrival (default: true). */
  notifyOnArrival?: boolean
  discuss?: {
    /** Model spec as "provider/model" or "provider/model#variant". */
    model?: string
    /** Max tool/model steps for a single DISCUSS reply (default: 12). */
    maxTurns?: number
    /** Timeout per DISCUSS reply in ms (default: 180000). */
    timeoutMs?: number
  }
  idleCatcher?: {
    /** Enable passive extraction of buried questions/caveats on session idle (default: true). */
    enabled?: boolean
    /** Model spec as "provider/model" or "provider/model#variant". */
    model?: string
    /** Minimum assistant response chars before checking (unless ending with '?'; default: 120). */
    minChars?: number
  }
}

export interface ResolvedOptions {
  queueDir: string
  autoOpenPanel: boolean
  notifyOnArrival: boolean
  discuss: {
    model?: ModelSpec
    maxTurns: number
    timeoutMs: number
  }
  idleCatcher: {
    enabled: boolean
    model?: ModelSpec
    minChars: number
  }
}

export function parseModelSpec(raw: unknown): ModelSpec | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  const providerID = trimmed.slice(0, slash)
  const rest = trimmed.slice(slash + 1)
  const hash = rest.indexOf("#")
  if (hash > 0 && hash < rest.length - 1) {
    return { providerID, id: rest.slice(0, hash), variant: rest.slice(hash + 1) }
  }
  return { providerID, id: rest }
}
