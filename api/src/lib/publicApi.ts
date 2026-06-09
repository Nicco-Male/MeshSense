import type { Express } from 'express'
import { Server } from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import EventEmitter from 'eventemitter3'
import { parse } from 'url'
import { fromBinary } from '@bufbuild/protobuf'
import { Protobuf } from '../../meshtastic-js/dist'
import { address, channels, connectionStatus, messageHistory, nodes, packets, type Channel, type MeshPacket, type NodeInfo } from '../vars'
import { getAllKeyValues } from './persistence'

export type NormalizedNode = {
  num?: number
  id?: string
  longName?: string
  shortName?: string
  lastHeard?: string | null
  lastHeardSec?: number | null
  snr?: number | null
  rssi?: number | null
  latitude?: number
  longitude?: number
  role?: string | number
  user?: { longName?: string; shortName?: string; [key: string]: any }
  position?: any
  trace?: any
}

export type NormalizedTraceRoute = {
  direction: 'towards' | 'back'
  nodes: string[]
  snr: number[]
}

export type NormalizedRouteDiscovery = {
  route: string[]
  routeBack: string[]
  snrTowards: number[]
  snrBack: number[]
}

export type NormalizedPacket = {
  id?: number | string
  rxTime?: string | null
  rxTimeSec?: number | null
  from?: number
  fromId?: string
  to?: number
  toId?: string
  channel?: number | string
  portnum?: number | string
  app?: string
  type?: string
  rssi?: number | null
  snr?: number | null
  hasRadioMetrics?: boolean
  hopLimit?: number
  hopStart?: number
  hopsUsed?: number | null
  routeDiscovery?: NormalizedRouteDiscovery
  traceRoutes?: NormalizedTraceRoute[]
  traceRoute?: string[]
  nodeMetadata?: Record<string, Pick<NormalizedNode, 'id' | 'shortName' | 'longName' | 'latitude' | 'longitude'>>
  raw: any
}

export type NormalizedMessage = {
  id?: number | string
  rxTime?: string | null
  rxTimeSec?: number | null
  from?: number
  fromId?: string
  to?: number
  toId?: string
  channel?: number | string
  text?: string
  portnum?: number | string
  app?: string
  type?: string
  packet?: NormalizedPacket
  raw: any
}

type PacketFilters = {
  limit?: number | string
  from?: number | string
  to?: number | string
  portnum?: number | string
  since?: number | string
}

type RuntimeStore = {
  startedAt: string
  lastPacketAt?: string
  packetsSeen: number
  nodesSeen: number
  packets: NormalizedPacket[]
  messages: NormalizedMessage[]
  nodes: Map<number | string, NormalizedNode>
  traceRoutes: Map<string, NormalizedPacket>
  historyBootstrapped: boolean
  historySourceCount: number
}

export const publicApiEvents = new EventEmitter<{
  packet_rx: (packet: NormalizedPacket) => void
  node_update: (node: NormalizedNode) => void
  message_rx: (message: NormalizedMessage) => void
}>()

export const runtimeStore: RuntimeStore = {
  startedAt: new Date().toISOString(),
  packetsSeen: 0,
  nodesSeen: 0,
  packets: [],
  messages: [],
  nodes: new Map(),
  traceRoutes: new Map(),
  historyBootstrapped: false,
  historySourceCount: 0
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue == 'bigint') return Number(nestedValue)
      if (nestedValue instanceof Uint8Array) return Array.from(nestedValue)
      return nestedValue
    })
  )
}

function compact<T extends Record<string, any>>(value: T): T {
  for (let key of Object.keys(value)) {
    if (value[key] === undefined || Number.isNaN(value[key])) delete value[key]
  }
  return value
}

