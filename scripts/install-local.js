const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { spawn } = require("node:child_process")

const projectRoot = path.resolve(__dirname, "..")

const rootFiles = [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "tsconfig.json",
]

const shouldIncludeSrcFile = (fileName) => {
  if (fileName.endsWith(".test.ts")) return false
  return fileName.endsWith(".ts")
}

const copyIfExists = async (relativePath, targetRoot) => {
  const sourcePath = path.join(projectRoot, relativePath)
  try {
    const stat = await fs.stat(sourcePath)
    if (!stat.isFile()) return
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }

  const targetPath = path.join(targetRoot, relativePath)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.copyFile(sourcePath, targetPath)
}

const copyRuntimeSource = async (targetRoot) => {
  const sourceRoot = path.join(projectRoot, "src")
  const targetSourceRoot = path.join(targetRoot, "src")

  const visit = async (currentSource, currentTarget) => {
    const entries = await fs.readdir(currentSource, { withFileTypes: true })
    await fs.mkdir(currentTarget, { recursive: true })

    for (const entry of entries) {
      const sourcePath = path.join(currentSource, entry.name)
      const targetPath = path.join(currentTarget, entry.name)

      if (entry.isDirectory()) {
        await visit(sourcePath, targetPath)
        continue
      }

      if (!entry.isFile() || !shouldIncludeSrcFile(entry.name)) continue
      await fs.copyFile(sourcePath, targetPath)
    }
  }

  await visit(sourceRoot, targetSourceRoot)
}

const runInstall = (cwd, args) => new Promise((resolve, reject) => {
  const child = spawn("lms", ["dev", "--install", ...args], {
    cwd,
    stdio: "inherit",
  })

  child.on("error", reject)
  child.on("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`lms dev --install exited from signal ${signal}`))
      return
    }
    resolve(code ?? 1)
  })
})

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lms-plugin-install-"))

  try {
    await Promise.all(rootFiles.map((relativePath) => copyIfExists(relativePath, tempRoot)))
    await copyRuntimeSource(tempRoot)

    const args = process.argv.slice(2)
    const exitCode = await runInstall(tempRoot, args)
    process.exitCode = exitCode
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
