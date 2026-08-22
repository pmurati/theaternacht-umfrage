"""Build docs/data/programm.json from the listing page + content API."""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .api import ImxClient, html_to_text
from .models import Programm, Show, Theater
from .scrape import LISTING_URL, ListingRow, fetch_listing_html, parse_listing

USER_AGENT = "theaternacht-umfrage/0.1 (+https://github.com)"

_VENUE_SUFFIX_RE = re.compile(r"\s*\(([^)]*)\)\s*$")
_TREFFPUNKT_RE = re.compile(r"^Treffpunkt:\s*", re.IGNORECASE)


def _base_name(theater: str) -> str:
    name = _TREFFPUNKT_RE.sub("", theater)
    name = _VENUE_SUFFIX_RE.sub("", name)
    return name.strip()


def _venue_part(theater: str) -> str:
    if _TREFFPUNKT_RE.match(theater):
        return "Treffpunkt"
    m = _VENUE_SUFFIX_RE.search(theater)
    return m.group(1).strip() if m else ""


def _slug(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii").lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or "theater"


def _fmt_time(start_time: str) -> str:
    # "19:00:00" -> "19:00"
    return start_time[:5] if start_time else ""


def _time_sort_key(t: str) -> tuple[int, int]:
    try:
        h, m = (int(x) for x in t.split(":", 1))
    except ValueError:
        return (99, 99)
    # After-midnight slots belong at the end of the evening.
    if h < 6:
        h += 24
    return (h, m)


def _coords(event: dict) -> tuple[float | None, float | None]:
    for key in ("location", None):
        geo = (
            (event.get("location") or {}).get("geoInfo")
            if key
            else event.get("geoInfo")
        )
        coords = (geo or {}).get("coordinates") or {}
        lat, lng = coords.get("latitude"), coords.get("longitude")
        if lat is not None and lng is not None:
            return float(lat), float(lng)
    return None, None


def _address(event: dict) -> str:
    geo = (event.get("location") or {}).get("geoInfo") or event.get("geoInfo") or {}
    street = " ".join(p for p in (geo.get("street"), geo.get("streetNo")) if p)
    city = " ".join(p for p in (geo.get("zipcode"), geo.get("city")) if p)
    return ", ".join(p for p in (street.strip(), city.strip()) if p)


def _description(event: dict) -> str:
    return html_to_text(event.get("longDescription")) or html_to_text(
        event.get("shortDescription")
    )


def _times_from_event(event: dict) -> list[str]:
    times = {_fmt_time(d.get("startTime", "")) for d in event.get("eventDates") or []}
    return sorted((t for t in times if t), key=_time_sort_key)


def build_programm(client: httpx.Client) -> Programm:
    rows = parse_listing(fetch_listing_html(client))
    api = ImxClient.create(client)

    # Preserve first-seen order of permaLinks; collect listing fallback data.
    order: list[str] = []
    listing_by_perma: dict[str, list[ListingRow]] = defaultdict(list)
    for row in rows:
        if row.permalink not in listing_by_perma:
            order.append(row.permalink)
        listing_by_perma[row.permalink].append(row)

    # Fetch details and assign each show to a location group.
    groups: dict[str, list[dict]] = defaultdict(list)
    for permalink in order:
        listing_rows = listing_by_perma[permalink]
        event = api.event_by_permalink(permalink)
        if event is None:
            # Fall back to listing-only data (no coordinates -> skip on map later).
            event = {}

        lat, lng = _coords(event)
        theater_label = listing_rows[0].theater
        times = _times_from_event(event) or sorted(
            {r.time for r in listing_rows if r.time}, key=_time_sort_key
        )
        show = Show(
            id=permalink,
            title=event.get("title", "").strip() or listing_rows[0].title,
            venue=_venue_part(theater_label),
            times=times,
            description=_description(event),
        )
        # Group sub-stages of the same building (they share the base name).
        key = _base_name(theater_label)
        groups[key].append(
            {
                "show": show,
                "lat": lat,
                "lng": lng,
                "base_name": _base_name(theater_label),
                "address": _address(event),
            }
        )

    theaters: list[Theater] = []
    for members in groups.values():
        base_names = Counter(m["base_name"] for m in members)
        name = base_names.most_common(1)[0][0]
        lat = next((m["lat"] for m in members if m["lat"] is not None), None)
        lng = next((m["lng"] for m in members if m["lng"] is not None), None)
        address = next((m["address"] for m in members if m["address"]), "")
        shows = [m["show"] for m in members]
        shows.sort(key=lambda s: _time_sort_key(s.times[0]) if s.times else (99, 99))
        theaters.append(
            Theater(
                id=_slug(name),
                name=name,
                address=address,
                lat=lat,
                lng=lng,
                shows=shows,
            )
        )

    theaters.sort(key=lambda t: t.name.lower())
    return Programm(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        source_url=LISTING_URL,
        theaters=theaters,
    )


def write_programm(programm: Programm, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(programm.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def run(out_path: Path) -> Programm:
    with httpx.Client(
        timeout=30.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True
    ) as client:
        programm = build_programm(client)
    write_programm(programm, out_path)
    return programm
