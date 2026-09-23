import { create } from 'zustand'

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

function loadStoredUsername() {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage.getItem('chessgod.username')
}

function loadStoredKeepUserOnBottom() {
  if (typeof window === 'undefined') {
    return false
  }
  return window.localStorage.getItem('chessgod.keepUserOnBottom') === 'true'
}

function loadStoredTimeClass() {
  if (typeof window === 'undefined') {
    return 'rapid_blitz'
  }
  return window.localStorage.getItem('chessgod.timeClass') || 'rapid_blitz'
}

export type ImportProgress = {
  currentArchive: string
  archiveIndex: number
  totalArchives: number
  gamesInArchive: number
  currentGameIndex: number
  currentGameLabel: string
  newGames: number
  skippedGames: number
  archiveNewGames: number
  archiveSkippedGames: number
  cached: boolean
  complete: boolean
  cachedArchives: number
}

export type ReplayMove = {
  ply: number
  san: string
  uci: string
  fen: string
}

export type MoveNode = {
  id: string
  fen: string
  san: string | null
  uci: string | null
  ply: number
  parentId: string | null
  children: string[]
}

const ROOT_ID = 'root'

let nextNodeCounter = 0
function generateNodeId(): string {
  nextNodeCounter += 1
  return `n${nextNodeCounter}`
}

/**
 * `lastUci` records the move that produced this position without adding it to
 * the line. A drill jumps straight to a position, so there is no parent node to
 * highlight from — but the player still needs to see the move they are
 * answering. `san` stays null so the root is never counted as a played move.
 */
function createRootNode(fen = STARTING_FEN, lastUci: string | null = null): MoveNode {
  return {
    id: ROOT_ID,
    fen,
    san: null,
    uci: lastUci,
    ply: 0,
    parentId: null,
    children: [],
  }
}

function pathToRoot(nodes: Record<string, MoveNode>, nodeId: string): MoveNode[] {
  const path: MoveNode[] = []
  let current = nodes[nodeId]
  while (current) {
    path.unshift(current)
    current = current.parentId ? nodes[current.parentId] : (undefined as unknown as MoveNode)
  }
  return path
}

type AppState = {
  username: string | null
  currentFen: string
  boardOrientation: 'white' | 'black'
  keepUserOnBottom: boolean
  colorFilter: 'white' | 'black' | 'both'
  timeClassFilter: string | null
  isLoadingGame: boolean
  importStatus: 'idle' | 'running' | 'complete' | 'error'
  importProgress: ImportProgress | null
  analysisRequested: boolean

  nodes: Record<string, MoveNode>
  currentNodeId: string
  mainLine: string[]

  fenHistory: string[]
  moveHistory: string[]
  replayMoves: ReplayMove[]
  historyIndex: number
  bookPlies: number[]
  hasLoadedLine: boolean
  // True while a drill is waiting for the player's move. The board must not hint
  // at the answer with guidance arrows or move annotations while it is set.
  drillSolving: boolean
  // Bumped whenever the move tree is replaced wholesale (a game, a drill, an
  // opening or a cleared board). Anything that owns the current line — a
  // sparring game — compares it to know its line is gone.
  treeEpoch: number

  setUsername: (username: string) => void
  clearUsername: () => void
  setCurrentFen: (fen: string) => void
  loadPosition: (fen: string, lastUci?: string | null) => void
  pushPosition: (fen: string, san?: string, uci?: string) => void
  loadReplay: (moves: ReplayMove[], startIndex?: number, source?: 'loaded' | 'free') => void
  clearLoadedLine: () => void
  setDrillSolving: (value: boolean) => void
  jumpToNode: (nodeId: string) => void
  jumpToIndex: (index: number) => void
  goBack: () => void
  goForward: () => void
  resetToStart: () => void
  flipBoard: () => void
  setKeepUserOnBottom: (value: boolean) => void
  alignBoardToUserColor: (userColor: string | null) => void
  setColorFilter: (color: 'white' | 'black' | 'both') => void
  setTimeClassFilter: (value: string | null) => void
  setIsLoadingGame: (loading: boolean) => void
  setImportStatus: (status: AppState['importStatus']) => void
  setImportProgress: (progress: ImportProgress | null) => void
  setBookPlies: (plies: number[]) => void
  setAnalysisRequested: (requested: boolean) => void
  getCurrentPath: () => MoveNode[]
  getMainLineMoves: () => ReplayMove[]
}

function deriveCompat(nodes: Record<string, MoveNode>, currentNodeId: string, mainLine: string[]) {
  const path = pathToRoot(nodes, currentNodeId)
  const fenHistory = path.map((n) => n.fen)
  const moveHistory = path.filter((n) => n.san).map((n) => n.san!)
  const mainLineMoves: ReplayMove[] = mainLine
    .map((id) => nodes[id])
    .filter((n): n is MoveNode => Boolean(n?.san))
    .map((n) => ({ ply: n.ply, san: n.san!, uci: n.uci ?? '', fen: n.fen }))
  const historyIndex = path.length - 1
  return { fenHistory, moveHistory, replayMoves: mainLineMoves, historyIndex }
}

