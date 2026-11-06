import type { ReactNode } from 'react'
import { BookCheck, ListChecks } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { tableCell, tableHead, tableRow, tileClass, type Hue } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Row } from '@/components/ui/card'
import { ShownList } from '@/components/ui/list-tools'
import { SidePanel } from '@/components/ui/side-panel'
import type { PriceListPreview } from '@/lib/api/price-lists'
import { cn } from '@/lib/utils'
import { coverTone, day, errorBox, price } from './price-list-kit'

/** A titled part of the check, with a line when it is empty. */
function Part({
  title,
  hint,
  empty,
  children,
}: {
  title: string
  hint?: string | null
  empty?: string | null
  children?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-ink m-0 text-[15px] font-semibold">{title}</h3>
      {hint && <p className="text-ink-3 m-0 text-[13px]">{hint}</p>}
      {empty ? <p className="text-ink-3 m-0 text-[13px]">{empty}</p> : children}
    </section>
  )
}

/** The check (dry run): what the new list or version changes, before it is kept. */
export function PriceListPreviewPanel({
  preview: p,
  from,
  busy,
  error,
  onClose,
  onKeep,
  payers = null,
}: {
  preview: PriceListPreview
  from: string
  busy: boolean
  error: string | null
  onClose: () => void
  onKeep: () => void
  /** RSSB's list (0137): every RSSB scheme pays it ("RSSB RAMA, Mutuelle de Santé (CBHI)"). */
  payers?: string | null
}) {
  const { t } = useTranslation()
  const label = (key: string | null | undefined) =>
    p.columns.find((c) => c.key === key)?.label ?? key ?? ''
  const tiles: { label: string; value: number; hue: Hue }[] = [
    { label: t('prices.lists.tile.kept'), value: p.rows, hue: 'teal' },
    { label: t('prices.lists.tile.new'), value: p.new, hue: 'mint' },
    { label: t('prices.lists.tile.changed'), value: p.changedLines, hue: 'amber' },
    { label: t('prices.lists.tile.removed'), value: p.removed, hue: 'coral' },
    { label: t('prices.lists.tile.leftOut'), value: p.errorCount, hue: 'violet' },
    { label: t('prices.lists.tile.toLook'), value: p.warningCount, hue: 'navy' },
  ]
  const insurerChecks =
    p.checks.exceptionsOnRemoved.length +
    p.checks.ownPrices.length +
    p.checks.exceptionPrices.length
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="lavender"
      icon={ListChecks}
      className="w-[760px]"
      title={t('prices.lists.previewTitle', { name: p.name })}
      subtitle={[
        p.book.scope === 'insurer' && payers
          ? t('prices.lists.rssb.scope')
          : p.book.scope === 'insurer' && p.book.payer
            ? t('prices.lists.scopeOf', { payer: p.book.payer })
            : t(`prices.lists.scope.${p.book.scope}`),
        p.book.isNew
          ? t('prices.lists.previewNew', { list: p.book.name, publisher: p.book.publisher })
          : p.book.name,
        p.current
          ? t('prices.lists.comparedWith', { name: p.current.name, count: p.current.rows })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button type="button" variant="primary" disabled={busy || p.rows === 0} onClick={onKeep}>
            <BookCheck size={16} aria-hidden="true" />
            {t('prices.lists.keep', { date: day(from) })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-ink-2 m-0 text-[14px]">
          {t('prices.lists.keptOf', { count: p.rows, total: p.total })}{' '}
          {t('prices.lists.columnsAre', { list: p.columns.map((c) => c.label).join(', ') })}
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
          {tiles.map((x) => (
            <div
              key={x.label}
              className={cn('rounded-lg2 flex flex-col border p-3', tileClass[x.hue])}
            >
              <span className="text-ink-2 text-[13px]">{x.label}</span>
              <span className="text-ink text-[26px] leading-tight font-semibold tabular-nums">
                {formatNumber(x.value)}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}

        {(p.columnsAdded.length > 0 || p.columnsGone.length > 0) && (
          <Part title={t('prices.lists.columnsChanged')}>
            <span className="flex flex-wrap gap-1">
              {p.columnsAdded.map((c) => (
                <Badge key={`a-${c.key}`} tone="green">
                  + {c.label}
                </Badge>
              ))}
              {p.columnsGone.map((c) => (
                <Badge key={`g-${c.key}`} tone="red">
                  − {c.label}
                </Badge>
              ))}
            </span>
          </Part>
        )}

        {p.current && (
          <Part
            title={t('prices.lists.changedTitle', { count: p.changes })}
            empty={p.changed.length === 0 ? t('prices.lists.noChange') : null}
          >
            <ShownList items={p.changed} step={15} footerClassName="pt-1">
              {(rows) => (
                <div className="border-border max-h-[55vh] overflow-auto overscroll-contain rounded-md border">
                  <table className="w-full border-collapse">
                    <thead className="bg-surface sticky top-0 z-1">
                      <tr>
                        <th className={tableHead}>{t('prices.lists.colLine')}</th>
                        <th className={tableHead}>{t('prices.lists.colColumn')}</th>
                        <th className={cn(tableHead, 'text-right')}>{t('prices.lists.colOld')}</th>
                        <th className={cn(tableHead, 'text-right')}>{t('prices.lists.colNew')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={`${c.code}-${c.column}`} className={tableRow}>
                          <td className={tableCell}>
                            <span className="block font-medium">{c.name}</span>
                            <span className="text-ink-3 text-[12px]">{c.code}</span>
                          </td>
                          <td className={cn(tableCell, 'text-ink-2 text-[13px]')}>{c.label}</td>
                          <td className={cn(tableCell, 'text-ink-3 text-right tabular-nums')}>
                            {price(c.old)}
                          </td>
                          <td
                            className={cn(
                              tableCell,
                              'text-right font-semibold tabular-nums',
                              c.new != null && c.old != null && c.new > c.old
                                ? 'text-red'
                                : 'text-green',
                            )}
                          >
                            {price(c.new)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ShownList>
          </Part>
        )}

        {p.current && (
          <Part
            title={t('prices.lists.removedTitle', { count: p.removed })}
            hint={p.removed > 0 ? t('prices.lists.removedHint') : null}
            empty={p.removed === 0 ? t('prices.lists.noneRemoved') : null}
          >
            <ShownList items={p.removedLines} step={10} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={r.code} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <span className="min-w-[180px] flex-1">
                      <span className="text-ink block text-[14px] font-medium">{r.name}</span>
                      <span className="text-ink-3 text-[12px]">{r.code}</span>
                    </span>
                    {r.inClinic && <Badge tone="yellow">{t('prices.lists.atClinic')}</Badge>}
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.current && p.new > 0 && (
          <Part title={t('prices.lists.newTitle', { count: p.new })}>
            <ShownList items={p.newLines} step={10} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={r.code} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <span className="min-w-[180px] flex-1">
                      <span className="text-ink block text-[14px] font-medium">{r.name}</span>
                      <span className="text-ink-3 text-[12px]">{r.code}</span>
                    </span>
                    <span className="text-ink-2 text-[13px] tabular-nums">
                      {p.columns
                        .map((c) => `${c.label} ${price(r.prices[c.key])}`)
                        .slice(0, 3)
                        .join(' · ')}
                    </span>
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.renamed.length > 0 && (
          <Part title={t('prices.lists.renamedTitle', { count: p.renamed.length })}>
            <ShownList items={p.renamed} step={5} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={r.code} className="flex-col items-start gap-0.5 px-0 py-1.5">
                    <span className="text-ink-3 text-[12px]">{r.code}</span>
                    <span className="text-ink-3 text-[13px] line-through">{r.old}</span>
                    <span className="text-ink text-[14px] font-medium">{r.new}</span>
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.edited.length > 0 && (
          <Part
            title={t('prices.lists.editedTitle', { count: p.edited.length })}
            hint={t('prices.lists.editedHint')}
          >
            <ShownList items={p.edited} step={5} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={r.code} className="flex-wrap gap-x-2 px-0 py-1.5">
                    <span className="text-ink text-[14px] font-medium">{r.name}</span>
                    <span className="text-ink-3 text-[12px]">{r.code}</span>
                    {r.editedBy && <span className="text-ink-3 text-[12px]">· {r.editedBy}</span>}
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.errors.length > 0 && (
          <Part
            title={t('prices.lists.errorsTitle', { count: p.errorCount })}
            hint={t('prices.lists.errorsHint')}
          >
            <ShownList items={p.errors} step={10} footerClassName="pt-1">
              {(rows) =>
                rows.map((r, i) => (
                  <Row key={`${r.row}-${i}`} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <Badge tone="red">{t('prices.lists.rowN', { n: r.row })}</Badge>
                    <span className="text-ink text-[14px]">{t(`prices.lists.err.${r.code}`)}</span>
                    {(r.value || r.name) && (
                      <span className="text-ink-3 text-[13px]">
                        “{[r.value, r.name].filter(Boolean).join(' · ')}”
                      </span>
                    )}
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.warnings.length > 0 && (
          <Part
            title={t('prices.lists.warningsTitle', { count: p.warningCount })}
            hint={t('prices.lists.warningsHint')}
          >
            <ShownList items={p.warnings} step={10} footerClassName="pt-1">
              {(rows) =>
                rows.map((r, i) => (
                  <Row key={`${r.row}-${i}`} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <Badge tone="yellow">{t('prices.lists.rowN', { n: r.row })}</Badge>
                    <span className="text-ink min-w-[160px] flex-1 text-[14px]">
                      {r.name ?? r.line}
                      <span className="text-ink-3 block text-[12px]">
                        {[r.line, r.column ? label(r.column) : null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-ink-2 text-[13px]">
                      {t(`prices.lists.warn.${r.code}`, { value: r.value ?? '' })}
                    </span>
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.book.scope === 'clinic' && p.book.kind === 'treatments' && (
          <Part
            title={t('prices.lists.toCreateTitle', { count: p.clinic.toCreate })}
            hint={t('prices.lists.toCreateHint')}
            empty={p.clinic.toCreate === 0 ? t('prices.lists.toCreateNone') : null}
          >
            <span className="flex flex-wrap gap-1">
              {p.clinic.toCreateByCategory.map((c) => (
                <Badge key={c.category} tone="green">
                  {c.category} · {formatNumber(c.count)}
                </Badge>
              ))}
            </span>
          </Part>
        )}

        {p.book.scope === 'clinic' && p.clinic.ownPriceCount > 0 && (
          <Part
            title={t('prices.lists.ownPricesTitle', { count: p.clinic.ownPriceCount })}
            hint={t('prices.lists.ownPricesHint')}
          >
            <ShownList items={p.clinic.ownPrices} step={8} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={r.id} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <span className="min-w-[180px] flex-1">
                      <span className="text-ink block text-[14px] font-medium">{r.name}</span>
                      <span className="text-ink-3 text-[12px]">{r.code}</span>
                    </span>
                    <span className="text-ink-2 text-[13px] tabular-nums">
                      {t('prices.lists.ownVsList', { own: price(r.own), list: price(r.list) })}
                    </span>
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}

        {p.book.scope === 'insurer' && p.book.payer && (
          <Part
            title={t('prices.lists.insurerOwnTitle', { payer: payers ?? p.book.payer })}
            hint={t('prices.lists.insurerOwnHint', {
              payer: payers ?? p.book.payer,
              column: label(p.book.payerColumn),
            })}
          />
        )}

        {(p.names.byList > 0 || p.names.byClinic > 0 || p.names.notFoundCount > 0) && (
          <Part
            title={t('prices.lists.namesTitle')}
            hint={t('prices.lists.namesHint', {
              list: p.names.byList,
              clinic: p.names.byClinic,
              none: p.names.notFoundCount,
            })}
          >
            {p.names.notFound.length > 0 && (
              <ShownList items={p.names.notFound} step={8} footerClassName="pt-1">
                {(rows) =>
                  rows.map((r) => (
                    <Row key={r.code} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                      <Badge tone="yellow">{t('prices.lists.rowN', { n: r.row })}</Badge>
                      <span className="text-ink min-w-[160px] flex-1 text-[14px]">{r.name}</span>
                      <span className="text-ink-3 text-[12px]">{r.code}</span>
                    </Row>
                  ))
                }
              </ShownList>
            )}
          </Part>
        )}

        <Part
          title={t(
            p.book.kind === 'medicines'
              ? 'prices.lists.clinicMeds'
              : 'prices.lists.clinicTreatments',
          )}
          hint={t('prices.lists.clinicHint', {
            code: p.clinic.byCode.length,
            name: p.clinic.byName.length,
          })}
        >
          {p.clinic.byName.length > 0 && (
            <>
              <span className="text-ink-2 text-[13px] font-semibold">
                {t('prices.lists.byNameTitle')}
              </span>
              <ShownList items={p.clinic.byName} step={8} footerClassName="pt-1">
                {(rows) =>
                  rows.map((r) => (
                    <Row key={r.id} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                      <span className="text-ink text-[14px] font-medium">{r.clinicName}</span>
                      <span className="text-ink-3 text-[13px]">→ {r.code}</span>
                    </Row>
                  ))
                }
              </ShownList>
            </>
          )}
          {p.clinic.byCode.length > 0 && (
            <ShownList items={p.clinic.byCode} step={8} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={`${r.id}-${r.code}`} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <span className="text-ink text-[14px]">{r.clinicName}</span>
                    <span className="text-ink-3 text-[13px]">{r.code}</span>
                    {r.active === false && <Badge tone="grey">{t('prices.lists.hidden')}</Badge>}
                  </Row>
                ))
              }
            </ShownList>
          )}
          {p.clinic.gone.length > 0 && (
            <>
              <span className="text-red text-[13px] font-semibold">
                {t('prices.lists.goneTitle', { count: p.clinic.gone.length })}
              </span>
              {p.clinic.gone.slice(0, 20).map((r) => (
                <span key={r.id} className="text-ink-2 text-[13px]">
                  {r.clinicName} · {r.code}
                </span>
              ))}
            </>
          )}
        </Part>

        {!p.book.isNew && (
          <Part
            title={t('prices.lists.insurersTitle')}
            empty={p.followers.length === 0 ? t('prices.lists.noFollower') : null}
          >
            <span className="flex flex-wrap gap-1">
              {p.followers.map((f) => (
                <Badge key={f.payerId} tone={f.found ? 'blue' : 'red'}>
                  {f.payer} ·{' '}
                  {f.found ? f.label : t('prices.lists.columnGone', { column: f.column })}
                </Badge>
              ))}
            </span>
            {insurerChecks === 0 ? (
              p.followers.length > 0 && (
                <p className="text-ink-3 m-0 text-[13px]">{t('prices.lists.noInsurerCheck')}</p>
              )
            ) : (
              <div className="flex flex-col gap-1">
                {p.checks.ownPrices.map((c, i) => (
                  <span key={`o-${i}`} className="text-ink-2 text-[13px]">
                    {t('prices.lists.ownDiffers', {
                      payer: c.payer,
                      name: c.name,
                      own: price(c.own),
                      list: price(c.list),
                    })}
                  </span>
                ))}
                {p.checks.exceptionPrices.map((c, i) => (
                  <span key={`e-${i}`} className="text-ink-2 text-[13px]">
                    {t('prices.lists.exceptionDiffers', {
                      payer: c.payer,
                      name: c.name,
                      own: price(c.own),
                      list: price(c.list),
                    })}
                  </span>
                ))}
                {p.checks.exceptionsOnRemoved.map((c, i) => (
                  <span key={`r-${i}`} className="text-red text-[13px]">
                    {t('prices.lists.exceptionGone', { payer: c.payer, name: c.name })}
                  </span>
                ))}
              </div>
            )}
          </Part>
        )}

        {p.instructions && (
          <Part
            title={t('prices.lists.instructionsTitle', { payer: p.instructions.payer })}
            hint={t('prices.lists.instructionsHint', {
              notCovered: p.instructions.notCovered,
              preauth: p.instructions.preauth,
              notes: p.instructions.notes,
            })}
          >
            {p.instructions.keptTyped > 0 && (
              <p className="text-ink-2 m-0 text-[13px]">
                {t('prices.lists.keptTyped', { count: p.instructions.keptTyped })}
              </p>
            )}
            {p.instructions.dropped > 0 && (
              <p className="text-ink-2 m-0 text-[13px]">
                {t('prices.lists.dropped', { count: p.instructions.dropped })}
              </p>
            )}
            {!p.instructions.follows && (
              <p className="text-amber m-0 text-[13px] font-medium">
                {t('prices.lists.notFollowing', { payer: p.instructions.payer })}
              </p>
            )}
            <ShownList items={p.instructions.lines} step={10} footerClassName="pt-1">
              {(rows) =>
                rows.map((r) => (
                  <Row key={r.code} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <span className="min-w-[180px] flex-1">
                      <span className="text-ink block text-[14px] font-medium">{r.name}</span>
                      <span className="text-ink-3 text-[12px]">
                        {r.code} · “{r.note}”
                      </span>
                    </span>
                    {r.typed ? (
                      <Badge tone="grey">{t('prices.lists.typedKept')}</Badge>
                    ) : (
                      <Badge tone={coverTone(r.cover)}>{t(`prices.lists.cover.${r.cover}`)}</Badge>
                    )}
                  </Row>
                ))
              }
            </ShownList>
          </Part>
        )}
      </div>
    </SidePanel>
  )
}
