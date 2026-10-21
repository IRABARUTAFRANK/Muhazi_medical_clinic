import { useState } from 'react'
import { Check, KeyRound, UserCog, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconChip } from '@/components/dash/kit'
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
import { cn } from '@/lib/utils'

/*
 * Settings → Who may do what (manager). Each feature (take payments, start visits, vitals…) is
 * switched on or off for each role; below, an exception for one employee overrides their role
 * (allowed although the role is not, or not allowed although it is — e.g. not in charge today).
 * The database enforces it; every change is in the history.
 */
export function PermissionsCard() {
  const { t } = useTranslation()
  const { data: matrix, error: loadError } = usePermissionMatrix()
  const { data: employees = [] } = useEmployees()
  const actions = usePermissionActions()
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
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <IconChip icon={KeyRound} tint="violet" />
          {t('perms.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('perms.lead')}</p>
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
        <div className="border-border overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-hover/60 text-ink-2">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">{t('perms.feature')}</th>
                {MATRIX_ROLES.map((r) => (
                  <th key={r} className="px-2 py-2 text-center font-semibold">
                    {t(`staff.roles.${r}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MANAGED_FEATURES.map((f) => (
                <tr key={f} className="border-border border-t">
                  <td className="px-3 py-2">
                    <span className="block font-semibold">{t(`perms.f.${f}.name`)}</span>
                    <span className="text-ink-3 block text-xs">{t(`perms.f.${f}.hint`)}</span>
                  </td>
                  {MATRIX_ROLES.map((r) => {
                    const on = has(r, f)
                    return (
                      <td key={r} className="px-2 py-2 text-center">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${t(`perms.f.${f}.name`)} · ${t(`staff.roles.${r}`)}`}
                          disabled={!matrix || actions.setRole.isPending}
                          onClick={() =>
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
                          }
                          className={cn(
                            'inline-flex size-9 items-center justify-center rounded-lg border transition-colors',
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
        <p className="text-ink-3 m-0 text-xs">{t('perms.managerNote')}</p>
      </CardBody>

      {/* One employee */}
      <CardBody className="border-border gap-3 border-t">
        <h3 className="m-0 inline-flex items-center gap-2 text-[15px] font-bold">
          <UserCog size={16} aria-hidden="true" />
          {t('perms.oneTitle')}
        </h3>
        <p className="text-ink-2 m-0 text-[13px]">{t('perms.oneLead')}</p>
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
          <div className="flex flex-col gap-2">
            {MANAGED_FEATURES.map((f) => {
              const ex = exceptionOf(chosen.id, f)
              const byRole = has(chosen.role, f)
              const value = ex ? (ex.allowed ? 'yes' : 'no') : 'role'
              const effective = ex ? ex.allowed : byRole
              return (
                <div
                  key={f}
                  className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2"
                >
                  <span className="min-w-[200px] flex-1">
                    <span className="block font-semibold">{t(`perms.f.${f}.name`)}</span>
                    <span className="text-ink-3 block text-xs">
                      {t(byRole ? 'perms.roleYes' : 'perms.roleNo', {
                        role: t(`staff.roles.${chosen.role}`),
                      })}
                    </span>
                  </span>
                  <Badge tone={effective ? 'green' : 'red'}>
                    {t(effective ? 'perms.allowed' : 'perms.notAllowed')}
                  </Badge>
                  <span className="flex flex-wrap gap-1" role="radiogroup">
                    {(['role', 'yes', 'no'] as const).map((v) => (
                      <Button
                        key={v}
                        size="sm"
                        variant={value === v ? 'primary' : 'ghost'}
                        aria-checked={value === v}
                        role="radio"
                        disabled={actions.setStaff.isPending}
                        onClick={() =>
                          value !== v &&
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
                        }
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
          <div className="flex flex-col gap-1">
            <span className="text-ink-2 text-[13px] font-semibold">{t('perms.current')}</span>
            {matrix.exceptions.map((x) => (
              <span key={x.profileId + x.permission} className="text-[13px]">
                <b>{x.name}</b> · {t(`perms.f.${x.permission}.name`)}:{' '}
                <span className={x.allowed ? 'text-green' : 'text-red'}>
                  {t(x.allowed ? 'perms.allowed' : 'perms.notAllowed')}
                </span>
              </span>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
