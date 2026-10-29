import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Buttons of the console: 36 px high (sm 32, lg 40), 6 px corners, a 1 px border, 14 px medium
 * text. The owner asked that everything that acts stands out from the white, so controls (and
 * only controls) carry colour:
 * - the solid variants are a subtle vertical gradient in their hue with a 1 px darker border:
 *   `primary` teal (create, register, save), `success` mint (pay, confirm, done, hand over),
 *   `danger-solid` coral (delete, void), `warning` amber with dark text (hold, return),
 *   `info` clinical blue (details, information); hover is 4 % lighter, press scales to 0.98;
 * - the tinted variants are the secondary buttons: a light tint of the hue, coloured text and a
 *   1 px border in the hue. `default` is the teal tint; `tint-mint` (hand over), `tint-coral`
 *   (decline, cancel — `danger` is its old name), `tint-amber` (warn), `tint-grey` (print,
 *   export, open), `tint-blue` (information), `tint-violet` (laboratory), `tint-rose`;
 * - `ghost` has no border and only a hover tint.
 * Keyboard focus shows a teal border and a 2 px teal/20 ring. Loading dims the label and swaps
 * the icon for a spinner while the width stays put; disabled turns grey (the grey tint with
 * grey text, 4:1, so its label stays readable) and inert. On a phone a long
 * label wraps inside the button (it grows taller, never wider than its box) and on a touch
 * screen it is at least 44 px high (--tap, globals.css).
 * `buttonVariants` is exported so links can look like buttons; `actionLink` and `tableLink` are
 * the classes of a link that acts (open, view, edit) in text and inside a table row.
 */
export const buttonVariants = cva(
  'inline-flex max-w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none max-sm:h-auto max-sm:min-h-[max(var(--btn-h),var(--tap,0px))] max-sm:py-1.5 max-sm:text-center max-sm:whitespace-normal transition-[color,background-color,border-color,box-shadow,transform,filter] duration-120 ease-out active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none disabled:pointer-events-none disabled:border-border disabled:bg-hover disabled:bg-none disabled:text-ink-3 disabled:shadow-none aria-busy:pointer-events-none aria-busy:opacity-85',
  {
    variants: {
      variant: {
        // tinted secondaries: light tint, coloured text, 1 px border in the hue
        default: 'border-primary/30 bg-primary-tint text-primary hover:brightness-[0.96]',
        'tint-teal': 'border-primary/30 bg-primary-tint text-primary hover:brightness-[0.96]',
        'tint-mint': 'border-green/30 bg-green-bg text-green hover:brightness-[0.96]',
        'tint-coral': 'border-red/30 bg-red-bg text-red hover:brightness-[0.96]',
        'tint-amber': 'border-amber/30 bg-amber-bg text-amber hover:brightness-[0.96]',
        'tint-grey': 'border-border bg-hover text-ink-2 hover:brightness-[0.96]',
        'tint-blue': 'border-navy/30 bg-blue-bg text-navy-ink hover:brightness-[0.96]',
        'tint-violet': 'border-violet/30 bg-violet-bg text-violet hover:brightness-[0.96]',
        'tint-rose': 'border-rose/30 bg-rose-bg text-rose hover:brightness-[0.96]',
        danger: 'border-red/30 bg-red-bg text-red hover:brightness-[0.96]',
        // solid gradients: white (or dark, on amber) text, darker border, 4 % lighter on hover
        primary:
          'border-[#185b72] bg-[linear-gradient(180deg,#2a7f9c_0%,#1f6f8b_100%)] text-white hover:brightness-[1.04]',
        // a deeper mint than the dot: white reads at 3.9–5.5:1 (it was 2.5:1 on #10b981)
        success:
          'border-[#065f46] bg-[linear-gradient(180deg,#0d9466_0%,#047857_100%)] text-white hover:brightness-[1.04]',
        'danger-solid':
          'border-[#dc2626] bg-[linear-gradient(180deg,#f05252_0%,#ef4444_100%)] text-white hover:brightness-[1.04]',
        warning:
          'border-[#d97706] bg-[linear-gradient(180deg,#fbbf24_0%,#f59e0b_100%)] text-[#452c00] hover:brightness-[1.04]',
        info: 'border-[#1d4ed8] bg-[linear-gradient(180deg,#3b82f6_0%,#2563eb_100%)] text-white hover:brightness-[1.04]',
        ghost: 'border-transparent bg-transparent text-ink hover:bg-hover',
      },
      size: {
        xs: 'h-7 px-2.5 text-[12px] [--btn-h:1.75rem]',
        sm: 'h-8 px-3 text-[13px] [--btn-h:2rem]',
        md: 'h-9 px-3.5 text-[14px] [--btn-h:2.25rem]',
        lg: 'h-10 px-4 text-[14px] [--btn-h:2.5rem]',
        xl: 'h-11 px-5 text-[15px] [--btn-h:2.75rem]',
        icon: 'size-9 p-0 [--btn-h:2.25rem]',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>

/** The action hues of the app, as a tinted (secondary) and a solid (primary) button variant.
 *  create/save = teal, pay/confirm/hand over = mint, cancel/delete/refuse = coral, warn/hold =
 *  amber, print/export/open = grey (tint only), information/details = clinical blue. */
export const tintVariantOf = {
  teal: 'tint-teal',
  mint: 'tint-mint',
  coral: 'tint-coral',
  amber: 'tint-amber',
  grey: 'tint-grey',
  blue: 'tint-blue',
  violet: 'tint-violet',
  rose: 'tint-rose',
} as const satisfies Record<string, ButtonVariant>
export const solidVariantOf = {
  teal: 'primary',
  mint: 'success',
  coral: 'danger-solid',
  amber: 'warning',
  blue: 'info',
} as const satisfies Record<string, ButtonVariant>

/** A link that acts (open, view, details, edit) in running text or a card: teal, medium, with
 *  its icon, underlined on hover. */
export const actionLink =
  'text-primary inline-flex items-center gap-1 font-medium no-underline hover:underline focus-visible:ring-primary/20 rounded outline-none focus-visible:ring-2'
/** The same link inside a table or list row: a 28 px pill that takes the teal tint on hover. */
export const tableLink =
  'text-primary inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium whitespace-nowrap no-underline transition-colors duration-120 hover:bg-primary-tint focus-visible:ring-primary/20 outline-none focus-visible:ring-2'

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
