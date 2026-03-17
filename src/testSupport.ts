import * as fs from "node:fs/promises"

export type LinkSupport = {
  fileSymlinks: boolean
  dirLinks: boolean
}

export const createLink = async (target: string, linkPath: string, type: "file" | "dir" = "file") => {
  const linkType = process.platform === "win32" && type === "dir" ? "junction" : type
  await fs.symlink(target, linkPath, linkType)
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
