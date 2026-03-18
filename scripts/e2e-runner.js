const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")
const homeDir = os.homedir()
const fixtureRoot = path.join(repoRoot, "tests", "e2e-fixture")
const apiBase = (process.env.LMSTUDIO_E2E_BASE_URL || "http://127.0.0.1:1234").replace(/\/$/, "")
const pluginId = process.env.LMSTUDIO_E2E_PLUGIN_ID || "that-lucas/filesystem"
const apiToken = process.env.LM_API_TOKEN || ""

function expandHome(input) {
  if (input === "~") return homeDir
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2))
  return input
}

function toTildePath(target) {
  const resolved = path.resolve(target)
  if (resolved === homeDir) return "~"
  if (resolved.startsWith(`${homeDir}${path.sep}`)) {
    return `~/${path.relative(homeDir, resolved).split(path.sep).join("/")}`
  }
  return resolved
}

function normalizeToolPath(input) {
  if (input.startsWith("~/") || input === "~") return path.resolve(expandHome(input))
  if (path.isAbsolute(input)) return path.resolve(input)
  return path.resolve(homeDir, input)
}

function pathMatches(actual, expected) {
  return typeof actual === "string" && normalizeToolPath(actual) === path.resolve(expected)
}

function headers() {
  const out = { "Content-Type": "application/json" }
  if (apiToken) out.Authorization = `Bearer ${apiToken}`
  return out
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const json = await response.json().catch(() => ({}))
  if (!response.ok || json.error) {
    const message = json?.error?.message || `${response.status} ${response.statusText}`
    if (message.includes("Permission denied to use plugin")) {
      throw new Error(
        "LM Studio denied plugin-backed API calls. Provide LM_API_TOKEN with local plugin integration permissions and rerun the e2e script.",
      )
    }
    throw new Error(message)
  }
  return json
}

async function detectModel() {
  if (process.env.LMSTUDIO_E2E_MODEL) return process.env.LMSTUDIO_E2E_MODEL

  const json = await fetchJson(`${apiBase}/api/v1/models`, { method: "GET", headers: headers() })
  const models = (json.models || []).filter((model) => model.type === "llm")
  const loaded = models.find((model) => model.loaded_instances?.length && model.capabilities?.trained_for_tool_use)
  if (loaded) return loaded.key
  const fallback = models.find((model) => model.capabilities?.trained_for_tool_use) || models[0]
  if (!fallback) throw new Error("No LM Studio LLMs are available for e2e tests.")
  return fallback.key
}

function parseFlat(output) {
  const normalized = typeof output === "string" && output.startsWith('"') ? JSON.parse(output) : output
  const buf = Buffer.from(normalized, "utf8")
  const fields = {}
  const payloads = {}
  let index = 0
  while (index < buf.length) {
    assert.equal(buf[index], 0x23, `Invalid flat output near byte ${index}`)
    const newline = buf.indexOf(0x0a, index)
    const lineEnd = newline === -1 ? buf.length : newline
    const line = buf.slice(index, lineEnd).toString("utf8")
    const separator = line.indexOf(":")
    assert.notEqual(separator, -1, `Invalid flat field: ${line}`)
    const key = line.slice(1, separator)
    const value = line.slice(separator + 1)
    index = newline === -1 ? buf.length : newline + 1
    if (key.endsWith("_bytes")) {
      const payloadKey = key.slice(0, -6)
      const size = Number(value)
      payloads[payloadKey] = buf.slice(index, index + size).toString("utf8")
      index += size
      if (index < buf.length && buf[index] === 0x0a) index += 1
      continue
    }
    fields[key] = value
  }
  return { fields, payloads }
}

function parseGrepOutput(output) {
  const { fields, payloads } = parseFlat(output)
  const total = Number(fields.total || 0)
  const count = Number(fields.limit || 0)
  const matches = []
  for (let index = 0; index < count; index += 1) {
    matches.push({
      path: fields[`matches_${index}_path`],
      line: Number(fields[`matches_${index}_line`]),
      text: payloads[`matches_${index}_content`] || "",
    })
  }
  return {
    path: fields.path,
    pattern: fields.pattern,
    total,
    files: Number(fields.matches_files || 0),
    matches,
  }
}

