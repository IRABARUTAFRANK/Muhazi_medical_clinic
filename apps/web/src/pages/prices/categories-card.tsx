import { useState, type FormEvent } from 'react'
import {
  FlaskConical,
  Lock,
  Pencil,
  Plus,
  ScanLine,
  Stethoscope,
  Tags,
  Trash2,
  BedDouble,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import {
  categoryName,
  useCategories,
  useCategoryActions,
  type Category,
  type CategoryKind,
  type Treatment,
} from '@/lib/api/catalogue'
import { suggestNames } from '@/lib/medical-glossary'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
const KIND_ICON = { treatment: Stethoscope, lab: FlaskConical, imaging: ScanLine, bed: BedDouble }
/** Kinds the manager may choose; bed stays have their own built-in category. */
const CHOOSABLE: CategoryKind[] = ['treatment', 'lab', 'imaging']

/**
 * The clinic's own categories of treatments (Prices → Categories): create, rename, change the
 * kind, delete when empty. The kind decides how the treatments work: charged on the visit, or
 * ordered as a laboratory / ultrasound test with a result. The bed category is built in.
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

  const remove = async (c: Category) => {
    if (!window.confirm(t('prices.cat.confirmDelete', { name: c.nameEn }))) return
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
        const Icon = KIND_ICON[c.kind]
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
            <span className="min-w-[180px] flex-1">
              <span className="block font-semibold">{categoryName(c, i18n.language)}</span>
              <span className="text-ink-3 text-xs">
                {[
                  c.kind === 'treatment' ? t('prices.cat.kinds.treatment') : null,
                  t('prices.cat.count', { count: n }),
                  c.baseGroup ? t('prices.cat.builtIn') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            {c.kind !== 'treatment' && <Chip>{t(`prices.cat.kinds.${c.kind}`)}</Chip>}
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
  /** Treatments in it (a kind change affects them). */
  used: number
  onCancel: () => void
  onSaved: (name: string) => void
}) {
  const { t } = useTranslation()
  const actions = useCategoryActions()
  const [nameEn, setNameEn] = useState(category?.nameEn ?? '')
  const [nameKin, setNameKin] = useState(category?.nameKin ?? '')
  const [nameFr, setNameFr] = useState(category?.nameFr ?? '')
  const [touched, setTouched] = useState({ kin: !!category, fr: !!category })
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? 'treatment')
  const [error, setError] = useState<string | null>(null)

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
    try {
      await actions.save.mutateAsync({ id: category?.id, nameEn, nameKin, nameFr, kind })
      onSaved(nameEn.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        <Select
          label={t('prices.cat.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as CategoryKind)}
        >
          {CHOOSABLE.map((k) => (
            <option key={k} value={k}>
              {t(`prices.cat.kindsLong.${k}`)}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-ink-3 m-0 text-xs">{t(`prices.cat.kindHint.${kind}`)}</p>
      {category && kind !== category.kind && used > 0 && (
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
