import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"

const parseFlat = (output: string) => {
  const fields: Record<string, string> = {}
  let index = 0
  while (index < output.length) {
    if (output[index] !== "#") throw new Error("Invalid flat output")
    const newline = output.indexOf("\n", index)
    const line = newline === -1 ? output.slice(index) : output.slice(index, newline)
    const separator = line.indexOf(":")
    if (separator === -1) throw new Error("Invalid field")
    const key = line.slice(1, separator)
    const value = line.slice(separator + 1)
    index = newline === -1 ? output.length : newline + 1
    if (key.endsWith("_bytes")) {
      index += Number(value)
      if (index < output.length && output[index] === "\n") index += 1
      continue
    }
    fields[key] = value
  }
  return fields
}

const parseError = (output: string) => {
  const fields = parseFlat(output)
  return { code: fields.error, message: fields.message, path: fields.path, kind: fields.kind }
}

const parseGrepSummary = (output: string) => {
  const fields = parseFlat(output)
  return { total: fields.matches_total, files: fields.matches_files }
}

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
  await fs.writeFile(path.join(FIXTURE_DIR, "root.ts"), "export const y = 2\n")

  const mockCtl = {
    getPluginConfig: () => ({
      get: (key: string) => key === "baseDir" ? FIXTURE_DIR : undefined,
    }),
  } as any

  const toolList = await toolsProvider(mockCtl)
  tools = {}
  for (const t of toolList) {
    tools[(t as any).name] = (params: any) => (t as any).implementation(params)
  }

  const rootCtl = {
    getPluginConfig: () => ({
      get: (key: string) => key === "baseDir" ? "/" : undefined,
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

  it("glob accepts ~/... path with standard root matching", async () => {
    const result = await tools.glob({ pattern: "*.ts", path: HOME_REL })
    expect(result).toContain("root.ts")
    expect(result).not.toContain("data.ts")
  })

  it("grep accepts ~/... path", async () => {
    const result = await tools.grep({ pattern: "export", path: HOME_REL })
    expect(result).toContain("data.ts")
    expect(result).toContain("export const x = 1")
  })
})

describe("path outside base directory", () => {
  it("read returns error for absolute path outside base", async () => {
    expect(parseError(await tools.read({ filePath: "/etc/passwd" })).code).toBe("path_outside_base")
  })

  it("read returns error for relative path that escapes base", async () => {
    expect(parseError(await tools.read({ filePath: "../../etc/passwd" })).code).toBe("path_outside_base")
  })

  it("list returns error for path outside base", async () => {
    expect(parseError(await tools.list({ path: "/etc" })).code).toBe("path_outside_base")
  })

  it("glob returns error for path outside base", async () => {
    expect(parseError(await tools.glob({ pattern: "*", path: "/etc" })).code).toBe("path_outside_base")
  })

  it("grep returns error for path outside base", async () => {
    expect(parseError(await tools.grep({ pattern: "root", path: "/etc" })).code).toBe("path_outside_base")
  })

  it("create returns error for path outside base", async () => {
    expect(parseError(await tools.create({ type: "file", path: "/tmp/outside.txt", content: "x" })).code).toBe("path_outside_base")
  })

  it("edit returns error for path outside base", async () => {
    expect(parseError(await tools.edit({ path: "/tmp/outside.txt", edits: [{ oldString: "a", newString: "b" }] })).code).toBe("path_outside_base")
  })
})

describe("grep special system paths", () => {
  it("skips /dev", async () => {
    expect(parseGrepSummary(await rootTools.grep({ pattern: ".*", path: "/dev" }))).toEqual({ total: "0", files: "0" })
  })

  it("skips /proc", async () => {
    const result = await rootTools.grep({ pattern: ".*", path: "/proc" })
    expect(parseGrepSummary(result).total === "0" || parseError(result).code === "not_found").toBe(true)
  })

  it("skips /sys", async () => {
    const result = await rootTools.grep({ pattern: ".*", path: "/sys" })
    expect(parseGrepSummary(result).total === "0" || parseError(result).code === "not_found").toBe(true)
  })

  it("skips /run", async () => {
    const result = await rootTools.grep({ pattern: ".*", path: "/run" })
    expect(parseGrepSummary(result).total === "0" || parseError(result).code === "not_found").toBe(true)
  })

  it("skips /var/run", async () => {
    expect(parseGrepSummary(await rootTools.grep({ pattern: ".*", path: "/var/run" }))).toEqual({ total: "0", files: "0" })
  })

  it("skips /private/var/run", async () => {
    expect(parseGrepSummary(await rootTools.grep({ pattern: ".*", path: "/private/var/run" }))).toEqual({ total: "0", files: "0" })
  })

  it("skips /Volumes", async () => {
    expect(parseGrepSummary(await rootTools.grep({ pattern: ".*", path: "/Volumes" }))).toEqual({ total: "0", files: "0" })
  })
})
