import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

import { cn } from '@/lib/utils'

type ButtonProps = PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'primary' | 'ghost'
  }
>

export function Button({ children, className, variant = 'default', ...props }: ButtonProps) {
  return (
    <button
      className={cn('button', variant === 'primary' && 'button--primary', variant === 'ghost' && 'button--ghost', className)}
      {...props}
    >
      {children}
    </button>
  )
}
