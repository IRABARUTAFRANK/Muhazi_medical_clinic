import type { Margins, Orientation, PaperCfg, PaperChoice, PaperLayout, SavedChoice } from './paper'

/**
 * The script of a print window (0207). It applies the paper kept on this computer for the
 * document's kind, wires the print options at the top of the window (paper, orientation,
 * margins, "print straight away next time") and prints:
 * - a kind set to print straight away (and a document that asks to be printed) prints at once,
 *   as before 0207, on the kept paper;
 * - otherwise the window shows the options and prints only when Print is pressed; Print keeps
 *   the choice for the next document of the same kind.
 * A choice is applied live: the paper's CSS (`paperLayout`) replaces the <style id="mmc-paper">,
 * the classes of <html> follow, and a roll's height is measured from the content.
 *
 * Self-contained on purpose: the window runs a copy of it (`String(printRuntime)`), so it uses
 * nothing but its arguments and the browser's globals.
 */
export function printRuntime(
  cfg: PaperCfg,
  layout: (cfg: PaperCfg, c: PaperChoice | null | undefined) => PaperLayout,
  auto: boolean,
  errors: { width: string; height: string },
): void {
  const doc = document
  const root = doc.documentElement
  const ua = navigator.userAgent
  if (/firefox|fxios/i.test(ua) || (/safari/i.test(ua) && !/chrome|chromium|crios|edg/i.test(ua)))
    root.classList.add('no-margin-boxes')
  const key = 'mmc.print.' + cfg.kind
  const byId = (id: string) => doc.getElementById(id)

  // the choice kept on this computer (the same test as readPrintChoice in lib/paper.ts)
  let saved: SavedChoice | null
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? (JSON.parse(raw) as SavedChoice) : null
    saved = v && typeof v === 'object' && typeof v.paper === 'string' ? v : null
  } catch {
    // a private window keeps nothing
    saved = null
  }
  // printed at once: the kind is set to print straight away (openPrintWindow decides the same)
  const straight = auto && !!saved && saved.straight === true
  let current: PaperChoice = {
    paper: cfg.def.paper,
    orientation: null,
    margins: cfg.def.margins,
    w: null,
    h: null,
  }
  if (saved && layout(cfg, saved).ok)
    current = {
      paper: saved.paper,
      orientation: saved.orientation ?? null,
      margins: saved.margins ?? 'normal',
      w: saved.w ?? null,
      h: saved.h ?? null,
    }
  let lay = layout(cfg, current)
  let touched = !!current.orientation

  const style = byId('mmc-paper')
  const fit = doc.createElement('style')
  fit.id = 'mmc-roll'
  doc.head.appendChild(fit)
  const sel = byId('pt-paper') as HTMLSelectElement | null
  const ori = byId('pt-o') as HTMLSelectElement | null
  const mar = byId('pt-m') as HTMLSelectElement | null
  const wIn = byId('pt-w') as HTMLInputElement | null
  const hIn = byId('pt-h') as HTMLInputElement | null
  const tick = byId('pt-auto') as HTMLInputElement | null
  const err = byId('pt-err')
  const sizeBox = byId('pt-custom')
  const oriBox = byId('pt-o-f')
  const marBox = byId('pt-m-f')

  /**
   * A roll is as long as its content (Chrome ignores "80mm auto"): measured, plus 8 mm. Several
   * receipts (`.roll-page`, the receipts of a period) are each a page as long as the receipt, so
   * a printer that cuts after each page cuts after each receipt.
   */
  function fitRoll(): void {
    fit.textContent = ''
    const pages = doc.querySelectorAll('.sheet > .roll-page')
    pages.forEach((el) => (el as HTMLElement).style.removeProperty('page'))
    if (!lay.ok || lay.group !== 'roll' || lay.h !== null) return
    const s = doc.querySelector('.sheet') as HTMLElement | null
    if (!s) return
    const before = s.style.maxWidth
    s.style.maxWidth = 'none'
    const mm = Math.ceil((s.scrollHeight * 25.4) / 96) + 8
    let css = '@page { size: ' + lay.w + 'mm ' + mm + 'mm; margin: ' + lay.margin + '; }'
    if (pages.length > 1) {
      const m = lay.margin.split(/\s+/).map((x) => parseFloat(x) || 0)
      const topBottom = (m[0] || 0) + (m.length >= 3 ? m[2] || 0 : m[0] || 0)
      const w = lay.w
      const margin = lay.margin
      pages.forEach((el, i) => {
        const h = Math.ceil(((el as HTMLElement).getBoundingClientRect().height * 25.4) / 96)
        css +=
          '\n@page roll-' +
          i +
          ' { size: ' +
          w +
          'mm ' +
          (h + topBottom + 8) +
          'mm; margin: ' +
          margin +
          '; }'
        ;(el as HTMLElement).style.setProperty('page', 'roll-' + i)
      })
    }
    s.style.maxWidth = before
    fit.textContent = css
  }

  /**
   * 0211: a table wider than its page (a report's 12 columns on A5) gets smaller type, just enough
   * to fit, measured at the paper's own width (`fit-measure`, whatever the screen's width): the
   * browser would otherwise shrink the whole printout, every page, to fit that one table.
   */
  function fitTables(): void {
    const tables = doc.querySelectorAll('table.dt')
    if (!tables.length) return
    tables.forEach((t) => (t as HTMLElement).style.removeProperty('font-size'))
    if (!lay.ok || lay.group !== 'sheet') return
    root.classList.add('fit-measure')
    try {
      tables.forEach((el) => {
        const t = el as HTMLElement
        const box = t.closest('.rs') as HTMLElement | null
        if (!box) return
        // the table's narrowest width (all it can wrap, wrapped), not its 100 % of the page
        t.style.width = 'min-content'
        try {
          for (let k = 0; k < 8; k++) {
            const avail = box.clientWidth
            const need = t.offsetWidth
            // room to spare: print lays text out a little wider than the screen does
            if (!avail || need <= avail * 0.95) break
            const cur = parseFloat(getComputedStyle(t).fontSize)
            // the cell padding does not shrink with the text: aim lower, step by step. Never
            // below 7 px (about 5.3 pt): past that the browser's own shrinking is no worse
            const next = Math.max(7, cur * ((avail * 0.92) / need))
            if (!(next < cur - 0.05)) break
            t.style.fontSize = next.toFixed(2) + 'px'
          }
        } finally {
          t.style.removeProperty('width')
        }
      })
    } finally {
      root.classList.remove('fit-measure')
    }
  }

  function say(message: string | null): void {
    if (!err) return
    err.textContent = message || ''
    err.hidden = !message
  }

  /** Applies a choice to the document; false (and the reason shown) for a size typed wrong. */
  function apply(next: PaperChoice): boolean {
    const l = layout(cfg, next)
    if (!l.ok) {
      say(l.error === 'width' ? errors.width : errors.height)
      return false
    }
    say(null)
    lay = l
    current = next
    if (style) style.textContent = l.css
    const old: string[] = []
    root.classList.forEach((c) => {
      if (/^(paper-|pw-)/.test(c) || c === 'thermal') old.push(c)
    })
    old.forEach((c) => root.classList.remove(c))
    l.cls.forEach((c) => root.classList.add(c))
    if (ori && l.group === 'sheet' && !touched) ori.value = l.orientation
    fitRoll()
    fitTables()
    // the labels fit their text again (lib/dispense-label.ts)
    try {
      window.dispatchEvent(new Event('mmc-paper'))
    } catch {
      /* an old browser: the labels fit again before printing */
    }
    return true
  }

  function groupOf(id: string): string {
    if (id === 'custom') return 'custom'
    for (const p of cfg.papers) if (p.id === id) return p.group
    return 'sheet'
  }

  /** Only the options of the chosen paper: orientation for a sheet, margins but for a label. */
  function showFields(): void {
    if (!sel) return
    const g = groupOf(sel.value)
    if (sizeBox) sizeBox.hidden = g !== 'custom'
    if (oriBox) oriBox.hidden = g !== 'sheet'
    if (marBox) marBox.hidden = g === 'label'
  }

  function typedNumber(v: string): number | null {
    const s = v.trim().replace(',', '.')
    return s === '' ? null : Number(s)
  }

  function read(): PaperChoice {
    const paper = sel ? sel.value : current.paper
    return {
      paper,
      orientation: touched && ori ? (ori.value as Orientation) : null,
      margins: mar ? (mar.value as Margins) : 'normal',
      w: paper === 'custom' && wIn ? typedNumber(wIn.value) : null,
      h: paper === 'custom' && hIn ? typedNumber(hIn.value) : null,
    }
  }

  function print(): void {
    fitRoll()
    window.focus()
    window.print()
  }

  function close(): void {
    const fe = window.frameElement as HTMLElement | null
    if (!fe) {
      window.close()
      return
    }
    // the page under the frame takes the focus back (openPrintWindow)
    try {
      const view = fe.ownerDocument.defaultView
      fe.dispatchEvent(view ? new view.Event('mmc-print-close') : new Event('mmc-print-close'))
    } catch {
      /* removed below */
    }
    if (fe.parentNode) fe.parentNode.removeChild(fe)
  }

  // the options show the paper in use
  if (sel) {
    let known = current.paper === 'custom'
    for (const p of cfg.papers) if (p.id === current.paper) known = true
    sel.value = known ? current.paper : cfg.def.paper
  }
  if (lay.ok && ori) ori.value = lay.orientation
  if (lay.ok && mar) mar.value = lay.margins
  if (current.paper === 'custom' && lay.ok) {
    if (wIn) wIn.value = String(lay.w)
    if (hIn) hIn.value = lay.h === null ? '' : String(lay.h)
  }
  if (tick) tick.checked = !!(saved && saved.straight)
  showFields()
  apply(current)

  let timer = 0
  const later = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => apply(read()), 350)
  }
  if (sel)
    sel.addEventListener('change', () => {
      // a custom size starts from the paper in use
      if (sel.value === 'custom' && wIn && !wIn.value && lay.ok) {
        wIn.value = String(lay.w)
        if (hIn) hIn.value = lay.h === null ? '' : String(lay.h)
      }
      showFields()
      apply(read())
    })
  if (ori)
    ori.addEventListener('change', () => {
      touched = true
      apply(read())
    })
  if (mar) mar.addEventListener('change', () => apply(read()))
  if (wIn) wIn.addEventListener('input', later)
  if (hIn) hIn.addEventListener('input', later)
  const go = byId('pt-print')
  if (go)
    go.addEventListener('click', () => {
      window.clearTimeout(timer)
      const next = read()
      if (!apply(next)) {
        const l = layout(cfg, next)
        const bad = !l.ok && l.error === 'height' ? hIn : wIn
        if (bad) bad.focus()
        return
      }
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            paper: next.paper,
            orientation: next.orientation ?? null,
            margins: lay.ok ? lay.margins : 'normal',
            w: next.paper === 'custom' ? (next.w ?? null) : null,
            h: next.paper === 'custom' ? (next.h ?? null) : null,
            straight: !!(tick && tick.checked),
            at: new Date().toISOString(),
          }),
        )
      } catch {
        /* a private window keeps nothing: the options show again next time */
      }
      print()
    })
  const shut = byId('pt-close')
  if (shut) shut.addEventListener('click', close)
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.frameElement) {
      e.preventDefault()
      close()
    }
  })
  if (!straight && sel)
    try {
      sel.focus()
    } catch {
      /* not focusable yet */
    }

  // fonts and images ready (3 s at most), the roll's height measured, then print
  const cap = new Promise((r) => setTimeout(r, 3000))
  const loaded = new Promise<void>((r) => {
    if (doc.readyState === 'complete') r()
    else window.addEventListener('load', () => r(), { once: true })
  })
  const ready = loaded
    .then(() => {
      const f = doc.fonts
      const want = f
        ? Promise.all(
            ['400', '600', '700'].map((w) => f.load(w + ' 10pt "Source Sans 3"').catch(() => null)),
          )
        : Promise.resolve()
      return want.then(() => (f ? f.ready : null))
    })
    .then(() =>
      Promise.all(
        Array.prototype.map.call(doc.images, (i: HTMLImageElement) =>
          i.decode ? i.decode().catch(() => null) : null,
        ),
      ),
    )
    .catch(() => null)
  Promise.race([ready, cap]).then(() => {
    fitRoll()
    fitTables()
    if (straight) print()
  })
}
