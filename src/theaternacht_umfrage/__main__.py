"""Command-line entry point for the Theaternacht data pipeline."""

from __future__ import annotations

import argparse
from pathlib import Path

from .build import run

DEFAULT_OUT = Path("docs/data/programm.json")
AGENT_OUT = Path("docs/data/programm_agent.json")
MANUAL_OUT = Path("docs/data/programm_manual.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="theaternacht-umfrage",
        description="Build the interactive Theaternacht map data from the program listing.",
    )
    parser.add_argument(
        "-o",
        "--out",
        type=Path,
        default=None,
        help="Output JSON path (default: docs/data/programm.json, "
        "or docs/data/programm_agent.json with --agent-pdf).",
    )
    parser.add_argument(
        "--enrich",
        action="store_true",
        help="Generate short teaser texts via pydantic_ai/OpenAI (requires OPENAI_API_KEY).",
    )
    parser.add_argument(
        "--agent-pdf",
        action="store_true",
        help="Alternative source: extract the program per theater from the official "
        "program booklet (PDF) via a pydantic_ai agent. Writes a separate file for "
        "manual review and does NOT overwrite programm.json.",
    )
    parser.add_argument(
        "--poll",
        action="store_true",
        help="Build docs/data/poll_results.json from 'poll results/poll_results.xlsx' "
        "(sheet 'Antworten') joined against programm_manual.json.",
    )
    parser.add_argument(
        "--transit",
        action="store_true",
        help="Build docs/data/transit_matrix.json: a theatre-to-theatre public "
        "transport travel matrix for the night of 2026-09-05 from the hvv GTFS "
        "feed in hvv_Rohdaten/.",
    )
    args = parser.parse_args(argv)

    if args.poll:
        from .poll import build_poll

        payload = build_poll()
        print(
            f"Wrote docs/data/poll_results.json: {len(payload['entries'])} entries, "
            f"{len(payload['voters'])} voters ({', '.join(payload['voters'])})."
        )
        return 0

    if args.transit:
        from .transit import build_transit

        build_transit()
        return 0

    if args.agent_pdf:
        from .agent_pdf import build_from_pdf

        out = args.out or AGENT_OUT
        programm = build_from_pdf(out, programm_path=DEFAULT_OUT)
        shows = sum(len(t.shows) for t in programm.theaters)
        missing = [t.name for t in programm.theaters if t.lat is None]
        print(f"Wrote {out}: {len(programm.theaters)} theaters, {shows} shows.")
        if missing:
            print(
                f"NOTE: {len(missing)} theaters without coordinates "
                f"(no match in {DEFAULT_OUT}): {', '.join(missing)}"
            )
        return 0

    out = args.out or DEFAULT_OUT
    programm = run(out)

    if args.enrich:
        from .enrich import enrich_programm

        enrich_programm(programm, out)

    shows = sum(len(t.shows) for t in programm.theaters)
    missing = [t.name for t in programm.theaters if t.lat is None]
    print(f"Wrote {out}: {len(programm.theaters)} theaters, {shows} shows.")
    if missing:
        print(
            f"WARNING: {len(missing)} theaters without coordinates: {', '.join(missing)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
