/// <reference types="node" />

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'

import { ensureNnueFile } from '../scripts/stockfish-network.mjs'

const filename = 'nn-039058c6f2c0.nnue'
const validBytes = new Uint8Array([1, 2, 3])
let directory: string
let target: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'chessgod-network-test-'))
  target = path.join(directory, filename)
})

afterEach(async () => {
  // The test owns this generated directory; no installed model is touched.
  await rm(directory, { recursive: true, force: true })
})

it('keeps an intact installed model without making a network request', async () => {
  await writeFile(target, validBytes)
  const fetch = vi.fn()
  expect(await ensureNnueFile('https://model.test/network', target, fetch)).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('repairs an incomplete model and removes its staging files', async () => {
  await writeFile(target, new Uint8Array([1]))
  const fetch = vi.fn(async () => new Response(validBytes))
  expect(await ensureNnueFile('https://model.test/network', target, fetch)).toBe(true)
  expect(new Uint8Array(await readFile(target))).toEqual(validBytes)
  expect(await readdir(directory)).toEqual([filename])
})

it('does not publish corrupted downloaded bytes', async () => {
  const fetch = vi.fn(async () => new Response(new Uint8Array([9])))
  await expect(ensureNnueFile('https://model.test/network', target, fetch)).rejects.toThrow(
    'integrity check failed',
  )
  expect(await readdir(directory)).toEqual([])
})

it('leaves the existing file unchanged when a replacement stream fails', async () => {
  const original = new Uint8Array([9])
  await writeFile(target, original)
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(validBytes)
          },
          pull(controller) {
            controller.error(new Error('Connection lost'))
          },
        }),
      ),
  )
  await expect(ensureNnueFile('https://model.test/network', target, fetch)).rejects.toThrow(
    'Connection lost',
  )
  expect(new Uint8Array(await readFile(target))).toEqual(original)
  expect(await readdir(directory)).toEqual([filename])
})

it('isolates concurrent installs of the same model', async () => {
  const fetch = vi.fn(async () => new Response(validBytes))
  await Promise.all([
    ensureNnueFile('https://model.test/network', target, fetch),
    ensureNnueFile('https://model.test/network', target, fetch),
  ])
  expect(new Uint8Array(await readFile(target))).toEqual(validBytes)
  expect(await readdir(directory)).toEqual([filename])
})
