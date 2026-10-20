import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Calendar,
  CalendarDays,
  Clock,
  FlaskConical,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import {
  CATEGORY_FILTERS,
  CLINIC,
  CLINIC_HOURS,
  CLINIC_PROFILE,
  FEATURES,
  LANGS,
  formatPhone,
  hoursRows,
  isOpen247,
  startOfDay,
  telHref,
  whatsappHref,
} from '@mmc/shared'
import { ScheduleBoard } from '@/components/calendar/schedule-board'
import { buttonVariants } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { SiteFooter } from '@/components/public/site-footer'
import { SiteNav, Wrap } from '@/components/public/site-nav'
import {
  bookedFor,
  useBookedSlots,
  useClinicInfo,
  useClinicStatus,
  usePayers,
  usePractitioners,
  useServiceLines,
  type ClinicStatus,
} from '@/lib/api/public'
import { appNow } from '@/lib/clock'
import { useCountUp, useReveal } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { HeroWave, PhoneIllustration } from './hero-art'
import { RequestForm } from './request-form'
import { SignInCard } from './sign-in-card'

const h2 = 'm-0 mb-2 text-3xl leading-[1.15] font-bold tracking-[-0.015em] text-[var(--brand-navy)]'
const lead = 'm-0 max-w-[640px] text-base text-ink-2'

