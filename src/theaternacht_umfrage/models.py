"""Pydantic data models for the Theaternacht survey map."""

from __future__ import annotations

from pydantic import BaseModel, Field


class Show(BaseModel):
    """A single program point (one checkbox on the map).

    The same show is often listed at several times on the program page; those
    times are collected into ``times``. There is exactly one checkbox per show.
    """

    id: str = Field(description="permaLink slug, unique within a theater.")
    title: str
    venue: str = Field(default="", description="Specific stage, e.g. 'Malersaal'.")
    times: list[str] = Field(
        default_factory=list, description="e.g. ['19:00', '20:30']"
    )
    description: str = ""
    teaser: str = Field(default="", description="Optional short LLM-generated hook.")


class Theater(BaseModel):
    """A venue (map marker) with its location and program."""

    id: str = Field(description="Stable slug, unique across all theaters.")
    name: str
    address: str = ""
    lat: float | None = None
    lng: float | None = None
    shows: list[Show] = Field(default_factory=list)


class Programm(BaseModel):
    """Top-level payload written to docs/data/programm.json."""

    generated_at: str
    source_url: str
    theaters: list[Theater] = Field(default_factory=list)
