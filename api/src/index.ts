import 'dotenv/config'
import './lib/persistence'
import { app, createRoutes, finalize, server } from './lib/server'
import './meshtastic'
import { connect, disconnect, deleteNodes, requestPosition, send, traceRoute, setPosition, deviceConfig } from './meshtastic'
import { address, apiPort, currentTime, apiHostname, accessKey, autoConnectOnStartup, meshSenseNewsDate, allowRemoteMessaging } from './vars'
import { hostname } from 'os'
import intercept from 'intercept-stdout'
import { createWriteStream } from 'fs'
import { dataDirectory } from './lib/paths'
import { join } from 'path'
import axios from 'axios'
import { spawn } from 'child_process'
setInterval(() => currentTime.set(Date.now()), 15000)

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

function setFavoriteOnNode(nodeNum: number, favorite: boolean) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let destination = `!${Number(nodeNum).toString(16).padStart(8, '0')}`
    let value = favorite ? '1' : '0'
    let command = spawn('meshtastic', ['--dest', destination, '--set-favorite', value])
    let stdout = ''
    let stderr = ''
    command.stdout.on('data', (data) => (stdout += String(data)))
    command.stderr.on('data', (data) => (stderr += String(data)))
    command.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    command.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }))
  })
}

createRoutes((app) => {
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

  app.post('/setFavorite', async (req, res) => {
    let nodeNum = Number(req.body.nodeNum)
    let favorite = req.body.favorite === true || req.body.favorite === 'true' || req.body.favorite === 1
    if (!Number.isFinite(nodeNum)) return res.status(400).json({ error: 'Invalid nodeNum' })

    let result = await setFavoriteOnNode(nodeNum, favorite)
    if (result.code !== 0) {
      return res.status(500).json({
        error: 'Unable to set favorite on node',
        command: `meshtastic --dest !${nodeNum.toString(16).padStart(8, '0')} --set-favorite ${favorite ? '1' : '0'}`,
        stderr: result.stderr,
        stdout: result.stdout
      })
    }

    return res.json({ ok: true, stdout: result.stdout, stderr: result.stderr })
  })

  app.post('/requestPosition', async (req, res) => {
    let destination = req.body.destination
    await requestPosition(destination)
    return res.sendStatus(200)
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

  if ((process.env.ADDRESS || autoConnectOnStartup.value) && address.value) connect(address.value)
})
