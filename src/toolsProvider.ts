import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk"
import { createReadStream } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import {
  type BoundaryExpectedKind,
  type BoundaryFailure,
  inspectCreateTarget,
  inspectExistingPath,
  inspectTraversalRoot,
  resolveConfiguredBaseDir,
  resolveUserPath,
} from "./boundary"
import { configSchematics } from "./config"
import { formatError, formatOutput, outputPayload } from "./errors"
import { globWithRipgrep, grepWithRipgrep, isErrorResult } from "./ripgrep"
import { FILE_LIMIT, READ_LIMIT, binary, formatTree, walk } from "./utils"

type BaseContext = {
  base: string
  realBase: string
}

export async function toolsProvider(ctl: ToolsProviderController) {
  const tools: Tool[] = []

  const resolveBaseContext = async (): Promise<BaseContext> => {
    const configured = ctl.getPluginConfig(configSchematics).get("baseDir")
    const result = await resolveConfiguredBaseDir(configured)
    if (!result.ok) {
      throw new Error(formatError("filesystem_error", "Filesystem operation failed", [["path", result.resolvedPath], ["details", result.details]]))
    }
    return { base: result.resolvedPath, realBase: result.realBase }
  }

  const formatBoundaryFailure = (result: BoundaryFailure, expected: BoundaryExpectedKind) => {
    if (result.kind === "outside_base") {
      return formatError("path_outside_base", "Path is outside the configured base directory", [["path", result.resolvedPath]])
    }

    if (result.kind === "not_found") {
      const kind = expected === "directory" ? "directory" : "file"
      return formatError("not_found", kind === "directory" ? "Directory not found" : "File not found", [["kind", kind], ["path", result.resolvedPath]])
    }

    if (result.kind === "wrong_type") {
      return formatError(
        "wrong_type",
        `Path is not a ${expected}`,
        [["expected", expected], ["actual", result.actual ?? "other"], ["path", result.resolvedPath]],
      )
    }

    return formatError("filesystem_error", "Filesystem operation failed", [["path", result.resolvedPath], ["details", result.details]])
  }

  const resolveToolPath = (base: string, input?: string) => {
    const result = resolveUserPath(base, input)
    if (!result.ok) return { error: formatBoundaryFailure(result, "any"), path: undefined as string | undefined }
    return { path: result.resolvedPath, error: undefined as string | undefined }
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
        const baseContext = await resolveBaseContext()
        const resolved = resolveToolPath(baseContext.base, filePath)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectExistingPath(baseContext.base, resolved.path, "file")
        if (!checked.ok) return formatBoundaryFailure(checked, "file")
        if (await binary(resolved.path)) return formatError("binary_file", "Cannot read binary file", [["path", resolved.path]])

        const size = limit || READ_LIMIT
        const start = (offset || 1) - 1
        const raw: string[] = []
        let total = 0
        let truncated = false
        const stream = createReadStream(resolved.path, { encoding: "utf8" })
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
          ["path", resolved.path],
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
      description: "Browse files and/or directories under a directory. Use this when you want to inspect directory contents before choosing a file path or glob pattern.",
      parameters: {
        path: z.string().optional().describe("The directory to browse, such as \"~/my-project\" or \"/Users/john/workspace\"."),
        ignore: z.array(z.string()).optional().describe("Glob patterns to skip while browsing, such as [\"dist/**\", \"coverage/**\", \"build/**\"]."),
        recursive: z.boolean().optional().describe("Whether to include subdirectories while browsing. Default: false."),
        type: z.enum(["files", "directories", "all"]).optional().describe("What kinds of entries to return: \"all\" (default), \"files\", or \"directories\"."),
        offset: z.number().int().min(1).optional().describe("The 1-indexed entry number to start from when paging through results. Default: 1."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe("The maximum number of entries to return in one call. Default: 100."),
      },
      implementation: async ({ path: input, ignore, recursive, type, offset, limit }) => {
        const baseContext = await resolveBaseContext()
        const resolved = resolveToolPath(baseContext.base, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectTraversalRoot(baseContext.base, resolved.path)
        if (!checked.ok) return formatBoundaryFailure(checked, "directory")

        const deep = recursive ?? false
        const kind = type ?? "all"
        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT

        let found
        try {
          found = await walk(resolved.path, baseContext.realBase, { ignore, recursive: deep, type: kind, baseDir: baseContext.base })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return formatError("filesystem_error", "Filesystem operation failed", [["path", resolved.path], ["details", message]])
        }

        const slice = found.slice(start, start + size)
        const out = !deep
          ? [
              `${resolved.path}/`,
              ...slice
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((item) => `  ${path.basename(item.path)}${item.dir ? "/" : ""}`),
            ].join("\n")
          : formatTree(resolved.path, slice)
        if (found.length < (offset ?? 1) && !(found.length === 0 && (offset ?? 1) === 1)) {
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", found.length], ["unit", "entries"]])
        }
        const hasMore = start + slice.length < found.length
        return formatOutput([
          ["path", resolved.path],
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
      description: "Find matching file paths under a directory by glob pattern. Use this when you know what the file path should look like and want matching files only.",
      parameters: {
        pattern: z.string().describe("The file path pattern to match, such as \"*.ts\", \"*Tests.ts\", \"**/*.generated.ts\", or \"src/**/*.ts\"."),
        path: z.string().optional().describe("The directory to search from, such as \"~/my-project\" or \"/Users/john/workspace\"."),
        include: z.array(z.string()).optional().describe("Extra file glob patterns to include in the search. These are combined with pattern using union semantics."),
        exclude: z.array(z.string()).optional().describe("Glob patterns to leave out of the results, such as [\"dist/**\", \"coverage/**\", \"build/**\"] or [\"**/*.generated.ts\"]."),
        offset: z.number().int().min(1).optional().describe("The 1-indexed result number to start from when paging through matches. Default: 1."),
        limit: z.number().int().min(1).max(FILE_LIMIT).optional().describe("The maximum number of matches to return in one call. Default: 100."),
      },
      implementation: async ({ pattern, path: input, include, exclude, offset, limit }) => {
        const baseContext = await resolveBaseContext()
        const resolved = resolveToolPath(baseContext.base, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectTraversalRoot(baseContext.base, resolved.path)
        if (!checked.ok) return formatBoundaryFailure(checked, "directory")

        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT
        const files = await globWithRipgrep({
          baseDir: baseContext.base,
          realBase: baseContext.realBase,
          dir: resolved.path,
          pattern,
          include,
          exclude,
        })
        if (isErrorResult(files)) return files
        if (files.length < (offset ?? 1) && !(files.length === 0 && (offset ?? 1) === 1)) {
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", files.length], ["unit", "entries"]])
        }

        const slice = files.slice(start, start + size)
        const lines = slice.join("\n")
        const hasMore = start + slice.length < files.length
        return formatOutput([
          ["path", resolved.path],
          ["type", "files"],
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
        "Search text inside files by regular expression. Use this when you know the text or pattern you want to find, not the file name.",
      parameters: {
        pattern: z.string().describe("The regular expression to search for inside file contents, such as \"TODO\", \"describe\\\\(\", or \"export\\\\s+const\"."),
        path: z.string().optional().describe("The directory to search from, such as \"~/my-project\" or \"/Users/john/workspace\"."),
        include: z.array(z.string()).optional().describe("Glob patterns for which files to search, such as [\"*.ts\", \"*.js\"] to search TypeScript and Javascript files or [\"src/**\"] to search only files under \"src\"."),
        exclude: z.array(z.string()).optional().describe("Glob patterns to leave out of the search, such as [\"dist/**\", \"coverage/**\", \"build/**\"] or [\"**/*.generated.ts\"]."),
      },
      implementation: async ({ pattern, path: input, include, exclude }) => {
        const baseContext = await resolveBaseContext()
        const resolved = resolveToolPath(baseContext.base, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectTraversalRoot(baseContext.base, resolved.path)
        if (!checked.ok) return formatBoundaryFailure(checked, "directory")

        const matches = await grepWithRipgrep({
          baseDir: baseContext.base,
          realBase: baseContext.realBase,
          dir: resolved.path,
          pattern,
          include,
          exclude,
        })
        if (isErrorResult(matches)) return matches
        const fileCount = new Set(matches.map((match) => match.path)).size
        const out: Array<ReturnType<typeof outputPayload> | [string, string | number | boolean | undefined]> = [
          ["path", resolved.path],
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
        const baseContext = await resolveBaseContext()
        const resolved = resolveToolPath(baseContext.base, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const target = resolved.path

        if (type === "file") {
          const existing = await inspectExistingPath(baseContext.base, target, "file")
          if (existing.ok) {
            if (!overwrite) return formatError("already_exists", "File already exists", [["kind", "file"], ["path", target]])
          } else if (existing.kind !== "not_found") {
            return formatBoundaryFailure(existing, "file")
          } else {
            const creatable = await inspectCreateTarget(baseContext.base, target, "file")
            if (!creatable.ok) return formatBoundaryFailure(creatable, "file")
          }

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
              ["overwritten", existing.ok],
              ["lines", count],
              ["bytes", bytes.byteLength],
            ])
          } catch (error) {
            return formatError("filesystem_error", "Filesystem operation failed", [["path", target], ["details", error instanceof Error ? error.message : String(error)]])
          }
        }

        if (content !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "content"]])
        }
        if (overwrite !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "overwrite"]])
        }
        if (encoding !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "encoding"]])
        }

        const existing = await inspectExistingPath(baseContext.base, target, "directory")
        if (existing.ok) return formatError("already_exists", "Directory already exists", [["kind", "directory"], ["path", target]])
        if (existing.kind !== "not_found") return formatBoundaryFailure(existing, "directory")

        const creatable = await inspectCreateTarget(baseContext.base, target, "directory")
        if (!creatable.ok) return formatBoundaryFailure(creatable, "directory")

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
        const baseContext = await resolveBaseContext()
        const resolved = resolveToolPath(baseContext.base, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectExistingPath(baseContext.base, resolved.path, "file")
        if (!checked.ok) return formatBoundaryFailure(checked, "file")
        if (await binary(resolved.path)) return formatError("binary_file", "Cannot edit binary file", [["path", resolved.path]])

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

        let body = await fs.readFile(resolved.path, "utf8")
        for (const edit of edits) {
          if (edit.oldString.length === 0) return formatError("invalid_parameter", "Parameter must not be empty", [["parameter", "oldString"]])
          if (edit.oldString === edit.newString) return formatError("no_change", "Edit would not change the file")

          const matches = countMatches(body, edit.oldString)
          if (matches === 0) return formatError("match_not_found", "oldString not found", [["path", resolved.path]])
          if (matches > 1 && edit.replaceAll !== true) {
            return formatError("ambiguous_match", "oldString matched multiple times", [["path", resolved.path], ["matches", matches], ["details", "Use replaceAll to edit all matches"]])
          }

          if (edit.replaceAll) {
            body = body.split(edit.oldString).join(edit.newString)
            continue
          }

          const index = body.indexOf(edit.oldString)
          body = body.slice(0, index) + edit.newString + body.slice(index + edit.oldString.length)
        }

        await fs.writeFile(resolved.path, body, "utf8")
        return formatOutput([
          ["path", resolved.path],
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
