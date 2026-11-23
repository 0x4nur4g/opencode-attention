import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ChatMessage, ModelSpec, QueueItem } from "./types.js"
import {
  describeToolCall,
  discussSystemPrompt,
  discussUserPrompt,
  secondsBetween,
  splitReply,
} from "./chat.js"
import type { ClosingBlock } from "./chat.js"

type ServerContext = Parameters<Plugin.Plugin["setup"]>[0]

const RULES_CHARS = 20_000

/** Read-only session permissions baseline (enforced further by permission.hook & tool.hook). */
export const READ_ONLY_PERMISSIONS: ReadonlyArray<{
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}> = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "write", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
]

/** Collects AGENTS.md and CLAUDE.md from global config and ancestors down to projectDir. */
export function loadStandingRules(projectDir: string): string {
  const home = homedir()
  const candidates: string[] = [
    join(home, ".config", "opencode", "AGENTS.md"),
    join(home, ".claude", "CLAUDE.md"),
  ]
  const abs = resolve(projectDir)
  const ancestors: string[] = []
  let cur = abs
  for (;;) {
    ancestors.unshift(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dir of ancestors) {
    candidates.push(join(dir, "AGENTS.md"))
    candidates.push(join(dir, "CLAUDE.md"))
  }

  const seen = new Set<string>()
  const chunks: string[] = []
  let total = 0
  for (const file of candidates) {
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    try {
      const content = readFileSync(file, "utf8").trim()
      if (!content) continue
      const section = `--- ${file} ---\n${content}`
      if (total + section.length > RULES_CHARS) {
        const remaining = RULES_CHARS - total
        if (remaining > 80) chunks.push(`${section.slice(0, remaining)}\n[cut]`)
        break
      }
      chunks.push(section)
      total += section.length
    } catch {
      // unreadable rule file
    }
  }
  return chunks.join("\n\n")
}

/** Extracts the last N non-empty assistant text replies from structured OpenCode session context. */
export async function getRecentAssistantReplies(
  ctx: ServerContext,
  sessionID: string,
  limit = 4,
): Promise<string[]> {
  try {
    const messages = await ctx.session.context({ sessionID })
    const replies: string[] = []
    for (const msg of messages) {
      if (msg.type !== "assistant") continue
      const texts = msg.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text.trim())
        .filter(Boolean)
      if (texts.length > 0) replies.push(texts.join("\n\n"))
    }
    return replies.slice(-limit)
  } catch {
    return []
  }
}

/**
 * Picks a reliable fast model for DISCUSS and the Idle Attention Catcher:
 * 1. Explicit plugin config (`discuss.model` / `idleCatcher.model`)
 * 2. User's configured `explore` agent model (already authenticated and chosen for fast read-only checks)
 * 3. Active model of the main session (guaranteed authenticated and reachable)
 * 4. OpenCode's default model
 */
export async function resolveFastModel(
  ctx: ServerContext,
  configured: ModelSpec | undefined,
  sessionID?: string,
): Promise<ModelSpec | undefined> {
  if (configured) return configured

  // 1. Prefer the user's configured `explore` agent model when set
  try {
    const res = await ctx.agent.get({ agentID: "explore" })
    const agent = (res as { data?: { model?: ModelSpec | null } })?.data ?? (res as unknown as { model?: ModelSpec | null })
    if (agent?.model?.providerID && agent?.model?.id) {
      return {
        providerID: agent.model.providerID,
        id: agent.model.id,
        ...(agent.model.variant ? { variant: agent.model.variant } : {}),
      }
    }
  } catch {
    // fall through
  }

  // 2. Fallback to the session's active or last-used assistant model
  if (sessionID) {
    try {
      const info = await ctx.session.get({ sessionID })
      if (info.model?.providerID && info.model?.id) {
        return {
          providerID: info.model.providerID,
          id: info.model.id,
          ...(info.model.variant ? { variant: info.model.variant } : {}),
        }
      }
    } catch {
      // fall through
    }
    try {
      const messages = await ctx.session.context({ sessionID })
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]
        if (m?.type === "assistant" && m.model?.providerID && m.model?.id) {
          return {
            providerID: m.model.providerID,
            id: m.model.id,
            ...(m.model.variant ? { variant: m.model.variant } : {}),
          }
        }
      }
    } catch {
      // fall through
    }
  }

  // 3. Final fallback: OpenCode's configured default model
  try {
    const def = await ctx.model.default()
    const d = (def as { data?: { providerID?: string; id?: string } | null })?.data
    if (d?.providerID && d?.id) return { providerID: d.providerID, id: d.id }
  } catch {
    // ignore
  }
  return undefined
}