export function LandingPage() {
  const { t } = useTranslation()
  const rootRef = useReveal<HTMLDivElement>()
  const now = appNow()

  const { data: practitioners = [] } = usePractitioners()
  const { data: lines = [] } = useServiceLines()
  const { data: payers = [] } = usePayers()
  const { data: info } = useClinicInfo()
  const profile = info?.profile ?? CLINIC_PROFILE
  const hours = info?.hours ?? CLINIC_HOURS
  const { data: booked } = useBookedSlots(startOfDay(now), 14)
  const { data: status } = useClinicStatus(hours)

  const activeLines = lines
  const weekdaySpan = hours.days['1']
  const hoursLabel = isOpen247(hours)
    ? '24/7'
    : weekdaySpan
      ? `${weekdaySpan[0]}–${weekdaySpan[1]}`
      : '—'

  return (
    <div
      ref={rootRef}
      className="theme-public bg-card text-ink flex min-h-dvh flex-col text-base leading-normal"
    >
      <SiteNav current="landing" />
      <Hero
        status={status}
        phone={profile.phone}
        hoursLabel={hoursLabel}
        serviceLines={activeLines.length}
        insurers={payers.length}
      />

      {/* FIND A DOCTOR */}
      <section id="doctors" className="doctors-gradient scroll-mt-[56px] py-[72px]">
        <Wrap className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-6" data-reveal>
            <div className="min-w-[280px] flex-1">
              <span className="eyebrow">{t('nav.findDoctor')}</span>
              <h2 className={h2}>{t('landing.doctors.title')}</h2>
              <p className={lead}>{t('landing.doctors.lead')}</p>
            </div>
            <Link to="/book" className={buttonVariants({ variant: 'primary', size: 'lg' })}>
              {t('landing.doctors.openCalendar')}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <div className="flex flex-wrap gap-2" data-reveal data-delay="1">
            {CATEGORY_FILTERS.map((c) => (
              <Link
                key={c}
                to="/book"
                search={{ category: c === 'all' ? undefined : c }}
                className="border-border bg-card text-ink-2 hover:border-primary hover:bg-primary-tint hover:text-primary inline-flex min-h-10 items-center rounded-full border px-3.5 text-[13px] font-semibold no-underline transition-colors"
              >
                {t(`categories.${c}`)}
              </Link>
            ))}
          </div>
          <div className="card-glow bg-card rounded-2xl p-4 sm:p-5" data-reveal data-delay="2">
            {practitioners.length === 0 ? (
              <p className="text-ink-2 m-0 flex items-center gap-3 py-4 text-[15px]">
                <CalendarDays size={22} aria-hidden="true" className="text-primary flex-none" />
                {t('landing.doctors.noneYet', { phone: profile.phone })}
              </p>
            ) : (
              <ScheduleBoard
                variant="public"
                now={now}
                bookedFor={(p) => bookedFor(booked, p)}
                doctors={practitioners.map((p) => ({ p }))}
                action={({ p }) => (
                  <Link
                    to="/book"
                    search={{ category: p.cats[0] }}
                    className={buttonVariants({ variant: 'primary', size: 'sm' })}
                  >
                    {t('landing.doctors.book')}
                  </Link>
                )}
              />
            )}
          </div>
        </Wrap>
      </section>

      {/* SERVICES */}
      <section id="services" className="soft-gradient scroll-mt-[56px] py-[72px]">
        <Wrap className="flex flex-col gap-8">
          <div data-reveal>
            <span className="eyebrow">{t('nav.services')}</span>
            <h2 className={h2}>{t('landing.services.title')}</h2>
            <p className={lead}>{t('landing.services.lead')}</p>
          </div>
          <div className="pc:grid-cols-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {lines.map((s, i) => (
              <Link
                key={s.id}
                to="/book"
                search={{ category: s.id }}
                data-reveal
                data-delay={String(i % 4)}
                className="card-glow bg-card text-ink flex min-w-0 items-start gap-4 rounded-2xl p-5 no-underline"
              >
                <span className="icon-gradient inline-flex size-12 flex-none items-center justify-center rounded-xl text-white">
                  <Icon name={s.icon} size={22} />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <h3 className="m-0 text-base font-bold">{t(`services.${s.id}.name`)}</h3>
                  <p className="text-ink-2 m-0 text-sm">{t(`services.${s.id}.desc`)}</p>
                  {/* Prices are not published; the clinic gives them at reception. */}
                  <span className="text-primary text-[13px] font-semibold">
                    {t('landing.services.book')} →
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </Wrap>
      </section>

      {/* HOW TO BOOK */}
      <section id="book" className="bg-card scroll-mt-[56px] py-[72px]">
        <Wrap className="pc:grid-cols-2 grid items-start gap-12">
          <div className="flex flex-col gap-6" data-reveal>
            <PhoneIllustration />
            <div>
              <span className="eyebrow">{t('nav.book')}</span>
              <h2 className={h2}>{t('landing.book.title')}</h2>
              <p className={lead}>{t('landing.book.lead')}</p>
            </div>
            <Step n={1} title={t('landing.book.step1Title')} body={t('landing.book.step1')} />
            <Step n={2} title={t('landing.book.step2Title')} body={t('landing.book.step2')} />
            <Step n={3} title={t('landing.book.step3Title')} body={t('landing.book.step3')} />
          </div>
          <div data-reveal data-delay="1">
            <RequestForm />
          </div>
        </Wrap>
      </section>

      {/* INSURANCE */}
      <section
        id="insurance"
        className="band-gradient relative scroll-mt-[56px] overflow-hidden py-16 text-white"
      >
        <div
          aria-hidden="true"
          className="blob anim-drift-2 -top-32 right-[-6%] size-[420px] bg-[#39A9DF]"
        />
        <div
          aria-hidden="true"
          className="blob anim-drift -bottom-40 left-[-4%] size-[360px] bg-[#6CCB5F]"
        />
        <Wrap className="relative flex flex-col gap-8">
          {FEATURES.insurance && payers.length > 0 ? (
            <>
              <div data-reveal>
                <span className="eyebrow !text-[#9FE39A]">{t('nav.insurance')}</span>
                <h2 className={cn(h2, 'text-white')}>{t('landing.insurance.title')}</h2>
                <p className={cn(lead, 'text-white/80')}>{t('landing.insurance.lead')}</p>
              </div>
              <div className="marquee" data-reveal data-delay="1">
                <div className="marquee-track">
                  {[...payers, ...payers].map((name, i) => (
                    <span
                      key={`${name}-${i}`}
                      className="glass inline-flex min-h-12 items-center gap-2.5 rounded-full px-5 text-sm font-semibold whitespace-nowrap"
                      aria-hidden={i >= payers.length}
                    >
                      <ShieldCheck size={16} className="text-[#7BD36A]" aria-hidden="true" />
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-4" data-reveal>
              <span className="eyebrow !text-[#9FE39A]">{t('nav.insurance')}</span>
              <span className="glass inline-flex w-fit items-center gap-2 rounded-full px-4 py-1.5 text-[13px] font-semibold">
                <ShieldCheck size={16} className="text-[#7BD36A]" aria-hidden="true" />
                {t('landing.insurance.soonPill')}
              </span>
              <h2 className={cn(h2, 'text-white')}>{t('landing.insurance.soonTitle')}</h2>
              <p className={cn(lead, 'text-white/80')}>{t('landing.insurance.soonLead')}</p>
            </div>
          )}
        </Wrap>
      </section>

      {/* HOURS & LOCATION */}
      <section id="visit" className="soft-gradient scroll-mt-[56px] py-[72px]">
        <Wrap className="flex flex-col gap-8">
          <div data-reveal>
            <span className="eyebrow">{t('nav.visit')}</span>
            <h2 className={h2}>{t('landing.visit.mapTitle')}</h2>
            <p className={lead}>
              {profile.sector}, {profile.district} · {profile.province}, {profile.country}
            </p>
          </div>
          <div className="pc:grid-cols-[1fr_1fr_1.3fr] grid grid-cols-1 gap-4">
            <div className="card-glow bg-card flex flex-col gap-3 rounded-2xl p-6" data-reveal>
              <span className="icon-gradient inline-flex size-11 items-center justify-center rounded-xl text-white">
                <Clock size={22} aria-hidden="true" />
              </span>
              <h3 className="m-0 text-lg font-bold">{t('landing.visit.hours')}</h3>
              <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[15px] tabular-nums">
                {hoursRows(hours).map((h) => (
                  <HoursRow
                    key={h.key}
                    label={t(`landing.visit.${h.key}`)}
                    time={h.allDay ? t('landing.visit.allDay') : h.time}
                  />
                ))}
              </div>
              <StatusPill status={status} />
            </div>
            <div
              className="card-glow bg-card flex flex-col gap-3 rounded-2xl p-6"
              data-reveal
              data-delay="1"
            >
              <span className="icon-gradient inline-flex size-11 items-center justify-center rounded-xl text-white">
                <MapPin size={22} aria-hidden="true" />
              </span>
              <h3 className="m-0 text-lg font-bold">{t('landing.visit.findUs')}</h3>
              <p className="text-ink-2 m-0 text-[15px]">
                {profile.name}
                <br />
                {profile.sector}, {profile.district}
                <br />
                {profile.province}, {profile.country}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[15px]">
                <li>
                  <a
                    href={telHref(profile.phone)}
                    className="inline-flex items-center gap-2 font-semibold no-underline hover:underline"
                  >
                    <Phone size={16} aria-hidden="true" /> {formatPhone(profile.phone)}
                  </a>
                </li>
                <li>
                  <a
                    href={whatsappHref(profile.whatsapp)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 font-semibold no-underline hover:underline"
                  >
                    <MessageCircle size={16} aria-hidden="true" /> {t('landing.visit.whatsappUs')} ·{' '}
                    {formatPhone(profile.whatsapp)}
                  </a>
                </li>
                <li>
                  <a
                    href={`mailto:${profile.email}`}
                    className="inline-flex items-center gap-2 font-semibold break-all no-underline hover:underline"
                  >
                    <Mail size={16} aria-hidden="true" /> {profile.email}
                  </a>
                </li>
              </ul>
              <a
                href={CLINIC.mapsUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ variant: 'default', size: 'md' }),
                  'mt-auto self-start',
                )}
              >
                <MapPin size={18} aria-hidden="true" />
                {t('landing.visit.mapCta')}
              </a>
            </div>
            <div
              className="card-glow relative min-h-[300px] overflow-hidden rounded-2xl bg-[#E8EEF2]"
              data-reveal
              data-delay="2"
            >
              <iframe
                title={t('landing.visit.mapAria')}
                src={CLINIC.mapsEmbedUrl}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
                className="absolute inset-0 h-full w-full border-0"
              />
            </div>
          </div>
        </Wrap>
      </section>

      <SiteFooter />
    </div>
  )
}

/* ---------- hero ---------- */

function Hero({
  status,
  phone,
  hoursLabel,
  serviceLines,
  insurers,
}: {
  status: ClinicStatus | undefined
  phone: string
  hoursLabel: string
  serviceLines: number
  insurers: number
}) {
  const { t } = useTranslation()
  return (
    <section className="hero-photo relative overflow-hidden text-white">
      {/* The clinic's photo behind the whole slogan area: slow zoom, navy tint from the left
          so the text reads, the instruments visible on the right, a light sheen passing over. */}
      <picture aria-hidden="true">
        <source media="(max-width: 760px)" srcSet="/hero-small.jpg" />
        <img src="/hero.jpg" alt="" className="hero-photo-img" fetchPriority="high" />
      </picture>
      <div aria-hidden="true" className="hero-photo-tint" />
      <div aria-hidden="true" className="hero-photo-sheen" />
      <div aria-hidden="true" className="dot-grid absolute inset-0 opacity-40" />

      <Wrap className="pc:grid-cols-[minmax(0,1.15fr)_420px] pc:pt-16 pc:pb-32 relative grid items-start gap-12 pt-14 pb-28">
        <div className="anim-rise flex flex-col gap-6">
          <StatusPill status={status} variant="glass" />
          <h1 className="m-0 text-[38px] leading-[1.05] font-extrabold tracking-[-0.025em] sm:text-[56px]">
            {t('landing.heroTitle1')}
            <br />
            <span className="text-shine">{t('landing.heroTitle2')}</span>
          </h1>
          <p className="m-0 max-w-[600px] text-lg leading-relaxed text-white/85">
            {t('landing.heroLead')}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/book"
              className={cn(buttonVariants({ variant: 'primary', size: 'xl' }), 'btn-brand-green')}
            >
              <Calendar size={20} aria-hidden="true" />
              {t('landing.ctaBook')}
            </Link>
            <a
              href={telHref(phone)}
              className={cn(buttonVariants({ variant: 'default', size: 'xl' }), 'btn-glass')}
            >
              <Phone size={20} aria-hidden="true" />
              {t('landing.ctaCall', { phone: formatPhone(phone) })}
            </a>
          </div>
          <div className="flex flex-wrap gap-3 pt-1">
            <FloatBadge icon={FlaskConical} label={t('landing.badges.lab')} />
            <FloatBadge
              icon={FEATURES.insurance ? ShieldCheck : Wallet}
              label={t(FEATURES.insurance ? 'landing.badges.insurance' : 'landing.badges.payment')}
              className="[animation-delay:-2s]"
            />
            <FloatBadge
              icon={CalendarDays}
              label={t('landing.badges.days')}
              className="[animation-delay:-4s]"
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-5 sm:flex sm:flex-wrap sm:gap-10">
            <CountStat to={serviceLines} label={t('landing.stats.serviceLines')} />
            <Stat value={hoursLabel} label={t('landing.stats.hours')} />
            {FEATURES.insurance && insurers > 0 && (
              <CountStat to={insurers} label={t('landing.stats.insurers')} />
            )}
            <CountStat to={LANGS.length} label={t('landing.stats.languages')} />
          </div>
        </div>
        <div className="anim-rise [animation-delay:.15s]">
          <SignInCard />
        </div>
      </Wrap>
      <HeroWave />
    </section>
  )
}

/** Open/closed with closing time and, when open and known, the current wait. */
function StatusPill({
  status,
  variant = 'light',
}: {
  status: ClinicStatus | undefined
  variant?: 'glass' | 'light'
}) {
  const { t } = useTranslation()
  if (!status) return null
  const text = status.open
    ? status.closesAt === '24:00'
      ? t('landing.status.open24')
      : t('landing.status.open', { closes: status.closesAt ?? '' })
    : t('landing.status.closed', { opens: status.opensAt ?? '' })
  const wait =
    status.open && status.avgWaitMin > 0
      ? ` · ${t('landing.status.wait', { time: formatDuration(status.avgWaitMin, t) })}`
      : ''
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2.5 self-start rounded-full px-4 py-2 text-sm font-semibold',
        variant === 'glass' ? 'glass' : 'bg-green-bg text-green',
        variant === 'light' && !status.open && 'bg-hover text-ink-2',
      )}
    >
      <span
        className={cn(
          'size-2.5 rounded-full',
          status.open ? 'pulse-ring bg-[#7BD36A] text-[#7BD36A]' : 'bg-ink-3 text-ink-3',
          variant === 'light' && status.open && 'bg-green-dot text-green-dot',
        )}
        aria-hidden="true"
      />
      {text}
      {wait}
    </span>
  )
}

function FloatBadge({
  icon: IconComponent,
  label,
  className,
}: {
  icon: LucideIcon
  label: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'glass anim-float inline-flex min-h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold',
        className,
      )}
    >
      <IconComponent size={16} className="text-[#7BD36A]" aria-hidden="true" />
      {label}
    </span>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="tabular-nums">
      <b className="block text-[28px] leading-[1.1] font-extrabold">{value}</b>
      <span className="text-[13px] text-white/75">{label}</span>
    </span>
  )
}

function CountStat({ to, label }: { to: number; label: string }) {
  const value = useCountUp(to)
  return <Stat value={String(value)} label={label} />
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex items-start gap-4">
      <span className="step-gradient inline-flex size-10 flex-none items-center justify-center rounded-full font-bold text-white shadow-[0_6px_16px_rgba(29,79,174,.3)]">
        {n}
      </span>
      <span>
        <b className="block text-base">{title}</b>
        <span className="text-ink-2 text-[15px]">{body}</span>
      </span>
    </div>
  )
}

function HoursRow({ label, time }: { label: string; time: string }) {
  return (
    <>
      <span>{label}</span>
      <span className="font-semibold">{time}</span>
    </>
  )
}
