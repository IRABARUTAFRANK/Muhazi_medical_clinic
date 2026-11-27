import { create } from 'zustand'

/** Whether the "Printing on this computer" panel is open (opened from the user menu, 0207). */
export const usePrintChoicesPanel = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
)