export const useAppStore = create<AppState>((set, get) => {
  const rootNode = createRootNode()
  const initialNodes = { [ROOT_ID]: rootNode }
  const initialCompat = deriveCompat(initialNodes, ROOT_ID, [])

  return {
    username: loadStoredUsername(),
    currentFen: STARTING_FEN,
    boardOrientation: 'white',
    keepUserOnBottom: loadStoredKeepUserOnBottom(),
    colorFilter: 'both',
    timeClassFilter: loadStoredTimeClass(),
    isLoadingGame: false,
    importStatus: 'idle',
    importProgress: null,
    analysisRequested: false,

    nodes: initialNodes,
    currentNodeId: ROOT_ID,
    mainLine: [],

    bookPlies: [],
    hasLoadedLine: false,
    drillSolving: false,
    treeEpoch: 0,
    ...initialCompat,

    setUsername: (username) => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('chessgod.username', username)
      }
      set({ username })
    },

    clearUsername: () => {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('chessgod.username')
      }
      set({ username: null, importStatus: 'idle', importProgress: null })
    },

    setCurrentFen: (fen) =>
      set({ currentFen: fen, analysisRequested: false, hasLoadedLine: false }),

    loadPosition: (fen, lastUci = null) => {
      nextNodeCounter = 0
      const rootNode = createRootNode(fen, lastUci)
      const nodes = { [ROOT_ID]: rootNode }
      const compat = deriveCompat(nodes, ROOT_ID, [])
      set((state) => ({
        treeEpoch: state.treeEpoch + 1,
        nodes,
        currentNodeId: ROOT_ID,
        mainLine: [],
        currentFen: fen,
        analysisRequested: false,
        bookPlies: [],
        hasLoadedLine: false,
        ...compat,
      }))
    },

    pushPosition: (fen, san, uci) => {
      const { nodes, currentNodeId, mainLine } = get()
      const parentNode = nodes[currentNodeId]
      if (!parentNode) return

      const existingChildId = parentNode.children.find((id) => nodes[id]?.fen === fen)
      if (existingChildId) {
        const compat = deriveCompat(nodes, existingChildId, mainLine)
        set({
          currentFen: fen,
          currentNodeId: existingChildId,
          analysisRequested: false,
          ...compat,
        })
        return
      }

      const newId = generateNodeId()
      const newNode: MoveNode = {
        id: newId,
        fen,
        san: san ?? null,
        uci: uci ?? null,
        ply: parentNode.ply + 1,
        parentId: currentNodeId,
        children: [],
      }

      const updatedParent = {
        ...parentNode,
        children: [...parentNode.children, newId],
      }
      const updatedNodes = {
        ...nodes,
        [currentNodeId]: updatedParent,
        [newId]: newNode,
      }
      const compat = deriveCompat(updatedNodes, newId, mainLine)
      set({
        nodes: updatedNodes,
        currentNodeId: newId,
        currentFen: fen,
        analysisRequested: false,
        ...compat,
      })
    },

    loadReplay: (moves, startIndex = 0, source = 'loaded') => {
      nextNodeCounter = 0
      const rootNode = createRootNode()
      const newNodes: Record<string, MoveNode> = { [ROOT_ID]: rootNode }
      const newMainLine: string[] = []
      let prevId = ROOT_ID

      for (const move of moves) {
        const id = generateNodeId()
        newNodes[id] = {
          id,
          fen: move.fen,
          san: move.san,
          uci: move.uci,
          ply: move.ply,
          parentId: prevId,
          children: [],
        }
        newNodes[prevId] = {
          ...newNodes[prevId],
          children: [...newNodes[prevId].children, id],
        }
        newMainLine.push(id)
        prevId = id
      }

      const targetNodeId = startIndex === 0 ? ROOT_ID : (newMainLine[startIndex - 1] ?? ROOT_ID)
      const targetFen = newNodes[targetNodeId].fen
      const compat = deriveCompat(newNodes, targetNodeId, newMainLine)

      set((state) => ({
        treeEpoch: state.treeEpoch + 1,
        nodes: newNodes,
        currentNodeId: targetNodeId,
        mainLine: newMainLine,
        currentFen: targetFen,
        analysisRequested: false,
        hasLoadedLine: source === 'loaded' && moves.length > 0,
        ...compat,
      }))
    },

    setDrillSolving: (value) => set({ drillSolving: value }),

    clearLoadedLine: () => {
      nextNodeCounter = 0
      const rootNode = createRootNode()
      const newNodes = { [ROOT_ID]: rootNode }
      const compat = deriveCompat(newNodes, ROOT_ID, [])

      set((state) => ({
        treeEpoch: state.treeEpoch + 1,
        nodes: newNodes,
        currentNodeId: ROOT_ID,
        mainLine: [],
        currentFen: STARTING_FEN,
        analysisRequested: false,
        bookPlies: [],
        hasLoadedLine: false,
        drillSolving: false,
        ...compat,
      }))
    },

    jumpToNode: (nodeId) => {
      const { nodes, mainLine } = get()
      const node = nodes[nodeId]
      if (!node) return
      const compat = deriveCompat(nodes, nodeId, mainLine)
      set({
        currentNodeId: nodeId,
        currentFen: node.fen,
        analysisRequested: false,
        ...compat,
      })
    },

    jumpToIndex: (index) => {
      const { nodes, currentNodeId, mainLine } = get()
      if (index === 0) {
        const compat = deriveCompat(nodes, ROOT_ID, mainLine)
        set({
          currentNodeId: ROOT_ID,
          currentFen: nodes[ROOT_ID]?.fen ?? STARTING_FEN,
          analysisRequested: false,
          ...compat,
        })
        return
      }

      if (mainLine.length > 0 && index > 0 && index <= mainLine.length) {
        const targetId = mainLine[index - 1]
        const node = nodes[targetId]
        if (node) {
          const compat = deriveCompat(nodes, targetId, mainLine)
          set({
            currentNodeId: targetId,
            currentFen: node.fen,
            analysisRequested: false,
            ...compat,
          })
          return
        }
      }

      const path = pathToRoot(nodes, currentNodeId)
      if (index >= 0 && index < path.length) {
        const node = path[index]
        const compat = deriveCompat(nodes, node.id, mainLine)
        set({
          currentNodeId: node.id,
          currentFen: node.fen,
          analysisRequested: false,
          ...compat,
        })
      }
    },

    goBack: () => {
      const { nodes, currentNodeId, mainLine } = get()
      const current = nodes[currentNodeId]
      if (!current?.parentId) return
      const parent = nodes[current.parentId]
      if (!parent) return
      const compat = deriveCompat(nodes, parent.id, mainLine)
      set({
        currentNodeId: parent.id,
        currentFen: parent.fen,
        analysisRequested: false,
        ...compat,
      })
    },

    goForward: () => {
      const { nodes, currentNodeId, mainLine } = get()
      const current = nodes[currentNodeId]
      if (!current || current.children.length === 0) return

      const mainLineChild = current.children.find((id) => mainLine.includes(id))
      const nextId = mainLineChild ?? current.children[0]
      const next = nodes[nextId]
      if (!next) return

      const compat = deriveCompat(nodes, nextId, mainLine)
      set({
        currentNodeId: nextId,
        currentFen: next.fen,
        analysisRequested: false,
        ...compat,
      })
    },

    resetToStart: () => {
      const { nodes, mainLine } = get()
      const compat = deriveCompat(nodes, ROOT_ID, mainLine)
      set({
        currentNodeId: ROOT_ID,
        currentFen: nodes[ROOT_ID]?.fen ?? STARTING_FEN,
        analysisRequested: false,
        ...compat,
      })
    },

    flipBoard: () =>
      set((state) => ({
        boardOrientation: state.boardOrientation === 'white' ? 'black' : 'white',
      })),

    setKeepUserOnBottom: (keepUserOnBottom) => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('chessgod.keepUserOnBottom', String(keepUserOnBottom))
      }
      set({ keepUserOnBottom })
    },

    alignBoardToUserColor: (userColor) => {
      set({ boardOrientation: userColor === 'black' ? 'black' : 'white' })
    },

    setColorFilter: (colorFilter) => set({ colorFilter }),
    setTimeClassFilter: (timeClassFilter) => {
      if (typeof window !== 'undefined') {
        if (timeClassFilter) window.localStorage.setItem('chessgod.timeClass', timeClassFilter)
        else window.localStorage.removeItem('chessgod.timeClass')
      }
      set({ timeClassFilter })
    },
    setIsLoadingGame: (isLoadingGame) => set({ isLoadingGame }),
    setImportStatus: (importStatus) => set({ importStatus }),
    setImportProgress: (importProgress) => set({ importProgress }),
    setBookPlies: (bookPlies) => set({ bookPlies }),
    setAnalysisRequested: (analysisRequested) => set({ analysisRequested }),

    getCurrentPath: () => {
      const { nodes, currentNodeId } = get()
      return pathToRoot(nodes, currentNodeId)
    },

    getMainLineMoves: () => {
      const { nodes, mainLine } = get()
      return mainLine
        .map((id) => nodes[id])
        .filter((n): n is MoveNode => Boolean(n?.san))
        .map((n) => ({
          ply: n.ply,
          san: n.san!,
          uci: n.uci ?? '',
          fen: n.fen,
        }))
    },
  }
})
