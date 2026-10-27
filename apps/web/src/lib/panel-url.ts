import { useCallback, type MouseEvent } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'

/*
 * The patient file opens beside the list it was opened from (components/clinical/file-panel.tsx)
 * instead of leaving the page: `?file=<patientId>` (and `tab=`) on the current address shows
 * it, so Back closes it and the address can be shared. Routes validate their own search params
 * and leave unknown ones in the address (the router is not strict), which is where these read.
 */

type Search = Record<string, unknown>

/** Set when the panel was opened from this page: closing it then goes Back instead of forward. */
let openedHere = false

/** `openFile(patientId, tab?)` shows the patient's file in the side panel of the current page. */
export function useOpenFile() {
  const router = useRouter()
  return useCallback(
    (patientId: string, tab?: string) => {
      openedHere = true
      void router.navigate({
        to: '.',
        search: (s: Search) => ({ ...s, file: patientId, tab }),
        replace: false,
      } as never)
    },
    [router],
  )
}

/** Closes the panel: Back when it was opened here, else the address without `file`. */
export function useCloseFile() {
  const router = useRouter()
  return useCallback(() => {
    if (openedHere) {
      openedHere = false
      router.history.back()
      return
    }
    void router.navigate({
      to: '.',
      search: (s: Search) =>
        Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'file' && k !== 'tab')),
      replace: true,
    } as never)
  }, [router])
}

/** The patient whose file the panel shows now (null when closed): lists tint that row. */
export function useOpenFileId(): string | null {
  const file = useLocation({ select: (l) => (l.search as Search).file })
  return typeof file === 'string' && file ? file : null
}

/** The `tab=` beside `file=`, if any. */
export function useOpenFileTab(): string | undefined {
  const tab = useLocation({ select: (l) => (l.search as Search).tab })
  return typeof tab === 'string' ? tab : undefined
}

/** The address of the whole page of a patient file (for `href`). */
export function useFileHref() {
  const router = useRouter()
  return (patientId: string, tab?: string) =>
    router.buildLocation({ to: '/app/patient', search: { id: patientId, tab } }).href
}

/** Plain left click only: modifiers and the middle button keep the browser's own behaviour. */
export const plainClick = (e: MouseEvent) =>
  !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/** The action link (teal, icon, underline on hover) and its 28 px table pill: button.tsx owns them. */
export { actionLink as actionLinkClass, tableLink as tableLinkClass } from '@/components/ui/button'
