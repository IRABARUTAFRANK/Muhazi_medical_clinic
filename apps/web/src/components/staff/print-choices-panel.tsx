import { useMemo, useState } from 'react'
import { Printer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { SidePanel } from '@/components/ui/side-panel'
import { makePaperWords, type TFn } from '@/lib/doc-style'
import {
  canKeepChoices,
  choiceText,
  DOC_KINDS,
  forgetPrintChoice,
  readPrintChoice,
  writePrintChoice,
} from '@/lib/paper'
import { cn } from '@/lib/utils'
import { usePrintChoicesPanel } from '@/store/print-choices'

/**
 * "Printing on this computer" (0207): the paper each kind of document prints on, as kept on this
 * computer by the print window, with Ask again (show the print options next time instead of
 * printing straight away) and Forget. Mounted once in the staff shell; opened from the user menu.
 */
export function PrintChoicesHost() {
  const { t } = useTranslation()
  const open = usePrintChoicesPanel((s) => s.open)
  const setOpen = usePrintChoicesPanel((s) => s.setOpen)
  return (
    <SidePanel
      open={open}
      onClose={() => setOpen(false)}
      hue="grey"
      icon={Printer}
      title={t('doc.paper.panel.menu')}
    >
      {open && <PrintChoicesList />}
    </SidePanel>
  )
}

function PrintChoicesList() {
  const { t } = useTranslation()
  const words = useMemo(() => makePaperWords(t as unknown as TFn), [t])
  // the choices live in this browser's storage: read again after each change
  const [, setVersion] = useState(0)
  const changed = () => setVersion((n) => n + 1)
  const keeps = canKeepChoices()
  const rows = DOC_KINDS.map((kind) => ({ kind, saved: readPrintChoice(kind) }))
  const any = rows.some((r) => r.saved)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2 m-0 text-[14px] leading-relaxed">{t('doc.paper.panel.lead')}</p>
      {!keeps && (
        <p className="border-amber/30 bg-amber-bg text-amber m-0 rounded-md border px-3 py-2 text-[14px] font-medium">
          {t('doc.paper.panel.noStorage')}
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(({ kind, saved }) => (
          <li
            key={kind}
            className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2.5"
          >
            <div className="min-w-0 flex-[1_1_220px]">
              <div className="text-ink text-[14px] font-semibold">
                {t(`doc.paper.kinds.${kind}`)}
              </div>
              <div className="text-ink-2 text-[13px] break-words">
                {saved ? choiceText(kind, saved, words) : t('doc.paper.panel.notChosen')}
              </div>
              {saved && (
                <div
                  className={cn(
                    'text-[12.5px] font-medium',
                    saved.straight ? 'text-green' : 'text-ink-3',
                  )}
                >
                  {t(saved.straight ? 'doc.paper.panel.straightOn' : 'doc.paper.panel.straightOff')}
                </div>
              )}
            </div>
            {saved && (
              <div className="flex flex-wrap gap-2">
                {saved.straight && (
                  <Button
                    size="sm"
                    variant="tint-teal"
                    onClick={() => {
                      writePrintChoice(kind, { ...saved, straight: false })
                      changed()
                    }}
                  >
                    {t('doc.paper.panel.askAgain')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="tint-coral"
                  onClick={() => {
                    forgetPrintChoice(kind)
                    changed()
                  }}
                >
                  {t('doc.paper.panel.forget')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {any && (
        <div>
          <Button
            variant="tint-coral"
            onClick={() => {
              DOC_KINDS.forEach(forgetPrintChoice)
              changed()
            }}
          >
            {t('doc.paper.panel.forgetAll')}
          </Button>
        </div>
      )}
    </div>
  )
}
