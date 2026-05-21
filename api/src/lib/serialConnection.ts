import { SerialPort } from 'serialport'
import { MeshDevice, Types } from '../../meshtastic-js/dist'

/**
 * Node.js serial connection for Meshtastic devices.
 * Uses the `serialport` npm package instead of the Web Serial API.
 */
export class NodeSerialConnection extends MeshDevice {
  public connType: any = 'serial'
  protected portId: string = ''

  private port: SerialPort | undefined
  private byteBuffer = new Uint8Array([])
  private heartbeatInterval?: ReturnType<typeof setInterval>

  constructor(configId?: number) {
    super(configId)
  }

  /** List available serial ports */
  static async listPorts() {
    return SerialPort.list()
  }

  /** Connect to a serial port by path */
  async connect(params: any) {
    const path = params.path || params.address
    const baudRate = params.baudRate || 115200

    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnecting)
    this.portId = path

    this.port = new SerialPort({ path, baudRate, autoOpen: false })

    return new Promise<void>((resolve, reject) => {
      this.port!.open((err) => {
        if (err) {
          console.error('[serial] Failed to open port:', err.message)
          this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected)
          reject(err)
          return
        }

        console.log('[serial] Port opened:', path)

        this.port!.on('data', (chunk: Buffer) => {
          this.processIncomingData(new Uint8Array(chunk))
        })

        this.port!.on('close', () => {
          console.log('[serial] Port closed')
          this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected)
          this.complete()
        })

        this.port!.on('error', (err) => {
          console.error('[serial] Port error:', err.message)
        })

        this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected)

        setTimeout(() => {
          this.configure().catch(() => {})
        }, 1000)

        this.heartbeatInterval = setInterval(() => {
          this.heartbeat().catch((err) => {
            console.error('[serial] Heartbeat error', err)
          })
        }, 60 * 1000)

        resolve()
      })
    })
  }

  /** Parse incoming serial data using the Meshtastic framing protocol */
  private processIncomingData(chunk: Uint8Array) {
    this.byteBuffer = new Uint8Array([...this.byteBuffer, ...chunk])

    let processingExhausted = false
    while (this.byteBuffer.length !== 0 && !processingExhausted) {
      const framingIndex = this.byteBuffer.findIndex((byte) => byte === 0x94)
      if (framingIndex === -1) {
        this.byteBuffer = new Uint8Array([])
        break
      }

      const framingByte2 = this.byteBuffer[framingIndex + 1]
      if (framingByte2 === 0xc3) {
        if (framingIndex > 0) {
          this.byteBuffer = this.byteBuffer.subarray(framingIndex)
        }

        const msb = this.byteBuffer[2]
        const lsb = this.byteBuffer[3]

        if (msb !== undefined && lsb !== undefined && this.byteBuffer.length >= 4 + (msb << 8) + lsb) {
          const packetLen = (msb << 8) + lsb
          const packet = this.byteBuffer.subarray(4, 4 + packetLen)

          const malformedIndex = packet.findIndex((byte) => byte === 0x94)
          if (malformedIndex !== -1 && packet[malformedIndex + 1] === 0xc3) {
            this.byteBuffer = this.byteBuffer.subarray(malformedIndex)
          } else {
            this.byteBuffer = this.byteBuffer.subarray(4 + packetLen)
            this.handleFromRadio(packet)
          }
        } else {
          processingExhausted = true
        }
      } else {
        this.byteBuffer = this.byteBuffer.subarray(framingIndex + 1)
      }
    }
  }

  /** Send protobuf data to the radio with serial framing */
  protected async writeToRadio(data: Uint8Array): Promise<void> {
    if (!this.port?.isOpen) return

    const frame = new Uint8Array([0x94, 0xc3, (data.length >> 8) & 0xff, data.length & 0xff, ...data])

    return new Promise((resolve, reject) => {
      this.port!.write(frame, (err) => {
        if (err) reject(err)
        else {
          this.port!.drain((err) => {
            if (err) reject(err)
            else resolve()
          })
        }
      })
    })
  }

  async disconnect() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }

    if (this.port?.isOpen) {
      return new Promise<void>((resolve) => {
        this.port!.close(() => {
          this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected)
          this.complete()
          resolve()
        })
      })
    }

    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected)
    this.complete()
  }

  async reconnect() {
    await this.connect({ path: this.portId })
  }

  async ping(): Promise<boolean> {
    return this.port?.isOpen ?? false
  }
}
