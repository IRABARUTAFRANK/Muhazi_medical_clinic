import type { ReactNode } from 'react'
import { Boxes, Lock, Tag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { PACK_WORDS, PIECE_WORDS, type Packaging, type SaleMode } from '@/lib/pack-pricing'
import { cn } from '@/lib/utils'
import { n, packOfDraft, packSummary, type PackDraft } from './pack-draft'
import { packWord, pieceWord, tx } from './stock-util'

/**
 * The package of a medicine and how it is sold (0107), as a form fills it: pieces only or a pack
 * of N pieces (with the pack's and the piece's words), then by the piece, only by the whole pack,
 * or both, with the prices that apply. Add stock (each line) and Prices › Medicines use it; the
 * helpers that read and check it are in pack-draft.ts.
 */
const digits = (s: string) => s.replace(/[^\d]/g, '')

export function PackagingFields({
  value,
  onChange,
  readOnly = false,
  readOnlyNote,
  current,
  idPrefix,
  hint,
  showUnit = true,
}: {
  value: PackDraft
  onChange: (d: PackDraft) => void
  /** The person may not change the package or the prices: shown, not edited. */
  readOnly?: boolean
  readOnlyNote?: string
  /** The item as it is now (read-only view). */
  current?: Packaging | null
  /** Unique for the datalists of this form. */
  idPrefix: string
  /** A note under the block ("from the official list: B/20"). */
  hint?: ReactNode
  /** The piece word field (a form that has its own unit field leaves it out). */
  showUnit?: boolean
}) {
  const { t } = useTranslation()
  const set = (patch: Partial<PackDraft>) => onChange({ ...value, ...patch })
  const pack = value.kind === 'pack'
  const mode = pack ? value.saleMode : 'piece'
  const size = n(value.packSize)
  const word = packWord(t, value.packUnit)
  const piece = pieceWord(t, value.unit)
  const derived =
    mode === 'pack' && size && size >= 2 && n(value.packPrice) != null
      ? Math.round(n(value.packPrice)! / size)
      : null
  const heading = (
    <span className="text-ink flex items-center gap-1.5 text-[13px] font-semibold">
      <Boxes size={15} aria-hidden="true" className="text-primary" />
      {tx(t, 'packaging.title', 'Package and how it is sold')}
    </span>
  )
  if (readOnly)
    return (
      <div className="border-border bg-surface flex flex-col gap-1 rounded-md border px-3 py-2">
        {heading}
        <span className="text-ink-2 text-[13px]">
          {current ? packSummary(t, current) : packSummary(t, packOfDraft(value))}
        </span>
        <span className="text-ink-3 flex items-start gap-1.5 text-[12px]">
          <Lock size={12} aria-hidden="true" className="mt-0.5 flex-none" />
          {readOnlyNote ??
            tx(
              t,
              'packaging.readOnly',
              'Only the manager or a person allowed to set prices changes the package and the prices.',
            )}
        </span>
      </div>
    )
  return (
    <div className="border-primary/25 bg-primary-tint/30 flex flex-col gap-2.5 rounded-md border px-3 py-2.5">
      {heading}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-2 text-[13px] font-medium">
          {tx(t, 'packaging.packageLabel', 'Package')}
        </span>
        <Seg<'pieces' | 'pack'>
          size="sm"
          label={tx(t, 'packaging.packageLabel', 'Package')}
          value={value.kind}
          onChange={(k) =>
            set(
              k === 'pieces'
                ? { kind: k, saleMode: 'piece' }
                : { kind: k, saleMode: value.saleMode, packUnit: value.packUnit || 'box' },
            )
          }
          options={[
            { value: 'pieces', label: tx(t, 'packaging.kind.pieces', 'Pieces only') },
            { value: 'pack', label: tx(t, 'packaging.kind.pack', 'A pack of pieces') },
          ]}
        />
      </div>
      <datalist id={`${idPrefix}-pack-words`}>
        {PACK_WORDS.map((w) => (
          <option key={w} value={w}>
            {t(`packaging.word.${w}`, { defaultValue: w })}
          </option>
        ))}
      </datalist>
      <datalist id={`${idPrefix}-piece-words`}>
        {PIECE_WORDS.map((w) => (
          <option key={w} value={w}>
            {t(`packaging.pieceWord.${w}`, { defaultValue: w })}
          </option>
        ))}
      </datalist>
      <div
        className={cn(
          'grid grid-cols-1 gap-2 sm:grid-cols-3',
          !pack && 'sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
        )}
      >
        {pack && (
          <Field
            label={tx(t, 'packaging.packSize', 'Pieces in one pack')}
            inputMode="numeric"
            value={value.packSize}
            placeholder="8"
            required
            onChange={(e) => set({ packSize: digits(e.target.value) })}
          />
        )}
        {pack && (
          <Field
            label={tx(t, 'packaging.packUnit', 'The pack is a')}
            value={value.packUnit}
            placeholder="box"
            list={`${idPrefix}-pack-words`}
            onChange={(e) => set({ packUnit: e.target.value })}
          />
        )}
        {showUnit && (
          <Field
            label={tx(t, 'packaging.unit', 'One piece is a')}
            value={value.unit}
            placeholder="tablet"
            list={`${idPrefix}-piece-words`}
            onChange={(e) => set({ unit: e.target.value })}
          />
        )}
        {!pack && (
          <p className="text-ink-3 m-0 self-end pb-2 text-[12.5px]">
            {tx(
              t,
              'packaging.piecesHint',
              'No pack: it is stocked, counted and sold by the {{piece}}.',
              { piece },
            )}
          </p>
        )}
      </div>
      {pack && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2 flex items-center gap-1 text-[13px] font-medium">
            <Tag size={13} aria-hidden="true" />
            {tx(t, 'packaging.howSold', 'How it is sold')}
          </span>
          <Seg<SaleMode>
            size="sm"
            label={tx(t, 'packaging.howSold', 'How it is sold')}
            value={value.saleMode}
            onChange={(m) => set({ saleMode: m })}
            options={[
              { value: 'piece', label: tx(t, 'packaging.mode.piece', 'By the piece') },
              { value: 'pack', label: tx(t, 'packaging.mode.pack', 'By the pack only') },
              { value: 'both', label: tx(t, 'packaging.mode.both', 'Both') },
            ]}
          />
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {mode !== 'pack' && (
          <Field
            label={tx(t, 'packaging.piecePrice', 'Price of one {{piece}} (RWF)', { piece })}
            inputMode="numeric"
            value={value.piecePrice}
            required
            onChange={(e) => set({ piecePrice: digits(e.target.value) })}
          />
        )}
        {mode !== 'piece' && (
          <Field
            label={tx(t, 'packaging.packPrice', 'Price of one {{pack}} (RWF)', { pack: word })}
            inputMode="numeric"
            value={value.packPrice}
            required
            placeholder={
              size && n(value.piecePrice) != null ? String(size * n(value.piecePrice)!) : undefined
            }
            onChange={(e) => set({ packPrice: digits(e.target.value) })}
          />
        )}
      </div>
      <p className="text-ink-2 m-0 text-[12.5px]">
        {mode === 'piece'
          ? pack
            ? tx(
                t,
                'packaging.explain.piece',
                'Sold by the {{piece}}: a {{pack}} typed counts as {{size}} pieces at the piece price.',
                { piece, pack: word, size: size ?? '…' },
              )
            : null
          : mode === 'pack'
            ? tx(
                t,
                'packaging.explain.pack',
                'Sold only by the whole {{pack}}: a quantity that is not whole packs is refused. One {{piece}} is worth {{derived}} (for insurers and the stock value).',
                { pack: word, piece, derived: derived != null ? formatRwf(derived) : '…' },
              )
            : tx(
                t,
                'packaging.explain.both',
                'Whole packs at the pack price, the pieces left at the piece price: 1 {{pack}} + 3 = pack price + 3 × piece price.',
                { pack: word },
              )}
      </p>
      {hint}
    </div>
  )
}
