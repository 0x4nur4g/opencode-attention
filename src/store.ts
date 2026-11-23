import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ChatMessage, OtherSessionSummary, QueueItem } from "./types.js"
import { ANSWER_LOG, answerLogLine, byPriority } from "./queue.js"
import type { AnswerRecord } from "./queue.js"
import { CHAT_KEEP_MESSAGES, CHAT_KEEP_MS } from "./chat.js"

interface StoredChatFile {
  at: number
  messages: ChatMessage[]
}

export function resolveQueueDir(configured?: string): string {
  const raw = typeof configured === "string" ? configured.trim().replace(/\/+$/, "") : ""
  if (raw !== "") {
    if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))
    return raw
  }
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const base = xdg && xdg !== "" ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode", "attention")
}

// ponytail: simple synchronous JSON file store per root session + append-only 0600 JSONL audit log.
// No SQLite dependency needed for tens of small JSON items per session.
export class AttentionStore {
  readonly rootDir: string
  private readonly itemsByRoot = new Map<string, Map<string, QueueItem>>()
  private readonly chatByRoot = new Map<string, StoredChatFile>()
  private readonly titlesByRoot = new Map<string, string>()

  constructor(rootDir: string) {
    this.rootDir = rootDir
    mkdirSync(rootDir, { recursive: true, mode: 0o700 })
    this.loadAllFromDisk()
  }

  private sessionDir(rootSessionID: string): string {
    return join(this.rootDir, rootSessionID)
  }

  private itemPath(rootSessionID: string, itemID: string): string {
    return join(this.sessionDir(rootSessionID), `${itemID}.json`)
  }

  private chatPath(rootSessionID: string): string {
    return join(this.sessionDir(rootSessionID), "_chat.json")
  }

