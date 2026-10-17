import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Buttons. Behaviour from the Figma "Buttons" spec: hover brightens 6 % and lifts 1 px with a
 * deeper shadow (150 ms), press scales to 0.98 (90 ms), keyboard focus shows a 3 px teal ring,
 * loading dims the label and swaps the icon for a spinner while the width stays put,
 * disabled is 50 % and inert. `buttonVariants` is exported so links can look like buttons.
 */
export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border font-semibold whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 ease-out hover:-translate-y-px hover:brightness-[1.06] active:translate-y-0 active:scale-[0.98] active:duration-[90ms] focus-visible:ring-[3px] focus-visible:ring-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none aria-busy:opacity-85 motion-reduce:transition-none motion-reduce:hover:transform-none motion-reduce:active:transform-none',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-ink hover:bg-hover hover:shadow-card',
        primary:
          'border-transparent bg-[linear-gradient(135deg,var(--mmc-primary),var(--mmc-primary-hover))] text-on-primary shadow-[0_8px_20px_rgba(31,111,139,0.3)] hover:shadow-[0_12px_24px_rgba(31,111,139,0.4)]',
        ghost: 'border-transparent bg-transparent text-ink shadow-none hover:bg-hover',
        danger: 'border-border bg-card text-red hover:bg-red-bg hover:shadow-card',
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
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'
