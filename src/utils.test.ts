import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  expandHome,
  PathOutsideBaseError,
  resolvePath,
  relPath,
  compile,
  ignored,
  blocked,
  walk,
  binary,
  formatTree,
  DEFAULT_IGNORES,
  IGNORE_PATHS_ENV,
  defaultIgnoreList,
  matchesPattern,
} from "./utils"
import { createLink, detectLinkSupport, type LinkSupport } from "./testSupport"

let tmp: string
let linkSupport: LinkSupport

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fs-plugin-test-"))
  linkSupport = await detectLinkSupport(path.join(tmp, "utils-link-check"))

  await fs.writeFile(path.join(tmp, "hello.txt"), "hello world\n")
  await fs.writeFile(path.join(tmp, "empty.txt"), "")
  await fs.writeFile(path.join(tmp, "long-line.txt"), "x".repeat(5000) + "\n")

  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "index.ts"), 'console.log("hi")\n')
  await fs.writeFile(path.join(tmp, "src", "utils.ts"), "export const foo = 1\n")
  await fs.mkdir(path.join(tmp, "src", "lib"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "lib", "helper.ts"), "export function help() {}\n")

  await fs.mkdir(path.join(tmp, "node_modules"), { recursive: true })
  await fs.writeFile(path.join(tmp, "node_modules", "pkg.js"), "module.exports = {}\n")

  const buf = Buffer.alloc(64)
  buf[0] = 0
  buf[1] = 0
  await fs.writeFile(path.join(tmp, "image.bin"), buf)

  await fs.writeFile(path.join(tmp, "photo.png"), "not really a png")
  await fs.writeFile(path.join(tmp, "control-chars.txt"), Buffer.from([1, 2, 3, 4, 5, 6, 65, 66, 67, 68]))
  await fs.writeFile(path.join(tmp, ".hidden"), "secret\n")

  await fs.mkdir(path.join(tmp, "a", "b", "c"), { recursive: true })
  await fs.writeFile(path.join(tmp, "a", "b", "c", "deep.txt"), "deep\n")

  if (linkSupport.fileSymlinks) {
    await createLink(path.join(tmp, "hello.txt"), path.join(tmp, "hello-link.txt"))
  }
})

beforeEach(() => {
  delete process.env[IGNORE_PATHS_ENV]
})

afterAll(async () => {
  delete process.env[IGNORE_PATHS_ENV]
  await fs.rm(tmp, { recursive: true, force: true })
})

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

describe("resolvePath", () => {
  it("resolves a relative path within base", () => {
    expect(resolvePath(tmp, "src")).toBe(path.join(tmp, "src"))
  })

  it("resolves . to base itself", () => {
    expect(resolvePath(tmp)).toBe(tmp)
  })

  it("throws for paths outside base", () => {
    expect(() => resolvePath(tmp, "../..")).toThrow(PathOutsideBaseError)
  })

  it("throws for absolute paths outside base", () => {
    expect(() => resolvePath(tmp, "/etc/passwd")).toThrow(PathOutsideBaseError)
  })
})

describe("relPath", () => {
  it("returns relative forward-slash path", () => {
    expect(relPath(tmp, path.join(tmp, "src", "index.ts"))).toBe("src/index.ts")
  })

  it("returns . for same path", () => {
    expect(relPath(tmp, tmp)).toBe(".")
  })
})

describe("compile and matching", () => {
  it("returns empty array for undefined", () => {
    expect(compile()).toHaveLength(0)
  })

  it("compiles patterns into Minimatch instances", () => {
    const matchers = compile(["*.ts", "dist/**"])
    expect(matchers).toHaveLength(2)
    expect(matchers[0].match("foo.ts")).toBe(true)
    expect(matchers[0].match("foo.js")).toBe(false)
  })

  it("matches only relative path values", () => {
    const matchers = compile(["*.ts"])
    expect(matchesPattern("root.ts", matchers)).toBe(true)
    expect(matchesPattern("src/index.ts", matchers)).toBe(false)
  })
})

describe("defaultIgnoreList", () => {
  it("uses defaults when env var is absent", () => {
    expect(defaultIgnoreList()).toEqual(DEFAULT_IGNORES)
  })

  it("uses custom semicolon-separated values when env var is present", () => {
    process.env[IGNORE_PATHS_ENV] = "custom;tmp/**;  logs  "
    expect(defaultIgnoreList()).toEqual(["custom", "tmp/**", "logs"])
  })

  it("uses empty list when env var is present but empty", () => {
    process.env[IGNORE_PATHS_ENV] = ""
    expect(defaultIgnoreList()).toEqual([])
  })
})

describe("ignored", () => {
  it("ignores default dirs like node_modules", () => {
    expect(ignored("node_modules/pkg.js", [])).toBe(true)
  })

  it("ignores nested default dirs", () => {
    expect(ignored("foo/node_modules/bar.js", [])).toBe(true)
  })

  it("does not ignore normal paths", () => {
    expect(ignored("src/index.ts", [])).toBe(false)
  })

  it("respects custom matchers with relative-path semantics", () => {
    const matchers = compile(["**/*.log"])
    expect(ignored("app.log", matchers)).toBe(true)
    expect(ignored("logs/app.log", matchers)).toBe(true)
  })

  it("supports glob-like env ignore patterns in defaults", () => {
    expect(ignored("tmp/cache/file.txt", [], ["tmp/**"])).toBe(true)
  })
})

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

