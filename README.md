# MeshSense

**MeshSense** is a simple, [open-source](https://github.com/Affirmatech/MeshSense) application that monitors, maps and graphically displays all the vital stats of your area's Meshtastic network including connected nodes, signal reports, trace routes and more!

![](https://affirmatech.com/meshsense.png)

MeshSense directly connects to your Meshtastic node via Bluetooth, WiFi, or Serial/USB and continuously provides all the information you need to assess the health of your network. For more detailed information, take a peek at our [Frequently Asked Questions](https://affirmatech.com/meshsense/faq) or [Bluetooth Tips](https://affirmatech.com/meshsense/bluetooth).

## Docker

A pre-built Docker image is available on GitHub Container Registry:

```sh
docker pull ghcr.io/outrun207/meshsense:latest
```

### Running the container

```sh
docker run -d --name meshsense \
  --privileged \
  --network host \
  -v /var/run/dbus:/var/run/dbus \
  -v meshsense-data:/root/.local/share/meshsense \
  -e ACCESS_KEY=yourSecretKey \
  -e ADDRESS=/dev/ttyACM0 \
  --restart unless-stopped \
  ghcr.io/outrun207/meshsense:latest
```

- `ADDRESS` — Set to a serial port path (e.g. `/dev/ttyACM0`) or IP address for auto-connect on startup
- `ACCESS_KEY` — Required for remote (non-localhost) access to send messages and manage the device
- `--privileged` — Required for Bluetooth and serial port access
- `--network host` — Required for mDNS and WebSocket connectivity

The web UI will be available at `http://<host-ip>:5920`.

### Building the Docker image locally

```sh
# Build the UI and API
cd ui && npm install && npm run build && cd ..
cd api && npm install && npm run build && cd ..

# Build the Docker image (run on target platform or use buildx)
docker build -t meshsense .
```

**Note:** The `serialport` native bindings and `simpleble.node` must match the target platform architecture. When building on ARM64 (e.g. Raspberry Pi), the correct bindings will be installed automatically.

## Headless Usage

To run MeshSense without a GUI, use the `--headless` flag. Additionally the `ACCESS_KEY` environment variable can be used to specify the privileged access key for remote connections to gain full permissions.

```sh
export ADDRESS=10.0.1.20  # Address of Meshtastic Node
export PORT=5920          # Port of remote interface

ACCESS_KEY=mySecretKey ./meshsense-x86_64.AppImage --headless

# Alternative execution:
dbus-run-session xvfb-run ./meshsense-arm64.AppImage --headless \
 --disable-gpu --in-process-gpu --disable-software-rasterizer
```

See also [Headless FAQ](https://affirmatech.com/meshsense/faq#headless)

## Debian Dependencies

Ubuntu and Raspberry Pi OS users will need the following dependency installed to run the AppImage:

```sh
sudo apt install libfuse2
```

To display unicode symbols on the buttons, it may be helpful to install `fonts-noto-color-emoji`

```sh
sudo apt install fonts-noto-color-emoji
```

## Development Setup

To run MeshSense from the source code, first clone the MeshSense repo:

```sh
git clone --recurse-submodules https://github.com/Affirmatech/MeshSense.git
cd MeshSense
```

Build `webbluetooth` Dependency.  Debian systems will need the `cmake` and `libdbus-1-dev` packages.

```
cd api/webbluetooth
npm i
npm run build:all
cd ../..
```

The `update.mjs` script will pull the latest code and install dependencies for the `ui`, `api`, and `electron` directories.

```sh
./update.mjs
```

During development, the electron portion is usually not needed. First start the UI Vite service as follows:

```sh
cd ui
PORT=5921 npm run dev
```

Leave the UI running and then also start the API service. The `DEV_UI_URL` will tell the API to forward any unhandled route requests to the UI service and should use the same port as above.

```sh
cd api
export DEV_UI_URL=http://localhost:5921
PORT=5920 npm run dev
```

The `PORT` variables in the above are optional and will default to the values in the example, but ensure `DEV_UI_URL` is present with the correct port if changed. These values may also be read from `.env` files `api/.env` and `ui/.env` respectively.

The front-end should now be accessible by connecting to the **API** service in a browser. Be careful not to connect to the UI service by accident. http://localhost:5920/

Any API changes will automatically reload the service. Any UI changes will be hot-reloaded by Vite.

**Please note:** currently certain event subscribers (particularly State variables) will duplicate their subscription when Vite hot-reloads resulting in duplicate events such as Log entries. Until this is fixed, the easiest solution is to refresh the browser to reset the events.

To build the `ui`, `api`, and `electron` components, the `build.mjs` script will accomplish this. The official electron builds are signed with an Affirmatech certificate on our build servers. The deployables will be placed in `api/dist` and `electron/dist`.
