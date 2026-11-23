import { describe, expect, test } from "bun:test"
import type { QueueItem } from "../src/types.js"
import { parseModelSpec } from "../src/types.js"
import {
  applyItemUpdate,
  answerLogLine,
  byPriority,
  deliveryForAnswer,
  focusIndex,
  isRiskyItem,
  isRiskyOption,
  successor,
  validateNewItem,
  type AnswerRecord,
  type NewItemInput,
} from "../src/queue.js"

const makeInput = (overrides: Partial<NewItemInput> = {}): NewItemInput => ({
  id: "item-1",
  sessionID: "session-1",
  rootSessionID: "session-1",
  title: "Choose a direction",
  ...overrides,
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

const validatedItem = (input: NewItemInput, now = 100): QueueItem => {
  const result = validateNewItem(input, now)
  if (!result.ok) throw new Error(result.error)
  return result.item
}

describe("parseModelSpec", () => {
  test("parses provider/model and provider/model#variant", () => {
    expect(parseModelSpec("openai/gpt-4.1")).toEqual({
      providerID: "openai",
      id: "gpt-4.1",
    })
    expect(parseModelSpec(" anthropic/claude-sonnet#fast ")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet",
      variant: "fast",
    })
  })

  test("rejects non-strings and specs without a provider and model", () => {
    for (const raw of [undefined, null, 42, {}, "", "   ", "model", "/model", "provider/", "/"]) {
      expect(parseModelSpec(raw)).toBeUndefined()
    }
  })
})

describe("validateNewItem", () => {
  test("accepts trimmed IDs within the lowercase slug pattern", () => {
    const id = `a${"b".repeat(63)}`
    const item = validatedItem(makeInput({ id: ` ${id} ` }))

    expect(item.id).toBe(id)
    expect(item.id).toHaveLength(64)
  })

  test("rejects IDs outside the lowercase letter, digit, and hyphen pattern", () => {
    for (const id of ["", "Uppercase", "-leading", "has_underscore", "two words", "a".repeat(65)]) {
      expect(validateNewItem(makeInput({ id }), 100).ok).toBe(false)
    }
  })

  test("defaults to a normal decision and makes approvals blocking by default", () => {
    const decision = validatedItem(makeInput(), 100)
    const approval = validatedItem(makeInput({ id: "approval", kind: "approval" }), 101)
    const explicitUrgency = validatedItem(
      makeInput({ id: "low-approval", kind: "approval", urgency: "low" }),
      102,
    )

    expect(decision.kind).toBe("decision")
    expect(decision.urgency).toBe("normal")
    expect(decision.allowCustom).toBe(true)
    expect(approval.urgency).toBe("blocking")
    expect(explicitUrgency.urgency).toBe("low")
  })

  test("falls back to valid kind and urgency defaults for unknown values", () => {
    const invalidDecision = validatedItem(makeInput({ kind: "unknown", urgency: "urgent" }))
    const invalidApprovalUrgency = validatedItem(
      makeInput({ id: "approval", kind: "approval", urgency: "urgent" }),
    )

    expect(invalidDecision.kind).toBe("decision")
    expect(invalidDecision.urgency).toBe("normal")
    expect(invalidApprovalUrgency.kind).toBe("approval")
    expect(invalidApprovalUrgency.urgency).toBe("blocking")
  })

  test("adds the default Acknowledge option when an ack has no usable options", () => {
    const defaultAck = validatedItem(makeInput({ kind: "ack" }))
    const ackWithBlankOptions = validatedItem(makeInput({ id: "ack-2", kind: "ack", options: [" ", 3] }))

    expect(defaultAck.options).toEqual(["Acknowledge"])
    expect(ackWithBlankOptions.options).toEqual(["Acknowledge"])
  })

  test("keeps at most nine non-empty, trimmed options", () => {
    const options = Array.from({ length: 12 }, (_, index) => ` Option ${index + 1} `)
    const item = validatedItem(makeInput({ options }))

    expect(item.options).toHaveLength(9)
    expect(item.options).toEqual(Array.from({ length: 9 }, (_, index) => `Option ${index + 1}`))
  })

  test("rejects an unanswerable item when custom answers are disabled", () => {
    expect(validateNewItem(makeInput({ options: [], allowCustom: false }), 100)).toEqual({
      ok: false,
      error: "No options provided and allowCustom is false: nothing to answer with.",
    })

    const ack = validatedItem(makeInput({ kind: "ack", allowCustom: false, options: [] }))
    expect(ack.options).toEqual(["Acknowledge"])
  })

  test("keeps only an in-range integer recommendation", () => {
    const recommended = validatedItem(
      makeInput({ options: ["A", "B"], recommended: 1 }),
    )
    expect(recommended.recommended).toBe(1)

    for (const value of [-1, 2, 1.5, Number.NaN]) {
      const item = validatedItem(makeInput({ options: ["A", "B"], recommended: value }))
      expect(item.recommended).toBeUndefined()
    }
  })

  test("requires a non-empty title", () => {
    expect(validateNewItem(makeInput({ title: "  " }), 100)).toEqual({
      ok: false,
      error: '"title" is required.',
    })
  })
})

describe("applyItemUpdate", () => {
  test("updates title, summary, details, options, and the timestamp", () => {
    const original = makeItem({
      title: "Old title",
      plainSummary: "Old summary",
      details: "Old details",
      updatedAt: 1,
      recommended: 1,
    })
    const updated = applyItemUpdate(
      original,
      {
        title: " New title ",
        plainSummary: " New summary ",
        details: " New details ",
        appendDetails: "This is ignored when details are replaced.",
        options: ["", " First ", "Second"],
        recommended: 1,
      },
      500,
    )

    expect(updated.title).toBe("New title")
    expect(updated.plainSummary).toBe("New summary")
    expect(updated.details).toBe("New details")
    expect(updated.options).toEqual(["First", "Second"])
    expect(updated.recommended).toBe(1)
    expect(updated.updatedAt).toBe(500)
    expect(original.title).toBe("Old title")
    expect(original.options).toEqual(["Option A", "Option B"])
  })

  test("appends details with a blank line and trims the appended text", () => {
    const updated = applyItemUpdate(
      makeItem({ details: "Existing details" }),
      { appendDetails: "  Additional context  " },
      2,
    )

    expect(updated.details).toBe("Existing details\n\nAdditional context")
  })

  test("prunes a recommendation when an options update removes its index", () => {
    const item = makeItem({ options: ["Keep", "Remove"], recommended: 1 })
    const updated = applyItemUpdate(item, { options: ["Keep"] }, 2)

    expect(updated.options).toEqual(["Keep"])
    expect(updated.recommended).toBeUndefined()
  })

  test("does not clear options when custom answers are disabled", () => {
    const item = makeItem({ options: ["Required option"], recommended: 0, allowCustom: false })
    const updated = applyItemUpdate(item, { options: [] }, 2)

    expect(updated.options).toEqual(["Required option"])
    expect(updated.recommended).toBe(0)
  })
})

describe("byPriority", () => {
  test("puts active items first, then sorts snoozed items by snooze time", () => {
    const items = [
      makeItem({ id: "snoozed-later-blocking", urgency: "blocking", snoozedAt: 20 }),
      makeItem({ id: "active-low", urgency: "low", createdAt: 0 }),
      makeItem({ id: "snoozed-earlier-low", urgency: "low", snoozedAt: 10 }),
      makeItem({ id: "active-blocking", urgency: "blocking", createdAt: 100 }),
      makeItem({ id: "active-normal", urgency: "normal", createdAt: 1 }),
    ]

    expect(items.sort(byPriority).map((item) => item.id)).toEqual([
      "active-blocking",
      "active-normal",
      "active-low",
      "snoozed-earlier-low",
      "snoozed-later-blocking",
    ])
  })

  test("orders equal-urgency items by creation time and then by ID", () => {
    const items = [
      makeItem({ id: "later", createdAt: 3 }),
      makeItem({ id: "tie-b", createdAt: 2 }),
      makeItem({ id: "older", createdAt: 1 }),
      makeItem({ id: "tie-a", createdAt: 2 }),
    ]

    expect(items.sort(byPriority).map((item) => item.id)).toEqual([
      "older",
      "tie-a",
      "tie-b",
      "later",
    ])
  })
})

describe("successor and focusIndex", () => {
  test("chooses the next surviving item, then the nearest earlier one", () => {
    const before = ["a", "b", "c", "d"].map((id) => makeItem({ id }))
    const after = [before[0]!, before[2]!, before[3]!]

    expect(successor(before, "b", after)).toBe("c")
    expect(successor(before, "d", [before[0]!, before[2]!])).toBe("c")
    expect(successor(before, "b", [before[0]!])).toBe("a")
  })

  test("falls back to the first remaining item, or an empty ID", () => {
    const before = [makeItem({ id: "a" })]
    const after = [makeItem({ id: "other" })]

    expect(successor(before, "missing", after)).toBe("other")
    expect(successor(before, "missing", [])).toBe("")
    expect(successor(before, "a", [])).toBe("")
  })

  test("returns the focused index, the first item for a missing ID, or -1 when empty", () => {
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })]

    expect(focusIndex(items, "b")).toBe(1)
    expect(focusIndex(items, "missing")).toBe(0)
    expect(focusIndex([], "missing")).toBe(-1)
  })
})

