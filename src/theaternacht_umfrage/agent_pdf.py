"""Alternative data source: extract the program per theater from the official
Theaternacht program booklet (PDF) using a pydantic_ai agent.

Motivation: the listing/content API groups some houses (e.g. Thalia Gaußstraße,
Kampnagel) into a single umbrella event, so their individual program points are
buried inside one description. The printed booklet lists every point explicitly.

This module downloads the booklet, extracts the text per page, feeds overlapping
page windows to an LLM agent (so no theater is torn apart at a chunk boundary),
and merges the structured results into the same shape as ``programm.json``.

The result is written to a *separate* file (``programm_agent.json`` by default)
so it can be reviewed manually before replacing the primary data. Coordinates and
addresses are enriched from an existing ``programm.json`` when a theater name
matches; otherwise they stay ``null`` for manual completion.

Requires OPENAI_API_KEY (see env.example).
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from pydantic_ai import Agent

from .build import _slug, _time_sort_key
from .models import Programm, Show, Theater

PDF_URL = (
    "https://theater-hamburg.org/downloads/theaternacht_hamburg_programmheft_2026.pdf"
)
DEFAULT_CACHE = Path(".cache/programmheft.pdf")

# Program section of the 2026 booklet (0-based page indices). The first pages are
# foreword/tickets/maps; the theater listings run from "Alma Hoppes" onward.
PROGRAM_FIRST_PAGE = 6
PROGRAM_LAST_PAGE = 24  # inclusive

# Overlapping page windows: window of WINDOW pages advancing by STEP pages. With
# an overlap of (WINDOW - STEP) pages, any theater spanning up to two pages is
# fully contained in at least one window.
WINDOW = 3
STEP = 2


SYSTEM_PROMPT = (
    "Du extrahierst das Programm der Langen Nacht der Theater Hamburg aus dem "
    "offiziellen Programmheft. Du bekommst den Rohtext einiger aufeinanderfolgender "
    "Seiten. Gib strukturiert JEDES Theaterhaus mit seinen EINZELNEN Programmpunkten "
    "zurueck.\n"
    "\n"
    "Regeln:\n"
    "- Ein Theaterhaus ist eine Ueberschrift (Eigenname), gefolgt von Adresse, "
    "Website, hvv-Haltestelle und einem Beschreibungstext.\n"
    "- Danach folgen die Programmpunkte. Jeder Programmpunkt beginnt typischerweise "
    "mit einer Zeitangabe wie '19:00 - 19:20 Uhr, Buehne' oder 'ab 18:00 Uhr, Foyer'. "
    "Die Zeile danach ist der Titel (oft mit ':' gefolgt von einer kurzen Beschreibung).\n"
    "- Erzeuge pro Programmpunkt genau EINEN Eintrag mit: title (praegnanter Titel "
    "ohne Uhrzeit), venue (Buehne/Ort wie 'Hauptbuehne', 'LABOR', 'Foyer'; sonst leer), "
    "times (Liste aller Startzeiten im Format 'HH:MM'), description (der erklaerende "
    "Satz zum Punkt, ohne Uhrzeit/Buehne; sonst leer).\n"
    "- Fasse denselben Programmpunkt, der zu mehreren Uhrzeiten laeuft, zu EINEM "
    "Eintrag mit mehreren times zusammen.\n"
    "- Ignoriere reine Info-/Service-Abschnitte (Tickets, Anfahrt, Barrierefreiheit, "
    "Aftershowparty-Allgemeintext, Impressum, Seitenzahlen).\n"
    "- Uebernimm den allgemeinen Haus-Beschreibungstext NICHT als Programmpunkt.\n"
    "- Behalte Titel und Beschreibung woertlich aus dem Heft (nur offensichtliche "
    "Silbentrennungs-Bindestriche am Zeilenende zusammenfuegen). Erfinde nichts.\n"
    "- Wenn ein Haus auf den gegebenen Seiten nur angeschnitten ist, gib nur die "
    "erkennbaren Punkte zurueck."
)


class AgentShow(BaseModel):
    title: str
    venue: str = ""
    times: list[str] = Field(default_factory=list)
    description: str = ""


class AgentTheater(BaseModel):
    name: str = Field(description="Name des Theaterhauses laut Ueberschrift.")
    address: str = Field(default="", description="Strasse + PLZ Ort, falls im Text.")
    shows: list[AgentShow] = Field(default_factory=list)


class ChunkResult(BaseModel):
    theaters: list[AgentTheater] = Field(default_factory=list)


def download_pdf(client: httpx.Client, url: str, cache_path: Path) -> Path:
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return cache_path
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    resp = client.get(url)
    resp.raise_for_status()
    cache_path.write_bytes(resp.content)
    return cache_path


def extract_pages(pdf_path: Path) -> list[str]:
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    return [(page.extract_text() or "") for page in reader.pages]


def _windows(first: int, last: int) -> list[tuple[int, int]]:
    """Return inclusive (start, end) page-index windows covering [first, last]."""
    spans: list[tuple[int, int]] = []
    start = first
    while start <= last:
        end = min(start + WINDOW - 1, last)
        spans.append((start, end))
        if end == last:
            break
        start += STEP
    return spans


def _build_agent() -> Agent[None, ChunkResult]:
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    # Allow OPENAI_MODEL to be given with or without the "openai:" provider prefix.
    if ":" not in model:
        model = f"openai:{model}"
    return Agent(model, output_type=ChunkResult, system_prompt=SYSTEM_PROMPT)


_TIME_RE = re.compile(r"\b(\d{1,2})[:.](\d{2})\b")

_UMLAUT_MAP = str.maketrans({"ß": "ss", "ä": "ae", "ö": "oe", "ü": "ue"})


def _norm_time(raw: str) -> str | None:
    m = _TIME_RE.search(raw)
    if not m:
        return None
    h, mnt = int(m.group(1)), int(m.group(2))
    if h > 27 or mnt > 59:
        return None
    return f"{h:02d}:{mnt:02d}"


def _clean_times(times: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for t in times:
        norm = _norm_time(t)
        if norm:
            seen.setdefault(norm, None)
    return sorted(seen, key=_time_sort_key)


def _norm_name(name: str) -> str:
    n = name.lower().translate(_UMLAUT_MAP)
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode("ascii")
    n = re.sub(r"[^a-z0-9]+", " ", n).strip()
    # Drop a leading German article so "Die Hamburgische Staatsoper" and
    # "Hamburgische Staatsoper" merge to the same theater.
    n = re.sub(r"^(die|das|der) ", "", n)
    return n


def _norm_title(title: str) -> str:
    return _norm_name(title)


def _load_coord_index(programm_path: Path) -> dict[str, dict]:
    if not programm_path.exists():
        return {}
    data = json.loads(programm_path.read_text(encoding="utf-8"))
    index: dict[str, dict] = {}
    for th in data.get("theaters", []):
        key = _norm_name(th.get("name", ""))
        if key:
            index[key] = th
    return index


def _match_coords(name: str, index: dict[str, dict]) -> dict | None:
    key = _norm_name(name)
    if key in index:
        return index[key]
    # Substring match in either direction (e.g. "Ernst Deutsch Theater" vs
    # "Ernst Deutsch Theater (Hauptbuehne)").
    for other_key, th in index.items():
        if key and (key in other_key or other_key in key):
            return th
    # Compare with all whitespace removed ("Deutsches SchauSpielHaus" vs
    # "DeutschesSchauSpielHaus").
    tight = key.replace(" ", "")
    for other_key, th in index.items():
        other_tight = other_key.replace(" ", "")
        if tight and (tight in other_tight or other_tight in tight):
            return th
    return None


def _merge_show(target: AgentShow, extra: AgentShow) -> None:
    target.times = _clean_times(target.times + extra.times)
    if len(extra.description) > len(target.description):
        target.description = extra.description
    if not target.venue and extra.venue:
        target.venue = extra.venue
    # Keep the shorter, cleaner title (the longer one often trails into the
    # description, e.g. "Prost!" vs "Prost! An unserer sieben Meter langen Bar").
    if len(extra.title) < len(target.title):
        target.title = extra.title


def _titles_duplicate(a: str, b: str) -> bool:
    """Two program points are the same if their normalized titles match or one
    is a prefix of the other (agents sometimes append the subtitle to the title)."""
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return len(shorter) >= 4 and longer.startswith(shorter)


def _find_duplicate(title_key: str, existing: dict[str, AgentShow]) -> AgentShow | None:
    if title_key in existing:
        return existing[title_key]
    for key, show in existing.items():
        if _titles_duplicate(title_key, key):
            return show
    return None


def _merge_theaters(chunks: list[ChunkResult]) -> list[AgentTheater]:
    by_name: dict[str, AgentTheater] = {}
    order: list[str] = []
    for chunk in chunks:
        for th in chunk.theaters:
            key = _norm_name(th.name)
            if not key:
                continue
            if key not in by_name:
                by_name[key] = AgentTheater(name=th.name, address=th.address)
                order.append(key)
            merged = by_name[key]
            if not merged.address and th.address:
                merged.address = th.address
            existing = {_norm_title(s.title): s for s in merged.shows}
            for show in th.shows:
                tkey = _norm_title(show.title)
                if not tkey:
                    continue
                dup = _find_duplicate(tkey, existing)
                if dup is not None:
                    _merge_show(dup, show)
                else:
                    existing[tkey] = show
                    merged.shows.append(show)
    return [by_name[k] for k in order]


def _to_programm(
    theaters: list[AgentTheater], coord_index: dict[str, dict], source_url: str
) -> Programm:
    out: list[Theater] = []
    for at in theaters:
        match = _match_coords(at.name, coord_index)
        lat = match.get("lat") if match else None
        lng = match.get("lng") if match else None
        address = at.address or (match.get("address", "") if match else "")

        shows: list[Show] = []
        used_ids: set[str] = set()
        for s in at.shows:
            base = _slug(s.title)
            sid = base
            i = 2
            while sid in used_ids:
                sid = f"{base}-{i}"
                i += 1
            used_ids.add(sid)
            shows.append(
                Show(
                    id=sid,
                    title=s.title.strip(),
                    venue=s.venue.strip(),
                    times=_clean_times(s.times),
                    description=s.description.strip(),
                )
            )
        shows.sort(key=lambda s: _time_sort_key(s.times[0]) if s.times else (99, 99))

        out.append(
            Theater(
                id=_slug(at.name),
                name=at.name.strip(),
                address=address,
                lat=lat,
                lng=lng,
                shows=shows,
            )
        )

    out.sort(key=lambda t: t.name.lower())
    return Programm(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        source_url=source_url,
        theaters=out,
    )


def build_from_pdf(
    out_path: Path,
    *,
    programm_path: Path | None = None,
    pdf_url: str = PDF_URL,
    cache_path: Path = DEFAULT_CACHE,
    first_page: int = PROGRAM_FIRST_PAGE,
    last_page: int = PROGRAM_LAST_PAGE,
) -> Programm:
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set (see env.example).")

    with httpx.Client(timeout=60.0, follow_redirects=True) as client:
        pdf_path = download_pdf(client, pdf_url, cache_path)

    pages = extract_pages(pdf_path)
    last_page = min(last_page, len(pages) - 1)

    agent = _build_agent()
    chunks: list[ChunkResult] = []
    for start, end in _windows(first_page, last_page):
        text = "\n\n".join(pages[start : end + 1])
        prompt = (
            f"Seiten {start}-{end} des Programmhefts. Extrahiere alle Theaterhaeuser "
            f"mit ihren Programmpunkten:\n\n{text}"
        )
        result = agent.run_sync(prompt)
        chunks.append(result.output)

    merged = _merge_theaters(chunks)
    coord_index = _load_coord_index(programm_path) if programm_path else {}
    programm = _to_programm(merged, coord_index, pdf_url)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(programm.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return programm
