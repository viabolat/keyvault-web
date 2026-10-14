import type { Category } from '../types';

type P = { size?: number };
const svg = (path: React.ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
);

export const Logo = ({ size = 40 }: P) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <rect x="4" y="4" width="40" height="40" rx="12" fill="var(--accent)" />
    <circle cx="24" cy="21" r="6" fill="none" stroke="#fff" strokeWidth="3.5" />
    <path d="M24 27v9" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
    <path d="M24 32h4" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
  </svg>
);

export const Icon = {
  search: ({ size }: P) => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, size),
  plus: ({ size }: P) => svg(<path d="M12 5v14M5 12h14" />, size),
  star: ({ size, filled }: P & { filled?: boolean }) =>
    svg(<path fill={filled ? 'currentColor' : 'none'} d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />, size),
  grid: ({ size }: P) => svg(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>, size),
  shield: ({ size }: P) => svg(<path d="M12 3 4.5 6v6c0 4.5 3.2 8 7.5 9 4.3-1 7.5-4.5 7.5-9V6z" />, size),
  trash: ({ size }: P) => svg(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>, size),
  lock: ({ size }: P) => svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>, size),
  copy: ({ size }: P) => svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>, size),
  eye: ({ size }: P) => svg(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, size),
  eyeOff: ({ size }: P) => svg(<><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.5-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>, size),
  dice: ({ size }: P) => svg(<><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" /></>, size),
  vault: ({ size }: P) => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5" /></>, size),
  edit: ({ size }: P) => svg(<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />, size),
  close: ({ size }: P) => svg(<path d="M6 6l12 12M18 6 6 18" />, size),
  external: ({ size }: P) => svg(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>, size),
  tag: ({ size }: P) => svg(<><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="7.5" r="1.3" /></>, size),
  menu: ({ size }: P) => svg(<path d="M4 6h16M4 12h16M4 18h16" />, size),
  back: ({ size }: P) => svg(<path d="M15 5l-7 7 7 7" />, size),
};

const CAT_COLORS: Record<Category, string> = {
  login: '#3b82f6',
  password: '#8b5cf6',
  secure_note: '#f59e0b',
  credit_card: '#10b981',
  identity: '#ec4899',
  api_credential: '#64748b',
};

const CAT_GLYPH: Record<Category, React.ReactNode> = {
  login: <><circle cx="12" cy="9" r="3.5" /><path d="M5.5 19c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5" /></>,
  password: <><circle cx="8" cy="12" r="3.5" /><path d="M11.5 12H20M17 12v3M20 12v2" /></>,
  secure_note: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7" /></>,
  credit_card: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  identity: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M6 16c.6-1.5 1.7-2 3-2s2.4.5 3 2M14 10h4M14 13h3" /></>,
  api_credential: <><path d="M8 8 4 12l4 4M16 8l4 4-4 4M13.5 6l-3 12" /></>,
};

export function CategoryIcon({ category, title, size = 36 }: { category: Category; title?: string; size?: number }) {
  const letter = category === 'login' && title ? title.trim()[0]?.toUpperCase() : undefined;
  return (
    <span className="cat-icon" style={{ width: size, height: size, background: CAT_COLORS[category] }}>
      {letter ? (
        <span style={{ fontSize: size * 0.45 }}>{letter}</span>
      ) : (
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{CAT_GLYPH[category]}</svg>
      )}
    </span>
  );
}

export function CategoryGlyph({ category }: { category: Category }) {
  return svg(CAT_GLYPH[category], 18);
}
