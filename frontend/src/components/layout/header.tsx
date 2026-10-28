import { Check, LogOut, Monitor, MoonStar, Sun } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { ResyncButton } from '@/components/dashboard/resync-button'
import { TrainingChip } from '@/components/training/training-widgets'
import { useTheme } from '@/components/layout/theme-provider'
import { useImportSummary } from '@/hooks/use-import-summary'
import { useAppStore } from '@/store/app-store'

function ThemeSelector() {
  const { theme, setTheme } = useTheme()
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? MoonStar : Monitor

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  return (
    <div className="theme-selector" ref={menuRef}>
      <Button
        variant="ghost"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        title="Change theme"
        className="theme-selector__trigger"
      >
        <ThemeIcon size={16} />
      </Button>

      {isOpen && (
        <div className="theme-selector__dropdown panel">
          <button
            className={`theme-selector__option ${theme === 'light' ? 'theme-selector__option--active' : ''}`}
            onClick={() => {
              setTheme('light')
              setIsOpen(false)
            }}
          >
            <span className="theme-selector__option-left">
              <Sun size={14} /> Light
            </span>
            {theme === 'light' && <Check size={13} />}
          </button>
          <button
            className={`theme-selector__option ${theme === 'dark' ? 'theme-selector__option--active' : ''}`}
            onClick={() => {
              setTheme('dark')
              setIsOpen(false)
            }}
          >
            <span className="theme-selector__option-left">
              <MoonStar size={14} /> Dark
            </span>
            {theme === 'dark' && <Check size={13} />}
          </button>
          <button
            className={`theme-selector__option ${theme === 'system' ? 'theme-selector__option--active' : ''}`}
            onClick={() => {
              setTheme('system')
              setIsOpen(false)
            }}
          >
            <span className="theme-selector__option-left">
              <Monitor size={14} /> System
            </span>
            {theme === 'system' && <Check size={13} />}
          </button>
        </div>
      )}
    </div>
  )
}

export function Header() {
  const username = useAppStore((state) => state.username)
  const importStatus = useAppStore((state) => state.importStatus)
  const clearUsername = useAppStore((state) => state.clearUsername)
  // Shares a query key with the dashboard, so this costs no extra request.
  const { data: summary } = useImportSummary(username, importStatus)
  // A username is only "the active player" once it has games here. Typing a
  // name that turns out not to exist should not leave the header claiming to
  // be signed in as it.
  const hasLibrary = (summary?.total_games ?? 0) > 0

  return (
    <header className="header">
      <div className="header__brand">
        <img alt="ChessGod" className="header__logo" height={512} src="/logo.webp" width={512} />
      </div>

      <div className="header__actions">
        {username && hasLibrary && (
          <>
            <div className="header__user" title="Active player">
              <span className="header__user-dot" aria-hidden="true" />
              <span>{username}</span>
            </div>
            <TrainingChip username={username} />
            <ResyncButton username={username} />
            <Button
              variant="ghost"
              onClick={clearUsername}
              type="button"
              title="Switch to another Chess.com account"
              className="header__change-player"
            >
              <LogOut size={16} />
              <span className="header__action-label">Switch player</span>
            </Button>
          </>
        )}
        <ThemeSelector />
      </div>
    </header>
  )
}
