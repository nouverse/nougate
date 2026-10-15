import { useId } from 'react';

/**
 * The Nougate mark: a gateway, seen head-on.
 *
 * Two arches drawn with the Nouverse "n" stroke, one inside the other — a doorway with depth —
 * and the nou mark's planet passing through it. `public/favicon.svg` explains the rules that keep
 * it legible at 16px; this is the same picture, and so is the copy Nouride's dashboard draws for
 * its LLM Gateway page. Change one, change all three.
 *
 * It brings its own background rather than inheriting `currentColor`, so it needs no wrapper tile
 * and looks the same on the dark theme, the light theme and a browser tab. Callers size it and
 * nothing else:
 *
 *   <NougateMark className="w-9 h-9" />
 *
 * The gradient id is per-instance. A hardcoded one would collide the moment two marks render in
 * the same document, and every instance after the first would paint from whichever definition the
 * browser resolved — a bug that only shows up on the page that happens to have two.
 */
export function NougateMark({ className = 'w-8 h-8' }: { className?: string }) {
  const gradientId = useId();

  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label="Nougate">
      <defs>
        <linearGradient id={gradientId} x1="6" y1="2" x2="42" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2EE6B0" />
          <stop offset=".5" stopColor="#0BAF90" />
          <stop offset="1" stopColor="#4338CA" />
        </linearGradient>
      </defs>

      <rect width="48" height="48" rx="11.5" fill={`url(#${gradientId})`} />
      {/* Invisible on a light surface; keeps the deep indigo corner from dissolving into a dark one. */}
      <rect
        x=".75"
        y=".75"
        width="46.5"
        height="46.5"
        rx="10.75"
        fill="none"
        stroke="#fff"
        strokeOpacity=".18"
        strokeWidth="1.5"
      />

      <path
        d="M11 36.5V22a13 13 0 0 1 26 0v14.5"
        fill="none"
        stroke="#fff"
        strokeOpacity=".42"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path d="M17 36.5V24.5a7 7 0 0 1 14 0v12" fill="none" stroke="#fff" strokeWidth="4.2" strokeLinecap="round" />
      <circle cx="24" cy="30.8" r="3.2" fill="#fff" />
    </svg>
  );
}
