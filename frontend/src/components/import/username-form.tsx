import { FormEvent, useState } from 'react'
import { AlertTriangle, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useImport } from '@/hooks/use-import'
import { useAppStore } from '@/store/app-store'

export function UsernameForm() {
  const username = useAppStore((state) => state.username ?? '')
  const setUsername = useAppStore((state) => state.setUsername)
  const [draft, setDraft] = useState(username)
  const [hint, setHint] = useState<string | null>(null)
  const { status, startImport, error } = useImport(draft)
  const isRunning = status === 'running'

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (draft.trim().length === 0) {
      setHint('Type the Chess.com username whose games you want to read.')
      return
    }
    setHint(null)
    setUsername(draft)
    void startImport()
  }

  return (
    <Card className="landing__card">
      <CardHeader>
        <h2>Start here</h2>
      </CardHeader>
      <CardBody>
        <form className="column" style={{ gap: '18px' }} onSubmit={handleSubmit}>
          <label className="column" style={{ gap: '8px' }} htmlFor="username">
            <span className="field-label">Chess.com username</span>
            <Input
              autoComplete="username"
              autoFocus
              id="username"
              onChange={(event) => {
                setDraft(event.target.value)
                setHint(null)
              }}
              placeholder="hikaru"
              spellCheck={false}
              value={draft}
            />
            <div className="landing__quick-picks">
              <div className="landing__quick-picks-list">
                {['saint_uwe', 'hikaru', 'magnuscarlsen'].map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="quick-pick-pill"
                    onClick={() => {
                      setDraft(name)
                      setHint(null)
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </label>
          <div className="column" style={{ gap: '12px' }}>
            <Button
              disabled={isRunning}
              style={{ width: '100%', padding: '13px' }}
              type="submit"
              variant="primary"
            >
              <Download size={15} />
              {isRunning ? 'Importing…' : 'Import my games'}
            </Button>
            {hint ? (
              <span className="form-error form-error--hint" role="alert">
                <AlertTriangle size={14} style={{ flex: 'none', marginTop: 1 }} />
                {hint}
              </span>
            ) : null}
            {error ? (
              <span className="form-error" role="alert">
                <AlertTriangle size={14} style={{ flex: 'none', marginTop: 1 }} />
                {error}
              </span>
            ) : null}
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