describe("risk helpers", () => {
  test("recognizes destructive actions and risky consequences in options", () => {
    for (const option of [
      "Delete the old branch",
      "  FORCE deploy",
      "This affects production",
      "Send to the remote service",
      "This change is irreversible",
    ]) {
      expect(isRiskyOption(option)).toBe(true)
    }

    for (const option of ["Keep the local copy", "Review the report", "productional metrics"]) {
      expect(isRiskyOption(option)).toBe(false)
    }
  })

  test("marks approvals and explicitly irreversible items as risky", () => {
    expect(isRiskyItem({ kind: "approval", reversible: true })).toBe(true)
    expect(isRiskyItem({ kind: "decision", reversible: false })).toBe(true)
    expect(isRiskyItem({ kind: "action", reversible: true })).toBe(false)
    expect(isRiskyItem({ kind: "ack" })).toBe(false)
  })
})

describe("deliveryForAnswer", () => {
  test("records a plain ack silently without resuming the session", () => {
    const item = makeItem({ kind: "ack", options: ["Acknowledge"] })

    expect(deliveryForAnswer(item, "  Got it ", false, false)).toEqual({
      delivery: "queue",
      resume: false,
      silentAck: true,
    })
  })

  test("steers and resumes when an ack includes a typed comment", () => {
    const item = makeItem({ kind: "ack", options: ["Acknowledge"] })

    expect(deliveryForAnswer(item, "Acknowledge — use the safe path", true, false)).toEqual({
      delivery: "steer",
      resume: true,
      silentAck: false,
    })
  })

  test("steers and resumes when an ack already has chat", () => {
    const item = makeItem({ kind: "ack", options: ["Acknowledge"] })

    expect(deliveryForAnswer(item, "Acknowledge", false, true)).toEqual({
      delivery: "steer",
      resume: true,
      silentAck: false,
    })
  })

  test("steers blocking decisions, approvals, and actions", () => {
    for (const item of [
      makeItem({ kind: "decision", urgency: "blocking" }),
      makeItem({ kind: "approval", urgency: "normal" }),
      makeItem({ kind: "action", urgency: "normal" }),
    ]) {
      expect(deliveryForAnswer(item, "Option A", false, false)).toEqual({
        delivery: "steer",
        resume: true,
        silentAck: false,
      })
    }
  })

  test("queues normal and low decision option clicks while resuming", () => {
    for (const urgency of ["normal", "low"] as const) {
      const item = makeItem({ kind: "decision", urgency })

      expect(deliveryForAnswer(item, "Option A", false, false)).toEqual({
        delivery: "queue",
        resume: true,
        silentAck: false,
      })
    }
  })
})

describe("answerLogLine", () => {
  test("returns one valid JSONL record followed by a newline", () => {
    const record: AnswerRecord = {
      ts: "2026-11-23T12:00:00.000Z",
      sessionID: "session-1",
      rootSessionID: "session-1",
      cwd: "/workspace",
      id: "item-1",
      kind: "decision",
      urgency: "normal",
      title: "Choose a direction",
      plainSummary: "First line\nSecond line",
      options: ["Option A"],
      answer: "Option A",
      sent: true,
    }
    const line = answerLogLine(record)

    expect(line.endsWith("\n")).toBe(true)
    expect([...line].filter((character) => character === "\n")).toHaveLength(1)
    expect(JSON.parse(line)).toEqual(record)
  })
})
