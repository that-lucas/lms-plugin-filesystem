import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { toolsProvider } from "./toolsProvider"
import { createLink, detectLinkSupport, type LinkSupport } from "./testSupport"

let tmp: string
let outsideTmp: string
let tools: Record<string, (params: any) => Promise<string>>
let linkSupport: LinkSupport

type FlatRecord = {
  fields: Record<string, string>
  payloads: Record<string, string>
}

const parseFlat = (output: string) => {
  const record: FlatRecord = { fields: {}, payloads: {} }
  const buf = Buffer.from(output, "utf8")
  let index = 0

  while (index < buf.length) {
    if (buf[index] !== 0x23) throw new Error(`Invalid flat output at byte ${index}`)
    const newline = buf.indexOf(0x0a, index)
    const lineEnd = newline === -1 ? buf.length : newline
    const line = buf.slice(index, lineEnd).toString("utf8")
    const separator = line.indexOf(":")
    if (separator === -1) throw new Error(`Invalid flat field: ${line}`)
    const key = line.slice(1, separator)
    const value = line.slice(separator + 1)
    index = newline === -1 ? buf.length : newline + 1

    if (key.endsWith("_bytes")) {
      const payloadKey = key.slice(0, -6)
      const length = Number(value)
      if (!Number.isInteger(length) || length < 0) throw new Error(`Invalid byte count for ${key}`)
      record.fields[key] = value
      const payload = buf.slice(index, index + length).toString("utf8")
      record.payloads[payloadKey] = payload
      index += length
      if (index < buf.length && buf[index] === 0x0a) index += 1
      continue
    }

    record.fields[key] = value
  }

  return record
}

const parseError = (output: string) => {
  const parsed = parseFlat(output)
  return {
    code: parsed.fields.error,
    message: parsed.fields.message,
    kind: parsed.fields.kind,
    path: parsed.fields.path,
    expected: parsed.fields.expected,
    actual: parsed.fields.actual,
    parameter: parsed.fields.parameter,
    value: parsed.fields.value,
    total: parsed.fields.total,
    unit: parsed.fields.unit,
    pattern: parsed.fields.pattern,
    matches: parsed.fields.matches,
    details: parsed.fields.details,
  }
}

const parseRead = (output: string) => {
  const parsed = parseFlat(output)
  const content = parsed.payloads.content || ""
  return {
    path: parsed.fields.path,
    type: parsed.fields.type,
    offset: Number(parsed.fields.offset),
    limit: Number(parsed.fields.limit),
    total: Number(parsed.fields.total),
    hasMore: parsed.fields.has_more === "true",
    nextOffset: parsed.fields.next_offset ? Number(parsed.fields.next_offset) : undefined,
    lines: content.length === 0 ? [] : content.split("\n"),
    contentBytes: Number(parsed.fields.content_bytes),
  }
}

const parseList = (output: string) => {
  const parsed = parseFlat(output)
  const entries = parsed.payloads.entries || ""
  return {
    path: parsed.fields.path,
    type: parsed.fields.type,
    offset: Number(parsed.fields.offset),
    limit: Number(parsed.fields.limit),
    total: Number(parsed.fields.total),
    hasMore: parsed.fields.has_more === "true",
    nextOffset: parsed.fields.next_offset ? Number(parsed.fields.next_offset) : undefined,
    entries: entries.length === 0 ? [] : entries.split("\n"),
    entriesBytes: Number(parsed.fields.entries_bytes),
  }
}

const parseGlob = (output: string) => {
  const parsed = parseFlat(output)
  const entries = parsed.payloads.entries || ""
  return {
    path: parsed.fields.path,
    type: parsed.fields.type,
    pattern: parsed.fields.pattern,
    offset: Number(parsed.fields.offset),
    limit: Number(parsed.fields.limit),
    total: Number(parsed.fields.total),
    hasMore: parsed.fields.has_more === "true",
    nextOffset: parsed.fields.next_offset ? Number(parsed.fields.next_offset) : undefined,
    entries: entries.length === 0 ? [] : entries.split("\n").filter(Boolean),
    entriesBytes: Number(parsed.fields.entries_bytes),
  }
}

const parseGrep = (output: string) => {
  const parsed = parseFlat(output)
  const total = Number(parsed.fields.total)
  const count = Number(parsed.fields.limit)
  const matches = Array.from({ length: count }, (_, index) => ({
    path: parsed.fields[`matches_${index}_path`],
    line: Number(parsed.fields[`matches_${index}_line`]),
    text: parsed.payloads[`matches_${index}_content`] || "",
  }))
  return {
    path: parsed.fields.path,
    pattern: parsed.fields.pattern,
    offset: Number(parsed.fields.offset),
    limit: count,
    total,
    hasMore: parsed.fields.has_more === "true",
    nextOffset: parsed.fields.next_offset ? Number(parsed.fields.next_offset) : undefined,
    files: Number(parsed.fields.matches_files),
    matches,
  }
}

