import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  expandHome,
  resolvePath,
  relPath,
  compile,
  ignored,
  blocked,
  walk,
  binary,
  formatTree,
  DEFAULT_IGNORES,
} from "./utils"

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-test-"))

  // files
  await fs.writeFile(path.join(tmp, "hello.txt"), "hello world\n")
  await fs.writeFile(path.join(tmp, "empty.txt"), "")
  await fs.writeFile(path.join(tmp, "long-line.txt"), "x".repeat(5000) + "\n")

  // nested dirs
  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "index.ts"), 'console.log("hi")\n')
  await fs.writeFile(path.join(tmp, "src", "utils.ts"), "export const foo = 1\n")
  await fs.mkdir(path.join(tmp, "src", "lib"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "lib", "helper.ts"), "export function help() {}\n")

  // default-ignored dir
  await fs.mkdir(path.join(tmp, "node_modules"), { recursive: true })
  await fs.writeFile(path.join(tmp, "node_modules", "pkg.js"), "module.exports = {}\n")

  // binary file (null bytes)
  const buf = Buffer.alloc(64)
  buf[0] = 0
  buf[1] = 0
  await fs.writeFile(path.join(tmp, "image.bin"), buf)

  // binary by extension
  await fs.writeFile(path.join(tmp, "photo.png"), "not really a png")

  // binary by control-char ratio
  await fs.writeFile(
    path.join(tmp, "control-chars.txt"),
    Buffer.from([1, 2, 3, 4, 5, 6, 65, 66, 67, 68]),
  )

  // dotfile
  await fs.writeFile(path.join(tmp, ".hidden"), "secret\n")

  // deeply nested
  await fs.mkdir(path.join(tmp, "a", "b", "c"), { recursive: true })
  await fs.writeFile(path.join(tmp, "a", "b", "c", "deep.txt"), "deep\n")

  // symlink
  await fs.symlink(path.join(tmp, "hello.txt"), path.join(tmp, "hello-link.txt"))
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// expandHome
// ---------------------------------------------------------------------------
describe("expandHome", () => {
  it("expands ~ to homedir", () => {
    expect(expandHome("~")).toBe(os.homedir())
  })

  it("expands ~/path", () => {
    expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"))
  })

  it("leaves absolute paths alone", () => {
    expect(expandHome("/usr/local")).toBe("/usr/local")
  })

  it("leaves relative paths alone", () => {
    expect(expandHome("foo/bar")).toBe("foo/bar")
  })
})

// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------
describe("resolvePath", () => {
  it("resolves a relative path within base", () => {
    const result = resolvePath(tmp, "src")
    expect(result).toBe(path.join(tmp, "src"))
  })

  it("resolves . to base itself", () => {
    expect(resolvePath(tmp)).toBe(tmp)
  })

  it("throws for paths outside base", () => {
    expect(() => resolvePath(tmp, "../..")).toThrow("outside the configured base directory")
  })

  it("throws for absolute paths outside base", () => {
    expect(() => resolvePath(tmp, "/etc/passwd")).toThrow("outside the configured base directory")
  })
})

