import { mkdir, copyFile, access, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureNnueFile } from './stockfish-network.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(__dirname, '..')
const stockfishDir = path.join(frontendDir, 'public', 'stockfish')
const stockfishPackageDir = path.join(frontendDir, 'node_modules', '@lichess-org', 'stockfish-web')
// Stockfish 19 retired the secondary NNUE network used by sf_18. Keep this
// pinned to the filename published for the sf_19 target in stockfish-web so a
// release cannot silently start with the wrong evaluation network.
const engineFiles = ['sf_19.js', 'sf_19.wasm']
const nnueFilenames = ['nn-1a298aa575a0.nnue']
const retiredFiles = ['sf_18.js', 'sf_18.wasm', 'nn-c288c895ea92.nnue', 'nn-37f18f62d772.nnue']
const skipNnueDownload = process.env.SKIP_STOCKFISH_NNUE_DOWNLOAD === '1'

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function copyIfChanged(source, target) {
  if (await exists(target)) {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)])
    if (sourceBytes.equals(targetBytes)) {
      return
    }
  }

  await copyFile(source, target)
}

async function main() {
  await mkdir(stockfishDir, { recursive: true })

  for (const filename of retiredFiles) {
    await rm(path.join(stockfishDir, filename), { force: true })
  }

  for (const file of engineFiles) {
    await copyIfChanged(path.join(stockfishPackageDir, file), path.join(stockfishDir, file))
  }

  if (!skipNnueDownload) {
    for (const filename of nnueFilenames) {
      await ensureNnueFile(
        `https://tests.stockfishchess.org/api/nn/${filename}`,
        path.join(stockfishDir, filename),
      )
    }
  }
}

await main()
