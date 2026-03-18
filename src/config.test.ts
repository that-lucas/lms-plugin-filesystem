import { describe, it, expect } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"
import { createLink, detectLinkSupport } from "./testSupport"

describe("baseDir config behavior", () => {
  it("trims whitespace around baseDir", async () => {
    const ctl = {
      getPluginConfig: () => ({
        get: (key: string) => key === "baseDir" ? `  ${process.cwd()}  ` : undefined,
      }),
    } as any

    const tools = await toolsProvider(ctl)
    const read = tools.find((tool) => (tool as any).name === "read") as any
    const result = await read.implementation({ filePath: path.join(process.cwd(), "package.json") })
    expect(result).toContain("#path:")
  })

  it("uses home directory when baseDir is empty", async () => {
    const ctl = {
      getPluginConfig: () => ({
        get: (key: string) => key === "baseDir" ? "" : undefined,
      }),
    } as any

    const tools = await toolsProvider(ctl)
    const list = tools.find((tool) => (tool as any).name === "list") as any
    const result = await list.implementation({ path: "~" })
    expect(result).toContain(`#path:${os.homedir()}`)
  })

  it("fails cleanly when baseDir does not exist", async () => {
    const ctl = {
      getPluginConfig: () => ({
        get: (key: string) => key === "baseDir" ? path.join(process.cwd(), "missing-base-dir") : undefined,
      }),
    } as any

    const tools = await toolsProvider(ctl)
    const list = tools.find((tool) => (tool as any).name === "list") as any
    await expect(list.implementation({})).rejects.toThrow("#error:filesystem_error")
  })

  it("fails cleanly when baseDir is a symlink", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-config-"))
    const support = await detectLinkSupport(path.join(tmp, "config-link-check"))
    if (!support.dirLinks) {
      await fs.rm(tmp, { recursive: true, force: true })
      return
    }

    const target = path.join(tmp, "real-base")
    const link = path.join(tmp, "base-link")
    await fs.mkdir(target, { recursive: true })
    await createLink(target, link, "dir")

    const ctl = {
      getPluginConfig: () => ({
        get: (key: string) => key === "baseDir" ? link : undefined,
      }),
    } as any

    const tools = await toolsProvider(ctl)
    const list = tools.find((tool) => (tool as any).name === "list") as any
    await expect(list.implementation({})).rejects.toThrow("#error:filesystem_error")
    await fs.rm(tmp, { recursive: true, force: true })
  })
})