  private loadAllFromDisk(): void {
    let entries: string[]
    try {
      entries = readdirSync(this.rootDir)
    } catch {
      return
    }
    const now = Date.now()
    for (const entry of entries) {
      if (entry === ANSWER_LOG || entry.startsWith(".")) continue
      const dir = join(this.rootDir, entry)
      let files: string[]
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      const map = new Map<string, QueueItem>()
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const full = join(dir, file)
        if (file === "_chat.json") {
          const parsed = this.readChatFile(full)
          if (parsed) {
            if (now - parsed.at > CHAT_KEEP_MS) {
              try {
                rmSync(full, { force: true })
              } catch {
                // ignore prune error
              }
            } else {
              this.chatByRoot.set(entry, parsed)
            }
          }
          continue
        }
        try {
          const raw = JSON.parse(readFileSync(full, "utf8")) as Partial<QueueItem>
          if (typeof raw?.id === "string" && typeof raw?.title === "string" && typeof raw?.status === "string") {
            const item: QueueItem = {
              id: raw.id,
              sessionID: typeof raw.sessionID === "string" ? raw.sessionID : entry,
              rootSessionID: typeof raw.rootSessionID === "string" ? raw.rootSessionID : entry,
              ...(typeof raw.originAgent === "string" ? { originAgent: raw.originAgent } : {}),
              kind: raw.kind ?? "decision",
              urgency: raw.urgency ?? "normal",
              title: raw.title,
              plainSummary: typeof raw.plainSummary === "string" ? raw.plainSummary : "",
              details: typeof raw.details === "string" ? raw.details : "",
              ...(typeof raw.impact === "string" ? { impact: raw.impact } : {}),
              ...(typeof raw.reversible === "boolean" ? { reversible: raw.reversible } : {}),
              options: Array.isArray(raw.options) ? raw.options.filter((x): x is string => typeof x === "string") : [],
              ...(typeof raw.recommended === "number" ? { recommended: raw.recommended } : {}),
              allowCustom: typeof raw.allowCustom === "boolean" ? raw.allowCustom : true,
              ...(typeof raw.defaultAction === "string" ? { defaultAction: raw.defaultAction } : {}),
              ...(raw.autoCaptured === true ? { autoCaptured: true } : {}),
              status: raw.status,
              createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
              updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
              ...(typeof raw.snoozedAt === "number" ? { snoozedAt: raw.snoozedAt } : {}),
              ...(typeof raw.answer === "string" ? { answer: raw.answer } : {}),
              ...(typeof raw.answeredAt === "string" ? { answeredAt: raw.answeredAt } : {}),
              ...(raw.closedFromChat === true ? { closedFromChat: true } : {}),
              ...(raw.silentAck === true ? { silentAck: true } : {}),
              ...(typeof raw.withdrawnReason === "string" ? { withdrawnReason: raw.withdrawnReason } : {}),
              ...(typeof raw.withdrawnAt === "string" ? { withdrawnAt: raw.withdrawnAt } : {}),
            }
            map.set(item.id, item)
          }
        } catch {
          // ignore unreadable item file
        }
      }
      if (map.size > 0) this.itemsByRoot.set(entry, map)
    }
  }

  private readChatFile(path: string): StoredChatFile | undefined {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredChatFile>
      if (!raw || !Array.isArray(raw.messages)) return undefined
      return {
        at: typeof raw.at === "number" ? raw.at : 0,
        messages: raw.messages as ChatMessage[],
      }
    } catch {
      return undefined
    }
  }

  private writeJson(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  }

  setSessionTitle(rootSessionID: string, title: string): void {
    if (title.trim()) this.titlesByRoot.set(rootSessionID, title.trim())
  }

  getItem(rootSessionID: string, itemID: string): QueueItem | undefined {
    return this.itemsByRoot.get(rootSessionID)?.get(itemID)
  }

  listOpen(rootSessionID: string): QueueItem[] {
    const map = this.itemsByRoot.get(rootSessionID)
    if (!map) return []
    return [...map.values()].filter((i) => i.status === "open").sort(byPriority)
  }

  listClosed(rootSessionID: string): QueueItem[] {
    const map = this.itemsByRoot.get(rootSessionID)
    if (!map) return []
    return [...map.values()]
      .filter((i) => i.status === "answered")
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  }

  listAll(rootSessionID: string): QueueItem[] {
    const map = this.itemsByRoot.get(rootSessionID)
    if (!map) return []
    return [...map.values()].sort(byPriority)
  }

  putItem(item: QueueItem): void {
    let map = this.itemsByRoot.get(item.rootSessionID)
    if (!map) {
      map = new Map()
      this.itemsByRoot.set(item.rootSessionID, map)
    }
    map.set(item.id, item)
    this.writeJson(this.itemPath(item.rootSessionID, item.id), item)
  }

  otherSessionsWithOpen(excludeRootSessionID: string): OtherSessionSummary[] {
    const out: OtherSessionSummary[] = []
    for (const [rootID, map] of this.itemsByRoot) {
      if (rootID === excludeRootSessionID) continue
      let openCount = 0
      let blockingCount = 0
      for (const item of map.values()) {
        if (item.status === "open") {
          openCount += 1
          if (item.urgency === "blocking") blockingCount += 1
        }
      }
      if (openCount > 0) {
        out.push({
          sessionID: rootID,
          title: this.titlesByRoot.get(rootID) ?? rootID.slice(0, 12),
          openCount,
          blockingCount,
        })
      }
    }
    return out.sort((a, b) => b.blockingCount - a.blockingCount || b.openCount - a.openCount)
  }

  getChat(rootSessionID: string): ChatMessage[] {
    return this.chatByRoot.get(rootSessionID)?.messages ?? []
  }

  setChat(rootSessionID: string, messages: ChatMessage[], now = Date.now()): void {
    const trimmed = messages.slice(-CHAT_KEEP_MESSAGES)
    const entry: StoredChatFile = { at: now, messages: trimmed }
    this.chatByRoot.set(rootSessionID, entry)
    this.writeJson(this.chatPath(rootSessionID), entry)
  }

  /** Marks any in-flight chat messages from before a reload so they can be retried cleanly. */
  recoverChatOnReload(rootSessionID: string): string[] {
    const messages = this.getChat(rootSessionID)
    if (messages.length === 0) return []
    const toResume: string[] = []
    let changed = false
    const next = messages.map((m): ChatMessage => {
      if (m.kind !== "you" || (m.status !== "queued" && m.status !== "thinking")) return m
      changed = true
      if (m.resent) {
        return { ...m, status: "failed", reason: "Server reloaded while waiting. Press Retry." }
      }
      toResume.push(m.id)
      return { ...m, status: "queued", resent: true }
    })
    if (changed) this.setChat(rootSessionID, next)
    return toResume
  }

  appendAnswerLog(record: AnswerRecord): void {
    const logPath = join(this.rootDir, ANSWER_LOG)
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 })
    const existed = existsSync(logPath)
    appendFileSync(logPath, answerLogLine(record), { mode: 0o600 })
    if (!existed) {
      try {
        chmodSync(logPath, 0o600)
      } catch {
        // best-effort permission tightening
      }
    }
  }
}
