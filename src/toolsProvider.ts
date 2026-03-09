import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk"
import { createReadStream, existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Minimatch } from "minimatch"
import { z } from "zod"
import { configSchematics } from "./config"
import {
  READ_LIMIT,
  FILE_LIMIT,
  expandHome,
  resolvePath,
  relPath,
  walk,
  binary,
  formatTree,
} from "./utils"

export async function toolsProvider(ctl: ToolsProviderController) {
  const tools: Tool[] = []

  const baseDir = () => {
    const dir = ctl.getPluginConfig(configSchematics).get("baseDir")?.trim()
    const full = path.resolve(expandHome(dir || "~"))
    if (!existsSync(full)) throw new Error(`Error: Base directory does not exist: ${full}`)
    return full
  }

  const resolveInputPath = (base: string, input?: string) => {
    try {
      return input && path.isAbsolute(input) ? resolvePath(base, path.relative(base, input)) : resolvePath(base, input)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  tools.push(
    tool({
      name: "read",
      description: "Read a file from an absolute or home-relative path. Supports line offsets and limits.",
      parameters: {
        filePath: z.string().describe("The absolute or home-relative path to the file to read (e.g., /Users/john/file.ext, ~/path/to/file.ext)"),
        offset: z.number().int().min(1).optional().describe("The line number to start reading from (1-indexed)"),
        limit: z.number().int().min(1).optional().describe("The maximum number of lines to return (defaults to 2000)"),
      },
      implementation: async ({ filePath, offset, limit }) => {
        const base = baseDir()
        const file = resolveInputPath(base, filePath)
        if (file.startsWith("Error:")) return file
        const stat = await fs.stat(file).catch(() => undefined)
        if (!stat) return `Error: File not found: ${file}`
        if (stat.isDirectory()) return `Error: ${file} is a directory. Use the list tool instead.`
        if (await binary(file)) return `Error: Cannot read binary file: ${file}`

        const size = limit || READ_LIMIT
        const start = (offset || 1) - 1
        const raw: string[] = []
        let total = 0
        let truncated = false
        const stream = createReadStream(file, { encoding: "utf8" })
        const rl = createInterface({ input: stream, crlfDelay: Infinity })
        try {
          for await (const text of rl) {
            total += 1
            if (total <= start) continue
            if (raw.length >= size) {
              truncated = true
              continue
            }
            raw.push(text)
          }
        } finally {
          rl.close()
          stream.destroy()
        }

        if (total < (offset || 1) && !(total === 0 && (offset || 1) === 1)) {
          return `Error: Offset ${offset} is out of range for this file (${total} lines)`
        }

        const lines = raw.map((line, index) => `${index + (offset || 1)}: ${line}`)
        const last = (offset || 1) + raw.length - 1
        const next = last + 1
        return [
          `<path>${file}</path>`,
          `<type>file</type>`,
          `<content>`,
          lines.join("\n"),
          truncated
            ? `\n\n(Showing lines ${offset || 1}-${last} of ${total}. Use offset=${next} to continue.)`
            : `\n\n(End of file - total ${total} lines)`,
          `</content>`,
        ].join("\n")
      },
    }),
  )

  tools.push(
    tool({
      name: "list",
      description: "List files or directories from an absolute or home-relative path.",
      parameters: {
        path: z.string().optional().describe("The absolute or home-relative directory to list (e.g., /Users/john, ~/path/to/dir)"),
        ignore: z.array(z.string()).optional().describe("Optional glob patterns to ignore"),
        recursive: z.boolean().optional().describe("Whether to recurse into subdirectories. Defaults to false."),
        type: z.enum(["files", "directories", "all"]).optional().describe("Which entry types to include. Defaults to all."),
        offset: z.number().int().min(1).optional().describe("The entry number to start listing from (1-indexed). Defaults to 1."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe(`The maximum number of entries to return. Defaults to ${FILE_LIMIT}.`),
      },
      implementation: async ({ path: input, ignore, recursive, type, offset, limit }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (dir.startsWith("Error:")) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat?.isDirectory()) return `Error: Directory not found: ${dir}`
        const deep = recursive ?? false
        const kind = type ?? "all"
        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT
        const found = await walk(dir, { ignore, recursive: deep, type: kind })
        const slice = found.slice(start, start + size)
        const out = !deep
          ? [
              `${dir}/`,
              ...slice
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((item) => `  ${path.basename(item.path)}${item.dir ? "/" : ""}`),
            ].join("\n")
          : formatTree(dir, slice)
        if (found.length < (offset ?? 1) && !(found.length === 0 && (offset ?? 1) === 1)) {
          return `Error: Offset ${offset} is out of range for this listing (${found.length} entries)`
        }
        if (start + slice.length >= found.length) return `${out}\n\n(Showing ${slice.length} of ${found.length} entries)`
        return `${out}\n\n(Showing entries ${start + 1}-${start + slice.length} of ${found.length}. Use offset=${start + slice.length + 1} to continue.)`
      },
    }),
  )

  tools.push(
    tool({
      name: "glob",
      description: "Match files using a glob pattern from an absolute or home-relative path. Searches recursively and returns entries ordered by most recently modified first.",
      parameters: {
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z.string().optional().describe("The absolute or home-relative directory to search in (e.g., /Users/john, ~/path/to/dir)"),
        type: z.enum(["files", "directories", "all"]).optional().describe("Which entry types to match. Defaults to files."),
        include: z.array(z.string()).optional().describe('File or directory patterns to include in the search (for example, ["src/**", "*.ts"])'),
        exclude: z.array(z.string()).optional().describe('File or directory patterns to exclude from the search (for example, ["dist/**", "*.test.ts"])'),
        offset: z.number().int().min(1).optional().describe("The entry number to start from (1-indexed). Defaults to 1."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe(`The maximum number of entries to return. Defaults to ${FILE_LIMIT}.`),
      },
      implementation: async ({ pattern, path: input, type, include, exclude, offset, limit }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (dir.startsWith("Error:")) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat?.isDirectory()) return `Error: Directory not found: ${dir}`
        const matcher = new Minimatch(pattern, { dot: true, nocase: true })
        const kind = type ?? "files"
        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT
        const found = (await walk(dir, { recursive: true, type: kind, include, exclude })).filter((file) => {
          const rel = relPath(dir, file.path)
          return matcher.match(rel) || matcher.match(path.basename(rel))
        })
        const files = await Promise.all(
          found.map(async (file) => ({
            path: file.path,
            time: (await fs.stat(file.path)).mtime.getTime(),
          })),
        )
        files.sort((a, b) => b.time - a.time)
        if (files.length === 0) return "No entries found"
        if (files.length < (offset ?? 1) && !(files.length === 0 && (offset ?? 1) === 1)) {
          return `Error: Offset ${offset} is out of range for these entries (${files.length} total)`
        }
        const slice = files.slice(start, start + size)
        const lines = slice.map((item) => item.path)
        if (start + slice.length >= files.length) return `${lines.join("\n")}\n\n(Showing ${slice.length} of ${files.length} entries)`
        return `${lines.join("\n")}\n\n(Showing entries ${start + 1}-${start + slice.length} of ${files.length}. Use offset=${start + slice.length + 1} to continue.)`
      },
    }),
  )

  tools.push(
    tool({
      name: "grep",
      description:
        "Search file contents using a regular expression from an absolute or home-relative path. Searches recursively, orders matching files by most recently modified first, groups matches by file path, skips binary files, and skips the following special system paths: /dev, /proc, /sys, /run, /var/run, /private/var/run, /Volumes.",
      parameters: {
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z.string().optional().describe("The absolute or home-relative directory to search in (e.g., /Users/john, ~/path/to/dir)"),
        include: z.array(z.string()).optional().describe('File patterns to include in the search (for example, ["*.js", "*.{ts,tsx}"])'),
        exclude: z.array(z.string()).optional().describe('File patterns to exclude from the search (for example, ["*.test.ts", "dist/**"])'),
      },
      implementation: async ({ pattern, path: input, include, exclude }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (dir.startsWith("Error:")) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat?.isDirectory()) return `Error: Directory not found: ${dir}`
        let regex: RegExp
        try {
          regex = new RegExp(pattern, "u")
        } catch (error) {
          return `Error: Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`
        }
        const files = await walk(dir, { recursive: true, type: "files", include, exclude })
        const matches: { path: string; line: number; text: string; time: number }[] = []
        for (const file of files) {
          if (await binary(file.path)) continue
          const body = await fs.readFile(file.path, "utf8").catch(() => undefined)
          if (body === undefined) continue
          const lines = body.split(/\r?\n/)
          const time = (await fs.stat(file.path)).mtime.getTime()
          for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue
            matches.push({
              path: file.path,
              line: i + 1,
              text: lines[i],
              time,
            })
            regex.lastIndex = 0
          }
        }
        if (matches.length === 0) return "No matches found"
        matches.sort((a, b) => b.time - a.time)
        const out = [`Found ${matches.length} matches`]
        let current = ""
        for (const match of matches) {
          if (current !== match.path) {
            if (current) out.push("")
            current = match.path
            out.push(`${match.path}:`)
          }
          out.push(`  Line ${match.line}: ${match.text}`)
        }
        return out.join("\n")
      },
    }),
  )

  tools.push(
    tool({
      name: "create",
      description:
        "Create a new file or directory at an absolute or home-relative path. Parent directories are created automatically for files. Fails if the target already exists unless overwrite is set to true.",
      parameters: {
        type: z.enum(["file", "directory"]).describe("Whether to create a file or a directory"),
        path: z.string().describe("Absolute or home-relative path (e.g., /Users/john/file.ext, ~/path/to/dir)"),
        content: z.string().optional().describe("The file content. Only used when type is file."),
        overwrite: z.boolean().optional().describe("Allow replacing an existing file. Only used when type is file. Defaults to false."),
        recursive: z.boolean().optional().describe("Create parent directories if they don't exist. Only used when type is directory. Defaults to true."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("Content encoding. Only used when type is file. Defaults to utf8."),
      },
      implementation: async ({ type, path: input, content, overwrite, recursive, encoding }) => {
        const base = baseDir()
        const target = resolveInputPath(base, input)
        if (target.startsWith("Error:")) return target

        if (type === "file") {
          if (recursive !== undefined && recursive !== true) {
            return `Error: Parameter "recursive" is not used when type is file`
          }
          const stat = await fs.stat(target).catch(() => undefined)
          if (stat && !overwrite) return `Error: File already exists: ${target}`
          await fs.mkdir(path.dirname(target), { recursive: true })
          if (encoding === "base64") {
            await fs.writeFile(target, Buffer.from(content || "", "base64"))
          } else {
            await fs.writeFile(target, content || "", "utf8")
          }
          const lines = content ? content.split(/\r?\n/) : []
          const count = content && content.length > 0 ? (content.endsWith("\n") ? lines.length - 1 : lines.length) : 0
          return `Created file: ${relPath(base, target)} (${count === 0 ? "empty" : `${count} lines`})`
        }

        // type === "directory"
        if (content !== undefined) {
          return `Error: Parameter "content" is not used when type is directory`
        }
        if (overwrite !== undefined && overwrite !== false) {
          return `Error: Parameter "overwrite" is not used when type is directory`
        }
        if (encoding !== undefined && encoding !== "utf8") {
          return `Error: Parameter "encoding" is not used when type is directory`
        }
        const stat = await fs.stat(target).catch(() => undefined)
        if (stat) return `Error: Directory already exists: ${target}`
        const rec = recursive ?? true
        try {
          await fs.mkdir(target, { recursive: rec })
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
        return `Created directory: ${relPath(base, target)}`
      },
    }),
  )

  tools.push(
    tool({
      name: "edit",
      description:
        "Edit an existing file by applying one or more exact text replacements in order from an absolute or home-relative path. Fails if a replacement is missing, ambiguous, or would not change the file.",
      parameters: {
        path: z.string().describe("Absolute or home-relative path (e.g., /Users/john/file.ext, ~/path/to/file.ext)"),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("Exact text to replace"),
              newString: z.string().describe("Replacement text"),
              replaceAll: z.boolean().optional().describe("Replace all matches of oldString. Defaults to false."),
            }),
          )
          .min(1)
          .describe("One or more exact text replacements to apply in order"),
        encoding: z.enum(["utf8"]).optional().describe("File encoding. Defaults to utf8."),
      },
      implementation: async ({ path: input, edits }) => {
        const base = baseDir()
        const file = resolveInputPath(base, input)
        if (file.startsWith("Error:")) return file

        const stat = await fs.stat(file).catch(() => undefined)
        if (!stat) return `Error: File not found: ${file}`
        if (stat.isDirectory()) return `Error: ${file} is a directory. The edit tool only works on files.`
        if (await binary(file)) return `Error: Cannot edit binary file: ${file}`

        const countMatches = (body: string, needle: string) => {
          let count = 0
          let index = 0
          while (true) {
            const found = body.indexOf(needle, index)
            if (found === -1) return count
            count += 1
            index = found + needle.length
          }
        }

        let body = await fs.readFile(file, "utf8")
        for (const edit of edits) {
          if (edit.oldString.length === 0) return 'Error: Parameter "oldString" must not be empty'
          if (edit.oldString === edit.newString) return "Error: oldString and newString must be different"

          const matches = countMatches(body, edit.oldString)
          if (matches === 0) return `Error: oldString not found: ${file}`
          if (matches > 1 && edit.replaceAll !== true) {
            return `Error: oldString matched ${matches} times in file: ${file}. Use replaceAll to edit all matches.`
          }

          if (edit.replaceAll) {
            body = body.split(edit.oldString).join(edit.newString)
            continue
          }

          const index = body.indexOf(edit.oldString)
          body = body.slice(0, index) + edit.newString + body.slice(index + edit.oldString.length)
        }

        await fs.writeFile(file, body, "utf8")
        return `Edited file: ${relPath(base, file)} (${edits.length} edits)`
      },
    }),
  )

  return tools
}
