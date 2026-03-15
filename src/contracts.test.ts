import { describe, it, expect } from "vitest"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"

describe("tool contracts", () => {
  it("exposes all expected tools", async () => {
    const tools = await toolsProvider({
      getPluginConfig: () => ({ get: () => process.cwd() }),
    } as any)

    expect(tools.map((tool) => (tool as any).name)).toEqual(["read", "list", "glob", "grep", "create", "edit"])
  })

  it("declares descriptions and implementations on each tool", async () => {
    const tools = await toolsProvider({
      getPluginConfig: () => ({ get: () => process.cwd() }),
    } as any)

    for (const tool of tools as any[]) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(typeof tool.implementation).toBe("function")
    }
  })

  it("returns flat protocol output for representative success and error cases", async () => {
    const tools = await toolsProvider({
      getPluginConfig: () => ({ get: () => process.cwd() }),
    } as any)
    const byName = Object.fromEntries(tools.map((tool) => [(tool as any).name, tool as any]))

    const readError = await byName.read.implementation({ filePath: path.join(process.cwd(), "missing-file.txt") })
    expect(readError.startsWith("#error:")).toBe(true)

    const globResult = await byName.glob.implementation({ pattern: "package.json", path: process.cwd() })
    expect(globResult).toContain("#entries_bytes:")
  })
})