function numeric(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseTime(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let numericValue = Number(value)
  if (Number.isFinite(numericValue)) return numericValue > 100000000000 ? numericValue / 1000 : numericValue
  let parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed / 1000 : undefined
}

function packetTime(packet: NormalizedPacket): number | undefined {
  return packet.rxTimeSec ?? parseTime(packet.rxTime)
}

function normalizeLimit(value: any, defaultValue: number, maxValue: number) {
  let limit = Number(value ?? defaultValue)
  if (!Number.isFinite(limit) || limit < 1) return defaultValue
  return Math.min(Math.floor(limit), maxValue)
}

export function normalizeNodeId(num?: number | string, userId?: string): string | undefined {
  if (typeof userId == 'string' && userId.startsWith('!')) return userId
  let parsed = numeric(num)
  if (parsed === undefined) return userId
  return `!${(parsed >>> 0).toString(16).padStart(8, '0')}`
}

export function normalizeDestinationId(num?: number | string): string | undefined {
  let parsed = numeric(num)
  if (parsed == 4294967295) return '^all'
  return normalizeNodeId(num)
}

export function unixSecondsToIso(value?: number | string): string | null {
  let seconds = parseTime(value)
  if (seconds === undefined) return null
  return new Date(seconds * 1000).toISOString()
}

export function calculateHopsUsed(hopStart?: number, hopLimit?: number): number | null {
  if (hopStart === undefined || hopLimit === undefined) return null
  if (!Number.isFinite(hopStart) || !Number.isFinite(hopLimit)) return null
  if (hopStart <= 0 || hopLimit < 0 || hopStart < hopLimit) return null
  return hopStart - hopLimit
}

export function normalizeRadioMetrics(rxRssi?: number, rxSnr?: number) {
  if (rxRssi === undefined && rxSnr === undefined) return { rssi: null, snr: null, hasRadioMetrics: false }
  if (rxRssi === 0 && rxSnr === 0) return { rssi: null, snr: null, hasRadioMetrics: false }
  return { rssi: rxRssi ?? null, snr: rxSnr ?? null, hasRadioMetrics: true }
}


function parsePayloadBytes(payload?: Uint8Array | number[] | Record<string, number>): Uint8Array | undefined {
  if (!payload) return undefined
  if (payload instanceof Uint8Array) return payload
  if (Array.isArray(payload)) return Uint8Array.from(payload)

  return Uint8Array.from(
    Object.entries(payload)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => value)
  )
}

function normalizeRouteNodeIds(route?: unknown[]): string[] {
  if (!Array.isArray(route)) return []
  return route.map((nodeNum) => normalizeNodeId(nodeNum as number | string)).filter((nodeId): nodeId is string => !!nodeId)
}

function normalizeScaledSnr(snr?: unknown[]): number[] {
  if (!Array.isArray(snr)) return []
  return snr.map((value) => numeric(value)).filter((value): value is number => value !== undefined).map((value) => value / 4)
}

function normalizeSnrArray(snr?: unknown[]): number[] {
  if (!Array.isArray(snr)) return []
  return snr.map((value) => numeric(value)).filter((value): value is number => value !== undefined)
}

function normalizeExistingRouteDiscovery(value: any, scaleSnr = false): NormalizedRouteDiscovery | undefined {
  if (!value || typeof value != 'object') return undefined
  let route = normalizeRouteNodeIds(value.route)
  let routeBack = normalizeRouteNodeIds(value.routeBack ?? value.back)
  if (route.length < 2 && routeBack.length < 2) return undefined
  return {
    route,
    routeBack,
    snrTowards: scaleSnr ? normalizeScaledSnr(value.snrTowards ?? value.snr) : normalizeSnrArray(value.snrTowards ?? value.snr),
    snrBack: scaleSnr ? normalizeScaledSnr(value.snrBack) : normalizeSnrArray(value.snrBack)
  }
}

function normalizeExistingTraceRoutes(value: any): NormalizedTraceRoute[] | undefined {
  if (!Array.isArray(value)) return undefined
  let routes = value
    .map((route): NormalizedTraceRoute | undefined => {
      let nodes = normalizeRouteNodeIds(route?.nodes ?? route?.route)
      if (nodes.length < 2) return undefined
      return {
        direction: route?.direction == 'back' ? 'back' : 'towards',
        nodes,
        snr: normalizeSnrArray(route?.snr)
      }
    })
    .filter((route): route is NormalizedTraceRoute => !!route)
  return routes.length ? routes : undefined
}

function decodeRouteDiscovery(packet: any, portnum?: number | string): NormalizedRouteDiscovery | undefined {
  if (numeric(portnum) != 70) return undefined

  let decoded = getPacketDecoded(packet)
  let payload = parsePayloadBytes(decoded?.payload)
  if (!payload?.length) return undefined

  let routeDiscovery = fromBinary(Protobuf.Mesh.RouteDiscoverySchema, payload)

  return {
    route: normalizeRouteNodeIds(routeDiscovery.route),
    routeBack: normalizeRouteNodeIds(routeDiscovery.routeBack),
    snrTowards: normalizeScaledSnr(routeDiscovery.snrTowards),
    snrBack: normalizeScaledSnr(routeDiscovery.snrBack)
  }
}


function includeEndpoint(route: string[], endpoint: string | undefined, side: 'start' | 'end'): string[] {
  if (!endpoint || endpoint == '^all') return route
  if (!route.length) return route
  if (side == 'start') return route[0] == endpoint ? route : [endpoint, ...route]
  return route[route.length - 1] == endpoint ? route : [...route, endpoint]
}

