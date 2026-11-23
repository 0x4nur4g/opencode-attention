import type { ItemKind, ItemUrgency, QueueItem } from "./types.js"

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_TITLE = 160
export const MAX_SUMMARY = 600
export const MAX_DETAILS = 4000
export const MAX_IMPACT = 300
export const MAX_OPTIONS = 9
export const MAX_OPTION = 200
export const ANSWER_LOG = "answers-log.jsonl"

export const VALID_KINDS: readonly ItemKind[] = ["decision", "approval", "action", "ack"]
export const VALID_URGENCIES: readonly ItemUrgency[] = ["blocking", "normal", "low"]

const URGENCY_RANK: Record<ItemUrgency, number> = {
  blocking: 0,
  normal: 1,
  low: 2,
}

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export function slugifyId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return ID_PATTERN.test(cleaned) ? cleaned : `item-${Date.now().toString(36)}`
}

export interface NewItemInput {
  id: string
  sessionID: string
  rootSessionID: string
  originAgent?: string
  kind?: string
  urgency?: string
  title: string
  plainSummary?: string
  details?: string
  impact?: string
  reversible?: boolean
  options?: unknown
  recommended?: number
  allowCustom?: boolean
  defaultAction?: string
  autoCaptured?: boolean
}

export type ValidatedItem =
  | { ok: true; item: QueueItem }
  | { ok: false; error: string }

export function validateNewItem(input: NewItemInput, now: number): ValidatedItem {
  const id = typeof input.id === "string" ? input.id.trim() : ""
  if (!ID_PATTERN.test(id)) {
    return { ok: false, error: '"id" must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase letters, digits, hyphens).' }
  }
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title) return { ok: false, error: '"title" is required.' }

  const kind: ItemKind = VALID_KINDS.includes(input.kind as ItemKind)
    ? (input.kind as ItemKind)
    : "decision"
  const urgency: ItemUrgency = VALID_URGENCIES.includes(input.urgency as ItemUrgency)
    ? (input.urgency as ItemUrgency)
    : kind === "approval"
      ? "blocking"
      : "normal"

  const rawOptions = Array.isArray(input.options)
    ? input.options
        .filter((o): o is string => typeof o === "string" && o.trim() !== "")
        .slice(0, MAX_OPTIONS)
        .map((o) => clip(o.trim(), MAX_OPTION))
    : []

  const options = kind === "ack" && rawOptions.length === 0 ? ["Acknowledge"] : rawOptions
  const allowCustom = typeof input.allowCustom === "boolean" ? input.allowCustom : true
  if (options.length === 0 && !allowCustom) {
    return { ok: false, error: "No options provided and allowCustom is false: nothing to answer with." }
  }

  const recommended =
    typeof input.recommended === "number" &&
    Number.isInteger(input.recommended) &&
    input.recommended >= 0 &&
    input.recommended < options.length
      ? input.recommended
      : undefined

  const plainSummary =
    typeof input.plainSummary === "string" && input.plainSummary.trim() !== ""
      ? clip(input.plainSummary.trim(), MAX_SUMMARY)
      : ""
  const details =
    typeof input.details === "string" && input.details.trim() !== ""
      ? clip(input.details.trim(), MAX_DETAILS)
      : ""
  const impact =
    typeof input.impact === "string" && input.impact.trim() !== ""
      ? clip(input.impact.trim(), MAX_IMPACT)
      : undefined
  const defaultAction =
    typeof input.defaultAction === "string" && input.defaultAction.trim() !== ""
      ? clip(input.defaultAction.trim(), MAX_IMPACT)
      : undefined

  return {
    ok: true,
    item: {
      id,
      sessionID: input.sessionID,
      rootSessionID: input.rootSessionID,
      ...(input.originAgent ? { originAgent: input.originAgent } : {}),
      kind,
      urgency,
      title: clip(title, MAX_TITLE),
      plainSummary,
      details,
      ...(impact ? { impact } : {}),
      ...(typeof input.reversible === "boolean" ? { reversible: input.reversible } : {}),
      options,
      ...(recommended !== undefined ? { recommended } : {}),
      allowCustom,
      ...(defaultAction ? { defaultAction } : {}),
      ...(input.autoCaptured ? { autoCaptured: true } : {}),
      status: "open",
      createdAt: now,
      updatedAt: now,
    },
  }
}

export interface UpdateItemPatch {
  title?: string
  plainSummary?: string
  details?: string
  appendDetails?: string
  impact?: string
  urgency?: string
  options?: string[]
  recommended?: number
  defaultAction?: string
}