const parseCreate = (output: string) => parseFlat(output).fields
const parseEdit = (output: string) => parseFlat(output).fields

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-tools-"))
  outsideTmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-tools-outside-"))
  linkSupport = await detectLinkSupport(path.join(tmp, "tools-link-check"))

  await fs.writeFile(path.join(tmp, "hello.txt"), "line 1\nline 2\nline 3\nline 4\nline 5\n")
  await fs.writeFile(path.join(tmp, "empty.txt"), "")
  await fs.writeFile(path.join(tmp, "search-me.ts"), 'const foo = "bar"\nconst baz = "qux"\nfoo()\n')
  await fs.writeFile(path.join(tmp, "multi-match.ts"), "foo one\nfoo two\nfoo three\n")
  await fs.writeFile(path.join(tmp, "literal.txt"), "#header: value\n<tag>\n\nplain text\n")
  await fs.writeFile(path.join(outsideTmp, "outside-read.txt"), "outside\n")
  await fs.writeFile(path.join(outsideTmp, "outside-edit.txt"), "outside edit\n")
  await fs.writeFile(path.join(outsideTmp, "outside-write.txt"), "outside write\n")

  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "index.ts"), 'export const main = () => "hello"\n')
  await fs.writeFile(path.join(tmp, "src", "MixedCase.TS"), "export const MIXED = true\n")
  await fs.writeFile(path.join(tmp, "src", "utils.ts"), "export const add = (a: number, b: number) => a + b\n")
  await fs.mkdir(path.join(tmp, "src", "lib"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "lib", "helper.ts"), "export function help() {}\n")
  await fs.writeFile(path.join(tmp, "src", "existing.ts"), "existing\n")
  await fs.mkdir(path.join(tmp, "src", "existing-dir"), { recursive: true })
  if (linkSupport.fileSymlinks) {
    await createLink(path.join(outsideTmp, "outside-read.txt"), path.join(tmp, "read-link.txt"))
    await createLink(path.join(outsideTmp, "outside-edit.txt"), path.join(tmp, "edit-link.txt"))
    await createLink(path.join(outsideTmp, "outside-write.txt"), path.join(tmp, "write-link.txt"))
    await createLink(path.join(tmp, "search-me.ts"), path.join(tmp, "search-link.ts"))
  }
  if (linkSupport.dirLinks) {
    await createLink(outsideTmp, path.join(tmp, "linked-outside-dir"), "dir")
  }

  const buf = Buffer.alloc(64)
  buf[0] = 0
  await fs.writeFile(path.join(tmp, "data.bin"), buf)

  await fs.mkdir(path.join(tmp, "node_modules"), { recursive: true })
  await fs.writeFile(path.join(tmp, "node_modules", "dep.js"), "module.exports = {}\n")

  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
  await fs.writeFile(path.join(tmp, "big.txt"), lines.join("\n") + "\n")

  const now = new Date()
  const times = [
    ["hello.txt", -60_000],
    ["empty.txt", -50_000],
    ["search-me.ts", -40_000],
    [path.join("src", "lib", "helper.ts"), -30_000],
    [path.join("src", "utils.ts"), -20_000],
    [path.join("src", "index.ts"), -10_000],
    [path.join("src", "MixedCase.TS"), -12_000],
    ["big.txt", 0],
    [path.join("node_modules", "dep.js"), -2_000],
    ["multi-match.ts", 10_000],
    ["data.bin", -5_000],
    [path.join("src", "existing.ts"), -15_000],
    ["literal.txt", -25_000],
  ] as const
  for (const [file, offset] of times) {
    const time = new Date(now.getTime() + offset)
    await fs.utimes(path.join(tmp, file), time, time)
  }

  const mockCtl = {
    getPluginConfig: () => ({
      get: (key: string) => key === "sandboxBaseDir" ? tmp : undefined,
    }),
  } as any

  const toolList = await toolsProvider(mockCtl)
  tools = {}
  for (const t of toolList) {
    tools[(t as any).name] = (params: any) => (t as any).implementation(params)
  }
})

beforeEach(() => {
  delete process.env.LMS_FILESYSTEM_IGNORE_PATHS
})

afterAll(async () => {
  delete process.env.LMS_FILESYSTEM_IGNORE_PATHS
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.rm(outsideTmp, { recursive: true, force: true })
})

