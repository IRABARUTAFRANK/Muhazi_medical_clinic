import { describe, expect, it } from 'vitest'
import { blockTotals, countByState, partialHits, visitBlocks } from './visit-blocks'

const row = (id: string, encounterId: string, status = 'ordered') => ({ id, encounterId, status })

describe('visitBlocks', () => {
  const rows = [
    row('a', 'v1'),
    row('b', 'v2', 'resulted'),
    row('c', 'v1', 'collected'),
    row('d', 'v3'),
    row('e', 'v1', 'resulted'),
  ]

  it('puts the tests of one visit together, where the first one stood', () => {
    const blocks = visitBlocks(rows)
    expect(blocks.map((b) => b.key)).toEqual(['v1', 'v2', 'v3'])
    expect(blocks[0]!.rows.map((r) => r.id)).toEqual(['a', 'c', 'e'])
    expect(blocks[0]!.hits).toHaveLength(3)
    expect(partialHits(blocks[0]!)).toBeNull()
  })

  it('keeps a whole block when one of its tests matches, and says which', () => {
    const blocks = visitBlocks(rows, (r) => r.status === 'resulted')
    expect(blocks.map((b) => b.key)).toEqual(['v1', 'v2'])
    expect(blocks[0]!.rows).toHaveLength(3)
    expect([...partialHits(blocks[0]!)!]).toEqual(['e'])
    // the only test of the visit matches: nothing to point out
    expect(partialHits(blocks[1]!)).toBeNull()
  })

  it('drops a block none of whose tests matches', () => {
    expect(visitBlocks(rows, (r) => r.status === 'verified')).toEqual([])
  })

  it('counts the tests and the patients', () => {
    expect(blockTotals(visitBlocks(rows))).toEqual({ rows: 5, blocks: 3 })
    expect(blockTotals(visitBlocks(rows, (r) => r.id === 'd'))).toEqual({ rows: 1, blocks: 1 })
  })
})

describe('countByState', () => {
  it('counts each state in the order asked, leaving out the absent ones', () => {
    expect(
      countByState(['resulted', 'ordered', 'ordered'], [
        'ordered',
        'collected',
        'resulted',
      ] as const),
    ).toEqual([
      { state: 'ordered', count: 2 },
      { state: 'resulted', count: 1 },
    ])
  })
})
