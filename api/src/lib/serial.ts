import { SerialPort } from 'serialport'
import { State } from './state'

export let serialPorts = new State<{ path: string; manufacturer?: string; vendorId?: string; productId?: string }[]>('serialPorts', [])

/** Scan for available serial ports that might be Meshtastic devices */
export async function listSerialPorts() {
  try {
    const ports = await SerialPort.list()
    // Filter for likely Meshtastic devices (USB serial adapters)
    const filtered = ports
      .filter((p) => p.path.includes('ttyACM') || p.path.includes('ttyUSB') || p.path.includes('cu.usbmodem') || p.path.includes('cu.SLAB'))
      .map((p) => ({ path: p.path, manufacturer: p.manufacturer, vendorId: p.vendorId, productId: p.productId }))
    serialPorts.set(filtered)
    return filtered
  } catch (e) {
    console.error('[serial] Error listing ports:', e)
    return []
  }
}

/** Check if a string looks like a serial port path */
export function isSerialPath(address: string): boolean {
  return address.startsWith('/dev/tty') || address.startsWith('COM') || address.startsWith('/dev/cu.')
}
