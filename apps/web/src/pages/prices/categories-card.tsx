import { useState, type FormEvent } from 'react'
import {
  BedDouble,
  FlaskConical,
  Lock,
  Pencil,
  Plus,
  Receipt,
  Send,
  Tags,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import {
  ORDER_DESKS,
  categoryName,
  handlingLabel,
  useCategories,
  useCategoryActions,
  type Category,
  type OrderDesk,
  type Treatment,
} from '@/lib/api/catalogue'
import { suggestNames } from '@/lib/medical-glossary'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/*
 * The clinic's own categories of treatments (Prices → Categories): create, rename, delete when
 * empty, and say how their treatments are handled — charged on the visit, or ordered by the
 * doctor and done at a desk the manager chooses (the patient is sent there, the desk writes the
 * result, the patient comes back to the doctor). The bed category is built in.
 */
export function CategoriesCard({
  treatments,
  onDone,
  onClose,
}: {
  treatments: Treatment[]
  onDone: (text: string) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const { data: categories = [] } = useCategories()
  const actions = useCategoryActions()
  const [editing, setEditing] = useState<Category | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const count = (c: Category) => treatments.filter((x) => x.categoryId === c.id).length
  const confirm = useConfirm()

  const remove = async (c: Category) => {
    if (
      !(await confirm({
        title: t('prices.cat.confirmDelete', { name: categoryName(c, i18n.language) }),
        body: t('confirm.prices.deleteCategoryBody'),
        confirmLabel: t('confirm.prices.deleteYes'),
        tone: 'danger',
      }))
    )
      return
    setError(null)
    try {
      await actions.remove.mutateAsync(c.id)
      onDone(t('prices.cat.deleted', { name: c.nameEn }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="border-primary">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Tags size={16} aria-hidden="true" />
          {t('prices.cat.title')}
        </span>
        <span className="flex gap-1">
          {editing === null && (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              <Plus size={14} aria-hidden="true" />
              {t('prices.cat.new')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      </CardHeader>
      <CardBody className="gap-2">
        <p className="text-ink-2 m-0 text-[13px]">{t('prices.cat.lead')}</p>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        {editing === 'new' && (
          <CategoryForm
            category={null}
            used={0}
            onCancel={() => setEditing(null)}
            onSaved={(name) => {
              setEditing(null)
              onDone(t('prices.cat.saved', { name }))
            }}
          />
        )}
      </CardBody>
      {categories.map((c) => {
        const n = count(c)
        const Icon = c.kind === 'bed' ? BedDouble : c.orderStation ? FlaskConical : Receipt
        if (editing !== 'new' && editing?.id === c.id)
          return (
            <CardBody key={c.id} className="border-border border-t">
              <CategoryForm
                category={c}
                used={n}
                onCancel={() => setEditing(null)}
                onSaved={(name) => {
                  setEditing(null)
                  onDone(t('prices.cat.saved', { name }))
                }}
              />
            </CardBody>
          )
        return (
          <Row key={c.id} className="flex-wrap gap-x-3 gap-y-1 py-2">
            <Icon size={16} aria-hidden="true" className="text-primary flex-none" />
            <span className="min-w-45 flex-1">
              <span className="block font-semibold">{categoryName(c, i18n.language)}</span>
              <span className="text-ink-3 text-xs">
                {[t('prices.cat.count', { count: n }), c.baseGroup ? t('prices.cat.builtIn') : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <Chip>{handlingLabel(c, t)}</Chip>
            {c.kind === 'bed' ? (
              <span
                className="text-ink-3 inline-flex items-center gap-1 text-xs"
                title={t('prices.cat.bedLocked')}
              >
                <Lock size={13} aria-hidden="true" />
                {t('prices.cat.bedLocked')}
              </span>
            ) : (
              <>
                <Button size="sm" onClick={() => setEditing(c)}>
                  <Pencil size={14} aria-hidden="true" />
                  {t('prices.cat.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={n > 0 || actions.remove.isPending}
                  title={n > 0 ? t('prices.cat.deleteBlocked') : t('prices.cat.delete')}
                  aria-label={t('prices.cat.delete')}
                  onClick={() => void remove(c)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </>
            )}
          </Row>
        )
      })}
    </Card>
  )
}

function CategoryForm({
  category,
  used,
  onCancel,
  onSaved,
}: {
  category: Category | null
  /** Treatments in it (a change of handling affects them). */
  used: number
  onCancel: () => void
  onSaved: (name: string) => void
}) {
  const { t } = useTranslation()
  const actions = useCategoryActions()
  const confirm = useConfirm()
  const [nameEn, setNameEn] = useState(category?.nameEn ?? '')
  const [nameKin, setNameKin] = useState(category?.nameKin ?? '')
  const [nameFr, setNameFr] = useState(category?.nameFr ?? '')
  const [touched, setTouched] = useState({ kin: !!category, fr: !!category })
  const [ordered, setOrdered] = useState(!!category?.orderStation)
  const [desk, setDesk] = useState<OrderDesk>(
    (category?.orderStation as OrderDesk | null) ?? 'laboratory',
  )
  const [error, setError] = useState<string | null>(null)
  const changed =
    !!category && (ordered ? desk : null) !== (category.orderStation ?? null) && used > 0

  const onEnglish = (v: string) => {
    setNameEn(v)
    const s = suggestNames(v)
    if (!touched.kin) setNameKin(s?.rw ?? '')
    if (!touched.fr) setNameFr(s?.fr ?? '')
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (nameEn.trim().length < 2) return setError(t('prices.cat.errors.name'))
    if (
      !(await confirm({
        title: t(
          category ? 'confirm.prices.saveCategoryTitle' : 'confirm.prices.addCategoryTitle',
          {
            name: nameEn.trim(),
          },
        ),
        body: changed ? t('prices.cat.kindChange', { count: used }) : undefined,
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    try {
      await actions.save.mutateAsync({
        id: category?.id,
        nameEn,
        nameKin,
        nameFr,
        orderStation: ordered ? desk : null,
      })
      onSaved(nameEn.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const choice = (
    on: boolean,
    value: boolean,
    icon: React.ReactNode,
    title: string,
    hint: string,
  ) => (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => setOrdered(value)}
      className={cn(
        'flex min-w-0 flex-1 items-start gap-2.5 rounded-xl border p-3 text-left',
        on ? 'border-primary bg-primary/5 ring-primary/30 ring-2' : 'border-border hover:bg-hover',
      )}
    >
      <span className={cn('mt-0.5 flex-none', on ? 'text-primary' : 'text-ink-3')}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-bold">{title}</span>
        <span className="text-ink-2 block text-[13px]">{hint}</span>
      </span>
    </button>
  )

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label={t('prices.cat.nameEn')}
          value={nameEn}
          onChange={(e) => onEnglish(e.target.value)}
          autoFocus
          required
        />
        <Field
          label={t('prices.cat.nameKin')}
          value={nameKin}
          onChange={(e) => {
            setTouched((x) => ({ ...x, kin: true }))
            setNameKin(e.target.value)
          }}
        />
        <Field
          label={t('prices.cat.nameFr')}
          value={nameFr}
          onChange={(e) => {
            setTouched((x) => ({ ...x, fr: true }))
            setNameFr(e.target.value)
          }}
        />
      </div>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="text-ink-2 mb-1 text-[13px] font-semibold">{t('prices.cat.how')}</legend>
        <div className="flex flex-col gap-2 sm:flex-row" role="radiogroup">
          {choice(
            !ordered,
            false,
            <Receipt size={18} aria-hidden="true" />,
            t('prices.cat.charged'),
            t('prices.cat.chargedHint'),
          )}
          {choice(
            ordered,
            true,
            <Send size={18} aria-hidden="true" />,
            t('prices.cat.ordered'),
            t('prices.cat.orderedHint'),
          )}
        </div>
        {ordered && (
          <Select
            label={t('prices.cat.desk')}
            value={desk}
            onChange={(e) => setDesk(e.target.value as OrderDesk)}
            wrapperClassName="sm:max-w-sm"
          >
            {ORDER_DESKS.map((d) => (
              <option key={d} value={d}>
                {t(`register.stations.${d}`)}
              </option>
            ))}
          </Select>
        )}
        {ordered && (
          <p className="text-ink-3 m-0 text-xs">
            {t('prices.cat.deskHint', { desk: t(`register.stations.${desk}`) })}
          </p>
        )}
      </fieldset>
      {changed && (
        <p className="bg-amber-bg text-amber m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
          {t('prices.cat.kindChange', { count: used })}
        </p>
      )}
      {error && (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      )}
      <span className="flex gap-2">
        <Button type="submit" variant="primary" loading={actions.save.isPending}>
          {t('prices.cat.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('prices.cat.cancel')}
        </Button>
      </span>
    </form>
  )
}
