import { describe, expect, test } from "bun:test"
import type { ChatMessage, QueueItem } from "../src/types.js"
import {
  SESSION_CHARS,
  buildSessionMessage,
  protocolText,
  splitReply,
  verifyOwnerQuote,
} from "../src/chat.js"

type OwnerMessage = Extract<ChatMessage, { kind: "you" }>
type AssistantMessage = Extract<ChatMessage, { kind: "assistant" }>

const ownerMessage = (id: string, text: string, at = 0): OwnerMessage => ({
  id,
  kind: "you",
  itemID: "item-1",
  text,
  at,
  status: "answered",
})

const assistantMessage = (
  id: string,
  text: string,
  at = 0,
  metadata: Pick<AssistantMessage, "model" | "seconds"> = {},
): AssistantMessage => ({
  id,
  kind: "assistant",
  itemID: "item-1",
  text,
  at,
  ...metadata,
})

const makeItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1",
  sessionID: "session-1",
  rootSessionID: "session-1",
  kind: "decision",
  urgency: "normal",
  title: "Choose a direction",
  plainSummary: "Choose one option.",
  details: "",
  options: ["Option A", "Option B"],
  allowCustom: true,
  status: "open",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe("splitReply", () => {
  test("extracts the matching context and close decision with its quoted text", () => {
    const result = splitReply(
      [
        "Option A is safer.",
        "",
        "[attention-context:item-1]",
        "- The config path matches.",
        "- The change is reversible.",
        '[attention-close:item-1] Choose A | quote: "I choose option A"',
      ].join("\n"),
      "item-1",
    )

    expect(result).toEqual({
      reply: "Option A is safer.",
      closing: {
        decision: "Choose A",
        quote: "I choose option A",
        context: "- The config path matches.\n- The change is reversible.",
      },
    })
  })

  test("ignores context and close markers inside backtick and tilde fences", () => {
    const result = splitReply(
      [
        "Example:",
        "```text",
        "[attention-context:item-1]",
        "- fake context",
        '[attention-close:item-1] Fake choice | quote: "not owner words"',
        "```",
        "~~~",
        "[attention-context:item-1]",
        "- fake tilde context",
        '[attention-close:item-1] Fake again | quote: "not owner words"',
        "~~~",
        "Actual answer.",
        '[attention-close:item-1] Continue | quote: "I choose option A"',
      ].join("\n"),
      "item-1",
    )

    expect(result.closing).toEqual({
      decision: "Continue",
      quote: "I choose option A",
      context: "",
    })
    expect(result.reply).toContain("[attention-context:item-1]")
    expect(result.reply).toContain('[attention-close:item-1] Fake choice | quote: "not owner words"')
    expect(result.reply).toContain('[attention-close:item-1] Fake again | quote: "not owner words"')
    expect(result.reply).toContain("Actual answer.")
  })

  test("leaves markers for another item in the reply", () => {
    const result = splitReply(
      [
        "[attention-context:item-2]",
        "- context for the other item",
        "[attention-close:item-2] Ignore | quote: unrelated",
        "Visible answer.",
        "[attention-context:item-1]",
        "- context for this item",
        "[attention-close:item-1] Proceed | quote: exact owner words",
      ].join("\n"),
      "item-1",
    )

    expect(result.reply).toContain("[attention-context:item-2]")
    expect(result.reply).toContain("[attention-close:item-2] Ignore | quote: unrelated")
    expect(result.reply).toContain("Visible answer.")
    expect(result.closing?.context).toBe("- context for this item")
    expect(result.closing?.decision).toBe("Proceed")
  })

  test("keeps an orphan context block as plain reply text", () => {
    const result = splitReply(
      [
        "Answer without a close.",
        "[attention-context:item-1]",
        "- unclosed context",
        "Still part of the orphan block.",
      ].join("\n"),
      "item-1",
    )

    expect(result).toEqual({
      reply:
        "Answer without a close.\n[attention-context:item-1]\n- unclosed context\nStill part of the orphan block.",
    })
  })

  test("strips matching single quotes around the owner quote", () => {
    const result = splitReply(
      "[attention-close:item-1] Proceed | quote: 'Please continue'",
      "item-1",
    )

    expect(result.closing?.quote).toBe("Please continue")
  })
})