export interface DiscussSessionMeta {
  systemPrompt: string
  rootSessionID: string
  itemID: string
  ownerMessageID: string
  maxTurns: number
  turnsUsed: number
  checked: string[]
  onActivity: (line: string) => void
}

export type DiscussResult =
  | {
      ok: true
      replyText: string
      closing?: ClosingBlock
      model: string
      seconds: number
      checked: string[]
    }
  | { ok: false; aborted: boolean; reason: string }

export class DiscussRunner {
  /** Maps active scratch discuss sessionID -> metadata (used by hooks in index.ts). */
  readonly activeSessions = new Map<string, DiscussSessionMeta>()
  private readonly controllersByItem = new Map<string, Set<AbortController>>()
  private allowedWorktrees: string[] = []
  private worktreesLoadedAt = 0

  constructor(private readonly ctx: ServerContext) {}

  async getAllowedWorktrees(): Promise<readonly string[]> {
    const now = Date.now()
    if (now - this.worktreesLoadedAt < 30_000 && this.allowedWorktrees.length > 0) {
      return this.allowedWorktrees
    }
    const dirs = new Set<string>([this.ctx.location.directory, this.ctx.location.project.canonical])
    try {
      const listed = await this.ctx.worktree.list({ projectID: this.ctx.location.project.id })
      const arr = Array.isArray(listed) ? listed : ((listed as { data?: Array<{ directory?: string }> })?.data ?? [])
      for (const wt of arr) {
        if (typeof wt?.directory === "string") dirs.add(wt.directory)
      }
    } catch {
      // ignore worktree lookup failure
    }
    this.allowedWorktrees = [...dirs]
    this.worktreesLoadedAt = now
    return this.allowedWorktrees
  }

  stopForItem(itemID: string): void {
    const set = this.controllersByItem.get(itemID)
    if (!set) return
    this.controllersByItem.delete(itemID)
    for (const c of set) c.abort()
  }

  stopAll(): void {
    for (const itemID of [...this.controllersByItem.keys()]) this.stopForItem(itemID)
  }

  observeToolCall(sessionID: string, tool: string, input: unknown): void {
    const meta = this.activeSessions.get(sessionID)
    if (!meta) return
    const desc = describeToolCall(tool, input)
    if (meta.checked.length < 25 && !meta.checked.includes(desc.checked)) {
      meta.checked.push(desc.checked)
    }
    meta.onActivity(desc.activity)
  }

  async run(input: {
    item: QueueItem
    ownerMessageID: string
    earlierThread: readonly ChatMessage[]
    siblingTitles: readonly string[]
    message: string
    modelSpec?: ModelSpec
    maxTurns: number
    timeoutMs: number
    onActivity: (line: string) => void
  }): Promise<DiscussResult> {
    const controller = new AbortController()
    let set = this.controllersByItem.get(input.item.id)
    if (!set) {
      set = new Set()
      this.controllersByItem.set(input.item.id, set)
    }
    set.add(controller)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, input.timeoutMs)

    const startedAt = Date.now()
    let scratchID: string | undefined

