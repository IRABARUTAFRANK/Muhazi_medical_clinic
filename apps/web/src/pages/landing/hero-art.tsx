/** Flat artwork for the public site, recoloured to the logo palette. */

export function PhoneIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 320 160"
      className="anim-float-slow block h-[160px] w-[320px] max-w-full"
    >
      <rect x="20" y="10" width="80" height="140" rx="12" fill="#0F2F6E" />
      <rect x="26" y="20" width="68" height="120" rx="8" fill="#FFFFFF" />
      <rect x="34" y="34" width="44" height="14" rx="7" fill="#E7EEFB" />
      <rect x="44" y="56" width="42" height="14" rx="7" fill="#1D4FAE" />
      <rect x="34" y="78" width="36" height="14" rx="7" fill="#E7EEFB" />
      <rect x="120" y="36" width="180" height="64" rx="12" fill="#EAF8E8" />
      <path d="M120 70 l-12 10 l12 2 Z" fill="#EAF8E8" />
      <circle cx="146" cy="68" r="14" fill="#37A935" />
      <path
        d="m139 68 5 5 9-10"
        stroke="#fff"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="170" y="54" width="110" height="10" rx="5" fill="#2A8A2A" opacity=".85" />
      <rect x="170" y="72" width="80" height="10" rx="5" fill="#2A8A2A" opacity=".45" />
      <rect x="120" y="112" width="140" height="36" rx="10" fill="#E7EEFB" />
      <rect x="134" y="125" width="112" height="10" rx="5" fill="#1D4FAE" opacity=".7" />
    </svg>
  )
}

/** Soft wave that closes the gradient hero into the white page. */
export function HeroWave() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1440 90"
      preserveAspectRatio="none"
      className="absolute right-0 bottom-0 left-0 block h-[70px] w-full"
    >
      <path
        d="M0 50 C 240 95, 480 95, 720 55 S 1200 5, 1440 45 L1440 90 L0 90 Z"
        fill="#ffffff"
        opacity=".18"
      />
      <path
        d="M0 62 C 300 100, 620 90, 900 58 S 1300 20, 1440 58 L1440 90 L0 90 Z"
        fill="#ffffff"
      />
    </svg>
  )
}