describe("verifyOwnerQuote", () => {
  test("matches a trimmed case-insensitive substring in an owner message", () => {
    const thread: ChatMessage[] = [
      ownerMessage("owner-1", "Please use the safe option and continue."),
      assistantMessage("assistant-1", "I will check the safe option."),
    ]

    expect(verifyOwnerQuote(thread, "  USE THE SAFE OPTION  ")).toBe(true)
  })

  test("does not accept text found only in assistant replies or an empty quote", () => {
    const thread: ChatMessage[] = [assistantMessage("assistant-1", "Only the assistant said proceed now.")]

    expect(verifyOwnerQuote(thread, "proceed now")).toBe(false)
    expect(verifyOwnerQuote(thread, " \n ")).toBe(false)
  })
})

describe("buildSessionMessage", () => {
  const item = { id: "item-1", title: "Choose a direction", kind: "decision" as const }

  test("formats a plain answer without chat as one attention tag", () => {
    expect(buildSessionMessage(item, "Option A", [])).toBe("[attention:item-1] Option A")
  })

  test("includes relevant pane-model context when provided", () => {
    const message = buildSessionMessage(item, "Option A", [], "Verified path: src/queue.ts\nRisk: low")

    expect(message).toContain("[PANE MODEL] RELEVANT CONTEXT")
    expect(message).toContain("  Verified path: src/queue.ts")
    expect(message).toContain("  Risk: low")
  })

  test("labels owner and pane-model messages with the correct speaker metadata", () => {
    const message = buildSessionMessage(item, "Option A", [
      ownerMessage("owner-1", "I choose option A.", 0),
      assistantMessage("assistant-1", "The source confirms it.", 1000, {
        model: "gpt-4.1-mini",
        seconds: 2.5,
      }),
    ])

    expect(message).toContain("[OWNER · 1970-01-01 00:00:00 UTC] I choose option A.")
    expect(message).toContain(
      "[PANE MODEL, gpt-4.1-mini, 2.5s · 1970-01-01 00:00:01 UTC] The source confirms it.",
    )
  })

  test("shortens the oldest pane-model reply before newer replies", () => {
    const oldest = `old reply: ${"o".repeat(16_000)}`
    const newest = `new reply: ${"n".repeat(16_000)}`
    const message = buildSessionMessage(item, "Option A", [
      assistantMessage("assistant-old", oldest, 0),
      assistantMessage("assistant-new", newest, 1000),
    ])

    expect(message.length).toBeLessThanOrEqual(SESSION_CHARS)
    expect(message).toContain(`${oldest.slice(0, 300)} …`)
    expect(message).not.toContain(oldest)
    expect(message).toContain(newest)
    expect(message).not.toContain(`${newest.slice(0, 300)} …`)
  })

  test("drops oldest pane-model replies only after trimming them", () => {
    const thread = Array.from({ length: 100 }, (_, index) => {
      const label = `reply-${String(index).padStart(3, "0")}:`
      return assistantMessage(
        `assistant-${index}`,
        `${label}${"x".repeat(1000)}`,
        index * 1000,
      )
    })
    const message = buildSessionMessage(item, "Option A", thread)

    expect(message.length).toBeLessThanOrEqual(SESSION_CHARS)
    expect(message).toContain("older pane-model replies trimmed to 300 chars")
    expect(message).toContain("older pane-model replies omitted")
    expect(message).not.toContain("reply-000:")
    expect(message).toContain("reply-099:")
  })

  test("never truncates owner messages even when they exceed the session budget", () => {
    const ownerText = `owner words: ${"x".repeat(SESSION_CHARS + 100)}`
    const message = buildSessionMessage(item, "Option A", [ownerMessage("owner-large", ownerText)])

    expect(message.length).toBeGreaterThan(SESSION_CHARS)
    expect(message).toContain(ownerText)
    expect(message).toContain("owner messages are kept whole")
  })
})

describe("protocolText", () => {
  test("summarizes pending open items", () => {
    const text = protocolText([
      makeItem({
        id: "approve-release",
        kind: "approval",
        urgency: "blocking",
        title: "Approve the release",
      }),
      makeItem({
        id: "confirm-note",
        kind: "ack",
        urgency: "low",
        title: "Confirm the caveat",
        autoCaptured: true,
      }),
    ])

    expect(text).toContain("Currently open items waiting on the user (2)")
    expect(text).toContain("- [blocking/approval] approve-release: Approve the release")
    expect(text).toContain("- [low/ack] confirm-note: Confirm the caveat (auto-captured)")
  })

  test("states when there are no pending open items", () => {
    expect(protocolText([])).toContain("Currently open items in this session: none.")
  })
})
