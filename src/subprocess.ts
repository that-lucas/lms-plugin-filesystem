import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { inspectTraversalRoot, resolveConfiguredBaseDir, resolveUserPath } from "./boundary"

export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 10_000
export const DEFAULT_SUBPROCESS_MAX_OUTPUT_BYTES = 256 * 1024
export const SUBPROCESS_KILL_GRACE_MS = 250
export const DEFAULT_EXECUTABLE_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
]

export type RunSubprocessOptions = {
  command: string
  args?: string[]
  baseDir: string
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
  stdin?: string
}

export type RunSubprocessResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  spawnError?: string
}

export async function resolveExecutable(command: string, envPath = process.env.PATH, fallbackDirs = DEFAULT_EXECUTABLE_DIRS) {
  if (command.length === 0) throw new Error("Command must not be empty")
  if (path.isAbsolute(command)) return command

  const candidates =
    process.platform === "win32"
      ? [command, ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((ext) => ext.length > 0).map((ext) => `${command}${ext}`)]
      : [command]

  const dirs = [...(envPath || "").split(path.delimiter), ...fallbackDirs]
    .filter((item) => item.length > 0)
    .filter((item, index, all) => all.indexOf(item) === index)

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.resolve(dir, candidate)
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat?.isFile()) continue
      const executable = process.platform === "win32"
        ? true
        : await fs.access(full, fsConstants.X_OK).then(() => true).catch(() => false)
      if (!executable) continue
      return full
    }
  }

  return undefined
}

const resolveSubprocessCwd = async (baseDir: string, cwd?: string) => {
  const base = await resolveConfiguredBaseDir(baseDir)
  if (!base.ok) {
    throw new Error(`Working directory validation failed: ${base.details ?? base.resolvedPath}`)
  }

  const resolved = resolveUserPath(base.resolvedPath, cwd)
  if (!resolved.ok) {
    throw new Error(`Working directory is outside the configured base directory: ${resolved.resolvedPath}`)
  }

  const inspected = await inspectTraversalRoot(base.resolvedPath, resolved.resolvedPath)
  if (!inspected.ok) {
    if (inspected.kind === "outside_base") {
      throw new Error(`Working directory is outside the configured base directory: ${inspected.resolvedPath}`)
    }
    if (inspected.kind === "not_found") {
      throw new Error(`Working directory not found: ${inspected.resolvedPath}`)
    }
    if (inspected.kind === "wrong_type") {
      throw new Error(`Working directory is not a directory: ${inspected.resolvedPath}`)
    }
    throw new Error(`Working directory validation failed: ${inspected.details ?? inspected.resolvedPath}`)
  }

  return inspected.realPath ?? inspected.resolvedPath
}

export async function runSubprocess({
  command,
  args = [],
  baseDir,
  cwd,
  timeoutMs = DEFAULT_SUBPROCESS_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_SUBPROCESS_MAX_OUTPUT_BYTES,
  env,
  stdin,
}: RunSubprocessOptions): Promise<RunSubprocessResult> {
  if (!path.isAbsolute(command)) {
    throw new Error(`Command must be an absolute path: ${command}`)
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs must be greater than 0: ${timeoutMs}`)
  }
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`maxOutputBytes must be greater than 0: ${maxOutputBytes}`)
  }

  const resolvedCwd = await resolveSubprocessCwd(baseDir, cwd)

  return await new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let truncated = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined

    const finish = (result: RunSubprocessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolve(result)
    }

    const killChild = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill(signal)
    }

    const scheduleForceKill = () => {
      if (forceKillTimer) return
      forceKillTimer = setTimeout(() => {
        killChild("SIGKILL")
      }, SUBPROCESS_KILL_GRACE_MS)
      forceKillTimer.unref?.()
    }

    const appendChunk = (chunks: Buffer[], chunk: string | Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (outputBytes >= maxOutputBytes) {
        truncated = true
        killChild("SIGTERM")
        scheduleForceKill()
        return
      }

      const remaining = maxOutputBytes - outputBytes
      const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf
      chunks.push(slice)
      outputBytes += slice.byteLength

      if (slice.byteLength < buf.byteLength) {
        truncated = true
        killChild("SIGTERM")
        scheduleForceKill()
      }
    }

    const child = spawn(command, args, {
      cwd: resolvedCwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      stdio: "pipe",
    })

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      killChild("SIGTERM")
      scheduleForceKill()
    }, timeoutMs)
    timeoutHandle.unref?.()

    child.stdout.on("data", (chunk) => appendChunk(stdoutChunks, chunk))
    child.stderr.on("data", (chunk) => appendChunk(stderrChunks, chunk))
    child.stdin.on("error", () => {})

    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        truncated,
        spawnError: error.message,
      })
    })

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        truncated,
      })
    })

    if (stdin !== undefined) {
      child.stdin.end(stdin)
      return
    }

    child.stdin.end()
  })
}