describe("walk", () => {
  it("lists all entries recursively by default", async () => {
    const names = (await walk(tmp)).map((i) => relPath(tmp, i.path))
    expect(names).toContain("hello.txt")
    expect(names).toContain("src")
    expect(names).toContain("src/index.ts")
    expect(names).toContain("src/lib/helper.ts")
  })

  it("skips default-ignored dirs", async () => {
    const names = (await walk(tmp)).map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("node_modules")
    expect(names).not.toContain("node_modules/pkg.js")
  })

  it("disables built-in default ignores when env var is empty", async () => {
    process.env[IGNORE_PATHS_ENV] = ""
    const names = (await walk(tmp)).map((i) => relPath(tmp, i.path))
    expect(names).toContain("node_modules")
    expect(names).toContain("node_modules/pkg.js")
  })

  it("supports glob-style env ignore overrides", async () => {
    process.env[IGNORE_PATHS_ENV] = "src/lib/**"
    const names = (await walk(tmp)).map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("src/lib/helper.ts")
  })

  it("supports bracket character classes in env ignore patterns", async () => {
    await fs.writeFile(path.join(tmp, "data1.txt"), "one\n")
    await fs.writeFile(path.join(tmp, "data9.txt"), "nine\n")
    process.env[IGNORE_PATHS_ENV] = "data[0-9].txt"
    const names = (await walk(tmp)).map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("data1.txt")
    expect(names).not.toContain("data9.txt")
  })

  it("non-recursive lists only top level", async () => {
    const names = (await walk(tmp, { recursive: false })).map((i) => relPath(tmp, i.path))
    expect(names).toContain("hello.txt")
    expect(names).toContain("src")
    expect(names).not.toContain("src/index.ts")
  })

  it("filters by type: files", async () => {
    expect((await walk(tmp, { type: "files" })).every((i) => !i.dir)).toBe(true)
  })

  it("filters by type: directories", async () => {
    expect((await walk(tmp, { type: "directories" })).every((i) => i.dir)).toBe(true)
  })

  it("respects include filter with root-relative semantics", async () => {
    const items = await walk(tmp, { type: "files", include: ["*.ts"] })
    expect(items.map((i) => relPath(tmp, i.path))).toEqual([])
  })

  it("respects recursive include filter", async () => {
    const items = await walk(tmp, { type: "files", include: ["**/*.ts"] })
    expect(items.every((i) => i.path.endsWith(".ts"))).toBe(true)
    expect(items.length).toBeGreaterThan(0)
  })

  it("respects exclude filter", async () => {
    const items = await walk(tmp, { type: "files", exclude: ["**/*.txt"] })
    expect(items.every((i) => !i.path.endsWith(".txt"))).toBe(true)
  })

  it("does not traverse excluded directories", async () => {
    const names = (await walk(tmp, { exclude: ["src/lib", "src/lib/**"] })).map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("src/lib")
    expect(names).not.toContain("src/lib/helper.ts")
  })

  it("includes matching directories while still traversing unmatched parents", async () => {
    const names = (await walk(tmp, { type: "directories", include: ["src/lib"] })).map((i) => relPath(tmp, i.path))
    expect(names).toEqual(["src/lib"])
  })

  it("respects ignore patterns", async () => {
    const names = (await walk(tmp, { ignore: ["src/**/*.ts"] })).map((i) => relPath(tmp, i.path))
    expect(names).not.toContain("src/index.ts")
  })

  it("skips symbolic links", async () => {
    if (!linkSupport.fileSymlinks) return
    const names = (await walk(tmp, { type: "files" })).map((i) => relPath(tmp, i.path))
    expect(names).toContain("hello.txt")
    expect(names).not.toContain("hello-link.txt")
  })
})

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
    expect(formatTree(tmp, [])).toBe(`${tmp}/`)
  })

  it("renders exact indentation and ordering", () => {
    const items = [
      { path: path.join(tmp, "src"), dir: true },
      { path: path.join(tmp, "src", "index.ts"), dir: false },
      { path: path.join(tmp, "src", "lib"), dir: true },
      { path: path.join(tmp, "src", "lib", "helper.ts"), dir: false },
      { path: path.join(tmp, "hello.txt"), dir: false },
    ]
    expect(formatTree(tmp, items)).toBe([
      `${tmp}/`,
      "  src/",
      "    lib/",
      "      helper.ts",
      "    index.ts",
      "  hello.txt",
    ].join("\n"))
  })
})

describe("walk error handling", () => {
  it("returns empty results when the base directory cannot be read", async () => {
    await expect(walk(path.join(tmp, "missing-dir"))).resolves.toEqual([])
  })
})
