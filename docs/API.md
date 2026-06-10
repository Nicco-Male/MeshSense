# MeshSense Public API

MeshSense exposes a public REST and WebSocket API for data already collected by the existing single Meshtastic connection. This API does not add multi-source connections, gateway selection, or multi-node deduplication.

## Standard dashboard vs multi-instance dashboard

`MESHSENSE_ENABLE_INSTANCES_DASHBOARD=false` disables only the multi-instance dashboard at `/instances.html`. In that mode:

- `/` and `/index.html` continue to serve the standard local MeshSense dashboard.
- Global dashboard assets such as JavaScript, CSS, images, favicon files, and Vite/static bundles continue to be served.
- `/state`, the standard UI state WebSocket, and public API endpoints such as `GET /api/health`, `GET /api/nodes`, and `WS /api/live` continue to work.
- `GET /instances.html` returns `403` with `MeshSense multi-instance dashboard disabled on this agent.`

Leave `MESHSENSE_ENABLE_INSTANCES_DASHBOARD=true` on the central dashboard host to expose `/instances.html`.

Trace retention is bounded by `MESHSENSE_TRACE_HISTORY_LIMIT` (default `1000`, max `10000`). Trace API responses are additionally capped by `MESHSENSE_TRACE_SNAPSHOT_DEFAULT_LIMIT` (default `200`, max `10000`) unless a smaller explicit `limit` is requested.

## CORS

CORS is enabled for external dashboards. By default all origins are allowed. Set one of these environment variables to restrict the allowed origin:

- `MESHSENSE_CORS_ORIGIN`
- `API_CORS_ORIGIN`

Example:

```bash
MESHSENSE_CORS_ORIGIN=https://dashboard.example.com npm run dev
```

## REST endpoints

All REST endpoints are served below `/api`.

### `GET /api/health`

Returns service health metadata.

```json
{
  "ok": true,
  "service": "meshsense-api",
  "time": "2026-06-08T12:00:00.000Z"
}
```

Example:

```bash
curl http://localhost:5920/api/health
```

### `GET /api/status`

Returns the current MeshSense runtime status.

Fields:

- `connected`
- `connectionType`, when inferred from the configured address
- `device` / `host`, when available
- `startedAt`
- `lastPacketAt`
- `packetsSeen`
- `nodesSeen`

Example:

```bash
curl http://localhost:5920/api/status
```

### `GET /api/nodes`

Returns known nodes normalized as:

```json
[
  {
    "num": 305441741,
    "id": "!1234abcd",
    "longName": "Long Name",
    "shortName": "LN",
    "lastHeard": "2026-06-08T12:00:00.000Z",
    "lastHeardSec": 1780920000,
    "snr": 8.5,
    "rssi": -87,
    "latitude": 45.1234567,
    "longitude": 9.1234567,
    "role": 1
  }
]
```

Example:

```bash
curl http://localhost:5920/api/nodes
```

### `GET /api/packets`

Returns recently received packets normalized as:

```json
[
  {
    "id": 123,
    "rxTime": "2026-06-08T12:00:00.000Z",
    "rxTimeSec": 1780920000,
    "from": 305441741,
    "fromId": "!1234abcd",
    "to": 4294967295,
    "toId": "^all",
    "channel": 0,
    "portnum": 1,
    "app": "TEXT_MESSAGE_APP",
    "type": "text",
    "rssi": -87,
    "snr": 8.5,
    "hasRadioMetrics": true,
    "hopLimit": 3,
    "hopStart": 5,
    "hopsUsed": 2
  }
]
```



Notes:

- `rxTime` is always an ISO timestamp when available; `rxTimeSec` preserves the original Unix timestamp in seconds.
- `fromId` is the `!xxxxxxxx` form of `from`; `toId` is `!xxxxxxxx`, or `^all` for broadcast destination `4294967295`.
- `hopsUsed` is only calculated when `hopStart > 0`, `hopLimit >= 0`, and `hopStart >= hopLimit`; otherwise it is `null`.
- If both `rxRssi` and `rxSnr` are zero, `rssi` and `snr` are `null` and `hasRadioMetrics` is `false`.
- Minimum app/type mapping: `1 => TEXT_MESSAGE_APP/text`, `3 => POSITION_APP/position`, `5 => ROUTING_APP/routing`, `67 => TELEMETRY_APP/telemetry`, `70 => TRACEROUTE_APP/traceroute`, otherwise `UNKNOWN_APP/decoded` or `UNKNOWN_APP/unknown`.

