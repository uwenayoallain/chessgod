import type { HTMLAttributes, PropsWithChildren } from 'react'

export function ScrollArea({ children, style, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div style={{ overflow: 'auto', ...style }} {...props}>
      {children}
    </div>
  )
}