describe("read tool", () => {
  it("reads a text file with line numbers", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "hello.txt") })
    expect(parseRead(result)).toEqual({
      path: path.join(tmp, "hello.txt"),
      type: "file",
      offset: 1,
      limit: 5,
      total: 5,
      hasMore: false,
      nextOffset: undefined,
      lines: ["1: line 1", "2: line 2", "3: line 3", "4: line 4", "5: line 5"],
      contentBytes: Buffer.byteLength("1: line 1\n2: line 2\n3: line 3\n4: line 4\n5: line 5", "utf8"),
    })
  })

  it("supports offset and limit", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "big.txt"), offset: 10, limit: 5 })
    expect(parseRead(result)).toEqual({
      path: path.join(tmp, "big.txt"),
      type: "file",
      offset: 10,
      limit: 5,
      total: 100,
      hasMore: true,
      nextOffset: 15,
      lines: ["10: line 10", "11: line 11", "12: line 12", "13: line 13", "14: line 14"],
      contentBytes: Buffer.byteLength("10: line 10\n11: line 11\n12: line 12\n13: line 13\n14: line 14", "utf8"),
    })
  })

  it("frames raw content without escaping", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "literal.txt") })
    expect(parseRead(result).lines).toEqual([
      "1: #header: value",
      "2: <tag>",
      "3: ",
      "4: plain text",
    ])
  })

  it("returns error for missing file", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "nope.txt") })
    expect(parseError(result).code).toBe("not_found")
  })

  it("returns error for directory path", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "src") })
    expect(parseError(result)).toMatchObject({
      code: "wrong_type",
      message: "Path is not a file",
      path: path.join(tmp, "src"),
      expected: "file",
      actual: "directory",
    })
  })

  it("returns error for binary file", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "data.bin") })
    expect(parseError(result)).toMatchObject({
      code: "binary_file",
      path: path.join(tmp, "data.bin"),
    })
  })

  it("returns filesystem_error for root file symlink reads", async () => {
    if (!linkSupport.fileSymlinks) return
    const result = await tools.read({ filePath: path.join(tmp, "read-link.txt") })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: path.join(tmp, "read-link.txt"),
    })
  })

  it("returns filesystem_error for file reads through root directory symlinks", async () => {
    if (!linkSupport.dirLinks) return
    const result = await tools.read({ filePath: path.join(tmp, "linked-outside-dir", "outside-read.txt") })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: path.join(tmp, "linked-outside-dir", "outside-read.txt"),
    })
  })

  it("returns error for out-of-range offset", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "hello.txt"), offset: 999 })
    expect(parseError(result)).toMatchObject({
      code: "out_of_range",
      parameter: "offset",
      value: "999",
      total: "5",
      unit: "lines",
    })
  })

  it("handles empty file", async () => {
    const result = await tools.read({ filePath: path.join(tmp, "empty.txt") })
    expect(parseRead(result)).toEqual({
      path: path.join(tmp, "empty.txt"),
      type: "file",
      offset: 1,
      limit: 0,
      total: 0,
      hasMore: false,
      nextOffset: undefined,
      lines: [],
      contentBytes: 0,
    })
  })
})

describe("list tool", () => {
  it("lists top-level entries by default", async () => {
    const result = await tools.list({ path: tmp })
    const parsed = parseList(result)
    expect(parsed.entries).toContain("  hello.txt")
    expect(parsed.entries).toContain("  src/")
    expect(parsed.entries).not.toContain("    index.ts")
  })

  it("lists recursively with tree format", async () => {
    const result = await tools.list({ path: tmp, recursive: true })
    expect(parseList(result)).toEqual({
      path: tmp,
      type: "directory",
      offset: 1,
      limit: 15,
      total: 15,
      hasMore: false,
      nextOffset: undefined,
      entries: [
        `${tmp}/`,
        "  src/",
        "    existing-dir/",
        "    lib/",
        "      helper.ts",
        "    existing.ts",
        "    index.ts",
        "    MixedCase.TS",
        "    utils.ts",
        "  big.txt",
        "  data.bin",
        "  empty.txt",
        "  hello.txt",
        "  literal.txt",
        "  multi-match.ts",
        "  search-me.ts",
      ],
      entriesBytes: Buffer.byteLength([
        `${tmp}/`,
        "  src/",
        "    existing-dir/",
        "    lib/",
        "      helper.ts",
        "    existing.ts",
        "    index.ts",
        "    MixedCase.TS",
        "    utils.ts",
        "  big.txt",
        "  data.bin",
        "  empty.txt",
        "  hello.txt",
        "  literal.txt",
        "  multi-match.ts",
        "  search-me.ts",
      ].join("\n"), "utf8"),
    })
  })

  it("filters by type: files", async () => {
    const result = await tools.list({ path: tmp, type: "files" })
    const parsed = parseList(result)
    expect(parsed.entries).not.toContain("  src/")
    expect(parsed.entries).toContain("  hello.txt")
  })

  it("filters by type: directories", async () => {
    const result = await tools.list({ path: tmp, type: "directories" })
    const parsed = parseList(result)
    expect(parsed.entries).toContain("  src/")
    expect(parsed.entries).not.toContain("  hello.txt")
  })

  it("is the directory discovery tool for nested directories", async () => {
    const result = await tools.list({ path: tmp, recursive: true, type: "directories" })
    expect(parseList(result).entries).toEqual([
      `${tmp}/`,
      "  src/",
      "    existing-dir/",
      "    lib/",
    ])
  })

  it("skips default-ignored directories", async () => {
    const result = await tools.list({ path: tmp, recursive: true })
    expect(result).not.toContain("node_modules")
    expect(result).not.toContain("dep.js")
  })

  it("respects ignore patterns", async () => {
    const result = await tools.list({ path: tmp, ignore: ["*.txt"] })
    const parsed = parseList(result)
    expect(parsed.entries).not.toContain("  hello.txt")
    expect(parsed.entries).not.toContain("  big.txt")
    expect(parsed.entries).toContain("  src/")
  })

  it("returns error for missing directory", async () => {
    const result = await tools.list({ path: path.join(tmp, "nope") })
    expect(parseError(result).code).toBe("not_found")
  })

  it("returns error for out-of-range offset", async () => {
    const result = await tools.list({ path: tmp, offset: 999 })
    expect(parseError(result).code).toBe("out_of_range")
  })

  it("supports pagination", async () => {
    const result = await tools.list({ path: tmp, limit: 2 })
    expect(parseList(result)).toEqual({
      path: tmp,
      type: "directory",
      offset: 1,
      limit: 2,
      total: 8,
      hasMore: true,
      nextOffset: 3,
      entries: [`${tmp}/`, "  big.txt", "  data.bin"],
      entriesBytes: Buffer.byteLength([`${tmp}/`, "  big.txt", "  data.bin"].join("\n"), "utf8"),
    })
  })

  it("returns top-level directory results in path-ascending order", async () => {
    const result = await tools.list({ path: tmp, type: "directories" })
    expect(parseList(result).entries).toEqual([
      `${tmp}/`,
      "  src/",
    ])
  })

  it("returns filesystem_error for root directory symlink list roots", async () => {
    if (!linkSupport.dirLinks) return
    const result = await tools.list({ path: path.join(tmp, "linked-outside-dir") })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: path.join(tmp, "linked-outside-dir"),
    })
  })
})

