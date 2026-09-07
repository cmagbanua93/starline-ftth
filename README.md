# StarLine FTTH Network

A map-based manager for StarLine Internet's fiber plant in Minglanilla, Cebu.
Styled to the StarLine brand — navy and gold, Montserrat/Open Sans/Lato.
Pin OLTs, NAP boxes and splitters on a real map, configure each physical port,
wire port-to-port fiber links, hang subscribers off NAP ports, and trace what
goes dark when a segment breaks.

## What it does

- **Map layout** — Leaflet with OpenStreetMap street view, Esri satellite and
  satellite+labels layers. Pins are draggable; positions save on drop.
- **Devices** — OLT, NAP box, splitter and joint/closure, each with a name,
  model, split ratio, area/barangay, address, status and notes.
- **Real ports, in two kinds** — every device has *feeder-in* ports (the cable
  arriving from upstream) and *output* ports. A 1:8 NAP is one feeder-in plus
  eight outputs; an OLT is all outputs. Ports carry a label, a status
  (free / used / reserved / faulty) and notes. Changing a device's port count
  adds or removes ports, never destroying a port that is in use.
- **Closures are splices, not patch panels** — a joint closure has no ports in
  the NAP sense. Each core is one fusion splice with an arriving side and a
  continuing side, both carrying that core's colour: white in, white out. The
  closure shows as a splice table — core, arrives from, continues to — and a
  cable passing through it is two links joined at the splice, so tracing goes
  *through* the closure rather than around it. Cores are independent: cutting the
  feeder on core 1 leaves core 5's traffic alone.
- **Pigtail colour coding** — output ports are assigned their TIA-598-C colour
  by position (Blue, Orange, Green, Brown, Slate, White, Red, Black, …). Each
  device chooses how its ports are labelled: **number**, **pigtail colour**, or
  **both**. In colour mode the cell is filled with the actual pigtail colour and
  port status is shown as a ring around it.
- **Port-to-port links** — connect a specific port on one device to a specific
  port on another (OLT PON → NAP, NAP → NAP daisy chain, splitter fan-out).
  Each link stores cable length, fiber core, cable type and status, and is drawn
  on the map. Straight-line distance is pre-filled as a length estimate.
- **Re-pointing a cable** — either end of a link can be moved onto a different
  port without deleting it, keeping its traced route, length and notes. A port
  that is already taken says so and offers the move, so a mis-landed feeder is a
  two-click correction rather than a rebuild.
- **Traced cable routes** — cable does not run in straight lines, so any link can
  be traced along the road. Click waypoints on the map, drag them to adjust,
  click one to remove it; the app reports the real run length and can copy it
  into the link's cable length. Waypoints live in `links.path` and the drawn line
  follows them.
- **Subscribers** — assign a household to a free NAP port with plan, PPPoE
  username, ONU serial, address, drop length and install date. The house pin and
  its drop cable are drawn on the map.
- **Fault tracing** — mark a link as cut, or ask "what if this device is down",
  and get the exact list of subscribers and devices that lose their path back to
  an OLT, highlighted on the map.
- **Capacity view** — colour pins by free-port ratio (green / amber / red) to see
  at a glance where you can still sell connections.
- **Isolated devices** — highlight anything with no live path to an OLT.
- **Search** — devices, subscribers, PPPoE usernames, ONU serials, port labels.
- **Export** — a JSON backup of the whole network.

## Running it

```bash
npm install
DATABASE_URL=postgres://user:pass@host:5432/ftth npm start
```

Open http://localhost:3000.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. The schema is created on boot. |
| `APP_PASSWORD` | Shared password for the sign-in gate. Leave unset and the app is open to anyone with the URL. |
| `SESSION_SECRET` | Signs the session cookie. Set it so sessions survive restarts. |
| `PORT` | Listen port (Railway sets this). |

### Seeding demo data

```bash
BASE=http://localhost:3000 node seed.js
```

Creates one OLT, four NAP boxes, a splitter, five fiber links and seven
subscribers around Minglanilla, so you can see how the pieces fit before
entering the real plant.

## Data model

```
devices ──< ports ──< links (from_port_id ⇄ to_port_id, one link per port)
                 └──< subscribers (one subscriber per port)
```

Ports have a `port_kind` of `in` or `out`. This is a labelling convenience, not a
constraint: any port can link to any port on another device. An OLT PON feeds a
NAP's input, a NAP output daisy-chains to the next NAP's input, and a closure can
be fed from two directions with two inputs. Joining two feeder-ins is unusual
enough that the UI asks first, but it is allowed — a splice closure joins cores in
whatever direction the plant actually runs.

Reachability is computed over **ports**, not devices, because what is joined
inside a box differs by type: a closure joins core n's in side to core n's out
side and nothing else; a NAP or splitter feeds every output from its feeder;
an OLT's PON ports are independent sources.

Feed direction is not stored — anything reachable from an OLT through live
splices and links is downstream of it. That is what makes impact analysis honest: it recomputes
reachability with the failed element removed instead of relying on a hand-drawn
hierarchy.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/network` | Everything: devices, ports, links, subscribers, capacity, reachability |
| POST/PATCH/DELETE | `/api/devices[/:id]` | Manage devices (port grid syncs automatically) |
| PATCH | `/api/ports/:id` | Label, status, notes |
| POST/PATCH/DELETE | `/api/links[/:id]` | Fiber links between two ports |
| POST/PATCH/DELETE | `/api/subscribers[/:id]` | Households on ports |
| GET | `/api/impact?linkId=` or `?deviceId=` | Who goes dark |
| GET | `/api/trace/:deviceId` | Path from a device back to its OLT |
| GET | `/api/export` | JSON backup |
