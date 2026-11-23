import { Component, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

type Props = { children: ReactNode }
type State = { failed: boolean }

/**
 * Keeps one page's failure to that page. Without a boundary a lazy chunk that
 * cannot load (a tab older than the last deploy), or a render error inside a
 * page, unmounts the whole app and the screen goes blank. This shows what
 * happened in that page's space and the one action that fixes it.
 */
export class PageBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="panel-error" role="alert">
        <p>This page did not load. The app was probably updated while this tab was open.</p>
        <Button onClick={() => window.location.reload()} type="button" variant="primary">
          Reload
        </Button>
      </div>
    )
  }
}
