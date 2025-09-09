#!/usr/bin/env python3
"""
PGN to FEN Converter

A universal CLI and importable module to convert PGN game(s) to the full list of
FEN strings for each position along the mainline. Supports:

- Single PGN string via --pgn
- PGN file(s) via --pgn-file (can contain multiple games)
- CSV files with a column of PGN strings via --csv-file and --column

Output formats:
- text: newline-separated FENs; multiple games separated by a blank line
- json: single game -> [fens]; multi-game -> [{"id": <id>, "fens": [...]}, ...]
- csv: exploded rows with columns [id, ply, fen]

Install requirements:
  pip install -r requirements.txt

Example usage:
  # Single PGN string
  ./pgn_to_fens.py --pgn "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6" --include-initial --format text

  # From PGN file to JSON
  ./pgn_to_fens.py --pgn-file game.pgn --format json > fens.json

  # From CSV column to exploded CSV
  ./pgn_to_fens.py --csv-file games.csv --column pgn --format csv > fens.csv
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from dataclasses import dataclass
from typing import Iterable, Iterator, List, Optional, Sequence, Tuple

try:
    import chess
    import chess.pgn
except Exception as exc:  # pragma: no cover - dependency missing is user environment issue
    print(
        "Error: python-chess is required. Please install dependencies with 'pip install -r requirements.txt'",
        file=sys.stderr,
    )
    raise


# Optional dependency: pandas only needed for CSV IO. We import lazily when used.
def _lazy_import_pandas():
    try:
        import pandas as pd  # type: ignore

        return pd
    except Exception as exc:  # pragma: no cover - dependency missing is user environment issue
        print(
            "Error: pandas is required for CSV mode. Install with 'pip install -r requirements.txt'",
            file=sys.stderr,
        )
        raise


def convert_pgn_text_to_fens(
    pgn_text: str,
    include_initial: bool = False,
    max_positions: Optional[int] = None,
) -> List[str]:
    """Convert one or more PGN games in a string into a flattened list of FENs.

    If multiple games exist in the input `pgn_text`, the FENs for each game will
    be concatenated one after another. Use `split_pgn_text_into_games` to
    enumerate per-game FEN lists instead.

    Args:
        pgn_text: String containing one or more PGN games.
        include_initial: Whether to include the initial position FEN before the first move.
        max_positions: Optional cap on the number of positions (useful for sampling).

    Returns:
        List of FEN strings along the mainline.
    """
    all_fens: List[str] = []
    for fens_for_game in iterate_pgn_games_to_fens(pgn_text, include_initial=include_initial):
        for fen in fens_for_game:
            all_fens.append(fen)
            if max_positions is not None and len(all_fens) >= max_positions:
                return all_fens
    return all_fens


def iterate_pgn_games_to_fens(
    pgn_text: str,
    include_initial: bool = False,
) -> Iterator[List[str]]:
    """Yield FEN lists for each game contained in `pgn_text`.

    Args:
        pgn_text: String containing one or more PGN games.
        include_initial: Whether to include the initial position FEN before the first move.

    Yields:
        For each game, a list of FEN strings along the mainline.
    """
    reader = io.StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(reader)
        if game is None:
            break
        yield _fens_from_game(game, include_initial=include_initial)


def _fens_from_game(game: chess.pgn.Game, include_initial: bool) -> List[str]:
    board = game.board()
    fens: List[str] = []
    if include_initial:
        fens.append(board.board_fen() + " " + board.turn_str() + " " + str(board.castling_xfen()) + " " + board.ep_square_str() + " 0 1")
        # The above manual FEN construction is intentionally verbose to reduce dependency on private methods.
        # However, python-chess provides board.fen(). Use that for reliability and brevity.
        fens[-1] = board.fen()
    for move in game.mainline_moves():
        board.push(move)
        fens.append(board.fen())
    return fens


@dataclass
class OutputRecord:
    identifier: str
    ply_index: int
    fen: str


def _output_text(games_fens: List[Tuple[str, List[str]]], out: io.TextIOBase) -> None:
    first = True
    for game_id, fens in games_fens:
        if not first:
            out.write("\n")
        first = False
        for fen in fens:
            out.write(f"{fen}\n")


def _output_json(games_fens: List[Tuple[str, List[str]]], out: io.TextIOBase) -> None:
    if len(games_fens) == 1:
        # Single game -> simple list
        _, fens = games_fens[0]
        json.dump(fens, out, ensure_ascii=False)
    else:
        # Multiple games -> array of objects
        payload = [{"id": gid, "fens": fens} for gid, fens in games_fens]
        json.dump(payload, out, ensure_ascii=False)


def _output_csv(games_fens: List[Tuple[str, List[str]]], out: io.TextIOBase) -> None:
    out.write("id,ply,fen\n")
    for game_id, fens in games_fens:
        for ply_index, fen in enumerate(fens, start=1):
            # Escape quotes by doubling them; wrap field in quotes
            escaped_id = str(game_id).replace('"', '""')
            escaped_fen = fen.replace('"', '""')
            out.write(f'"{escaped_id}",{ply_index},"{escaped_fen}"\n')


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _write_output(path: Optional[str], data_writer) -> None:
    if path:
        with open(path, "w", encoding="utf-8") as f:
            data_writer(f)
    else:
        data_writer(sys.stdout)


def _handle_from_pgn_string(args: argparse.Namespace) -> None:
    games_fens: List[Tuple[str, List[str]]] = []
    fens = convert_pgn_text_to_fens(args.pgn, include_initial=args.include_initial)
    games_fens.append(("game_0", fens))
    _emit_output(args, games_fens)


def _handle_from_pgn_file(args: argparse.Namespace) -> None:
    content = _read_text(args.pgn_file)
    games_fens: List[Tuple[str, List[str]]] = []
    for index, fens in enumerate(iterate_pgn_games_to_fens(content, include_initial=args.include_initial)):
        games_fens.append((f"game_{index}", fens))
    _emit_output(args, games_fens)


def _handle_from_csv(args: argparse.Namespace) -> None:
    pd = _lazy_import_pandas()
    df = pd.read_csv(
        args.csv_file,
        sep=args.delimiter,
        quotechar=args.quotechar,
        dtype=str,
        keep_default_na=False,
        engine="python",
    )
    if args.column not in df.columns:
        raise SystemExit(
            f"Column '{args.column}' not found in CSV. Available columns: {list(df.columns)}"
        )

    games_fens: List[Tuple[str, List[str]]] = []
    for idx, pgn_text in df[args.column].items():
        identifier = f"row_{idx}"
        per_game_fens: List[List[str]] = list(
            iterate_pgn_games_to_fens(str(pgn_text), include_initial=args.include_initial)
        )
        if len(per_game_fens) == 0:
            games_fens.append((identifier, []))
        elif len(per_game_fens) == 1:
            games_fens.append((identifier, per_game_fens[0]))
        else:
            # Multiple games in a single CSV cell: enumerate with suffix
            for game_index, fens in enumerate(per_game_fens):
                games_fens.append((f"{identifier}_game_{game_index}", fens))

    _emit_output(args, games_fens)


def _emit_output(args: argparse.Namespace, games_fens: List[Tuple[str, List[str]]]) -> None:
    fmt = args.format

    def writer(out):
        if fmt == "text":
            _output_text(games_fens, out)
        elif fmt == "json":
            _output_json(games_fens, out)
        elif fmt == "csv":
            _output_csv(games_fens, out)
        else:
            raise SystemExit(f"Unknown format: {fmt}")

    _write_output(args.output, writer)


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Convert PGN(s) to FEN sequences. Provide one of: --pgn, --pgn-file, or --csv-file with --column."
        )
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument(
        "--pgn",
        type=str,
        help="Literal PGN string containing one game (or multiple games).",
    )
    input_group.add_argument(
        "--pgn-file",
        type=str,
        help="Path to a PGN file (may contain multiple games).",
    )
    input_group.add_argument(
        "--csv-file",
        type=str,
        help="Path to a CSV containing a column of PGN strings.",
    )

    parser.add_argument(
        "--column",
        type=str,
        default="pgn",
        help="When using --csv-file, the name of the column with PGN strings (default: pgn).",
    )
    parser.add_argument(
        "--delimiter",
        type=str,
        default=",",
        help="CSV delimiter (default: ,)",
    )
    parser.add_argument(
        "--quotechar",
        type=str,
        default='"',
        help='CSV quote character (default: ")',
    )

    parser.add_argument(
        "--include-initial",
        action="store_true",
        help="Include the initial position before the first move.",
    )

    parser.add_argument(
        "--format",
        choices=["text", "json", "csv"],
        default="text",
        help="Output format: text, json, or csv (default: text)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output file path. If omitted, prints to stdout.",
    )

    return parser


def _dispatch(args: argparse.Namespace) -> None:
    if args.pgn is not None:
        _handle_from_pgn_string(args)
    elif args.pgn_file is not None:
        _handle_from_pgn_file(args)
    elif args.csv_file is not None:
        _handle_from_csv(args)
    else:  # pragma: no cover - guarded by argparse
        raise SystemExit("No input provided.")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)
    try:
        _dispatch(args)
        return 0
    except KeyboardInterrupt:  # pragma: no cover - user interruption
        return 130
    except SystemExit:
        raise
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

