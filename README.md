# opencode-attention

An attention filter, decision desk, and isolated read-only **DISCUSS** side-chat plugin for **OpenCode V2** (Server + TUI + Desktop GUI).

In long or autonomous sessions, routine tool output buries the 5% of things that genuinely need human judgment, approval, action, or acknowledgment. `opencode-attention` pulls those items into a dedicated, non-blocking side panel — while letting the agent keep working on independent tasks and giving you a safe read-only partner to verify facts before deciding.

## Features

- **Four structured item kinds + urgency triage** (`blocking` → `normal` → `low`, then oldest-first):
  - `decision` — tradeoffs/choices with an explicit recommended option and optional default while waiting.
  - `approval` — destructive, external, or irreversible gates (`reversible: false`, highlighted impact, risky `(!)` markers).
  - `action` — steps only you can perform (browser login, manual check, secret placement).
  - `ack` — important FYIs/caveats that must be explicitly acknowledged.
- **Truly silent acknowledgments:** Clicking or pressing `a` on a plain `ack` item records it in `answers-log.jsonl` and injects it into the session's next turn context without enqueuing a prompt or waking the agent. Typing a comment/override or discussing first wakes and steers the session normally.
- **Native tools + live open-queue awareness:** Exposes `attention_post`, `attention_update`, `attention_withdraw`, and `attention_list`, and injects currently open and silently acknowledged items into model context so the agent avoids duplicates and withdraws moot items.
- **Subagent rollup & cross-session awareness:** Items posted by subagents automatically surface in the root session's panel (tagged with the subagent) and route answers back to the originating session. Cross-session badges let you jump straight to other sessions needing attention.
- **Idle Attention Catcher** (on by default): When a session goes idle without posting an item and no background work is running, a lightweight check inspects the final response for buried questions, approval requests, or critical caveats and surfaces an `[auto]` card you can answer, acknowledge, or dismiss.
- **Isolated read-only DISCUSS partner:**
  - One-key **`Explain simply` (`e`)** translates jargon-heavy cards into plain English after checking referenced files, commits, and issues.
  - Runs inside an isolated, archived scratch session (removed immediately after replying — never leaks into or wakes the main session) enforced by both session permissions and a strict read-only tool/shell/secret-file/Cypher guard.
  - **Quote-verified auto-close + 5s Undo:** When your own words in chat give a decision, the plugin verifies the closing quote verbatim against your messages and starts a 5-second countdown with `Undo` (`u`) before sending `[attention:<id>] <decision>` + `[PANE MODEL] RELEVANT CONTEXT` + the full attributed chat (`[OWNER]` lines are never truncated).
- **Fast triage ergonomics:** Focus view (`1`–`9`, `a`, `t`, `e`, `s` snooze, `d` details, `c` chat) + Inbox view (`i`) with urgency groups, `Batch-Ack` (`Shift+A`) for safe FYIs, auto-advance to next open item, and closed-item history.
- **Durable audit log:** Every answer and rollback is appended to `<queueDir>/answers-log.jsonl` (`0600`).

## Install

Add to `~/.config/opencode/opencode.json` (or `.opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-attention"]
}
```

Or install directly from GitHub:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:0x4nur4g/opencode-attention"]
}
```

## Configuration & Model Selection

All options are optional:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-attention",
      "options": {
        "queueDir": "~/.local/share/opencode/attention",
        "autoOpenPanel": true,
        "notifyOnArrival": true,
        "discuss": {
          "model": "openai/gpt-6-luna-fast#max",
          "maxTurns": 12,
          "timeoutMs": 180000
        },
        "idleCatcher": {
          "enabled": true,
          "model": "openai/gpt-6-luna-fast#low",
          "minChars": 120
        }
      }
    }
  ]
}
```

### How the model is chosen (for DISCUSS and Idle Attention Catcher)

Model specs use `"provider/model"` or `"provider/model#variant"`. When `discuss.model` or `idleCatcher.model` is not set, `opencode-attention` resolves automatically in this order:

1. Explicit `discuss.model` / `idleCatcher.model` in plugin `options`
2. Your configured `explore` agent model in OpenCode (already authenticated and tuned for fast read-only checks)
3. The current session's active model
4. OpenCode's default model

## Controls

### TUI (`./tui`)
- **`/attention`** (or `/attn`, or `<leader>d` / `ctrl+x d`): open/toggle the side panel.
- Inside the panel (when the DISCUSS input is not focused):
  - `1`–`9`: pick an option
  - `a`: silent Acknowledge (`ack` items)
  - `t`: custom answer / override comment (wakes agent)
  - `e`: Explain simply (read-only DISCUSS)
  - `s`: Snooze / defer to back of queue
  - `p` / `n`: Previous / Next open item
  - `i`: toggle Inbox / Focus view
  - `Shift+A`: Batch-Ack all safe `ack` items
  - `d`: toggle full details
  - `c`: focus DISCUSS chat input (`Esc` blurs back to hotkeys)
  - `u`: Undo pending chat close
  - `r`: Retry failed DISCUSS reply
  - `x`: Cancel in-flight DISCUSS run
  - `f`: toggle fullscreen

### Desktop GUI (`./gui-experimental`)
- Pinned **Attention** side panel tab + floating **ComposerPill** badge above the prompt whenever items are waiting.
- `/attention` or `mod+shift+a` toggles the panel.

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

## License

MIT
