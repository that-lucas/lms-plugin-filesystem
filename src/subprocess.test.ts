import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveExecutable, runSubprocess } from "./subprocess"
import { createLink, detectLinkSupport, type LinkSupport } from "./testSupport"

let baseDir: string
let outsideDir: string
let linkSupport: LinkSupport

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-subprocess-"))
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-subprocess-outside-"))
  linkSupport = await detectLinkSupport(path.join(baseDir, "subprocess-link-check"))

  await fs.mkdir(path.join(baseDir, "subdir"), { recursive: true })
  if (linkSupport.symlinks) {
    await createLink(path.join(baseDir, "subdir"), path.join(baseDir, "inside-link"), "dir")
    await createLink(outsideDir, path.join(baseDir, "outside-link"), "dir")
  }
})

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true })
  await fs.rm(outsideDir, { recursive: true, force: true })
})

describe("runSubprocess", () => {
  it("resolves executables from PATH entries", async () => {
    const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-bin-"))
    const toolPath = path.join(toolDir, "fake-rg")

    try {
      await fs.writeFile(toolPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      await expect(resolveExecutable("fake-rg", toolDir, [])).resolves.toBe(toolPath)
    } finally {
      await fs.rm(toolDir, { recursive: true, force: true })
    }
  })

  it("resolves executables from fallback directories when PATH is empty", async () => {
    const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-fallback-bin-"))
    const toolPath = path.join(toolDir, "fake-rg")

    try {
      await fs.writeFile(toolPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      await expect(resolveExecutable("fake-rg", "", [toolDir])).resolves.toBe(toolPath)
    } finally {
      await fs.rm(toolDir, { recursive: true, force: true })
    }
  })

  it("returns absolute paths when PATH entries are relative", async () => {
    const toolDir = await fs.mkdtemp(path.join(process.cwd(), "fs-plugin-relative-bin-"))
    const toolName = path.basename(toolDir)
    const toolPath = path.join(toolDir, "fake-rg")

    try {
      await fs.writeFile(toolPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      await expect(resolveExecutable("fake-rg", `./${toolName}`, [])).resolves.toBe(toolPath)
    } finally {
      await fs.rm(toolDir, { recursive: true, force: true })
    }
  })

  it("runs a subprocess successfully", async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("ok")'],
      baseDir,
    })

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      truncated: false,
    })
  })

  it("captures non-zero exits and stderr", async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("bad"); process.exit(7)'],
      baseDir,
    })

    expect(result).toEqual({
      exitCode: 7,
      signal: null,
      stdout: "",
      stderr: "bad",
      timedOut: false,
      truncated: false,
    })
  })

  it("returns spawn errors for missing executables", async () => {
    const result = await runSubprocess({
      command: path.join(baseDir, "missing-command"),
      baseDir,
    })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(result.spawnError).toBeTruthy()
    expect(result.spawnError).toContain("ENOENT")
  })

  it("uses baseDir as the default cwd", async () => {
    const realBaseDir = await fs.realpath(baseDir)
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(process.cwd())'],
      baseDir,
    })

    expect(result.stdout).toBe(realBaseDir)
  })

  it("resolves a relative cwd within the base directory", async () => {
    const realSubdir = await fs.realpath(path.join(baseDir, "subdir"))
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(process.cwd())'],
      baseDir,
      cwd: "subdir",
    })

    expect(result.stdout).toBe(realSubdir)
  })

  it("returns the canonical cwd after validating a symlink within the base directory", async () => {
    if (!linkSupport.symlinks) return
    const realSubdir = await fs.realpath(path.join(baseDir, "subdir"))
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(process.cwd())'],
      baseDir,
      cwd: "inside-link",
    })

    expect(result.stdout).toBe(realSubdir)
  })

  it("rejects symlinked cwd values that escape the base directory", async () => {
    if (!linkSupport.symlinks) return
    await expect(
      runSubprocess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("nope")'],
        baseDir,
        cwd: "outside-link",
      }),
    ).rejects.toThrow("Working directory is outside the configured base directory")
  })

  it("times out long-running subprocesses", async () => {
    const started = Date.now()
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      baseDir,
      timeoutMs: 50,
    })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.timedOut).toBe(true)
    expect(result.signal ?? result.exitCode).toBeTruthy()
  })

  it("captures stdout and stderr independently", async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("out"); process.stderr.write("err")'],
      baseDir,
    })

    expect(result.stdout).toBe("out")
    expect(result.stderr).toBe("err")
  })

  it("truncates output at the configured byte limit", async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("a".repeat(256)); setTimeout(() => {}, 10_000)'],
      baseDir,
      maxOutputBytes: 64,
      timeoutMs: 2_000,
    })

    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout + result.stderr, "utf8")).toBe(64)
  })

  it("writes stdin to the child process", async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", 'process.stdin.setEncoding("utf8"); let body=""; process.stdin.on("data", (chunk) => body += chunk); process.stdin.on("end", () => process.stdout.write(body.toUpperCase()))'],
      baseDir,
      stdin: "hello",
    })

    expect(result.stdout).toBe("HELLO")
  })

  it("ignores stdin stream errors when the child exits early", async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      baseDir,
      stdin: "hello",
    })

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it("requires an absolute command path", async () => {
    await expect(
      runSubprocess({
        command: "node",
        args: ["-e", 'process.stdout.write("x")'],
        baseDir,
      }),
    ).rejects.toThrow("Command must be an absolute path")
  })
})
