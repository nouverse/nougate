import { useId } from 'react';

/**
 * The Nougate mark.
 *
 * Kept identical to `public/favicon.svg` — the tab icon and the one in the
 * sidebar are the same picture, and a viewer who notices they differ is right
 * to. If you change one, change the other.
 *
 * It brings its own background rather than inheriting `currentColor`, so it
 * needs no wrapper tile and looks the same on the dark theme, the light theme
 * and a browser tab. Callers size it and nothing else:
 *
 *   <NougateMark className="w-9 h-9" />
 *
 * The gradient id is per-instance. A hardcoded one would collide the moment two
 * marks render in the same document, and every instance after the first would
 * paint from whichever definition the browser resolved — a bug that only shows
 * up on the page that happens to have two.
 */
export function NougateMark({ className = 'w-8 h-8' }: { className?: string }) {
  const gradientId = useId();

  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label="Nougate">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3BE9B4" />
          <stop offset=".45" stopColor="#0AC48D" />
          <stop offset="1" stopColor="#3D34C9" />
        </linearGradient>
      </defs>

      <rect width="48" height="48" rx="11.5" fill={`url(#${gradientId})`} />
      {/* Invisible on a light surface; keeps the deep indigo corner from
          dissolving into a dark one. */}
      <rect
        x=".75"
        y=".75"
        width="46.5"
        height="46.5"
        rx="10.75"
        fill="none"
        stroke="#fff"
        strokeOpacity=".2"
        strokeWidth="1.5"
      />

      <path
        d="M24 9.2l12.8 7.4v14.8L24 38.8l-12.8-7.4V16.6z"
        fill="none"
        stroke="#fff"
        strokeWidth="3.4"
        strokeLinejoin="round"
      />
      <g fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 24h8.5" />
        <path d="M24.8 19.6l4.6 4.4-4.6 4.4" />
      </g>
    </svg>
  );
}
