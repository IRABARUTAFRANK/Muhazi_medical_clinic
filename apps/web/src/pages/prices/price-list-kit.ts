import { formatDate, formatNumber, formatRwf } from '@mmc/shared'
import { payerBodyOf, type PayerType } from '@/lib/api/catalogue'
import { useTranslation } from 'react-i18next'
import {
  usePriceListActions,
  type BookRemoved,
  type Cover,
  type PriceListBook,
} from '@/lib/api/price-lists'
import { useConfirm } from '@/lib/confirm'
import type { PriceListColumn } from '@/lib/price-list-file'

/** The red box of a refusal or a file problem. */
export const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'

/** "2026-06-01" → 01/06/2026 (a calendar day, no time zone shift). */
export const day = (iso: string) =>
  iso ? formatDate(new Date(`${iso.slice(0, 10)}T00:00:00`)) : ''

/** A price, or a dash when there is none. */
export const price = (n: number | null | undefined) => (n == null ? '—' : formatRwf(n))

/** The badge colour of an insurer's cover of a line. */
export const coverTone = (c: Cover) =>
  c === 'not_covered' ? ('red' as const) : c === 'preauth' ? ('yellow' as const) : ('blue' as const)

/** The column a private patient pays: "Privates (Non insured)", "General Clinics", else the first. */
export function guessPrivateColumn(columns: PriceListColumn[]): string {
  const by = (re: RegExp) => columns.find((c) => re.test(c.label))?.key
  return (
    by(/non.?insur|uninsur|non.?assur/i) ??
    by(/general clinic|clinique g/i) ??
    by(/^privates?\b|private patient|cash|comptant/i) ??
    columns[0]?.key ??
    ''
  )
}

/**
 * The column an insurer pays on a list it follows, from the column names: RSSB / RAMA and MMI pay
 * "RAMA; MMI", a private insurer (or an employer) the column with its name, else "Private
 * Insurances"; CBHI a "CBHI" / "Mutuelle" column. '' when no column says (the manager chooses).
 */
export function guessFollowColumn(
  columns: PriceListColumn[],
  type: PayerType,
  name: string,
  /** The list is RSSB's (its title, file or publisher says so): RAMA and Mutuelle pay its price. */
  rssbList = false,
): string {
  const usable = columns.filter((c) => !/non.?insur|uninsur|non.?assur/i.test(c.label))
  const by = (re: RegExp) => usable.find((c) => re.test(c.label))?.key
  if (rssbList) {
    if (payerBodyOf(type) !== 'RSSB') return ''
    return (
      by(/\b(rama|rssb|cbhi|mutuel+e?s?)\b/i) ??
      (usable.length === 1 ? usable[0]!.key : undefined) ??
      by(/price|prix|tarif|tariff|amount|montant/i) ??
      ''
    )
  }
  if (type === 'rssb_rama') return by(/\b(rama|rssb)\b/i) ?? ''
  if (type === 'mmi') return by(/\b(mmi|military)\b/i) ?? ''
  if (type === 'cbhi') return by(/\b(cbhi|mutuel+e?s?)\b/i) ?? ''
  if (type === 'private' || type === 'employer') {
    const first = name.trim().split(/\s+/)[0] ?? ''
    const own =
      first.length >= 3
        ? usable.find((c) => c.label.toLowerCase().includes(first.toLowerCase()))?.key
        : undefined
    return own ?? by(/private insur|insurances?\b|assurances? priv/i) ?? ''
  }
  return ''
}

/** The file's title, name or publisher says the list is RSSB's ("… BY RSSB JUNE 2026"). */
export const looksRssb = (...texts: (string | null | undefined)[]) =>
  /\b(rssb|rwanda social security)\b/i.test(texts.filter(Boolean).join(' '))

/** A price as Excel shows it in the file: rounded to the franc. */
export const asInFile = (n: number) => formatNumber(Math.round(n))

/** The column an insurer pays on its own list: its name, a price column, else the first. */
export function guessPayerColumn(columns: PriceListColumn[], insurer: string | undefined): string {
  if (columns.length === 1) return columns[0]!.key
  const name = (insurer ?? '').toLowerCase().split(/\s+/)[0] ?? ''
  return (
    (name ? columns.find((c) => c.label.toLowerCase().includes(name))?.key : undefined) ??
    columns.find((c) => /tarif|tariff|price|prix|amount|montant/i.test(c.label))?.key ??
    columns[0]?.key ??
    ''
  )
}

/**
 * "Remove the list" (0136): asks first (what goes with it, the insurers that stop following it),
 * takes the list away with what it made, and says what was done. Answers false when not confirmed;
 * throws the database's refusal.
 */
export function useRemoveList(onNotice: (text: string) => void) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { removeBook } = usePriceListActions()
  const run = async (book: PriceListBook): Promise<boolean> => {
    const names = book.followers.map((f) => f.payer).join(', ')
    if (
      !(await confirm({
        title: t('prices.lists.drop.q', { name: book.name }),
        body: [
          t(`prices.lists.drop.body.${book.kind}`),
          names ? t('prices.lists.drop.followers', { names }) : '',
          t('prices.lists.drop.again'),
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('prices.lists.drop.yes'),
        tone: 'danger',
      }))
    )
      return false
    const r: BookRemoved = await removeBook.mutateAsync(book.id)
    onNotice(
      [
        t('prices.lists.drop.done', { name: r.name }),
        r.deleted > 0 ? t('prices.lists.drop.deleted', { count: r.deleted }) : '',
        r.hidden > 0 ? t('prices.lists.drop.hidden', { count: r.hidden }) : '',
        r.followers.length > 0
          ? t('prices.lists.drop.stopped', { names: r.followers.join(', ') })
          : '',
        r.kept > 0 ? t(`prices.lists.drop.kept.${book.kind}`, { count: r.kept }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    return true
  }
  return { run, busy: removeBook.isPending }
}
