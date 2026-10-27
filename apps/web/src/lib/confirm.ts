import { createContext, useContext, type ReactNode } from 'react'

/** A text box inside the "Are you sure?" dialog: the reason behind the action, typed there. */
export interface ConfirmInput {
  /** The label above the box: "Why is the task withdrawn?" */
  label: string
  placeholder?: string
  /** The yes button stays off while the box is empty. */
  required?: boolean
  /** A 3-line textarea instead of a single line. */
  multiline?: boolean
  maxLength?: number
  initial?: string
}

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
  /** A text box under the question (a reason); the answer then carries its value. */
  input?: ConfirmInput
}

/** The answer when the dialog had a text box: the trimmed text on yes. */
export type ConfirmInputResult = { ok: true; value: string } | { ok: false }

export interface Confirm {
  (options: ConfirmOptions & { input: ConfirmInput }): Promise<ConfirmInputResult>
  (options: ConfirmOptions & { input?: undefined }): Promise<boolean>
}

export const ConfirmContext = createContext<Confirm | null>(null)

const always = ((options: ConfirmOptions) =>
  Promise.resolve(
    options.input ? { ok: true, value: options.input.initial ?? '' } : true,
  )) as Confirm

/**
 * Ask before an action that changes something: `if (!(await confirm({ title }))) return`.
 * Every button that triggers an operation in one click goes through it (Frank, 2026-10-24).
 * With `input`, the answer is `{ ok, value }` and the reason is typed in the same box.
 * Outside the provider (tests) it answers yes.
 */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext) ?? always
}
