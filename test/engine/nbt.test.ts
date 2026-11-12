import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { big, compound, flag, list, num, readNbt, str, uuidFromHalves, uuidFromInts } from '../../src/engine/save/nbt.ts';
import { byte, comp, int, list as nbtList, long, nbtFile, short, str as nbtStr, uuid } from '../fixtures/nbt.ts';

const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-000000000001';

test('reads every kind of value, packed or not', () => {
  const root = {
    name: nbtStr('Tavrik'), admin: byte(true), id: short(-7), count: int(123456), raw: long(9223372036854775807n),
    user: uuid(UUID), inner: comp({ deep: nbtList([int(1), int(2), int(3)]) }), empty: nbtList([]),
  };
  for (const packed of [true, false]) {
    const n = readNbt(nbtFile(root, packed));
    assert.equal(str(n, 'name'), 'Tavrik');
    assert.equal(flag(n, 'admin'), true);
    assert.equal(num(n, 'id'), -7);
    assert.equal(num(n, 'count'), 123456);
    assert.equal(big(n, 'raw'), 9223372036854775807n); // a long keeps every digit
    assert.equal(uuidFromInts(n.user), UUID);
    assert.deepEqual(list(compound(n, 'inner'), 'deep'), [1, 2, 3]);
    assert.deepEqual(list(n, 'empty'), []);
  }
});

test('a missing tag or a tag of another type is "not there", never a crash', () => {
  const n = readNbt(nbtFile({ name: int(5) }));
  assert.equal(str(n, 'name'), undefined);
  assert.equal(str(n, 'nothing'), undefined);
  assert.equal(compound(n, 'name'), undefined);
  assert.deepEqual(list(n, 'name'), []);
  assert.equal(uuidFromInts(n.name), undefined);
});

test('uuid halves as the market database stores them', () => {
  assert.equal(uuidFromHalves(BigInt.asIntN(64, 0xa1b2c3d4e5f64a7bn), BigInt.asIntN(64, 0x8c9d000000000001n)), UUID);
});

test('damaged and hostile files are refused in plain words', () => {
  const good = nbtFile({ a: nbtList([int(1), int(2)]) }, false);
  assert.throws(() => readNbt(good.subarray(0, good.length - 3)), /not valid NBT/);
  assert.throws(() => readNbt(Buffer.from([3, 0, 0])), /does not start with a compound/);
  // a list that claims two billion elements in a file of a few bytes
  const lie = Buffer.concat([Buffer.from([10, 0, 0, 9, 0, 1, 0x61, 3, 0x7f, 0xff, 0xff, 0xff]), Buffer.alloc(4)]);
  assert.throws(() => readNbt(lie), /ends in the middle/);
  // nesting deeper than the limit: 600 lists inside each other
  const deep = Buffer.concat([Buffer.from([10, 0, 0, 9, 0, 1, 0x61]), ...Array.from({ length: 600 }, () => Buffer.from([9, 0, 0, 0, 1])), Buffer.from([0, 0, 0, 0, 0, 0])]);
  assert.throws(() => readNbt(deep), /deeper than 512/);
  // a small packed file that unpacks to more than the limit
  const bomb = zlib.gzipSync(Buffer.alloc(300 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024);
  assert.throws(() => readNbt(bomb), /could not be unpacked/);
});
