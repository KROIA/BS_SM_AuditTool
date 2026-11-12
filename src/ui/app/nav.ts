// The eight screens of the left menu, in the order of the design canvas.
export interface Screen {
  id: string;
  label: string;
  /** The question the screen answers (DESIGN_SPEC section 6). */
  question: string;
  /** The milestone that builds it; empty when it exists. */
  milestone: string;
  icon: string;
}

export const SCREENS: Screen[] = [
  { id: 'overview', label: 'Overview', question: 'Is something wrong, and where do I start?', milestone: 'M2', icon: 'M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z' },
  { id: 'findings', label: 'Findings', question: 'What exactly was flagged, and why?', milestone: 'M2', icon: 'M12 4l9 15H3zM12 10v4M12 16.5v.5' },
  { id: 'players', label: 'Players', question: 'What did this player do?', milestone: 'M1', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c.8-3.4 3.8-5.5 7.5-5.5s6.7 2.1 7.5 5.5' },
  { id: 'markets', label: 'Markets', question: 'What happened to this price, and who did it?', milestone: 'M1', icon: 'M7 3v4M7 15v6M5 7h4v8H5zM17 3v6M17 15v6M15 9h4v6h-4z' },
  { id: 'accounts', label: 'Bank accounts', question: "Does the bank's log explain the balance?", milestone: 'M1', icon: 'M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18' },
  { id: 'flow', label: 'Money flow', question: 'Where did the money go?', milestone: 'M4', icon: 'M4 7h5c3 0 3 10 6 10h5M4 17h5c1.2 0 1.9-1.6 2.6-3.5M17 14l3 3-3 3' },
  { id: 'saves', label: 'Saves and servers', question: 'What is loaded, and do the servers agree?', milestone: '', icon: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01' },
  { id: 'case', label: 'Case and report', question: 'What do we take back, and what do we tell the admins?', milestone: 'M4', icon: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z' },
];

export const ICON = {
  logo: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 12l2-3 2 2 2-3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  clock: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 8v4l3 2',
  servers: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  upload: 'M12 16V5M7 10l5-5 5 5M5 19h14',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  ok: 'M5 12l5 5 9-10',
  warn: 'M12 4l9 15H3zM12 10v4M12 16.5v.5',
  none: 'M6 12h12',
};
