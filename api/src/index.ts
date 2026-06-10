import { webcrypto as nodeWebcrypto } from "node:crypto";
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = nodeWebcrypto;
}

import 'dotenv/config'
import './lib/persistence'
import { app, createRoutes, finalize, server } from './lib/server'
import { logRuntimeFlags } from './lib/runtimeFlags'
import { installPublicApi } from './lib/publicApi'
import './meshtastic'
import { connect, disconnect, deleteNodes, requestPosition, send, traceRoute, setPosition, deviceConfig } from './meshtastic'
import { isSerialPath, listSerialPorts } from './lib/serial'
import { address, apiPort, currentTime, apiHostname, accessKey, autoConnectOnStartup, meshSenseNewsDate, allowRemoteMessaging, connectionStatus } from './vars'
import { hostname } from 'os'
import intercept from 'intercept-stdout'
import { createWriteStream } from 'fs'
import { dataDirectory } from './lib/paths'
import { join } from 'path'
import axios from 'axios'
setInterval(() => currentTime.set(Date.now()), 15000)

logRuntimeFlags()

process.on('uncaughtException', (err, origin) => {
  console.error('[system] Uncaught Exception', err)
})

let consoleLog = []
let logSize = 1000

let lastLogStream = createWriteStream(join(dataDirectory, 'lastLog.txt'))
intercept(
  (text) => {
    lastLogStream.write(text)
    consoleLog.push(text)
    while (consoleLog.length >= logSize) consoleLog.shift()
  },
  (err) => {
    if (err.includes('Possible EventTarget memory leak detected')) return
    consoleLog.push(err)
    while (consoleLog.length >= logSize) consoleLog.shift()
  }
)

function errorDetails(error: any) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    responseStatus: error?.response?.status,
    responseData: error?.response?.data
  }
}

function isAuthorized(req: any) {
  let token = req.headers['authorization']?.split(' ')[1]
  console.log('Remote Address', req.socket.remoteAddress)
  return (
    req.socket.remoteAddress.includes('127.0.0.1') ||
    req.socket.remoteAddress.includes('ffff') ||
    req.socket.remoteAddress.includes('localhost') ||
    req.socket.remoteAddress.includes('::1') ||
    (accessKey.value != '' && accessKey.value == token)
  )
}

createRoutes((app) => {
  installPublicApi(app, server)
  app.post('/send', (req, res) => {
    if (!allowRemoteMessaging.value && !isAuthorized(req)) return res.sendStatus(403)
    let message = req.body.message
    let destination = req.body.destination
    let channel = req.body.channel
    let wantAck = req.body.wantAck
    send({ message, destination, channel, wantAck })
    return res.sendStatus(200)
  })

  app.post('/traceRoute', async (req, res) => {
    let destination = req.body.destination
    await traceRoute(destination)
    return res.sendStatus(200)
  })

  app.post('/requestPosition', async (req, res) => {
    let destination = Number(req.body.destination)
    if (!Number.isFinite(destination) || !Number.isInteger(destination) || destination < 0 || destination > 0xffffffff) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid destination. destination must be a finite numeric Meshtastic node number.'
      })
    }

    let status = connectionStatus.value
    if (status != 'connected') {
      console.warn('[express] /requestPosition rejected; not connected', { destination, connectionStatus: status })
      return res.status(409).json({ ok: false, error: 'Meshtastic connection is not connected.', connectionStatus: status })
    }

    try {
      let packetId = await requestPosition(destination)
      console.log('[express] /requestPosition sent', { destination, connectionStatus: connectionStatus.value, packetId })
      return res.json({ ok: true, destination, status: 'queued', packetId })
    } catch (error) {
      console.error('[express] /requestPosition failed', {
        destination,
        connectionStatus: connectionStatus.value,
        error: errorDetails(error)
      })
      return res.status(500).json({ ok: false, error: 'Failed to request position.', connectionStatus: connectionStatus.value })
    }
  })

  app.post('/deleteNodes', async (req, res) => {
    if (!isAuthorized(req)) return res.sendStatus(403)
    let nodes = req.body.nodes
    await deleteNodes(nodes)
  })

  app.post('/connect', async (req, res) => {
    if (!isAuthorized(req)) return res.sendStatus(403)
    console.log('[express]', '/connect')
    connect(req.body.address || address.value)
    return res.sendStatus(200)
  })

  app.post('/disconnect', async (req, res) => {
    if (!isAuthorized(req)) return res.sendStatus(403)
    console.log('[express]', '/disconnect')
    disconnect()
    return res.sendStatus(200)
  })

  app.get('/consoleLog', async (req, res) => {
    if (req.query.accessKey != accessKey.value && req.hostname.toLowerCase() != 'localhost') return res.sendStatus(403)
    return res.json(consoleLog)
  })

  app.get('/deviceConfig', async (req, res) => {
    if (req.query.accessKey != accessKey.value && req.hostname.toLowerCase() != 'localhost') return res.sendStatus(403)
    return res.json(deviceConfig)
  })

  app.get('/serialPorts', async (req, res) => {
    let ports = await listSerialPorts()
    return res.json(ports)
  })

  app.post('/position', async (req, res) => {
    if (!isAuthorized(req)) return res.sendStatus(403)
    console.log('[express]', '/position', req.body)
    setPosition(req.body)
    return res.sendStatus(200)
  })

  //** Set accessKey via environment variable */
  if (process.env.ACCESS_KEY) {
    accessKey.set(process.env.ACCESS_KEY)
  }

  if (process.env.ADDRESS) {
    address.set(process.env.ADDRESS)
  }

  //** Capture current hostname and port */
  apiHostname.set(hostname())
  apiPort.set((server.address() as any)?.port)

  // ** Check News Update */
  function checkForNews() {
    console.log('[news] Checking for news')
    axios
      .get('https://affirmatech.com/meshSenseNewsDate')
      .then((newDate) => {
        if (meshSenseNewsDate.value < newDate.data) {
          meshSenseNewsDate.set(newDate.data)
        }
      })
      .catch(() => {
        console.log('[news] Unable to get latest news')
      })
  }

  checkForNews()

  // Scan for serial ports unless a fixed serial path is already configured.
  if (!address.value || !isSerialPath(address.value)) listSerialPorts()

  if ((process.env.ADDRESS || autoConnectOnStartup.value) && address.value) connect(address.value)
})
