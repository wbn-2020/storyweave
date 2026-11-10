import type { CSSProperties } from 'react'

const paths = {
  sidebar: 'M3 4h18v16H3ZM9 4v16M5.5 8h1m-1 4h1m-1 4h1',
  more: 'M5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  books: 'M4 4v16M8 4v16M12 4v16M16 5l4 14M3 20h18',
  folder: 'M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  pen: 'm14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14l-1 7Z',
  read: 'M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z',
  galaxy: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  timeline: 'M5 3v18M5 6h13M5 12h9M5 18h13M18 4v4m-4 2v4m4 2v4',
  notes: 'M6 3h14v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 3v18M11 8h6m-6 4h6',
  archive: 'M4 8h16v12H4ZM3 3h18v5H3Zm6 9h6',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  history: 'M3 5v5h5M3 10a9 9 0 1 1 1 7m8-11v6l4 2',
  search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm5-1 5 5',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  focus: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  save: 'M4 3h13l4 4v14H3V3Zm3 0v6h10V3M7 21v-8h10v8',
  check: 'm5 12 4 4L19 6',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  layers: 'm12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5',
  export: 'M12 15V3m-4 4 4-4 4 4M4 13v7h16v-7',
  calendar: 'M4 6h16v14H4V6Zm0 4h16M8 3v3m8-3v3m-8 8h2m4 0h2',
  palette: 'M12 3a9 9 0 0 0 0 18 1.5 1.5 0 0 0 1.5-1.5c0-.4-.15-.75-.4-1a1.5 1.5 0 0 1 1.1-2.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8ZM7.5 10.5h.01M10.5 7.5h.01M14.5 7.5h.01M16.5 10.5h.01',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2 5-5 2 2-5 5-2Z',
  image: 'M4 5h16v14H4V5Zm4 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM20 15l-4.5-4.5L7 19',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 4 9 14 14 0 0 1-4 9 14 14 0 0 1-4-9 14 14 0 0 1 4-9Z',
  magic: 'M14.5 4.5 19.5 9.5 7 22H2v-5L14.5 4.5ZM18 2l4 4M2 2l3 3M22 22l-3-3',
  workflow: 'M3 3h6v6H3Zm12 0h6v6h-6ZM9 15h6v6H9ZM6 9v3a3 3 0 0 0 3 3h3m6-6v3a3 3 0 0 1-3 3h-3',
} satisfies Record<string, string>

export type StudioIconName = keyof typeof paths

export function StudioIcon({ name, size = 18, style }: { name: StudioIconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}><path d={paths[name]} /></svg>
}
