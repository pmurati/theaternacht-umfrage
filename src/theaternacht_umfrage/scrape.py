"""Parse the server-rendered Theaternacht program listing page.

Each table row yields the theater name, one showtime, the program title, and the
event's permaLink (used to fetch details from the content API).
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from bs4 import BeautifulSoup

LISTING_URL = "https://theater-hamburg.org/theaternacht/programm/"


@dataclass(frozen=True)
class ListingRow:
    theater: str
    permalink: str
    title: str
    time: str


def fetch_listing_html(client: httpx.Client) -> str:
    resp = client.get(LISTING_URL)
    resp.raise_for_status()
    return resp.text


def _clean_time(raw: str) -> str:
    # "18:00 Uhr" -> "18:00"
    return raw.replace("Uhr", "").strip()


def _permalink_from_href(href: str) -> str | None:
    marker = "events/detail/"
    idx = href.find(marker)
    if idx == -1:
        return None
    tail = href[idx + len(marker) :]
    # Strip any query/fragment/time suffix.
    for sep in ("?", "|", "#"):
        tail = tail.split(sep, 1)[0]
    return tail.strip("/") or None


def parse_listing(html: str) -> list[ListingRow]:
    soup = BeautifulSoup(html, "html.parser")
    rows: list[ListingRow] = []
    for tr in soup.select("tr[data-fav-id]"):
        theater_el = tr.select_one("a.address")
        title_el = tr.select_one("a.title")
        if not theater_el or not title_el:
            continue
        href = title_el.get("href", "")
        permalink = _permalink_from_href(href)
        if not permalink:
            continue
        time_el = tr.select_one("span.time")
        rows.append(
            ListingRow(
                theater=theater_el.get_text(strip=True),
                permalink=permalink,
                title=title_el.get_text(strip=True),
                time=_clean_time(time_el.get_text()) if time_el else "",
            )
        )
    return rows
