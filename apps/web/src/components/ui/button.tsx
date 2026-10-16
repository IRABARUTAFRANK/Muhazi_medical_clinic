import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Buttons from the design system sheet: radius 8, ≥ 44 px by default,
 * no elevation. `buttonVariants` is exported so links can look like buttons.
 */
export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border font-semibold whitespace-nowrap transition-colors select-none focus-visible:ring-[3px] focus-visible:ring-primary-tint focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-ink hover:bg-hover',
        primary:
          'border-primary bg-primary text-on-primary hover:border-primary-hover hover:bg-primary-hover',
        ghost: 'border-transparent bg-transparent text-ink hover:bg-hover',
        danger: 'border-border bg-card text-red hover:bg-hover',
      },
      size: {
        xs: 'min-h-9 px-3 text-[13px]',
        sm: 'min-h-10 px-3 text-[13px]',
        md: 'min-h-11 px-4 text-sm',
        lg: 'min-h-12 px-5 text-[15px]',
        xl: 'min-h-[52px] px-6 text-[15px]',
        icon: 'size-11 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
