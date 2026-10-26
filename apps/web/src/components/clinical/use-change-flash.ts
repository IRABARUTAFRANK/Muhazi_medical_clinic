import { useEffect, useRef, useState } from 'react'
import './visit-motion.css'

/**
 * True for 1.2 s after `signature` changes (not on first render): a queue row glows briefly
 * when the patient moves desk, is taken, or changes triage colour. Pair with `anim-row-flash`.
 */
export function useChangeFlash(signature: string): boolean {
  const [flash, setFlash] = useState(false)
  const prev = useRef(signature)
  useEffect(() => {
    if (prev.current === signature) return
    prev.current = signature
    setFlash(true)
    const id = window.setTimeout(() => setFlash(false), 1200)
    return () => window.clearTimeout(id)
  }, [signature])
  return flash
}
