import type { Plugin } from "@opencode/plugin"
import type { ItemKind, ItemUrgency, ModelSpec, QueueItem } from "./types.js"
import { clip, slugifyId, VALID_KINDS, VALID_URGENCIES } from "./queue.js"
import { resolveFastModel } from "./discuss.js"

type ServerContext = Parameters<Plugin.Plugin["setup"]>[0]

export interface CaughtAttention {
  id: string
  kind: ItemKind
  urgency: ItemUrgency
  title: string
  plainSummary: string
  impact?: string
  reversible?: boolean
  options: string[]
  recommended?: number
}

const CATCHER_PROMPT = (assistantText: string, openTitles: readonly string[]): string =>
  [
    "You are an ultra-conservative attention filter for a coding agent's final message before going idle.",
    "Decide whether the message below genuinely requires human action, a decision, an approval, OR explicit acknowledgment of a critical caveat/fallback/blocker — AND is NOT already covered by the currently open Attention items.",
    "Return JSON ONLY (no markdown fence, no extra prose).",
    "Return {\"needsAttention\": false} for normal status reports, completed tasks, routine explanations, or polite closers like 'Let me know if you need anything else'.",
    "Return {\"needsAttention\": true, \"kind\": \"decision\"|\"approval\"|\"action\"|\"ack\", \"urgency\": \"blocking\"|\"normal\"|\"low\", \"id\": \"short-kebab-slug\", \"title\": \"crisp one-line headline\", \"plainSummary\": \"1-2 plain English sentences explaining what is needed and why\", \"impact\": \"optional short consequence\", \"reversible\": true|false, \"options\": [\"short option\", ...], \"recommended\": 0} ONLY when the user would miss something genuinely important if they didn't read the full message.",
    openTitles.length > 0 ? `Already open Attention items:\n${openTitles.map((t) => `- ${t}`).join("\n")}` : "Already open Attention items: none.",
    "--- ASSISTANT FINAL MESSAGE ---",
    clip(assistantText, 6000),
  ].join("\n\n")

export function parseCatcherResponse(raw: string): CaughtAttention | undefined {
  const trimmed = raw.trim()
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const jsonText = (fenceMatch?.[1] ?? trimmed).trim()
  const start = jsonText.indexOf("{")
  const end = jsonText.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>
  if (obj.needsAttention !== true) return undefined
  const title = typeof obj.title === "string" ? obj.title.trim() : ""
  const plainSummary = typeof obj.plainSummary === "string" ? obj.plainSummary.trim() : ""
  if (!title) return undefined
  const kind: ItemKind = VALID_KINDS.includes(obj.kind as ItemKind) ? (obj.kind as ItemKind) : "decision"
  const urgency: ItemUrgency = VALID_URGENCIES.includes(obj.urgency as ItemUrgency)
    ? (obj.urgency as ItemUrgency)
    : kind === "ack"
      ? "normal"
      : "blocking"
  const options = Array.isArray(obj.options)
    ? obj.options.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 6)
    : []
  const recommended =
    typeof obj.recommended === "number" && Number.isInteger(obj.recommended) && obj.recommended >= 0 && obj.recommended < options.length
      ? obj.recommended
      : undefined
  return {
    id: slugifyId(typeof obj.id === "string" && obj.id.trim() ? obj.id : title.slice(0, 40)),
    kind,
    urgency,
    title,
    plainSummary: plainSummary || title,
    ...(typeof obj.impact === "string" && obj.impact.trim() ? { impact: obj.impact.trim() } : {}),
    ...(typeof obj.reversible === "boolean" ? { reversible: obj.reversible } : {}),
    options,
    ...(recommended !== undefined ? { recommended } : {}),
  }
}

export function shouldInspectMessage(text: string, minChars: number): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length >= minChars) return true
  // Short messages that explicitly end with a question mark may still be direct questions
  return trimmed.endsWith("?") && trimmed.length >= 20
}

export async function detectMissedAttention(input: {
  ctx: ServerContext
  sessionID: string
  assistantText: string
  openItems: readonly QueueItem[]
  modelSpec?: ModelSpec
  minChars: number
}): Promise<CaughtAttention | undefined> {
  if (!shouldInspectMessage(input.assistantText, input.minChars)) return undefined
  const model = await resolveFastModel(input.ctx, input.modelSpec, input.sessionID)
  try {
    const res = await input.ctx.experimental.generate.text({
      ...(model ? { model } : {}),
      prompt: CATCHER_PROMPT(
        input.assistantText,
        input.openItems.map((i) => `${i.id}: ${i.title}`),
      ),
    })
    const text = typeof (res as { text?: unknown })?.text === "string" ? (res as { text: string }).text : ""
    return parseCatcherResponse(text)
  } catch {
    return undefined
  }
}
