import type { HTMLAttributes, PropsWithChildren } from 'react'

import { cn } from '@/lib/utils'

export function Card({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={cn('panel', className)} {...props}>
      {children}
    </div>
  )
}

export function CardHeader({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={cn('panel__header', className)} {...props}>
      {children}
    </div>
  )
}

export function CardBody({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={cn('panel__body', className)} {...props}>
      {children}
    </div>
  )
}
