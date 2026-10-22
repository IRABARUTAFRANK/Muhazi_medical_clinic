import { demoNow } from '@mmc/shared'
import { isLive } from './supabase'

/** The real clock when connected to Supabase; the frozen demo clock on sample data. */
export const appNow = (): Date => (isLive ? new Date() : demoNow())

/**
 * A clinic time (Africa/Kigali, UTC+2 all year) whatever the visitor's own clock: a request for
 * "Monday 10:00" means 10:00 at the clinic, also from abroad. `month` counts from 0.
 */
export const kigaliTime = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(year, month, day, hour - 2, minute))

/** Today at the clinic, as yyyy-mm-dd. */
export const kigaliToday = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10)