function includeRouteDiscoveryEndpoints(routeDiscovery: NormalizedRouteDiscovery | undefined, fromId?: string, toId?: string): NormalizedRouteDiscovery | undefined {
  if (!routeDiscovery) return undefined
  return {
    ...routeDiscovery,
    route: includeEndpoint(includeEndpoint(routeDiscovery.route, fromId, 'start'), toId, 'end'),
    routeBack: includeEndpoint(includeEndpoint(routeDiscovery.routeBack, toId, 'start'), fromId, 'end')
  }
}

function buildTraceRoutes(routeDiscovery?: NormalizedRouteDiscovery): NormalizedTraceRoute[] | undefined {
  if (!routeDiscovery) return undefined
  return [
    { direction: 'towards', nodes: routeDiscovery.route, snr: routeDiscovery.snrTowards },
    { direction: 'back', nodes: routeDiscovery.routeBack, snr: routeDiscovery.snrBack }
  ]
}

function getPacketDecoded(packet: any) {
  return packet?.decoded ?? (packet?.payloadVariant?.case == 'decoded' ? packet.payloadVariant.value : undefined) ?? (packet?.variant?.case == 'decoded' ? packet.variant.value : undefined)
}

function getPacketPortnum(packet: any): number | string | undefined {
  let portnum = getPacketDecoded(packet)?.portnum ?? packet?.portnum ?? packet?.data?.portnum ?? packet?.Data?.portnum ?? packet?.raw?.decoded?.portnum ?? packet?.raw?.Data?.portnum ?? packet?.message?.portnum
  if (portnum !== undefined) return portnum
  let appOrType = packet?.app ?? packet?.type ?? packet?.raw?.app ?? packet?.raw?.type
  if (String(appOrType).toUpperCase() == 'TRACEROUTE_APP' || String(appOrType).toLowerCase() == 'traceroute') return 70
  if (packet?.data?.$typeName == 'meshtastic.RouteDiscovery' || packet?.Data?.$typeName == 'meshtastic.RouteDiscovery') return 70
  if (packet?.trace || packet?.routeDiscovery || packet?.traceRoutes || packet?.traceRoute) return 70
  return undefined
}

function getPacketAppType(portnum?: number | string, decoded?: any) {
  switch (numeric(portnum)) {
    case 1:
      return { app: 'TEXT_MESSAGE_APP', type: 'text' }
    case 3:
      return { app: 'POSITION_APP', type: 'position' }
    case 5:
      return { app: 'ROUTING_APP', type: 'routing' }
    case 67:
      return { app: 'TELEMETRY_APP', type: 'telemetry' }
    case 70:
      return { app: 'TRACEROUTE_APP', type: 'traceroute' }
    default:
      return { app: 'UNKNOWN_APP', type: decoded ? 'decoded' : 'unknown' }
  }
}

export function normalizePacket(packet: MeshPacket | any): NormalizedPacket {
  let safePacket = jsonSafe(packet)
  let decoded = getPacketDecoded(safePacket)
  let portnum = getPacketPortnum(safePacket)
  let { app, type } = getPacketAppType(portnum, decoded)
  let hopStart = numeric(safePacket.hopStart)
  let hopLimit = numeric(safePacket.hopLimit)
  let from = numeric(safePacket.from)
  let to = numeric(safePacket.to)
  let rxTimeSec = parseTime(safePacket.rxTime)
  let radioMetrics = normalizeRadioMetrics(numeric(safePacket.rxRssi ?? safePacket.rssi), numeric(safePacket.rxSnr ?? safePacket.snr))
  let fromId = normalizeNodeId(from, safePacket.fromId)
  let toId = normalizeDestinationId(to) ?? normalizeNodeId(safePacket.toId)
  let routeDiscovery = includeRouteDiscoveryEndpoints(
    decodeRouteDiscovery(safePacket, portnum) ??
      normalizeExistingRouteDiscovery(safePacket.routeDiscovery) ??
      normalizeExistingRouteDiscovery(safePacket.data, safePacket.data?.$typeName == 'meshtastic.RouteDiscovery') ??
      normalizeExistingRouteDiscovery(safePacket.Data, safePacket.Data?.$typeName == 'meshtastic.RouteDiscovery') ??
      normalizeExistingRouteDiscovery(safePacket.trace, safePacket.trace?.$typeName == 'meshtastic.RouteDiscovery'),
    fromId,
    toId
  )
  let traceRoutes = buildTraceRoutes(routeDiscovery) ?? normalizeExistingTraceRoutes(safePacket.traceRoutes) ?? normalizeExistingTraceRoutes(safePacket.data?.traceRoutes) ?? normalizeExistingTraceRoutes(safePacket.Data?.traceRoutes)
  let traceRoute = routeDiscovery?.route ?? normalizeRouteNodeIds(safePacket.traceRoute ?? safePacket.data?.traceRoute ?? safePacket.Data?.traceRoute ?? safePacket.data?.route ?? safePacket.Data?.route ?? safePacket.trace?.route)
  if (!traceRoute.length) traceRoute = traceRoutes?.find((route) => route.direction == 'towards')?.nodes ?? []

  return compact({
    id: safePacket.id,
    rxTime: unixSecondsToIso(safePacket.rxTime),
    rxTimeSec: rxTimeSec ?? null,
    from,
    fromId,
    to,
    toId,
    channel: safePacket.channel,
    portnum,
    app,
    type,
    ...radioMetrics,
    hopLimit,
    hopStart,
    hopsUsed: calculateHopsUsed(hopStart, hopLimit),
    routeDiscovery,
    traceRoutes,
    traceRoute: traceRoute.length >= 2 ? traceRoute : undefined,
    raw: safePacket
  })
}

