import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Buttons of the console: 36 px high (sm 32, lg 40), 6 px corners, a 1 px border, 14 px medium
 * text. Primary is solid teal; default is white with a grey border; ghost has no border; danger
 * is white with red text that gets its red border on hover. Hover is a background tint only
 * (120 ms) and a press scales the button to 0.98 (not under reduced motion); keyboard focus
 * shows a teal border and a 2 px teal/20 ring. Loading dims the label
 * and swaps the icon for a spinner while the width stays put, disabled is 50 % and inert.
 * `buttonVariants` is exported so links can look like buttons.
 */
export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,transform] duration-120 ease-out active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none aria-busy:opacity-85',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-ink hover:bg-hover',
        primary:
          'border-primary bg-primary text-on-primary hover:border-primary-hover hover:bg-primary-hover',
        ghost: 'border-transparent bg-transparent text-ink hover:bg-hover',
        danger: 'border-border bg-card text-red hover:border-red/50 hover:bg-red-bg',
      },
      size: {
        xs: 'h-7 px-2.5 text-[12px]',
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9 px-3.5 text-[14px]',
        lg: 'h-10 px-4 text-[14px]',
        xl: 'h-11 px-5 text-[15px]',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner in place of the first icon and makes the button inert; width is kept. */
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', loading = false, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'
