import * as fs from "node:fs/promises"
import type { PathLike } from "node:fs"
import path from "node:path"
import { setBoundaryRealpathForTests } from "./boundary"

export type LinkSupport = {
  fileSymlinks: boolean
  dirLinks: boolean
}

export const createLink = async (target: string, linkPath: string, type: "file" | "dir" = "file") => {
  const linkType = process.platform === "win32" && type === "dir" ? "junction" : type
  await fs.symlink(target, linkPath, linkType)
}

export const createBrokenFileLink = async (target: string, linkPath: string) => {
  await createLink(target, linkPath, "file")
}

export const createBrokenDirLink = async (target: string, linkPath: string) => {
  await createLink(target, linkPath, "dir")
}

export const createSymlinkLoopPair = async (first: string, second: string, type: "file" | "dir" = "dir") => {
  await createLink(second, first, type)
  await createLink(first, second, type)
}

export const mockRealpathFailure = (target: string, error: NodeJS.ErrnoException) => {
  const original = (filePath: PathLike) => fs.realpath(filePath, "utf8")
  setBoundaryRealpathForTests((async (filePath: PathLike) => {
    const normalized = typeof filePath === "string" ? filePath : filePath.toString()
    if (path.resolve(normalized) === path.resolve(target)) throw error
    return await original(normalized)
  }) as typeof fs.realpath)
  return {
    mockRestore() {
      setBoundaryRealpathForTests()
    },
  }
}

export const detectLinkSupport = async (tmpDir: string) => {
  const fileTarget = `${tmpDir}-file-target`
  const fileLink = `${tmpDir}-file-link`
  const dirTarget = `${tmpDir}-dir-target`
  const dirLink = `${tmpDir}-dir-link`
  await fs.writeFile(fileTarget, "ok\n")
  await fs.mkdir(dirTarget, { recursive: true })
  let fileSymlinks = false
  let dirLinks = false
  try {
    await createLink(fileTarget, fileLink)
    fileSymlinks = true
  } catch {}

  try {
    await createLink(dirTarget, dirLink, "dir")
    dirLinks = true
  } catch {} finally {
    await fs.rm(fileLink, { force: true, recursive: true }).catch(() => undefined)
    await fs.rm(fileTarget, { force: true }).catch(() => undefined)
    await fs.rm(dirLink, { force: true, recursive: true }).catch(() => undefined)
    await fs.rm(dirTarget, { force: true, recursive: true }).catch(() => undefined)
  }

  return { fileSymlinks, dirLinks }
}
