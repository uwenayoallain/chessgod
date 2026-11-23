import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { reportFrontendEvent } from '@/lib/telemetry'

type Props = {
  children: ReactNode
  /** Which part of the app this guards, for the error report. */
  name?: string
}
type State = { failure: 'none' | 'stale-build' | 'error' }

/**
 * A chunk the server no longer has: what a tab opened before the last deploy
 * gets when it opens a lazy page. Browsers word it differently.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'A value that is not an Error was thrown'
}

export function isStaleBuildError(error: unknown): boolean {
  const message = messageOf(error)
  return /dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to load module script/i.test(
    message,
  )
}

/**
 * Keeps one page's failure to that page. Without a boundary a lazy chunk that
 * cannot load (a tab older than the last deploy), or a render error inside a
 * page, unmounts the whole app and the screen goes blank. This shows what
 * happened in that page's space and the one action that fixes it.
 *
 * It says which of the two happened. Every failure used to be blamed on an
 * update, which is a guess when the cause is a bug in the page: the player is
 * told to reload for a new version that does not exist, and nobody hears of
 * the bug. A render error is reported to the observability panel instead.
 */
export class PageBoundary extends Component<Props, State> {
  state: State = { failure: 'none' }

  static getDerivedStateFromError(error: unknown): State {
    return { failure: isStaleBuildError(error) ? 'stale-build' : 'error' }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const stale = isStaleBuildError(error)
    try {
      reportFrontendEvent({
        kind: 'error',
        name: stale ? 'page_chunk_missing' : 'page_render_error',
        // A stale tab is expected after every deploy; a render error is a bug.
        severity: stale ? 'warn' : 'error',
        message: messageOf(error),
        stack: error instanceof Error ? error.stack : undefined,
        url: typeof window === 'undefined' ? undefined : window.location.href,
        meta: {
          boundary: this.props.name ?? 'page',
          component_stack: info.componentStack?.slice(0, 1000) ?? null,
        },
      })
    } catch {
      // Reporting must never be the thing that takes the page down.
    }
  }

  render() {
    if (this.state.failure === 'none') return this.props.children
    return (
      <div className="panel-error" role="alert">
        <p>
          {this.state.failure === 'stale-build'
            ? 'This page did not load. The app was updated while this tab was open; reload to get the new version.'
            : 'This page did not load. Something in it failed, and the error has been reported. Reloading usually brings it back.'}
        </p>
        <Button onClick={() => window.location.reload()} type="button" variant="primary">
          Reload
        </Button>
      </div>
    )
  }
}
