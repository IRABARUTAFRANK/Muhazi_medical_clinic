import { useState } from 'react'
import { Check, KeyRound, UserCog, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, IconChip } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import {
  MANAGED_FEATURES,
  MATRIX_ROLES,
  usePermissionActions,
  usePermissionMatrix,
  type Feature,
} from '@/lib/api/permissions'
import { useEmployees } from '@/lib/api/staff'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { DesksCard } from './desks-card'

/*
 * Settings → Who may do what (manager). Each feature (take payments, start visits, vitals…) is
 * switched on or off for each role; below, an exception for one employee overrides their role
 * (allowed although the role is not, or not allowed although it is — e.g. not in charge today).
 * The database enforces it; every change is in the history. Below it, the desks each role may use
 * (DesksCard): the role is the ceiling, the departments decide (0085).
 */
export function PermissionsCard() {
  const { t } = useTranslation()
  const { data: matrix, error: loadError } = usePermissionMatrix()
  const { data: employees = [] } = useEmployees()
  const actions = usePermissionActions()
  const confirm = useConfirm()
  const [person, setPerson] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(done)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const has = (role: string, f: Feature) => matrix?.roles[role]?.includes(f) ?? false
  const staff = employees.filter((e) => e.active && e.role !== 'manager')
  const chosen = staff.find((e) => e.id === person)
  const exceptionOf = (id: string, f: Feature) =>
    matrix?.exceptions.find((x) => x.profileId === id && x.permission === f)

  return (
    <>
      <Card>
        <CardHeader hue="navy">
          <span className="inline-flex items-center gap-2">
            <IconChip icon={KeyRound} tint="violet" />
            {t('perms.title')}
          </span>
        </CardHeader>
        <CardBody className="gap-3">
          <p className="text-ink-2 m-0 text-[14px]">{t('perms.lead')}</p>
          {(loadError || error) && (
            <Flash tone="error" onClose={() => setError(null)}>
              {error ?? loadError?.message}
            </Flash>
          )}
          {notice && (
            <Flash key={notice} onClose={() => setNotice(null)}>
              {notice}
            </Flash>
          )}
          <div className="border-border overflow-x-auto rounded-md border">
            <table className="w-full min-w-[760px] border-collapse text-[14px]">
              <thead>
                <tr className="border-border bg-surface border-b">
                  <th scope="col" className={tableHead}>
                    {t('perms.feature')}
                  </th>
                  {MATRIX_ROLES.map((r) => (
                    <th key={r} scope="col" className={cn(tableHead, 'px-2 text-center')}>
                      {t(`staff.roles.${r}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MANAGED_FEATURES.map((f) => (
                  <tr key={f} className={tableRow}>
                    <td className={tableFirstCell}>
                      <span className="block">{t(`perms.f.${f}.name`)}</span>
                      <span className="text-ink-3 block text-xs font-normal">
                        {t(`perms.f.${f}.hint`)}
                      </span>
                    </td>
                    {MATRIX_ROLES.map((r) => {
                      const on = has(r, f)
                      return (
                        <td key={r} className={cn(tableCell, 'px-2 text-center')}>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={on}
                            aria-label={`${t(`perms.f.${f}.name`)} · ${t(`staff.roles.${r}`)}`}
                            disabled={!matrix || actions.setRole.isPending}
                            onClick={async () => {
                              const vars = {
                                feature: t(`perms.f.${f}.name`),
                                role: t(`staff.roles.${r}`),
                              }
                              const k = on ? 'confirm.perms.roleOff' : 'confirm.perms.roleOn'
                              if (
                                !(await confirm({
                                  title: t(`${k}.title`, vars),
                                  body: t(`${k}.body`, vars),
                                  confirmLabel: t(`${k}.yes`),
                                  tone: on ? 'danger' : 'primary',
                                }))
                              )
                                return
                              void run(
                                () =>
                                  actions.setRole.mutateAsync({
                                    role: r,
                                    permission: f,
                                    allowed: !on,
                                  }),
                                t(on ? 'perms.roleOff' : 'perms.roleOn', {
                                  feature: t(`perms.f.${f}.name`),
                                  role: t(`staff.roles.${r}`),
                                }),
                              )
                            }}
                            className={cn(
                              'inline-flex size-9 items-center justify-center rounded-md border transition-colors',
                              on
                                ? 'border-green/40 bg-green-bg text-green'
                                : 'border-border bg-card text-ink-3 hover:bg-hover',
                            )}
                          >
                            {on ? (
                              <Check size={16} strokeWidth={3} aria-hidden="true" />
                            ) : (
                              <X size={15} aria-hidden="true" />
                            )}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Hint>{t('perms.managerNote')}</Hint>
        </CardBody>

        {/* One employee */}
        <CardHeader hue="navy" className="border-t">
          <span className="inline-flex items-center gap-2">
            <IconChip icon={UserCog} tint="violet" />
            {t('perms.oneTitle')}
          </span>
        </CardHeader>
        <CardBody className="gap-3">
          <p className="text-ink-2 m-0 text-[14px]">{t('perms.oneLead')}</p>
          <Select
            label={t('perms.employee')}
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            wrapperClassName="sm:max-w-md"
          >
            <option value="">{t('perms.pickEmployee')}</option>
            {staff.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName} · {t(`staff.roles.${e.role}`)}
              </option>
            ))}
          </Select>
          {chosen && (
            <div className="border-border flex flex-col rounded-md border">
              {MANAGED_FEATURES.map((f) => {
                const ex = exceptionOf(chosen.id, f)
                const byRole = has(chosen.role, f)
                const value = ex ? (ex.allowed ? 'yes' : 'no') : 'role'
                const effective = ex ? ex.allowed : byRole
                return (
                  <div
                    key={f}
                    className="border-grid hover:bg-hover flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-1.5 transition-colors duration-120 last:border-b-0"
                  >
                    <span className="min-w-[min(200px,100%)] flex-1">
                      <span className="block font-medium">{t(`perms.f.${f}.name`)}</span>
                      <span className="text-ink-3 block text-xs">
                        {t(byRole ? 'perms.roleYes' : 'perms.roleNo', {
                          role: t(`staff.roles.${chosen.role}`),
                        })}
                      </span>
                    </span>
                    <Badge
                      tone={effective ? 'green' : 'red'}
                      icon={
                        effective ? (
                          <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                        ) : (
                          <X size={12} strokeWidth={2.5} aria-hidden="true" />
                        )
                      }
                    >
                      {t(effective ? 'perms.allowed' : 'perms.notAllowed')}
                    </Badge>
                    <span className="flex flex-wrap gap-1" role="radiogroup">
                      {(['role', 'yes', 'no'] as const).map((v) => (
                        <Button
                          key={v}
                          size="sm"
                          variant={value === v ? 'primary' : 'tint-grey'}
                          aria-checked={value === v}
                          role="radio"
                          disabled={actions.setStaff.isPending}
                          onClick={async () => {
                            if (value === v) return
                            const vars = {
                              feature: t(`perms.f.${f}.name`),
                              name: chosen.fullName,
                              role: t(`staff.roles.${chosen.role}`),
                            }
                            if (
                              !(await confirm({
                                title: t(`confirm.perms.one.${v}.title`, vars),
                                body: t(`confirm.perms.one.${v}.body`, vars),
                                confirmLabel: t('confirm.perms.one.change'),
                                tone: v === 'no' ? 'danger' : 'primary',
                              }))
                            )
                              return
                            void run(
                              () =>
                                actions.setStaff.mutateAsync({
                                  profileId: chosen.id,
                                  name: chosen.fullName,
                                  role: chosen.role,
                                  permission: f,
                                  allowed: v === 'role' ? null : v === 'yes',
                                }),
                              t(`perms.one.${v}Done`, {
                                feature: t(`perms.f.${f}.name`),
                                name: chosen.fullName,
                              }),
                            )
                          }}
                        >
                          {t(`perms.one.${v}`)}
                        </Button>
                      ))}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {matrix && matrix.exceptions.length > 0 && (
            <div className="flex flex-col">
              <span className="text-ink-3 border-border flex h-10 items-center border-b text-[12px]">
                {t('perms.current')}
              </span>
              {matrix.exceptions.map((x) => (
                <span
                  key={x.profileId + x.permission}
                  className="border-grid flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b py-1.5 text-[14px] last:border-b-0"
                >
                  <span className="font-medium">{x.name}</span>
                  <span className="text-ink-2">· {t(`perms.f.${x.permission}.name`)}</span>
                  <Badge
                    tone={x.allowed ? 'green' : 'red'}
                    icon={
                      x.allowed ? (
                        <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                      ) : (
                        <X size={12} strokeWidth={2.5} aria-hidden="true" />
                      )
                    }
                  >
                    {t(x.allowed ? 'perms.allowed' : 'perms.notAllowed')}
                  </Badge>
                </span>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
      <DesksCard />
    </>
  )
}
