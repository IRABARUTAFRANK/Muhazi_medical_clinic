import { useState, type FormEvent } from 'react'
import { Save, Settings2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import { usePriceListActions, type PriceListBook } from '@/lib/api/price-lists'
import { errorBox, useRemoveList } from './price-list-kit'

/**
 * A list's settings (Prices › Published price lists › Settings): its name and publisher; for the
 * Ministry's list for the whole clinic, the column private patients pay and its order among the
 * clinic-wide lists (smallest first: the first with a line prices it); for an insurer's own list,
 * the column that insurer pays. "Remove the list" takes it away with what it made (0136).
 */
export function BookSettingsPanel({
  book,
  onClose,
  onNotice,
}: {
  book: PriceListBook
  onClose: () => void
  onNotice: (text: string) => void
}) {
  const { t } = useTranslation()
  const actions = usePriceListActions()
  const removeList = useRemoveList(onNotice)
  const columns = book.versions.find((v) => v.status === 'current')?.columns ?? []
  const own = book.followers.find((f) => f.payerId === book.payerId)?.column ?? ''
  const [name, setName] = useState(book.name)
  const [publisher, setPublisher] = useState(book.publisher)
  // 0145: no column = the clinic sets its own cash prices ("-")
  const [privateColumn, setPrivateColumn] = useState(book.privateColumn ?? '-')
  const [priority, setPriority] = useState(String(book.priority))
  const [payerColumn, setPayerColumn] = useState(own)
  const [error, setError] = useState<string | null>(null)
  const busy = actions.saveBook.isPending || actions.saveSettings.isPending || removeList.busy

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      if (name.trim() !== book.name || publisher.trim() !== book.publisher)
        await actions.saveBook.mutateAsync({
          id: book.id,
          name: name.trim(),
          publisher: publisher.trim(),
          remove: false,
        })
      if (
        (book.scope === 'clinic' &&
          (privateColumn !== (book.privateColumn ?? '-') || priority !== String(book.priority))) ||
        (book.scope === 'insurer' && payerColumn !== own)
      )
        await actions.saveSettings.mutateAsync({
          bookId: book.id,
          privateColumn: book.scope === 'clinic' ? privateColumn || null : null,
          priority: book.scope === 'clinic' && priority ? Number(priority) : null,
          payerColumn: book.scope === 'insurer' ? payerColumn || null : null,
        })
      onNotice(t('prices.lists.settingsSaved', { name: name.trim() }))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async () => {
    setError(null)
    try {
      if (await removeList.run(book)) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <SidePanel
      open
      onClose={onClose}
      hue="lavender"
      icon={Settings2}
      title={t('prices.lists.settingsTitle', { name: book.name })}
      subtitle={
        book.scope === 'insurer' && book.payerBody
          ? t('prices.lists.rssb.scope')
          : book.scope === 'insurer' && book.payer
            ? t('prices.lists.scopeOf', { payer: book.payer })
            : t(`prices.lists.scope.${book.scope}`)
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button type="submit" form="price-list-settings" variant="primary" loading={busy}>
            <Save size={16} aria-hidden="true" />
            {t('prices.lists.saveSettings')}
          </Button>
        </>
      }
    >
      <form id="price-list-settings" onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
        <Field
          label={t('prices.lists.bookName')}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label={t('prices.lists.publisher')}
          value={publisher}
          maxLength={80}
          onChange={(e) => setPublisher(e.target.value)}
        />
        {book.scope === 'clinic' && (
          <>
            <Select
              label={t('prices.lists.privateColumn')}
              value={privateColumn}
              onChange={(e) => setPrivateColumn(e.target.value)}
            >
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
              <option value="-">{t('prices.lists.ownCashPrices')}</option>
            </Select>
            {privateColumn === '-' && (
              <p className="text-ink-2 m-0 text-[13px]">{t('prices.lists.ownCashPricesHint')}</p>
            )}
            <Field
              label={t('prices.lists.order')}
              inputMode="numeric"
              value={priority}
              onChange={(e) => setPriority(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
            />
            <p className="text-ink-3 m-0 text-[13px]">{t('prices.lists.orderHint')}</p>
          </>
        )}
        {book.scope === 'insurer' && columns.length > 0 && (
          <Select
            label={
              book.payerBody
                ? t('prices.lists.rssb.column')
                : t('prices.lists.payerColumn', { payer: book.payer ?? '' })
            }
            value={payerColumn}
            onChange={(e) => setPayerColumn(e.target.value)}
          >
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <div className="border-border mt-2 flex flex-col gap-2 border-t pt-3">
          <span className="text-ink-2 text-[13px]">{t('prices.lists.deleteHint')}</span>
          <Button
            type="button"
            variant="tint-coral"
            className="self-start"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('prices.lists.delete')}
          </Button>
        </div>
      </form>
    </SidePanel>
  )
}
