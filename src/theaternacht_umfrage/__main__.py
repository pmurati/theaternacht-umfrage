"""Command-line entry point for the Theaternacht data pipeline."""

from __future__ import annotations

import argparse
from pathlib import Path

from .build import run

DEFAULT_OUT = Path("docs/data/programm.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theaternacht-umfrage",
        description="Build the interactive Theaternacht map data from the program listing.",
    )
    parser.add_argument(
        "-o",
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output JSON path (default: {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--enrich",
        action="store_true",
        help="Generate short teaser texts via pydantic_ai/OpenAI (requires OPENAI_API_KEY).",
    )
    args = parser.parse_args(argv)

    programm = run(args.out)

    if args.enrich:
        from .enrich import enrich_programm

        enrich_programm(programm, args.out)

    shows = sum(len(t.shows) for t in programm.theaters)
    missing = [t.name for t in programm.theaters if t.lat is None]
    print(f"Wrote {args.out}: {len(programm.theaters)} theaters, {shows} shows.")
    if missing:
        print(
            f"WARNING: {len(missing)} theaters without coordinates: {', '.join(missing)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
