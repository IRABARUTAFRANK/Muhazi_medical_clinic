import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Combine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { useFindPatients } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'
import { supabase } from '@/lib/supabase'

/**
 * The manager merges a duplicate file into this one: its visits, bookings, documents and
 * insurance move here, and the duplicate's number still finds the patient.
 */
export function MergeCard({ keepId, keepLabel }: { keepId: string; keepLabel: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [search, setSearch] = useState('')
  const { data: hits = [] } = useFindPatients(search)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const others = hits.filter((h) => h.id !== keepId)

  const merge = async (id: string, label: string) => {
    if (
      !(await confirm({
        title: t('confirm.desks.patient.merge', { dup: label, keep: keepLabel }),
        body: t('confirm.desks.patient.mergeBody', { dup: label }),
        confirmLabel: t('confirm.desks.patient.mergeYes'),
        tone: 'danger',
      }))
    )
      return
    setMsg(null)
    setBusy(true)
    try {
      if (supabase) {
        const { data, error } = await supabase.rpc('merge_patients', {
          p_keep: keepId,
          p_merge: id,
        })
        if (error) throw new Error(error.message)
        const r = (data ?? {}) as { moved?: number }
        setMsg({ ok: true, text: t('patients.merge.done', { dup: label, count: r.moved ?? 0 }) })
      } else {
        setMsg({ ok: true, text: t('patients.merge.done', { dup: label, count: 0 }) })
      }
      setSearch('')
      void qc.invalidateQueries({ queryKey: ['patients'] })
      void navigate({ to: '/app/patient', search: { id: keepId } })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader hue="amber">
        <span className="inline-flex items-center gap-2">
          <Combine size={16} aria-hidden="true" />
          {t('patients.merge.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('patients.merge.lead')}</p>
        <Field
          label={t('patients.merge.find')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('register.searchPh')}
          autoComplete="off"
        />
        {others.map((p) => {
          const label = `${p.fileNumber} · ${p.surname} ${p.givenNames}`
          return (
            <Row key={p.id} className="flex-wrap gap-3 py-2">
              <span className="min-w-[160px] flex-1">
                <span className="block font-semibold">{label}</span>
                <span className="text-ink-3 text-xs">
                  {[p.birthDate, p.phone].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Button size="sm" disabled={busy} onClick={() => void merge(p.id, label)}>
                {t('patients.merge.button')}
              </Button>
            </Row>
          )
        })}
        {msg && (
          <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
            {msg.text}
          </Flash>
        )}
      </CardBody>
    </Card>
  )
}