describe("glob tool", () => {
  it("matches files by pattern", async () => {
    const result = await tools.glob({ pattern: "*.txt", path: tmp })
    expect(parseGlob(result)).toEqual({
      path: tmp,
      type: "files",
      pattern: "*.txt",
      offset: 1,
      limit: 4,
      total: 4,
      hasMore: false,
      nextOffset: undefined,
      entries: [
        path.join(tmp, "big.txt"), // matched by pattern *.txt
        path.join(tmp, "literal.txt"), // matched by pattern *.txt
        path.join(tmp, "empty.txt"), // matched by pattern *.txt
        path.join(tmp, "hello.txt"), // matched by pattern *.txt
      ],
      entriesBytes: Buffer.byteLength([
        path.join(tmp, "big.txt"),
        path.join(tmp, "literal.txt"),
        path.join(tmp, "empty.txt"),
        path.join(tmp, "hello.txt"),
      ].join("\n"), "utf8"),
    })
  })

  it("matches nested files with **", async () => {
    const result = await tools.glob({ pattern: "**/*.ts", path: tmp })
    expect(parseGlob(result).entries).toEqual([
      path.join(tmp, "multi-match.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "index.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "existing.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "utils.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "lib", "helper.ts"), // matched by pattern **/*.ts
      path.join(tmp, "search-me.ts"), // matched by pattern **/*.ts
    ])
  })

  it("matches basename file patterns at any depth", async () => {
    const result = await tools.glob({ pattern: "*.ts", path: tmp })
    expect(parseGlob(result).entries).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "src", "index.ts"),
      path.join(tmp, "src", "existing.ts"),
      path.join(tmp, "src", "utils.ts"),
      path.join(tmp, "src", "lib", "helper.ts"),
      path.join(tmp, "search-me.ts"),
    ])
  })

  it("returns no results for unmatched pattern", async () => {
    const result = await tools.glob({ pattern: "*.xyz", path: tmp })
    expect(parseGlob(result).entries).toEqual([])
  })

  it("applies include and exclude file filters to glob results", async () => {
    const result = await tools.glob({ pattern: "**/*.ts", path: tmp, include: ["**/src/**"], exclude: ["src/lib/**"] })
    expect(parseGlob(result).entries).toEqual([
      path.join(tmp, "multi-match.ts"),
      path.join(tmp, "src", "index.ts"),
      path.join(tmp, "src", "MixedCase.TS"),
      path.join(tmp, "src", "existing.ts"),
      path.join(tmp, "src", "utils.ts"),
      path.join(tmp, "search-me.ts"),
    ])
  })

  it("respects exclude filter for file matching", async () => {
    const result = await tools.glob({ pattern: "**/*.ts", path: tmp, exclude: ["src/lib", "src/lib/**"] })
    expect(parseGlob(result).entries).toEqual([
      path.join(tmp, "multi-match.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "index.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "existing.ts"), // matched by pattern **/*.ts
      path.join(tmp, "src", "utils.ts"), // matched by pattern **/*.ts
      path.join(tmp, "search-me.ts"), // matched by pattern **/*.ts (src/lib/helper.ts excluded)
    ])
  })

  it("supports pagination", async () => {
    const result = await tools.glob({ pattern: "**/*", path: tmp, limit: 2 })
    const parsed = parseGlob(result)
    expect(parsed.type).toBe("files")
    expect(parsed.limit).toBe(2)
    expect(parsed.hasMore).toBe(true)
    expect(parsed.nextOffset).toBe(3)
  })

  it("returns error for out-of-range offset", async () => {
    const result = await tools.glob({ pattern: "**/*", path: tmp, offset: 999 })
    expect(parseError(result).code).toBe("out_of_range")
  })

  it("returns error for missing directory", async () => {
    const result = await tools.glob({ pattern: "*", path: path.join(tmp, "nope") })
    expect(parseError(result).code).toBe("not_found")
  })

  it("returns filesystem_error for root directory symlink glob roots", async () => {
    if (!linkSupport.dirLinks) return
    const result = await tools.glob({ pattern: "*", path: path.join(tmp, "linked-outside-dir") })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: path.join(tmp, "linked-outside-dir"),
    })
  })
})

