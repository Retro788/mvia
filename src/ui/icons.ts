/** Inline 1.5px hairline icons (16×16 viewBox, currentColor). Static, trusted markup. */
const svg = (body: string, size = 16): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  minus: svg('<path d="M3 8h10"/>'),
  play: svg('<path d="M5 3.2v9.6L12.6 8z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M5 3.5v9M11 3.5v9" stroke-width="2.2"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  chevron: svg('<path d="M4 6l4 4 4-4"/>'),
  locate: svg('<circle cx="8" cy="8" r="4.2"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/>'),
  fullscreen: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  chat: svg('<path d="M2.5 4.2c0-.9.7-1.7 1.7-1.7h7.6c.9 0 1.7.8 1.7 1.7v5c0 .9-.8 1.7-1.7 1.7H7l-3 2.6v-2.6h0c-.9 0-1.5-.8-1.5-1.7z"/>'),
  voice: svg('<path d="M2.5 6.5v3M5 4.5v7M7.5 2.5v11M10 5v6M12.5 6.8v2.4"/>'),
  speaker: svg('<path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z"/><path d="M10.5 5.6a3.2 3.2 0 0 1 0 4.8M12.3 3.8a5.8 5.8 0 0 1 0 8.4"/>'),
  spark: svg('<path d="M8 1.8l1.4 4.1 4.1 1.4-4.1 1.4L8 12.8 6.6 8.7 2.5 7.3l4.1-1.4z"/>'),
  build: svg('<path d="M2.5 13.5h11M3.5 13.5V7l4.5-3 4.5 3v6.5M6.5 13.5v-3.5h3v3.5"/>'),
  bulldoze: svg('<path d="M3 11.5h7.5M4 11.5V8h4.5l1.5 3.5M12 6.5l1.5 5M2.5 13.5h9"/>'),
  cursor: svg('<path d="M3.5 2.5l8.5 4-3.6 1.3L7 11.5z"/>'),
  layers: svg('<path d="M8 2.5l5.5 3L8 8.5l-5.5-3z"/><path d="M2.5 8.2L8 11.2l5.5-3M2.5 10.9L8 13.9l5.5-3"/>'),
  key: svg('<rect x="2" y="4.5" width="12" height="7.5" rx="1.5"/><path d="M4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  arrow: svg('<path d="M3 8h9.5M9 4.5L12.5 8 9 11.5"/>'),
  compass: `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2.5l3 8.5h-6z" fill="var(--risk)"/><path d="M11 19.5l-3-8.5h6z" fill="currentColor" opacity=".35"/><circle cx="11" cy="11" r="1.3" fill="currentColor"/></svg>`,
} as const;
