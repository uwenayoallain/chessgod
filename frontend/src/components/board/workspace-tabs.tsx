import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

type Tab = {
  id: string
  label: string
  icon?: ReactNode
  content: ReactNode
}

export function WorkspaceTabs({
  tabs,
  activeTab,
  onChange,
  collapsed = false,
  onToggleCollapse,
}: {
  tabs: Tab[]
  activeTab: string
  onChange: (tabId: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}) {
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]

  return (
    <div className={`workspace-sidebar${collapsed ? ' workspace-sidebar--collapsed' : ''}`}>
      <div className="workspace-sidebar__tabs">
        {onToggleCollapse ? (
          <Button
            className="workspace-sidebar__collapse-btn"
            onClick={onToggleCollapse}
            type="button"
            variant="ghost"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
          </Button>
        ) : null}
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            onClick={() => {
              onChange(tab.id)
              if (collapsed && onToggleCollapse) onToggleCollapse()
            }}
            type="button"
            variant={tab.id === selected.id ? 'primary' : 'ghost'}
          >
            {tab.icon}
            {tab.label}
          </Button>
        ))}
      </div>
      {!collapsed ? <div className="workspace-sidebar__body">{selected?.content}</div> : null}
    </div>
  )
}
