import i18next from 'i18next'
import { resources } from '@mmc/shared/i18n'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { documentHtml, makeDocLabels, type DocLabels } from './doc-style'
import {
  choiceText,
  customError,
  DOC_KINDS,
  forgetPrintChoice,
  groupsFor,
  MARGINS,
  PAPERS,
  paperCfg,
  paperLayout,
  papersFor,
  printKey,
  readPrintChoice,
  scaleOf,
  writePrintChoice,
  type PageKind,
  type PaperLayout,
} from './paper'
import { printRuntime } from './print-runtime'

let dl: DocLabels
beforeAll(async () => {
  const i = i18next.createInstance()
  await i.init({ lng: 'en', resources, interpolation: { escapeValue: false } })
  dl = makeDocLabels((key, vars) => i.t(key, vars ?? {}) as string)
})

const ok = (l: PaperLayout) => {
  if (!l.ok) throw new Error(`not ok: ${l.error}`)
  return l
}
const lay = (kind: Parameters<typeof paperCfg>[0], paper: string, more: object = {}) =>
  ok(
    paperLayout(paperCfg(kind, 'a4', 'FOOT(__FS_SMALL__)', 'NARROW(__FS_SMALL__)'), {
      paper,
      ...more,
    }),
  )

describe('the paper catalogue (0207)', () => {
  // the sizes of the five pages before 0207, as they were written in doc-style.ts (SCALES)
  const BEFORE: Record<PageKind, ReturnType<typeof scaleOf>> = {
    a4: {
      title: 16,
      clinic: 15,
      h: 11,
      sub: 10,
      body: 10,
      table: 9,
      small: 8,
      logo: '20mm',
      idLabel: '28mm',
      stampW: '40mm',
      stampH: '28mm',
      sheetW: '210mm',
      pad: '15mm 18mm 20mm',
      page: 'size: A4 portrait; margin: 15mm 18mm 20mm;',
    },
    'a4-landscape': {
      title: 16,
      clinic: 15,
      h: 11,
      sub: 10,
      body: 10,
      table: 9,
      small: 8,
      logo: '14mm',
      idLabel: '28mm',
      stampW: '40mm',
      stampH: '28mm',
      sheetW: '297mm',
      pad: '15mm 18mm 20mm',
      page: 'size: A4 landscape; margin: 15mm 18mm 20mm;',
    },
    a5: {
      title: 14,
      clinic: 13,
      h: 10,
      sub: 9.5,
      body: 9.5,
      table: 9,
      small: 7.5,
      logo: '16mm',
      idLabel: '24mm',
      stampW: '35mm',
      stampH: '25mm',
      sheetW: '148mm',
      pad: '12mm 12mm 16mm',
      page: 'size: A5 portrait; margin: 12mm 12mm 16mm;',
    },
    receipt: {
      title: 11,
      clinic: 11,
      h: 9,
      sub: 9,
      body: 9,
      table: 9,
      small: 8,
      logo: '14mm',
      idLabel: '22mm',
      stampW: '0',
      stampH: '0',
      sheetW: '80mm',
      pad: '3mm 4mm',
      page: 'size: 80mm 200mm; margin: 3mm 4mm;',
    },
    label: {
      title: 10,
      clinic: 7.5,
      h: 10,
      sub: 9.5,
      body: 7.5,
      table: 7.5,
      small: 7.5,
      logo: '0',
      idLabel: '0',
      stampW: '0',
      stampH: '0',
      sheetW: '70mm',
      pad: '0',
      page: 'size: 70mm 40mm; margin: 0;',
    },
  }
  it("keeps today's five pages exactly as they were", () => {
    for (const page of Object.keys(BEFORE) as PageKind[])
      expect(scaleOf(page)).toEqual(BEFORE[page])
  })

  it('gives each paper its size and @page rule', () => {
    expect(lay('report', 'a3').scale.page).toBe('size: A3 portrait; margin: 15mm 18mm 20mm;')
    const a3l = lay('report', 'a3', { orientation: 'landscape' })
    expect([a3l.w, a3l.h, a3l.scale.sheetW]).toEqual([420, 297, '420mm'])
    expect(a3l.scale.page).toBe('size: A3 landscape; margin: 15mm 18mm 20mm;')
    expect(lay('report', 'a6').scale.page).toBe('size: 105mm 148mm; margin: 8mm 8mm 12mm;')
    expect(lay('report', 'a6', { orientation: 'landscape' }).scale.page).toBe(
      'size: 148mm 105mm; margin: 8mm 8mm 12mm;',
    )
    expect(lay('report', 'b5').scale.page).toBe('size: B5 portrait; margin: 15mm 18mm 20mm;')
    expect(lay('report', 'letter').scale.page).toContain('size: letter portrait;')
    expect(lay('report', 'legal', { orientation: 'landscape' }).scale.page).toContain(
      'size: legal landscape;',
    )
    // a roll: as long as the content (measured in the window), black only, no page footer
    const r58 = lay('receipt', 'roll-58')
    expect(r58.scale.page).toBe('size: 58mm 200mm; margin: 3mm 5mm;')
    expect([r58.h, r58.printable]).toEqual([null, 48])
    expect(r58.cls).toEqual(['paper-roll', 'paper-portrait', 'pw-xs', 'thermal'])
    expect(r58.css).not.toContain('FOOT(')
    expect(lay('receipt', 'roll-112').cls).toContain('pw-m')
    // labels: their own size, no margin, landscape never
    const l40 = lay('label', 'label-40x30', { orientation: 'landscape' })
    expect(l40.scale.page).toBe('size: 40mm 30mm; margin: 0;')
    expect(l40.orientation).toBe('portrait')
    expect(l40.css).toContain('--label-w: 40mm; --label-h: 30mm;')
    // every paper of the catalogue lays out, with its @page
    for (const p of PAPERS)
      for (const m of MARGINS) {
        const l = lay('label', p.id, { margins: m })
        expect(l.css).toContain(`@page { size: `)
        expect(l.group).toBe(p.group)
      }
  })

  it('sizes the type by the printable width', () => {
    const body = (kind: Parameters<typeof paperCfg>[0], id: string) => lay(kind, id).scale.body
    expect(body('receipt', 'roll-58')).toBeLessThan(body('receipt', 'roll-80'))
    expect(body('receipt', 'roll-80')).toBeLessThan(body('receipt', 'roll-112'))
    expect(body('report', 'a6')).toBeLessThan(body('report', 'a5'))
    expect(body('report', 'a5')).toBeLessThan(body('report', 'a4'))
    expect(body('report', 'a3')).toBe(body('report', 'a4'))
    expect(body('label', 'label-40x30')).toBeLessThan(body('label', 'label-70x40'))
    expect(body('label', 'label-100x50')).toBeGreaterThan(body('label', 'label-70x40'))
  })

  it('puts the footer on sheets with margins only, a shorter one on A6', () => {
    expect(lay('report', 'a4').css).toContain('FOOT(8)')
    expect(lay('report', 'a5').css).toContain('FOOT(7.5)')
    expect(lay('report', 'a6').css).toContain('NARROW(7)')
    const narrow = lay('report', 'a4', { margins: 'narrow' })
    expect(narrow.scale.page).toBe('size: A4 portrait; margin: 8mm 10mm 14mm;')
    const none = lay('report', 'a4', { margins: 'none' })
    expect(none.scale.page).toBe('size: A4 portrait; margin: 0;')
    expect(none.css).not.toContain('FOOT(')
    expect(none.cls).toContain('paper-nofoot')
    // a wide table's landscape page follows the paper
    expect(lay('report', 'a5').css).toContain(
      '@page wide { size: A5 landscape; margin: 12mm 12mm 16mm; }',
    )
  })

  it('offers each document only the papers it can print on', () => {
    const groups = (k: Parameters<typeof papersFor>[0]) => [
      ...new Set(papersFor(k).map((p) => p.group)),
    ]
    expect(groups('report')).toEqual(['sheet'])
    expect(groups('medicalReport')).toEqual(['sheet'])
    expect(groups('history')).toEqual(['sheet'])
    expect(groups('transferNote')).toEqual(['sheet'])
    expect(groups('receipt')).toEqual(['sheet', 'roll'])
    expect(groups('prescription')).toEqual(['sheet', 'roll'])
    expect(groups('resultReport')).toEqual(['sheet', 'roll'])
    expect(groups('label')).toEqual(['sheet', 'roll', 'label'])
    expect(groupsFor('report')).toEqual(['sheet'])
    expect(DOC_KINDS).toHaveLength(8)
    // a paper the document cannot use falls back to its own
    expect(
      ok(paperLayout(paperCfg('report', 'a4-landscape'), { paper: 'roll-80' })).scale.page,
    ).toBe('size: A4 landscape; margin: 15mm 18mm 20mm;')
  })

  it('checks a custom size', () => {
    expect(customError('receipt', 57, null)).toBeNull()
    expect(customError('report', 57, null)).toBe('height')
    expect(customError('report', 120, 180)).toBeNull()
    expect(customError('report', 10, 180)).toBe('width')
    expect(customError('report', 600, 180)).toBe('width')
    expect(customError('report', Number.NaN, 180)).toBe('width')
    expect(customError('report', null, 180)).toBe('width')
    expect(customError('report', 120, 5)).toBe('height')
    expect(customError('report', 120, Number.NaN)).toBe('height')
    // a custom roll: as long as the content, the type of the closest roll
    const roll = lay('receipt', 'custom', { w: 57, h: null })
    expect([roll.group, roll.scale.page, roll.scale.body]).toEqual([
      'roll',
      'size: 57mm 200mm; margin: 3mm 5mm;',
      8,
    ])
    // a custom sheet: its size in mm, the type of the closest sheet
    const sheet = lay('report', 'custom', { w: 200, h: 300 })
    expect([sheet.group, sheet.scale.page, sheet.scale.body]).toEqual([
      'sheet',
      'size: 200mm 300mm; margin: 15mm 18mm 20mm;',
      10,
    ])
    // on the labels, a custom size with a height is label stock
    expect(lay('label', 'custom', { w: 45, h: 35 }).group).toBe('label')
  })

  it('keeps a choice on this computer and says it in words', () => {
    forgetPrintChoice('receipt')
    expect(readPrintChoice('receipt')).toBeNull()
    writePrintChoice('receipt', { paper: 'roll-58', margins: 'narrow', straight: true })
    expect(localStorage.getItem(printKey('receipt'))).toContain('"roll-58"')
    expect(readPrintChoice('receipt')).toMatchObject({ paper: 'roll-58', straight: true })
    expect(choiceText('receipt', readPrintChoice('receipt')!, dl.paper)).toBe(
      'Receipt roll 58 mm · Margins: Narrow',
    )
    expect(choiceText('report', { paper: 'a3', orientation: 'landscape' }, dl.paper)).toBe(
      'A3 (297 × 420 mm) · Landscape (wide) · Margins: Normal',
    )
    expect(choiceText('label', { paper: 'label-50x30' }, dl.paper)).toBe('Label 50 × 30 mm')
    localStorage.setItem(printKey('label'), 'not json')
    expect(readPrintChoice('label')).toBeNull()
    forgetPrintChoice('receipt')
    forgetPrintChoice('label')
  })

  it('carries a self-contained copy of the layout into the print window', () => {
    // the window runs String(paperLayout): the same result for every paper and choice
    const copy = new Function(`return ${String(paperLayout)}`)() as typeof paperLayout
    for (const kind of DOC_KINDS)
      for (const p of [...papersFor(kind), { id: 'custom' }])
        for (const orientation of ['portrait', 'landscape', null] as const)
          for (const margins of MARGINS) {
            const cfg = paperCfg(kind, 'a4', 'F(__FS_SMALL__)', 'N(__FS_SMALL__)')
            const c = {
              paper: p.id,
              orientation,
              margins,
              w: 99,
              h: p.id === 'custom' ? 140 : null,
            }
            expect(copy(cfg, c)).toEqual(paperLayout(cfg, c))
          }
    expect(() => new Function(`return ${String(printRuntime)}`)()).not.toThrow()
  })
})

