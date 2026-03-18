import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Minimatch } from "minimatch"

export const READ_LIMIT = 500
export const FILE_LIMIT = 100
export const GREP_LIMIT = 50
export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "bin",
  "obj",
  ".idea",
  ".vscode",
  ".zig-cache",
  "zig-out",
  ".coverage",
  "coverage",
  "tmp",
  "temp",
  ".cache",
  "cache",
  "logs",
  ".venv",
  "venv",
  "env",
]
export const SYSTEM_IGNORES = ["/dev", "/proc", "/sys", "/run", "/var/run", "/private/var/run", "/Volumes"]
export const BINARY_EXT = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
])

export type Item = {
  path: string
  dir: boolean
}

export type WalkOptions = {
  ignore?: string[]
  include?: string[]
  exclude?: string[]
  recursive?: boolean
  type?: "all" | "files" | "directories"
  sandboxBaseDir?: string
}

export const IGNORE_PATHS_ENV = "LMS_FILESYSTEM_IGNORE_PATHS"

export class PathOutsideBaseError extends Error {
  filePath: string

  constructor(filePath: string) {
    super(`Path is outside the configured sandbox base directory: ${filePath}`)
    this.name = "PathOutsideBaseError"
    this.filePath = filePath
  }
}

export const expandHome = (input: string) => {
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  return input
}

export const resolvePath = (base: string, input?: string) => {
  const full = path.resolve(base, expandHome(input || "."))
  if (!withinBase(base, full)) {
    throw new PathOutsideBaseError(full)
  }
  return full
}

export const relPath = (base: string, target: string) => path.relative(base, target).split(path.sep).join("/") || "."

const expandPattern = (pattern: string) => {
  if (pattern.includes("/")) return [pattern]
  return [pattern, `**/${pattern}`]
}

export const compile = (patterns?: string[]) =>
  (patterns || []).flatMap((item) => expandPattern(item).map((pattern) => new Minimatch(pattern, { dot: true, nocase: false })))

export const defaultIgnoreList = () => {
  const raw = process.env[IGNORE_PATHS_ENV]
  if (raw === undefined) return DEFAULT_IGNORES
  if (raw.length === 0) return []
  return raw.split(";").map((item) => item.trim()).filter((item) => item.length > 0)
}

export const matchesPattern = (rel: string, matchers: Minimatch[]) => matchers.some((item) => item.match(rel))

export const ignored = (rel: string, matchers: Minimatch[], defaults = defaultIgnoreList(), defaultMatchers = compile(defaults)) => {
  const parts = rel.split("/")
  if (parts.some((part) => defaults.includes(part))) return true
  if (matchesPattern(rel, defaultMatchers)) return true
  if (matchesPattern(rel, matchers)) return true
  return false
}

export const isSystemPath = (file: string) =>
  SYSTEM_IGNORES.some((item) => file === item || file.startsWith(item + "/"))

export const blocked = (file: string, base: string) => {
  if (base !== "/" && !isSystemPath(base)) return false
  return isSystemPath(file)
}

export const withinBase = (base: string, target: string) => {
  const rel = path.relative(base, target)
  return rel === "" || (!(rel === ".." || rel.startsWith(`..${path.sep}`)) && !path.isAbsolute(rel))
}

export const walk = async (base: string, realBase: string, opts?: WalkOptions) => {
  const { inspectTraversalRoot, inspectNestedEntry } = await import("./boundary")

  const out: Item[] = []
  const skip = compile(opts?.ignore)
  const include = compile(opts?.include)
  const exclude = compile(opts?.exclude)
  const defaults = defaultIgnoreList()
  const defaultMatchers = compile(defaults)
  const recursive = opts?.recursive ?? true
  const type = opts?.type ?? "all"
  const sandboxBase = opts?.sandboxBaseDir ?? base
  const rootCheck = await inspectTraversalRoot(sandboxBase, base)
  if (!rootCheck.ok) {
    throw new Error(rootCheck.details ?? rootCheck.kind)
  }

  const visit = async (dir: string) => {
    if (blocked(dir, base)) return
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    items.sort((a, b) => a.name.localeCompare(b.name))

    for (const item of items) {
      const full = path.join(dir, item.name)
      const nested = await inspectNestedEntry(realBase, full, "any")
      if (!nested.ok || !nested.stat) continue
      if (blocked(full, base)) continue

      const rel = relPath(base, full)
      if (ignored(rel, skip, defaults, defaultMatchers)) continue
      if (matchesPattern(rel, exclude)) continue

      if (nested.stat.isDirectory()) {
        if (type !== "files" && (include.length === 0 || matchesPattern(rel, include))) out.push({ path: full, dir: true })
        if (recursive) await visit(full)
        continue
      }

      if (!nested.stat.isFile()) continue
      if (include.length > 0 && !matchesPattern(rel, include)) continue
      if (type !== "directories") out.push({ path: full, dir: false })
    }
  }

  await visit(base)
  return out
}

export const binary = async (file: string) => {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return true
  const stat = await fs.stat(file)
  if (stat.size === 0) return false
  const fd = await fs.open(file, "r")
  try {
    const size = Math.min(4096, stat.size)
    const buf = Buffer.alloc(size)
    const res = await fd.read(buf, 0, size, 0)
    if (res.bytesRead === 0) return false
    let count = 0
    for (let i = 0; i < res.bytesRead; i++) {
      if (buf[i] === 0) return true
      if (buf[i] < 9 || (buf[i] > 13 && buf[i] < 32)) count += 1
    }
    return count / res.bytesRead > 0.3
  } finally {
    await fd.close()
  }
}

export const formatTree = (base: string, items: Item[]) => {
  const dirs = new Set<string>(["."])
  const byDir = new Map<string, string[]>()
  for (const item of items) {
    const rel = relPath(base, item.path)
    const dir = path.dirname(rel)
    const parts = dir === "." ? [] : dir.split("/")
    for (let i = 0; i <= parts.length; i++) {
      dirs.add(i === 0 ? "." : parts.slice(0, i).join("/"))
    }
    if (!item.dir) {
      const key = dir === "" ? "." : dir
      byDir.set(key, [...(byDir.get(key) || []), path.basename(rel)])
      continue
    }
    dirs.add(rel)
  }

  const render = (dir: string, depth: number): string[] => {
    const out: string[] = []
    if (depth > 0) out.push(`${"  ".repeat(depth)}${path.basename(dir)}/`)
    const kids = [...dirs].filter((item) => item !== dir && path.dirname(item) === dir).sort((a, b) => a.localeCompare(b))
    for (const kid of kids) out.push(...render(kid, depth + 1))
    const indent = "  ".repeat(depth + 1)
    for (const file of (byDir.get(dir) || []).sort((a, b) => a.localeCompare(b))) out.push(`${indent}${file}`)
    return out
  }

  return [`${base}/`, ...render(".", 0)].join("\n")
}
