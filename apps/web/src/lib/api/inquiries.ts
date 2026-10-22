import { inquiryReference, type CategoryFilter } from '@mmc/shared'
import { supabase } from '@/lib/supabase'

export type InquiryChannel = 'whatsapp' | 'sms' | 'call'

export interface InquiryInput {
  /** Practitioner code (`mb`, `nf`, …) or null for a free-text request. */
  practitionerCode: string | null
  startsAt: Date | null
  fullName: string
  phone: string
  insurer?: string
  category?: CategoryFilter
  /** Free text from the landing form: the service asked for. */
  note?: string
  channel?: InquiryChannel
  /** Landing form: the day and time the person would like (no doctor chosen). */
  preferredAt?: Date | null
}

/** Rwandan mobile number: 07xx xxx xxx, with or without +250. */
export const RW_PHONE = /^(\+?250|0)?7[0-9]{8}$/
export const cleanPhone = (phone: string) => phone.replace(/[^0-9+]/g, '')

/** The reason a request was refused, as a translation key under `landing.book.errors`. */
export function inquiryErrorKey(message: string): string {
  const m = message.toLowerCase()
  // "too many requests for this phone" mentions the phone too: checked first
  if (m.includes('too many')) return 'tooMany'
  if (m.includes('phone')) return 'phone'
  if (m.includes('full name')) return 'name'
  if (m.includes('just been taken')) return 'taken'
  if (m.includes('in the past')) return 'past'
  if (m.includes('does not work')) return 'notWorking'
  return 'generic'
}

export interface InquiryResult {
  reference: string
  /** `live` = stored in Supabase, `sample` = no backend configured. */
  mode: 'live' | 'sample'
}

/**
 * Send an appointment inquiry (doc §6, state "inquiry", slot held 24 h).
 * Calls the `create_appointment_inquiry` database function, which is the only
 * write the anonymous public site is allowed to make.
 */
export async function sendInquiry(input: InquiryInput): Promise<InquiryResult> {
  if (!supabase) {
    const key = `${input.practitionerCode ?? 'x'}|${input.startsAt?.toISOString() ?? input.phone}`
    return { reference: inquiryReference(key, new Date().getFullYear()), mode: 'sample' }
  }
  const { data, error } = await supabase.rpc('create_appointment_inquiry', {
    p_practitioner_code: input.practitionerCode,
    p_starts_at: input.startsAt?.toISOString() ?? null,
    p_full_name: input.fullName.trim(),
    p_phone: input.phone.trim(),
    p_insurer: input.insurer?.trim() || null,
    p_category: input.category && input.category !== 'all' ? input.category : null,
    p_note: input.note?.trim() || null,
    p_channel: input.channel ?? 'whatsapp',
    p_preferred_at: input.preferredAt?.toISOString() ?? null,
  })
  if (error) throw new Error(error.message)
  return { reference: String(data), mode: 'live' }
}