function coordinateValue(...values: any[]): number | undefined {
  for (let value of values) {
    let parsed = numeric(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function coordinateIValue(...values: any[]): number | undefined {
  let parsed = coordinateValue(...values)
  return parsed === undefined ? undefined : parsed / 10000000
}

export function normalizeNode(node: Partial<NodeInfo> | any): NormalizedNode {
  let safeNode = jsonSafe(node)
  let latitude = coordinateIValue(safeNode.position?.latitudeI, safeNode.latitudeI, safeNode.latitude_i, safeNode.user?.latitudeI, safeNode.user?.latitude_i) ??
    coordinateValue(safeNode.latitude, safeNode.position?.latitude, safeNode.user?.latitude, safeNode.raw?.latitude, safeNode.approximatePosition?.latitude)
  let longitude = coordinateIValue(safeNode.position?.longitudeI, safeNode.longitudeI, safeNode.longitude_i, safeNode.user?.longitudeI, safeNode.user?.longitude_i) ??
    coordinateValue(safeNode.longitude, safeNode.position?.longitude, safeNode.user?.longitude, safeNode.raw?.longitude, safeNode.approximatePosition?.longitude)
  let lastHeardSec = parseTime(safeNode.lastHeard)

  return compact({
    num: numeric(safeNode.num),
    id: normalizeNodeId(safeNode.num, safeNode.user?.id ?? safeNode.id),
    longName: safeNode.user?.longName ?? safeNode.longName,
    shortName: safeNode.user?.shortName ?? safeNode.shortName,
    lastHeard: unixSecondsToIso(safeNode.lastHeard),
    lastHeardSec: lastHeardSec ?? null,
    snr: numeric(safeNode.snr) ?? null,
    rssi: numeric(safeNode.rssi ?? safeNode.rxRssi) ?? null,
    latitude,
    longitude,
    role: safeNode.user?.role ?? safeNode.role,
    user: safeNode.user,
    position: safeNode.position,
    trace: safeNode.trace
  })
}

function extractText(message: any): string | undefined {
  if (typeof message?.message?.data == 'string') return message.message.data
  if (typeof message?.message?.decoded == 'string') return message.message.decoded
  if (typeof message?.message?.readable == 'string') return message.message.readable
  if (typeof message?.data == 'string') return message.data
  if (typeof message?.decoded == 'string') return message.decoded
  if (typeof message?.readable == 'string') return message.readable
  return undefined
}

export function normalizeMessage(message: MeshPacket | any): NormalizedMessage {
  let safeMessage = jsonSafe(message)
  let packet = normalizePacket(safeMessage)
  return compact({
    id: packet.id ?? safeMessage.message?.id,
    rxTime: packet.rxTime ?? unixSecondsToIso(safeMessage.message?.rxTime),
    rxTimeSec: packet.rxTimeSec ?? parseTime(safeMessage.message?.rxTime) ?? null,
    from: packet.from ?? numeric(safeMessage.message?.from),
    fromId: packet.fromId ?? normalizeNodeId(safeMessage.message?.from),
    to: packet.to ?? numeric(safeMessage.message?.to),
    toId: packet.toId ?? normalizeDestinationId(safeMessage.message?.to),
    channel: packet.channel ?? safeMessage.message?.channel,
    text: extractText(safeMessage),
    portnum: packet.portnum,
    app: packet.app,
    type: packet.type,
    packet,
    raw: safeMessage
  })
}

export function filterPackets(packetList: NormalizedPacket[], filters: PacketFilters = {}): NormalizedPacket[] {
  let limit = normalizeLimit(filters.limit, 200, 1000)
  let from = numeric(filters.from)
  let to = numeric(filters.to)
  let since = parseTime(filters.since)
  let portnum = filters.portnum === undefined || filters.portnum === '' ? undefined : String(filters.portnum)

  return packetList
    .filter((packet) => {
      if (from !== undefined && packet.from != from) return false
      if (to !== undefined && packet.to != to) return false
      if (portnum !== undefined && String(packet.portnum) != portnum && String(packet.app) != portnum && String(packet.type) != portnum && String(getPacketPortnum(packet.raw)) != portnum) return false
      if (since !== undefined) {
        let rxTime = packetTime(packet)
        if (rxTime === undefined || rxTime < since) return false
      }
      return true
    })
    .slice(-limit)
}

function filterMessages(messageList: NormalizedMessage[], filters: Pick<PacketFilters, 'limit' | 'from' | 'since'> = {}) {
  let limit = normalizeLimit(filters.limit, 200, 500)
  let from = numeric(filters.from)
  let since = parseTime(filters.since)

  return messageList
    .filter((message) => {
      if (from !== undefined && message.from != from) return false
      if (since !== undefined) {
        let rxTime = parseTime(message.rxTime)
        if (rxTime === undefined || rxTime < since) return false
      }
      return true
    })
    .slice(-limit)
}


function nodeMergeKey(node: NormalizedNode): string | undefined {
  if (node.num !== undefined) return `num:${node.num}`
  if (node.id) return `id:${node.id}`
  return undefined
}

function mergeDefined<T extends Record<string, any>>(previous: T | undefined, next: T | undefined): T | undefined {
  if (!previous) return next
  if (!next) return previous
  return { ...previous, ...compact(next) }
}

function mergeNormalizedNode(previous: NormalizedNode | undefined, next: NormalizedNode): NormalizedNode {
  if (!previous) return next

  let previousLastHeard = previous.lastHeardSec ?? parseTime(previous.lastHeard)
  let nextLastHeard = next.lastHeardSec ?? parseTime(next.lastHeard)
  let newerLastHeard = nextLastHeard !== undefined && (previousLastHeard === undefined || nextLastHeard >= previousLastHeard)

  return compact({
    ...previous,
    ...next,
    num: next.num ?? previous.num,
    id: next.id ?? previous.id,
    longName: next.longName || previous.longName,
    shortName: next.shortName || previous.shortName,
    user: mergeDefined(previous.user, next.user),
    position: next.position ?? previous.position,
    latitude: next.latitude ?? previous.latitude,
    longitude: next.longitude ?? previous.longitude,
    lastHeard: newerLastHeard ? next.lastHeard : previous.lastHeard,
    lastHeardSec: newerLastHeard ? (nextLastHeard ?? null) : (previousLastHeard ?? previous.lastHeardSec ?? null),
    rssi: next.rssi ?? previous.rssi ?? null,
    snr: next.snr ?? previous.snr ?? null,
    role: next.role ?? previous.role,
    trace: next.trace ?? previous.trace
  })
}

function addMergedNode(
  merged: Map<string, NormalizedNode>,
  aliases: Map<string, string>,
  node: NormalizedNode
) {
  let key = nodeMergeKey(node)
  if (!key) return

  let aliasKeys = [key]
  if (node.num !== undefined) aliasKeys.push(`num:${node.num}`)
  if (node.id) aliasKeys.push(`id:${node.id}`)

  let existingKey = aliasKeys.map((alias) => aliases.get(alias)).find((alias): alias is string => !!alias) ?? key
  let mergedNode = mergeNormalizedNode(merged.get(existingKey), node)
  let finalKey = nodeMergeKey(mergedNode) ?? existingKey

  if (finalKey !== existingKey) merged.delete(existingKey)
  merged.set(finalKey, mergedNode)
  aliases.set(finalKey, finalKey)
  if (mergedNode.num !== undefined) aliases.set(`num:${mergedNode.num}`, finalKey)
  if (mergedNode.id) aliases.set(`id:${mergedNode.id}`, finalKey)
}

export function getCurrentNodeSnapshot(): NormalizedNode[] {
  let merged = new Map<string, NormalizedNode>()
  let aliases = new Map<string, string>()

  for (let node of runtimeStore.nodes.values()) addMergedNode(merged, aliases, node)
  for (let node of nodes.value || []) addMergedNode(merged, aliases, normalizeNode(node))

  runtimeStore.nodes.clear()
  for (let node of merged.values()) {
    let key = node.num ?? node.id
    if (key !== undefined) runtimeStore.nodes.set(key, node)
  }
  runtimeStore.nodesSeen = runtimeStore.nodes.size

  return Array.from(merged.values()).sort((a, b) => (b.lastHeardSec ?? 0) - (a.lastHeardSec ?? 0))
}



const maxPacketCacheSize = normalizeLimit(process.env.MESHSENSE_PUBLIC_API_PACKET_CACHE, 1000, 10000)
const maxTraceCacheSize = normalizeLimit(process.env.MESHSENSE_PUBLIC_API_TRACE_CACHE, 1000, 10000)

function packetCacheKey(packet: NormalizedPacket): string {
  if (packet.id !== undefined && packet.id !== null && packet.id !== '') return `id:${packet.id}`
  return [packet.fromId ?? packet.from ?? '', packet.toId ?? packet.to ?? '', packet.rxTimeSec ?? packet.rxTime ?? '', packet.portnum ?? '', packet.traceRoute?.join('>') ?? ''].join(':')
}

function mergeNormalizedPacket(previous: NormalizedPacket | undefined, next: NormalizedPacket): NormalizedPacket {
  if (!previous) return next
  return compact({
    ...previous,
    ...next,
    routeDiscovery: next.routeDiscovery ?? previous.routeDiscovery,
    traceRoutes: next.traceRoutes ?? previous.traceRoutes,
    traceRoute: next.traceRoute ?? previous.traceRoute,
    raw: next.raw ?? previous.raw
  })
}

function rememberPacketInCache(packet: NormalizedPacket) {
  let key = packetCacheKey(packet)
  let index = runtimeStore.packets.findIndex((current) => packetCacheKey(current) == key)
  let previous = index >= 0 ? runtimeStore.packets[index] : undefined
  if (index >= 0) runtimeStore.packets.splice(index, 1)
  runtimeStore.packets.push(mergeNormalizedPacket(previous, packet))
  while (runtimeStore.packets.length > maxPacketCacheSize) runtimeStore.packets.shift()
}

function normalizeHistoricalPacket(packet: MeshPacket | any): NormalizedPacket | undefined {
  try {
    let normalized = normalizePacket(packet)
    rememberPacketInCache(normalized)
    rememberTraceRoute(normalized)
    return normalized
  } catch (e) {
    console.log('[api] normalization error historical packet', String(e))
  }
}

function persistedRouteCacheEntries(): Array<{ source: string; nodeNum: number; trace: any }> {
  let persisted = getAllKeyValues()
  let entries: Array<{ source: string; nodeNum: number; trace: any }> = []
  for (let [source, value] of Object.entries(persisted)) {
    if (!source.startsWith('routeCache-') || !value || typeof value != 'object') continue
    for (let [nodeNum, trace] of Object.entries(value as Record<string, any>)) {
      let parsedNodeNum = numeric(nodeNum)
      if (parsedNodeNum !== undefined && trace && typeof trace == 'object') entries.push({ source, nodeNum: parsedNodeNum, trace })
    }
  }
  return entries
}

function currentHistorySourceCount() {
  return (packets.value?.length || 0) + (messageHistory.value?.length || 0) + persistedRouteCacheEntries().reduce((total, entry) => total + JSON.stringify(entry.trace).length + 1, 0)
}

function normalizedPacketFromRouteCache(entry: { source: string; nodeNum: number; trace: any }): NormalizedPacket | undefined {
  return normalizedPacketFromNodeTrace({ num: entry.nodeNum, id: normalizeNodeId(entry.nodeNum) }, { ...entry.trace, from: entry.nodeNum, id: `${entry.source}:${entry.nodeNum}:${JSON.stringify(entry.trace)}` })
}

function bootstrapTraceHistory() {
  let historicalPackets = [...(packets.value || []), ...(messageHistory.value || [])]
  for (let packet of historicalPackets) normalizeHistoricalPacket(packet)
  for (let entry of persistedRouteCacheEntries()) {
    let normalized = normalizedPacketFromRouteCache(entry)
    if (!normalized) continue
    rememberPacketInCache(normalized)
    rememberTraceRoute(normalized)
  }
  for (let node of getCurrentNodeSnapshot()) rememberNodeTrace(node)
  runtimeStore.historyBootstrapped = true
  runtimeStore.historySourceCount = currentHistorySourceCount()
}

export function ensureTraceHistoryBootstrapped(force = false) {
  if (runtimeStore.historyBootstrapped && !force && runtimeStore.historySourceCount == currentHistorySourceCount()) return
  bootstrapTraceHistory()
}

export function getPacketSnapshot(): NormalizedPacket[] {
  ensureTraceHistoryBootstrapped()
  return runtimeStore.packets
}

function routeHasUsablePath(packet: NormalizedPacket): boolean {
  if (packet.routeDiscovery && (packet.routeDiscovery.route.length >= 2 || packet.routeDiscovery.routeBack.length >= 2)) return true
  if (packet.traceRoutes?.some((route) => route.nodes.length >= 2)) return true
  return !!packet.traceRoute && packet.traceRoute.length >= 2
}

function traceRouteKey(packet: NormalizedPacket): string {
  if (packet.id !== undefined && packet.id !== null && packet.id !== '') return `id:${packet.id}`
  let routeParts = [
    ...(packet.traceRoutes ?? []).map((route) => `${route.direction}:${route.nodes.join('>')}`),
    packet.traceRoute?.length ? `towards:${packet.traceRoute.join('>')}` : ''
  ].filter(Boolean)
  return [packet.fromId ?? packet.from ?? '', packet.toId ?? packet.to ?? '', packet.rxTimeSec ?? packet.rxTime ?? '', routeParts.join('|')].join(':')
}

function rememberTraceRoute(packet: NormalizedPacket) {
  if (!routeHasUsablePath(packet)) return
  let key = traceRouteKey(packet)
  runtimeStore.traceRoutes.delete(key)
  runtimeStore.traceRoutes.set(key, packet)
  while (runtimeStore.traceRoutes.size > maxTraceCacheSize) {
    let oldestKey = runtimeStore.traceRoutes.keys().next().value
    if (oldestKey === undefined) break
    runtimeStore.traceRoutes.delete(oldestKey)
  }
}

function normalizedPacketFromNodeTrace(node: NormalizedNode, trace: any): NormalizedPacket | undefined {
  let from = numeric(trace?.from ?? node.num)
  let to = numeric(trace?.to)
  let fromId = normalizeNodeId(trace?.from ?? node.num, trace?.fromId ?? node.id)
  let toId = normalizeDestinationId(trace?.to) ?? normalizeNodeId(trace?.toId)
  let routeDiscovery = includeRouteDiscoveryEndpoints(normalizeExistingRouteDiscovery(trace, trace?.$typeName == 'meshtastic.RouteDiscovery'), fromId, toId)
  let traceRoutes = buildTraceRoutes(routeDiscovery) ?? normalizeExistingTraceRoutes(trace?.traceRoutes)
  let traceRoute = normalizeRouteNodeIds(trace?.traceRoute ?? trace?.route ?? trace?.nodes)
  if (!traceRoutes && traceRoute.length >= 2) traceRoutes = [{ direction: 'towards', nodes: traceRoute, snr: normalizeSnrArray(trace?.snr) }]
  if (!traceRoute.length) traceRoute = traceRoutes?.find((route) => route.direction == 'towards')?.nodes ?? []
  if (!traceRoutes && traceRoute.length < 2) return undefined
  return compact({
    id: trace?.id,
    rxTime: unixSecondsToIso(trace?.rxTime ?? trace?.time ?? node.lastHeardSec ?? node.lastHeard),
    rxTimeSec: parseTime(trace?.rxTime ?? trace?.time ?? node.lastHeardSec ?? node.lastHeard) ?? null,
    from,
    fromId,
    to,
    toId,
    portnum: 70,
    app: 'TRACEROUTE_APP',
    type: 'traceroute',
    routeDiscovery,
    traceRoutes,
    traceRoute: traceRoute.length >= 2 ? traceRoute : undefined,
    raw: { node, trace }
  })
}

function rememberNodeTrace(node: NormalizedNode) {
  if (!node.trace) return
  let traces = Array.isArray(node.trace) ? node.trace : [node.trace]
  for (let trace of traces) {
    let normalized = normalizedPacketFromNodeTrace(node, trace)
    if (normalized) {
      rememberPacketInCache(normalized)
      rememberTraceRoute(normalized)
    }
  }
}

function nodeMetadataForRoutes(packet: NormalizedPacket) {
  let ids = new Set<string>()
  for (let route of packet.traceRoutes ?? []) for (let id of route.nodes) ids.add(id)
  for (let id of packet.traceRoute ?? []) ids.add(id)
  if (!ids.size) return undefined
  let nodesById = new Map(getCurrentNodeSnapshot().map((node) => [node.id, node]))
  let metadata: NormalizedPacket['nodeMetadata'] = {}
  for (let id of ids) {
    let node = nodesById.get(id)
    if (!node) continue
    metadata[id] = compact({ id: node.id, shortName: node.shortName, longName: node.longName, latitude: node.latitude, longitude: node.longitude })
  }
  return Object.keys(metadata).length ? metadata : undefined
}

function enrichTracePacket(packet: NormalizedPacket): NormalizedPacket {
  return compact({ ...packet, nodeMetadata: packet.nodeMetadata ?? nodeMetadataForRoutes(packet) })
}

export function getTraceRouteSnapshot(): NormalizedPacket[] {
  ensureTraceHistoryBootstrapped()
  for (let node of getCurrentNodeSnapshot()) rememberNodeTrace(node)
  return Array.from(runtimeStore.traceRoutes.values()).map(enrichTracePacket)
}

export function recordPacket(packet: MeshPacket | any) {
  try {
    let normalized = normalizePacket(packet)
    rememberPacketInCache(normalized)
    runtimeStore.packetsSeen += 1
    rememberTraceRoute(normalized)
    runtimeStore.lastPacketAt = new Date().toISOString()
    console.log('[api] packet_rx', normalized.id ?? '(no id)', normalized.from ? `from ${normalized.from}` : '')
    publicApiEvents.emit('packet_rx', normalized)
    return normalized
  } catch (e) {
    console.log('[api] normalization error packet', String(e))
  }
}

export function recordNodeUpdate(node: Partial<NodeInfo> | any) {
  try {
    let normalized = normalizeNode(node)
    let key = normalized.num ?? normalized.id
    if (key === undefined) return normalized
    let existingEntry = Array.from(runtimeStore.nodes.entries()).find(([, current]) => {
      if (normalized.num !== undefined && current.num === normalized.num) return true
      if (normalized.id && current.id === normalized.id) return true
      return false
    })
    let storeKey = existingEntry?.[0] ?? key
    let wasKnown = existingEntry !== undefined
    runtimeStore.nodes.set(storeKey, mergeNormalizedNode(existingEntry?.[1], normalized))
    runtimeStore.nodesSeen = runtimeStore.nodes.size
    let storedNode = runtimeStore.nodes.get(storeKey)
    if (storedNode) rememberNodeTrace(storedNode)
    if (!wasKnown) console.log('[api] node discovered', normalized.id ?? normalized.num)
    publicApiEvents.emit('node_update', runtimeStore.nodes.get(storeKey))
    return normalized
  } catch (e) {
    console.log('[api] normalization error node', String(e))
  }
}

export function recordMessage(message: MeshPacket | any) {
  try {
    let normalized = normalizeMessage(message)
    runtimeStore.messages.push(normalized)
    while (runtimeStore.messages.length > 500) runtimeStore.messages.shift()
    publicApiEvents.emit('message_rx', normalized)
    return normalized
  } catch (e) {
    console.log('[api] normalization error message', String(e))
  }
}

function getConnectionType() {
  let value = address.value
  if (!value) return undefined
  if (String(value).startsWith('/') || String(value).toLowerCase().startsWith('com')) return 'serial'
  if (/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(String(value))) return 'bluetooth'
  return 'http'
}

function normalizeChannel(channel: Channel | any) {
  let safeChannel = jsonSafe(channel)
  return safeChannel
}

export function installPublicApi(app: Express, server: Server) {
  ensureTraceHistoryBootstrapped()
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'meshsense-api', time: new Date().toISOString() })
  })

  app.get('/api/status', (_req, res) => {
    res.json(
      compact({
        connected: connectionStatus.value == 'connected',
        connectionType: getConnectionType(),
        device: address.value || undefined,
        host: address.value || undefined,
        startedAt: runtimeStore.startedAt,
        lastPacketAt: runtimeStore.lastPacketAt,
        packetsSeen: runtimeStore.packetsSeen,
        nodesSeen: runtimeStore.nodesSeen
      })
    )
  })

  app.get('/api/nodes', (_req, res) => {
    res.json(getCurrentNodeSnapshot())
  })

  app.get('/api/packets', (req, res) => {
    res.json(filterPackets(getPacketSnapshot(), req.query as PacketFilters))
  })

  app.get('/api/traces', (_req, res) => {
    res.json(getTraceRouteSnapshot())
  })

  app.get('/api/messages', (req, res) => {
    res.json(filterMessages(runtimeStore.messages, req.query as PacketFilters))
  })

  app.get('/api/channels', (_req, res) => {
    res.json((channels.value || []).map(normalizeChannel))
  })

  let liveWss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    let { pathname } = parse(request.url || '')
    if (pathname != '/api/live') return

    liveWss.handleUpgrade(request, socket, head, (ws) => {
      liveWss.emit('connection', ws, request)
    })
  })

  liveWss.on('connection', (socket, request) => {
    let remoteAddress = request.socket.remoteAddress
    console.log('[api] WebSocket client connected', remoteAddress)
    socket.send(JSON.stringify({ type: 'hello', ok: true, server: 'meshsense', time: new Date().toISOString() }))
    for (let node of getCurrentNodeSnapshot()) {
      socket.send(JSON.stringify({ type: 'node_update', data: node }))
    }
    socket.send(JSON.stringify({ type: 'trace_snapshot', data: getTraceRouteSnapshot() }))

    socket.on('close', () => console.log('[api] WebSocket client disconnected', remoteAddress))
    socket.on('error', (error) => console.log('[api] WebSocket error', remoteAddress, String(error)))
  })

  function broadcast(type: string, data: any) {
    let payload = JSON.stringify({ type, data })
    liveWss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return
      try {
        client.send(payload)
      } catch (e) {
        console.log('[api] WebSocket broadcast error', String(e))
      }
    })
  }

  publicApiEvents.on('packet_rx', (packet) => broadcast('packet_rx', packet))
  publicApiEvents.on('node_update', (node) => broadcast('node_update', node))
  publicApiEvents.on('message_rx', (message) => broadcast('message_rx', message))
}
