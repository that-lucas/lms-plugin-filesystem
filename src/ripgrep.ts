import { formatError } from "./errors"
import { resolveExecutable, runSubprocess } from "./subprocess"
import { blocked, compile, defaultIgnoreList, ignored, matchesPattern, relPath } from "./utils"

export const RIPGREP_TIMEOUT_MS = 60_000

type TextValue = {
  text?: string
  bytes?: string
}

type RipgrepEvent = {
  type?: string
  data?: {
    path?: TextValue
    lines?: TextValue
    line_number?: number | null
  }
}

export type RipgrepMatch = {
  path: string
  line: number
  text: string
}

export const isErrorResult = (value: RipgrepMatch[] | string): value is string => typeof value === "string"

const decodeText = (value?: TextValue) => {
  if (!value) return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8")
  return ""
}

const trimLineEnding = (line: string) => line.replace(/\r?\n$/, "")

export async function grepWithRipgrep({
  baseDir,
  dir,
  pattern,
  include,
  exclude,
}: {
  baseDir: string
  dir: string
  pattern: string
  include?: string[]
  exclude?: string[]
}): Promise<RipgrepMatch[] | string> {
  if (blocked(dir, baseDir)) return []

  const executable = await resolveExecutable("rg")
  if (!executable) {
    return formatError("filesystem_error", "Filesystem operation failed", [["details", "ripgrep executable not found in PATH"]])
  }

  const result = await runSubprocess({
    command: executable,
    args: ["--json", "--engine", "auto", "--hidden", "--no-ignore", "--no-messages", "--sortr", "modified", pattern, dir],
    baseDir,
    cwd: dir,
    timeoutMs: RIPGREP_TIMEOUT_MS,
    maxOutputBytes: 8 * 1024 * 1024,
  })

  if (result.spawnError) {
    return formatError("filesystem_error", "Filesystem operation failed", [["details", result.spawnError]])
  }
  if (result.timedOut) {
    return formatError("filesystem_error", "Filesystem operation failed", [["details", "ripgrep timed out"]])
  }
  if (result.truncated) {
    return formatError("filesystem_error", "Filesystem operation failed", [["details", "ripgrep output exceeded limit"]])
  }
  if (result.exitCode === 2) {
    return formatError("invalid_pattern", "Invalid regular expression", [["pattern", pattern], ["details", result.stderr || "ripgrep rejected the pattern"]])
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return formatError("filesystem_error", "Filesystem operation failed", [["details", result.stderr || `ripgrep exited with code ${result.exitCode}`]])
  }

  const includeMatchers = compile(include)
  const excludeMatchers = compile(exclude)
  const defaults = defaultIgnoreList()
  const defaultMatchers = compile(defaults)
  const matches: RipgrepMatch[] = []

  for (const rawLine of result.stdout.split(/\r?\n/)) {
    if (rawLine.length === 0) continue

    let event: RipgrepEvent
    try {
      event = JSON.parse(rawLine)
    } catch (error) {
      return formatError("filesystem_error", "Filesystem operation failed", [["details", error instanceof Error ? error.message : String(error)]])
    }

    if (event.type !== "match") continue

    const filePath = decodeText(event.data?.path)
    const rel = relPath(dir, filePath)
    if (ignored(rel, [], defaults, defaultMatchers)) continue
    if (matchesPattern(rel, excludeMatchers)) continue
    if (includeMatchers.length > 0 && !matchesPattern(rel, includeMatchers)) continue

    matches.push({
      path: filePath,
      line: typeof event.data?.line_number === "number" ? event.data.line_number : 1,
      text: trimLineEnding(decodeText(event.data?.lines)),
    })
  }

  return matches
}
