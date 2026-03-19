import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  inspectCreateTarget,
  inspectExistingPath,
  inspectNestedEntry,
  resolveConfiguredSandboxBaseDir,
  resolveUserPath,
} from "./boundary"
import {
  createBrokenDirLink,
  createBrokenFileLink,
  createLink,
  createSymlinkLoopPair,
  detectLinkSupport,
  mockRealpathFailure,
  type LinkSupport,
} from "./testSupport"

let tmp: string
let outsideTmp: string
let linkSupport: LinkSupport
let realpathSpy: ReturnType<typeof mockRealpathFailure> | undefined

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-boundary-"))
  outsideTmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-boundary-outside-"))
  linkSupport = await detectLinkSupport(path.join(tmp, "boundary-link-check"))

  await fs.mkdir(path.join(tmp, "dir", "nested"), { recursive: true })
  await fs.writeFile(path.join(tmp, "dir", "nested", "file.txt"), "ok\n")
  await fs.writeFile(path.join(outsideTmp, "outside.txt"), "outside\n")
})

afterEach(() => {
  realpathSpy?.mockRestore()
  realpathSpy = undefined
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.rm(outsideTmp, { recursive: true, force: true })
})

describe("boundary", () => {
  it("accepts a valid configured sandbox base directory", async () => {
    const result = await resolveConfiguredSandboxBaseDir(tmp)
    expect(result.ok).toBe(true)
  })

  it("rejects a missing configured sandbox base directory", async () => {
    const result = await resolveConfiguredSandboxBaseDir(path.join(tmp, "missing-base"))
    expect(result).toMatchObject({ ok: false, kind: "sandbox_base_dir_invalid" })
  })

  it("rejects a symlinked configured sandbox base directory", async () => {
    if (!linkSupport.dirLinks) return
    const linkPath = path.join(tmp, "sandbox-base-link")
    await createLink(path.join(tmp, "dir"), linkPath, "dir")
    const result = await resolveConfiguredSandboxBaseDir(linkPath)
    expect(result).toMatchObject({ ok: false, kind: "sandbox_base_dir_invalid" })
  })

  it("rejects lexical outside-base paths", () => {
    const result = resolveUserPath(tmp, "../../escape")
    expect(result).toMatchObject({ ok: false, kind: "outside_base" })
  })

  it("returns success for an existing file", async () => {
    const result = await inspectExistingPath(tmp, path.join(tmp, "dir", "nested", "file.txt"), "file")
    expect(result).toMatchObject({ ok: true })
  })

  it("returns success for an existing directory", async () => {
    const result = await inspectExistingPath(tmp, path.join(tmp, "dir"), "directory")
    expect(result).toMatchObject({ ok: true })
  })

  it("reports wrong-type paths", async () => {
    const result = await inspectExistingPath(tmp, path.join(tmp, "dir"), "file")
    expect(result).toMatchObject({ ok: false, kind: "wrong_type", actual: "directory" })
  })

  it("reports truly missing targets as not_found", async () => {
    const result = await inspectExistingPath(tmp, path.join(tmp, "missing.txt"), "file")
    expect(result).toMatchObject({ ok: false, kind: "not_found" })
  })

  it("classifies root file symlinks", async () => {
    if (!linkSupport.fileSymlinks) return
    const linkPath = path.join(tmp, "file-link.txt")
    await createLink(path.join(tmp, "dir", "nested", "file.txt"), linkPath)
    const result = await inspectExistingPath(tmp, linkPath, "file")
    expect(result).toMatchObject({ ok: false, kind: "symlink_root" })
  })

  it("classifies root directory symlinks", async () => {
    if (!linkSupport.dirLinks) return
    const linkPath = path.join(tmp, "dir-link")
    await createLink(path.join(tmp, "dir"), linkPath, "dir")
    const result = await inspectExistingPath(tmp, linkPath, "directory")
    expect(result).toMatchObject({ ok: false, kind: "symlink_root" })
  })

  it("classifies broken root file symlinks", async () => {
    if (!linkSupport.fileSymlinks) return
    const linkPath = path.join(tmp, "broken-file-link.txt")
    await createBrokenFileLink(path.join(tmp, "missing-file.txt"), linkPath)
    const result = await inspectExistingPath(tmp, linkPath, "file")
    expect(result).toMatchObject({ ok: false, kind: "broken_link" })
  })

  it("classifies broken root directory symlinks", async () => {
    if (!linkSupport.dirLinks) return
    const linkPath = path.join(tmp, "broken-dir-link")
    await createBrokenDirLink(path.join(tmp, "missing-dir"), linkPath)
    const result = await inspectExistingPath(tmp, linkPath, "directory")
    expect(result).toMatchObject({ ok: false, kind: "broken_link" })
  })

  it("classifies root symlink loops", async () => {
    if (!linkSupport.dirLinks) return
    const first = path.join(tmp, "loop-a")
    const second = path.join(tmp, "loop-b")
    await createSymlinkLoopPair(first, second)
    const result = await inspectExistingPath(tmp, first, "directory")
    expect(result).toMatchObject({ ok: false, kind: "symlink_loop" })
  })

  it("classifies canonicalization failures", async () => {
    const target = path.join(tmp, "dir", "nested", "file.txt")
    realpathSpy = mockRealpathFailure(target, Object.assign(new Error("boom"), { code: "EACCES" }))
    const result = await inspectExistingPath(tmp, target, "file")
    realpathSpy.mockRestore()
    realpathSpy = undefined
    expect(result).toMatchObject({ ok: false, kind: "canonicalization_failed" })
  })

  it("rejects create targets under a symlinked parent", async () => {
    if (!linkSupport.dirLinks) return
    const linkPath = path.join(tmp, "create-link")
    await createLink(path.join(tmp, "dir"), linkPath, "dir")
    const result = await inspectCreateTarget(tmp, path.join(linkPath, "new.txt"), "file")
    expect(result).toMatchObject({ ok: false, kind: "symlink_root" })
  })

  it("returns a failure result for nested file symlinks", async () => {
    if (!linkSupport.fileSymlinks) return
    const linkPath = path.join(tmp, "nested-file-link.txt")
    await createLink(path.join(tmp, "dir", "nested", "file.txt"), linkPath)
    const base = await resolveConfiguredSandboxBaseDir(tmp)
    if (!base.ok) throw new Error("base failed")
    const result = await inspectNestedEntry(base.realBase, linkPath, "file")
    expect(result).toMatchObject({ ok: false, kind: "symlink_root" })
  })

  it("returns a failure result for nested directory symlinks", async () => {
    if (!linkSupport.dirLinks) return
    const linkPath = path.join(tmp, "nested-dir-link")
    await createLink(path.join(tmp, "dir"), linkPath, "dir")
    const base = await resolveConfiguredSandboxBaseDir(tmp)
    if (!base.ok) throw new Error("base failed")
    const result = await inspectNestedEntry(base.realBase, linkPath, "directory")
    expect(result).toMatchObject({ ok: false, kind: "symlink_root" })
  })
})
