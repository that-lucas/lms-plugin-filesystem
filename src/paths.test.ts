import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"

const PROJECT_DIR = path.resolve(__dirname, "..")
const FIXTURE_DIR = path.join(PROJECT_DIR, "test-fixtures")
const HOME_REL = "~/" + path.relative(os.homedir(), FIXTURE_DIR)

let tools: Record<string, (params: any) => Promise<string>>
let rootTools: Record<string, (params: any) => Promise<string>>

beforeAll(async () => {
  await fs.mkdir(FIXTURE_DIR, { recursive: true })
  await fs.writeFile(path.join(FIXTURE_DIR, "note.txt"), "hello from fixture\n")
  await fs.mkdir(path.join(FIXTURE_DIR, "sub"), { recursive: true })
  await fs.writeFile(path.join(FIXTURE_DIR, "sub", "data.ts"), "export const x = 1\n")

  const mockCtl = {
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "baseDir") return FIXTURE_DIR
        return undefined
      },
    }),
  } as any

  const toolList = await toolsProvider(mockCtl)
  tools = {}
  for (const t of toolList) {
    tools[(t as any).name] = (params: any) => (t as any).implementation(params)
  }

  const rootCtl = {
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "baseDir") return "/"
        return undefined
      },
    }),
  } as any

  const rootToolList = await toolsProvider(rootCtl)
  rootTools = {}
  for (const t of rootToolList) {
    rootTools[(t as any).name] = (params: any) => (t as any).implementation(params)
  }
})

afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Home-relative paths
// ---------------------------------------------------------------------------
describe("home-relative paths", () => {
  it("read accepts ~/... path", async () => {
    const result = await tools.read({ filePath: HOME_REL + "/note.txt" })
    expect(result).toContain("1: hello from fixture")
  })

  it("list accepts ~/... path", async () => {
    const result = await tools.list({ path: HOME_REL })
    expect(result).toContain("note.txt")
    expect(result).toContain("sub/")
  })

  it("glob accepts ~/... path", async () => {
    const result = await tools.glob({ pattern: "*.ts", path: HOME_REL })
    expect(result).toContain("data.ts")
  })

  it("grep accepts ~/... path", async () => {
    const result = await tools.grep({ pattern: "export", path: HOME_REL })
    expect(result).toContain("data.ts")
    expect(result).toContain("export const x = 1")
  })
})

// ---------------------------------------------------------------------------
// Path outside base directory (security boundary)
// ---------------------------------------------------------------------------
describe("path outside base directory", () => {
  it("read returns error for absolute path outside base", async () => {
    await expect(tools.read({ filePath: "/etc/passwd" })).resolves.toBe(
      "Error: Path is outside the configured base directory: /etc/passwd",
    )
  })

  it("read returns error for relative path that escapes base", async () => {
    await expect(tools.read({ filePath: "../../etc/passwd" })).resolves.toContain(
      "Error: Path is outside the configured base directory:",
    )
  })

  it("list returns error for path outside base", async () => {
    await expect(tools.list({ path: "/etc" })).resolves.toBe(
      "Error: Path is outside the configured base directory: /etc",
    )
  })

  it("glob returns error for path outside base", async () => {
    await expect(tools.glob({ pattern: "*", path: "/etc" })).resolves.toBe(
      "Error: Path is outside the configured base directory: /etc",
    )
  })

  it("grep returns error for path outside base", async () => {
    await expect(tools.grep({ pattern: "root", path: "/etc" })).resolves.toBe(
      "Error: Path is outside the configured base directory: /etc",
    )
  })
})

describe("grep special system paths", () => {
  it("skips /dev", async () => {
    expect(await rootTools.grep({ pattern: ".*", path: "/dev" })).toContain('<matches total="0" files="0">')
  })

  it("skips /proc", async () => {
    const result = await rootTools.grep({ pattern: ".*", path: "/proc" })
    expect(result.includes('<matches total="0" files="0">') || result === "Error: Directory not found: /proc").toBe(true)
  })

  it("skips /sys", async () => {
    const result = await rootTools.grep({ pattern: ".*", path: "/sys" })
    expect(result.includes('<matches total="0" files="0">') || result === "Error: Directory not found: /sys").toBe(true)
  })

  it("skips /run", async () => {
    const result = await rootTools.grep({ pattern: ".*", path: "/run" })
    expect(result.includes('<matches total="0" files="0">') || result === "Error: Directory not found: /run").toBe(true)
  })

  it("skips /var/run", async () => {
    expect(await rootTools.grep({ pattern: ".*", path: "/var/run" })).toContain('<matches total="0" files="0">')
  })

  it("skips /private/var/run", async () => {
    expect(await rootTools.grep({ pattern: ".*", path: "/private/var/run" })).toContain('<matches total="0" files="0">')
  })

  it("skips /Volumes", async () => {
    expect(await rootTools.grep({ pattern: ".*", path: "/Volumes" })).toContain('<matches total="0" files="0">')
  })
})
