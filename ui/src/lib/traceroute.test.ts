import assert from 'node:assert/strict'
import { buildTraceroutePolyline, type TracerouteDebugEvent } from './traceroute'
import type { NodeInfo } from 'api/src/vars'

function node(num: number, shortName: string, longitude: number, latitude: number): NodeInfo {
  return {
    num,
    user: { shortName, longName: `${shortName} long`, id: `!${num.toString(16).padStart(8, '0')}` } as any,
    position: { longitudeI: longitude * 10000000, latitudeI: latitude * 10000000 } as any
  } as NodeInfo
}

const nodes = [node(1, 'Nmob', 10, 45), node(2, 'N-Pi', 11, 46), node(3, 'B', 12, 47), ({ ...node(4, 'NoGPS', 13, 48), position: undefined } as NodeInfo)]
let logs: TracerouteDebugEvent[] = []
const logger = (event: TracerouteDebugEvent) => logs.push(event)

logs = []
assert.deepEqual(
  buildTraceroutePolyline({ nodes, source: 'Nmob', destination: 'N-Pi', trace: { route: [] }, logger }),
  [
    [10, 45],
    [11, 46]
  ],
  'direct RouteDiscovery without intermediate hops draws source -> destination'
)
assert.deepEqual(logs, [])

logs = []
assert.deepEqual(
  buildTraceroutePolyline({ nodes, source: 1, destination: 2, trace: { route: [3] }, logger }),
  [
    [10, 45],
    [12, 47],
    [11, 46]
  ],
  'RouteDiscovery with an intermediate hop draws a segmented line'
)
assert.deepEqual(logs, [])

logs = []
assert.deepEqual(
  buildTraceroutePolyline({ nodes, source: '!00000001', destination: '!00000002', trace: { route: [4, '!000000ff'] }, logger }),
  [
    [10, 45],
    [11, 46]
  ],
  'RouteDiscovery skips unresolved/no-coordinate intermediate hops but still draws source -> destination'
)
assert.deepEqual(
  logs.map((event) => event.reason),
  ['unresolved hop node', 'unresolved hop node']
)

logs = []
assert.equal(buildTraceroutePolyline({ nodes, source: 'missing', destination: 'N-Pi', trace: { route: [] }, logger }), undefined)
assert.deepEqual(logs.map((event) => event.reason), ['missing source node'])

logs = []
assert.equal(buildTraceroutePolyline({ nodes, source: 'Nmob', destination: 'missing', trace: { route: [] }, logger }), undefined)
assert.deepEqual(logs.map((event) => event.reason), ['missing destination node'])


logs = []
assert.equal(buildTraceroutePolyline({ nodes, source: 'NoGPS', destination: 'N-Pi', trace: { route: [] }, logger }), undefined)
assert.deepEqual(logs.map((event) => event.reason), ['missing source coordinates'])

logs = []
assert.equal(buildTraceroutePolyline({ nodes, source: 'Nmob', destination: 'NoGPS', trace: { route: [] }, logger }), undefined)
assert.deepEqual(logs.map((event) => event.reason), ['missing destination coordinates'])

console.log('traceroute tests passed')
