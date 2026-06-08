import assert from 'node:assert/strict'
import { create, toBinary } from '@bufbuild/protobuf'
import { Protobuf } from '../../meshtastic-js/dist'
import {
  calculateHopsUsed,
  filterPackets,
  normalizeDestinationId,
  normalizeNodeId,
  normalizePacket,
  normalizeRadioMetrics,
  unixSecondsToIso,
  type NormalizedPacket
} from './publicApi'

assert.equal(normalizeNodeId(0x1234abcd), '!1234abcd')
assert.equal(normalizeNodeId(1), '!00000001')
assert.equal(normalizeNodeId(undefined, '!aabbccdd'), '!aabbccdd')
assert.equal(normalizeDestinationId(4294967295), '^all')
assert.equal(normalizeDestinationId(0x1234abcd), '!1234abcd')

assert.equal(calculateHopsUsed(5, 3), 2)
assert.equal(calculateHopsUsed(3, 3), 0)
assert.equal(calculateHopsUsed(0, 3), null)
assert.equal(calculateHopsUsed(2, 3), null)
assert.equal(calculateHopsUsed(undefined, 3), null)

assert.equal(unixSecondsToIso(0), '1970-01-01T00:00:00.000Z')
assert.equal(unixSecondsToIso(1000), '1970-01-01T00:16:40.000Z')

assert.deepEqual(normalizeRadioMetrics(0, 0), { rssi: null, snr: null, hasRadioMetrics: false })
assert.deepEqual(normalizeRadioMetrics(-87, 8.5), { rssi: -87, snr: 8.5, hasRadioMetrics: true })

const normalized = normalizePacket({
  id: 99,
  rxTime: 1000,
  from: 0x1234abcd,
  to: 4294967295,
  channel: 0,
  hopStart: 0,
  hopLimit: 3,
  rxRssi: 0,
  rxSnr: 0,
  payloadVariant: { case: 'decoded', value: { portnum: 1 } }
})
assert.equal(normalized.rxTime, '1970-01-01T00:16:40.000Z')
assert.equal(normalized.rxTimeSec, 1000)
assert.equal(normalized.fromId, '!1234abcd')
assert.equal(normalized.toId, '^all')
assert.equal(normalized.app, 'TEXT_MESSAGE_APP')
assert.equal(normalized.type, 'text')
assert.equal(normalized.hopsUsed, null)
assert.equal(normalized.rssi, null)
assert.equal(normalized.snr, null)
assert.equal(normalized.hasRadioMetrics, false)
assert.equal(normalized.traceRoutes, undefined)

const routeDiscoveryPayload = toBinary(
  Protobuf.Mesh.RouteDiscoverySchema,
  create(Protobuf.Mesh.RouteDiscoverySchema, {
    route: [0x1234abcd, 0x00000001],
    snrTowards: [24, -2],
    routeBack: [0x00000002],
    snrBack: [14]
  })
)
const traceroutePacket = normalizePacket({
  id: 100,
  rxTime: 1001,
  from: 0x1234abcd,
  to: 0x00000002,
  payloadVariant: { case: 'decoded', value: { portnum: 70, payload: routeDiscoveryPayload } }
})
assert.equal(traceroutePacket.app, 'TRACEROUTE_APP')
assert.equal(traceroutePacket.type, 'traceroute')
assert.deepEqual(traceroutePacket.routeDiscovery, {
  route: ['!1234abcd', '!00000001'],
  routeBack: ['!00000002'],
  snrTowards: [6, -0.5],
  snrBack: [3.5]
})
assert.deepEqual(traceroutePacket.traceRoutes, [
  { direction: 'towards', nodes: ['!1234abcd', '!00000001'], snr: [6, -0.5] },
  { direction: 'back', nodes: ['!00000002'], snr: [3.5] }
])
assert.deepEqual(traceroutePacket.traceRoute, ['!1234abcd', '!00000001'])

const packets: NormalizedPacket[] = [
  { id: 1, rxTime: unixSecondsToIso(100), rxTimeSec: 100, from: 10, to: 20, portnum: 1, raw: {} },
  { id: 2, rxTime: unixSecondsToIso(200), rxTimeSec: 200, from: 11, to: 20, portnum: 1, raw: {} },
  { id: 3, rxTime: unixSecondsToIso(300), rxTimeSec: 300, from: 10, to: 21, portnum: 2, raw: {} },
  { id: 4, rxTime: unixSecondsToIso(400), rxTimeSec: 400, from: 10, to: 20, portnum: 1, raw: {} }
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
