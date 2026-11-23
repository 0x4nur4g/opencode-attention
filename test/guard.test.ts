import { describe, expect, test } from "bun:test"
import { checkReadOnlyShell, checkReadOnlyTool } from "../src/guard.js"

describe("checkReadOnlyTool", () => {
  test("allows read-only built-ins on normal files and queries", () => {
    const cases: Array<[string, unknown]> = [
      ["read", { path: "src/queue.ts" }],
      ["grep", { pattern: "validateNewItem", path: "src" }],
      ["glob", { pattern: "src/**/*.ts" }],
      ["websearch", { query: "OpenCode plugin API" }],
      ["webfetch", { url: "https://example.com/docs" }],
    ]

    for (const [tool, input] of cases) {
      expect(checkReadOnlyTool(tool, input).allow).toBe(true)
    }
  })

  test("blocks secret paths from file-inspection built-ins", () => {
    const secretPaths = [
      ".env",
      ".env.local",
      "~/.ssh/id_rsa",
      ".aws/credentials",
      "prod.pem",
      "my-secret.txt",
      "auth-token.json",
      "db_password.yml",
    ]

    for (const path of secretPaths) {
      expect(checkReadOnlyTool("read", { path }).allow).toBe(false)
    }
  })

  test("blocks tools that can mutate state or send work to the main session", () => {
    for (const tool of ["write", "edit", "apply_patch", "subagent", "attention_post"]) {
      expect(checkReadOnlyTool(tool, {}).allow).toBe(false)
    }
  })

  test("allows read-only code graph tools and queries", () => {
    expect(checkReadOnlyTool("mcp__codebase-memory-mcp__search_graph", {}).allow).toBe(true)
    expect(checkReadOnlyTool("codebase-memory-mcp_trace_path", {}).allow).toBe(true)
    expect(
      checkReadOnlyTool("codebase_memory_mcp_query_graph", {
        query: "MATCH (n) RETURN n",
      }).allow,
    ).toBe(true)
  })

  test("blocks code graph tools that mutate the index", () => {
    for (const tool of [
      "mcp__codebase-memory-mcp__index_repository",
      "codebase-memory-mcp_delete_project",
    ]) {
      expect(checkReadOnlyTool(tool, {}).allow).toBe(false)
    }
  })

  test("blocks mutating Cypher in query_graph calls", () => {
    for (const query of [
      "MATCH (n) DELETE n",
      "CREATE (n:Thing)",
      "MERGE (n:Thing)",
      "MATCH (n) SET n.name = 'changed'",
      "DROP GRAPH example",
    ]) {
      expect(
        checkReadOnlyTool("mcp__codebase-memory-mcp__query_graph", { query }).allow,
      ).toBe(false)
    }
  })
})

describe("checkReadOnlyShell", () => {
  test("allows the requested read-only shell commands and pipelines", () => {
    const commands = [
      "git status",
      "git log --oneline -n 10 | head -5",
      "git branch --list",
      "git tag --list",
      "git remote -v",
      "git worktree list",
      "git stash list",
      "glab mr view 42",
      "gh pr checks 12",
      "ls -la && wc -l foo.ts",
      "cat foo.ts | sort | uniq",
    ]

    for (const command of commands) {
      expect(checkReadOnlyShell(command).allow).toBe(true)
    }
  })

  test("blocks redirects, substitutions, subshells, unsafe operators, and long chains", () => {
    const commands = [
      "cat foo.ts > out.txt",
      "cat < foo.ts",
      "cat `pwd`",
      "cat $(pwd)",
      "cat (pwd)",
      "cat foo.ts || cat bar.ts",
      "cat foo.ts &",
      "ls && ls && ls && ls && ls && ls && ls",
    ]

    for (const command of commands) {
      expect(checkReadOnlyShell(command).allow).toBe(false)
    }
  })

  test("blocks mutating git commands and unsafe git options", () => {
    const commands = [
      "git checkout main",
      "git commit -m message",
      "git push",
      "git branch -D foo",
      "git tag -d v1",
      "git remote add origin https://example.com/repo.git",
      "git worktree remove ../other",
      "git stash drop",
      "git reflog expire --expire=now --all",
      "git log --output=/tmp/x",
      "git -C /etc status",
    ]

    for (const command of commands) {
      expect(checkReadOnlyShell(command).allow).toBe(false)
    }
  })

  test("blocks forge options that can add comments", () => {
    expect(checkReadOnlyShell("glab mr view 1 --comment hi").allow).toBe(false)
  })

  test("blocks unsafe utilities, file-output modes, and commands that name secrets", () => {
    const commands = [
      "rm -rf .",
      "curl https://example.com",
      "sort -o out",
      "tail -f log.txt",
      "fd -x rm",
      "uniq file.txt",
      "tr a b",
      "cat .env",
      "ls ~/.ssh",
    ]

    for (const command of commands) {
      expect(checkReadOnlyShell(command).allow).toBe(false)
    }
  })
})
