export type NodeRoleDefinition = {
  code: string
  title: string
  className: string
}

export const NODE_ROLE_DEFINITIONS: Record<number, NodeRoleDefinition> = {
  0: { code: 'C', title: 'Client Node', className: 'bg-blue-500/50' },
  1: { code: 'CM', title: 'Client_Mute Node', className: 'bg-indigo-500/50 text-indigo-300' },
  2: { code: 'R', title: 'Router Node', className: 'bg-red-500/50 text-red-200' },
  3: { code: 'RC', title: 'Deprecated Router_Client Node', className: 'bg-blue-500/50' },
  4: { code: 'Re', title: 'Repeater Node', className: 'bg-red-500/50 text-red-200' },
  5: { code: 'T', title: 'Tracker Node', className: 'bg-indigo-500/50 text-indigo-300' },
  6: { code: 'S', title: 'Sensor Node', className: 'bg-indigo-500/50 text-indigo-300' },
  7: { code: 'TAK', title: 'TAK Node', className: 'bg-indigo-500/50 text-indigo-300' },
  8: { code: 'CH', title: 'Client Hidden Node', className: 'bg-indigo-500/50 text-indigo-300' },
  9: { code: 'LF', title: 'Lost and Found Node', className: 'bg-indigo-500/50 text-indigo-300' },
  10: { code: 'TT', title: 'TAK Tracker Node', className: 'bg-indigo-500/50 text-indigo-300' },
  11: { code: 'RL', title: 'Router_Late Node', className: 'bg-red-500/50 text-red-200' },
  12: { code: 'CB', title: 'Client_Base Node', className: 'bg-blue-500/50' }
}

export const HARDWARE_MODELS: Record<number, string> = {
  37: 'PORTDUINO'
}

export function getNodeRoleDefinition(role?: number) {
  if (role == undefined) return undefined
  return NODE_ROLE_DEFINITIONS[role] ?? { code: `R${role}`, title: `Unknown Role (${role})`, className: 'bg-zinc-600/50 text-zinc-200' }
}

export function getHardwareModelName(hwModel?: number | string) {
  if (hwModel == undefined) return undefined
  if (typeof hwModel == 'string') return hwModel
  return HARDWARE_MODELS[hwModel] ?? `HW_${hwModel}`
}
