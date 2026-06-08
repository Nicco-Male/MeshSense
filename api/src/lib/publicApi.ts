import type { Express } from 'express'
import { Server } from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import EventEmitter from 'eventemitter3'
import { parse } from 'url'
import { address, channels, connectionStatus, nodes, type Channel, type MeshPacket, type NodeInfo } from '../vars'

export type NormalizedNode = {
  num?: number
  id?: string
  longName?: string
  shortName?: string
  lastHeard?: number | string
  snr?: number
  rssi?: number
  latitude?: number
  longitude?: number
  role?: string | number
}

export type NormalizedPacket = {
  id?: number | string
  rxTime?: number | string
  from?: number
  to?: number
  channel?: number | string
  portnum?: number | string
  type?: string
  rssi?: number
  snr?: number
  hopLimit?: number
  hopStart?: number
  hopsUsed?: number
  raw: any
}

export type NormalizedMessage = {
  id?: number | string
  rxTime?: number | string
  from?: number
  to?: number
  channel?: number | string
  text?: string
  portnum?: number | string
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
  return parseTime(packet.rxTime)
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

export function calculateHopsUsed(hopStart?: number, hopLimit?: number): number | undefined {
  if (hopStart === undefined || hopLimit === undefined) return undefined
  let used = Number(hopStart) - Number(hopLimit)
  return Number.isFinite(used) ? used : undefined
}

function getPacketDecoded(packet: any) {
  return packet?.decoded ?? (packet?.payloadVariant?.case == 'decoded' ? packet.payloadVariant.value : undefined) ?? (packet?.variant?.case == 'decoded' ? packet.variant.value : undefined)
}

function getPacketPortnum(packet: any): number | string | undefined {
  return getPacketDecoded(packet)?.portnum ?? packet?.data?.portnum ?? packet?.message?.portnum
}

function getPacketType(packet: any, portnum?: number | string): string | undefined {
  if (packet?.message) return 'text'
  if (packet?.event) return packet.event
  if (packet?.data?.$typeName) return packet.data.$typeName
  if (packet?.decoded?.$typeName) return packet.decoded.$typeName
  if (packet?.payloadVariant?.case) return packet.payloadVariant.case
  if (portnum !== undefined) return String(portnum)
  return undefined
}

export function normalizePacket(packet: MeshPacket | any): NormalizedPacket {
  let safePacket = jsonSafe(packet)
  let portnum = getPacketPortnum(safePacket)
  let hopStart = numeric(safePacket.hopStart)
  let hopLimit = numeric(safePacket.hopLimit)

  return compact({
    id: safePacket.id,
    rxTime: safePacket.rxTime,
    from: numeric(safePacket.from),
    to: numeric(safePacket.to),
    channel: safePacket.channel,
    portnum,
    type: getPacketType(safePacket, portnum),
    rssi: numeric(safePacket.rxRssi ?? safePacket.rssi),
    snr: numeric(safePacket.rxSnr ?? safePacket.snr),
    hopLimit,
    hopStart,
    hopsUsed: calculateHopsUsed(hopStart, hopLimit),
    raw: safePacket
  })
}

export function normalizeNode(node: Partial<NodeInfo> | any): NormalizedNode {
  let safeNode = jsonSafe(node)
  let latitude = numeric(safeNode.position?.latitudeI) !== undefined ? numeric(safeNode.position.latitudeI) / 10000000 : numeric(safeNode.latitude ?? safeNode.approximatePosition?.latitude)
  let longitude = numeric(safeNode.position?.longitudeI) !== undefined ? numeric(safeNode.position.longitudeI) / 10000000 : numeric(safeNode.longitude ?? safeNode.approximatePosition?.longitude)

  return compact({
    num: numeric(safeNode.num),
    id: normalizeNodeId(safeNode.num, safeNode.user?.id ?? safeNode.id),
    longName: safeNode.user?.longName ?? safeNode.longName,
    shortName: safeNode.user?.shortName ?? safeNode.shortName,
    lastHeard: safeNode.lastHeard,
    snr: numeric(safeNode.snr),
    rssi: numeric(safeNode.rssi ?? safeNode.rxRssi),
    latitude,
    longitude,
    role: safeNode.user?.role ?? safeNode.role
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
    rxTime: packet.rxTime ?? safeMessage.message?.rxTime,
    from: packet.from ?? numeric(safeMessage.message?.from),
    to: packet.to ?? numeric(safeMessage.message?.to),
    channel: packet.channel ?? safeMessage.message?.channel,
    text: extractText(safeMessage),
    portnum: packet.portnum,
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
    let wasKnown = runtimeStore.nodes.has(key)
    runtimeStore.nodes.set(key, { ...runtimeStore.nodes.get(key), ...normalized })
    runtimeStore.nodesSeen = runtimeStore.nodes.size
    if (!wasKnown) console.log('[api] node discovered', normalized.id ?? normalized.num)
    publicApiEvents.emit('node_update', runtimeStore.nodes.get(key))
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
    let merged = new Map(runtimeStore.nodes)
    for (let node of nodes.value || []) {
      let normalized = normalizeNode(node)
      let key = normalized.num ?? normalized.id
      if (key !== undefined) merged.set(key, { ...merged.get(key), ...normalized })
    }
    res.json(Array.from(merged.values()))
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