export function applyItemUpdate(item: QueueItem, patch: UpdateItemPatch, now: number): QueueItem {
  const next: QueueItem = { ...item, updatedAt: now }
  if (typeof patch.title === "string" && patch.title.trim()) next.title = clip(patch.title.trim(), MAX_TITLE)
  if (typeof patch.plainSummary === "string" && patch.plainSummary.trim()) {
    next.plainSummary = clip(patch.plainSummary.trim(), MAX_SUMMARY)
  }
  if (typeof patch.details === "string") {
    next.details = clip(patch.details.trim(), MAX_DETAILS)
  } else if (typeof patch.appendDetails === "string" && patch.appendDetails.trim()) {
    const combined = next.details ? `${next.details}\n\n${patch.appendDetails.trim()}` : patch.appendDetails.trim()
    next.details = clip(combined, MAX_DETAILS)
  }
  if (typeof patch.impact === "string" && patch.impact.trim()) next.impact = clip(patch.impact.trim(), MAX_IMPACT)
  if (VALID_URGENCIES.includes(patch.urgency as ItemUrgency)) next.urgency = patch.urgency as ItemUrgency
  if (Array.isArray(patch.options)) {
    const clean = patch.options
      .filter((o): o is string => typeof o === "string" && o.trim() !== "")
      .slice(0, MAX_OPTIONS)
      .map((o) => clip(o.trim(), MAX_OPTION))
    if (clean.length > 0 || next.allowCustom) next.options = clean
  }
  if (
    typeof patch.recommended === "number" &&
    Number.isInteger(patch.recommended) &&
    patch.recommended >= 0 &&
    patch.recommended < next.options.length
  ) {
    next.recommended = patch.recommended
  } else if (next.recommended !== undefined && next.recommended >= next.options.length) {
    delete next.recommended
  }
  if (typeof patch.defaultAction === "string" && patch.defaultAction.trim()) {
    next.defaultAction = clip(patch.defaultAction.trim(), MAX_IMPACT)
  }
  return next
}

/**
 * Queue ordering:
 * 1. Non-snoozed items come before snoozed items (snoozed items sort oldest-snooze first).
 * 2. Urgency: blocking -> normal -> low.
 * 3. Oldest createdAt first, then id.
 */
export function byPriority(a: QueueItem, b: QueueItem): number {
  const aSnoozed = a.snoozedAt !== undefined
  const bSnoozed = b.snoozedAt !== undefined
  if (aSnoozed !== bSnoozed) return aSnoozed ? 1 : -1
  if (aSnoozed && bSnoozed && a.snoozedAt !== b.snoozedAt) {
    return (a.snoozedAt ?? 0) - (b.snoozedAt ?? 0)
  }
  const urg = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
  if (urg !== 0) return urg
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function successor(before: readonly QueueItem[], goneID: string, after: readonly QueueItem[]): string {
  const at = before.findIndex((item) => item.id === goneID)
  if (at < 0) return after[0]?.id ?? ""
  const alive = new Set(after.map((item) => item.id))
  const later = before.slice(at + 1).find((item) => alive.has(item.id))
  if (later !== undefined) return later.id
  const earlier = before.slice(0, at).reverse().find((item) => alive.has(item.id))
  return earlier?.id ?? after[0]?.id ?? ""
}

export function focusIndex(items: readonly QueueItem[], focusedID: string): number {
  if (items.length === 0) return -1
  const at = items.findIndex((item) => item.id === focusedID)
  return at >= 0 ? at : 0
}

export const isRiskyOption = (option: string): boolean =>
  /^\s*(delete|drop|remove|purge|destroy|reset|force)\b/i.test(option) ||
  /\b(remote|force|production|prod|irreversible)\b/i.test(option)

export const isRiskyItem = (item: Pick<QueueItem, "kind" | "reversible">): boolean =>
  item.kind === "approval" || item.reversible === false

export const isPlainAckAnswer = (item: QueueItem, answer: string, typed: boolean, hasChat: boolean): boolean => {
  if (item.kind !== "ack" || typed || hasChat) return false
  const norm = answer.trim().toLowerCase()
  return norm === "acknowledge" || norm === "acknowledged" || norm === "ok" || norm === "got it" || norm === "noted"
}

export interface DeliveryPolicy {
  delivery: "steer" | "queue"
  resume: boolean
  silentAck: boolean
}

/**
 * Decides how an answer reaches the owning OpenCode session:
 * - Plain acknowledgment on a `kind: "ack"` item (no custom comment, no chat): records silently (`resume: false`, `delivery: "queue"`).
 * - Any user comment/override, chat close, blocking item, approval, or action: steers immediately and wakes if idle (`delivery: "steer"`, `resume: true`).
 * - Non-blocking normal/low decision: queues cleanly (`delivery: "queue"`, `resume: true`) so an active tool step finishes cleanly.
 */
export function deliveryForAnswer(
  item: QueueItem,
  answer: string,
  typed: boolean,
  hasChat: boolean,
): DeliveryPolicy {
  if (isPlainAckAnswer(item, answer, typed, hasChat)) {
    return { delivery: "queue", resume: false, silentAck: true }
  }
  if (typed || hasChat || item.urgency === "blocking" || item.kind === "approval" || item.kind === "action") {
    return { delivery: "steer", resume: true, silentAck: false }
  }
  return { delivery: "queue", resume: true, silentAck: false }
}

export const attentionTag = (id: string, answer: string): string => `[attention:${id}] ${answer}`

export interface AnswerRecord {
  ts: string
  sessionID: string
  rootSessionID: string
  cwd: string
  id: string
  kind: ItemKind
  urgency: ItemUrgency
  title: string
  plainSummary: string
  options: string[]
  answer: string
  custom?: string
  sent: boolean
  silentAck?: true
  closedFromChat?: true
  autoCaptured?: true
  rolledBack?: true
  reason?: string
}

export const answerLogLine = (record: AnswerRecord): string => `${JSON.stringify(record)}\n`
