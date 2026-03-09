import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"

let tmp: string
let tools: Record<string, (params: any) => Promise<string>>

const splitBody = (output: string) => output.split("\n\n(")[0]

const listLines = (output: string) => splitBody(output).split("\n")

const pathLines = (output: string) => splitBody(output).split("\n").filter(Boolean)

const parseGrep = (output: string) => {
  const files: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = []
  let current: { path: string; matches: Array<{ line: number; text: string }> } | undefined

  for (const line of output.split("\n")) {
    if (!line || line.startsWith("Found ")) continue
    if (line.endsWith(":")) {
      current = { path: line.slice(0, -1), matches: [] }
      files.push(current)
      continue
    }
    const match = line.match(/^  Line (\d+): (.*)$/)
    if (match && current) {
      current.matches.push({ line: Number(match[1]), text: match[2] })
    }
  }

  return files
}

const parseRead = (output: string) => {
  const pathMatch = output.match(/<path>(.*)<\/path>/)
  const typeMatch = output.match(/<type>(.*)<\/type>/)
  const contentMatch = output.match(/<content>\n([\s\S]*)\n<\/content>/)
  if (!pathMatch || !typeMatch || !contentMatch) throw new Error("Invalid read output")
  const body = contentMatch[1]
  const parts = body.split("\n\n")
  const lines = parts[0] ? parts[0].split("\n") : []
  const footer = parts.slice(1).join("\n\n")
  return {
    path: pathMatch[1],
    type: typeMatch[1],
    lines,
    footer: footer.trim(),
  }
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-tools-"))

  // text files
  await fs.writeFile(path.join(tmp, "hello.txt"), "line 1\nline 2\nline 3\nline 4\nline 5\n")
  await fs.writeFile(path.join(tmp, "empty.txt"), "")
  await fs.writeFile(path.join(tmp, "search-me.ts"), 'const foo = "bar"\nconst baz = "qux"\nfoo()\n')
  await fs.writeFile(path.join(tmp, "multi-match.ts"), "foo one\nfoo two\nfoo three\n")

  // nested
  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "index.ts"), 'export const main = () => "hello"\n')
  await fs.writeFile(path.join(tmp, "src", "utils.ts"), "export const add = (a: number, b: number) => a + b\n")
  await fs.mkdir(path.join(tmp, "src", "lib"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "lib", "helper.ts"), "export function help() {}\n")

  // binary
  const buf = Buffer.alloc(64)
  buf[0] = 0
  await fs.writeFile(path.join(tmp, "data.bin"), buf)

  // default-ignored
  await fs.mkdir(path.join(tmp, "node_modules"), { recursive: true })
  await fs.writeFile(path.join(tmp, "node_modules", "dep.js"), "module.exports = {}\n")

  // large file for pagination
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
  await fs.writeFile(path.join(tmp, "big.txt"), lines.join("\n") + "\n")

  const now = new Date()
  const t1 = new Date(now.getTime() - 60_000)
  const t2 = new Date(now.getTime() - 50_000)
  const t3 = new Date(now.getTime() - 40_000)
  const t4 = new Date(now.getTime() - 30_000)
  const t5 = new Date(now.getTime() - 20_000)
  const t6 = new Date(now.getTime() - 10_000)
  const t7 = new Date(now.getTime())
  const t8 = new Date(now.getTime() + 10_000)
  const t9 = new Date(now.getTime() - 5_000)
  await fs.utimes(path.join(tmp, "hello.txt"), t1, t1)
  await fs.utimes(path.join(tmp, "empty.txt"), t2, t2)
  await fs.utimes(path.join(tmp, "search-me.ts"), t3, t3)
  await fs.utimes(path.join(tmp, "src", "lib", "helper.ts"), t4, t4)
  await fs.utimes(path.join(tmp, "src", "utils.ts"), t5, t5)
  await fs.utimes(path.join(tmp, "src", "index.ts"), t6, t6)
  await fs.utimes(path.join(tmp, "big.txt"), t7, t7)
  await fs.utimes(path.join(tmp, "multi-match.ts"), t8, t8)
  await fs.utimes(path.join(tmp, "data.bin"), t9, t9)

  // mock the ToolsProviderController
  const mockCtl = {
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "baseDir") return tmp
        return undefined
      },
    }),
  } as any

  const toolList = await toolsProvider(mockCtl)
  tools = {}
  for (const t of toolList) {
    tools[(t as any).name] = (params: any) => (t as any).implementation(params)
  }
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------
describe("read tool", () => {
  it("reads a text file with line numbers", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "hello.txt") })
    expect(parseRead(result)).toEqual({
      path: path.join(tmp, "hello.txt"),
      type: "file",
      lines: ["1: line 1", "2: line 2", "3: line 3", "4: line 4", "5: line 5"],
      footer: "(End of file - total 5 lines)",
    })
  })

  it("supports offset and limit", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "big.txt"), offset: 10, limit: 5 })
    expect(parseRead(result)).toEqual({
      path: path.join(tmp, "big.txt"),
      type: "file",
      lines: ["10: line 10", "11: line 11", "12: line 12", "13: line 13", "14: line 14"],
      footer: "(Showing lines 10-14 of 100. Use offset=15 to continue.)",
    })
  })

  it("returns error for missing file", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "nope.txt") })
    expect(result).toContain("Error: File not found")
  })

  it("returns error for directory path", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "src") })
    expect(result).toContain("is a directory")
    expect(result).toContain("list tool")
  })

  it("returns error for binary file", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "data.bin") })
    expect(result).toContain("Cannot read binary file")
  })

  it("returns error for out-of-range offset", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "hello.txt"), offset: 999 })
    expect(result).toContain("out of range")
  })

  it("handles empty file", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "empty.txt") })
    expect(parseRead(result)).toEqual({
      path: path.join(tmp, "empty.txt"),
      type: "file",
      lines: [],
      footer: "(End of file - total 0 lines)",
    })
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
describe("list tool", () => {
  it("lists top-level entries by default", async () => {
    const result = await tools.list({ path: tmp })
    expect(result).toContain("hello.txt")
    expect(result).toContain("src/")
    // should not recurse into src
    expect(result).not.toContain("index.ts")
  })

  it("uses the base directory when path is omitted", async () => {
    const result = await tools.list({})
    expect(result).toContain("hello.txt")
    expect(result).toContain("src/")
  })

  it("lists recursively with tree format", async () => {
    const result = await tools.list({ path: tmp, recursive: true })
    expect(listLines(result)).toEqual([
      `${tmp}/`,
      "  src/",
      "    lib/",
      "      helper.ts",
      "    index.ts",
      "    utils.ts",
      "  big.txt",
      "  data.bin",
      "  empty.txt",
      "  hello.txt",
      "  multi-match.ts",
      "  search-me.ts",
    ])
  })

  it("filters by type: files", async () => {
    const result = await tools.list({ path: tmp, type: "files" })
    expect(result).not.toContain("src/")
    expect(result).toContain("hello.txt")
  })

  it("filters by type: directories", async () => {
    const result = await tools.list({ path: tmp, type: "directories" })
    expect(result).toContain("src/")
    expect(result).not.toContain("hello.txt")
  })

  it("skips default-ignored directories", async () => {
    const result = await tools.list({ path: tmp, recursive: true })
    expect(result).not.toContain("node_modules")
    expect(result).not.toContain("dep.js")
  })

  it("respects ignore patterns", async () => {
    const result = await tools.list({ path: tmp, ignore: ["*.txt"] })
    expect(result).not.toContain("hello.txt")
    expect(result).not.toContain("big.txt")
    expect(result).toContain("src/")
  })

  it("returns error for missing directory", async () => {
    const result = await tools.list({ path: path.join(tmp, "nope") })
    expect(result).toContain("Error: Directory not found")
  })

  it("returns error for out-of-range offset", async () => {
    const result = await tools.list({ path: tmp, offset: 999 })
    expect(result).toContain("out of range")
  })

  it("supports pagination", async () => {
    const result = await tools.list({ path: tmp, limit: 2 })
    expect(listLines(result)).toEqual([
      `${tmp}/`,
      "  big.txt",
      "  data.bin",
    ])
  })
})

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------
describe("glob tool", () => {
  it("matches files by pattern", async () => {
    const result = await tools.glob({ pattern: "*.txt", path: tmp })
    expect(pathLines(result)).toEqual([
      path.join(tmp, "big.txt"),
      path.join(tmp, "empty.txt"),
      path.join(tmp, "hello.txt"),
    ])
  })

  it("matches nested files with **", async () => {
    const result = await tools.glob({ pattern: "**/*.ts", path: tmp })
    expect(pathLines(result)).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "src", "index.ts"),
      path.join(tmp, "src", "utils.ts"),
      path.join(tmp, "src", "lib", "helper.ts"),
      path.join(tmp, "search-me.ts"),
    ])
  })

  it("returns no results message for unmatched pattern", async () => {
    const result = await tools.glob({ pattern: "*.xyz", path: tmp })
    expect(result).toBe("No entries found")
  })

  it("respects type filter for directories", async () => {
    const result = await tools.glob({ pattern: "*", path: tmp, type: "directories" })
    expect(result).toContain("src")
    expect(result).not.toContain("hello.txt")
  })

  it("respects include filter", async () => {
    const result = await tools.glob({ pattern: "**/*", path: tmp, include: ["*.ts"] })
    expect(pathLines(result)).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "src", "index.ts"),
      path.join(tmp, "src", "utils.ts"),
      path.join(tmp, "src", "lib", "helper.ts"),
      path.join(tmp, "search-me.ts"),
    ])
  })

  it("respects exclude filter", async () => {
    const result = await tools.glob({ pattern: "**/*.ts", path: tmp, exclude: ["src/lib/**"] })
    expect(pathLines(result)).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "src", "index.ts"),
      path.join(tmp, "src", "utils.ts"),
      path.join(tmp, "search-me.ts"),
    ])
  })

  it("returns error for out-of-range offset", async () => {
    const result = await tools.glob({ pattern: "**/*", path: tmp, offset: 999 })
    expect(result).toContain("out of range")
  })

  it("supports pagination", async () => {
    const result = await tools.glob({ pattern: "**/*", path: tmp, limit: 2 })
    expect(pathLines(result)).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "big.txt"),
    ])
  })

  it("sorts matches by most recently modified first", async () => {
    const result = await tools.glob({ pattern: "*.txt", path: tmp })
    expect(pathLines(result)).toEqual([
      path.join(tmp, "big.txt"),
      path.join(tmp, "empty.txt"),
      path.join(tmp, "hello.txt"),
    ])
  })

  it("returns error for missing directory", async () => {
    const result = await tools.glob({ pattern: "*", path: path.join(tmp, "nope") })
    expect(result).toContain("Error: Directory not found")
  })
})

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------
describe("grep tool", () => {
  it("finds matches in files", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp })
    expect(parseGrep(result)).toEqual([
      {
        path: path.join(tmp, "multi-match.ts"),
        matches: [
          { line: 1, text: "foo one" },
          { line: 2, text: "foo two" },
          { line: 3, text: "foo three" },
        ],
      },
      {
        path: path.join(tmp, "search-me.ts"),
        matches: [
          { line: 1, text: 'const foo = "bar"' },
          { line: 3, text: "foo()" },
        ],
      },
    ])
  })

  it("returns line numbers", async () => {
    const result = await tools.grep({ pattern: "baz", path: tmp })
    expect(parseGrep(result)).toEqual([
      {
        path: path.join(tmp, "search-me.ts"),
        matches: [{ line: 2, text: 'const baz = "qux"' }],
      },
    ])
  })

  it("searches recursively", async () => {
    const result = await tools.grep({ pattern: "hello", path: tmp })
    expect(parseGrep(result)).toEqual([
      {
        path: path.join(tmp, "src", "index.ts"),
        matches: [{ line: 1, text: 'export const main = () => "hello"' }],
      },
    ])
  })

  it("respects include filter", async () => {
    const result = await tools.grep({ pattern: "export", path: tmp, include: ["*.ts"] })
    expect(parseGrep(result)).toEqual([
      {
        path: path.join(tmp, "src", "index.ts"),
        matches: [{ line: 1, text: 'export const main = () => "hello"' }],
      },
      {
        path: path.join(tmp, "src", "utils.ts"),
        matches: [{ line: 1, text: "export const add = (a: number, b: number) => a + b" }],
      },
      {
        path: path.join(tmp, "src", "lib", "helper.ts"),
        matches: [{ line: 1, text: "export function help() {}" }],
      },
    ])
  })

  it("respects exclude filter", async () => {
    const result = await tools.grep({ pattern: "export", path: tmp, exclude: ["src/lib/**"] })
    expect(parseGrep(result)).toEqual([
      {
        path: path.join(tmp, "src", "index.ts"),
        matches: [{ line: 1, text: 'export const main = () => "hello"' }],
      },
      {
        path: path.join(tmp, "src", "utils.ts"),
        matches: [{ line: 1, text: "export const add = (a: number, b: number) => a + b" }],
      },
    ])
  })

  it("skips binary files", async () => {
    const result = await tools.grep({ pattern: ".*", path: tmp })
    expect(result).not.toContain("data.bin")
  })

  it("returns no matches message", async () => {
    const result = await tools.grep({ pattern: "zzzznotfound", path: tmp })
    expect(result).toBe("No matches found")
  })

  it("sorts matching files by most recently modified first", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp })
    expect(parseGrep(result).map((file) => file.path)).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "search-me.ts"),
    ])
  })

  it("groups multiple matches from the same file under one header", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp, include: ["multi-match.ts"] })
    expect(parseGrep(result)).toEqual([
      {
        path: path.join(tmp, "multi-match.ts"),
        matches: [
          { line: 1, text: "foo one" },
          { line: 2, text: "foo two" },
          { line: 3, text: "foo three" },
        ],
      },
    ])
  })

  it("returns error for invalid regex", async () => {
    const result = await tools.grep({ pattern: "[invalid", path: tmp })
    expect(result).toContain("Error: Invalid regular expression")
  })

  it("returns error for missing directory", async () => {
    const result = await tools.grep({ pattern: "test", path: path.join(tmp, "nope") })
    expect(result).toContain("Error: Directory not found")
  })
})
