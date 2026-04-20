const STOCKFISH_MODULE_PATH = '/stockfish/sf_18_smallnet.js'
const STOCKFISH_ASSET_BASE_PATH = '/stockfish/'

export function getStockfishModuleUrl(origin: string) {
  return new URL(STOCKFISH_MODULE_PATH, origin).href
}

export function getStockfishNnueUrl(origin: string, filename: string) {
  return new URL(`${STOCKFISH_ASSET_BASE_PATH}${filename}`, origin).href
}
