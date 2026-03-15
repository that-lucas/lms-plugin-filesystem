import * as fs from "node:fs/promises"
import { Minimatch } from "minimatch"
import { formatError } from "./errors"
import { resolveExecutable, runSubprocess } from "./subprocess"
import { blocked, compile, defaultIgnoreList, ignored, matchesPattern, relPath, walk } from "./utils"

export const RIPGREP_TIMEOUT_MS = 60_000
export const RIPGREP_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

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

type RipgrepGlobOptions = {
  baseDir: string
  dir: string
  pattern: string
  type?: "files" | "directories" | "all"
  include?: string[]
  exclude?: string[]
}

type GlobEntry = {
  path: string
  time: number
}

export const isErrorResult = (value: RipgrepMatch[] | string): value is string => typeof value === "string"

const decodeText = (value?: TextValue) => {
  if (!value) return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8")
  return ""
}

const trimLineEnding = (line: string) => line.replace(/\r?\n$/, "")

const ripgrepError = (details: string) => formatError("filesystem_error", "Filesystem operation failed", [["details", details]])

async function runRipgrep(args: string[]) {
  const executable = await resolveExecutable("rg")
  if (!executable) return ripgrepError("ripgrep executable not found in PATH")

  const result = await runSubprocess({
    command: executable,
    args,
    baseDir: "/",
    cwd: "/",
    timeoutMs: RIPGREP_TIMEOUT_MS,
    maxOutputBytes: RIPGREP_MAX_OUTPUT_BYTES,
  })

  if (result.spawnError) return ripgrepError(result.spawnError)
  if (result.timedOut) return ripgrepError("ripgrep timed out")
  if (result.truncated) return ripgrepError("ripgrep output exceeded limit")

  return result
}

const sortEntries = (items: GlobEntry[]) => items.sort((a, b) => b.time - a.time)

const collectFileEntries = async (dir: string) => {
  const result = await runRipgrep(["--files", "--hidden", "--no-ignore", "--no-messages", "--sortr", "modified", dir])
  if (isErrorResult(result)) return result
  if (result.exitCode !== 0) return ripgrepError(result.stderr || `ripgrep exited with code ${result.exitCode}`)

  const out: GlobEntry[] = []
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const filePath = rawLine.trim()
    if (filePath.length === 0) continue
    const stat = await fs.lstat(filePath).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue
    out.push({ path: filePath, time: stat.mtime.getTime() })
  }
  return out
}

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

  const result = await runRipgrep(["--json", "--engine", "auto", "--hidden", "--no-ignore", "--no-messages", "--sortr", "modified", pattern, dir])
  if (isErrorResult(result)) return result
  if (result.exitCode === 2) {
    return formatError("invalid_pattern", "Invalid regular expression", [["pattern", pattern], ["details", result.stderr || "ripgrep rejected the pattern"]])
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) return ripgrepError(result.stderr || `ripgrep exited with code ${result.exitCode}`)

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

export async function globWithRipgrep({
  baseDir,
  dir,
  pattern,
  type,
  include,
  exclude,
}: RipgrepGlobOptions): Promise<string[] | string> {
  if (blocked(dir, baseDir)) return []

  const matcher = new Minimatch(pattern, { dot: true, nocase: true })
  const kind = type ?? "files"
  const includeMatchers = compile(include)
  const excludeMatchers = compile(exclude)
  const defaults = defaultIgnoreList()
  const defaultMatchers = compile(defaults)
  const entries: GlobEntry[] = []

  if (kind !== "directories") {
    const files = await collectFileEntries(dir)
    if (isErrorResult(files)) return files

    for (const file of files) {
      const rel = relPath(dir, file.path)
      if (ignored(rel, [], defaults, defaultMatchers)) continue
      if (matchesPattern(rel, excludeMatchers)) continue
      if (includeMatchers.length > 0 && !matchesPattern(rel, includeMatchers)) continue
      if (!matcher.match(rel)) continue
      entries.push(file)
    }
  }

  if (kind !== "files") {
    const dirs = await walk(dir, { recursive: true, type: "directories", include, exclude })
    const dirEntries = await Promise.all(
      dirs.map(async (item) => ({
        path: item.path,
        time: (await fs.stat(item.path)).mtime.getTime(),
      })),
    )

    for (const entry of dirEntries) {
      const rel = relPath(dir, entry.path)
      if (!matcher.match(rel)) continue
      entries.push(entry)
    }
  }

  return sortEntries(entries).map((entry) => entry.path)
}
