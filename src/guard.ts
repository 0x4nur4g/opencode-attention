import { realpathSync } from "node:fs"

// Strict read-only guard for the isolated DISCUSS side-chat (pure TypeScript, no subprocess overhead).

export const SECRET_PATH_RE =
  /(^|[/:])(\.env[^/]*|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.claude\.json|\.credentials[^/]*|id_[a-z0-9_]+|[^/]*\.(pem|key|p12|pfx|kdbx)|[^/]*secret[^/]*|[^/]*token[^/]*|[^/]*password[^/]*|Keychains)($|[/:])/i

export const READ_ONLY_BUILTIN_TOOLS = new Set(["read", "grep", "glob", "websearch", "webfetch", "shell"])

export const CODE_GRAPH_READ_TOOLS = new Set([
  "search_graph",
  "trace_path",
  "get_code_snippet",
  "query_graph",
  "get_architecture",
  "search_code",
  "get_file_outline",
  "get_graph_schema",
  "list_projects",
  "index_status",
  "check_index_coverage",
  "detect_changes",
  "compare_graphs",
])

export const CODE_GRAPH_WRITE_TOOLS = new Set([
  "index_repository",
  "delete_project",
  "manage_adr",
  "ingest_traces",
])

const MUTATING_CYPHER_RE =
  /\b(create|delete|set|merge|remove|drop|detach|call|load|copy|alter|install|attach)\b/i

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "shortlog",
  "describe",
  "rev-list",
  "for-each-ref",
  "cat-file",
  "merge-base",
  "name-rev",
  "show-ref",
  "cherry",
  "diff-tree",
  "grep",
])

const GIT_FORBIDDEN_FLAGS = [
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec",
  "--upload-pack",
  "--receive-pack",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config",
  "-c",
  "-C",
  "--filters",
  "--open-files-in-pager",
  "-O",
]

const GLAB_ALLOWED_SUBCOMMANDS = new Set([
  "mr view",
  "mr list",
  "mr diff",
  "issue view",
  "issue list",
  "ci status",
  "ci list",
  "repo view",
])

const GH_ALLOWED_SUBCOMMANDS = new Set([
  "pr view",
  "pr list",
  "pr diff",
  "pr checks",
  "issue view",
  "issue list",
  "run view",
  "run list",
  "repo view",
])

const SIMPLE_READ_COMMANDS = new Set([
  "ls",
  "wc",
  "stat",
  "head",
  "tail",
  "date",
  "pwd",
  "file",
  "jq",
  "cat",
  "sort",
  "uniq",
  "cut",
  "grep",
  "rg",
  "fd",
  "tr",
])

export type GuardDecision = { allow: true } | { allow: false; reason: string }

const allow = (): GuardDecision => ({ allow: true })
const deny = (reason: string): GuardDecision => ({ allow: false, reason })

