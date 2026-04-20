import { Monitor, MoonStar, Sun } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { ResyncButton } from '@/components/dashboard/resync-button'
import { useTheme } from '@/components/layout/theme-provider'
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
            onClick={() => { setTheme('light'); setIsOpen(false) }}
          >
            <Sun size={14} /> Light
          </button>
          <button
            className={`theme-selector__option ${theme === 'dark' ? 'theme-selector__option--active' : ''}`}
            onClick={() => { setTheme('dark'); setIsOpen(false) }}
          >
            <MoonStar size={14} /> Dark
          </button>
          <button
            className={`theme-selector__option ${theme === 'system' ? 'theme-selector__option--active' : ''}`}
            onClick={() => { setTheme('system'); setIsOpen(false) }}
          >
            <Monitor size={14} /> System
          </button>
        </div>
      )}
    </div>
  )
}

export function Header() {
  const username = useAppStore((state) => state.username)

  return (
    <header className="header">
      <div className="header__brand">
        <div className="header__title">ChessGod</div>
      </div>

      <div className="header__actions">
        {username && (
          <>
            <div className="header__user">
              <span className="muted">Player:</span> {username}
            </div>
            <ResyncButton username={username} />
          </>
        )}
        <ThemeSelector />
      </div>
    </header>
  )
}
