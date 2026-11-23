import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Verify existing/downloaded bytes without buffering the full network in memory. */
export async function ensureNnueFile(url, target, fetchImpl = fetch) {
  const expected = /^nn-([a-f0-9]{12})\.nnue$/.exec(path.basename(target))?.[1]
  if (!expected) throw new Error('Invalid NNUE filename')

  try {
    const existingHash = createHash('sha256')
    for await (const chunk of createReadStream(target)) existingHash.update(chunk)
    if (existingHash.digest('hex').startsWith(expected)) return false
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`)
  }

  // A unique staging directory also isolates concurrent install/startup runs.
  // Only the final rename exposes new bytes at the public model URL.
  const staging = await mkdtemp(path.join(path.dirname(target), '.nnue-'))
  const partial = path.join(staging, 'network.part')
  try {
    const hash = createHash('sha256')
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(partial, { flags: 'wx' }),
    )
    if (!hash.digest('hex').startsWith(expected)) {
      throw new Error(`NNUE integrity check failed for ${path.basename(target)}`)
    }
    await rename(partial, target)
    return true
  } finally {
    // This exact directory was created by this invocation and holds only its partial file.
    await rm(staging, { recursive: true, force: true })
  }
}
