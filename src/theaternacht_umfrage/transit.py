"""Build docs/data/transit_matrix.json from the hvv GTFS feed.

The full feed is far too large to ship to the browser, so this module runs a
Connection-Scan-Algorithm (CSA) journey planner *offline* over the schedule that
is active on the night of the Theaternacht (5 September 2026) and distils it into
a compact theatre-to-theatre travel matrix.

For every ordered pair of theatres and a handful of representative departure
times across the evening it stores the fastest public-transport journey
(duration, number of transfers and the individual legs) plus a straight-line
walking estimate. The route-planning front-end uses this matrix to sequence the
selected events, decide between walking and transit and print a schedule.
"""

from __future__ import annotations

import bisect
import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_GTFS = Path("hvv_Rohdaten")
DEFAULT_PROGRAMM = Path("docs/data/programm_manual.json")
DEFAULT_OUT = Path("docs/data/transit_matrix.json")

# The night of the Theaternacht.
TARGET_DATE = "20260905"  # Saturday

# Only keep the evening/night portion of the schedule (GTFS times may exceed 24h).
WINDOW_LO = 17 * 3600  # 17:00
WINDOW_HI = 27 * 3600  # 03:00 next day

# Representative departure times for which a journey is precomputed (seconds).
SAMPLE_TIMES = [
    18 * 3600,  # 18:00
    19 * 3600 + 30 * 60,  # 19:30
    21 * 3600,  # 21:00
    22 * 3600 + 30 * 60,  # 22:30
    24 * 3600,  # 00:00
    25 * 3600,  # 01:00
]

