#!/usr/bin/env python3
"""Independent dinosaur simulator; run with --seeds 5 --size 32.

AST extraction never runs production main(). Default sizes: 2, 4, 6, 8, 32.
Moves and CPython source-line events are NOT game ticks. Random targets are
uniformly chosen from currently unoccupied cells; identical seeds need not
produce identical targets for different strategies. Game API integration
(dinosaur_once, hats, clear, inventory and statistics) is tested separately.
"""

import argparse
import ast
from collections import Counter, deque
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import random
import sys
import time


DIRECTIONS = {"East": (1, 0), "North": (0, 1),
              "West": (-1, 0), "South": (0, -1)}
FUNCTIONS = {
    "old": {"dino_cycle_index", "choose_dino_move", "move_dinosaur_to"},
    "new": {"build_dino_route", "dino_cycle_index", "follow_dino_route"},
}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def load_algorithm(path, text, size, algorithm):
    tree = ast.parse(text, filename=str(path))
    selected = [node for node in tree.body
                if isinstance(node, ast.FunctionDef)
                and node.name in FUNCTIONS[algorithm]]
    check({node.name for node in selected} == FUNCTIONS[algorithm],
          f"{path}: missing required functions")
    ns = {direction: direction for direction in DIRECTIONS}
    ns["WORLD_SIZE"] = size
    # Preserve the baseline's actual constant, including on small boards.
    if algorithm == "old":
        constants = [node for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == "DINO_SHORTCUT_LIMIT"
                             for t in node.targets)]
        check(len(constants) == 1, "missing baseline shortcut limit")
        ns["DINO_SHORTCUT_LIMIT"] = ast.literal_eval(constants[0].value)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), ns)
    return ns


@contextmanager
def trace_lines(ns, enabled):
    """Count only extracted algorithm code; exclude simulator and harness."""
    counts = Counter()
    codes = {value.__code__ for value in ns.values() if callable(value)
             and hasattr(value, "__code__") and value.__globals__ is ns}

    def trace(frame, event, arg):
        if frame.f_code not in codes:
            return None
        if event == "line":
            counts[frame.f_code.co_name] += 1
        return trace

    previous = sys.gettrace()
    if enabled:
        sys.settrace(trace)
    try:
        yield counts
    finally:
        if enabled:
            sys.settrace(previous)


def validate_route(ns, route):
    size = ns["WORLD_SIZE"]
    area = size * size
    check(len(route) == area, "route length differs from board area")
    indices = [ns["dino_cycle_index"](x, y)
               for y in range(size) for x in range(size)]
    check(sorted(indices) == list(range(area)), "indices are not a permutation")
    x = y = 0
    seen = set()
    for index, direction in enumerate(route):
        check((x, y) not in seen, "route repeats a cell")
        seen.add((x, y))
        check(ns["dino_cycle_index"](x, y) == index, "route/index mismatch")
        check(direction in DIRECTIONS, "invalid route direction")
        dx, dy = DIRECTIONS[direction]
        check(abs(dx) + abs(dy) == 1, "nonadjacent route edge")
        x, y = x + dx, y + dy
        check(0 <= x < size and 0 <= y < size, "route leaves board")
    check((x, y) == (0, 0) and len(seen) == area,
          "route does not form a full Hamilton cycle")
    return {"valid": True, "unique_cells": len(seen), "closed": True}


