import type { TraceRouteData } from '../vars'

export type TraceHops = {
  towards: number | null
  back: number | null
  min: number | null
}

function routeHopCandidate(route?: unknown[]): number | null {
  if (!Array.isArray(route) || route.length == 0) return null
  return route.length
}

function routeBackHopCandidate(routeBack?: unknown[]): number | null {
  if (!Array.isArray(routeBack) || routeBack.length == 0) return null

  // Some RouteDiscovery return paths include an endpoint that route-line drawing
  // treats separately. Account for that without ever turning a real, non-empty
  // traceroute into a zero-hop candidate.
  return Math.max(1, routeBack.length - 1)
}

function positiveCandidate(value: unknown): number | null {
  let numericValue = Number(value)
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null
}

function finiteCandidate(value: unknown): number | null {
  let numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : null
}

export function calculateTraceHops(nodeOrTrace?: (Partial<{ trace: TraceRouteData; hopsAway: unknown }> & Record<string, any>) | TraceRouteData | any, hopsAway?: unknown): TraceHops | undefined {
  if (!nodeOrTrace || typeof nodeOrTrace != 'object') return undefined

  let trace = nodeOrTrace.trace && typeof nodeOrTrace.trace == 'object' ? nodeOrTrace.trace : nodeOrTrace
  let nodeHopsAway = hopsAway ?? nodeOrTrace.hopsAway
  let towards = routeHopCandidate(trace?.route)
  let back = routeBackHopCandidate(trace?.routeBack ?? trace?.back)
  let positiveHopsAway = positiveCandidate(nodeHopsAway)
  let candidates = [towards, back, positiveHopsAway].filter((value): value is number => value !== null)
  let min = candidates.length ? Math.min(...candidates) : finiteCandidate(nodeHopsAway)

  if (min === null) return undefined
  return { towards, back, min }
}
