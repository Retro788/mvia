/** Inline 16px stroke icons (currentColor). */
const wrap = (d: string, extra = '') =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

export const ICONS = {
  play: wrap('<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>'),
  stop: wrap('<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none"/>'),
  close: wrap('<path d="M4 4l8 8M12 4l-8 8"/>'),
  download: wrap('<path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13.5h10"/>'),
  trash: wrap('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  wave: wrap('<path d="M2 8h1M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 8h0"/>'),
  sparkle: wrap('<path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z"/>'),
  reset: wrap('<path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.8v2.6h2.6"/>'),
  key: wrap('<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7L13 3M11 5l1.5 1.5"/>'),
  check: wrap('<path d="M3.5 8.5l3 3 6-7"/>'),
};
