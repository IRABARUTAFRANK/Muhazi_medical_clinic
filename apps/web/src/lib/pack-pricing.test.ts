import { describe, expect, it } from 'vitest'
import {
  isWholePacks,
  knownPackWord,
  packSizeOf,
  piecePriceOf,
  priceQuantity,
  saleModeOf,
  sellValueOf,
} from './pack-pricing'

const syrup = { packSize: null, saleMode: 'piece' as const, sellingPrice: 1500, unit: 'bottle' }
const boxOnly = { packSize: 8, saleMode: 'pack' as const, packPrice: 1200, sellingPrice: 150 }
const both = { packSize: 8, saleMode: 'both' as const, packPrice: 1500, sellingPrice: 200 }
const byPiece = { packSize: 20, saleMode: 'piece' as const, packPrice: null, sellingPrice: 50 }

describe('the package and how it is sold', () => {
  it('reads the pack size and the mode', () => {
    expect(packSizeOf(syrup)).toBeNull()
    expect(packSizeOf({ packSize: 1 })).toBeNull()
    expect(packSizeOf(boxOnly)).toBe(8)
    expect(saleModeOf(syrup)).toBe('piece')
    expect(saleModeOf(boxOnly)).toBe('pack')
    expect(saleModeOf(both)).toBe('both')
    // pieces only is always by the piece, whatever is stored
    expect(saleModeOf({ packSize: 1, saleMode: 'pack', packPrice: 100 })).toBe('piece')
    // an older database: a pack price means both (as 0103 charged it)
    expect(saleModeOf({ packSize: 20, packPrice: 900 })).toBe('both')
    expect(saleModeOf({ packSize: 20 })).toBe('piece')
    // by the pack without a pack price cannot be: by the piece
    expect(saleModeOf({ packSize: 20, saleMode: 'both', packPrice: null })).toBe('piece')
  })
  it('derives the piece price of a pack-only medicine', () => {
    expect(piecePriceOf(boxOnly)).toBe(150)
    expect(piecePriceOf({ ...boxOnly, packPrice: 1000, packSize: 24 })).toBe(42)
    expect(piecePriceOf(both)).toBe(200)
    expect(piecePriceOf(syrup)).toBe(1500)
  })
  it('knows whole packs', () => {
    expect(isWholePacks(16, 8)).toBe(true)
    expect(isWholePacks(3, 8)).toBe(false)
    expect(isWholePacks(0, 8)).toBe(false)
    expect(isWholePacks(8, null)).toBe(false)
  })
  it('knows the pack words it can say', () => {
    expect(knownPackWord(' Box ')).toBe('box')
    expect(knownPackWord('carton')).toBe('carton')
    expect(knownPackWord('bag')).toBeNull()
  })
})

describe('what a quantity costs', () => {
  it('pieces only: pieces × price', () => {
    expect(priceQuantity(syrup, 3)).toMatchObject({ packs: 0, pieces: 3, total: 4500, ok: true })
  })
  it('by the piece: packs typed are only pieces', () => {
    expect(priceQuantity(byPiece, 40)).toMatchObject({
      packs: 0,
      pieces: 40,
      total: 2000,
      ok: true,
    })
  })
  it('by the pack only: whole packs at the pack price; 3 pieces refused', () => {
    expect(priceQuantity(boxOnly, 16)).toMatchObject({
      packs: 2,
      pieces: 0,
      packPrice: 1200,
      total: 2400,
      ok: true,
    })
    const three = priceQuantity(boxOnly, 3)
    expect(three.ok).toBe(false)
    expect(three.packs).toBe(0)
  })
  it('both: 1 pack + 3 pieces = pack price + 3 × piece price', () => {
    expect(priceQuantity(both, 11)).toMatchObject({ packs: 1, pieces: 3, total: 2100, ok: true })
    expect(priceQuantity(both, 5)).toMatchObject({ packs: 0, pieces: 5, total: 1000 })
    expect(priceQuantity(both, 16)).toMatchObject({ packs: 2, pieces: 0, total: 3000 })
  })
  it('an insurer’s own price stays per piece', () => {
    expect(priceQuantity(both, 11, { cash: false, piecePrice: 180 })).toMatchObject({
      packs: 0,
      pieces: 11,
      total: 1980,
    })
    // pack only still needs whole packs, whoever pays
    expect(priceQuantity(boxOnly, 3, { cash: false, piecePrice: 140 }).ok).toBe(false)
  })
  it('nothing asked costs nothing', () => {
    expect(priceQuantity(both, 0)).toMatchObject({ packs: 0, pieces: 0, total: 0 })
    expect(priceQuantity(null, 4)).toMatchObject({ mode: 'piece', total: 0 })
  })
})

describe('the value at selling price', () => {
  it('whole packs at the pack price, the rest at the piece price', () => {
    expect(sellValueOf(both, 16)).toBe(3000)
    expect(sellValueOf(both, 11)).toBe(2100)
    expect(sellValueOf(boxOnly, 3)).toBe(450)
    expect(sellValueOf(syrup, 3)).toBe(4500)
    expect(sellValueOf(byPiece, 40)).toBe(2000)
  })
})
