"""Optional enrichment: generate short, upbeat teaser texts via pydantic_ai/OpenAI.

This step is optional. The core map data (build.py) already contains full
descriptions from the content API. Running ``--enrich`` adds a one-sentence
"worauf habt ihr Lust?"-style hook per show to make the survey more inviting.
Requires OPENAI_API_KEY (see env.example).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel
from pydantic_ai import Agent

from .models import Programm

SYSTEM_PROMPT = (
    "Du bist Kurator:in fuer die Lange Nacht der Theater in Hamburg. "
    "Formuliere zu jedem Programmpunkt einen einzigen, kurzen, einladenden Teaser "
    "(max. 15 Woerter, Deutsch), der Lust auf den Besuch macht. Keine Uhrzeiten, "
    "keine Anfuehrungszeichen, kein Punkt am Ende."
)


class Teaser(BaseModel):
    teaser: str


def _build_agent() -> Agent[None, Teaser]:
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    return Agent(f"openai:{model}", output_type=Teaser, system_prompt=SYSTEM_PROMPT)


def enrich_programm(programm: Programm, out_path: Path) -> Programm:
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set (see env.example).")

    agent = _build_agent()
    for theater in programm.theaters:
        for show in theater.shows:
            source = show.description or show.title
            prompt = (
                f"Theater: {theater.name}\nTitel: {show.title}\nBeschreibung: {source}"
            )
            result = agent.run_sync(prompt)
            show.teaser = result.output.teaser.strip()

    out_path.write_text(
        json.dumps(programm.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return programm