class Game:
    """Deque/set reference state is private to the simulator, never the new AI."""

    def __init__(self, ns, algorithm, route, seed):
        self.ns, self.algorithm, self.route = ns, algorithm, route
        self.size = ns["WORLD_SIZE"]
        self.area = self.size ** 2
        self.rng = random.Random(seed)
        self.tail = deque()
        self.occupied = set()
        self.head = 0
        self.target = None
        self.steps = self.leg_steps = self.apples = 0
        self.old_body, self.old_occupied = [], {}
        ns.update(move=self.move, get_pos_x=lambda: self.head % self.size,
                  get_pos_y=lambda: self.head // self.size)

    def validate_old(self):
        if self.algorithm == "old":
            check(self.old_body == list(self.tail), "baseline body/deque mismatch")
            check(self.old_occupied.keys() == self.occupied,
                  "baseline occupancy/reference mismatch")

    def move(self, direction):
        self.validate_old()
        check(direction in DIRECTIONS, f"invalid direction: {direction!r}")
        check(self.target is not None and self.head != self.target,
              "movement after target reached")
        check(self.leg_steps < self.area, "target not reached within one cycle")
        grow = self.leg_steps == 0  # Growth occurs when LEAVING the apple.
        dx, dy = DIRECTIONS[direction]
        x, y = self.head % self.size + dx, self.head // self.size + dy
        check(0 <= x < self.size and 0 <= y < self.size, "out-of-bounds move")
        node = x + y * self.size
        check(node not in self.occupied or
              (not grow and self.tail and node == self.tail[0]),
              f"collision at move {self.steps + 1}: cell={node}, grow={grow}")
        if not grow:
            self.occupied.remove(self.tail.popleft())
        self.tail.append(self.head)
        self.occupied.add(self.head)
        self.head = node
        self.steps += 1
        self.leg_steps += 1
        check(self.head not in self.occupied, "head overlaps tail")
        check(len(self.tail) == len(self.occupied), "duplicate tail cells")
        return True

    def travel(self, target):
        check(target != self.head and target not in self.occupied,
              "apple target is occupied")
        self.target, self.leg_steps = target, 0
        before = len(self.tail)
        if self.algorithm == "new":
            index = self.ns["dino_cycle_index"]
            head_index = index(self.head % self.size, self.head // self.size)
            target_index = index(target % self.size, target // self.size)
            result = self.ns["follow_dino_route"](self.route, head_index, target_index)
        else:
            result = self.ns["move_dinosaur_to"](
                target % self.size, target // self.size,
                self.old_body, self.old_occupied)
        self.validate_old()
        check(result is True, f"movement returned failure: head={self.head}, target={target}")
        check(self.head == target and self.leg_steps > 0, "target not reached")
        check(len(self.tail) == before + 1, "must grow once per apple leg")
        self.apples += 1

    def run(self, prefix=()):
        for x, y in prefix:
            self.travel(x + y * self.size)
        while self.apples < self.area - 1:
            free = [node for node in range(self.area)
                    if node != self.head and node not in self.occupied]
            check(free, "no free target before completion")
            self.travel(self.rng.choice(free))
        check(self.occupied | {self.head} == set(range(self.area)),
              "final snake does not cover every cell")
        check(len(self.tail) == self.area - 1, "wrong final tail length")


def run_game(ns, algorithm, route, seed, prefix=(), traced=False):
    game = Game(ns, algorithm, route, seed)
    started = time.perf_counter()
    error = None
    with trace_lines(ns, traced) as counts:
        try:
            game.run(prefix)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
    return {
        "algorithm": algorithm, "size": game.size, "seed": seed,
        "case": "two_apple_counterexample" if prefix else "random",
        "forced_apple_prefix": list(prefix),
        "success": error is None, "error": error,
        "steps": game.steps, "completed_apples": game.apples,
        "required_apples": game.area - 1, "occupied_cells": len(game.tail) + 1,
        "seconds_including_validation": round(time.perf_counter() - started, 6),
        "source_line_events": dict(counts) if traced else None,
        "total_source_line_events": sum(counts.values()) if traced else None,
    }


def even_size(value):
    number = int(value)
    if number < 2 or number % 2:
        raise argparse.ArgumentTypeError("size must be even and >= 2")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, default=5)
    parser.add_argument("--size", type=even_size, default=32)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--trace-lines", action="store_true",
                        help="trace seed 0 only, plus one-time route construction")
    args = parser.parse_args()
    if args.seeds < 1:
        parser.error("--seeds must be >= 1")
    root = Path(__file__).resolve().parent
    paths = {"old": root / "dinosaur_32_baseline.py",
             "new": root / "dinosaur_32_full_cycle_experiment.py"}
    texts = {name: path.read_text() for name, path in paths.items()}
    report = {
        "notes": [
            "Steps count successful moves, not game ticks.",
            "Source-line events proxy CPython interpreter work, NOT game ticks or timing.",
            "Tracing excludes simulator/validation; route construction is reported separately.",
            "Same seeds may yield different apples because free cells depend on strategy.",
            "Baseline failures are limitations and do not fail the new algorithm.",
            "dinosaur_once game API integration is outside this benchmark's scope.",
        ],
        "seeds": args.seeds, "sizes": sorted({2, 4, 6, 8, args.size}),
        "sources": {name: {"path": str(paths[name]),
                            "sha256": hashlib.sha256(text.encode()).hexdigest()}
                    for name, text in texts.items()},
        "routes": [], "games": [], "new_failures": [],
    }
    for size in report["sizes"]:
        for algorithm in ("old", "new"):
            try:
                ns = load_algorithm(paths[algorithm], texts[algorithm], size, algorithm)
                route = None
                if algorithm == "new":
                    with trace_lines(ns, args.trace_lines) as counts:
                        route = ns["build_dino_route"]()
                    result = validate_route(ns, route)
                    report["routes"].append(dict(
                        result, size=size,
                        build_source_line_events=dict(counts) if args.trace_lines else None))
            except Exception as exc:
                error = f"{algorithm} size={size}: {type(exc).__name__}: {exc}"
                if algorithm == "new":
                    report["new_failures"].append(error)
                else:
                    report.setdefault("baseline_setup_failures", []).append(error)
                continue
            for seed in range(args.seeds):
                result = run_game(ns, algorithm, route, seed,
                                  traced=args.trace_lines and seed == 0)
                report["games"].append(result)
            # At >=4 the original greedily moves north, then cannot reach (1,0).
            # The new version must finish both forced targets and the entire game.
            if size >= 4:
                report["games"].append(run_game(
                    ns, algorithm, route, 0, prefix=((0, 1), (1, 0))))
    for result in report["games"]:
        if result["algorithm"] == "new" and not result["success"]:
            report["new_failures"].append(result)
    counterexamples = [g for g in report["games"]
                       if g["algorithm"] == "old"
                       and g["case"] == "two_apple_counterexample"]
    report["baseline_counterexample_reproduced"] = bool(counterexamples) and all(
        not g["success"] and g["completed_apples"] == 1 for g in counterexamples)
    report["summary"] = {
        algorithm: {
            "games": len(games := [g for g in report["games"] if g["algorithm"] == algorithm]),
            "completed_games": sum(g["success"] for g in games),
            "steps_including_partial_games": sum(g["steps"] for g in games),
        } for algorithm in ("old", "new")
    }
    report["success"] = not report["new_failures"]
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    sys.stdout.write(rendered)
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
