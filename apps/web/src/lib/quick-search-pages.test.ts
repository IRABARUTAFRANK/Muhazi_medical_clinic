import { describe, expect, it } from 'vitest'
import { fold, matchPages, type PageHit } from './quick-search-pages'

const page = (
  key: string,
  label: string,
  en: string,
  to = '/app/x',
): PageHit & { words: string } => ({
  key,
  navId: key,
  icon: 'box',
  label,
  where: '',
  to,
  words: fold(`${label} ${en} ${key}`),
})

describe('the search bar finds pages (0213)', () => {
  const pages = [
    page('stock', 'Ububiko', 'Stock', '/app/stock'),
    page('finance:salaries', 'Imishahara', 'Salaries', '/app/finance'),
    page('physio', 'Kinésithérapie', 'Physiotherapy'),
    page('reports', 'Raporo', 'Reports'),
  ]

  it('a word in English finds the page shown in another language', () => {
    expect(matchPages(pages, 'stock').map((p) => p.label)).toEqual(['Ububiko'])
    expect(matchPages(pages, 'salar').map((p) => p.key)).toEqual(['finance:salaries'])
  })

  it('accents and capitals do not matter', () => {
    expect(matchPages(pages, 'KINESI').map((p) => p.key)).toEqual(['physio'])
  })

  it('every word typed must be there; nothing typed finds nothing', () => {
    expect(matchPages(pages, 'raporo stock')).toEqual([])
    expect(matchPages(pages, '   ')).toEqual([])
  })

  it('a label that starts with the word comes first', () => {
    const two = [page('a', 'Old reports', 'Old reports'), page('b', 'Reports', 'Reports')]
    expect(matchPages(two, 'rep').map((p) => p.key)).toEqual(['b', 'a'])
  })
})