WALK_SPEED = 1.30  # m/s (~4.7 km/h)
FOOT_DETOUR = 1.30  # street detour factor vs. straight line
GEO_FOOT_RADIUS = 160.0  # metres: auto-generated transfer footpaths between stops
THEATER_ACCESS_RADIUS = 800.0  # metres: theatre <-> nearby stop walking access
MIN_CHANGE = 120  # seconds: buffer when changing vehicles at the same stop
INF = float("inf")


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def _tosec(t: str) -> int | None:
    if not t:
        return None
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _fmt_clock(sec: int) -> str:
    sec = int(round(sec))
    h = (sec // 3600) % 24
    m = (sec % 3600) // 60
    return f"{h:02d}:{m:02d}"


# --------------------------------------------------------------------------- #
# GTFS loading
# --------------------------------------------------------------------------- #


def _active_services(gtfs: Path) -> set[str]:
    active: set[str] = set()
    with (gtfs / "calendar.txt").open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["start_date"] <= TARGET_DATE <= r["end_date"] and r["saturday"] == "1":
                active.add(r["service_id"])
    added: set[str] = set()
    removed: set[str] = set()
    with (gtfs / "calendar_dates.txt").open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["date"] == TARGET_DATE:
                if r["exception_type"] == "1":
                    added.add(r["service_id"])
                elif r["exception_type"] == "2":
                    removed.add(r["service_id"])
    return (active | added) - removed


def _load_stops(gtfs: Path) -> dict[str, dict]:
    stops: dict[str, dict] = {}
    with (gtfs / "stops.txt").open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                lat = float(r["stop_lat"])
                lon = float(r["stop_lon"])
            except (ValueError, KeyError):
                continue
            stops[r["stop_id"]] = {
                "name": r.get("stop_name", ""),
                "lat": lat,
                "lon": lon,
            }
    return stops


def _load_routes(gtfs: Path) -> dict[str, str]:
    routes: dict[str, str] = {}
    with (gtfs / "routes.txt").open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            routes[r["route_id"]] = (r.get("route_short_name") or "").strip()
    return routes


def _load_trips(gtfs: Path, services: set[str]) -> dict[str, str]:
    """trip_id -> route_id for active trips only."""
    trips: dict[str, str] = {}
    with (gtfs / "trips.txt").open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["service_id"] in services:
                trips[r["trip_id"]] = r["route_id"]
    return trips


def _load_connections(gtfs: Path, trips: dict[str, str]) -> list[tuple]:
    """Return connections (dep_stop, arr_stop, dep_t, arr_t, trip_id) inside the
    evening window, sorted by departure time."""
    by_trip: dict[str, list[tuple[int, str, int, int]]] = defaultdict(list)
    with (gtfs / "stop_times.txt").open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            tid = r["trip_id"]
            if tid not in trips:
                continue
            dep = _tosec(r["departure_time"])
            arr = _tosec(r["arrival_time"])
            if dep is None:
                dep = arr
            if arr is None:
                arr = dep
            if dep is None:
                continue
            by_trip[tid].append((int(r["stop_sequence"]), r["stop_id"], arr, dep))

    connections: list[tuple] = []
    for tid, seq in by_trip.items():
        seq.sort()
        for a, b in zip(seq, seq[1:]):
            _, s1, _, dep_t = a
            _, s2, arr_t, _ = b
            if arr_t < dep_t:  # guard against malformed rows
                continue
            if WINDOW_LO <= dep_t <= WINDOW_HI:
                connections.append((s1, s2, dep_t, arr_t, tid))
    connections.sort(key=lambda c: c[2])
    return connections


def _load_transfers(gtfs: Path) -> list[tuple[str, str, int]]:
    out: list[tuple[str, str, int]] = []
    path = gtfs / "transfers.txt"
    if not path.exists():
        return out
    with path.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            frm = r.get("from_stop_id")
            to = r.get("to_stop_id")
            if not frm or not to or frm == to:
                continue
            try:
                t = int(r.get("min_transfer_time") or 0)
            except ValueError:
                t = 0
            out.append((frm, to, max(t, 30)))
    return out


# --------------------------------------------------------------------------- #
# Footpath graph (grid-accelerated)
# --------------------------------------------------------------------------- #


def _build_grid(stops: dict[str, dict], used: set[str], cell_m: float):
    """Bucket stops into a fixed lon/lat grid. Longitude uses a fixed reference
    latitude (Hamburg ~53.55) so cells line up predictably."""
    dlat = cell_m / 111_320.0
    dlon = cell_m / (111_320.0 * math.cos(math.radians(53.55)))
    grid: dict[tuple[int, int], list[str]] = defaultdict(list)
    for sid in used:
        s = stops[sid]
        grid[(int(s["lat"] / dlat), int(s["lon"] / dlon))].append(sid)
    return grid, dlat, dlon


def _nearby(stops, grid, dlat, dlon, lat, lon, radius_m):
    """Yield (stop_id, distance_m) for stops within ``radius_m`` of a point."""
    gi = int(lat / dlat)
    gj = int(lon / dlon)
    span_i = int(radius_m / (dlat * 111_320.0)) + 1
    span_j = int(radius_m / (dlon * 111_320.0 * math.cos(math.radians(53.55)))) + 1
    for di in range(-span_i, span_i + 1):
        for dj in range(-span_j, span_j + 1):
            for sid in grid.get((gi + di, gj + dj), ()):
                s = stops[sid]
                d = _haversine(lat, lon, s["lat"], s["lon"])
                if d <= radius_m:
                    yield sid, d


def _geo_footpaths(stops, used):
    """Generate short walking transfers between nearby stops via a spatial grid."""
    grid, _dlat, _dlon = _build_grid(stops, used, cell_m=GEO_FOOT_RADIUS)

    foot: list[tuple[str, str, int]] = []
    for (gi, gj), ids in grid.items():
        # Compare against this cell and the 8 neighbours.
        cand: list[str] = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                cand.extend(grid.get((gi + di, gj + dj), ()))
        for a in ids:
            sa = stops[a]
            for b in cand:
                if a == b:
                    continue
                sb = stops[b]
                d = _haversine(sa["lat"], sa["lon"], sb["lat"], sb["lon"])
                if d <= GEO_FOOT_RADIUS:
                    secs = int(d * FOOT_DETOUR / WALK_SPEED) + 20
                    foot.append((a, b, secs))
    return foot


# --------------------------------------------------------------------------- #
# CSA journey planner
# --------------------------------------------------------------------------- #


class Planner:
    def __init__(self, connections, footpaths, stop_index, n_stops, routes, trips, stops_meta):
        self.dep_stop = [c[0] for c in connections]
        self.arr_stop = [c[1] for c in connections]
        self.dep_t = [c[2] for c in connections]
        self.arr_t = [c[3] for c in connections]
        self.trip = [c[4] for c in connections]
        self.footpaths = footpaths  # idx -> list[(idx, secs)]
        self.n_stops = n_stops
        self.routes = routes
        self.trips = trips
        self.stops_meta = stops_meta  # idx -> {name,...}

    def earliest(self, source_idx, dep_time, targets):
        """Single-source CSA. Returns {target_idx: journey dict} for reachable
        targets. ``journey`` = {arr, transfers, legs}."""
        n = self.n_stops
        arr = [INF] * n
        pred_type = [0] * n  # 0 none, 1 connection, 2 foot
        pred_val = [-1] * n  # connection index or predecessor stop idx
        foot_reached = [False] * n
        trip_reached: dict[str, bool] = {}

        def relax_foot(stop, time):
            for nb, secs in self.footpaths[stop]:
                nt = time + secs
                if nt < arr[nb]:
                    arr[nb] = nt
                    pred_type[nb] = 2
                    pred_val[nb] = stop
                    foot_reached[nb] = True

        arr[source_idx] = dep_time
        foot_reached[source_idx] = True
        relax_foot(source_idx, dep_time)

        dep_stop = self.dep_stop
        arr_stop = self.arr_stop
        dep_t = self.dep_t
        arr_t = self.arr_t
        trip = self.trip

        # Skip connections that depart before our start.
        start = bisect.bisect_left(dep_t, dep_time)
        for i in range(start, len(dep_t)):
            ds = dep_stop[i]
            tid = trip[i]
            on_trip = trip_reached.get(tid, False)
            if not on_trip:
                a = arr[ds]
                if a == INF:
                    continue
                buffer = 0 if foot_reached[ds] else MIN_CHANGE
                if a + buffer > dep_t[i]:
                    continue
                trip_reached[tid] = True
            as_ = arr_stop[i]
            at = arr_t[i]
            if at < arr[as_]:
                arr[as_] = at
                pred_type[as_] = 1
                pred_val[as_] = i
                foot_reached[as_] = False
                relax_foot(as_, at)

        out = {}
        for t in targets:
            if arr[t] < INF:
                out[t] = self._reconstruct(t, source_idx, arr, pred_type, pred_val)
        return out

    def _reconstruct(self, target, source, arr, pred_type, pred_val):
        # Walk predecessors back to source collecting raw hops.
        hops = []  # ('c', conn_idx) or ('f', from_idx, to_idx)
        cur = target
        guard = 0
        while cur != source and guard < 100000:
            guard += 1
            pt = pred_type[cur]
            if pt == 1:
                ci = pred_val[cur]
                hops.append(("c", ci))
                cur = self.dep_stop[ci]
            elif pt == 2:
                frm = pred_val[cur]
                hops.append(("f", frm, cur))
                cur = frm
            else:
                break
        hops.reverse()

        legs = []
        i = 0
        while i < len(hops):
            h = hops[i]
            if h[0] == "f":
                # Merge consecutive foot hops.
                frm = h[1]
                to = h[2]
                j = i + 1
                while j < len(hops) and hops[j][0] == "f":
                    to = hops[j][2]
                    j += 1
                legs.append(
                    {
                        "mode": "walk",
                        "from": self._name(frm),
                        "to": self._name(to),
                    }
                )
                i = j
            else:
                ci = h[1]
                tid = self.trip[ci]
                board = self.dep_stop[ci]
                dep = self.dep_t[ci]
                alight = self.arr_stop[ci]
                arr_time = self.arr_t[ci]
                j = i + 1
                while j < len(hops) and hops[j][0] == "c" and self.trip[hops[j][1]] == tid:
                    alight = self.arr_stop[hops[j][1]]
                    arr_time = self.arr_t[hops[j][1]]
                    j += 1
                legs.append(
                    {
                        "mode": "transit",
                        "line": self.routes.get(self.trips.get(tid, ""), ""),
                        "from": self._name(board),
                        "to": self._name(alight),
                        "dep": _fmt_clock(dep),
                        "arr": _fmt_clock(arr_time),
                    }
                )
                i = j

        transfers = max(0, sum(1 for l in legs if l["mode"] == "transit") - 1)
        return {"arr": arr[target], "transfers": transfers, "legs": legs}

    def _name(self, idx):
        return self.stops_meta[idx]["name"]


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def build_transit(
    out: Path = DEFAULT_OUT,
    gtfs: Path = DEFAULT_GTFS,
    programm_path: Path = DEFAULT_PROGRAMM,
) -> dict:
    print("Loading GTFS…")
    services = _active_services(gtfs)
    print(f"  active services on {TARGET_DATE}: {len(services)}")
    stops = _load_stops(gtfs)
    routes = _load_routes(gtfs)
    trips = _load_trips(gtfs, services)
    print(f"  active trips: {len(trips)}")
    connections = _load_connections(gtfs, trips)
    print(f"  evening connections: {len(connections)}")

    programm = json.loads(programm_path.read_text(encoding="utf-8"))
    theaters = [t for t in programm.get("theaters", []) if t.get("lat") is not None]

    # Stops actually used by evening connections + transfers.
    transfers = _load_transfers(gtfs)
    used: set[str] = set()
    for c in connections:
        used.add(c[0])
        used.add(c[1])
    for frm, to, _ in transfers:
        if frm in stops and to in stops:
            used.add(frm)
            used.add(to)

    # Theatre access footpaths.
    grid, dlat, dlon = _build_grid(stops, used, cell_m=THEATER_ACCESS_RADIUS)
    theater_access: dict[str, list[tuple[str, float]]] = {}
    for t in theaters:
        near = []
        seen = set()
        for sid, d in _nearby(stops, grid, dlat, dlon, t["lat"], t["lng"], THEATER_ACCESS_RADIUS):
            if sid in seen:
                continue
            seen.add(sid)
            near.append((sid, d))
        near.sort(key=lambda x: x[1])
        theater_access[t["id"]] = near[:12]

    # Build stop index (real stops + virtual theatre stops).
    stop_ids = sorted(used)
    for t in theaters:
        stop_ids.append("TH:" + t["id"])
    stop_index = {sid: i for i, sid in enumerate(stop_ids)}
    n_stops = len(stop_ids)
    stops_meta = [None] * n_stops
    for sid, i in stop_index.items():
        if sid.startswith("TH:"):
            stops_meta[i] = {"name": "TH:" + sid[3:]}
        else:
            stops_meta[i] = {"name": stops[sid]["name"]}

    # Re-index connections to integer stop indices.
    iconn = [
        (stop_index[c[0]], stop_index[c[1]], c[2], c[3], c[4])
        for c in connections
        if c[0] in stop_index and c[1] in stop_index
    ]

    # Footpath adjacency (integer indices, symmetric).
    foot_adj: list[list[tuple[int, int]]] = [[] for _ in range(n_stops)]

    def add_foot(a_id, b_id, secs):
        if a_id not in stop_index or b_id not in stop_index:
            return
        foot_adj[stop_index[a_id]].append((stop_index[b_id], secs))

    print("Building footpaths…")
    for frm, to, secs in transfers:
        add_foot(frm, to, secs)
    for a, b, secs in _geo_footpaths(stops, used):
        add_foot(a, b, secs)
    # Theatre <-> stop access (walking), both directions.
    for t in theaters:
        vid = "TH:" + t["id"]
        for sid, d in theater_access[t["id"]]:
            secs = int(d * FOOT_DETOUR / WALK_SPEED) + 30
            add_foot(vid, sid, secs)
            add_foot(sid, vid, secs)

    planner = Planner(iconn, foot_adj, stop_index, n_stops, routes, trips, stops_meta)

    # Resolve theatre stop names to real venue names for legs.
    th_name = {t["id"]: t["name"] for t in theaters}
    for i, m in enumerate(stops_meta):
        if m["name"].startswith("TH:"):
            m["name"] = th_name.get(m["name"][3:], m["name"])

    target_idx = {t["id"]: stop_index["TH:" + t["id"]] for t in theaters}
    all_targets = list(target_idx.values())
    idx_to_theater = {v: k for k, v in target_idx.items()}

    print(f"Planning journeys for {len(theaters)} theatres × {len(SAMPLE_TIMES)} times…")
    transit_out: dict[str, list] = defaultdict(list)
    for n, t in enumerate(theaters, 1):
        src_id = t["id"]
        src_idx = target_idx[src_id]
        for dep in SAMPLE_TIMES:
            results = planner.earliest(src_idx, dep, all_targets)
            for tgt_idx, journey in results.items():
                dst_id = idx_to_theater[tgt_idx]
                if dst_id == src_id:
                    continue
                dur_min = round((journey["arr"] - dep) / 60)
                if dur_min <= 0 or dur_min > 180:
                    continue
                transit_out[f"{src_id}|{dst_id}"].append(
                    {
                        "t": dep,
                        "dur_min": dur_min,
                        "transfers": journey["transfers"],
                        "legs": [
                            l for l in journey["legs"] if l["mode"] == "transit"
                        ],
                    }
                )
        print(f"  [{n}/{len(theaters)}] {src_id}")

    # Walking matrix (symmetric straight-line estimate).
    walk_out: dict[str, dict] = {}
    for a in theaters:
        for b in theaters:
            if a["id"] == b["id"]:
                continue
            d = _haversine(a["lat"], a["lng"], b["lat"], b["lng"]) * FOOT_DETOUR
            walk_out[f"{a['id']}|{b['id']}"] = {
                "min": round(d / WALK_SPEED / 60),
                "meters": round(d),
            }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "date": "2026-09-05",
        "sample_times": SAMPLE_TIMES,
        "theaters": {
            t["id"]: {"name": t["name"], "lat": t["lat"], "lng": t["lng"]}
            for t in theaters
        },
        "walk": walk_out,
        "transit": transit_out,
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {out} ({out.stat().st_size // 1024} KiB)")
    return payload
