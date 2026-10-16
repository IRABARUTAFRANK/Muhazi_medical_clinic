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
  /** Free text from the landing form: service, preferred day and time. */
  note?: string
  channel?: InquiryChannel
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
  })
  if (error) throw new Error(error.message)
  return { reference: String(data), mode: 'live' }
}
