/**
 * Frozen demo clock so that every sample screen tells the same story:
 * Thursday 15/10/2026 at 12:45. Swap `demoNow` for `new Date()` once real data flows.
 */
export const DEMO_NOW = new Date(2026, 9, 15, 12, 45)
export const demoNow = (): Date => new Date(DEMO_NOW)

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
export const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()