describe('the print window (0207)', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    document.documentElement.className = ''
  })
  const receipt = (autoPrint: boolean) =>
    documentHtml({
      base: { page: 'receipt', title: 'Receipt', clinicName: 'C', labels: dl },
      body: '<p>x</p>',
      autoPrint,
      kind: 'receipt',
    })
  /** Loads the window's markup into the test document and runs its script. */
  const open = (html: string, auto: boolean) => {
    const cls = /<html[^>]* class="([^"]*)"/.exec(html)![1]!
    document.documentElement.className = cls
    document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(html)![1]!
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<script>/.exec(html)![1]!
    const errors = { width: dl.paper.errWidth, height: dl.paper.errHeightRoll }
    printRuntime(paperCfg('receipt', 'receipt'), paperLayout, auto, errors)
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('marks the document and lays out the print options', () => {
    const html = receipt(true)
    expect(html).toMatch(
      /<html lang="en" class="paper-roll paper-portrait pw-s thermal" data-print-kind="receipt" data-auto-print="1">/,
    )
    expect(receipt(false)).not.toContain('data-auto-print')
    expect(html).toContain('<select id="pt-paper"><optgroup label="Sheets">')
    expect(html).toContain('<option value="roll-58">Receipt roll 58 mm</option>')
    expect(html).toContain('<option value="roll-80" selected>Receipt roll 80 mm</option>')
    expect(html).not.toContain('value="label-')
    expect(html).toContain('Print straight away next time on this computer')
    expect(html).toContain("untick 'Headers and footers'")
    expect(html).toContain('@media print {\n  .screen-hint, .pt { display: none !important; }')
  })

  it('first print: shows the options and prints only on Print, then keeps the choice', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    open(receipt(true), true)
    await settle()
    expect(print).not.toHaveBeenCalled()
    const sel = document.getElementById('pt-paper') as HTMLSelectElement
    sel.value = 'roll-58'
    sel.dispatchEvent(new Event('change'))
    expect(document.getElementById('mmc-paper')!.textContent).toContain(
      'size: 58mm 200mm; margin: 3mm 5mm;',
    )
    expect(document.documentElement.classList.contains('pw-xs')).toBe(true)
    // a size typed wrong is said, not printed
    sel.value = 'custom'
    sel.dispatchEvent(new Event('change'))
    ;(document.getElementById('pt-w') as HTMLInputElement).value = '5'
    document.getElementById('pt-print')!.click()
    expect(document.getElementById('pt-err')!.textContent).toBe(dl.paper.errWidth)
    expect(print).not.toHaveBeenCalled()
    // back to the 58 mm roll, straight away next time
    sel.value = 'roll-58'
    sel.dispatchEvent(new Event('change'))
    ;(document.getElementById('pt-auto') as HTMLInputElement).checked = true
    document.getElementById('pt-print')!.click()
    expect(print).toHaveBeenCalledTimes(1)
    expect(readPrintChoice('receipt')).toMatchObject({ paper: 'roll-58', straight: true })
  })

  it('later prints: the kept paper, printed straight away when asked', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    writePrintChoice('receipt', { paper: 'a5', margins: 'narrow', straight: true })
    open(receipt(true), true)
    expect(document.getElementById('mmc-paper')!.textContent).toContain(
      'size: A5 portrait; margin: 7mm 8mm 13mm;',
    )
    expect(document.documentElement.classList.contains('thermal')).toBe(false)
    await settle()
    expect(print).toHaveBeenCalledTimes(1)
    // kept but not straight away: shown, not printed
    print.mockClear()
    writePrintChoice('receipt', { paper: 'a5', straight: false })
    open(receipt(true), true)
    await settle()
    expect(print).not.toHaveBeenCalled()
    expect((document.getElementById('pt-paper') as HTMLSelectElement).value).toBe('a5')
  })
})
