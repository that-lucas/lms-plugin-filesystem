import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk"
import { createReadStream, existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Minimatch } from "minimatch"
import { z } from "zod"
import { configSchematics } from "./config"
import { formatError, formatOutput, isErrorOutput, outputPayload } from "./errors"
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
    if (!existsSync(full)) throw new Error(formatError("filesystem_error", "Base directory does not exist", [["path", full]]))
    return full
  }

  const resolveInputPath = (base: string, input?: string) => {
    try {
      return input && path.isAbsolute(input) ? resolvePath(base, path.relative(base, input)) : resolvePath(base, input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const match = message.match(/^Error: Path is outside the configured base directory: (.+)$/)
      if (match) {
        return formatError("path_outside_base", "Path is outside the configured base directory", [["path", match[1]]])
      }
      return formatError("filesystem_error", "Filesystem operation failed", [["details", message]])
    }
  }

  tools.push(
    tool({
      name: "read",
      description: "Read text from a file at an absolute or home-relative path with optional line offset and limit.",
      parameters: {
        filePath: z.string().describe("Absolute or home-relative file path to read from."),
        offset: z.number().int().min(1).optional().describe("Starting line number, 1-indexed."),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to return."),
      },
      implementation: async ({ filePath, offset, limit }) => {
        const base = baseDir()
        const file = resolveInputPath(base, filePath)
        if (isErrorOutput(file)) return file
        const stat = await fs.stat(file).catch(() => undefined)
        if (!stat) return formatError("not_found", "File not found", [["kind", "file"], ["path", file]])
        if (stat.isDirectory()) return formatError("wrong_type", "Path is a directory", [["expected", "file"], ["actual", "directory"], ["path", file]])
        if (await binary(file)) return formatError("binary_file", "Cannot read binary file", [["path", file]])

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
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", total], ["unit", "lines"]])
        }

        const startOffset = offset || 1
        const lines = raw.map((line, index) => `${index + startOffset}: ${line}`).join("\n")
        const hasMore = truncated
        const next = startOffset + raw.length
        return formatOutput([
          ["path", file],
          ["type", "file"],
          ["offset", startOffset],
          ["limit", raw.length],
          ["total", total],
          ["has_more", hasMore],
          ["next_offset", hasMore ? next : undefined],
          outputPayload("content", lines),
        ])
      },
    }),
  )

  tools.push(
    tool({
      name: "list",
      description: "List files or directories from an absolute or home-relative directory with optional recursion, filtering, and pagination.",
      parameters: {
        path: z.string().optional().describe("Absolute or home-relative directory path to list from."),
        ignore: z.array(z.string()).optional().describe("Array of glob patterns for paths to skip during traversal, for example [\"dist\", \"coverage\", \"generated/**\"]."),
        recursive: z.boolean().optional().describe("Recurse into subdirectories."),
        type: z.enum(["files", "directories", "all"]).optional().describe("Whether to return \"files\", \"directories\", or \"all\"."),
        offset: z.number().int().min(1).optional().describe("Starting entry number, 1-indexed."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe("Maximum number of entries to return."),
      },
      implementation: async ({ path: input, ignore, recursive, type, offset, limit }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (isErrorOutput(dir)) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat) return formatError("not_found", "Directory not found", [["kind", "directory"], ["path", dir]])
        if (!stat.isDirectory()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", dir]])
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
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", found.length], ["unit", "entries"]])
        }
        const hasMore = start + slice.length < found.length
        return formatOutput([
          ["path", dir],
          ["type", "directory"],
          ["offset", offset ?? 1],
          ["limit", slice.length],
          ["total", found.length],
          ["has_more", hasMore],
          ["next_offset", hasMore ? start + slice.length + 1 : undefined],
          outputPayload("entries", out),
        ])
      },
    }),
  )

  tools.push(
    tool({
      name: "glob",
      description: "Match file or directory paths by glob pattern from an absolute or home-relative directory. Use this to find files by name or path, not by file contents.",
      parameters: {
        pattern: z.string().describe("Glob pattern to match against file or directory paths relative to the search root, for example *.ts, src/**/*.tsx, or **/*Tests*.cs."),
        path: z.string().optional().describe("Absolute or home-relative directory path to search from."),
        type: z.enum(["files", "directories", "all"]).optional().describe("Whether to match \"files\", \"directories\", or \"all\"."),
        include: z.array(z.string()).optional().describe("Array of glob patterns that returned files or directories must match, for example [\"src/**\", \"**/*.ts\"]."),
        exclude: z.array(z.string()).optional().describe("Array of glob patterns for files or directories to exclude from results and traversal, for example [\"dist/**\", \"**/*.test.ts\"]."),
        offset: z.number().int().min(1).optional().describe("Starting entry number, 1-indexed."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe("Maximum number of entries to return."),
      },
      implementation: async ({ pattern, path: input, type, include, exclude, offset, limit }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (isErrorOutput(dir)) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat) return formatError("not_found", "Directory not found", [["kind", "directory"], ["path", dir]])
        if (!stat.isDirectory()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", dir]])
        const matcher = new Minimatch(pattern, { dot: true, nocase: true })
        const kind = type ?? "files"
        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT
        const found = (await walk(dir, { recursive: true, type: kind, include, exclude })).filter((file) => {
          const rel = relPath(dir, file.path)
          return matcher.match(rel)
        })
        const files = await Promise.all(
          found.map(async (file) => ({
            path: file.path,
            time: (await fs.stat(file.path)).mtime.getTime(),
          })),
        )
        files.sort((a, b) => b.time - a.time)
        if (files.length < (offset ?? 1) && !(files.length === 0 && (offset ?? 1) === 1)) {
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", files.length], ["unit", "entries"]])
        }
        const slice = files.slice(start, start + size)
        const lines = slice.map((item) => item.path).join("\n")
        const hasMore = start + slice.length < files.length
        return formatOutput([
          ["path", dir],
          ["type", kind],
          ["pattern", pattern],
          ["offset", offset ?? 1],
          ["limit", slice.length],
          ["total", files.length],
          ["has_more", hasMore],
          ["next_offset", hasMore ? start + slice.length + 1 : undefined],
          outputPayload("entries", lines),
        ])
      },
    }),
  )

  tools.push(
    tool({
      name: "grep",
      description:
        "Search file contents with a regular expression from an absolute or home-relative directory. Use this only for text inside files, not for file names or paths.",
      parameters: {
        pattern: z.string().describe("Regular expression to search for inside file contents, not file names or paths, for example describe\\(, TODO, or class\\s+User."),
        path: z.string().optional().describe("Absolute or home-relative directory path to search from."),
        include: z.array(z.string()).optional().describe("Array of glob patterns that candidate files must match before their contents are searched, for example [\"**/*.cs\", \"src/**\"]."),
        exclude: z.array(z.string()).optional().describe("Array of glob patterns for files or directories to exclude from the search, for example [\"dist/**\", \"**/*.generated.cs\"]."),
      },
      implementation: async ({ pattern, path: input, include, exclude }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (isErrorOutput(dir)) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat) return formatError("not_found", "Directory not found", [["kind", "directory"], ["path", dir]])
        if (!stat.isDirectory()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", dir]])
        let regex: RegExp
        try {
          regex = new RegExp(pattern, "u")
        } catch (error) {
          return formatError("invalid_pattern", "Invalid regular expression", [["pattern", pattern], ["details", error instanceof Error ? error.message : String(error)]])
        }
        const files = await walk(dir, { recursive: true, type: "files", include, exclude })
        const orderedFiles = await Promise.all(
          files.map(async (file) => ({
            path: file.path,
            time: (await fs.stat(file.path)).mtime.getTime(),
          })),
        )
        orderedFiles.sort((a, b) => b.time - a.time)
        const matches: { path: string; line: number; text: string }[] = []
        for (const file of orderedFiles) {
          if (await binary(file.path)) continue
          const stream = createReadStream(file.path, { encoding: "utf8" })
          const rl = createInterface({ input: stream, crlfDelay: Infinity })
          let lineNumber = 0
          try {
            for await (const line of rl) {
              lineNumber += 1
              if (!regex.test(line)) {
                regex.lastIndex = 0
                continue
              }
              matches.push({
                path: file.path,
                line: lineNumber,
                text: line,
              })
              regex.lastIndex = 0
            }
          } finally {
            rl.close()
            stream.destroy()
          }
        }
        const fileCount = new Set(matches.map((match) => match.path)).size
        const out: Array<ReturnType<typeof outputPayload> | [string, string | number | boolean | undefined]> = [
          ["path", dir],
          ["pattern", pattern],
          ["matches_total", matches.length],
          ["matches_files", fileCount],
        ]
        for (const [index, match] of matches.entries()) {
          out.push([`matches_${index}_path`, match.path])
          out.push([`matches_${index}_line`, match.line])
          out.push(outputPayload(`matches_${index}_content`, match.text))
        }
        return formatOutput(out)
      },
    }),
  )

  tools.push(
    tool({
      name: "create",
      description:
        "Create a file or directory at an absolute or home-relative path, with optional file overwrite and parent directory creation.",
      parameters: {
        type: z.enum(["file", "directory"]).describe("Whether to create a file or directory."),
        path: z.string().describe("Absolute or home-relative target path to create."),
        content: z.string().optional().describe("File content to write when type is file."),
        overwrite: z.boolean().optional().describe("Allow replacing an existing file when type is file."),
        recursive: z.boolean().optional().describe("Create missing parent directories when creating a file or directory."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding for file content when type is file: \"utf8\" or \"base64\"."),
      },
      implementation: async ({ type, path: input, content, overwrite, recursive, encoding }) => {
        const base = baseDir()
        const target = resolveInputPath(base, input)
        if (isErrorOutput(target)) return target

        if (type === "file") {
          const stat = await fs.stat(target).catch(() => undefined)
          if (stat?.isDirectory()) return formatError("wrong_type", "Path is a directory", [["expected", "file"], ["actual", "directory"], ["path", target]])
          if (stat && !overwrite) return formatError("already_exists", "File already exists", [["kind", "file"], ["path", target]])
          const fileEncoding = encoding ?? "utf8"
          const rec = recursive ?? true
          const text = content || ""
          const lines = text.split(/\r?\n/)
          const count = text.length > 0 ? (text.endsWith("\n") ? lines.length - 1 : lines.length) : 0
          try {
            if (rec) await fs.mkdir(path.dirname(target), { recursive: true })
            const bytes = fileEncoding === "base64"
              ? Buffer.from(text, "base64")
              : Buffer.from(text, "utf8")
            await fs.writeFile(target, bytes)
            return formatOutput([
              ["path", target],
              ["type", "file"],
              ["status", "created"],
              ["encoding", fileEncoding],
              ["overwritten", Boolean(stat)],
              ["lines", count],
              ["bytes", bytes.byteLength],
            ])
          } catch (error) {
            return formatError("filesystem_error", "Filesystem operation failed", [["path", target], ["details", error instanceof Error ? error.message : String(error)]])
          }
        }

        // type === "directory"
        if (content !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "content"]])
        }
        if (overwrite !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "overwrite"]])
        }
        if (encoding !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "encoding"]])
        }
        const stat = await fs.stat(target).catch(() => undefined)
        if (stat?.isFile()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", target]])
        if (stat) return formatError("already_exists", "Directory already exists", [["kind", "directory"], ["path", target]])
        const rec = recursive ?? true
        try {
          await fs.mkdir(target, { recursive: rec })
        } catch (error) {
          return formatError("filesystem_error", "Filesystem operation failed", [["path", target], ["details", error instanceof Error ? error.message : String(error)]])
        }
        return formatOutput([
          ["path", target],
          ["type", "directory"],
          ["status", "created"],
          ["recursive", rec],
        ])
      },
    }),
  )

  tools.push(
    tool({
      name: "edit",
      description:
        "Edit an existing text file by applying exact text replacements in order, failing on missing, ambiguous, or no-op edits.",
      parameters: {
        path: z.string().describe("Absolute or home-relative file path to edit."),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("Exact text to replace."),
              newString: z.string().describe("Replacement text."),
              replaceAll: z.boolean().optional().describe("Set to true to replace every match of oldString; otherwise exactly one match is required."),
            }),
          )
          .min(1)
          .describe("Array of exact text replacements to apply in order to the file contents, for example [{\"oldString\":\"foo\",\"newString\":\"bar\"}]."),
        encoding: z.enum(["utf8"]).optional().describe("Encoding of the file being edited."),
      },
      implementation: async ({ path: input, edits, encoding }) => {
        const base = baseDir()
        const file = resolveInputPath(base, input)
        if (isErrorOutput(file)) return file

        const stat = await fs.stat(file).catch(() => undefined)
        if (!stat) return formatError("not_found", "File not found", [["kind", "file"], ["path", file]])
        if (stat.isDirectory()) return formatError("wrong_type", "Path is a directory", [["expected", "file"], ["actual", "directory"], ["path", file]])
        if (await binary(file)) return formatError("binary_file", "Cannot edit binary file", [["path", file]])

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
          if (edit.oldString.length === 0) return formatError("invalid_parameter", "Parameter must not be empty", [["parameter", "oldString"]])
          if (edit.oldString === edit.newString) return formatError("no_change", "Edit would not change the file")

          const matches = countMatches(body, edit.oldString)
          if (matches === 0) return formatError("match_not_found", "oldString not found", [["path", file]])
          if (matches > 1 && edit.replaceAll !== true) {
            return formatError("ambiguous_match", "oldString matched multiple times", [["path", file], ["matches", matches], ["details", "Use replaceAll to edit all matches"]])
          }

          if (edit.replaceAll) {
            body = body.split(edit.oldString).join(edit.newString)
            continue
          }

          const index = body.indexOf(edit.oldString)
          body = body.slice(0, index) + edit.newString + body.slice(index + edit.oldString.length)
        }

        await fs.writeFile(file, body, "utf8")
        return formatOutput([
          ["path", file],
          ["type", "file"],
          ["status", "edited"],
          ["encoding", encoding ?? "utf8"],
          ["changes_requested", edits.length],
          ["changes_performed", edits.length],
        ])
      },
    }),
  )

  return tools
}
