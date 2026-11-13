// The report: both styles in both languages, the take-back figures and commands as takeBack gives them,
// escaping of save strings, nothing that loads or runs, German without English headings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, cacheFile, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Cutoff, type ReportOptions } from '../../src/shared/api.ts';
import { commands } from '../../src/shared/commands.ts';
import { money } from '../../src/shared/fmt.ts';
import { buildFixtures, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const tavrik = uuidText(PLAYERS.Tavrik.n);
const PUMP = `hour-profit:${tavrik}@${T0}`;
const DAY: Cutoff = { kind: 'day', at: null };
const EVIL = '<img src=x onerror=alert(1)>';
let fx: Fixtures;
let n = 0;
const open = (...saves: string[]) => {
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of saves) addSave(s);
};
const make = (o: Partial<ReportOptions> = {}) => api.report(PUMP, { style: 'admin', lang: 'en', version: '2.1.2', ...o }, DEFAULT_RULES);
const headings = (html: string) => [...html.matchAll(/<h[12]>(.*?)<\/h[12]>/g)].map((m) => m[1]!.replace(/:.*/, ''));

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-report-')), true)));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('both styles in both languages: self-contained, the figures and commands of takeBack, German headings', () => {
  open(fx.legacy);
  api.mark(PUMP, { title: 'Pump', start: T0, pinned: true, dismissed: false, reason: '', note: 'Checked with the admins.' });
  const tb = api.takeBack(PUMP, DAY, DEFAULT_RULES);
  assert.ok(tb.rows.length > 1);
  const out: Record<string, string> = {};
  for (const style of ['admin', 'tech'] as const) for (const lang of ['en', 'de'] as const) out[style + lang] = make({ style, lang });
  for (const [k, html] of Object.entries(out)) {
    assert.match(html, /^<!doctype html>/, k);
    assert.doesNotMatch(html, /<script|http|src=|<link|<img|@import|url\(/i, k);
    for (const r of tb.rows) for (const v of [r.now, r.keep, r.take]) assert.ok(html.includes(money(v)), `${k}: ${money(v)} of account ${r.account}`);
    assert.ok(html.includes(money(tb.rows.reduce((s, r) => s + r.take, 0n))), `${k}: the total`);
    for (const line of commands(tb.rows, '2.1.2')) assert.ok(html.includes(line), `${k}: ${line}`);
    assert.ok(html.includes('Checked with the admins.'), `${k}: the pin's note`);
    assert.doesNotMatch(html, /\d,\d{3}/, `${k}: the apostrophe format`);
    assert.doesNotMatch(html, /\$[\d.']+[MB]\b/, `${k}: amounts in full`);
  }
  const en = new Set([...headings(out.adminen!), ...headings(out.techen!)]);
  for (const k of ['adminde', 'techde']) {
    assert.deepEqual(headings(out[k]!).filter((x) => en.has(x)), [], `${k}: English headings left`);
    assert.doesNotMatch(out[k]!, /ß/);
    assert.doesNotMatch(out[k]!, /logged no admin action/); // the 2.1.2 note is German too
    assert.match(out[k]!, /\d{1,2}\. (Jan\.|Feb\.|März|Apr\.|Mai|Juni|Juli|Aug\.|Sept\.|Okt\.|Nov\.|Dez\.) \d{4}, \d{2}:\d{2}/);
  }
  assert.match(out.adminen!, /logged no admin action/);
  // Technical adds the findings with their record ids, the coverage, the warnings and the versions.
  assert.ok(!out.adminen!.includes('Every finding of the incident'));
  for (const s of ['Every finding of the incident', 'Order ids', 'Coverage of the loaded saves', 'Warnings from loading']) assert.ok(out.techen!.includes(s), s);
  assert.match(out.techen!, /Audit Tool \d+\.\d+\.\d+/);
  assert.match(out.techen!, /BankSystem (2\.1\.2|not recorded in this save)/);
  // 2.2.0 freezes the accounts by number around the lines.
  assert.ok(make({ version: '2.2.0' }).includes(`/banksystem freeze ${PLAYERS.Tavrik.account} on`));
  // Unknown options fall back to the defaults instead of failing.
  assert.ok(api.report(PUMP, { style: 'x', lang: 'fr', version: '9' } as never, DEFAULT_RULES).includes('<html lang="en">'));
  assert.throws(() => api.report('nothing', { style: 'admin', lang: 'en', version: '2.1.2' }, DEFAULT_RULES), /not raised/);
});

test('every string from a save or the case is escaped', () => {
  open(fx.legacy);
  const db = new DatabaseSync(cacheFile(fx.legacy));
  db.prepare('UPDATE player SET name = ? WHERE uuid = ?').run(EVIL, tavrik);
  db.close();
  api.mark(PUMP, { title: EVIL, start: T0, pinned: true, dismissed: false, reason: '', note: `${EVIL} & "quoted"` });
  for (const style of ['admin', 'tech'] as const) {
    const html = make({ style });
    assert.ok(html.includes('&#60;img src=x onerror=alert(1)&#62;'), style);
    assert.doesNotMatch(html, /<img/i, style);
    assert.ok(html.includes('&#38; &#34;quoted&#34;'), style);
  }
});
