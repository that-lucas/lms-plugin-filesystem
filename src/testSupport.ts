import * as fs from "node:fs/promises"

export type LinkSupport = {
  symlinks: boolean
}

export const createLink = async (target: string, linkPath: string, type: "file" | "dir" = "file") => {
  const linkType = process.platform === "win32" && type === "dir" ? "junction" : type
  await fs.symlink(target, linkPath, linkType)
}

export const detectLinkSupport = async (tmpDir: string) => {
  const target = `${tmpDir}-target`
  const link = `${tmpDir}-link`
  await fs.writeFile(target, "ok\n")
  try {
    await createLink(target, link)
    return { symlinks: true }
  } catch {
    return { symlinks: false }
  } finally {
    await fs.rm(link, { force: true }).catch(() => undefined)
    await fs.rm(target, { force: true }).catch(() => undefined)
  }
}