// ---------------------------------------------------------------------------
// relPath
// ---------------------------------------------------------------------------
describe("relPath", () => {
  it("returns relative forward-slash path", () => {
    expect(relPath(tmp, path.join(tmp, "src", "index.ts"))).toBe("src/index.ts")
  })

  it("returns . for same path", () => {
    expect(relPath(tmp, tmp)).toBe(".")
  })
})

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------
describe("compile", () => {
  it("returns empty array for undefined", () => {
    expect(compile()).toHaveLength(0)
  })

  it("compiles patterns into Minimatch instances", () => {
    const matchers = compile(["*.ts", "dist/**"])
    expect(matchers).toHaveLength(2)
    expect(matchers[0].match("foo.ts")).toBe(true)
    expect(matchers[0].match("foo.js")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ignored
// ---------------------------------------------------------------------------
describe("ignored", () => {
  it("ignores default dirs like node_modules", () => {
    expect(ignored("node_modules/pkg.js", "pkg.js", [])).toBe(true)
  })

  it("ignores nested default dirs", () => {
    expect(ignored("foo/node_modules/bar.js", "bar.js", [])).toBe(true)
  })

  it("does not ignore normal paths", () => {
    expect(ignored("src/index.ts", "index.ts", [])).toBe(false)
  })

  it("respects custom matchers", () => {
    const matchers = compile(["*.log"])
    expect(ignored("app.log", "app.log", matchers)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// blocked
// ---------------------------------------------------------------------------
describe("blocked", () => {
  it("blocks system paths when base is /", () => {
    expect(blocked("/dev", "/")).toBe(true)
    expect(blocked("/dev/null", "/")).toBe(true)
    expect(blocked("/proc", "/")).toBe(true)
    expect(blocked("/Volumes", "/")).toBe(true)
  })

  it("does not block when base is not /", () => {
    expect(blocked("/dev", "/home/user")).toBe(false)
  })

  it("does not block normal paths", () => {
    expect(blocked("/home/user/file.txt", "/")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// walk
// ---------------------------------------------------------------------------
describe("walk", () => {
  it("lists all entries recursively by default", async () => {
    const items = await walk(tmp)
    const names = items.map((i) => relPath(tmp, i.path))
    expect(names).toContain("hello.txt")
    expect(names).toContain("src")
    expect(names).toContain("src/index.ts")
    expect(names).toContain("src/lib/helper.ts")
  })

  it("skips default-ignored dirs", async () => {
    const items = await walk(tmp)
    const names = items.map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("node_modules")
    expect(names).not.toContain("node_modules/pkg.js")
  })

  it("non-recursive lists only top level", async () => {
    const items = await walk(tmp, { recursive: false })
    const names = items.map((i) => relPath(tmp, i.path))
    expect(names).toContain("hello.txt")
    expect(names).toContain("src")
    expect(names).not.toContain("src/index.ts")
  })

  it("filters by type: files", async () => {
    const items = await walk(tmp, { type: "files" })
    expect(items.every((i) => !i.dir)).toBe(true)
  })

  it("filters by type: directories", async () => {
    const items = await walk(tmp, { type: "directories" })
    expect(items.every((i) => i.dir)).toBe(true)
  })

  it("respects include filter", async () => {
    const items = await walk(tmp, { type: "files", include: ["*.ts"] })
    expect(items.every((i) => i.path.endsWith(".ts"))).toBe(true)
    expect(items.length).toBeGreaterThan(0)
  })

  it("respects exclude filter", async () => {
    const items = await walk(tmp, { type: "files", exclude: ["*.txt"] })
    expect(items.every((i) => !i.path.endsWith(".txt"))).toBe(true)
  })

  it("respects ignore patterns", async () => {
    const items = await walk(tmp, { ignore: ["*.ts"] })
    const names = items.map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("src/index.ts")
  })

  it("skips symbolic links", async () => {
    const items = await walk(tmp, { type: "files" })
    const names = items.map((i) => relPath(tmp, i.path))
    expect(names).toContain("hello.txt")
    expect(names).not.toContain("hello-link.txt")
  })
})

// ---------------------------------------------------------------------------
// binary
// ---------------------------------------------------------------------------
describe("binary", () => {
  it("detects binary by extension", async () => {
    expect(await binary(path.join(tmp, "photo.png"))).toBe(true)
  })

  it("detects binary by content (null bytes)", async () => {
    expect(await binary(path.join(tmp, "image.bin"))).toBe(true)
  })

  it("returns false for text files", async () => {
    expect(await binary(path.join(tmp, "hello.txt"))).toBe(false)
  })

  it("returns false for empty files", async () => {
    expect(await binary(path.join(tmp, "empty.txt"))).toBe(false)
  })

  it("detects binary by control-character ratio", async () => {
    expect(await binary(path.join(tmp, "control-chars.txt"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// formatTree
// ---------------------------------------------------------------------------
describe("formatTree", () => {
  it("renders a tree with directories and files", () => {
    const items = [
      { path: path.join(tmp, "src"), dir: true },
      { path: path.join(tmp, "src", "index.ts"), dir: false },
      { path: path.join(tmp, "src", "lib"), dir: true },
      { path: path.join(tmp, "src", "lib", "helper.ts"), dir: false },
      { path: path.join(tmp, "hello.txt"), dir: false },
    ]
    const tree = formatTree(tmp, items)
    expect(tree).toContain(`${tmp}/`)
    expect(tree).toContain("src/")
    expect(tree).toContain("lib/")
    expect(tree).toContain("index.ts")
    expect(tree).toContain("helper.ts")
    expect(tree).toContain("hello.txt")
  })

  it("handles empty items", () => {
    const tree = formatTree(tmp, [])
    expect(tree).toBe(`${tmp}/`)
  })

  it("renders exact indentation and ordering", () => {
    const items = [
      { path: path.join(tmp, "src"), dir: true },
      { path: path.join(tmp, "src", "index.ts"), dir: false },
      { path: path.join(tmp, "src", "lib"), dir: true },
      { path: path.join(tmp, "src", "lib", "helper.ts"), dir: false },
      { path: path.join(tmp, "hello.txt"), dir: false },
    ]
    expect(formatTree(tmp, items)).toBe(
      [
        `${tmp}/`,
        "  src/",
        "    lib/",
        "      helper.ts",
        "    index.ts",
        "  hello.txt",
      ].join("\n"),
    )
  })
})

describe("walk error handling", () => {
  it("returns empty results when the base directory cannot be read", async () => {
    await expect(walk(path.join(tmp, "missing-dir"))).resolves.toEqual([])
  })
})
