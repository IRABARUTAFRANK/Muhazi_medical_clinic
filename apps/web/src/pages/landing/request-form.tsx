import { useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { kigaliTime, kigaliToday } from '@/lib/clock'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import {
  RW_PHONE,
  cleanPhone,
  inquiryErrorKey,
  sendInquiry,
  type InquiryChannel,
} from '@/lib/api/inquiries'
import { cn } from '@/lib/utils'

const channelKey: Record<InquiryChannel, string> = {
  whatsapp: 'landing.book.whatsapp',
  sms: 'landing.book.sms',
  call: 'landing.book.callChannel',
}

/** "Request an appointment" card on the landing page: free-text inquiry for reception. */
export function RequestForm() {
  const { t } = useTranslation()
  const [channel, setChannel] = useState<InquiryChannel>('whatsapp')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [service, setService] = useState('')
  const [day, setDay] = useState('')
  const [time, setTime] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentRef, setSentRef] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    if (fullName.trim().length < 3) return setError(t('landing.book.errors.name'))
    if (!RW_PHONE.test(cleanPhone(phone))) return setError(t('landing.book.errors.phone'))
    // the clinic's time; today without a time means "today, as soon as possible"
    const [y, m, d] = day.split('-').map(Number)
    const [hh, mm] = (time || (day === kigaliToday() ? '' : '08:00')).split(':').map(Number)
    const preferredAt =
      day && y && m && d
        ? time || day !== kigaliToday()
          ? kigaliTime(y, m - 1, d, hh ?? 8, mm ?? 0)
          : new Date(Date.now() + 60 * 60_000)
        : null
    if (preferredAt && preferredAt.getTime() < Date.now())
      return setError(t('landing.book.errors.past'))
    setBusy(true)
    try {
      const result = await sendInquiry({
        practitionerCode: null,
        startsAt: null,
        fullName,
        phone: cleanPhone(phone),
        note: service,
        channel,
        preferredAt,
      })
      setSentRef(result.reference)
    } catch (err) {
      setError(t(`landing.book.errors.${inquiryErrorKey(err instanceof Error ? err.message : '')}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={t('landing.book.formTitle')}
      className="card-glow bg-card flex min-w-0 flex-col gap-3.5 rounded-2xl p-6"
    >
      <span className="text-lg font-bold">{t('landing.book.formTitle')}</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={t('landing.book.fullName')}
          placeholder={t('landing.book.fullNamePh')}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
        <Field
          label={t('landing.book.phone')}
          type="tel"
          placeholder={t('landing.book.phonePh')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
      </div>
      <Field
        label={t('landing.book.service')}
        placeholder={t('landing.book.servicePh')}
        value={service}
        onChange={(e) => setService(e.target.value)}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={t('landing.book.day')}
          type="date"
          min={kigaliToday()}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        <Field
          label={t('landing.book.time')}
          type="time"
          step={900}
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      </div>
      <div className="text-ink-2 flex flex-wrap items-center gap-2 text-[13px]">
        {t('landing.book.confirmBy')}
        {(Object.keys(channelKey) as InquiryChannel[]).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={channel === c}
            onClick={() => setChannel(c)}
            className={cn(
              'inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors',
              channel === c
                ? 'border-primary bg-primary-tint text-primary'
                : 'border-border bg-card text-ink hover:bg-hover',
            )}
          >
            {t(channelKey[c])}
          </button>
        ))}
      </div>
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? t('landing.book.sending') : t('common.sendRequest')}
      </Button>
      {sentRef && (
        <p
          role="status"
          className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
        >
          {t('landing.book.sentRef', { ref: sentRef, channel: t(channelKey[channel]) })}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
        >
          {error}
        </p>
      )}
      <p className="text-ink-3 m-0 text-xs">
        <Trans i18nKey="landing.book.emergency" components={{ b: <b /> }} />
      </p>
    </form>
  )
}
