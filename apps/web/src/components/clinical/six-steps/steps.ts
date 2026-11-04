/** The six steps of a visit (0127), in order. */
export type StepKey = 'complaint' | 'exam' | 'differential' | 'tests' | 'definitive' | 'plan'
export const STEP_KEYS: readonly StepKey[] = [
  'complaint',
  'exam',
  'differential',
  'tests',
  'definitive',
  'plan',
]
/** The step number (1–6) a URL's `?step=` asks for; anything else is step 1. */
export const stepNumber = (v: unknown): number => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= STEP_KEYS.length ? n : 1
}
