import type { Stats } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { PathOutsideBaseError, expandHome, resolvePath, withinBase } from "./utils"

let realpathImpl: typeof fs.realpath = fs.realpath.bind(fs)

export type BoundaryFailureKind =
  | "outside_base"
  | "not_found"
  | "wrong_type"
  | "symlink_root"
  | "broken_link"
  | "symlink_loop"
  | "canonicalization_failed"
  | "sandbox_base_dir_invalid"

export type BoundaryExpectedKind = "file" | "directory" | "any"

export type BoundarySuccess = {
  ok: true
  requestedPath: string
  resolvedPath: string
  realBase: string
  realPath?: string
  stat?: Stats
}

export type BoundaryFailure = {
  ok: false
  kind: BoundaryFailureKind
  requestedPath: string
  resolvedPath: string
  expected: BoundaryExpectedKind
  details?: string
  actual?: "file" | "directory" | "other"
}

export type BoundaryResult = BoundarySuccess | BoundaryFailure

type NativeFsError = NodeJS.ErrnoException & Error

type RootInspection =
  | BoundaryFailure
  | {
      ok: true
      targetExists: boolean
      targetStat?: Stats
      nearestExistingPath: string
      nearestExistingStat: Stats
    }

const formatDetails = (error: unknown) => error instanceof Error ? error.message : String(error)

const actualKind = (stat: Stats): "file" | "directory" | "other" => {
  if (stat.isFile()) return "file"
  if (stat.isDirectory()) return "directory"
  return "other"
}

const boundarySuccess = (
  requestedPath: string,
  resolvedPath: string,
  realBase: string,
  realPath?: string,
  stat?: Stats,
): BoundarySuccess => ({
  ok: true,
  requestedPath,
  resolvedPath,
  realBase,
  realPath,
  stat,
})

const boundaryFailure = (
  kind: BoundaryFailureKind,
  requestedPath: string,
  resolvedPath: string,
  expected: BoundaryExpectedKind,
  details?: string,
  actual?: "file" | "directory" | "other",
): BoundaryFailure => ({
  ok: false,
  kind,
  requestedPath,
  resolvedPath,
  expected,
  details,
  actual,
})

const realpathWithError = async (target: string) => {
  try {
    return { ok: true as const, value: await realpathImpl(target) }
  } catch (error) {
    return { ok: false as const, error: error as NativeFsError }
  }
}

export const setBoundaryRealpathForTests = (impl?: typeof fs.realpath) => {
  realpathImpl = impl ?? fs.realpath.bind(fs)
}

const classifySymlink = async (
  requestedPath: string,
  resolvedPath: string,
  segment: string,
  expected: BoundaryExpectedKind,
): Promise<BoundaryFailure> => {
  const real = await realpathWithError(segment)
  if (real.ok) {
    return boundaryFailure("symlink_root", requestedPath, resolvedPath, expected, `Path contains a symbolic link: ${segment}`)
  }
  if (real.error.code === "ENOENT") {
    return boundaryFailure("broken_link", requestedPath, resolvedPath, expected, `Path contains a broken symbolic link: ${segment}`)
  }
  if (real.error.code === "ELOOP") {
    return boundaryFailure("symlink_loop", requestedPath, resolvedPath, expected, `Path contains a symbolic link loop: ${segment}`)
  }
  return boundaryFailure(
    "canonicalization_failed",
    requestedPath,
    resolvedPath,
    expected,
    `Failed to canonicalize path ${segment}: ${formatDetails(real.error)}`,
  )
}

const splitRelativeSegments = (base: string, target: string) => {
  const rel = path.relative(base, target)
  if (rel === "") return []
  return rel.split(path.sep).filter((segment) => segment.length > 0)
}

