import { useState } from 'react'

import { GameReviewPanel } from '@/components/analysis/game-review-panel'
import { reviewCoverage } from '@/lib/analysis/game-review'
import { QUICK_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { EngineLines } from '@/components/analysis/engine-lines'
import { SparringPanel } from '@/components/sparring/sparring-panel'
import { MoveTreePanel } from '@/components/tree/move-tree-panel'
import { TheoryComparison } from '@/components/theory/theory-comparison'
import {
  CollapsibleSection,
  readSectionOpen,
  writeSectionOpen,
} from '@/components/ui/collapsible-section'
import { GameListPanel } from '@/components/workspace/game-list-panel'
import { OpeningGroupsPanel } from '@/components/workspace/opening-groups-panel'
import type { useBoardWorkspace } from '@/hooks/use-board-workspace'
import { useStableCallback } from '@/hooks/use-stable-callback'
import { useTheory } from '@/hooks/use-theory'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { useAppStore } from '@/store/app-store'
import { useIsSparring, useSparStore } from '@/store/spar-store'

function TheoryAtPosition() {
  const currentFen = useAppStore((state) => state.currentFen)
  const theory = useTheory(currentFen)
  return <TheoryComparison data={theory.data} isRefreshing={theory.isRefreshing} />
}

/**
 * "Explore" tab: everything anchored to the board — pick something to load
 * (openings/games library), understand the current position (your tree +
 * master theory), and run the live engine.
 */
export function ExplorePanel({
  username,
  color,
  timeClass,
  workspace,
  engineOpen,
  onEngineOpenChange,
  isAnalyzing,
  engineLines,
  annotations,
  fenHistory,
  userColor,
}: {
  username: string
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  workspace: ReturnType<typeof useBoardWorkspace>
  engineOpen: boolean
  onEngineOpenChange: (open: boolean) => void
  isAnalyzing: boolean
  engineLines: UCIInfo[]
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
  userColor: 'white' | 'black' | null
}) {
  const [libraryView, setLibraryView] = useState<'openings' | 'games'>('openings')
  const [libraryOpen, setLibraryOpen] = useState(() => readSectionOpen('explore-library', false))
  // Stable, so the memoised opening list does not re-render on every board step.
  const selectOpening = useStableCallback(workspace.loadOpening)
  const sparring = useIsSparring()
  const sparReview = useSparStore((state) => state.reviewing)
  const treeEpoch = useAppStore((state) => state.treeEpoch)
  // A finished game against the engine, still on the board.
  const reviewingSparGame = sparReview !== null && sparReview.epoch === treeEpoch
  // While a game is in progress its controls lead the panel; otherwise the
  // review of a loaded game does.
  const sparringSection = (
    <CollapsibleSection
      description="A game against Stockfish at your strength"
      id="explore-sparring"
      title="Play the engine"
    >
      <SparringPanel onBeforeNewGame={workspace.clearLoadedContext} username={username} />
    </CollapsibleSection>
  )
  const coverage = reviewCoverage(annotations)

  return (
    <div className="theory-stack">
      {/* The game review is the payoff of loading a game, so it gets its own
          section. It used to live inside "Engine" — collapsing that section
          hid it entirely, and its name collided with the Review tab. */}
      {sparring ? sparringSection : null}
      <CollapsibleSection
        description="What the engine made of the game on the board"
        id="explore-game-review"
        meta={
          annotations.length ? (
            <span className="muted">
              {coverage.judged} of {coverage.total} moves
            </span>
          ) : null
        }
        title="Game review"
      >
        {sparring ? (
          <p className="muted sparring__note">The review opens when the game ends.</p>
        ) : (
          <GameReviewPanel
            annotations={annotations}
            fenHistory={fenHistory}
            opponentTitle={reviewingSparGame ? 'Stockfish' : 'Opponent'}
            reviewDepth={reviewingSparGame ? QUICK_REVIEW_DEPTH : undefined}
            userColor={reviewingSparGame ? sparReview.userColor : userColor}
          />
        )}
      </CollapsibleSection>

      {sparring ? null : sparringSection}
      <CollapsibleSection
        description="Live evaluation of the position on the board"
        id="explore-engine"
        onOpenChange={onEngineOpenChange}
        open={engineOpen}
        title="Engine"
      >
        <EngineLines hidden={sparring} isAnalyzing={isAnalyzing} lines={engineLines} />
      </CollapsibleSection>

      <CollapsibleSection
        id="explore-library"
        title="Library"
        defaultOpen={false}
        onOpenChange={setLibraryOpen}
        open={libraryOpen}
        meta={
          <span className="workspace-tabs__list" onClick={(e) => e.stopPropagation()}>
            {(['openings', 'games'] as const).map((view) => (
              <button
                className={`workspace-tabs__button${libraryView === view ? ' workspace-tabs__button--active' : ''}`}
                key={view}
                onClick={(e) => {
                  e.stopPropagation()
                  setLibraryView(view)
                  // Choosing a view while the section is closed used to do
                  // nothing visible: the switch sits in the header, the list
                  // stayed hidden.
                  if (!libraryOpen) {
                    setLibraryOpen(true)
                    writeSectionOpen('explore-library', true)
                  }
                }}
                type="button"
              >
                {view === 'openings' ? 'Openings' : 'Games'}
              </button>
            ))}
          </span>
        }
      >
        {libraryView === 'openings' ? (
          <OpeningGroupsPanel
            color={color}
            isLoadingPreview={workspace.trainingLine.isLoading}
            onSelectOpening={selectOpening}
            previewError={workspace.trainingLine.error}
            selectedOpening={workspace.selectedOpening}
            timeClass={timeClass}
            username={username}
          />
        ) : (
          <GameListPanel
            color={color}
            currentFen={workspace.currentFen}
            eco={workspace.gameFilters.eco}
            onSelectGame={workspace.loadGame}
            openingName={workspace.gameFilters.openingName}
            selectedGameId={workspace.selectedGameId}
            timeClass={timeClass}
            username={username}
          />
        )}
      </CollapsibleSection>

      <CollapsibleSection id="explore-position" title="This Position" defaultOpen={false}>
        <MoveTreePanel />
        <TheoryAtPosition />
      </CollapsibleSection>
    </div>
  )
}
