import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk"
import { createReadStream, existsSync, type Stats } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { configSchematics } from "./config"
import { formatError, formatOutput, isErrorOutput, outputPayload } from "./errors"
import { globWithRipgrep, grepWithRipgrep, isErrorResult } from "./ripgrep"
import {
  READ_LIMIT,
  FILE_LIMIT,
  PathOutsideBaseError,
  expandHome,
  resolvePath,
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
      if (error instanceof PathOutsideBaseError) {
        return formatError("path_outside_base", "Path is outside the configured base directory", [["path", error.filePath]])
      }
      const message = error instanceof Error ? error.message : String(error)
      return formatError("filesystem_error", "Filesystem operation failed", [["details", message]])
    }
  }

  const ensureExistingPathIsSafe = async (target: string, expected: "file" | "directory"): Promise<{ stat?: Stats; error?: string }> => {
    const stat = await fs.lstat(target).catch(() => undefined)
    if (stat?.isSymbolicLink()) {
      return { error: formatError("wrong_type", "Path is a symbolic link", [["expected", expected], ["actual", "symlink"], ["path", target]]) }
    }
    return { stat }
  }

  const ensureParentWithinBase = async (base: string, target: string) => {
    const realBase = await fs.realpath(base).catch(() => base)
    let current = path.dirname(target)
    while (true) {
      const stat = await fs.lstat(current).catch(() => undefined)
      if (stat) {
        const realCurrent = await fs.realpath(current).catch(() => current)
        const rel = path.relative(realBase, realCurrent)
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return formatError("path_outside_base", "Path is outside the configured base directory", [["path", target]])
        }
        return undefined
      }
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }

  tools.push(
    tool({
      name: "read",
      description: "Read text from a file. Use this when you already know the file path and want its contents with line numbers.",
      parameters: {
        filePath: z.string().describe("The file to read, such as \"~/my-project/src/index.ts\" or \"/Users/john/workspace/src/index.ts\"."),
        offset: z.number().int().min(1).optional().describe("The 1-indexed line number to start from. Default: 1."),
        limit: z.number().int().min(1).optional().describe("The maximum number of lines to return. Default: 2000."),
      },
      implementation: async ({ filePath, offset, limit }) => {
        const base = baseDir()
        const file = resolveInputPath(base, filePath)
        if (isErrorOutput(file)) return file
        const { stat, error } = await ensureExistingPathIsSafe(file, "file")
        if (error) return error
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
      description: "Browse files or directories under a directory. Use this when you want to inspect what is present before choosing a path or pattern.",
      parameters: {
        path: z.string().optional().describe("The directory to browse, such as \"~/my-project\" or \"/Users/john/workspace\"."),
        ignore: z.array(z.string()).optional().describe("Glob patterns to skip while browsing, such as [\"dist/**\", \"coverage/**\", \"build/**\"]."),
        recursive: z.boolean().optional().describe("Whether to include subdirectories while browsing. Default: false."),
        type: z.enum(["files", "directories", "all"]).optional().describe("What kinds of entries to return: \"all\" (default), \"files\", or \"directories\"."),
        offset: z.number().int().min(1).optional().describe("The 1-indexed entry number to start from when paging through results. Default: 1."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe("The maximum number of entries to return in one call. Default: 100."),
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
      description: "Find paths under a directory by glob pattern. Use this when you know what the path should look like and want matching files, directories, or both.",
      parameters: {
        pattern: z.string().describe("The path pattern to match, such as \"*.ts\", \"*Tests.ts\", \"src/**\", or \"**/components\"."),
        path: z.string().optional().describe("The directory to search from, such as \"~/my-project\" or \"/Users/john/workspace\"."),
        type: z.enum(["files", "directories", "all"]).optional().describe("What kinds of paths to return: \"files\" (default), \"directories\", or \"all\". File matches use ripgrep glob semantics; directory matches still use the plugin's existing walker semantics."),
        include: z.array(z.string()).optional().describe("Extra glob patterns to include in the search, combined with pattern. For example, [\"src/**\"] also includes files under \"~/my-project/src\", or [\"**/*.ts\"] also includes TypeScript paths."),
        exclude: z.array(z.string()).optional().describe("Glob patterns to leave out of the results, such as [\"dist/**\", \"coverage/**\", \"build/**\"] or [\"**/*.generated.ts\"]."),
        offset: z.number().int().min(1).optional().describe("The 1-indexed result number to start from when paging through matches. Default: 1."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe("The maximum number of matches to return in one call. Default: 100."),
      },
      implementation: async ({ pattern, path: input, type, include, exclude, offset, limit }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (isErrorOutput(dir)) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat) return formatError("not_found", "Directory not found", [["kind", "directory"], ["path", dir]])
        if (!stat.isDirectory()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", dir]])
        const kind = type ?? "files"
        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT
        const files = await globWithRipgrep({ baseDir: base, dir, pattern, type: kind, include, exclude })
        if (isErrorResult(files)) return files
        if (files.length < (offset ?? 1) && !(files.length === 0 && (offset ?? 1) === 1)) {
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", files.length], ["unit", "entries"]])
        }
        const slice = files.slice(start, start + size)
        const lines = slice.join("\n")
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
        "Search text inside files by regular expression. Use this when you know the content you want to find, not the file name or path.",
      parameters: {
        pattern: z.string().describe("The regular expression to search for inside file contents, such as \"TODO\", \"describe\\\\(\", or \"export\\\\s+const\"."),
        path: z.string().optional().describe("The directory to search from, such as \"~/my-project\" or \"/Users/john/workspace\"."),
        include: z.array(z.string()).optional().describe("Extra glob patterns that narrow the search to specific files, such as [\"*.ts\"] to search TypeScript files or [\"src/**\"] to search only files under \"~/my-project/src\"."),
        exclude: z.array(z.string()).optional().describe("Glob patterns to leave out of the search, such as [\"dist/**\", \"coverage/**\", \"build/**\"] or [\"**/*.generated.ts\"]."),
      },
      implementation: async ({ pattern, path: input, include, exclude }) => {
        const base = baseDir()
        const dir = resolveInputPath(base, input)
        if (isErrorOutput(dir)) return dir
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat) return formatError("not_found", "Directory not found", [["kind", "directory"], ["path", dir]])
        if (!stat.isDirectory()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", dir]])
        const matches = await grepWithRipgrep({ baseDir: base, dir, pattern, include, exclude })
        if (isErrorResult(matches)) return matches
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
        "Create a new file or directory at a path. Use this to add files, folders, or initial file content.",
      parameters: {
        type: z.enum(["file", "directory"]).describe("What to create: \"file\" or \"directory\"."),
        path: z.string().describe("The path to create, such as \"~/my-project/src/new-file.ts\" or \"/Users/john/workspace/src/new-file.ts\"."),
        content: z.string().optional().describe("The content to write when creating a file, such as \"export const enabled = true\". Used only when type is \"file\"."),
        overwrite: z.boolean().optional().describe("Whether to replace an existing file when type is \"file\". Default: false."),
        recursive: z.boolean().optional().describe("Whether to create missing parent directories when creating the file or directory. Default: true."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("How file content is interpreted when type is \"file\": \"utf8\" (default) or \"base64\"."),
      },
      implementation: async ({ type, path: input, content, overwrite, recursive, encoding }) => {
        const base = baseDir()
        const target = resolveInputPath(base, input)
        if (isErrorOutput(target)) return target

        if (type === "file") {
          const { stat, error } = await ensureExistingPathIsSafe(target, "file")
          if (error) return error
          if (stat?.isDirectory()) return formatError("wrong_type", "Path is a directory", [["expected", "file"], ["actual", "directory"], ["path", target]])
          if (stat && !overwrite) return formatError("already_exists", "File already exists", [["kind", "file"], ["path", target]])
          const fileEncoding = encoding ?? "utf8"
          const rec = recursive ?? true
          const text = content || ""
          const lines = text.split(/\r?\n/)
          const count = text.length > 0 ? (text.endsWith("\n") ? lines.length - 1 : lines.length) : 0
          try {
            const parentError = await ensureParentWithinBase(base, target)
            if (parentError) return parentError
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
        const { stat, error } = await ensureExistingPathIsSafe(target, "directory")
        if (error) return error
        if (stat?.isFile()) return formatError("wrong_type", "Path is not a directory", [["expected", "directory"], ["actual", "file"], ["path", target]])
        if (stat) return formatError("already_exists", "Directory already exists", [["kind", "directory"], ["path", target]])
        const rec = recursive ?? true
        try {
          const parentError = await ensureParentWithinBase(base, target)
          if (parentError) return parentError
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
        "Edit a text file by replacing exact text. Use this when you know the current text and the replacement text.",
      parameters: {
        path: z.string().describe("The file to edit, such as \"~/my-project/src/index.ts\" or \"/Users/john/workspace/src/index.ts\"."),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("The exact text to find, such as \"const enabled = false\" or \"Hello World\"."),
              newString: z.string().describe("The replacement text to write, such as \"const enabled = true\" or \"Hello Universe\"."),
              replaceAll: z.boolean().optional().describe("Whether to replace every match of oldString. If omitted, the edit expects exactly one match."),
            }),
          )
          .min(1)
          .describe("The list of text replacements to apply in order, such as [{\"oldString\":\"const enabled = false\",\"newString\":\"const enabled = true\"}]."),
        encoding: z.enum(["utf8"]).optional().describe("The file encoding to use while editing. Default: \"utf8\"."),
      },
      implementation: async ({ path: input, edits, encoding }) => {
        const base = baseDir()
        const file = resolveInputPath(base, input)
        if (isErrorOutput(file)) return file

        const { stat, error } = await ensureExistingPathIsSafe(file, "file")
        if (error) return error
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