const inspectRootPath = async (
  base: string,
  target: string,
  expected: BoundaryExpectedKind,
): Promise<RootInspection> => {
  if (!withinBase(base, target)) {
    return boundaryFailure("outside_base", target, target, expected)
  }

  let current = base
  let currentStat: Stats
  try {
    currentStat = await fs.lstat(base)
  } catch (error) {
    const nativeError = error as NativeFsError
    return boundaryFailure(
      "canonicalization_failed",
      target,
      target,
      expected,
      `Failed to inspect path ${base}: ${formatDetails(nativeError)}`,
    )
  }
  if (currentStat.isSymbolicLink()) {
    return await classifySymlink(target, target, base, expected)
  }

  const segments = splitRelativeSegments(base, target)
  if (segments.length === 0) {
    return {
      ok: true,
      targetExists: true,
      targetStat: currentStat,
      nearestExistingPath: base,
      nearestExistingStat: currentStat,
    }
  }

  for (const [index, segment] of segments.entries()) {
    const nextPath = path.join(current, segment)
    try {
      const stat = await fs.lstat(nextPath)
      if (stat.isSymbolicLink()) {
        return await classifySymlink(target, target, nextPath, expected)
      }
      current = nextPath
      currentStat = stat
      if (index === segments.length - 1) {
        return {
          ok: true,
          targetExists: true,
          targetStat: stat,
          nearestExistingPath: nextPath,
          nearestExistingStat: stat,
        }
      }
    } catch (error) {
      const nativeError = error as NativeFsError
      if (nativeError.code === "ENOENT") {
        return {
          ok: true,
          targetExists: false,
          nearestExistingPath: current,
          nearestExistingStat: currentStat,
        }
      }
      return boundaryFailure(
        "canonicalization_failed",
        target,
        target,
        expected,
        `Failed to inspect path ${nextPath}: ${formatDetails(nativeError)}`,
      )
    }
  }

  return {
    ok: true,
    targetExists: true,
    targetStat: currentStat,
    nearestExistingPath: current,
    nearestExistingStat: currentStat,
  }
}

const canonicalizeRequired = async (
  target: string,
  requestedPath: string,
  resolvedPath: string,
  expected: BoundaryExpectedKind,
): Promise<{ ok: true; value: string } | BoundaryFailure> => {
  const real = await realpathWithError(target)
  if (real.ok) return { ok: true, value: real.value }
  if (real.error.code === "ENOENT") {
    return boundaryFailure("not_found", requestedPath, resolvedPath, expected)
  }
  if (real.error.code === "ELOOP") {
    return boundaryFailure("symlink_loop", requestedPath, resolvedPath, expected, `Path contains a symbolic link loop: ${target}`)
  }
  return boundaryFailure(
    "canonicalization_failed",
    requestedPath,
    resolvedPath,
    expected,
    `Failed to canonicalize path ${target}: ${formatDetails(real.error)}`,
  )
}

export async function resolveConfiguredSandboxBaseDir(input?: string): Promise<BoundaryResult> {
  const requestedPath = input?.trim() || "~"
  const resolvedPath = path.resolve(expandHome(requestedPath))

  try {
    const stat = await fs.lstat(resolvedPath)
    if (stat.isSymbolicLink()) {
      return boundaryFailure("sandbox_base_dir_invalid", requestedPath, resolvedPath, "directory", `Sandbox base directory must not be a symbolic link: ${resolvedPath}`)
    }
    if (!stat.isDirectory()) {
      return boundaryFailure("sandbox_base_dir_invalid", requestedPath, resolvedPath, "directory", `Sandbox base directory is not a directory: ${resolvedPath}`)
    }

    const realBase = await realpathWithError(resolvedPath)
    if (!realBase.ok) {
      return boundaryFailure(
        "sandbox_base_dir_invalid",
        requestedPath,
        resolvedPath,
        "directory",
        `Failed to canonicalize sandbox base directory ${resolvedPath}: ${formatDetails(realBase.error)}`,
      )
    }

    return boundarySuccess(requestedPath, resolvedPath, realBase.value, realBase.value, stat)
  } catch (error) {
    const nativeError = error as NativeFsError
    if (nativeError.code === "ENOENT") {
      return boundaryFailure("sandbox_base_dir_invalid", requestedPath, resolvedPath, "directory", `Sandbox base directory does not exist: ${resolvedPath}`)
    }
    return boundaryFailure(
      "sandbox_base_dir_invalid",
      requestedPath,
      resolvedPath,
      "directory",
      `Failed to inspect sandbox base directory ${resolvedPath}: ${formatDetails(nativeError)}`,
    )
  }
}

