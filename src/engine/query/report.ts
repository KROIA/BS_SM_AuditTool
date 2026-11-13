// The report (DESIGN_SPEC 9): one self-contained HTML page for the admins, or a technical one, in English or German.
// It shows what the screens show, from the same calls (takeBack, findings, the case's choices, the save summaries); no amount
// is worked out a second time. Every string from a save or the case goes through h``, which escapes it.
import fs from 'node:fs';
import path from 'node:path';
import type { Answer, Finding, Level, ReportOptions, RuleSettings, SaveSource, Scope } from '../../shared/api.ts';
import { commands } from '../../shared/commands.ts';
import { headline, plainName, ruleName, ruleText, type ItemWords } from '../../shared/finding.ts';
import { count, items as quantity, money } from '../../shared/fmt.ts';
import { caseData, workspace } from '../workspace.ts';
import { findings } from './findings.ts';
import { items } from './players.ts';
import { takeBack } from './takeback.ts';

const ALL: Scope = { from: null, to: null, server: null };
/** Record ids per finding in the technical report: an order-rate finding can hold thousands. */
const IDS = 200;

// ---- HTML: interpolated values are escaped unless they are already HTML (Html) ----
class Html { readonly html: string; constructor(html: string) { this.html = html; } }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const part = (v: unknown): string => (v instanceof Html ? v.html : Array.isArray(v) ? v.map(part).join('') : v === null || v === undefined || v === false ? '' : esc(String(v)));
const h = (s: TemplateStringsArray, ...v: unknown[]) => new Html(s.reduce((out, text, i) => out + text + (i < v.length ? part(v[i]) : ''), ''));

