/*
 * "The file of that patient": the rows of one visit (the tests asked for one patient, their
 * results) are shown together as one block, wherever a list would repeat the patient on every row
 * (the laboratory worklist, the doctor's tests and results, the results on the doctor's home).
 */

/** The rows of one visit. */
export interface VisitBlock<T> {
  /** The visit. */
  key: string
  /** Every row of the visit, in the order of the list. */
  rows: T[]
  /** The rows the search and the filters ask for (all of them when nothing is filtered). */
  hits: T[]
}

/**
 * The rows put together by visit, in the order each visit first appears (so a list sorted before
 * keeps its order: the block stands where its first row stood). With `match`, a block is kept when
 * one of its rows matches, whole, and `hits` says which.
 */
export function visitBlocks<T extends { encounterId: string }>(
  rows: readonly T[],
  match: (row: T) => boolean = () => true,
): VisitBlock<T>[] {
  const byVisit = new Map<string, VisitBlock<T>>()
  for (const row of rows) {
    let block = byVisit.get(row.encounterId)
    if (!block) {
      block = { key: row.encounterId, rows: [], hits: [] }
      byVisit.set(row.encounterId, block)
    }
    block.rows.push(row)
    if (match(row)) block.hits.push(row)
  }
  return [...byVisit.values()].filter((b) => b.hits.length > 0)
}

/** The ids of the rows to point out: only when some rows of the block match and others do not. */
export function partialHits<T extends { id: string }>(block: VisitBlock<T>): Set<string> | null {
  return block.hits.length < block.rows.length ? new Set(block.hits.map((r) => r.id)) : null
}

/** How many rows of the blocks (the tests) and how many blocks (the patients' visits). */
export function blockTotals<T>(blocks: readonly VisitBlock<T>[]) {
  return { rows: blocks.reduce((n, b) => n + b.rows.length, 0), blocks: blocks.length }
}

/** The states of a block's rows with how many of each, in the order given. */
export function countByState<S extends string>(
  states: readonly S[],
  order: readonly S[],
): { state: S; count: number }[] {
  return order
    .map((state) => ({ state, count: states.filter((s) => s === state).length }))
    .filter((x) => x.count > 0)
}
