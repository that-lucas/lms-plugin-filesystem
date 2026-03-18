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
  resolveConfiguredSandboxBaseDir,
  resolveUserPath,
} from "./boundary"
import { configSchematics } from "./config"
import { formatError, formatOutput, outputPayload } from "./errors"
import { globWithRipgrep, grepWithRipgrep, isErrorResult } from "./ripgrep"
import { FILE_LIMIT, GREP_LIMIT, READ_LIMIT, binary, formatTree, walk } from "./utils"

type SandboxContext = {
  sandboxBaseDir: string
  realSandboxBaseDir: string
}

export async function toolsProvider(ctl: ToolsProviderController) {
  const tools: Tool[] = []

  const resolveSandboxContext = async (): Promise<SandboxContext> => {
    const configured = ctl.getPluginConfig(configSchematics).get("sandboxBaseDir")
    const result = await resolveConfiguredSandboxBaseDir(configured)
    if (!result.ok) {
      throw new Error(formatError("filesystem_error", "Filesystem operation failed", [["path", result.resolvedPath], ["details", result.details]]))
    }
    return { sandboxBaseDir: result.resolvedPath, realSandboxBaseDir: result.realBase }
  }

  const formatBoundaryFailure = (result: BoundaryFailure, expected: BoundaryExpectedKind) => {
    if (result.kind === "outside_base") {
      return formatError("path_outside_base", "Path is outside the configured sandbox base directory", [["path", result.resolvedPath]])
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
      name: "list",
      description: "Browse the contents of a directory when you want to inspect what exists before choosing a file path or search pattern. Use this for directory browsing; use glob for file-name pattern matching.",
      parameters: {
        path: z.string().describe("Required. Absolute or home-relative directory path to browse."),
        ignore: z.array(z.string()).optional().describe("Optional. Array of glob patterns to skip while browsing, for example [\"dist/**\", \"coverage/**\", \"build/**\"]."),
        recursive: z.boolean().optional().describe("Optional. When true, include nested subdirectories. Default: false."),
        type: z.enum(["files", "directories", "all"]).optional().describe("Optional. What to return: \"files\", \"directories\", or \"all\". Default: \"all\"."),
        offset: z.number().int().min(1).optional().describe("Optional. 1-indexed result number to start from. Default: 1."),
        limit: z.number().int().min(1).optional().describe("Optional. Maximum number of entries to return. Default: 100."),
      },
      implementation: async ({ path: input, ignore, recursive, type, offset, limit }) => {
        const sandboxContext = await resolveSandboxContext()
        const resolved = resolveToolPath(sandboxContext.sandboxBaseDir, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectTraversalRoot(sandboxContext.sandboxBaseDir, resolved.path)
        if (!checked.ok) return formatBoundaryFailure(checked, "directory")

        const deep = recursive ?? false
        const kind = type ?? "all"
        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT

        let found
        try {
          found = await walk(resolved.path, sandboxContext.realSandboxBaseDir, { ignore, recursive: deep, type: kind, sandboxBaseDir: sandboxContext.sandboxBaseDir })
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
      description: "Find file paths by glob pattern when you know what the path should look like. This tool returns matching file paths only. Use list if you need to browse directories first.",
      parameters: {
        pattern: z.string().describe("Required. Primary glob pattern to match, for example \"*.ts\", \"*Tests.ts\", \"**/*.generated.ts\", or \"src/**/*.ts\"."),
        path: z.string().describe("Required. Absolute or home-relative directory path to search from."),
        include: z.array(z.string()).optional().describe("Optional. Additional file glob patterns to include when one pattern is not enough."),
        exclude: z.array(z.string()).optional().describe("Optional. File glob patterns to exclude from results, for example [\"dist/**\", \"coverage/**\", \"build/**\"] or [\"**/*.generated.ts\"]."),
        offset: z.number().int().min(1).optional().describe("Optional. 1-indexed result number to start from. Default: 1."),
        limit: z.number().int().min(1).optional().describe("Optional. Maximum number of matches to return. Default: 100."),
      },
      implementation: async ({ pattern, path: input, include, exclude, offset, limit }) => {
        const sandboxContext = await resolveSandboxContext()
        const resolved = resolveToolPath(sandboxContext.sandboxBaseDir, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectTraversalRoot(sandboxContext.sandboxBaseDir, resolved.path)
        if (!checked.ok) return formatBoundaryFailure(checked, "directory")

        const start = (offset ?? 1) - 1
        const size = limit ?? FILE_LIMIT
        const files = await globWithRipgrep({
          sandboxBaseDir: sandboxContext.sandboxBaseDir,
          realBase: sandboxContext.realSandboxBaseDir,
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
        "Search file contents by regular expression when you know the text pattern you want to find. Do not use this tool to find files by name or pattern; use glob for that.",
      parameters: {
        pattern: z.string().describe("Required. Regular expression to search for inside file contents, for example \"TODO\", \"describe\\\\(\", or \"export\\\\s+const\"."),
        path: z.string().describe("Required. Absolute or home-relative directory path to search from."),
        include: z.array(z.string()).optional().describe("Optional. File glob patterns limiting which files are searched, for example [\"*.ts\", \"*.js\"] or [\"src/**\"]."),
        exclude: z.array(z.string()).optional().describe("Optional. File glob patterns to leave out of the search, for example [\"dist/**\", \"coverage/**\", \"build/**\"] or [\"**/*.generated.ts\"]."),
        offset: z.number().int().min(1).optional().describe("Optional. 1-indexed match number to start from. Default: 1."),
        limit: z.number().int().min(1).optional().describe("Optional. Maximum number of matches to return. Default: 50."),
      },
      implementation: async ({ pattern, path: input, include, exclude, offset, limit }) => {
        const sandboxContext = await resolveSandboxContext()
        const resolved = resolveToolPath(sandboxContext.sandboxBaseDir, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectTraversalRoot(sandboxContext.sandboxBaseDir, resolved.path)
        if (!checked.ok) return formatBoundaryFailure(checked, "directory")

        const matches = await grepWithRipgrep({
          sandboxBaseDir: sandboxContext.sandboxBaseDir,
          realBase: sandboxContext.realSandboxBaseDir,
          dir: resolved.path,
          pattern,
          include,
          exclude,
        })
        if (isErrorResult(matches)) return matches

        const start = (offset ?? 1) - 1
        const size = limit ?? GREP_LIMIT

        if (matches.length < (offset ?? 1) && !(matches.length === 0 && (offset ?? 1) === 1)) {
          return formatError("out_of_range", "Offset is out of range", [["parameter", "offset"], ["value", offset!], ["total", matches.length], ["unit", "matches"]])
        }

        const slice = matches.slice(start, start + size)
        const fileCount = new Set(slice.map((match) => match.path)).size
        const hasMore = start + slice.length < matches.length
        const out: Array<ReturnType<typeof outputPayload> | [string, string | number | boolean | undefined]> = [
          ["path", resolved.path],
          ["pattern", pattern],
          ["offset", offset ?? 1],
          ["limit", slice.length],
          ["total", matches.length],
          ["has_more", hasMore],
          ["next_offset", hasMore ? start + slice.length + 1 : undefined],
          ["matches_files", fileCount],
        ]
        for (const [index, match] of slice.entries()) {
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
      name: "read",
      description: "Read text from one file when you already know the exact file path and want line-numbered output. Do not use this tool to discover files or directories; use list or glob first if needed.",
      parameters: {
        filePath: z.string().describe("Required. Absolute or home-relative path to the file to read, for example \"~/project/src/index.ts\"."),
        offset: z.number().int().min(1).optional().describe("Optional. 1-indexed starting line number. Default: 1."),
        limit: z.number().int().min(1).optional().describe("Optional. Maximum number of lines to return. Default: 500."),
      },
      implementation: async ({ filePath, offset, limit }) => {
        const sandboxContext = await resolveSandboxContext()
        const resolved = resolveToolPath(sandboxContext.sandboxBaseDir, filePath)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectExistingPath(sandboxContext.sandboxBaseDir, resolved.path, "file")
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
      name: "create",
      description:
        "Create one new file or one new directory. Use this to add files, folders, or initial file content. Make sure type matches what you want to create, because some parameters are valid only for files.",
      parameters: {
        type: z.enum(["file", "directory"]).describe("Required. What to create: \"file\" or \"directory\"."),
        path: z.string().describe("Required. Absolute or home-relative target path to create, for example \"~/project/src/new-file.ts\" or \"/Users/name/project/new-folder\"."),
        recursive: z.boolean().optional().describe("Optional. When true, create missing parent directories. Default: true."),
        fileContent: z.string().optional().describe("Optional. File contents to write when type is \"file\". If omitted for a file, an empty file is created. Do not provide this parameter when type is \"directory\"."),
        overwriteFile: z.boolean().optional().describe("Optional. Only used when type is \"file\". When true, replace an existing file. Default: false."),
        fileEncoding: z.enum(["utf8", "base64"]).optional().describe("Optional. Only used when type is \"file\". \"utf8\" or \"base64\". Default: \"utf8\". Do not provide this parameter when type is \"directory\"."),
      },
      implementation: async ({ type, path: input, recursive, fileContent, overwriteFile, fileEncoding }) => {
        const sandboxContext = await resolveSandboxContext()
        const resolved = resolveToolPath(sandboxContext.sandboxBaseDir, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const target = resolved.path

        if (type === "file") {
          const existing = await inspectExistingPath(sandboxContext.sandboxBaseDir, target, "file")
          if (existing.ok) {
            if (!overwriteFile) return formatError("already_exists", "File already exists", [["kind", "file"], ["path", target]])
          } else if (existing.kind !== "not_found") {
            return formatBoundaryFailure(existing, "file")
          } else {
            const creatable = await inspectCreateTarget(sandboxContext.sandboxBaseDir, target, "file")
            if (!creatable.ok) return formatBoundaryFailure(creatable, "file")
          }

          const resolvedFileEncoding = fileEncoding ?? "utf8"
          const rec = recursive ?? true
          const text = fileContent || ""
          const lines = text.split(/\r?\n/)
          const count = text.length > 0 ? (text.endsWith("\n") ? lines.length - 1 : lines.length) : 0

          try {
            if (rec) await fs.mkdir(path.dirname(target), { recursive: true })
            const bytes = resolvedFileEncoding === "base64"
              ? Buffer.from(text, "base64")
              : Buffer.from(text, "utf8")
            await fs.writeFile(target, bytes)
            return formatOutput([
              ["path", target],
              ["type", "file"],
              ["status", "created"],
              ["fileEncoding", resolvedFileEncoding],
              ["overwritten", existing.ok],
              ["lines", count],
              ["bytes", bytes.byteLength],
            ])
          } catch (error) {
            return formatError("filesystem_error", "Filesystem operation failed", [["path", target], ["details", error instanceof Error ? error.message : String(error)]])
          }
        }

        if (fileContent !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "fileContent"]])
        }
        if (overwriteFile !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "overwriteFile"]])
        }
        if (fileEncoding !== undefined) {
          return formatError("invalid_parameter", "Parameter is not used when type is directory", [["parameter", "fileEncoding"]])
        }

        const existing = await inspectExistingPath(sandboxContext.sandboxBaseDir, target, "directory")
        if (existing.ok) return formatError("already_exists", "Directory already exists", [["kind", "directory"], ["path", target]])
        if (existing.kind !== "not_found") return formatBoundaryFailure(existing, "directory")

        const creatable = await inspectCreateTarget(sandboxContext.sandboxBaseDir, target, "directory")
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
        "Edit a text file by applying exact text replacements in order. Use this only when you know the exact current text to replace and the exact new text to write. This tool is often useful after read or grep has shown you the exact text to change.",
      parameters: {
        filePath: z.string().describe("Required. Absolute or home-relative path to the file to edit."),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("Required. Exact literal text to find. Must not be empty."),
              newString: z.string().describe("Required. Exact replacement text to write. May be empty if you want to delete the matched text."),
              replaceAll: z.boolean().optional().describe("Optional. When true, replace every match of oldString. Default: false, which means the edit expects exactly one match."),
            }),
          )
          .min(1)
          .describe("Required. Non-empty array of edit objects applied in order. Each edit object must include oldString and newString, and may include replaceAll. Example: [{\"oldString\":\"const enabled = false\",\"newString\":\"const enabled = true\"}]."),
        fileEncoding: z.enum(["utf8"]).optional().describe("Optional. File encoding. \"utf8\". Default: \"utf8\"."),
      },
      implementation: async ({ filePath: input, edits, fileEncoding }) => {
        const sandboxContext = await resolveSandboxContext()
        const resolved = resolveToolPath(sandboxContext.sandboxBaseDir, input)
        if (resolved.error || !resolved.path) return resolved.error!

        const checked = await inspectExistingPath(sandboxContext.sandboxBaseDir, resolved.path, "file")
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

        const resolvedFileEncoding = fileEncoding ?? "utf8"

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
          ["fileEncoding", resolvedFileEncoding],
          ["changes_requested", edits.length],
          ["changes_performed", edits.length],
        ])
      },
    }),
  )

  return tools
}
