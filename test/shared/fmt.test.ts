import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amount, bytes, count, items, money, moneyShort, time } from '../../src/shared/fmt.ts';

test('apostrophe between thousands, point before decimals', () => {
  assert.equal(amount(153205n), "1'532.05");
  assert.equal(amount(100000n), "1'000.00");
  assert.equal(amount(5n), '0.05');
  assert.equal(amount(-153205n), "-1'532.05");
  assert.equal(count(14100254), "14'100'254");
  assert.equal(count(999), '999');
  assert.equal(count(-1000n), "-1'000");
});

test('money in full and shortened', () => {
  assert.equal(money(153205n), "$1'532.05");
  assert.equal(money(-153205n), "-$1'532.05");
  assert.equal(money(1154255602700n), "$11'542'556'027.00");
  assert.equal(moneyShort(2_943_000_000_000n), '$29.43B');
  assert.equal(moneyShort(19_200_000_000n), '$192M');
  assert.equal(moneyShort(-714_000_000_000n), '-$7.14B');
  assert.equal(moneyShort(1_240_000n), "$12'400.00"); // below a million: in full
  assert.equal(moneyShort(99_999_600_000n), '$1B'); // 999.996M rounds up to the next unit
});

test('item counts drop empty decimals', () => {
  assert.equal(items(64000n), '640');
  assert.equal(items(1250n), '12.5');
  assert.equal(items(1205n), '12.05');
  assert.equal(items(123456700n), "1'234'567");
});

test('amounts beyond what a floating-point number holds stay exact', () => {
  // 2^63 - 1, the largest value a save can contain. A float would turn the last digits into 808.
  assert.equal(amount(9223372036854775807n), "92'233'720'368'547'758.07");
  assert.equal(moneyShort(9223372036854775807n), "$92'233'720.37B");
});

test('time and file size', () => {
  assert.equal(time(Date.UTC(2026, 10, 4, 10, 21, 7), true), '4 Nov 2026, 10:21:07');
  assert.equal(time(Date.UTC(2026, 8, 30, 0, 0, 0), true), '30 Sep 2026, 00:00:00');
  assert.equal(time(Number.NaN), 'unknown time');
  assert.equal(bytes(736_100_352), '702 MB');
  assert.equal(bytes(1_252_000_000), "1'194 MB");
  assert.equal(bytes(2048), '2 KB');
});
