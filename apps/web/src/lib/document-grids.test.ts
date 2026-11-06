import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import {
  csvRows,
  docxGrids,
  DocumentError,
  formatOf,
  htmlGrids,
  loadDocument,
  odtGrids,
} from './document-grids'
import { priceOf, readPriceListFile } from './price-list-file'
import { readTariffFile } from './tariff-file'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const tc = (text: string, span = 1) =>
  `<w:tc>${span > 1 ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : ''}${p(text)}</w:tc>`
const tr = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`
const docXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`

/** A Word file: a title, the table on two pages (two tables, the column names repeated), a note. */
const tariffDocx = docXml(
  p('INSURER TARIFF FOR PRIVATE CLINICS JUNE 2026') +
    `<w:tbl>${tr(tc('Code'), tc('Service'), tc('Tarif'))}${tr(tc('C-001'), tc('Consultation'), tc('12.500'))}</w:tbl>` +
    `<w:tbl>${tr(tc('Code'), tc('Service'), tc('Tarif'))}${tr(tc('C-002'), tc('Suture'), tc('9 000'))}</w:tbl>` +
    p('NC: not covered'),
)

const file = (data: BlobPart, name: string, type = '') => new File([data], name, { type })

describe('every kind of price list file', () => {
  it('knows the kind of a file by its name or its type', () => {
    expect(formatOf({ name: 'list.XLS', type: '' })).toBe('xls')
    expect(formatOf({ name: 'list.ods', type: '' })).toBe('ods')
    expect(formatOf({ name: 'list.tsv', type: '' })).toBe('csv')
    expect(formatOf({ name: 'tarif.docx', type: '' })).toBe('docx')
    expect(formatOf({ name: 'tarif.doc', type: '' })).toBe('oldWord')
    expect(formatOf({ name: 'scan.jpg', type: 'image/jpeg' })).toBe('image')
    expect(formatOf({ name: 'list', type: 'application/pdf' })).toBe('pdf')
    expect(formatOf({ name: 'list.zip', type: 'application/zip' })).toBe('type')
  })

  it('reads a text table separated by tabs, and French thousands', () => {
    const rows = csvRows('﻿Code\tName\tPrice\nA-1\tAct one\t12.500\n')
    expect(rows).toEqual([
      { n: 1, cells: ['Code', 'Name', 'Price'] },
      { n: 2, cells: ['A-1', 'Act one', '12.500'] },
    ])
    expect(priceOf('12.500')).toBe(12500)
    expect(priceOf('1.200.000')).toBe(1200000)
    expect(priceOf('12.5')).toBe(12.5)
  })

  it('reads the tables of a Word document: one table over two pages, the title, a merged cell', () => {
    const grids = docxGrids(tariffDocx)
    expect(grids).toHaveLength(1)
    expect(grids[0]!.above).toEqual(['INSURER TARIFF FOR PRIVATE CLINICS JUNE 2026'])
    expect(grids[0]!.notes).toEqual(['NC: not covered'])
    expect(grids[0]!.rows.map((r) => r.cells)).toEqual([
      ['Code', 'Service', 'Tarif'],
      ['C-001', 'Consultation', '12.500'],
      ['Code', 'Service', 'Tarif'],
      ['C-002', 'Suture', '9 000'],
    ])
    const merged = docxGrids(
      docXml(`<w:tbl>${tr(tc('Dentistry', 2), tc('x'))}${tr(tc('a'), tc('b'), tc('c'))}</w:tbl>`),
    )
    expect(merged[0]!.rows[0]!.cells).toEqual(['Dentistry', '', 'x'])
  })

  it('reads an OpenDocument text and a web page', () => {
    const odt = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>RSSB LIST</text:p><table:table><table:table-row><table:table-cell><text:p>Code</text:p></table:table-cell><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Price</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>M-1</text:p></table:table-cell><table:table-cell><text:p>Amoxicillin</text:p></table:table-cell><table:table-cell><text:p>300</text:p></table:table-cell><table:table-cell table:number-columns-repeated="20"/></table:table-row></table:table></office:text></office:body></office:document-content>`
    const g = odtGrids(odt)
    expect(g[0]!.above).toEqual(['RSSB LIST'])
    expect(g[0]!.rows.map((r) => r.cells)).toEqual([
      ['Code', 'Name', 'Price'],
      ['M-1', 'Amoxicillin', '300'],
    ])
    const h = htmlGrids(
      '<h1>Tariff</h1><table><tr><th>Code</th><th colspan="2">Name</th><th>Price</th></tr><tr><td>A</td><td>Act</td><td>x</td><td>1,500</td></tr></table>',
    )
    expect(h[0]!.above).toEqual(['Tariff'])
    expect(h[0]!.rows[0]!.cells).toEqual(['Code', 'Name', '', 'Price'])
  })

  it('reads a Word file, an old Excel file and an OpenDocument sheet end to end', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', tariffDocx)
    const docx = await zip.generateAsync({ type: 'arraybuffer' })
    const parsed = await readPriceListFile(file(docx, 'Insurer tariff JUNE 2026.docx'))
    expect(parsed.format).toBe('docx')
    expect(parsed.lines.map((l) => [l.code, l.name, l.prices.tarif])).toEqual([
      ['C-001', 'Consultation', 12500],
      ['C-002', 'Suture', 9000],
    ])
    expect(parsed.title).toBe('INSURER TARIFF FOR PRIVATE CLINICS JUNE 2026')
    expect(parsed.from).toBe('2026-06-01')
    expect(parsed.notes).toContain('NC: not covered')

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Code', 'Service', 'Prix'],
        ['C-001', 'Consultation', 12500],
        ['C-002', 'Suture', 9000],
      ]),
      'Tarif',
    )
    for (const [bookType, name] of [
      ['xls', 'tarif.xls'],
      ['ods', 'tarif.ods'],
    ] as const) {
      const data = XLSX.write(wb, { bookType, type: 'array' }) as ArrayBuffer
      const t = await readTariffFile(file(data, name))
      expect(t.lines.map((l) => [l.code, l.name, l.price])).toEqual([
        ['C-001', 'Consultation', 12500],
        ['C-002', 'Suture', 9000],
      ])
    }
  })

  it('says what to do with an old Word file or a photo', async () => {
    const pdf = (g: unknown) => g as null
    await expect(loadDocument(file('x', 'tarif.doc'), pdf)).rejects.toMatchObject({
      problem: 'oldWord',
    })
    await expect(loadDocument(file('x', 'scan.png', 'image/png'), pdf)).rejects.toBeInstanceOf(
      DocumentError,
    )
    await expect(readPriceListFile(file('x', 'scan.png', 'image/png'))).rejects.toMatchObject({
      problem: 'image',
    })
  })
})
