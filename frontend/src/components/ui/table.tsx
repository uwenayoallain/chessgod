import type { PropsWithChildren, TableHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

export function Table({ children, className, ...props }: PropsWithChildren<TableHTMLAttributes<HTMLTableElement>>) {
  return (
    <table className={cn('table', className)} {...props}>
      {children}
    </table>
  )
}
