/**
 * One source of truth for the destinations, shared by the desktop sidebar and
 * the mobile tab bar. `short` is what fits under a thumb-sized tab; `label` is
 * what the sidebar has room for.
 *
 * The sidebar shows every link. The tab bar only has room for five keys under
 * a thumb, so `tab` marks the five that earn a place there; Quotes and Bank
 * are reached from the dashboard or the sidebar on a phone.
 */
export interface NavLink {
  href: string;
  label: string;
  short: string;
  icon: string;
  tab?: boolean;
}

export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Dashboard', short: 'Home', icon: 'grid', tab: true },
  { href: '/invoices', label: 'Invoices', short: 'Invoices', icon: 'file', tab: true },
  { href: '/clients', label: 'Clients', short: 'Clients', icon: 'users', tab: true },
  { href: '/quotes', label: 'Quotes', short: 'Quotes', icon: 'quote' },
  { href: '/time', label: 'Time', short: 'Time', icon: 'clock', tab: true },
  { href: '/bank', label: 'Bank', short: 'Bank', icon: 'bank' },
  { href: '/tax', label: 'Tax & accounting', short: 'Tax', icon: 'calculator', tab: true },
];

/** The five that fit in the mobile tab bar's grid. */
export const TAB_LINKS: NavLink[] = NAV_LINKS.filter((link) => link.tab);

export const ICONS: Record<string, string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6',
  users:
    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  calculator: 'M4 2h16v20H4zM8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h8',
  bank: 'M3 21h18M3 10h18M5 6l7-3 7 3M6 10v11M10 10v11M14 10v11M18 10v11',
  quote: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 9h8M8 13h5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  gear:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

/** "/" only matches the dashboard exactly; everything else matches its subtree. */
export const isActive = (path: string, href: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`);
