// The one number and time format of the tool (DESIGN_SPEC rules 9 and 10).
// Every number a person sees goes through here: apostrophe between thousands, point before decimals, 1'532.05.
// Amounts are bigints in the mods' raw unit (real value x 100) and never pass through a floating-point number.

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
const abs = (v: bigint) => (v < 0n ? -v : v);

/** A whole number: 14100254 -> 14'100'254 */
export function count(n: bigint | number): string {
  const v = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
  return (v < 0n ? '-' : '') + group(abs(v).toString());
}

/** A raw amount with both decimals: 153205n -> 1'532.05 */
export function amount(raw: bigint): string {
  const a = abs(raw);
  return (raw < 0n ? '-' : '') + group((a / 100n).toString()) + '.' + (a % 100n).toString().padStart(2, '0');
}

/** A raw item count, decimals only when there are any: 64000n -> 640, 1250n -> 12.5 */
export function items(raw: bigint): string {
  const text = amount(raw);
  return text.endsWith('.00') ? text.slice(0, -3) : text.endsWith('0') ? text.slice(0, -1) : text;
}

/** Raw money in full: 153205n -> $1'532.05, -153205n -> -$1'532.05 */
export function money(raw: bigint): string {
  return (raw < 0n ? '-$' : '$') + amount(abs(raw));
}

const MILLION = 100_000_000n; // one million dollars in raw units
const BILLION = 100_000_000_000n;

/** Raw money shortened for headlines: $29.43B, $192M. Below a million it stays in full. Exports never use this. */
export function moneyShort(raw: bigint): string {
  const a = abs(raw);
  if (a < MILLION) return money(raw);
  let unit = a >= BILLION ? BILLION : MILLION;
  let hundredths = (a * 100n + unit / 2n) / unit; // rounded to two decimals, in whole numbers
  if (unit === MILLION && hundredths >= 100_000n) {
    unit = BILLION; // 999.996M rounds up to 1B, not to 1000M
    hundredths = (a * 100n + unit / 2n) / unit;
  }
  const decimals = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return (raw < 0n ? '-$' : '$') + group((hundredths / 100n).toString()) + (decimals ? '.' + decimals : '') + (unit === BILLION ? 'B' : 'M');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** A moment (epoch ms): 4 Nov 2026, 10:21:07, or 10:21:07.412 with millis (orders placed by a script are milliseconds apart). In the computer's time zone unless utc is set. */
export function time(ms: number, utc = false, millis = false): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  const [day, month, year, h, m, s] = utc
    ? [d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getDate(), d.getMonth(), d.getFullYear(), d.getHours(), d.getMinutes(), d.getSeconds()];
  return `${day} ${MONTHS[month]} ${year}, ${two(h)}:${two(m)}:${two(s)}` + (millis ? '.' + String(d.getMilliseconds()).padStart(3, '0') : '');
}

/** A file size: 736100352 -> 702 MB */
export function bytes(n: number): string {
  if (n < 1024) return count(n) + ' bytes';
  if (n < 1_048_576) return count(Math.round(n / 1024)) + ' KB';
  return count(Math.round(n / 1_048_576)) + ' MB';
}
