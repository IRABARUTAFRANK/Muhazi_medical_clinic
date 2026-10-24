import { createContext, useContext, type ReactNode } from 'react'

/** What the "Are you sure?" box says before an action runs. */
export interface ConfirmOptions {
  /** The question, naming the action and who it concerns: "Send Mutabazi to the cashier?" */
  title: string
  /** What will happen, in a sentence or two (optional). */
  body?: ReactNode
  /** The yes button: names the action ("Yes, send"). Default: "Yes, continue". */
  confirmLabel?: string
  /** The way back. Default: "No, go back". */
  cancelLabel?: string
  /** danger: permanent or money actions (red button). */
  tone?: 'primary' | 'danger'
}

export type Confirm = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<Confirm | null>(null)

/**
 * Ask before an action that changes something: `if (!(await confirm({ title }))) return`.
 * Every button that triggers an operation in one click goes through it (Frank, 2026-10-24).
 * Outside the provider (tests) it answers yes.
 */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext) ?? (async () => true)
}
