import type { TraceRouteData } from '../vars'

export type TraceHops = {
  towards: number | null
  back: number | null
  min: number | null
}

function validRouteHopCount(route?: unknown[], direction: 'towards' | 'back' = 'towards'): number | null {
  if (!Array.isArray(route) || route.length == 0) return null

  // Meshtastic node traces expose the forward path as the useful link count
  // directly in `route`, while `routeBack` includes one endpoint that route-line
  // drawing already treats separately. Do not synthesize hops from fake RX links.
  return direction == 'back' ? Math.max(route.length - 1, 0) : route.length
}

export function calculateTraceHops(trace?: TraceRouteData | any): TraceHops | undefined {
  if (!trace || typeof trace != 'object') return undefined

  let towards = validRouteHopCount(trace.route, 'towards')
  let back = validRouteHopCount(trace.routeBack ?? trace.back, 'back')
  let validHops = [towards, back].filter((value): value is number => value !== null)
  let min = validHops.length ? Math.min(...validHops) : null

  if (min === null) return undefined
  return { towards, back, min }
}
