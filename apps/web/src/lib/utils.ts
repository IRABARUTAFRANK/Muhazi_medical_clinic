import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes, later classes win. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))
