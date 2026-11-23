import { Rpc } from "@opencode/plugin/rpc"

// Shared RPC contract between the server plugin (src/index.ts) and the TUI/Desktop UIs.
// Uses JSON Schema so no extra runtime validator dependency is needed.
export const AttentionRpc = Rpc.define({
  id: "attention",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object" },
    },
    answer: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          itemID: { type: "string" },
          answer: { type: "string" },
          typed: { type: "boolean" },
        },
        required: ["sessionID", "itemID", "answer"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          silent: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
    },
    batchAck: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          acked: { type: "number" },
          errors: { type: "array", items: { type: "string" } },
        },
        required: ["acked", "errors"],
      },
    },
    snooze: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          itemID: { type: "string" },
        },
        required: ["sessionID", "itemID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
    dismiss: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          itemID: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sessionID", "itemID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
    sendChat: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          itemID: { type: "string" },
          text: { type: "string" },
          explainSimply: { type: "boolean" },
        },
        required: ["sessionID", "itemID", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          messageID: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
    },
    retryChat: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
        },
        required: ["sessionID", "messageID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
    cancelChat: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          itemID: { type: "string" },
          messageID: { type: "string" },
        },
        required: ["sessionID", "itemID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
    undoClose: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          reason: { type: "string" },
          itemID: { type: "string" },
          title: { type: "string" },
          urgency: { type: "string" },
          kind: { type: "string" },
        },
        required: ["sessionID", "reason"],
      },
    },
  },
})
