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

function parsePositiveIntegerEnv(name: string, defaultValue: number, maxValue: number): number {
  let value = process.env[name]
  if (value === undefined || value === '') return defaultValue

  let parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.log(`[config] ${name}=${value} is not a positive integer; using default ${defaultValue}`)
    return defaultValue
  }

  return Math.min(Math.floor(parsed), maxValue)
}

export const runtimeFlags = {
  enableInstancesDashboard: parseBoolEnv('MESHSENSE_ENABLE_INSTANCES_DASHBOARD', true),
  enablePublicApi: parseBoolEnv('MESHSENSE_ENABLE_PUBLIC_API', true),
  enableTraceHistory: parseBoolEnv('MESHSENSE_ENABLE_TRACE_HISTORY', true),
  traceHistoryLimit: parsePositiveIntegerEnv('MESHSENSE_TRACE_HISTORY_LIMIT', 1000, 10000)
}

export function logRuntimeFlags() {
  console.log('[config] instances dashboard', runtimeFlags.enableInstancesDashboard ? 'enabled' : 'disabled')
  console.log('[config] public API', runtimeFlags.enablePublicApi ? 'enabled' : 'disabled')
  console.log('[config] trace history', runtimeFlags.enableTraceHistory ? 'enabled' : 'disabled')
  console.log('[config] trace history limit', runtimeFlags.traceHistoryLimit)
}
