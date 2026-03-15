import { describe, it, expect, vi } from "vitest"
import { main } from "./index"
import { configSchematics } from "./config"
import { toolsProvider } from "./toolsProvider"

describe("main", () => {
  it("registers config schematics and tools provider", async () => {
    const withConfigSchematics = vi.fn()
    const withToolsProvider = vi.fn()
    const ctx = { withConfigSchematics, withToolsProvider } as any

    await main(ctx)

    expect(withConfigSchematics).toHaveBeenCalledTimes(1)
    expect(withConfigSchematics).toHaveBeenCalledWith(configSchematics)
    expect(withToolsProvider).toHaveBeenCalledTimes(1)
    expect(withToolsProvider).toHaveBeenCalledWith(toolsProvider)
    expect(withConfigSchematics.mock.invocationCallOrder[0]).toBeLessThan(withToolsProvider.mock.invocationCallOrder[0])
  })
})
