import { FormEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useImport } from '@/hooks/use-import'
import { useAppStore } from '@/store/app-store'

export function UsernameForm() {
  const username = useAppStore((state) => state.username ?? '')
  const setUsername = useAppStore((state) => state.setUsername)
  const [draft, setDraft] = useState(username)
  const { status, startImport, error } = useImport(draft)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setUsername(draft)
    void startImport()
  }

  return (
    <Card>
      <CardHeader>
        <h2>Import Games</h2>
      </CardHeader>
      <CardBody>
        <form className="column" style={{ gap: '20px' }} onSubmit={handleSubmit}>
          <label className="column" style={{ gap: '8px' }} htmlFor="username">
            <span className="muted" style={{ fontSize: '13px', fontWeight: 500 }}>Chess.com username</span>
            <Input id="username" onChange={(event) => setDraft(event.target.value)} placeholder="hikaru" value={draft} />
          </label>
          <div className="column" style={{ gap: '12px' }}>
            <Button type="submit" variant="primary" style={{ width: '100%', padding: '12px' }}>
              {status === 'running' ? 'Importing…' : 'Start Import'}
            </Button>
            {error && <span className="muted" style={{ color: 'var(--danger)', fontSize: '12px', textAlign: 'center' }}>{error}</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
