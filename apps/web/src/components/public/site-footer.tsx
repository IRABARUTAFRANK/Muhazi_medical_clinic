import { Link } from '@tanstack/react-router'
import { Clock, Mail, MapPin, MessageCircle, Phone, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CATEGORY_IDS,
  CLINIC,
  CLINIC_HOURS,
  CLINIC_PROFILE,
  LANGS,
  formatPhone,
  hoursRows,
  telHref,
  whatsappHref,
} from '@mmc/shared'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { Wrap } from './site-nav'

// on a touch screen each link is a 44 px row (the lists drop their gap so the footer keeps its rhythm)
const link =
  'text-white/75 no-underline transition-colors hover:text-white coarse:inline-flex coarse:min-h-11 coarse:items-center'
const title = 'mb-4 text-xs font-bold tracking-[.12em] text-white/60 uppercase'

/** Expanded public footer: about & contact, services, patient links, clinic links, opening hours. */
export function SiteFooter() {
  const { t } = useTranslation()
  const { data: info } = useClinicInfo()
  const profile = info?.profile ?? CLINIC_PROFILE
  const hours = info?.hours ?? CLINIC_HOURS
  const { data: status } = useClinicStatus(hours)

  return (
    <footer className="footer-gradient relative mt-auto text-sm text-white/80">
      <div className="brand-bar h-1" aria-hidden="true" />
      <Wrap className="grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1.2fr]">
        {/* ABOUT + CONTACT */}
        <div className="flex flex-col gap-4 sm:col-span-2 lg:col-span-1">
          <div className="flex items-center gap-3">
            <img
              src="/logo.jpg"
              alt=""
              className="size-12 rounded-full object-cover ring-2 ring-white/20"
            />
            <span>
              <span className="block text-base font-bold text-white">{profile.name}</span>
              <span className="text-white/70">{t('app.tagline')}</span>
            </span>
          </div>
          <p className="m-0 max-w-[420px] leading-relaxed">{t('landing.footer.about')}</p>
          <ul className="coarse:gap-0 m-0 flex list-none flex-col gap-2 p-0">
            <li className="flex items-start gap-2.5">
              <MapPin size={16} className="mt-0.5 text-[#7BD36A]" aria-hidden="true" />
              <span>
                {profile.sector}, {profile.district}
                <br />
                {profile.province}, {profile.country}
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <Phone size={16} className="text-[#7BD36A]" aria-hidden="true" />
              <a href={telHref(profile.phone)} className={link}>
                {formatPhone(profile.phone)}
              </a>
            </li>
            <li className="flex items-center gap-2.5">
              <MessageCircle size={16} className="text-[#7BD36A]" aria-hidden="true" />
              <a
                href={whatsappHref(profile.whatsapp)}
                target="_blank"
                rel="noreferrer"
                className={link}
              >
                WhatsApp · {formatPhone(profile.whatsapp)}
              </a>
            </li>
            <li className="flex items-center gap-2.5">
              <Mail size={16} className="text-[#7BD36A]" aria-hidden="true" />
              <a href={`mailto:${profile.email}`} className={`${link} break-all`}>
                {profile.email}
              </a>
            </li>
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-xs text-white/60">
            {t('landing.footer.languages')}
            <span className="flex gap-1.5" aria-hidden="true">
              {LANGS.map((l) => (
                <span
                  key={l.code}
                  className="rounded-md border border-white/20 px-1.5 py-0.5 font-semibold text-white/80"
                >
                  {l.label}
                </span>
              ))}
            </span>
          </div>
        </div>

        {/* SERVICES */}
        <nav aria-label={t('landing.footer.services')}>
          <h3 className={title}>{t('landing.footer.services')}</h3>
          <ul className="coarse:gap-0 m-0 flex list-none flex-col gap-2 p-0">
            {CATEGORY_IDS.map((id) => (
              <li key={id}>
                <Link to="/book" search={{ category: id }} className={link}>
                  {t(`services.${id}.name`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* PATIENTS */}
        <nav aria-label={t('landing.footer.patients')}>
          <h3 className={title}>{t('landing.footer.patients')}</h3>
          <ul className="coarse:gap-0 m-0 flex list-none flex-col gap-2 p-0">
            <li>
              <Link to="/book" className={link}>
                {t('nav.findDoctor')}
              </Link>
            </li>
            <li>
              <Link to="/" hash="book" className={link}>
                {t('nav.book')}
              </Link>
            </li>
            <li>
              <Link to="/" hash="insurance" className={link}>
                {t('nav.insurance')}
              </Link>
            </li>
            <li>
              <Link to="/" hash="visit" className={link}>
                {t('nav.visit')}
              </Link>
            </li>
            <li>
              <a href={CLINIC.mapsUrl} target="_blank" rel="noreferrer" className={link}>
                {t('landing.visit.mapCta')}
              </a>
            </li>
          </ul>
          <p className="mt-5 mb-0 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs leading-snug text-white/80">
            {t('landing.footer.emergency')}
          </p>
        </nav>

        {/* CLINIC */}
        <nav aria-label={t('landing.footer.clinic')}>
          <h3 className={title}>{t('landing.footer.clinic')}</h3>
          <ul className="coarse:gap-0 m-0 flex list-none flex-col gap-2 p-0">
            <li>
              <Link to="/" hash="signin" className={link}>
                {t('landing.footer.staffArea')}
              </Link>
            </li>
            <li>
              <Link to="/" hash="doctors" className={link}>
                {t('nav.findDoctor')}
              </Link>
            </li>
            <li>
              <a href="#privacy" className={link}>
                {t('landing.footer.privacy')}
              </a>
            </li>
            <li>
              <Link to="/" hash="visit" className={link}>
                {t('landing.footer.contact')}
              </Link>
            </li>
          </ul>
        </nav>

        {/* HOURS */}
        <div>
          <h3 className={title}>{t('landing.footer.hours')}</h3>
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 tabular-nums">
            {hoursRows(hours).map((h) => (
              <HoursRow
                key={h.key}
                label={t(`landing.visit.${h.key}`)}
                time={h.allDay ? t('landing.visit.allDay') : h.time}
              />
            ))}
          </dl>
          {status && (
            <p className="mt-4 mb-0 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white">
              <span
                className={
                  status.open
                    ? 'pulse-ring size-2 rounded-full bg-[#7BD36A] text-[#7BD36A]'
                    : 'size-2 rounded-full bg-white/50'
                }
                aria-hidden="true"
              />
              <Clock size={14} aria-hidden="true" />
              {status.open
                ? status.closesAt === '24:00'
                  ? t('landing.status.open24')
                  : t('landing.status.open', { closes: status.closesAt ?? '' })
                : t('landing.status.closed', { opens: status.opensAt ?? '' })}
            </p>
          )}
        </div>
      </Wrap>

      <div className="border-t border-white/10">
        <Wrap className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-5 text-xs text-white/60">
          <span>{t('landing.footer.rights')}</span>
          <span id="privacy" className="inline-flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-[#7BD36A]" aria-hidden="true" />
            {t('landing.footer.law')}
          </span>
          <span className="tabular-nums">{t('landing.footer.version')}</span>
        </Wrap>
      </div>
    </footer>
  )
}

function HoursRow({ label, time }: { label: string; time: string }) {
  return (
    <>
      <dt className="text-white/75">{label}</dt>
      <dd className="m-0 font-semibold text-white">{time}</dd>
    </>
  )
}
