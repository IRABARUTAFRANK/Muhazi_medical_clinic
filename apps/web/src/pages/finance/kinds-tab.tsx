import { useState, type FormEvent } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Empty, Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { ActionRow } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { kindName, useAccountsActions, useMoneyKinds, type MoneyKind } from '@/lib/api/accounts'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Note, PanelForm } from './accounts-kit'
import { errText, type Msg } from './accounts-tabs'
import { DeductionsPanel } from './deductions-panel'

/**
 * The kinds of money (0185): what money in and money out the clinic has, each with a description
 * of what it really is. The built-in kinds are filled by the system (patient bills, walk-in
 * sales, salaries, stock bought…) and only their description can change; the accountant adds
 * the others (rent received, electricity, cleaning…) and retires one no longer used.
 */
export function KindsTab() {
  const { t } = useTranslation()
  const { data: kinds = [], error } = useMoneyKinds()
  const [msg, setMsg] = useState<Msg | null>(null)
  // the form: 'new' (with the side), or the kind being changed
  const [form, setForm] = useState<{ side: 'in' | 'out'; kind: MoneyKind | null } | null>(null)
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <p className="text-ink-2 m-0 text-[14px]">{t('accounts.kinds.lead')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              setMsg(null)
              setForm({ side: 'in', kind: null })
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t('accounts.kinds.addIn')}
          </Button>
          <Button
            variant="tint-coral"
            onClick={() => {
              setMsg(null)
              setForm({ side: 'out', kind: null })
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t('accounts.kinds.addOut')}
          </Button>
        </div>
      </ActionRow>
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {msg && <Note msg={msg} />}
      {form && (
        <KindForm
          side={form.side}
          current={form.kind}
          onClose={() => setForm(null)}
          onMsg={setMsg}
        />
      )}
      <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
        {(['in', 'out'] as const).map((side, i) => {
          const list = kinds.filter((k) => k.side === side)
          return (
            <Panel
              key={side}
              i={i + 1}
              icon={side === 'in' ? ArrowDownToLine : ArrowUpFromLine}
              tint={side === 'in' ? 'teal' : 'coral'}
              title={t(`accounts.kinds.${side}`)}
            >
              {list.length === 0 ? (
                <Empty icon={side === 'in' ? ArrowDownToLine : ArrowUpFromLine}>
                  {t('accounts.kinds.none')}
                </Empty>
              ) : (
                <KindTable
                  list={list}
                  onChange={(k) => {
                    setMsg(null)
                    setForm({ side, kind: k })
                  }}
                  onMsg={setMsg}
                />
              )}
            </Panel>
          )
        })}
      </div>
      <DeductionsPanel i={3} />
    </div>
  )
}

function KindTable({
  list,
  onChange,
  onMsg,
}: {
  list: MoneyKind[]
  onChange: (k: MoneyKind) => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { setKind, removeKind } = useAccountsActions()
  const toggle = async (k: MoneyKind) => {
    try {
      await setKind.mutateAsync({
        id: k.id,
        side: k.side,
        name: k.name,
        description: k.description ?? '',
        active: !k.active,
      })
      onMsg({
        ok: true,
        text: t(k.active ? 'accounts.kinds.retired' : 'accounts.kinds.restored', {
          name: kindName(t, k),
        }),
      })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const remove = async (k: MoneyKind) => {
    if (
      !(await confirm({
        title: t('accounts.kinds.removeTitle', { name: k.name }),
        body: t('accounts.kinds.removeBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removeKind.mutateAsync(k.id)
      onMsg({ ok: true, text: t('accounts.kinds.removed', { name: k.name }) })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const actions = (k: MoneyKind) => (
    <>
      <Button size="sm" variant="tint-blue" onClick={() => onChange(k)}>
        {t('accounts.salaries.edit')}
      </Button>
      {!k.code && (
        <Button size="sm" variant="ghost" onClick={() => void toggle(k)}>
          {t(k.active ? 'accounts.kinds.retire' : 'accounts.kinds.restore')}
        </Button>
      )}
      {!k.code && k.inUse === 0 && (
        <Button size="sm" variant="ghost" onClick={() => void remove(k)}>
          {t('accounts.kinds.remove')}
        </Button>
      )}
    </>
  )
  return (
    <div className="@container overflow-x-auto">
      <table className="w-full border-collapse text-[14px]">
        <thead className="bg-surface">
          <tr className="border-border border-b">
            <th className={tableHead}>{t('accounts.kinds.name')}</th>
            <th className={cn(tableHead, 'text-right')}>{t('accounts.kinds.inUse')}</th>
            <th className={cn(tableHead, '@max-[32rem]:hidden')}></th>
          </tr>
        </thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} className={cn(tableRow, !k.active && 'opacity-60')}>
              <td className={tableFirstCell}>
                <span className="flex flex-wrap items-center gap-2">
                  {kindName(t, k)}
                  {k.code && <Badge tone="grey">{t('accounts.kinds.builtin')}</Badge>}
                  {!k.active && <Badge tone="yellow">{t('accounts.kinds.retiredTag')}</Badge>}
                </span>
                {k.description && (
                  <span className="text-ink-3 block text-[12px]">{k.description}</span>
                )}
                <span className="mt-1.5 hidden flex-wrap gap-1 @max-[32rem]:flex">
                  {actions(k)}
                </span>
              </td>
              <td className={cn(tableCell, 'text-right tabular-nums')}>{k.inUse}</td>
              <td className={cn(tableCell, 'text-right whitespace-nowrap @max-[32rem]:hidden')}>
                <span className="inline-flex gap-1">{actions(k)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function KindForm({
  side,
  current,
  onClose,
  onMsg,
}: {
  side: 'in' | 'out'
  current: MoneyKind | null
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { setKind } = useAccountsActions()
  const [name, setName] = useState(current?.name ?? '')
  const [description, setDescription] = useState(current?.description ?? '')
  const [kindSide, setKindSide] = useState<'in' | 'out'>(side)
  const builtin = !!current?.code
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!builtin && name.trim().length < 2)
      return onMsg({ ok: false, text: t('accounts.kinds.errors.name') })
    try {
      await setKind.mutateAsync({
        id: current?.id ?? null,
        side: current?.side ?? kindSide,
        name: builtin ? current!.name : name.trim(),
        description: description.trim(),
        active: current?.active ?? true,
      })
      onMsg({
        ok: true,
        text: t('accounts.kinds.saved', { name: builtin ? kindName(t, current!) : name.trim() }),
      })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm
      title={
        current
          ? t('accounts.kinds.changeTitle', { name: kindName(t, current) })
          : t(`accounts.kinds.newTitle.${kindSide}`)
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!current && (
            <Select
              label={t('accounts.kinds.side')}
              value={kindSide}
              onChange={(e) => setKindSide(e.target.value as 'in' | 'out')}
            >
              <option value="in">{t('accounts.kinds.in')}</option>
              <option value="out">{t('accounts.kinds.out')}</option>
            </Select>
          )}
          {!builtin && (
            <Field
              label={t('accounts.kinds.name')}
              placeholder={t(`accounts.kinds.namePh.${current?.side ?? kindSide}`)}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </div>
        <Field
          label={t('accounts.kinds.description')}
          placeholder={t('accounts.kinds.descriptionPh')}
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 300))}
        />
        {builtin && <p className="text-ink-3 m-0 text-[13px]">{t('accounts.kinds.builtinHint')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={setKind.isPending}>
            {t('accounts.kinds.save')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}
