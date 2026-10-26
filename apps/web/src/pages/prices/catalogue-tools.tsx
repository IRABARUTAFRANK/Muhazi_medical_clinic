import { useState } from 'react'
import { ArrowRightLeft, ListPlus, Trash2, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import {
  builtInGroup,
  categoryName,
  groupOfCategory,
  useCatalogueTools,
  useCategories,
} from '@/lib/api/catalogue'
import type { Department } from '@/lib/api/staff'
import { suggestNames } from '@/lib/medical-glossary'
import { useConfirm } from '@/lib/confirm'

const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'

/**
 * Manager tools for the catalogue: add many treatments to a department at once (one per line,
 * "Name | price"), move every treatment of a type into a department, or start over.
 */
export function CatalogueTools({
  departments,
  onDone,
  onClose,
}: {
  departments: Department[]
  onDone: (text: string) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const tools = useCatalogueTools()
  const ask = useConfirm()
  const deptName = (id: string) =>
    departments.find((d) => d.id === id)?.name ?? t('prices.dept.none')
  const [dept, setDept] = useState(departments[0]?.id ?? '')
  const { data: categories = [] } = useCategories()
  const [categoryId, setCategoryId] = useState('')
  const category =
    categories.find((c) => c.id === categoryId) ??
    categories.find((c) => c.baseGroup === 'consultation') ??
    categories[0]
  const [lines, setLines] = useState('')
  const [moveCat, setMoveCat] = useState('')
  const moveCategory = categories.find((c) => c.id === moveCat) ?? categories[0]
  const [moveDept, setMoveDept] = useState(departments[0]?.id ?? '')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const parsed = lines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, price] = l.split(/\s*[|;]\s*|\s+-\s+/)
      const s = suggestNames(name ?? '')
      return {
        name_en: (name ?? '').trim(),
        name_kin: s?.rw ?? '',
        name_fr: s?.fr ?? '',
        price: Number(String(price ?? '').replace(/[^\d]/g, '')) || 0,
        group: category ? groupOfCategory(category) : ('other' as const),
        category: category && !builtInGroup(category.id) ? category.id : undefined,
      }
    })
    .filter((x) => x.name_en.length >= 2)

  const run = async (fn: () => Promise<string>) => {
    setError(null)
    try {
      onDone(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="border-primary">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Wrench size={16} aria-hidden="true" />
          {t('prices.tools.title')}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      </CardHeader>
      <CardBody className="gap-5">
        {/* Add many */}
        <section className="flex flex-col gap-3">
          <h4 className="m-0 inline-flex items-center gap-2 text-[16px] font-semibold">
            <ListPlus size={16} aria-hidden="true" />
            {t('prices.tools.bulkTitle')}
          </h4>
          <p className="text-ink-2 m-0 text-[14px]">{t('prices.tools.bulkLead')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label={t('prices.dept.field')}
              value={dept}
              onChange={(e) => setDept(e.target.value)}
            >
              <option value="">{t('prices.dept.none')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Select
              label={t('prices.form.group')}
              value={category?.id ?? ''}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories
                .filter((c) => c.kind !== 'bed')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryName(c, i18n.language)}
                  </option>
                ))}
            </Select>
          </div>
          <label className="flex flex-col gap-1.5 text-[14px] font-semibold">
            {t('prices.tools.lines')}
            <textarea
              value={lines}
              onChange={(e) => setLines(e.target.value)}
              rows={6}
              placeholder={t('prices.tools.linesPh')}
              className="border-border bg-card text-ink focus:border-primary focus:ring-primary-tint rounded-md border px-3 py-2 font-mono text-[14px] font-normal outline-none focus:ring-[3px]"
            />
          </label>
          {parsed.length > 0 && (
            <ul className="text-ink-2 m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
              {parsed.slice(0, 8).map((x, i) => (
                <li key={i}>
                  <b className="text-ink">{x.name_en}</b> · RWF {x.price.toLocaleString()}
                  {x.name_kin ? ` · ${x.name_kin}` : ''}
                  {x.name_fr ? ` · ${x.name_fr}` : ''}
                </li>
              ))}
              {parsed.length > 8 && (
                <li>… {t('prices.tools.more', { count: parsed.length - 8 })}</li>
              )}
            </ul>
          )}
          <Button
            variant="primary"
            className="self-start"
            disabled={parsed.length === 0}
            loading={tools.bulkAdd.isPending}
            onClick={async () => {
              if (
                !(await ask({
                  title: t('confirm.prices.bulkAddTitle', {
                    count: parsed.length,
                    dept: deptName(dept),
                  }),
                  confirmLabel: t('confirm.prices.bulkAddYes'),
                }))
              )
                return
              void run(async () => {
                const n = await tools.bulkAdd.mutateAsync({
                  departmentId: dept || null,
                  items: parsed,
                })
                setLines('')
                return t('prices.tools.bulkDone', { count: n })
              })
            }}
          >
            <ListPlus size={16} aria-hidden="true" />
            {t('prices.tools.bulkAdd', { count: parsed.length })}
          </Button>
        </section>

        {/* Move a type */}
        <section className="border-border flex flex-col gap-3 border-t pt-4">
          <h4 className="m-0 inline-flex items-center gap-2 text-[16px] font-semibold">
            <ArrowRightLeft size={16} aria-hidden="true" />
            {t('prices.tools.moveTitle')}
          </h4>
          <p className="text-ink-2 m-0 text-[14px]">{t('prices.tools.moveLead')}</p>
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Select
              label={t('prices.form.group')}
              value={moveCategory?.id ?? ''}
              onChange={(e) => setMoveCat(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryName(c, i18n.language)}
                </option>
              ))}
            </Select>
            <Select
              label={t('prices.dept.field')}
              value={moveDept}
              onChange={(e) => setMoveDept(e.target.value)}
            >
              <option value="">{t('prices.dept.none')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Button
              loading={tools.moveCategory.isPending}
              disabled={!moveCategory}
              onClick={async () => {
                if (
                  !(await ask({
                    title: t('confirm.prices.moveTitle', {
                      category: categoryName(moveCategory!, i18n.language),
                      dept: deptName(moveDept),
                    }),
                    confirmLabel: t('confirm.prices.moveYes'),
                  }))
                )
                  return
                void run(async () => {
                  const n = await tools.moveCategory.mutateAsync({
                    categoryId: moveCategory!.id,
                    departmentId: moveDept || null,
                  })
                  return t('prices.tools.moveDone', { count: n })
                })
              }}
            >
              {t('prices.tools.move')}
            </Button>
          </div>
        </section>

        {/* Start over */}
        <section className="border-red/30 bg-red-bg/40 flex flex-col gap-3 rounded-md border p-3">
          <h4 className="text-red m-0 inline-flex items-center gap-2 text-[16px] font-semibold">
            <Trash2 size={16} aria-hidden="true" />
            {t('prices.tools.resetTitle')}
          </h4>
          <p className="text-ink-2 m-0 text-[14px]">{t('prices.tools.resetLead')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label={t('prices.tools.typeDelete')}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="DELETE"
              wrapperClassName="w-48"
            />
            <Button
              variant="danger"
              disabled={confirm !== 'DELETE'}
              loading={tools.deleteAll.isPending}
              onClick={() =>
                void run(async () => {
                  const n = await tools.deleteAll.mutateAsync()
                  setConfirm('')
                  return t('prices.tools.resetDone', { count: n })
                })
              }
            >
              <Trash2 size={16} aria-hidden="true" />
              {t('prices.tools.reset')}
            </Button>
          </div>
        </section>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
      </CardBody>
    </Card>
  )
}