Supported query parameters:

- `limit`: default `200`, max `1000`
- `from`
- `to`
- `portnum`
- `since`: Unix timestamp seconds, Unix timestamp milliseconds, or an ISO timestamp
- `includeRaw=true`: include raw packet data for debugging

Examples:

```bash
curl 'http://localhost:5920/api/packets?limit=50'
curl 'http://localhost:5920/api/packets?from=305441741&portnum=1&since=2026-06-08T12:00:00.000Z'
```

### `GET /api/traces`

Returns bounded trace-route packets. This endpoint is only available in central dashboard mode and is intentionally separate from `/api/nodes` so trace history is not shipped with every base node snapshot.

Default responses omit `raw` packet payloads and `nodeMetadata` to avoid large debug payloads. Use explicit query parameters only when needed:

- `limit`: default `MESHSENSE_TRACE_SNAPSHOT_DEFAULT_LIMIT`, max `MESHSENSE_TRACE_HISTORY_LIMIT`
- `includeMetadata=true`: include compact per-node metadata for nodes in trace routes
- `includeRaw=true`: include raw trace packet data for debugging

Example:

```bash
curl 'http://localhost:5920/api/traces?limit=50'
curl 'http://localhost:5920/api/traces?limit=50&includeMetadata=true'
```

### `GET /api/messages`

Returns received text messages only.

Supported query parameters:

- `limit`: default `200`, max `500`
- `from`
- `since`: Unix timestamp seconds, Unix timestamp milliseconds, or an ISO timestamp

Example:

```bash
curl 'http://localhost:5920/api/messages?limit=25'
```

### `GET /api/channels`

Returns known/configured channels when available.

Example:

```bash
curl http://localhost:5920/api/channels
```

## WebSocket live stream

Connect to:

```text
ws://localhost:5920/api/live
```

### Hello event

Sent immediately after connection:

```json
{
  "type": "hello",
  "ok": true,
  "server": "meshsense",
  "time": "2026-06-08T12:00:00.000Z"
}
```

### Packet received event

Broadcast when a Meshtastic packet arrives in central dashboard mode. Remote-agent mode keeps `/api/live` lightweight and only sends `hello` and `node_update` events by default:

```json
{
  "type": "packet_rx",
  "data": {
    "id": 123,
    "rxTime": "2026-06-08T12:00:00.000Z",
    "rxTimeSec": 1780920000,
    "from": 305441741,
    "fromId": "!1234abcd",
    "to": 4294967295,
    "toId": "^all",
    "channel": 0,
    "portnum": 1,
    "app": "TEXT_MESSAGE_APP",
    "type": "text",
    "rssi": -87,
    "snr": 8.5,
    "hasRadioMetrics": true,
    "hopLimit": 3,
    "hopStart": 5,
    "hopsUsed": 2
  }
}
```

### Node update event

Broadcast when a node is updated:

```json
{
  "type": "node_update",
  "data": {
    "num": 305441741,
    "id": "!1234abcd",
    "longName": "Long Name",
    "shortName": "LN",
    "lastHeard": "2026-06-08T12:00:00.000Z",
    "lastHeardSec": 1780920000,
    "snr": 8.5,
    "rssi": -87,
    "latitude": 45.1234567,
    "longitude": 9.1234567,
    "role": 1
  }
}
```

### Message received event

Broadcast when a text message arrives:

```json
{
  "type": "message_rx",
  "data": {
    "id": 123,
    "rxTime": "2026-06-08T12:00:00.000Z",
    "rxTimeSec": 1780920000,
    "from": 305441741,
    "fromId": "!1234abcd",
    "to": 4294967295,
    "toId": "^all",
    "channel": 0,
    "text": "hello mesh",
    "portnum": 1,
    "app": "TEXT_MESSAGE_APP",
    "type": "text",
    "packet": {}
  }
}
```

### Browser example

```html
<script>
  const socket = new WebSocket('ws://localhost:5920/api/live')

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data)
    console.log('MeshSense live event:', payload.type, payload)
  })

  socket.addEventListener('close', () => {
    console.log('MeshSense live socket closed')
  })
</script>
```
