// The CSV builder (AT-44): RFC 4180 quoting, CRLF, the byte order mark, numbers in full and untouched, formulas made text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csv, csvName, SEP, stamp, zone, type Column } from '../../src/shared/csv.ts';

const lines = (text: string) => text.slice(1).split('\r\n');

test('the byte order mark, CRLF after every line, quotes only where a field needs them', () => {
  const out = csv({ columns: [['Name', 'text'], ['Note', 'text']], rows: [['plain', `has ${SEP} and "quotes"`], ['two\nlines', null]] });
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.ok(out.endsWith('\r\n') && !out.includes('\r\n\r\n'));
  assert.deepEqual(lines(out), ['Name,Note', `plain,"has ${SEP} and ""quotes"""`, '"two\nlines",', '']);
});

test('numbers in full through fmt, negative numbers untouched, times in this computer\'s zone named in the header', () => {
  const columns: Column[] = [['Take back ($)', 'money'], ['Items', 'quantity'], ['Orders', 'count'], ['Swing', 'number'], ['When', 'time'], ['Account', 'id']];
  const big = 1_154_255_602_798_123_456n; // more than 15 digits: a double would lose the last ones
  const t = new Date(2026, 10, 4, 9, 5, 7).getTime();
  const out = lines(csv({ columns, rows: [[-153205n, 1250n, 14100254, 12.345, t, 1234], [big, 64000n, 0, 2, null, null]] }));
  assert.equal(out[0], `Take back ($),Items,Orders,Swing,When (${zone()}),Account`);
  assert.equal(out[1], "-1'532.05,12.5,14'100'254,12.35,2026-11-04 09:05:07,1234");
  assert.equal(out[2], "11'542'556'027'981'234.56,640,0,2,,");
  assert.equal(stamp(t), '2026-11-04 09:05:07');
});

test('a text cell a spreadsheet would run as a formula starts with an apostrophe; ids and names that are fine stay', () => {
  const evil = ['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tx', '\rx', 'fine', 'a=b'];
  const out = lines(csv({ columns: [['Player', 'text'], ['Id', 'id']], rows: evil.map((e) => [e, e]) }));
  assert.deepEqual(out.slice(1, -1), [
    `"'=HYPERLINK(""http://x"")","'=HYPERLINK(""http://x"")"`, "'+1,'+1", "'-2+3,'-2+3", "'@SUM(A1),'@SUM(A1)", "'\tx,'\tx", `"'\rx","'\rx"`, 'fine,fine', 'a=b,a=b',
  ]);
});

test('the proposed file name: screen, table and today', () => {
  assert.equal(csvName('players', 'orders', new Date(2026, 10, 13, 23, 59).getTime()), 'players-orders-2026-11-13.csv');
});
