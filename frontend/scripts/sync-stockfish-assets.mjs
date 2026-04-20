import { mkdir, copyFile, access, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(__dirname, '..')
const stockfishDir = path.join(frontendDir, 'public', 'stockfish')
const stockfishPackageDir = path.join(frontendDir, 'node_modules', '@lichess-org', 'stockfish-web')
const nnueFilename = 'nn-4ca89e4b3abf.nnue'
const nnueUrl = `https://tests.stockfishchess.org/api/nn/${nnueFilename}`
const skipNnueDownload = process.env.SKIP_STOCKFISH_NNUE_DOWNLOAD === '1'

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function copyIfMissing(source, target) {
  if (await exists(target)) {
    return
  }

  await copyFile(source, target)
}

async function downloadIfMissing(url, target) {
  if (await exists(target)) {
    return
  }

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  await writeFile(target, Buffer.from(arrayBuffer))
}

async function main() {
  await mkdir(stockfishDir, { recursive: true })
  await copyIfMissing(
    path.join(stockfishPackageDir, 'sf_18_smallnet.js'),
    path.join(stockfishDir, 'sf_18_smallnet.js'),
  )
  await copyIfMissing(
    path.join(stockfishPackageDir, 'sf_18_smallnet.wasm'),
    path.join(stockfishDir, 'sf_18_smallnet.wasm'),
  )
  if (!skipNnueDownload) {
    await downloadIfMissing(nnueUrl, path.join(stockfishDir, nnueFilename))
  }
}

await main()
