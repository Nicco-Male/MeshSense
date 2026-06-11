import type { NodeInfo, TraceRouteData } from 'api/src/vars'

type NodeRef = NodeInfo | number | string | undefined

type RouteSkipReason =
  | 'missing source node'
  | 'missing destination node'
  | 'missing source coordinates'
  | 'missing destination coordinates'
  | 'unresolved hop node'

export type TracerouteDebugEvent = {
  reason: RouteSkipReason
  ref?: NodeRef
  node?: NodeInfo
  route?: TraceRouteData
}

type BuildTraceroutePolylineOptions = {
  nodes: NodeInfo[]
  source: NodeRef
  destination: NodeRef
  trace?: TraceRouteData
  logger?: (event: TracerouteDebugEvent) => void
}

function normalizeMeshtasticId(value: string) {
  return value.startsWith('!') ? value.slice(1).toLowerCase() : value.toLowerCase()
}

function nodeIdMatches(node: NodeInfo, value: string) {
  const normalized = normalizeMeshtasticId(value)
  const numHex = node.num?.toString(16).padStart(8, '0').toLowerCase()

  return (
    String(node.num) == value ||
    normalized == numHex ||
    node.user?.id?.toLowerCase() == value.toLowerCase() ||
    normalizeMeshtasticId(node.user?.id || '') == normalized ||
    node.user?.shortName?.toLowerCase() == value.toLowerCase() ||
    node.user?.longName?.toLowerCase() == value.toLowerCase()
  )
}

export function resolveTracerouteNode(ref: NodeRef, nodeList: NodeInfo[]) {
  if (ref == undefined) return undefined
  if (typeof ref == 'object') return ref
  if (typeof ref == 'number') return nodeList.find((node) => node.num == ref)
  return nodeList.find((node) => nodeIdMatches(node, ref))
}

export function getTracerouteCoordinates(node: NodeInfo) {
  const approximatePosition = node?.approximatePosition || undefined
  const longitude = node?.position?.longitudeI ? node.position.longitudeI / 10000000 : approximatePosition?.longitude
  const latitude = node?.position?.latitudeI ? node.position.latitudeI / 10000000 : approximatePosition?.latitude

  return [longitude, latitude]
}

export function hasValidTracerouteCoordinates(node: NodeInfo) {
  const [longitude, latitude] = getTracerouteCoordinates(node)
  return Number.isFinite(longitude) && Number.isFinite(latitude) && !(longitude == 0 && latitude == 0)
}

export function buildTraceroutePolyline({ nodes, source, destination, trace, logger }: BuildTraceroutePolylineOptions) {
  const sourceNode = resolveTracerouteNode(source, nodes)
  const destinationNode = resolveTracerouteNode(destination, nodes)

  if (!sourceNode) {
    logger?.({ reason: 'missing source node', ref: source, route: trace })
    return undefined
  }

  if (!destinationNode) {
    logger?.({ reason: 'missing destination node', ref: destination, route: trace })
    return undefined
  }

  if (!hasValidTracerouteCoordinates(sourceNode)) {
    logger?.({ reason: 'missing source coordinates', ref: source, node: sourceNode, route: trace })
    return undefined
  }

  if (!hasValidTracerouteCoordinates(destinationNode)) {
    logger?.({ reason: 'missing destination coordinates', ref: destination, node: destinationNode, route: trace })
    return undefined
  }

  const routePoints = [getTracerouteCoordinates(sourceNode)]

  for (const hopRef of trace?.route || []) {
    const hopNode = resolveTracerouteNode(hopRef, nodes)

    if (!hopNode || !hasValidTracerouteCoordinates(hopNode)) {
      logger?.({ reason: 'unresolved hop node', ref: hopRef, node: hopNode, route: trace })
      continue
    }

    routePoints.push(getTracerouteCoordinates(hopNode))
  }

  routePoints.push(getTracerouteCoordinates(destinationNode))

  return routePoints.length >= 2 ? routePoints : undefined
}
