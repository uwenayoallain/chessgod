import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type PropsWithChildren, type ReactNode } from 'react'

const STORAGE_PREFIX = 'chessgod.study-room.section.'

export function readSectionOpen(id: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const stored = window.localStorage.getItem(STORAGE_PREFIX + id)
  return stored == null ? fallback : stored === 'true'
}

export function writeSectionOpen(id: string, open: boolean) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_PREFIX + id, String(open))
}

export const OPEN_SECTION_EVENT = 'chessgod:open-section'

/**
 * Open a section by id, wherever it is on the page, and scroll to it: how a
 * link elsewhere ("Go" on a quest) reaches a section the player collapsed.
 */
export function revealSection(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_SECTION_EVENT, { detail: id }))
  window.requestAnimationFrame(() => {
    const target =
      document.querySelector(`[data-section-id="${id}"]`) ?? document.getElementById(id)
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    target?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
    // Keyboard users land where they were sent, not back at the button they pressed.
    target?.querySelector<HTMLElement>('.section__toggle')?.focus({ preventScroll: true })
  })
}

/**
 * Accordion building block for the two workspace tabs. Closed sections unmount
 * their children after transition so any TanStack queries / polling inside them stop —
 * this preserves performance while providing silky smooth height animations.
 */
export function CollapsibleSection({
  id,
  title,
  description,
  meta,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  children,
}: PropsWithChildren<{
  id: string
  title: string
  /** One line saying what is inside, so a row of closed sections is readable. */
  description?: string
  meta?: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => readSectionOpen(id, defaultOpen))
  const open = controlledOpen ?? uncontrolledOpen
  const [renderChildren, setRenderChildren] = useState(open)

  useEffect(() => {
    if (open) {
      setRenderChildren(true)
    } else {
      const timer = setTimeout(() => setRenderChildren(false), 240)
      return () => clearTimeout(timer)
    }
  }, [open])

  useEffect(() => {
    function reveal(event: Event) {
      if ((event as CustomEvent<string>).detail !== id) return
      if (controlledOpen == null) setUncontrolledOpen(true)
      writeSectionOpen(id, true)
      onOpenChange?.(true)
    }
    window.addEventListener(OPEN_SECTION_EVENT, reveal)
    return () => window.removeEventListener(OPEN_SECTION_EVENT, reveal)
  }, [controlledOpen, id, onOpenChange])

  function toggle() {
    const next = !open
    if (controlledOpen == null) setUncontrolledOpen(next)
    writeSectionOpen(id, next)
    onOpenChange?.(next)
  }

  return (
    <section className={`section${open ? ' section--open' : ''}`} data-section-id={id}>
      <div className="section__header">
        <button aria-expanded={open} className="section__toggle" onClick={toggle} type="button">
          <ChevronRight className="section__chevron" size={14} />
          <span className="section__label">
            <span className="section__title">{title}</span>
            {description && !open ? (
              <span className="section__description">{description}</span>
            ) : null}
          </span>
        </button>
        {meta ? <span className="section__meta">{meta}</span> : null}
      </div>
      <div
        className={`section__content-wrapper ${open ? 'section__content-wrapper--open' : ''}`}
        aria-hidden={!open}
      >
        <div className="section__content-inner">
          {renderChildren ? <div className="theory-stack">{children}</div> : null}
        </div>
      </div>
    </section>
  )
}
