import { readFileSync } from 'fs'

function detectLowResourcePreset(): boolean {
  if (process.env.MESHSENSE_LOW_RESOURCE_PRESET !== undefined) return parseBoolEnv('MESHSENSE_LOW_RESOURCE_PRESET', false)

  try {
    let model = readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').toLowerCase()
    return model.includes('orange pi') || model.includes('orangepi')
  } catch {
    return false
  }
}

export function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  let value = process.env[name]
  if (value === undefined || value === '') return defaultValue

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'y':
    case 'on':
    case 'enabled':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'n':
    case 'off':
    case 'disabled':
      return false
    default:
      console.log(`[config] ${name}=${value} is not a recognized boolean; using default ${defaultValue}`)
      return defaultValue
  }
}

export function parsePositiveIntegerEnv(name: string, defaultValue: number, maxValue: number): number {
  let value = process.env[name]
  if (value === undefined || value === '') return defaultValue

  let parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.log(`[config] ${name}=${value} is not a positive integer; using default ${defaultValue}`)
    return defaultValue
  }

  return Math.min(Math.floor(parsed), maxValue)
}

const lowResourcePreset = detectLowResourcePreset()

export const runtimeFlags = {
  lowResourcePreset,
  enableInstancesDashboard: parseBoolEnv('MESHSENSE_ENABLE_INSTANCES_DASHBOARD', !lowResourcePreset),
  enablePublicApi: parseBoolEnv('MESHSENSE_ENABLE_PUBLIC_API', true),
  enableTraceHistory: parseBoolEnv('MESHSENSE_ENABLE_TRACE_HISTORY', true),
  traceHistoryLimit: parsePositiveIntegerEnv('MESHSENSE_TRACE_HISTORY_LIMIT', lowResourcePreset ? 100 : 1000, 10000),
  traceSnapshotDefaultLimit: parsePositiveIntegerEnv('MESHSENSE_TRACE_SNAPSHOT_DEFAULT_LIMIT', lowResourcePreset ? 50 : 200, 10000),
  nodeHistoryLimit: parsePositiveIntegerEnv('MESHSENSE_NODE_HISTORY_LIMIT', lowResourcePreset ? 200 : 2000, 10000),
  packetCacheLimit: parsePositiveIntegerEnv('MESHSENSE_PUBLIC_API_PACKET_CACHE', lowResourcePreset ? 200 : 1000, 10000),
  enableAutoScanning: parseBoolEnv('MESHSENSE_ENABLE_AUTO_SCANNING', !lowResourcePreset),
  nodeInfoBatchSize: parsePositiveIntegerEnv('MESHSENSE_NODEINFO_BATCH_SIZE', lowResourcePreset ? 5 : 25, 250),
  nodeInfoBatchIntervalMs: parsePositiveIntegerEnv('MESHSENSE_NODEINFO_BATCH_INTERVAL_MS', lowResourcePreset ? 250 : 100, 5000),
  configuringTimeoutMs: parsePositiveIntegerEnv('MESHSENSE_CONFIGURING_TIMEOUT_MS', 45000, 120000),
  configuringMaxRetries: parsePositiveIntegerEnv('MESHSENSE_CONFIGURING_MAX_RETRIES', 2, 10)
}

// The instances dashboard flag only gates the multi-instance HTML page.
// Keep the standard local dashboard, state websocket, and public/local APIs available when it is disabled.
export const isRemoteAgentMode = false

export function logRuntimeFlags() {
  console.log('[config] low-resource preset', runtimeFlags.lowResourcePreset ? 'enabled' : 'disabled')
  console.log('[config] instances dashboard', runtimeFlags.enableInstancesDashboard ? 'enabled' : 'disabled')
  console.log('[config] public API', runtimeFlags.enablePublicApi ? 'enabled' : 'disabled')
  console.log('[config] trace history', runtimeFlags.enableTraceHistory ? 'enabled' : 'disabled')
  console.log('[config] trace history limit', runtimeFlags.traceHistoryLimit)
  console.log('[config] trace snapshot default limit', runtimeFlags.traceSnapshotDefaultLimit)
  console.log('[config] node history limit', runtimeFlags.nodeHistoryLimit)
  console.log('[config] public API packet cache limit', runtimeFlags.packetCacheLimit)
  console.log('[config] auto scanning', runtimeFlags.enableAutoScanning ? 'enabled' : 'disabled')
  console.log('[config] standard dashboard', 'enabled')
}