async function readNumberedLines(filePath, offset, limit) {
  const raw = await fs.readFile(filePath, "utf8")
  const lines = raw.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join("\n")
}

async function collectPaths(root, predicate) {
  const out = []
  const visit = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(full)
        continue
      }
      if (!entry.isFile() || !predicate(full, entry.name)) continue
      const stat = await fs.stat(full)
      out.push({ path: full, time: stat.mtime.getTime() })
    }
  }
  await visit(root)
  return out.sort((a, b) => b.time - a.time).map((item) => item.path)
}

async function collectLiteralMatches(root, predicate, needle) {
  const files = await collectPaths(root, predicate)
  const matches = []
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8")
    const lines = raw.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(needle)) continue
      matches.push({ path: filePath, line: index + 1, text: lines[index] })
    }
  }
  return matches.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`))
}

function formatTree(base, items) {
  const dirs = new Set(["."])
  const byDir = new Map()
  for (const item of items) {
    const rel = path.relative(base, item.path).split(path.sep).join("/") || "."
    const dir = path.posix.dirname(rel)
    const parts = dir === "." ? [] : dir.split("/")
    for (let index = 0; index <= parts.length; index += 1) {
      dirs.add(index === 0 ? "." : parts.slice(0, index).join("/"))
    }
    if (!item.dir) {
      const key = dir === "" ? "." : dir
      byDir.set(key, [...(byDir.get(key) || []), path.posix.basename(rel)])
      continue
    }
    dirs.add(rel)
  }

  const render = (dir, depth) => {
    const out = []
    if (depth > 0) out.push(`${"  ".repeat(depth)}${path.posix.basename(dir)}/`)
    const kids = [...dirs].filter((item) => item !== dir && path.posix.dirname(item) === dir).sort((a, b) => a.localeCompare(b))
    for (const kid of kids) out.push(...render(kid, depth + 1))
    const indent = "  ".repeat(depth + 1)
    for (const file of (byDir.get(dir) || []).sort((a, b) => a.localeCompare(b))) out.push(`${indent}${file}`)
    return out
  }

  return [`${base}/`, ...render(".", 0)].join("\n")
}

async function formatTopLevelList(dir, type) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const lines = [`${dir}/`]
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (type !== "files") lines.push(`  ${entry.name}/`)
      continue
    }
    if (entry.isFile() && type !== "directories") lines.push(`  ${entry.name}`)
  }
  return lines.join("\n")
}

async function formatRecursiveDirectories(dir) {
  const dirs = []
  const visit = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      dirs.push({ path: full, dir: true })
      await visit(full)
    }
  }
  await visit(dir)
  return formatTree(dir, dirs)
}

function assertFinalMessage(response) {
  const messages = (response.output || []).filter((item) => item.type === "message")
  assert(messages.length > 0, `Expected final assistant message. Full response: ${JSON.stringify(response, null, 2)}`)
}

function firstToolCall(response, tool) {
  const invalid = (response.output || []).filter((item) => item.type === "invalid_tool_call")
  if (invalid.length > 0) {
    throw new Error(`Invalid tool call returned: ${JSON.stringify(invalid, null, 2)}`)
  }
  const toolCalls = (response.output || []).filter((item) => item.type === "tool_call")
  assert.equal(toolCalls.length, 1, `Expected exactly one ${tool} tool call, received ${toolCalls.length}. Full response: ${JSON.stringify(response, null, 2)}`)
  assert.equal(toolCalls[0].tool, tool)
  assert.equal(toolCalls[0].provider_info?.plugin_id, pluginId)
  return toolCalls[0]
}

async function runScenario(tool, scenario, ctx) {
  const prompt = scenario.prompt(ctx)
  const response = await fetchJson(`${apiBase}/api/v1/chat`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: ctx.model,
      input: prompt,
      integrations: [{ type: "plugin", id: pluginId, allowed_tools: [tool] }],
      temperature: 0,
      store: false,
    }),
  })
  if (process.env.LMSTUDIO_E2E_DEBUG === "1") {
    console.log(JSON.stringify(response, null, 2))
  }
  assertFinalMessage(response)
  await scenario.assert(ctx, response)
}

async function buildContext() {
  const model = await detectModel()
  const readmeAbs = path.join(fixtureRoot, "README.md")
  const docsAbs = path.join(fixtureRoot, "docs")
  const srcAbs = path.join(fixtureRoot, "src")
  const fixtureRel = path.relative(homeDir, fixtureRoot).split(path.sep).join("/")
  const readmeRel = path.relative(homeDir, readmeAbs).split(path.sep).join("/")
  const docsRel = path.relative(homeDir, docsAbs).split(path.sep).join("/")
  const srcRel = path.relative(homeDir, srcAbs).split(path.sep).join("/")
  return {
    model,
    fixtureAbs: fixtureRoot,
    fixture: toTildePath(fixtureRoot),
    fixtureRel,
    readmeAbs,
    readme: toTildePath(readmeAbs),
    readmeRel,
    docsAbs,
    docs: toTildePath(docsAbs),
    docsRel,
    srcAbs,
    src: toTildePath(srcAbs),
    srcRel,
  }
}

const scenarios = {
  read: [
    {
      name: "smoke-first-four-lines",
      prompt: (ctx) => `What are the first 4 lines of the file at exact path \`${ctx.readmeRel}\`? Use the available tool if needed.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "read")
        assert(pathMatches(call.arguments.filePath, ctx.readmeAbs))
        assert.equal(call.arguments.limit, 4)
        const parsed = parseFlat(call.output)
        assert.equal(parsed.payloads.content, await readNumberedLines(ctx.readmeAbs, 1, 4))
      },
    },
    {
      name: "offset-window-guide",
      prompt: (ctx) => `Read lines 3 through 5 of the file at exact path \`${ctx.docsRel}/guide.md\`. Use the read tool with offset 3 and limit 3.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "read")
        const guideAbs = path.join(ctx.docsAbs, "guide.md")
        assert(pathMatches(call.arguments.filePath, guideAbs))
        assert.equal(call.arguments.offset, 3)
        assert.equal(call.arguments.limit, 3)
        const parsed = parseFlat(call.output)
        assert.equal(parsed.payloads.content, await readNumberedLines(guideAbs, 3, 3))
      },
    },
  ],
  list: [
    {
      name: "smoke-top-level-src",
      prompt: (ctx) => `What is directly inside the directory at exact path \`${ctx.srcRel}\`? Use the available tool.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "list")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        const parsed = parseFlat(call.output)
        assert.equal(parsed.payloads.entries, await formatTopLevelList(ctx.srcAbs, "all"))
      },
    },
    {
      name: "top-level-files-only",
      prompt: (ctx) => `List only the files directly inside the directory at exact path \`${ctx.srcRel}\`.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "list")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        assert.equal(call.arguments.type, "files")
        const parsed = parseFlat(call.output)
        assert.equal(parsed.payloads.entries, await formatTopLevelList(ctx.srcAbs, "files"))
      },
    },
    {
      name: "recursive-directories-only",
      prompt: (ctx) => `Recursively list only directories under the directory at exact path \`${ctx.srcRel}\`.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "list")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        assert.equal(call.arguments.recursive, true)
        assert.equal(call.arguments.type, "directories")
        const parsed = parseFlat(call.output)
        assert.equal(parsed.payloads.entries, await formatRecursiveDirectories(ctx.srcAbs))
      },
    },
  ],
  glob: [
    {
      name: "find-fixture-files",
      prompt: (ctx) => `Use exactly one glob tool call with pattern \`*.fixture.ts\` and path \`${ctx.srcRel}\`. Do not make any other tool calls.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "glob")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        assert.equal(call.arguments.pattern, "*.fixture.ts")
        const expected = await collectPaths(ctx.srcAbs, (_, name) => name.endsWith(".fixture.ts"))
        const parsed = parseFlat(call.output)
        assert.equal(Number(parsed.fields.total), expected.length)
        assert.deepEqual((parsed.payloads.entries || "").split("\n").filter(Boolean).sort(), [...expected].sort())
      },
    },
    {
      name: "find-non-test-typescript-files",
      prompt: (ctx) => `Use exactly one glob tool call to list TypeScript files under path \`${ctx.srcRel}\` while excluding \`*.fixture.ts\`. Do not make any other tool calls.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "glob")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        assert(Array.isArray(call.arguments.exclude) && call.arguments.exclude.length > 0)
        const expected = await collectPaths(ctx.srcAbs, (_, name) => name.endsWith(".ts") && !name.endsWith(".fixture.ts"))
        const parsed = parseFlat(call.output)
        assert.deepEqual((parsed.payloads.entries || "").split("\n").filter(Boolean).sort(), [...expected].sort())
      },
    },
    {
      name: "paginate-markdown-files",
      prompt: (ctx) => `Use exactly one glob tool call to list markdown files under path \`${ctx.fixtureRel}\` with limit 2. Do not make any other tool calls.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "glob")
        assert(pathMatches(call.arguments.path, ctx.fixtureAbs))
        assert.equal(call.arguments.limit, 2)
        const allExpected = await collectPaths(ctx.fixtureAbs, (_, name) => name.endsWith(".md"))
        const entries = (parseFlat(call.output).payloads.entries || "").split("\n").filter(Boolean)
        assert.equal(entries.length, 2)
        assert(entries.every((entry) => allExpected.includes(entry)), `Unexpected markdown entries: ${entries.join(", ")}`)
      },
    },
  ],
  grep: [
    {
      name: "find-helper-sentinel",
      prompt: (ctx) => `Use exactly one grep tool call to search for the exact text \`HELPER_LITERAL_SENTINEL\` under path \`${ctx.srcRel}\`. Do not make any other tool calls.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "grep")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        const expected = await collectLiteralMatches(ctx.srcAbs, (_, name) => name.endsWith(".ts"), "HELPER_LITERAL_SENTINEL")
        const parsed = parseGrepOutput(call.output)
        assert.equal(parsed.total, expected.length)
        assert.deepEqual(parsed.matches.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)), expected)
      },
    },
    {
      name: "grep-only-test-files",
      prompt: (ctx) => `Use exactly one grep tool call to search for the exact phrase \`smoke assertion\` only in \`*.fixture.ts\` files under path \`${ctx.srcRel}\`. Do not make any other tool calls.`,
      assert: async (ctx, response) => {
        const call = firstToolCall(response, "grep")
        assert(pathMatches(call.arguments.path, ctx.srcAbs))
        assert(Array.isArray(call.arguments.include) && call.arguments.include.length > 0)
        const expected = await collectLiteralMatches(ctx.srcAbs, (_, name) => name.endsWith(".fixture.ts"), "smoke assertion")
        const parsed = parseGrepOutput(call.output)
        assert.equal(parsed.total, expected.length)
        assert.deepEqual(parsed.matches.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)), expected)
      },
    },
  ],
}

async function main() {
  const tool = process.argv[2]
  if (!tool || !scenarios[tool]) {
    throw new Error(`Usage: node scripts/e2e-runner.js <${Object.keys(scenarios).join("|")}>`)
  }
  if (!apiToken) {
    throw new Error("LM_API_TOKEN is required for plugin-backed LM Studio e2e tests.")
  }

  const ctx = await buildContext()
  console.log(`Using model: ${ctx.model}`)
  console.log(`Using plugin: ${pluginId}`)

  for (const scenario of scenarios[tool]) {
    process.stdout.write(`- ${tool}/${scenario.name} ... `)
    await runScenario(tool, scenario, ctx)
    console.log("ok")
  }

  console.log(`Passed ${scenarios[tool].length} ${tool} e2e scenarios.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
