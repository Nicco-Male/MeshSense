import assert from 'node:assert/strict'
import { create, toBinary } from '@bufbuild/protobuf'
import { Protobuf } from '../../meshtastic-js/dist'
import {
  calculateHopsUsed,
  filterPackets,
  normalizeDestinationId,
  normalizeNodeId,
  normalizePacket,
  normalizeNode,
  getCurrentNodeSnapshot,
  getTraceRouteSnapshot,
  getPacketSnapshot,
  ensureTraceHistoryBootstrapped,
  normalizeRadioMetrics,
  recordPacket,
  runtimeStore,
  unixSecondsToIso,
  type NormalizedPacket
} from './publicApi'
import { nodes, packets as packetHistory } from '../vars'
import { parseBoolEnv, runtimeFlags } from './runtimeFlags'

process.env.MESHSENSE_TEST_BOOL = 'false'
assert.equal(parseBoolEnv('MESHSENSE_TEST_BOOL', true), false)
process.env.MESHSENSE_TEST_BOOL = 'on'
assert.equal(parseBoolEnv('MESHSENSE_TEST_BOOL', false), true)
delete process.env.MESHSENSE_TEST_BOOL
assert.equal(parseBoolEnv('MESHSENSE_TEST_BOOL', true), true)

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

const tracerouteVariant = normalizePacket({
  id: 70,
  rxTime: 1000,
  app: 'TRACEROUTE_APP',
  traceRoutes: [{ direction: 'towards', nodes: ['!00000001', '!00000002'], snr: [-12] }]
})
assert.equal(tracerouteVariant.portnum, 70)
assert.equal(tracerouteVariant.app, 'TRACEROUTE_APP')
assert.equal(filterPackets([tracerouteVariant], { portnum: 70 }).length, 1)

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
  route: ['!1234abcd', '!00000001', '!00000002'],
  routeBack: ['!00000002', '!1234abcd'],
  snrTowards: [6, -0.5],
  snrBack: [3.5]
})
assert.deepEqual(traceroutePacket.traceRoutes, [
  { direction: 'towards', nodes: ['!1234abcd', '!00000001', '!00000002'], snr: [6, -0.5] },
  { direction: 'back', nodes: ['!00000002', '!1234abcd'], snr: [3.5] }
])
assert.deepEqual(traceroutePacket.traceRoute, ['!1234abcd', '!00000001', '!00000002'])

runtimeStore.traceRoutes.clear()
recordPacket({
  id: 100,
  rxTime: 1001,
  from: 0x1234abcd,
  to: 0x00000002,
  payloadVariant: { case: 'decoded', value: { portnum: 70, payload: routeDiscoveryPayload } }
})
assert.equal(getTraceRouteSnapshot().length, 1)
assert.deepEqual(getTraceRouteSnapshot()[0].traceRoutes?.[0].nodes, ['!1234abcd', '!00000001', '!00000002'])
recordPacket({
  id: 100,
  rxTime: 1002,
  from: 0x1234abcd,
  to: 0x00000002,
  payloadVariant: { case: 'decoded', value: { portnum: 70, payload: routeDiscoveryPayload } }
})
assert.equal(getTraceRouteSnapshot().length, 1)
runtimeStore.traceRoutes.clear()

