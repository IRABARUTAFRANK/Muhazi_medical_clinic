import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { sampleInsurers } from './catalogue'
import { apiError, isMissingFunction } from './errors'

/**
 * What each insurer pays for one treatment or medicine and why (0139: `insurer_prices_for`): its
 * price and where it comes from (its own price, a list it follows, the official medicine list, the
 * clinic's price), its exception on it (not covered, with its approval), its coverage. For the
 * treatment's and the medicine's forms, where the clinic sets each insurer's exception.
 */
export type PriceSource = 'tariff' | 'reference' | 'cash' | 'none' | 'excluded' | 'preauth'

export interface InsurerPriceRow {
  payerId: string
  payer: string
  payerType: string
  active: boolean
  /** The key of an exception set on it (its code on the price lists). */
  code: string | null
  price: number | null
  source: PriceSource
  /** No price of the insurer's own or on its lists: the clinic's price, under its rule. */
  fallback: boolean
  cover: 'covered' | 'not_covered' | 'preauth' | null
  exceptionPrice: number | null
  note: string | null
  /** The exception's code: the treatment's own, or the list line it is linked to (exceptionOwn false). */
  exceptionCode: string | null
  exceptionOwn: boolean
  /** The insurer's own price for it (its price list), null: none. */
  ownPrice: number | null
  coveragePct: number | null
  rule: string
}

const num = (v: unknown) => (v == null ? null : Number(v))

export function useInsurerPricesFor(serviceId: string | null, itemId: string | null) {
  return useQuery({
    queryKey: ['catalogue', 'insurerPrices', serviceId, itemId],
    enabled: !!(serviceId || itemId),
    queryFn: async (): Promise<InsurerPriceRow[] | null> => {
      if (!supabase)
        return sampleInsurers.map((i) => ({
          payerId: i.id,
          payer: i.name,
          payerType: i.type,
          active: i.active,
          code: 'SAMPLE',
          price: null,
          source: 'cash',
          fallback: true,
          cover: null,
          exceptionPrice: null,
          note: null,
          exceptionCode: null,
          exceptionOwn: false,
          ownPrice: null,
          coveragePct: i.coveragePct,
          rule: i.notListedRule,
        }))
      const { data, error } = await supabase.rpc('insurer_prices_for', {
        p_service_id: serviceId,
        p_item_id: itemId,
      })
      // a database before 0139: nothing to show
      if (error && isMissingFunction(error)) return null
      if (error) throw apiError(error)
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        payerId: String(r.payerId),
        payer: String(r.payer ?? ''),
        payerType: String(r.payerType ?? ''),
        active: r.active !== false,
        code: (r.code as string | null) ?? null,
        price: num(r.price),
        source: (r.source as PriceSource) ?? 'none',
        fallback: r.fallback === true,
        cover: (r.cover as InsurerPriceRow['cover']) ?? null,
        exceptionPrice: num(r.exceptionPrice),
        note: (r.note as string | null) ?? null,
        exceptionCode: (r.exceptionCode as string | null) ?? null,
        exceptionOwn: r.exceptionOwn === true,
        ownPrice: num(r.ownPrice),
        coveragePct: num(r.coveragePct),
        rule: String(r.rule ?? 'cash_covered'),
      }))
    },
  })
}
