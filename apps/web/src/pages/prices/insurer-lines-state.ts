import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Insurer } from '@/lib/api/catalogue'
import { useInsurerPricesFor, type InsurerPriceRow } from '@/lib/api/insurer-prices'

/** How an insurer covers one treatment or medicine (an exception on it: tariff_exception). */
export type CoverChoice = 'covered' | 'not_covered' | 'preauth'

interface Edit {
  price?: string
  cover?: CoverChoice
  reason?: string
}

/** What to save for one insurer whose line was changed in the form. */
export interface InsurerChange {
  payerId: string
  /** Its own price changed: the new one (null: none, its list's price counts). */
  price?: number | null
  /** Its cover on this changed (save_tariff_exception). */
  cover?: { code: string; cover: CoverChoice; price: number | null; note: string | null }
}

/**
 * Each insurer on one treatment or medicine (0139), for its form: what it pays now and why, its own
 * price, and the clinic's exception on it (not covered: the patient pays it all; only with its
 * approval; or covered as usual). Saved by the form's Save, after the treatment or medicine.
 */
export function useInsurerLines(opts: {
  serviceId?: string | null
  itemId?: string | null
  insurers: Insurer[]
  /** The own prices the form starts from (a treatment's, also when copied); else read here. */
  startPrices?: Record<string, number | null | undefined>
}) {
  const { t } = useTranslation()
  const { data: rows } = useInsurerPricesFor(opts.serviceId ?? null, opts.itemId ?? null)
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const rowOf = (id: string): InsurerPriceRow | undefined => rows?.find((r) => r.payerId === id)
  const startPrice = (id: string) => {
    const v = opts.startPrices ? opts.startPrices[id] : rowOf(id)?.ownPrice
    return v == null ? '' : String(v)
  }
  const startCover = (id: string): CoverChoice => rowOf(id)?.cover ?? 'covered'
  const priceOf = (id: string) => edits[id]?.price ?? startPrice(id)
  const coverOf = (id: string) => edits[id]?.cover ?? startCover(id)
  const reasonOf = (id: string) => edits[id]?.reason ?? ''
  const set = (id: string, patch: Edit) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }))

  const changes = (): InsurerChange[] =>
    opts.insurers.flatMap((i) => {
      const c: InsurerChange = { payerId: i.id }
      const p = priceOf(i.id).trim()
      if (p !== startPrice(i.id).trim()) c.price = p === '' ? null : Number(p)
      const r = rowOf(i.id)
      const cover = coverOf(i.id)
      if (r?.code && cover !== startCover(i.id)) {
        const reason = reasonOf(i.id).trim()
        c.cover = {
          code: r.code,
          cover,
          // a price set on its exception (the price list's exceptions) stays
          price: r.exceptionOwn ? r.exceptionPrice : null,
          // covered here over an exception set on the list line it is linked to: kept with a note
          note:
            reason ||
            (cover === 'covered' && r.cover && !r.exceptionOwn
              ? t('prices.insurerLines.overrideNote')
              : null),
        }
      }
      return c.price !== undefined || c.cover ? [c] : []
    })

  return {
    rows,
    /** The exceptions can be set once it is saved (its code is their key). */
    canCover: !!rows?.length,
    rowOf,
    startCover,
    priceOf,
    coverOf,
    reasonOf,
    set,
    changes,
  }
}

export type InsurerLines = ReturnType<typeof useInsurerLines>
