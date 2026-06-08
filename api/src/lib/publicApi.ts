import type { Express } from 'express'
import { Server } from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import EventEmitter from 'eventemitter3'
import { parse } from 'url'
import { fromBinary } from '@bufbuild/protobuf'
import { Protobuf } from '../../meshtastic-js/dist'
import { address, channels, connectionStatus, nodes, type Channel, type MeshPacket, type NodeInfo } from '../vars'

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
  nodes: new Map()
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
  return getPacketDecoded(packet)?.portnum ?? packet?.data?.portnum ?? packet?.message?.portnum
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
  let routeDiscovery = decodeRouteDiscovery(safePacket, portnum)
  let traceRoutes = buildTraceRoutes(routeDiscovery)

  return compact({
    id: safePacket.id,
    rxTime: unixSecondsToIso(safePacket.rxTime),
    rxTimeSec: rxTimeSec ?? null,
    from,
    fromId: normalizeNodeId(from),
    to,
    toId: normalizeDestinationId(to),
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
    traceRoute: routeDiscovery?.route,
    raw: safePacket
  })
}

export function normalizeNode(node: Partial<NodeInfo> | any): NormalizedNode {
  let safeNode = jsonSafe(node)
  let latitude = numeric(safeNode.position?.latitudeI) !== undefined ? numeric(safeNode.position.latitudeI) / 10000000 : numeric(safeNode.latitude ?? safeNode.approximatePosition?.latitude)
  let longitude = numeric(safeNode.position?.longitudeI) !== undefined ? numeric(safeNode.position.longitudeI) / 10000000 : numeric(safeNode.longitude ?? safeNode.approximatePosition?.longitude)
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
      if (portnum !== undefined && String(packet.portnum) != portnum) return false
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

export function recordPacket(packet: MeshPacket | any) {
  try {
    let normalized = normalizePacket(packet)
    runtimeStore.packets.push(normalized)
    while (runtimeStore.packets.length > 1000) runtimeStore.packets.shift()
    runtimeStore.packetsSeen += 1
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
    res.json(filterPackets(runtimeStore.packets, req.query as PacketFilters))
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
