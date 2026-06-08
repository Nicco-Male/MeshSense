import assert from 'node:assert/strict'
import { calculateHopsUsed, filterPackets, normalizeNodeId, type NormalizedPacket } from './publicApi'

assert.equal(normalizeNodeId(0x1234abcd), '!1234abcd')
assert.equal(normalizeNodeId(1), '!00000001')
assert.equal(normalizeNodeId(undefined, '!aabbccdd'), '!aabbccdd')
assert.equal(calculateHopsUsed(5, 3), 2)
assert.equal(calculateHopsUsed(undefined, 3), undefined)

const packets: NormalizedPacket[] = [
  { id: 1, rxTime: 100, from: 10, to: 20, portnum: 1, raw: {} },
  { id: 2, rxTime: 200, from: 11, to: 20, portnum: 1, raw: {} },
  { id: 3, rxTime: 300, from: 10, to: 21, portnum: 2, raw: {} },
  { id: 4, rxTime: 400, from: 10, to: 20, portnum: 1, raw: {} }
]

assert.deepEqual(
  filterPackets(packets, { limit: 2 }).map((packet) => packet.id),
  [3, 4]
)
assert.deepEqual(
  filterPackets(packets, { from: 10, to: 20, portnum: 1, since: 150 }).map((packet) => packet.id),
  [4]
)

console.log('publicApi pure function tests passed')