    try {
      const model = await resolveFastModel(this.ctx, input.modelSpec, input.item.sessionID)
      const modelLabel = model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : "default"

      const [recentSessionReplies, rules] = await Promise.all([
        getRecentAssistantReplies(this.ctx, input.item.sessionID, 4),
        Promise.resolve(loadStandingRules(this.ctx.location.directory)),
      ])
      if (controller.signal.aborted) {
        return { ok: false, aborted: !timedOut, reason: timedOut ? "Timed out before starting. Press Retry." : "Cancelled." }
      }

      const systemPrompt = discussSystemPrompt(input.item, modelLabel, rules)
      const userPrompt = discussUserPrompt({
        item: input.item,
        thread: input.earlierThread,
        recentSessionReplies,
        siblingTitles: input.siblingTitles,
        message: input.message,
      })

      // Omit parentID intentionally: a child session with parentID delivers <background-result>
      // into the main session on completion, which would leak DISCUSS traffic and wake the main agent.
      // Archive immediately so it stays invisible while running, and remove in `finally`.
      const created = await this.ctx.session.create({
        title: `[attention] ${input.item.id}`,
        ...(model ? { model } : {}),
        location: { directory: this.ctx.location.directory },
        metadata: { attentionDiscuss: true, itemID: input.item.id, rootSessionID: input.item.rootSessionID },
        permissions: READ_ONLY_PERMISSIONS,
      })
      scratchID = created.id
      await this.ctx.session.update({ sessionID: scratchID, archived: true }).catch(() => undefined)

      const meta: DiscussSessionMeta = {
        systemPrompt,
        rootSessionID: input.item.rootSessionID,
        itemID: input.item.id,
        ownerMessageID: input.ownerMessageID,
        maxTurns: input.maxTurns,
        turnsUsed: 0,
        checked: [],
        onActivity: input.onActivity,
      }
      this.activeSessions.set(scratchID, meta)

      const onAbort = () => {
        if (scratchID) {
          void this.ctx.session.interrupt({ sessionID: scratchID, resume: false }).catch(() => undefined)
        }
      }
      controller.signal.addEventListener("abort", onAbort, { once: true })

      try {
        await this.ctx.session.prompt({
          sessionID: scratchID,
          text: userPrompt,
          delivery: "steer",
          resume: true,
        })
        await this.ctx.session.wait({ sessionID: scratchID }, { signal: controller.signal })
      } finally {
        controller.signal.removeEventListener("abort", onAbort)
      }

      if (controller.signal.aborted) {
        return {
          ok: false,
          aborted: !timedOut,
          reason: timedOut
            ? `DISCUSS timed out after ${Math.round(input.timeoutMs / 1000)}s. Press Retry.`
            : "Cancelled.",
        }
      }

      const messages = await this.ctx.session.context({ sessionID: scratchID })
      const assistantTexts: string[] = []
      let usedModel = modelLabel
      for (const msg of messages) {
        if (msg.type !== "assistant") continue
        if (msg.model?.providerID && msg.model?.id) usedModel = `${msg.model.providerID}/${msg.model.id}`
        for (const part of msg.content) {
          if (part.type === "text" && part.text.trim()) assistantTexts.push(part.text.trim())
        }
      }
      const rawReply = assistantTexts.at(-1) ?? ""
      const split = splitReply(rawReply, input.item.id)
      if (!split.reply && !split.closing) {
        return { ok: false, aborted: false, reason: "Model returned an empty reply. Press Retry." }
      }

      return {
        ok: true,
        replyText: split.reply || "Decision recorded.",
        ...(split.closing ? { closing: split.closing } : {}),
        model: usedModel,
        seconds: secondsBetween(startedAt, Date.now()),
        checked: [...meta.checked],
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          aborted: !timedOut,
          reason: timedOut
            ? `DISCUSS timed out after ${Math.round(input.timeoutMs / 1000)}s. Press Retry.`
            : "Cancelled.",
        }
      }
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, aborted: false, reason: `DISCUSS failed: ${msg.slice(0, 140)}. Press Retry.` }
    } finally {
      clearTimeout(timer)
      const current = this.controllersByItem.get(input.item.id)
      current?.delete(controller)
      if (current && current.size === 0) this.controllersByItem.delete(input.item.id)
      if (scratchID) {
        this.activeSessions.delete(scratchID)
        // Always clean up scratch session so it never clutters the user's session list
        void this.ctx.session.remove({ sessionID: scratchID }).catch(() => undefined)
      }
    }
  }
}
