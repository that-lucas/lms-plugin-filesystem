import { describe, it, expect } from "vitest"
import os from "node:os"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"

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
})
