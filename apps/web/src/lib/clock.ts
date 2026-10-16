import { demoNow } from '@mmc/shared'
import { isLive } from './supabase'

/** The real clock when connected to Supabase; the frozen demo clock on sample data. */
export const appNow = (): Date => (isLive ? new Date() : demoNow())
