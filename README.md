# TNC — rider & driver apps + API

Monorepo for testing the core rideshare loop: **request → driver sees it → accept → rider sees acceptance and driver on the map → driver sees rider pickup on the map** (with live driver location over Socket.io).

## Stack

- **API:** Express, MongoDB (Mongoose), Socket.io, JWT auth  
- **Apps:** Expo (React Native), `react-native-maps` (Google provider), `socket.io-client`

## Prerequisites

- Node 20+ recommended  
- MongoDB on `127.0.0.1:27017` (or set `MONGODB_URI`)  
- [Google Maps SDK keys](https://console.cloud.google.com/) for iOS and Android map tiles (Maps SDK for iOS / Android enabled)

## Setup

```bash
cd /path/to/tnc
cp apps/api/.env.example apps/api/.env
cp .env.example .env
npm install
```

Edit **`/.env`** at the repo root (not committed to git) for the mobile apps: **`EXPO_PUBLIC_API_URL`** is the Express API base URL. Both `apps/rider` and `apps/driver` load it via `app.config.js` + `dotenv`.

### API URL on devices

- **iOS Simulator:** `EXPO_PUBLIC_API_URL=http://localhost:3000` in **`.env`** is fine.  
- **Android Emulator:** set `http://10.0.2.2:3000` in **`.env`**.  
- **Physical device:** set your machine’s LAN IP in **`.env`**, e.g. `http://192.168.1.10:3000`.

Restart Expo after changing **`.env`** so Metro picks up the new value.

Do **not** run plain `npx expo start` from the monorepo root without a path: there is no `App.js` at the repo root, so Metro will fail to resolve `App`. Use **`npm run dev:rider`**, **`npm run dev:driver`**, or `cd apps/rider && npx expo start`.

### Google Maps keys in native builds

`react-native-maps` with `PROVIDER_GOOGLE` needs keys in the native config. This repo reads **`GOOGLE_MAPS_API_KEY`** when you run prebuild / dev client:

```bash
cd apps/rider
GOOGLE_MAPS_API_KEY=your_key npx expo prebuild
# or pass the same env when using EAS / local native runs
```

For a quick **Expo Go** smoke test, maps may fall back or behave differently; a **development build** is the reliable way to verify Google tiles.

## Run the API

```bash
npm run dev:api
```

## Run the apps (two terminals)

From repository root (recommended; `--go` opens in **Expo Go**, not a missing dev client):

```bash
npm run dev:rider
npm run dev:driver
```

Or from each app folder:

```bash
cd apps/rider && npx expo start --go
cd apps/driver && npx expo start --go
```

Use different simulator/device targets or two simulators. Register **one rider** and **one driver** (separate emails).

## Happy-path test

1. **Driver:** log in, stay on **Open requests**.  
2. **Rider:** log in, set pickup (tap map or **My location**), **Request ride**.  
3. **Driver:** the request should appear (socket + refresh); tap **Accept**.  
4. **Rider:** status shows accepted; **green pin** updates as the driver moves (location stream).  
5. **Driver:** map shows **blue = rider pickup**, **green = you**; location is emitted to the server.  
6. **Driver:** **Complete trip** when done so both sides can run another request.

## Project layout

- `apps/api` — HTTP + Socket.io  
- `apps/rider` — rider UI  
- `apps/driver` — driver UI  
- `packages/shared` — tiny shared constants in plain JS (optional to import later)