describe("grep tool", () => {
  it("finds matches in files", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp })
    expect(parseGrep(result)).toEqual({
      path: tmp,
      pattern: "foo",
      offset: 1,
      limit: 5,
      total: 5,
      hasMore: false,
      nextOffset: undefined,
      files: 2,
      matches: [
        { path: path.join(tmp, "multi-match.ts"), line: 1, text: "foo one" },
        { path: path.join(tmp, "multi-match.ts"), line: 2, text: "foo two" },
        { path: path.join(tmp, "multi-match.ts"), line: 3, text: "foo three" },
        { path: path.join(tmp, "search-me.ts"), line: 1, text: 'const foo = "bar"' },
        { path: path.join(tmp, "search-me.ts"), line: 3, text: "foo()" },
      ],
    })
  })

  it("returns line numbers", async () => {
    const result = await tools.grep({ pattern: "baz", path: tmp })
    expect(parseGrep(result)).toEqual({
      path: tmp,
      pattern: "baz",
      offset: 1,
      limit: 1,
      total: 1,
      hasMore: false,
      nextOffset: undefined,
      files: 1,
      matches: [{ path: path.join(tmp, "search-me.ts"), line: 2, text: 'const baz = "qux"' }],
    })
  })

  it("searches recursively", async () => {
    const result = await tools.grep({ pattern: "hello", path: tmp })
    expect(parseGrep(result)).toEqual({
      path: tmp,
      pattern: "hello",
      offset: 1,
      limit: 1,
      total: 1,
      hasMore: false,
      nextOffset: undefined,
      files: 1,
      matches: [{ path: path.join(tmp, "src", "index.ts"), line: 1, text: 'export const main = () => "hello"' }],
    })
  })

  it("applies case-sensitive include filters", async () => {
    const result = await tools.grep({ pattern: "export", path: tmp, include: ["**/*.ts"] })
    expect(parseGrep(result).matches).toEqual([
      { path: path.join(tmp, "src", "index.ts"), line: 1, text: 'export const main = () => "hello"' },
      { path: path.join(tmp, "src", "utils.ts"), line: 1, text: "export const add = (a: number, b: number) => a + b" },
      { path: path.join(tmp, "src", "lib", "helper.ts"), line: 1, text: "export function help() {}" },
    ])
  })

  it("treats include globs as a union with the searched file set", async () => {
    const result = await tools.grep({ pattern: "export", path: tmp, include: ["**/src/**"] })
    expect(parseGrep(result).matches).toEqual([
      { path: path.join(tmp, "src", "index.ts"), line: 1, text: 'export const main = () => "hello"' },
      { path: path.join(tmp, "src", "MixedCase.TS"), line: 1, text: "export const MIXED = true" },
      { path: path.join(tmp, "src", "utils.ts"), line: 1, text: "export const add = (a: number, b: number) => a + b" },
      { path: path.join(tmp, "src", "lib", "helper.ts"), line: 1, text: "export function help() {}" },
    ])
  })

  it("respects exclude filter", async () => {
    const result = await tools.grep({ pattern: "export", path: tmp, exclude: ["src/lib", "src/lib/**"] })
    expect(parseGrep(result).matches).toEqual([
      { path: path.join(tmp, "src", "index.ts"), line: 1, text: 'export const main = () => "hello"' },
      { path: path.join(tmp, "src", "MixedCase.TS"), line: 1, text: "export const MIXED = true" },
      { path: path.join(tmp, "src", "utils.ts"), line: 1, text: "export const add = (a: number, b: number) => a + b" },
    ])
  })

  it("returns raw match content without escaping", async () => {
    const result = await tools.grep({ pattern: "#header|<tag>", path: tmp, include: ["literal.txt"] })
    expect(parseGrep(result).matches).toEqual([
      { path: path.join(tmp, "literal.txt"), line: 1, text: "#header: value" },
      { path: path.join(tmp, "literal.txt"), line: 2, text: "<tag>" },
    ])
  })

  it("skips binary files", async () => {
    const result = await tools.grep({ pattern: ".*", path: tmp })
    expect(result).not.toContain("data.bin")
  })

  it("ignores nested symlinked files", async () => {
    if (!linkSupport.fileSymlinks) return
    const result = await tools.grep({ pattern: "foo", path: tmp, include: ["**/*link.ts"] })
    expect(parseGrep(result).matches).toEqual([])
  })

  it("returns empty match metadata when nothing matches", async () => {
    const result = await tools.grep({ pattern: "zzzznotfound", path: tmp })
    expect(parseGrep(result)).toEqual({
      path: tmp,
      pattern: "zzzznotfound",
      offset: 1,
      limit: 0,
      total: 0,
      hasMore: false,
      nextOffset: undefined,
      files: 0,
      matches: [],
    })
  })

  it("sorts matches by file mtime then line order", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp })
    expect(parseGrep(result).matches.map((match) => `${path.basename(match.path)}:${match.line}`)).toEqual([
      "multi-match.ts:1",
      "multi-match.ts:2",
      "multi-match.ts:3",
      "search-me.ts:1",
      "search-me.ts:3",
    ])
  })

  it("returns error for invalid regex", async () => {
    const result = await tools.grep({ pattern: "[invalid", path: tmp })
    expect(parseError(result).code).toBe("invalid_pattern")
  })

  it("returns error for missing directory", async () => {
    const result = await tools.grep({ pattern: "test", path: path.join(tmp, "nope") })
    expect(parseError(result).code).toBe("not_found")
  })

  it("returns filesystem_error for root directory symlink grep roots", async () => {
    if (!linkSupport.dirLinks) return
    const result = await tools.grep({ pattern: "test", path: path.join(tmp, "linked-outside-dir") })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: path.join(tmp, "linked-outside-dir"),
    })
  })

  it("paginates results with offset and limit", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp, offset: 2, limit: 2 })
    const parsed = parseGrep(result)
    expect(parsed.offset).toBe(2)
    expect(parsed.limit).toBe(2)
    expect(parsed.total).toBe(5)
    expect(parsed.hasMore).toBe(true)
    expect(parsed.nextOffset).toBe(4)
    expect(parsed.matches).toEqual([
      { path: path.join(tmp, "multi-match.ts"), line: 2, text: "foo two" },
      { path: path.join(tmp, "multi-match.ts"), line: 3, text: "foo three" },
    ])
  })

  it("returns last page without next_offset", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp, offset: 4, limit: 10 })
    const parsed = parseGrep(result)
    expect(parsed.offset).toBe(4)
    expect(parsed.limit).toBe(2)
    expect(parsed.total).toBe(5)
    expect(parsed.hasMore).toBe(false)
    expect(parsed.nextOffset).toBeUndefined()
    expect(parsed.matches).toHaveLength(2)
  })

  it("returns out_of_range for offset beyond total", async () => {
    const result = await tools.grep({ pattern: "foo", path: tmp, offset: 100 })
    expect(parseError(result).code).toBe("out_of_range")
  })

  it("counts files only within the current page", async () => {
    const page1 = await tools.grep({ pattern: "foo", path: tmp, limit: 3 })
    expect(parseGrep(page1).files).toBe(1)
    const page2 = await tools.grep({ pattern: "foo", path: tmp, offset: 4, limit: 3 })
    expect(parseGrep(page2).files).toBe(1)
  })
})