// ---- Times: to the minute, in this computer's time zone, which the page names once ----
const MONTHS = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  de: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'] };
const two = (n: number) => String(n).padStart(2, '0');
const dayOf = (ms: number, lang: ReportOptions['lang']) => {
  const d = new Date(ms);
  return lang === 'de' ? `${d.getDate()}. ${MONTHS.de[d.getMonth()]} ${d.getFullYear()}` : `${d.getDate()} ${MONTHS.en[d.getMonth()]} ${d.getFullYear()}`;
};
/** 4 Nov 2026, 11:00 / 4. Nov. 2026, 11:00 */
const stamp = (ms: number, lang: ReportOptions['lang']) => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '?' : `${dayOf(ms, lang)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
};
function zone(at: number): string {
  const off = -new Date(at).getTimezoneOffset(), a = Math.abs(off);
  return `${Intl.DateTimeFormat().resolvedOptions().timeZone} (UTC${off < 0 ? '-' : '+'}${two(Math.floor(a / 60))}:${two(a % 60)})`;
}

/** The tool's version: package.json above this file, in the sources and in the build. */
function toolVersion(): string {
  for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (p.name === 'audit-tool') return p.version ?? '?';
    } catch { /* not here */ }
    if (path.dirname(dir) === dir) return '?';
  }
}

// ---- All report text, one dictionary per language. German writes ss, never the sharp s. ----
const EN = {
  title: 'Report', made: (at: string, v: string) => `Made on ${at} with Audit Tool ${v}.`, zone: (z: string) => `All times are in ${z}.`,
  styleName: { admin: 'For admins', tech: 'Technical' },
  happened: 'What happened',
  story: (who: string, _many: boolean, made: boolean, amount: string, where: string, from: string, to: string) => `${who} ${made ? 'made' : 'lost'} ${amount} on ${where} between ${from} and ${to}.`,
  on: (who: string, where: string) => `${who} on ${where}`,
  storyNoProfit: (what: string, from: string, to: string) => `${what}, between ${from} and ${to}.`,
  holds: (n: number, level: string) => `The incident holds ${count(n)} ${n === 1 ? 'finding' : 'findings'}, the strongest of them ${level}.`,
  findings: (n: number) => `${count(n)} ${n === 1 ? 'finding' : 'findings'}`,
  markets: (names: string[]) => (names.length === 1 ? `the ${names[0]!.toLowerCase()} market` : names.length === 2 ? `the ${names.join(' and ').toLowerCase()} markets` : `${count(names.length)} markets`),
  and: 'and', players: (n: number) => `${count(n)} players`,
  accounts: (list: string) => `Accounts: ${list}.`, servers: (list: string) => `Orders placed on: ${list}.`,
  total: (amount: string, n: number, its: string) => `To take back: ${amount} from ${count(n)} ${n === 1 ? 'account' : 'accounts'}${its}.`,
  totalItems: (n: string) => `, and ${n} items`,
  level: { critical: 'critical', high: 'high', medium: 'medium', low: 'low' } as Record<Level, string>,
  takeBack: 'What to take back',
  cut: {
    day: (day: string, at: string) => `Each player keeps the balance they had at the end of ${day} (${at}), before any flagged trade.`,
    first: (_day: string, at: string) => `Each player keeps the balance they had right before the incident's first finding, ${at}.`,
    custom: (_day: string, at: string) => `Each player keeps the balance they had at ${at}, a time the investigator picked.`,
  },
  keepRule: 'May keep is the balance at the cutoff plus what trading on markets outside the incident earned since, at most what the account holds. Nothing is changed on the server until an admin runs the commands.',
  span: (to: string | null) => (to === null ? 'From the cutoff to when the copy was taken.' : `From the cutoff to the copy, ${to}.`),
  th: { player: 'Player', account: 'Account', now: 'Has now', keep: 'May keep', take: 'Take back', amount: 'Amount', between: 'Between', answer: 'Answer',
    item: 'Item', remove: 'Remove', leaves: 'Leaves', source: 'Source', status: 'Status', table: 'Table', rows: 'Rows', from: 'From', to: 'To', lost: 'Lost ids' },
  totalRow: 'Total',
  via: (notes: string, name: string) => `likely paid in ${notes} of ${name}'s notes`,
  andItems: (n: string) => `and ${n} items`,
  noTake: 'Nothing to take back from the bank with this cutoff.',
  answers: 'What the admins answered',
  answersIntro: 'BankSystem 2.1.2 did not log money an admin removed. For each amount that left an account without a log row, the investigator recorded this answer.',
  answer: { yes: 'Removed by an admin already', unsure: 'Left the account, not confirmed', no: 'Gone, nobody knows where' } as Record<Answer, string>,
  stillOpen: 'Still open',
  askAdmins: (m: string, a: number, f: string, t: string) => `Ask the admins whether they removed ${m} from account ${a} (${f} to ${t}).`,
  gone: (m: string, a: number, f: string, t: string) => `${m} left account ${a} (${f} to ${t}) and nobody knows where.`,
  notFound: (m: string) => `${m} of banknotes were not found in any file or block the tool read.`,
  nothingOpen: 'Nothing is open.',
  commands: 'Commands for the admins',
  forVersion: (v: string) => `For BankSystem ${v}.`,
  runNote: 'Run them in game as an admin player: BankSystem does not take them from the server console. /money remove takes the player\'s name and works on their personal account. It reads the amount as a 32-bit number, so a large amount is split into parts it takes exactly; an account that keeps nothing is set to 0 instead, because the last part would be refused.',
  freezeNote: 'The first lines freeze the accounts so nothing moves while the admins work; the last lines unfreeze them, after the items below.',
  itemsTitle: 'Items to remove',
  itemsNote: 'BankSystem has no command that removes items from an account, so they are a list: change each balance in /bank <player> manage.',
  notes: 'Where the banknotes are',
  notesIntro: 'Banknotes the incident\'s players took out since the cutoff and that are still outside the bank. Where they are is an estimate.',
  notesRows: { outside: 'Still outside the bank', inFiles: 'In their own player files', elsewhere: 'Found elsewhere, owner unknown', notFound: 'Not found' },
  notesOther: (name: string) => `Likely paid in by ${name}`,
  noNotes: 'No banknotes of the incident are outside the bank.',
  evidence: 'Evidence',
  evidenceIntro: 'The findings the investigator pinned, in their order, with their notes.',
  noEvidence: 'Nothing was pinned.',
  noNote: 'No note.',
  gone2: 'No longer raised with the current rule settings.',
  basis: { proven: 'Proven', estimate: 'Estimate', hint: 'Hint', 'as raised': 'As the mod raised it' } as Record<Finding['basis'], string>,
  unchecked: 'What could not be checked',
  sourceState: (save: string, source: string, state: string) => `${save}: ${source} ${state}.`,
  lostRows: (save: string, table: string, n: number) => `${save}: ${count(n)} rows of ${table} are lost.`,
  newestLost: (save: string, table: string) => `${save}: the newest rows of ${table} are lost.`,
  allChecked: 'Nothing the report relies on is missing from the loaded saves.',
  missing: {
    'BankSystem 2.1.2 logged no admin action and no note paid in through the ATM converter: money that came or went without a log row is taken from the gaps between snapshots, an estimate.': '',
    'The server filter applies to trading only: trading on other servers is shown as one part. Bank rows and gaps belong to every server.': '',
    'Where the notes are now is not known: ': '',
    'No save with bank data is loaded, so no player file can be compared with it.': '',
    "None of the loaded saves has player files (the world's playerdata folder), so nothing could be counted.": '',
  } as Record<string, string>,
  // Technical only
  allFindings: 'Every finding of the incident', rulesUsed: 'The rules and their thresholds',
  f: { measured: 'Measured', account: 'Account', accounts: 'Accounts', orders: 'Order ids', ledger: 'Bank log ids', flags: 'Flag ids' },
  more: (n: number) => `and ${count(n)} more`,
  none: 'none',
  coverage: 'Coverage of the loaded saves',
  saveLine: (role: string, gen: string, at: string | null) => `${role}, ${gen}, ${at === null ? 'copy time unknown' : `copy taken ${at}`}.`,
  role: { MASTER: 'master', SLAVE: 'slave', STANDALONE: 'standalone server' } as Record<string, string>,
  gen: { legacy: 'written by BankSystem 2.1.2', current: 'with the audit additions' } as Record<string, string>,
  source: { bank: 'Bank database', market: 'Market database', bankDiag: 'Bank diagnostics', marketDiag: 'Market diagnostics', audit: 'Bank audit log' } as Record<SaveSource['id'], string>,
  status: { read: 'read', damaged: 'damaged', missing: 'missing', none: 'not there, which is normal' } as Record<SaveSource['status'], string>,
  warnings: 'Warnings from loading',
  warningsNote: 'As the tool wrote them while loading.',
  noWarnings: 'No warnings.',
  versions: 'Versions',
  toolVersion: 'Audit Tool', notRecorded: 'not recorded in this save',
  foot: '',
};
const DE: typeof EN = {
  title: 'Bericht', made: (at, v) => `Erstellt am ${at} mit Audit Tool ${v}.`, zone: (z) => `Alle Zeiten in ${z}.`,
  styleName: { admin: 'Für Admins', tech: 'Technisch' },
  happened: 'Was passiert ist',
  story: (who, many, made, amount, where, from, to) => `${who} ${made ? (many ? 'gewannen' : 'gewann') : many ? 'verloren' : 'verlor'} ${amount} auf ${where} zwischen ${from} und ${to}.`,
  on: (who, where) => `${who} auf ${where}`,
  storyNoProfit: (what, from, to) => `${what}, zwischen ${from} und ${to}.`,
  holds: (n, level) => `Der Vorfall umfasst ${count(n)} ${n === 1 ? 'Befund' : 'Befunde'}, der stärkste davon ${level}.`,
  findings: (n) => `${count(n)} ${n === 1 ? 'Befund' : 'Befunde'}`,
  markets: (names) => (names.length === 1 ? `dem Markt ${names[0]}` : names.length === 2 ? `den Märkten ${names.join(' und ')}` : `${count(names.length)} Märkten`),
  and: 'und', players: (n) => `${count(n)} Spieler`,
  accounts: (list) => `Konten: ${list}.`, servers: (list) => `Orders aufgegeben auf: ${list}.`,
  total: (amount, n, its) => `Zurückzuholen: ${amount} von ${count(n)} ${n === 1 ? 'Konto' : 'Konten'}${its}.`,
  totalItems: (n) => `, dazu ${n} Items`,
  level: { critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' },
  takeBack: 'Was zurückgeholt wird',
  cut: {
    day: (day, at) => `Jeder Spieler behält den Kontostand vom Ende des ${day} (${at}), vor jedem markierten Trade.`,
    first: (_day, at) => `Jeder Spieler behält den Kontostand direkt vor dem ersten Befund des Vorfalls, ${at}.`,
    custom: (_day, at) => `Jeder Spieler behält den Kontostand von ${at}, einem vom Ermittler gewählten Zeitpunkt.`,
  },
  keepRule: 'Behalten darf er den Kontostand zum Stichtag plus das, was der Handel auf Märkten ausserhalb des Vorfalls seither eingebracht hat, höchstens was auf dem Konto ist. Auf dem Server ändert sich nichts, bis ein Admin die Befehle ausführt.',
  span: (to) => (to === null ? 'Vom Stichtag bis zur Kopie.' : `Vom Stichtag bis zur Kopie, ${to}.`),
  th: { player: 'Spieler', account: 'Konto', now: 'Hat jetzt', keep: 'Darf behalten', take: 'Zurückholen', amount: 'Betrag', between: 'Zeitraum', answer: 'Antwort',
    item: 'Item', remove: 'Entfernen', leaves: 'Bleiben', source: 'Quelle', status: 'Zustand', table: 'Tabelle', rows: 'Zeilen', from: 'Von', to: 'Bis', lost: 'Verlorene Ids' },
  totalRow: 'Summe',
  via: (notes, name) => `hat vermutlich ${notes} in Banknoten von ${name} eingezahlt`,
  andItems: (n) => `und ${n} Items`,
  noTake: 'Mit diesem Stichtag ist von der Bank nichts zurückzuholen.',
  answers: 'Was die Admins geantwortet haben',
  answersIntro: 'BankSystem 2.1.2 hat Geld, das ein Admin entfernt hat, nicht protokolliert. Für jeden Betrag, der ein Konto ohne Log-Zeile verlassen hat, hat der Ermittler diese Antwort festgehalten.',
  answer: { yes: 'Bereits von einem Admin entfernt', unsure: 'Hat das Konto verlassen, nicht bestätigt', no: 'Weg, niemand weiss wohin' },
  stillOpen: 'Noch offen',
  askAdmins: (m, a, f, t) => `Die Admins fragen, ob sie ${m} von Konto ${a} entfernt haben (${f} bis ${t}).`,
  gone: (m, a, f, t) => `${m} haben Konto ${a} verlassen (${f} bis ${t}), und niemand weiss wohin.`,
  notFound: (m) => `${m} in Banknoten wurden in keiner Datei und keinem Block gefunden, die das Tool gelesen hat.`,
  nothingOpen: 'Nichts ist offen.',
  commands: 'Befehle für die Admins',
  forVersion: (v) => `Für BankSystem ${v}.`,
  runNote: 'Im Spiel als Admin-Spieler ausführen: BankSystem nimmt sie nicht von der Server-Konsole an. /money remove nimmt den Namen des Spielers und wirkt auf sein persönliches Konto. Es liest den Betrag als 32-Bit-Zahl, darum wird ein grosser Betrag in Teile aufgeteilt, die es genau annimmt; ein Konto, das nichts behält, wird stattdessen auf 0 gesetzt, weil der letzte Teil abgelehnt würde.',
  freezeNote: 'Die ersten Zeilen frieren die Konten ein, damit sich nichts bewegt, während die Admins arbeiten; die letzten Zeilen tauen sie wieder auf, nach den Items unten.',
  itemsTitle: 'Zu entfernende Items',
  itemsNote: 'BankSystem hat keinen Befehl, der Items von einem Konto entfernt, darum sind sie eine Liste: jeden Bestand in /bank <player> manage ändern.',
  notes: 'Wo die Banknoten sind',
  notesIntro: 'Banknoten, die die Spieler des Vorfalls seit dem Stichtag abgehoben haben und die noch ausserhalb der Bank sind. Wo sie sind, ist geschätzt.',
  notesRows: { outside: 'Noch ausserhalb der Bank', inFiles: 'In ihren eigenen Spielerdateien', elsewhere: 'Anderswo gefunden, Besitzer unbekannt', notFound: 'Nicht gefunden' },
  notesOther: (name) => `Vermutlich eingezahlt von ${name}`,
  noNotes: 'Keine Banknoten des Vorfalls sind ausserhalb der Bank.',
  evidence: 'Belege',
  evidenceIntro: 'Die Befunde, die der Ermittler angeheftet hat, in seiner Reihenfolge, mit seinen Notizen.',
  noEvidence: 'Nichts wurde angeheftet.',
  noNote: 'Keine Notiz.',
  gone2: 'Mit den aktuellen Regeleinstellungen nicht mehr gemeldet.',
  basis: { proven: 'Belegt', estimate: 'Schätzung', hint: 'Hinweis', 'as raised': 'Wie von der Mod gemeldet' },
  unchecked: 'Was nicht geprüft werden konnte',
  sourceState: (save, source, state) => `${save}: ${source} ${state}.`,
  lostRows: (save, table, n) => `${save}: ${count(n)} Zeilen von ${table} sind verloren.`,
  newestLost: (save, table) => `${save}: die neuesten Zeilen von ${table} sind verloren.`,
  allChecked: 'In den geladenen Spielständen fehlt nichts, worauf sich der Bericht stützt.',
  missing: {
    'BankSystem 2.1.2 logged no admin action and no note paid in through the ATM converter: money that came or went without a log row is taken from the gaps between snapshots, an estimate.':
      'BankSystem 2.1.2 hat keine Admin-Aktion und keine über den ATM-Konverter eingezahlte Banknote protokolliert: Geld, das ohne Log-Zeile kam oder ging, wird aus den Lücken zwischen den Schnappschüssen geschätzt.',
    'The server filter applies to trading only: trading on other servers is shown as one part. Bank rows and gaps belong to every server.':
      'Der Server-Filter gilt nur für den Handel: Handel auf anderen Servern erscheint als ein Teil. Bankzeilen und Lücken gehören zu jedem Server.',
    'Where the notes are now is not known: ': 'Wo die Banknoten jetzt sind, ist nicht bekannt: ',
    'No save with bank data is loaded, so no player file can be compared with it.': 'Kein Spielstand mit Bankdaten ist geladen, darum kann keine Spielerdatei damit verglichen werden.',
    "None of the loaded saves has player files (the world's playerdata folder), so nothing could be counted.":
      'Keiner der geladenen Spielstände hat Spielerdateien (den Ordner playerdata der Welt), darum konnte nichts gezählt werden.',
  },
  allFindings: 'Alle Befunde des Vorfalls', rulesUsed: 'Die Regeln und ihre Grenzwerte',
  f: { measured: 'Gemessen', account: 'Konto', accounts: 'Konten', orders: 'Order-Ids', ledger: 'Bank-Log-Ids', flags: 'Markierungs-Ids' },
  more: (n) => `und ${count(n)} weitere`,
  none: 'keine',
  coverage: 'Abdeckung der geladenen Spielstände',
  saveLine: (role, gen, at) => `${role}, ${gen}, ${at === null ? 'Zeitpunkt der Kopie unbekannt' : `Kopie vom ${at}`}.`,
  role: { MASTER: 'Master', SLAVE: 'Slave', STANDALONE: 'Einzelserver' },
  gen: { legacy: 'geschrieben von BankSystem 2.1.2', current: 'mit den Audit-Erweiterungen' },
  source: { bank: 'Bank-Datenbank', market: 'Markt-Datenbank', bankDiag: 'Bank-Diagnose', marketDiag: 'Markt-Diagnose', audit: 'Audit-Log der Bank' },
  status: { read: 'gelesen', damaged: 'beschädigt', missing: 'fehlt', none: 'nicht vorhanden, das ist normal' },
  warnings: 'Warnungen beim Laden',
  warningsNote: 'So, wie das Tool sie beim Laden geschrieben hat, auf Englisch.',
  noWarnings: 'Keine Warnungen.',
  versions: 'Versionen',
  toolVersion: 'Audit Tool', notRecorded: 'in diesem Spielstand nicht festgehalten',
  foot: 'Item- und Marktnamen stehen so, wie die Anwendung sie zeigt, auf Englisch.',
};

const CSS = `
@page { size: A4; margin: 16mm 15mm; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 820px; padding: 24px; font: 10.5pt/1.45 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #16181d; background: #fff; }
h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 6px; }
h2 { font-size: 13.5pt; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d5d8de; break-after: avoid; }
h3 { font-size: 11pt; margin: 16px 0 6px; break-after: avoid; }
p { margin: 0 0 8px; }
.meta, .small, .foot { color: #5a606b; font-size: 9pt; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { text-align: left; font-size: 8.5pt; color: #5a606b; font-weight: 600; padding: 4px 8px 4px 0; border-bottom: 1px solid #c3c7cf; }
td { padding: 5px 8px 5px 0; border-bottom: 1px solid #e6e8ec; vertical-align: top; }
td.r, th.r { text-align: right; }
tr.total td { font-weight: 700; border-bottom: 0; border-top: 1px solid #c3c7cf; }
.sub { display: block; color: #5a606b; font-size: 8.5pt; }
pre { margin: 6px 0 8px; padding: 10px 12px; background: #f4f5f7; border: 1px solid #e0e3e8; border-radius: 6px; font: 9pt/1.5 Consolas, "Cascadia Mono", monospace; white-space: pre-wrap; word-break: break-all; }
ul { margin: 0 0 8px; padding-left: 18px; }
li { margin-bottom: 3px; break-inside: avoid; }
.pin { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid #c3c7cf; break-inside: avoid; }
.pin b { display: block; }
dl { display: grid; grid-template-columns: 13em 1fr; gap: 2px 10px; margin: 0 0 12px; font-size: 9.5pt; }
dt { color: #5a606b; }
dd { margin: 0; overflow-wrap: anywhere; }
.finding { display: flex; flex-direction: column; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid #e6e8ec; break-inside: avoid; font-size: 9.5pt; }
.ids { color: #5a606b; font-size: 8pt; overflow-wrap: anywhere; }
table.compact td { padding: 2px 8px 2px 0; font-size: 9.5pt; }
`;

/** The report of one incident as one HTML page (DESIGN_SPEC 9). Throws, in plain words, when there is nothing to report. */
export function report(incidentId: string, options: ReportOptions, settings: RuleSettings): string {
  // The window process passes these on unchecked: anything unknown falls back to the defaults.
  const lang = options?.lang === 'de' ? 'de' : 'en', style = options?.style === 'tech' ? 'tech' : 'admin', version = options?.version === '2.2.0' ? '2.2.0' : '2.1.2';
  const T = lang === 'de' ? DE : EN;
  const c = caseData();
  const tb = takeBack(String(incidentId), c.choices.cutoff, settings);
  if (tb.reason !== null || !tb.incident) throw new Error(tb.reason ?? 'This incident is not raised with the current rule settings.');
  const inc = tb.incident, ws = workspace();
  const rowsById = new Map(items().map((i) => [i.id, i]));
  const w: ItemWords = { itemName: (id) => { const n = rowsById.get(id)?.name; return n ? plainName(n) : 'Item ' + id; }, isMoney: (id) => rowsById.get(id)?.money ?? false };
  const byId = new Map(findings(ALL, settings).findings.map((f) => [f.id, f]));
  const when = (ms: number) => stamp(ms, lang);
  /** The end of a span: only its time when it is the same day. */
  const end = (a: number, b: number) => (dayOf(a, lang) === dayOf(b, lang) ? when(b).split(', ')[1]! : when(b));
  const range = (a: number, b: number) => (when(a) === when(b) ? when(a) : `${when(a)} – ${end(a, b)}`);
  const sum = (v: bigint[]) => v.reduce((s, x) => s + x, 0n);
  const sumItems = (r: (typeof tb.rows)[number]) => sum(r.items.map((i) => i.remove));

  // ---- What happened ----
  const names = inc.players.map((p) => p.name), marketNames = inc.markets.map((m) => w.itemName(m));
  const who = names.length === 0 ? null : names.length <= 3 ? names.join(names.length === 2 ? ` ${T.and} ` : ', ') : T.players(names.length);
  const where = marketNames.length ? T.markets(marketNames) : null;
  const story = who && where && inc.profit !== 0n
    ? T.story(who, names.length > 1, inc.profit > 0n, money(inc.profit < 0n ? -inc.profit : inc.profit), where, when(inc.start), end(inc.start, inc.end))
    : T.storyNoProfit([who, where].filter(Boolean).join(', ') || T.findings(inc.findings.length), when(inc.start), end(inc.start, inc.end));
  const takeTotal = sum(tb.rows.map((r) => r.take)), itemTotal = sum(tb.rows.map(sumItems));
  const happened = h`<h2>${T.happened}</h2>
<p>${story} ${T.holds(inc.findings.length, T.level[inc.level])}</p>
<p>${T.accounts(inc.accounts.map(String).join(', ') || T.none)}${inc.servers.length ? ' ' + T.servers(inc.servers.join(', ')) : ''}</p>
<p><b>${T.total(money(takeTotal), tb.rows.filter((r) => r.take > 0n || r.items.length).length, itemTotal > 0n ? T.totalItems(quantity(itemTotal)) : '')}</b></p>`;

  // ---- What to take back ----
  const cutDay = dayOf(tb.day, lang);
  const table = h`<table><thead><tr><th>${T.th.player}</th><th>${T.th.account}</th><th class="r">${T.th.now}</th><th class="r">${T.th.keep}</th><th class="r">${T.th.take}</th></tr></thead><tbody>
${tb.rows.map((r) => h`<tr><td>${r.player.name}${r.via ? h`<span class="sub">${T.via(money(r.via.notes), r.via.name)}</span>` : ''}</td><td>${r.account}</td><td class="r">${money(r.now)}</td><td class="r">${money(r.keep)}</td><td class="r"><b>${money(r.take)}</b>${r.items.length ? h`<span class="sub">${T.andItems(quantity(sumItems(r)))}</span>` : ''}</td></tr>\n`)}
<tr class="total"><td>${T.totalRow}</td><td></td><td></td><td></td><td class="r">${money(takeTotal)}</td></tr></tbody></table>`;
  const take = h`<h2>${T.takeBack}</h2>
<p>${T.cut[c.choices.cutoff.kind](cutDay, when(tb.at))}</p>
${tb.rows.length ? table : h`<p>${T.noTake}</p>`}
<p class="small">${T.keepRule} ${T.span(tb.to === null ? null : when(tb.to))}</p>`;

  // ---- The admins' answers and what is still open ----
  const removals = tb.rows.flatMap((r) => r.removed.map((g) => ({ ...g, row: r }))).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const answer = (key: string): Answer => c.choices.answers[key] ?? 'unsure';
  const open = [
    ...removals.filter((g) => answer(g.key) === 'unsure').map((g) => T.askAdmins(money(g.amount), g.row.account, when(g.from), end(g.from, g.to))),
    ...removals.filter((g) => answer(g.key) === 'no').map((g) => T.gone(money(g.amount), g.row.account, when(g.from), end(g.from, g.to))),
    ...(tb.notes.notFound ? [T.notFound(money(tb.notes.notFound))] : []),
  ];
  const answers = h`${removals.length ? h`<h2>${T.answers}</h2><p>${T.answersIntro}</p>
<table><thead><tr><th>${T.th.player}</th><th>${T.th.account}</th><th class="r">${T.th.amount}</th><th>${T.th.between}</th><th>${T.th.answer}</th></tr></thead><tbody>
${removals.map((g) => h`<tr><td>${g.row.player.name}</td><td>${g.row.account}</td><td class="r">${money(g.amount)}</td><td>${range(g.from, g.to)}</td><td>${T.answer[answer(g.key)]}</td></tr>\n`)}</tbody></table>` : ''}
<h2>${T.stillOpen}</h2>${open.length ? h`<ul>${open.map((o) => h`<li>${o}</li>`)}</ul>` : h`<p>${T.nothingOpen}</p>`}`;

  // ---- Commands and items ----
  const lines = commands(tb.rows, version);
  const itemRows = tb.rows.flatMap((r) => r.items.map((i) => ({ r, i })));
  const cmds = h`<h2>${T.commands}</h2>
<p>${T.forVersion(version)} ${T.runNote}${version === '2.2.0' && lines.length ? ' ' + T.freezeNote : ''}</p>
${lines.length ? h`<pre>${lines.join('\n')}</pre>` : h`<p>${T.noTake}</p>`}
${itemRows.length ? h`<h3>${T.itemsTitle}</h3><p class="small">${T.itemsNote}</p>
<table class="compact"><thead><tr><th>${T.th.account}</th><th>${T.th.player}</th><th>${T.th.item}</th><th class="r">${T.th.remove}</th><th class="r">${T.th.leaves}</th></tr></thead><tbody>
${itemRows.map(({ r, i }) => h`<tr><td>${r.account}</td><td>${r.player.name}</td><td>${w.itemName(i.item)}</td><td class="r">${quantity(i.remove)}</td><td class="r">${quantity(i.now - i.remove)}</td></tr>\n`)}</tbody></table>` : ''}`;

  // ---- Where the banknotes are ----
  const n = tb.notes;
  const noteRows: [string, bigint | null][] = [[T.notesRows.outside, n.outside], [T.notesRows.inFiles, n.inFiles], [T.notesRows.elsewhere, n.elsewhere], [T.notesRows.notFound, n.notFound],
    ...n.others.map((o): [string, bigint] => [T.notesOther(o.player.name), o.amount])];
  const notes = h`<h2>${T.notes}</h2>${n.outside > 0n || n.others.length ? h`<p>${T.notesIntro}</p>
<table><tbody>${noteRows.filter(([, v]) => v !== null).map(([label, v]) => h`<tr><td>${label}</td><td class="r">${money(v!)}</td></tr>`)}</tbody></table>` : h`<p>${T.noNotes}</p>`}`;

  // ---- Evidence: the pins in the stored order ----
  const pinnedIds = Object.keys(c.marks).filter((id) => c.marks[id]!.pinned), order = c.choices.order;
  const pos = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length + pinnedIds.indexOf(id));
  const pins = pinnedIds.sort((a, b) => pos(a) - pos(b));
  const evidence = h`<h2>${T.evidence}</h2>${pins.length ? h`<p class="small">${T.evidenceIntro}</p>${pins.map((id) => {
    const m = c.marks[id]!, f = byId.get(id);
    const title = f ? headline(f, w, lang, money).title : m.title;
    const sub = f ? [f.players.map((p) => p.name).join(', '), when(f.start), T.basis[f.basis]].filter(Boolean).join(' · ') : `${when(m.start)} · ${T.gone2}`;
    return h`<div class="pin"><b>${title}</b><span class="sub">${sub}</span><p>${m.note.trim() || T.noNote}</p></div>`;
  })}` : h`<p>${T.noEvidence}</p>`}`;

  // ---- What could not be checked ----
  const translate = (s: string) => {
    if (lang === 'en') return s;
    const prefix = 'Where the notes are now is not known: ';
    if (s.startsWith(prefix)) return T.missing[prefix] + (T.missing[s.slice(prefix.length)] || s.slice(prefix.length));
    return T.missing[s] || s;
  };
  const gaps = ws.saves.flatMap((s) => s.sources.flatMap((src) => [
    ...(src.status === 'missing' || src.status === 'damaged' ? [T.sourceState(s.name, T.source[src.id], T.status[src.status])] : []),
    ...src.tables.flatMap((t) => (t.newestLost ? [T.newestLost(s.name, t.name)] : t.lostIds ? [T.lostRows(s.name, t.name, t.lostIds)] : [])),
  ]));
  const unchecked = [...tb.missing.map(translate), ...gaps];
  const notChecked = h`<h2>${T.unchecked}</h2>${unchecked.length ? h`<ul>${unchecked.map((u) => h`<li>${u}</li>`)}</ul>` : h`<p>${T.allChecked}</p>`}`;

  // ---- Technical: every finding, the coverage, the warnings, the versions ----
  let tech = h``;
  if (style === 'tech') {
    const ids = (list: number[]) => (list.length ? list.slice(0, IDS).join(', ') + (list.length > IDS ? ` ${T.more(list.length - IDS)}` : '') : T.none);
    const list = inc.findings.map((id) => byId.get(id)).filter((f): f is Finding => f !== undefined);
    const findingsHtml = list.map((f) => {
      const hl = headline(f, w, lang, money);
      const about = [f.players.map((p) => p.name).join(', '), f.accounts.length ? `${f.accounts.length === 1 ? T.f.account : T.f.accounts} ${f.accounts.join(', ')}` : '',
        f.markets.length ? f.markets.map((m) => w.itemName(m)).join(', ') : '', f.servers.join(', ')].filter(Boolean).join(' · ');
      const records = [[T.f.orders, f.records.orders], [T.f.ledger, f.records.ledger], [T.f.flags, f.records.flags]] as const;
      return h`<div class="finding"><b>${hl.title}</b>
<span class="sub">${hl.rule} · ${T.level[f.level]} · ${T.basis[f.basis]} · ${range(f.start, f.end)}${about ? ' · ' + about : ''}</span>
<span>${T.f.measured}: ${hl.measured}</span>
${records.filter(([, l]) => l.length).map(([k, l]) => h`<span class="ids">${k}: ${ids([...l])}</span>`)}</div>
`;
    });
    // Each rule's sentence once, with the thresholds these findings were raised with.
    const rules = [...new Set(list.map((f) => f.rule))].map((r) => h`<dt>${ruleName(r, lang)}</dt><dd>${ruleText(r, settings, lang)}</dd>`);
    const coverage = ws.saves.map((s) => h`<h3>${s.name}</h3><p>${T.saveLine(T.role[s.role] ?? s.role, T.gen[s.generation] ?? s.generation, s.lastPlayedMs === null ? null : when(s.lastPlayedMs))}</p>
<table class="compact"><thead><tr><th>${T.th.source}</th><th>${T.th.status}</th><th>${T.th.table}</th><th class="r">${T.th.rows}</th><th>${T.th.from}</th><th>${T.th.to}</th><th class="r">${T.th.lost}</th></tr></thead><tbody>
${s.sources.filter((src) => src.status !== 'none').flatMap((src) => (src.tables.length ? src.tables : [null]).map((t) => h`<tr><td>${T.source[src.id]}</td><td>${T.status[src.status]}</td><td>${t?.name ?? ''}</td><td class="r">${t ? count(t.rows) : ''}</td><td>${t?.from == null ? '' : when(t.from)}</td><td>${t?.to == null ? '' : when(t.to)}</td><td class="r">${t ? count(t.lostIds) : ''}</td></tr>\n`))}</tbody></table>`);
    const warnings = [...ws.warnings, ...ws.saves.flatMap((s) => s.warnings.map((x) => `${s.name}: ${x}`))];
    tech = h`<h2>${T.allFindings}</h2><h3>${T.rulesUsed}</h3><dl>${rules}</dl><h3>${T.findings(list.length)}</h3>${findingsHtml}
<h2>${T.coverage}</h2>${coverage}
<h2>${T.warnings}</h2>${warnings.length ? h`<p class="small">${T.warningsNote}</p><ul>${warnings.map((x) => h`<li>${x}</li>`)}</ul>` : h`<p>${T.noWarnings}</p>`}
<h2>${T.versions}</h2><table><tbody><tr><td>${T.toolVersion}</td><td>${toolVersion()}</td></tr>
${ws.saves.map((s) => h`<tr><td>${s.name}</td><td>BankSystem ${s.bankVersion ?? T.notRecorded} · StockMarket ${s.marketVersion ?? T.notRecorded} · Minecraft ${s.minecraft ?? T.notRecorded}</td></tr>\n`)}</tbody></table>`;
  }

  const title = `${T.title}: ${who && where ? T.on(who, where) : who ?? where ?? T.findings(inc.findings.length)}`;
  return h`<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><style>${new Html(CSS)}</style></head>
<body>
<h1>${title}</h1>
<p class="meta">${T.styleName[style]} · ${T.made(when(Date.now()), toolVersion())} ${T.zone(zone(inc.start))}</p>
${happened}${take}${answers}${cmds}${notes}${evidence}${notChecked}${tech}
${T.foot ? h`<p class="foot">${T.foot}</p>` : ''}
</body></html>
`.html;
}