export function resolveUserPath(base: string, input?: string): BoundaryResult {
  try {
    const resolvedPath = input && path.isAbsolute(input)
      ? resolvePath(base, path.relative(base, input))
      : resolvePath(base, input)
    return boundarySuccess(input || ".", resolvedPath, base)
  } catch (error) {
    if (error instanceof PathOutsideBaseError) {
      return boundaryFailure("outside_base", input || ".", error.filePath, "any")
    }
    return boundaryFailure("canonicalization_failed", input || ".", path.resolve(base, "."), "any", formatDetails(error))
  }
}

export async function inspectExistingPath(base: string, target: string, expected: "file" | "directory"): Promise<BoundaryResult> {
  const root = await inspectRootPath(base, target, expected)
  if (!root.ok) return root
  if (!root.targetExists) return boundaryFailure("not_found", target, target, expected)

  const realBase = await canonicalizeRequired(base, target, target, expected)
  if (!realBase.ok) return realBase
  const realTarget = await canonicalizeRequired(target, target, target, expected)
  if (!realTarget.ok) return realTarget
  if (!withinBase(realBase.value, realTarget.value)) {
    return boundaryFailure("outside_base", target, target, expected)
  }

  const stat = root.targetStat ?? root.nearestExistingStat
  if (expected === "file" && !stat.isFile()) {
    return boundaryFailure("wrong_type", target, target, expected, undefined, actualKind(stat))
  }
  if (expected === "directory" && !stat.isDirectory()) {
    return boundaryFailure("wrong_type", target, target, expected, undefined, actualKind(stat))
  }

  return boundarySuccess(target, target, realBase.value, realTarget.value, stat)
}

export async function inspectCreateTarget(base: string, target: string, expected: "file" | "directory"): Promise<BoundaryResult> {
  const root = await inspectRootPath(base, target, expected)
  if (!root.ok) return root

  const realBase = await canonicalizeRequired(base, target, target, expected)
  if (!realBase.ok) return realBase
  const canonicalTarget = root.targetExists ? target : root.nearestExistingPath
  const realTarget = await canonicalizeRequired(canonicalTarget, target, target, expected)
  if (!realTarget.ok) return realTarget
  if (!withinBase(realBase.value, realTarget.value)) {
    return boundaryFailure("outside_base", target, target, expected)
  }

  const stat = root.targetExists ? root.targetStat : root.nearestExistingStat
  return boundarySuccess(target, target, realBase.value, realTarget.value, stat)
}

export async function inspectTraversalRoot(base: string, target: string): Promise<BoundaryResult> {
  return await inspectExistingPath(base, target, "directory")
}

export async function inspectNestedEntry(
  baseRealPath: string,
  entryPath: string,
  expected: "file" | "directory" | "any",
): Promise<BoundaryResult> {
  try {
    const stat = await fs.lstat(entryPath)
    if (stat.isSymbolicLink()) {
      return await classifySymlink(entryPath, entryPath, entryPath, expected)
    }

    const realEntry = await canonicalizeRequired(entryPath, entryPath, entryPath, expected)
    if (!realEntry.ok) return realEntry
    if (!withinBase(baseRealPath, realEntry.value)) {
      return boundaryFailure("outside_base", entryPath, entryPath, expected)
    }
    if (expected === "file" && !stat.isFile()) {
      return boundaryFailure("wrong_type", entryPath, entryPath, expected, undefined, actualKind(stat))
    }
    if (expected === "directory" && !stat.isDirectory()) {
      return boundaryFailure("wrong_type", entryPath, entryPath, expected, undefined, actualKind(stat))
    }

    return boundarySuccess(entryPath, entryPath, baseRealPath, realEntry.value, stat)
  } catch (error) {
    const nativeError = error as NativeFsError
    if (nativeError.code === "ENOENT") {
      return boundaryFailure("not_found", entryPath, entryPath, expected)
    }
    return boundaryFailure(
      "canonicalization_failed",
      entryPath,
      entryPath,
      expected,
      `Failed to inspect path ${entryPath}: ${formatDetails(nativeError)}`,
    )
  }
}