describe("create tool", () => {
  it("creates a new file with content", async () => {
    const target = path.join(tmp, "created.txt")
    const result = await tools.create({ type: "file", path: target, fileContent: "hello\nworld\n" })
    expect(parseCreate(result)).toEqual({
      path: target,
      type: "file",
      status: "created",
      fileEncoding: "utf8",
      overwritten: "false",
      lines: "2",
      bytes: String(Buffer.byteLength("hello\nworld\n", "utf8")),
    })
    expect(await fs.readFile(target, "utf8")).toBe("hello\nworld\n")
  })

  it("creates a new empty file when content is omitted", async () => {
    const target = path.join(tmp, "created-empty.txt")
    const result = await tools.create({ type: "file", path: target })
    expect(parseCreate(result)).toEqual({
      path: target,
      type: "file",
      status: "created",
      fileEncoding: "utf8",
      overwritten: "false",
      lines: "0",
      bytes: "0",
    })
    expect(await fs.readFile(target, "utf8")).toBe("")
  })

  it("creates parent directories automatically for files", async () => {
    const target = path.join(tmp, "deep", "nested", "dir", "file.txt")
    const result = await tools.create({ type: "file", path: target, fileContent: "hi" })
    expect(parseCreate(result).path).toBe(target)
    expect(await fs.readFile(target, "utf8")).toBe("hi")
  })

  it("returns error when file already exists", async () => {
    const target = path.join(tmp, "src", "existing.ts")
    const result = await tools.create({ type: "file", path: target, fileContent: "new" })
    expect(parseError(result).code).toBe("already_exists")
  })

  it("overwrites existing file when overwrite is true", async () => {
    const target = path.join(tmp, "src", "existing-overwrite.ts")
    await fs.writeFile(target, "old\n")
    const result = await tools.create({ type: "file", path: target, fileContent: "new\n", overwriteFile: true })
    expect(parseCreate(result)).toMatchObject({
      path: target,
      overwritten: "true",
      lines: "1",
    })
    expect(await fs.readFile(target, "utf8")).toBe("new\n")
  })

  it("creates a file with base64 encoding", async () => {
    const data = Buffer.from("binary data")
    const target = path.join(tmp, "created.bin")
    const result = await tools.create({ type: "file", path: target, fileContent: data.toString("base64"), fileEncoding: "base64" })
    expect(parseCreate(result)).toMatchObject({
      path: target,
      fileEncoding: "base64",
      bytes: String(data.byteLength),
    })
    expect((await fs.readFile(target)).equals(data)).toBe(true)
  })

  it("returns structured error when file target is an existing directory", async () => {
    const target = path.join(tmp, "src", "existing-dir")
    const result = await tools.create({ type: "file", path: target, overwriteFile: true })
    expect(parseError(result)).toMatchObject({
      code: "wrong_type",
      expected: "file",
      actual: "directory",
      path: target,
    })
  })

  it("returns filesystem_error for root file symlink create targets", async () => {
    if (!linkSupport.fileSymlinks) return
    const target = path.join(tmp, "write-link.txt")
    const result = await tools.create({ type: "file", path: target, fileContent: "new", overwriteFile: true })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: target,
    })
  })

  it("returns filesystem_error when file creation crosses a symlinked parent", async () => {
    if (!linkSupport.dirLinks) return
    const target = path.join(tmp, "linked-outside-dir", "new.txt")
    const result = await tools.create({ type: "file", path: target, fileContent: "new" })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: target,
    })
  })

  it("creates a new directory", async () => {
    const target = path.join(tmp, "new-dir")
    const result = await tools.create({ type: "directory", path: target })
    expect(parseCreate(result)).toEqual({
      path: target,
      type: "directory",
      status: "created",
      recursive: "true",
    })
  })

  it("creates nested directories recursively by default", async () => {
    const target = path.join(tmp, "a", "b", "c", "d")
    const result = await tools.create({ type: "directory", path: target })
    expect(parseCreate(result).recursive).toBe("true")
  })

  it("returns error when directory already exists", async () => {
    const target = path.join(tmp, "src", "existing-dir")
    const result = await tools.create({ type: "directory", path: target })
    expect(parseError(result).code).toBe("already_exists")
  })

  it("returns error when directory target is an existing file", async () => {
    const target = path.join(tmp, "src", "existing.ts")
    const result = await tools.create({ type: "directory", path: target })
    expect(parseError(result)).toMatchObject({
      code: "wrong_type",
      expected: "directory",
      actual: "file",
      path: target,
    })
  })

  it("returns error when recursive is false and parent missing", async () => {
    const target = path.join(tmp, "no-parent", "child")
    const result = await tools.create({ type: "directory", path: target, recursive: false })
    expect(parseError(result).code).toBe("filesystem_error")
  })

  it("allows file type with recursive set to false when the parent exists", async () => {
    const target = path.join(tmp, "v1.txt")
    const result = await tools.create({ type: "file", path: target, fileContent: "x", recursive: false })
    expect(parseCreate(result).path).toBe(target)
  })

  it("returns error when file type has recursive set to false and the parent is missing", async () => {
    const result = await tools.create({ type: "file", path: path.join(tmp, "no-parent-file", "v1.txt"), fileContent: "x", recursive: false })
    expect(parseError(result).code).toBe("filesystem_error")
  })

  it("allows file type with recursive set to true", async () => {
    const target = path.join(tmp, "v2.txt")
    const result = await tools.create({ type: "file", path: target, fileContent: "x", recursive: true })
    expect(parseCreate(result).path).toBe(target)
  })

  it("returns error when directory type has content set", async () => {
    const result = await tools.create({ type: "directory", path: path.join(tmp, "v3"), fileContent: "oops" })
    expect(parseError(result).code).toBe("invalid_parameter")
  })

  it("returns error when directory type has overwrite set to true", async () => {
    const result = await tools.create({ type: "directory", path: path.join(tmp, "v4"), overwriteFile: true })
    expect(parseError(result).code).toBe("invalid_parameter")
  })

  it("returns error when directory type has fileEncoding set to base64", async () => {
    const result = await tools.create({ type: "directory", path: path.join(tmp, "v5"), fileEncoding: "base64" })
    expect(parseError(result).code).toBe("invalid_parameter")
  })

  it("returns error when directory type has fileEncoding set to utf8", async () => {
    const result = await tools.create({ type: "directory", path: path.join(tmp, "v6"), fileEncoding: "utf8" })
    expect(parseError(result).code).toBe("invalid_parameter")
  })

  it("returns error when directory type has overwrite set to false", async () => {
    const result = await tools.create({ type: "directory", path: path.join(tmp, "v7"), overwriteFile: false })
    expect(parseError(result).code).toBe("invalid_parameter")
  })

  it("returns error for path outside sandbox base directory", async () => {
    const result = await tools.create({ type: "file", path: "/tmp/escape.txt", fileContent: "x" })
    expect(parseError(result).code).toBe("path_outside_base")
  })
})