/** Minimal POSIX-like shell tokenizer supporting single/double quotes and &&, ;, | operators. */
export function tokenizeShell(command: string): { ok: true; segments: string[][]; operators: string[] } | { ok: false; reason: string } {
  const cleaned = command.replaceAll(" 2>&1", "").replaceAll(" 2>/dev/null", "").trim()
  if (!cleaned) return { ok: false, reason: "empty command" }
  if (/[`<>\n\r$(){}\\]/.test(cleaned)) {
    return { ok: false, reason: "read-only chat refuses redirects, substitutions, subshells, and escapes" }
  }

  const tokens: Array<{ kind: "word" | "op"; value: string }> = []
  let i = 0
  while (i < cleaned.length) {
    const ch = cleaned[i]!
    if (ch === " " || ch === "\t") {
      i += 1
      continue
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      if (ch === "&" && cleaned[i + 1] === "&") {
        tokens.push({ kind: "op", value: "&&" })
        i += 2
        continue
      }
      if (ch === "|" && cleaned[i + 1] === "|") {
        return { ok: false, reason: "shell operator || is refused" }
      }
      if (ch === "&") {
        return { ok: false, reason: "background operator & is refused" }
      }
      tokens.push({ kind: "op", value: ch })
      i += 1
      continue
    }

    let word = ""
    while (i < cleaned.length) {
      const c = cleaned[i]!
      if (c === " " || c === "\t" || c === ";" || c === "|" || c === "&") break
      if (c === "'" || c === '"') {
        const quote = c
        i += 1
        let closed = false
        while (i < cleaned.length) {
          const qc = cleaned[i]!
          if (qc === quote) {
            i += 1
            closed = true
            break
          }
          word += qc
          i += 1
        }
        if (!closed) return { ok: false, reason: "unterminated quote in command" }
      } else {
        word += c
        i += 1
      }
    }
    tokens.push({ kind: "word", value: word })
  }

  const segments: string[][] = [[]]
  const operators: string[] = []
  for (const tok of tokens) {
    if (tok.kind === "op") {
      operators.push(tok.value)
      segments.push([])
    } else {
      segments[segments.length - 1]!.push(tok.value)
    }
  }
  if (segments.some((s) => s.length === 0)) return { ok: false, reason: "malformed shell command" }
  if (segments.length > 6) return { ok: false, reason: "too many chained commands (max 6)" }
  return { ok: true, segments, operators }
}

function checkGit(argv: string[], allowedWorktrees: readonly string[]): GuardDecision {
  let rest = argv.slice(1)
  if (rest.length >= 2 && rest[0] === "-C") {
    const rawTarget = rest[1]!
    let resolved = rawTarget
    try {
      resolved = realpathSync(rawTarget)
    } catch {
      return deny("git -C target does not exist")
    }
    const ok = allowedWorktrees.some((wt) => resolved === wt || resolved.startsWith(`${wt}/`))
    if (!ok) return deny("git -C is allowed only for a worktree of this repository")
    rest = rest.slice(2)
  }
  if (rest.length < 1) return deny("only read-only git commands are allowed")
  const sub = rest[0]!
  const args = rest.slice(1)

  if (args.some((a) => GIT_FORBIDDEN_FLAGS.some((flag) => a === flag || a.startsWith(`${flag}=`) || (flag.startsWith("--") && a.startsWith(flag))))) {
    return deny("this git option is refused in read-only chat")
  }
  if (sub === "branch") {
    const mutatingLong = new Set([
      "--delete", "--move", "--copy", "--force", "--set-upstream-to",
      "--unset-upstream", "--edit-description", "--track", "--no-track", "--create-reflog",
    ])
    const listingFlags = new Set([
      "-a", "-r", "-v", "-vv", "-l", "--all", "--remotes", "--verbose",
      "--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
    ])
    if (args.some((a) => mutatingLong.has(a.split("=")[0] ?? ""))) return deny("git branch mutation is refused")
    if (args.some((a) => a.startsWith("-") && !a.startsWith("--") && /[dDmMcCfut]/.test(a))) {
      return deny("git branch mutation flag is refused")
    }
    if (!args.some((a) => listingFlags.has(a.split("=")[0] ?? ""))) {
      return deny("git branch is allowed only to list branches (--list, --contains, --merged, etc.)")
    }
  } else if (sub === "tag") {
    const mutating = new Set(["-d", "-a", "-s", "-f", "-m", "-F", "-u", "--delete", "--annotate", "--sign", "--force", "--message", "--file", "--local-user"])
    if (args.some((a) => mutating.has(a.split("=")[0] ?? ""))) return deny("git tag mutation is refused")
    if (!args.some((a) => a === "-l" || a === "--list")) return deny("git tag is allowed only with --list")
  } else if (sub === "remote") {
    if (!(args.length === 0 || (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")))) {
      return deny("git remote is allowed only as git remote or git remote -v")
    }
  } else if (sub === "worktree") {
    if (args[0] !== "list") return deny("git worktree is allowed only as git worktree list")
  } else if (sub === "stash") {
    if (args[0] !== "list" && args[0] !== "show") return deny("git stash is allowed only as list or show")
  } else if (sub === "reflog") {
    if (args[0] === "expire" || args[0] === "delete") return deny("git reflog expire/delete is refused")
  } else if (!GIT_READ_SUBCOMMANDS.has(sub)) {
    return deny(`git ${sub} is not read-only in this chat`)
  }

  if (args.some((a) => SECRET_PATH_RE.test(a))) return deny("secret files are refused")
  return allow()
}

function checkForgeCli(cli: "glab" | "gh", argv: string[]): GuardDecision {
  const pair = `${argv[1] ?? ""} ${argv[2] ?? ""}`
  const allowed = cli === "glab" ? GLAB_ALLOWED_SUBCOMMANDS : GH_ALLOWED_SUBCOMMANDS
  if (!allowed.has(pair)) return deny(`${cli} ${pair.trim()} is not read-only in this chat`)
  const rest = argv.slice(3)
  if (rest.some((a) => a === "-w" || a === "--web" || a === "--comment" || a === "--message" || a === "-m")) {
    return deny(`this ${cli} option is refused`)
  }
  if (rest.some((a) => SECRET_PATH_RE.test(a))) return deny("secret files are refused")
  return allow()
}

function checkSimpleCommand(argv: string[], piped: boolean): GuardDecision {
  const name = argv[0]!
  const rest = argv.slice(1)
  if ((name === "uniq" || name === "tr") && !piped) return deny(`${name} is allowed only after a pipe`)
  if (name === "uniq" && rest.some((a) => !a.startsWith("-"))) return deny("uniq takes no file arguments here")
  if (name === "sort" && rest.some((a) => a.startsWith("--output") || /^-[A-Za-z]*o/.test(a))) {
    return deny("sort output to file is refused")
  }
  if (name === "tail" && rest.some((a) => a === "-f" || a === "-F" || a.startsWith("--follow"))) {
    return deny("tail follow is refused")
  }
  if (name === "date" && rest.some((a) => a === "-s" || a.startsWith("--set"))) {
    return deny("setting the date is refused")
  }
  if (name === "file" && rest.some((a) => a === "-C" || a === "--compile")) {
    return deny("file --compile is refused")
  }
  if (name === "fd" && rest.some((a) => a === "-x" || a === "-X" || a === "--exec" || a === "--exec-batch")) {
    return deny("fd --exec is refused")
  }
  if (rest.some((a) => SECRET_PATH_RE.test(a))) return deny("secret files are refused")
  return allow()
}

export function checkReadOnlyShell(command: string, allowedWorktrees: readonly string[] = []): GuardDecision {
  const parsed = tokenizeShell(command)
  if (!parsed.ok) return deny(parsed.reason)
  for (let i = 0; i < parsed.segments.length; i += 1) {
    const argv = parsed.segments[i]!
    const head = argv[0]!
    const piped = i > 0 && parsed.operators[i - 1] === "|"
    let res: GuardDecision
    if (head === "git") res = checkGit(argv, allowedWorktrees)
    else if (head === "glab" || head === "gh") res = checkForgeCli(head, argv)
    else if (SIMPLE_READ_COMMANDS.has(head)) res = checkSimpleCommand(argv, piped)
    else res = deny(`only read-only git, glab, gh, and safe read utilities are allowed (refused: ${head})`)
    if (!res.allow) return res
  }
  return allow()
}

const CODE_GRAPH_PREFIXES = ["mcp__codebase-memory-mcp__", "codebase-memory-mcp_", "codebase_memory_mcp_"]

function extractCodeGraphTool(name: string): string | undefined {
  for (const prefix of CODE_GRAPH_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return undefined
}

export function checkReadOnlyTool(
  toolName: string,
  rawInput: unknown,
  allowedWorktrees: readonly string[] = [],
): GuardDecision {
  const input = typeof rawInput === "object" && rawInput !== null ? (rawInput as Record<string, unknown>) : {}
  const cgTool = extractCodeGraphTool(toolName)
  if (cgTool !== undefined) {
    if (CODE_GRAPH_WRITE_TOOLS.has(cgTool) || !CODE_GRAPH_READ_TOOLS.has(cgTool)) {
      return deny(`code graph tool "${cgTool}" is not read-only`)
    }
    if (cgTool === "query_graph" && MUTATING_CYPHER_RE.test(String(input.query ?? ""))) {
      return deny("mutating Cypher graph query is refused")
    }
    return allow()
  }

  if (!READ_ONLY_BUILTIN_TOOLS.has(toolName)) {
    return deny(`read-only DISCUSS chat refuses tool "${toolName}"`)
  }

  if (toolName === "read" || toolName === "grep" || toolName === "glob") {
    for (const key of ["path", "file_path", "filePath", "pattern", "include", "glob"]) {
      const value = input[key]
      if (typeof value === "string" && SECRET_PATH_RE.test(value)) {
        return deny("secret files are refused in read-only DISCUSS chat")
      }
    }
    return allow()
  }

  if (toolName === "shell") {
    const cmd = typeof input.command === "string" ? input.command : ""
    return checkReadOnlyShell(cmd, allowedWorktrees)
  }

  return allow()
}

export function isToolAllowedInDiscussSchema(toolName: string): boolean {
  if (READ_ONLY_BUILTIN_TOOLS.has(toolName)) return true
  const cg = extractCodeGraphTool(toolName)
  return cg !== undefined && CODE_GRAPH_READ_TOOLS.has(cg)
}
