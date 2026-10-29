import type { TFunction } from 'i18next'
import { formatRwf } from '@mmc/shared'
import {
  packSizeOf,
  piecePriceOf,
  saleModeOf,
  type Packaging,
  type SaleMode,
} from '@/lib/pack-pricing'
import { packCountText, packWord, pieceWord, saleModeText, tx } from './stock-util'

/**
 * The package of a medicine and how it is sold (0107), as a form fills it: pieces only or a pack
 * of N pieces (with the pack's and the piece's words), then by the piece, only by the whole pack,
 * or both, with the prices that apply. Add stock (each line) and Prices › Medicines use it.
 */
export interface PackDraft {
  kind: 'pieces' | 'pack'
  packSize: string
  packUnit: string
  unit: string
  saleMode: SaleMode
  piecePrice: string
  packPrice: string
}

export const emptyPack = (): PackDraft => ({
  kind: 'pieces',
  packSize: '',
  packUnit: '',
  unit: '',
  saleMode: 'piece',
  piecePrice: '',
  packPrice: '',
})

/** The form's fields from what the item says now. */
export function packDraftOf(i: Packaging | null | undefined): PackDraft {
  const size = packSizeOf(i)
  const mode = saleModeOf(i)
  const piece = mode === 'pack' ? null : (i?.sellingPrice ?? null)
  return {
    kind: size ? 'pack' : 'pieces',
    packSize: size ? String(size) : '',
    packUnit: size ? (i?.packUnit ?? '') : '',
    unit: i?.unit ?? '',
    saleMode: mode,
    piecePrice: piece != null ? String(piece) : '',
    packPrice: mode !== 'piece' && i?.packPrice != null ? String(i.packPrice) : '',
  }
}

export const n = (s: string): number | null => (s.trim() === '' ? null : Number(s))

/** What the form says, as the database takes it (pieces only: no pack, by the piece). */
export function packInput(d: PackDraft): {
  packSize: number | null
  saleMode: SaleMode
  piecePrice: number | null
  packPrice: number | null
  unit: string | null
  packUnit: string | null
} {
  const pack = d.kind === 'pack'
  const size = pack ? n(d.packSize) : null
  const mode: SaleMode = pack ? d.saleMode : 'piece'
  const packPrice = mode === 'piece' ? null : n(d.packPrice)
  const piecePrice =
    mode === 'pack'
      ? packPrice != null && size
        ? Math.round(packPrice / size)
        : null
      : n(d.piecePrice)
  return {
    packSize: size,
    saleMode: mode,
    piecePrice,
    packPrice,
    unit: d.unit.trim() || null,
    packUnit: pack ? d.packUnit.trim() || null : null,
  }
}

/** The packaging the form says, to price with (pack-pricing). */
export const packOfDraft = (d: PackDraft): Packaging => {
  const p = packInput(d)
  return {
    packSize: p.packSize,
    saleMode: p.saleMode,
    packPrice: p.packPrice,
    sellingPrice: p.piecePrice,
    unit: p.unit,
    packUnit: p.packUnit,
  }
}

/** The first thing missing or wrong, in plain words (null: complete). */
export function packProblem(t: TFunction, d: PackDraft): string | null {
  if (d.kind === 'pack') {
    const size = n(d.packSize)
    if (size == null || !Number.isInteger(size) || size < 2)
      return tx(t, 'packaging.errors.packSize', 'Say how many pieces are in one pack (2 or more).')
  }
  const mode = d.kind === 'pack' ? d.saleMode : 'piece'
  const bad = (s: string) => {
    const v = n(s)
    return v == null || !Number.isInteger(v) || v < 0
  }
  if (mode !== 'pack' && bad(d.piecePrice))
    return tx(
      t,
      'packaging.errors.piecePrice',
      'Say the price of one piece (a whole number, 0 or more).',
    )
  if (mode !== 'piece' && bad(d.packPrice))
    return tx(
      t,
      'packaging.errors.packPrice',
      'Say the price of one pack (a whole number, 0 or more).',
    )
  return null
}

/** The form differs from what the item says now. */
export function packChanged(d: PackDraft, i: Packaging | null | undefined): boolean {
  const a = packInput(d)
  const b = packInput(packDraftOf(i))
  return (
    a.packSize !== b.packSize ||
    a.saleMode !== b.saleMode ||
    a.packPrice !== b.packPrice ||
    (a.saleMode !== 'pack' && a.piecePrice !== b.piecePrice) ||
    (a.packUnit ?? '') !== (b.packUnit ?? '')
  )
}

/** "Pack of 8 · box · tablet · sold by the pack or by the piece · 1,500 a box · 200 a tablet". */
export function packSummary(t: TFunction, i: Packaging): string {
  const size = packSizeOf(i)
  const mode = saleModeOf(i)
  const piece = piecePriceOf(i)
  return [
    size ? packCountText(t, 1, size, i.packUnit) : null,
    saleModeText(t, i),
    mode !== 'piece' && size && i.packPrice != null
      ? tx(t, 'packaging.perPack', '{{price}} a {{pack}}', {
          price: formatRwf(i.packPrice),
          pack: packWord(t, i.packUnit),
        })
      : null,
    piece != null
      ? tx(t, 'packaging.perPiece', '{{price}} a {{unit}}', {
          price: formatRwf(piece),
          unit: pieceWord(t, i.unit),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