describe("edit tool", () => {
  it("edits a file with one unique replacement", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "beta", newString: "delta" }] })
    expect(parseEdit(result)).toEqual({
      path: target,
      type: "file",
      status: "edited",
      fileEncoding: "utf8",
      changes_requested: "1",
      changes_performed: "1",
    })
    expect(await fs.readFile(target, "utf8")).toBe("alpha\ndelta\ngamma\n")
  })

  it("applies multiple edits in order", async () => {
    const target = path.join(tmp, "edit-chain.txt")
    await fs.writeFile(target, "start middle end\n")
    const result = await tools.edit({
      filePath: target,
      edits: [
        { oldString: "middle", newString: "center" },
        { oldString: "center end", newString: "finish" },
      ],
    })
    expect(parseEdit(result).changes_requested).toBe("2")
    expect(await fs.readFile(target, "utf8")).toBe("start finish\n")
  })

  it("replaces all matches when replaceAll is true", async () => {
    const target = path.join(tmp, "edit-many.txt")
    await fs.writeFile(target, "foo\nfoo\nfoo\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "foo", newString: "bar", replaceAll: true }] })
    expect(parseEdit(result).changes_performed).toBe("1")
    expect(await fs.readFile(target, "utf8")).toBe("bar\nbar\nbar\n")
  })

  it("allows newString to be empty", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    await tools.edit({ filePath: target, edits: [{ oldString: "beta\n", newString: "" }] })
    expect(await fs.readFile(target, "utf8")).toBe("alpha\ngamma\n")
  })

  it("can empty a file by replacing the full content with an empty string", async () => {
    const target = path.join(tmp, "edit-empty-target.txt")
    await fs.writeFile(target, "erase me\n")
    await tools.edit({ filePath: target, edits: [{ oldString: "erase me\n", newString: "" }] })
    expect(await fs.readFile(target, "utf8")).toBe("")
  })

  it("returns error when oldString is empty", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "", newString: "delta" }] })
    expect(parseError(result).code).toBe("invalid_parameter")
  })

  it("returns error when oldString and newString are identical", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "beta", newString: "beta" }] })
    expect(parseError(result).code).toBe("no_change")
  })

  it("returns error when oldString is not found", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "missing", newString: "delta" }] })
    expect(parseError(result).code).toBe("match_not_found")
  })

  it("returns error when multiple matches exist and replaceAll is not true", async () => {
    const target = path.join(tmp, "edit-many.txt")
    await fs.writeFile(target, "foo\nfoo\nfoo\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "foo", newString: "bar" }] })
    expect(parseError(result).code).toBe("ambiguous_match")
  })

  it("keeps the file unchanged when a later edit fails", async () => {
    const target = path.join(tmp, "edit-chain.txt")
    const original = "start middle end\n"
    await fs.writeFile(target, original)
    const result = await tools.edit({
      filePath: target,
      edits: [
        { oldString: "middle", newString: "center" },
        { oldString: "missing", newString: "unused" },
      ],
    })
    expect(parseError(result).code).toBe("match_not_found")
    expect(await fs.readFile(target, "utf8")).toBe(original)
  })

  it("returns error when file does not exist", async () => {
    const target = path.join(tmp, "no-edit.txt")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "a", newString: "b" }] })
    expect(parseError(result).code).toBe("not_found")
  })

  it("returns error when path is a directory", async () => {
    const target = path.join(tmp, "src")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "a", newString: "b" }] })
    expect(parseError(result).code).toBe("wrong_type")
  })

  it("returns error for binary file", async () => {
    const target = path.join(tmp, "data.bin")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "a", newString: "b" }] })
    expect(parseError(result).code).toBe("binary_file")
  })

  it("returns filesystem_error for root file symlink edits", async () => {
    if (!linkSupport.fileSymlinks) return
    const target = path.join(tmp, "edit-link.txt")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "outside", newString: "inside" }] })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: target,
    })
  })

  it("returns filesystem_error for edits through root directory symlinks", async () => {
    if (!linkSupport.dirLinks) return
    const target = path.join(tmp, "linked-outside-dir", "outside-edit.txt")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "outside", newString: "inside" }] })
    expect(parseError(result)).toMatchObject({
      code: "filesystem_error",
      path: target,
    })
  })

  it("returns error for path outside sandbox base directory", async () => {
    const result = await tools.edit({ filePath: "/tmp/escape.txt", edits: [{ oldString: "a", newString: "b" }] })
    expect(parseError(result).code).toBe("path_outside_base")
  })

  it("uses utf8 by default", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "alpha", newString: "omega" }] })
    expect(parseEdit(result).fileEncoding).toBe("utf8")
  })

  it("accepts encoding utf8 explicitly", async () => {
    const target = path.join(tmp, "edit-one.txt")
    await fs.writeFile(target, "alpha\nbeta\ngamma\n")
    const result = await tools.edit({ filePath: target, edits: [{ oldString: "gamma", newString: "theta" }], fileEncoding: "utf8" })
    expect(parseEdit(result).fileEncoding).toBe("utf8")
  })
})
