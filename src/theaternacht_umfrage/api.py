"""Client for the IMX Platform GraphQL content API that powers theater-hamburg.org.

The public program widget (``hht.whitelabel.imxplatform.de``) ships a bearer token
inside its JavaScript bundle. We extract that token at runtime so the client keeps
working even if the token is rotated, then query the GraphQL endpoint for event
details (title, description, coordinates, address, showtimes).
"""

from __future__ import annotations

import re
from html import unescape

import httpx

WIDGET_JS_URL = "https://hht.whitelabel.imxplatform.de/widget/widget.js"
GRAPHQL_ENDPOINT = "https://content-delivery.imxplatform.de/hht/imxplatform"

_ENDPOINT_MARKER = f'graphqlEndpoint:"{GRAPHQL_ENDPOINT}"'
_TOKEN_RE = re.compile(r'graphqlBearerToken:"(eyJ[A-Za-z0-9_.-]+)"')

_EVENT_QUERY = """
query Event($permaLink: String!) {
  event(permaLink: $permaLink) {
    id
    title
    subTitle
    shortDescription
    longDescription
    location {
      title
      geoInfo {
        coordinates { latitude longitude }
        street
        streetNo
        zipcode
        city
      }
    }
    geoInfo {
      coordinates { latitude longitude }
      street
      streetNo
      zipcode
      city
    }
    eventDates { date startTime }
  }
}
"""


def _extract_bearer_token(widget_js: str) -> str:
    """Pull the hht GraphQL bearer token from the widget bundle.

    The bundle contains several instances; we take the token belonging to the
    config object that references the hht endpoint (the closest preceding match).
    """
    idx = widget_js.find(_ENDPOINT_MARKER)
    if idx == -1:
        raise RuntimeError("Could not locate hht graphqlEndpoint in widget.js")
    matches = _TOKEN_RE.findall(widget_js[:idx])
    if not matches:
        raise RuntimeError("Could not locate graphqlBearerToken in widget.js")
    return matches[-1]


class ImxClient:
    """Minimal GraphQL client for the theater-hamburg content API."""

    def __init__(self, client: httpx.Client, token: str) -> None:
        self._client = client
        self._token = token

    @classmethod
    def create(cls, client: httpx.Client) -> "ImxClient":
        resp = client.get(WIDGET_JS_URL)
        resp.raise_for_status()
        token = _extract_bearer_token(resp.text)
        return cls(client, token)

    def _post(self, query: str, variables: dict) -> dict:
        resp = self._client.post(
            GRAPHQL_ENDPOINT,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            json={"query": query, "variables": variables},
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("errors"):
            raise RuntimeError(f"GraphQL errors: {payload['errors']}")
        return payload["data"]

    def event_by_permalink(self, perma_link: str) -> dict | None:
        """Return the raw event dict for a permaLink, or None if unknown."""
        data = self._post(_EVENT_QUERY, {"permaLink": perma_link})
        return data.get("event")


_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_END_RE = re.compile(r"</(p|div|li|br|h[1-6])\s*>", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)


def html_to_text(value: str | None) -> str:
    """Convert the API's HTML description fragments to readable plain text."""
    if not value:
        return ""
    text = _BR_RE.sub("\n", value)
    text = _BLOCK_END_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = unescape(text)
    lines = [line.strip() for line in text.splitlines()]
    # Collapse runs of blank lines.
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()