runtimeStore.nodes.clear()
runtimeStore.nodes.set(0x1234abcd, {
  num: 0x1234abcd,
  id: '!1234abcd',
  shortName: 'RT',
  latitude: 45.1,
  longitude: 9.1,
  lastHeard: unixSecondsToIso(1000),
  lastHeardSec: 1000,
  rssi: -90
})
nodes.set([
  {
    num: 0x1234abcd,
    lastHeard: 900,
    snr: 7,
    user: { id: '!1234abcd', longName: 'State Long', shortName: 'ST', role: 1 },
    position: { latitudeI: 451234567, longitudeI: 91234567 },
    trace: { route: [0x1234abcd, 1] }
  } as any,
  {
    num: 2,
    lastHeard: 2000,
    user: { id: '!00000002', longName: 'Newest', shortName: 'NW' }
  } as any
])
const snapshot = getCurrentNodeSnapshot()
assert.deepEqual(snapshot.map((node) => node.id), ['!00000002', '!1234abcd'])
assert.equal(snapshot.length, 2)
assert.equal(snapshot[1].longName, 'State Long')
assert.equal(snapshot[1].shortName, 'ST')
assert.equal(snapshot[1].lastHeardSec, 1000)
assert.equal(snapshot[1].rssi, -90)
assert.equal(snapshot[1].snr, 7)
assert.equal(snapshot[1].latitude, 45.1234567)
assert.equal(snapshot[1].longitude, 9.1234567)
assert.equal(normalizeNode({ num: 3, latitude_i: 451000000, longitude_i: 91000000 }).latitude, 45.1)
assert.equal(normalizeNode({ num: 3, position: { latitude: 45.2, longitude: 9.2 } }).longitude, 9.2)
assert.deepEqual(snapshot[1].trace, { route: [0x1234abcd, 1] })
assert.equal(runtimeStore.nodesSeen, 2)
nodes.set([] as any)
runtimeStore.nodes.clear()
runtimeStore.nodesSeen = 0


runtimeStore.traceRoutes.clear()
runtimeStore.packets = []
runtimeStore.historyBootstrapped = false
packetHistory.set([
  {
    id: 101,
    rxTime: 1003,
    from: 0x1234abcd,
    to: 0x00000002,
    data: {
      $typeName: 'meshtastic.RouteDiscovery',
      route: [0x1234abcd, 0x00000001, 0x00000002],
      routeBack: [0x00000002, 0x00000001, 0x1234abcd],
      snrTowards: [6, -0.5],
      snrBack: [3.5, 2, 1]
    }
  } as any
])
ensureTraceHistoryBootstrapped()
assert.equal(getTraceRouteSnapshot().length, 1)
assert.equal(getPacketSnapshot().filter((packet) => String(packet.portnum) == '70' && packet.routeDiscovery).length, 1)
assert.deepEqual(getTraceRouteSnapshot()[0].traceRoutes?.map((route) => route.nodes), [
  ['!1234abcd', '!00000001', '!00000002'],
  ['!00000002', '!00000001', '!1234abcd']
])
packetHistory.set([] as any)
runtimeStore.traceRoutes.clear()
runtimeStore.packets = []
runtimeStore.historyBootstrapped = false

const previousTraceHistoryFlag = runtimeFlags.enableTraceHistory
runtimeFlags.enableTraceHistory = false
runtimeStore.traceRoutes.clear()
runtimeStore.packets = []
runtimeStore.historyBootstrapped = false
packetHistory.set([
  {
    id: 102,
    rxTime: 1004,
    from: 0x1234abcd,
    to: 0x00000002,
    traceRoutes: [{ direction: 'towards', nodes: ['!1234abcd', '!00000002'], snr: [1] }]
  } as any
])
ensureTraceHistoryBootstrapped(true)
assert.deepEqual(getTraceRouteSnapshot(), [])
assert.equal(getPacketSnapshot().length, 0)
recordPacket({
  id: 103,
  rxTime: 1005,
  from: 0x1234abcd,
  to: 0x00000002,
  traceRoutes: [{ direction: 'towards', nodes: ['!1234abcd', '!00000002'], snr: [1] }]
})
assert.equal(getPacketSnapshot().length, 1)
assert.deepEqual(getTraceRouteSnapshot(), [])
runtimeFlags.enableTraceHistory = previousTraceHistoryFlag
packetHistory.set([] as any)
runtimeStore.traceRoutes.clear()
runtimeStore.packets = []
runtimeStore.historyBootstrapped = false

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
