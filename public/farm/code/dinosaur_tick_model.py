#!/usr/bin/env python3
"""Estimate game ticks by instrumenting executed AST operations, not Python time.

Does not modify either game algorithm. Model weights are explicit assumptions;
move-cost alternatives and interpreter-cost sensitivity are reported separately.
The independent simulator still checks every move for collisions and boundaries.
"""
import argparse
import ast
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import time

import dinosaur_benchmark as simulator


FUNCTIONS = dict(simulator.FUNCTIONS)
FUNCTIONS['light'] = {'dino_cycle_index', 'follow_dino_route',
                      'build_shortcut_tables', 'new_shortcut_state', 'move_shortcut_to'}

SOURCE_CORE = 'https://github.com/MengLeiFudge/TFWR_Simulator/blob/55514a27d14a3819e28577bb4e1b027beb4d7887/references/DecompiledSource/Core/Core.decompiled.cs'
# Source-snapshot costs for the scalar/list operations used by these scripts.
# Dict operations use scalar integer keys; key-size cost is modeled as 1.
LANGUAGE_WEIGHTS = {
    'assignment': 0, 'augmented_assignment': 1, 'return': 0,
    'if_test': 1, 'while_setup': 1, 'while_test': 0,
    'for_setup': 1, 'for_iteration': 0, 'arithmetic': 1,
    'unary': 0, 'comparison': 1, 'membership': 1,
    'boolean_op': 1, 'index_read': 1, 'index_write': 1,
    'container_creation': 1, 'method_call': 1, 'function_call': 0,
    'builtin_len_range': 1, 'pass': 1,
}


class Meter:
    def __init__(self):
        self.operations = Counter()
        self.api = Counter()
        self.moves_by_apples = Counter()
        self.shifted_slots = 0

    def value(self, kind, value):
        if kind == 'container_creation':
            self.operations[kind] += 1 + len(value) if isinstance(value, dict) else max(1, len(value))
        else:
            self.operations[kind] += 1
        return value

    def event(self, kind):
        self.operations[kind] += 1

    def method(self, receiver, name, *args):
        self.operations['method_call'] += 1
        assert name in ('pop', 'append'), 'Add a documented cost for this method'
        if name == 'pop' and isinstance(receiver, list):
            index = args[0] if args else -1
            if index < 0:
                index += len(receiver)
            self.shifted_slots += max(0, len(receiver) - index - 1)
        return getattr(receiver, name)(*args)

    def call(self, function, *args):
        self.operations['function_call'] += 1
        if function is len or function is range:
            self.operations['builtin_len_range'] += 1
        return function(*args)

    def export(self):
        return {'operations': dict(self.operations), 'api_calls': dict(self.api),
                'moves_by_apples': dict(sorted(self.moves_by_apples.items())),
                'list_pop_front_shifted_slots': self.shifted_slots}


class Instrument(ast.NodeTransformer):
    """Preserve evaluation order and short-circuiting while counting operations."""
    @staticmethod
    def event(kind):
        return ast.Expr(ast.Call(ast.Name('_tick_event', ast.Load()),
                                 [ast.Constant(kind)], []))

    @staticmethod
    def value(kind, value):
        return ast.Call(ast.Name('_tick_value', ast.Load()),
                        [ast.Constant(kind), value], [])

    def visit_Assign(self, node):
        self.generic_visit(node)
        writes = sum(isinstance(target, ast.Subscript) for target in node.targets)
        return [self.event('assignment')] + [self.event('index_write') for _ in range(writes)] + [node]

    def visit_AugAssign(self, node):
        self.generic_visit(node)
        return [self.event('augmented_assignment'), node]

    def visit_Return(self, node):
        self.generic_visit(node)
        return [self.event('return'), node]

    def visit_Pass(self, node):
        return [self.event('pass'), node]

    def visit_If(self, node):
        self.generic_visit(node)
        node.test = self.value('if_test', node.test)
        return node

    def visit_While(self, node):
        self.generic_visit(node)
        node.test = self.value('while_test', node.test)
        return [self.event('while_setup'), node]

    def visit_For(self, node):
        self.generic_visit(node)
        node.body.insert(0, self.event('for_iteration'))
        return [self.event('for_setup'), node]

    def visit_BinOp(self, node):
        self.generic_visit(node)
        return self.value('arithmetic', node)

    def visit_UnaryOp(self, node):
        self.generic_visit(node)
        return self.value('unary', node)

    def visit_Compare(self, node):
        self.generic_visit(node)
        # These source functions use only single comparisons.
        assert len(node.ops) == 1, 'Extend model before using chained comparisons'
        kind = 'membership' if isinstance(node.ops[0], (ast.In, ast.NotIn)) else 'comparison'
        return self.value(kind, node)

    def visit_BoolOp(self, node):
        self.generic_visit(node)
        # Model left-associated binary and/or, including the tick charged
        # when the left operand short-circuits. Preserve operand evaluation.
        result = node.values[0]
        for value in node.values[1:]:
            result = self.value('boolean_op', ast.BoolOp(node.op, [result, value]))
        return result

    def visit_Subscript(self, node):
        self.generic_visit(node)
        if isinstance(node.ctx, ast.Load):
            return self.value('index_read', node)
        return node

    def visit_List(self, node):
        self.generic_visit(node)
        return self.value('container_creation', node)

    def visit_Dict(self, node):
        self.generic_visit(node)
        return self.value('container_creation', node)

    def visit_Call(self, node):
        self.generic_visit(node)
        assert not node.keywords
        if isinstance(node.func, ast.Attribute):
            return ast.Call(ast.Name('_tick_method', ast.Load()),
                            [node.func.value, ast.Constant(node.func.attr)] + node.args, [])
        return ast.Call(ast.Name('_tick_call', ast.Load()), [node.func] + node.args, [])


def load_instrumented(path, size, algorithm, meter):
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                and node.name in FUNCTIONS[algorithm]]
    original = {name: name for name in simulator.DIRECTIONS}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in ('WORLD_SIZE', 'DINO_SHORTCUT_LIMIT'):
                    original[target.id] = ast.literal_eval(node.value)
    original['WORLD_SIZE'] = size
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), 'exec'), original)
    original['_reference_rank'] = original['dino_cycle_index']
    transformed = Instrument().visit(ast.Module(body=selected, type_ignores=[]))
    original.update(_tick_event=meter.event, _tick_value=meter.value,
                    _tick_method=meter.method, _tick_call=meter.call)
    exec(compile(ast.fix_missing_locations(transformed), str(path), 'exec'), original)
    return original


class TickGame(simulator.Game):
    def __init__(self, ns, algorithm, route, seed, meter):
        super().__init__(ns, algorithm, route, seed)
        self.meter = meter
        self.light_state = ns['new_shortcut_state']() if algorithm == 'light' else None
        ns['get_pos_x'] = lambda: self.position('x')
        ns['get_pos_y'] = lambda: self.position('y')

    def position(self, axis):
        self.meter.api['get_pos_' + axis] += 1
        return self.head % self.size if axis == 'x' else self.head // self.size

    def validate_old(self):
        # Per-step collision checks remain in the independent Game.move.
        # Compare the algorithm queue to the oracle at every reached apple.
        pass

    def move(self, direction):
        result = super().move(direction)
        self.meter.moves_by_apples[self.apples] += 1
        return result

    def travel(self, target):
        if self.algorithm == 'light':
            simulator.check(target != self.head and target not in self.occupied, 'occupied target')
            self.target, self.leg_steps = target, 0
            before = len(self.tail)
            result = self.ns['move_shortcut_to'](target % self.size, target // self.size,
                                                  self.light_state, self.route)
            simulator.check(result is True, 'lightweight shortcut returned failure')
            simulator.check(self.head == target and self.leg_steps > 0, 'target not reached')
            simulator.check(len(self.tail) == before + 1, 'must grow once per apple')
            simulator.check(self.light_state[3] == len(self.tail), 'tracked length mismatch')
            simulator.check(self.light_state[4] == self.ns['_reference_rank'](self.head % self.size, self.head // self.size), 'tracked head mismatch')
            # Keep validation outside the cost model: no calls to instrumented
            # game functions here except the algorithm entry point above.
            self.apples += 1
        else:
            super().travel(target)
            simulator.Game.validate_old(self)


def movement_ticks(histogram, constant=None):
    # OnMove reduces integer ops before charging the move that leaves an
    # apple, provided the next apple can be spawned. Full funded runs satisfy
    # this for all modeled legs. 400 -> 388 on the first move, then floor 33.
    costs = []
    ticks = 400
    for apples in range(max((int(n) for n in histogram), default=0) + 1):
        ticks -= math.floor(ticks * .03)
        costs.append(ticks)
    return sum(count * (constant if constant is not None else costs[int(apples)])
               for apples, count in histogram.items())


def score(counts, movement, weight=1, shift_weight=1):
    language_ticks = sum(count * LANGUAGE_WEIGHTS[kind]
                         for kind, count in counts['operations'].items()) * weight
    api_ticks = sum(counts['api_calls'].values())
    shift_ticks = counts['list_pop_front_shifted_slots'] * shift_weight
    return {'estimated_ticks': language_ticks + api_ticks + movement + shift_ticks,
            'language_ticks': language_ticks, 'api_query_ticks': api_ticks,
            'movement_ticks': movement, 'list_pop_shift_ticks': shift_ticks}


def run(path, size, algorithm, seed):
    meter = Meter()
    ns = load_instrumented(path, size, algorithm, meter)
    route = None
    setup = None
    if algorithm in ('new', 'light'):
        builder = 'build_dino_route' if algorithm == 'new' else 'build_shortcut_tables'
        route = ns[builder]()
        setup = meter.export()
        meter.operations.clear()
        if algorithm == 'new':
            simulator.validate_route(simulator.load_algorithm(path, path.read_text(), size, algorithm), route)
    game = TickGame(ns, algorithm, route, seed, meter)
    started = time.perf_counter()
    error = None
    try:
        game.run()
    except Exception as exc:
        error = f'{type(exc).__name__}: {exc}'
    # One initial measure and one after each reached apple. On failure, the
    # last measured target is still pending; it must also be charged.
    # Shared per-round game setup, cleanup and top-level loop work are excluded.
    meter.api['measure'] = game.apples + 1
    counts = meter.export()
    move_ticks = movement_ticks(counts['moves_by_apples'])
    scores = {
        'source_costs': score(counts, move_ticks),
        'language_half_sensitivity': score(counts, move_ticks, .5),
        'language_double_sensitivity': score(counts, move_ticks, 2),
        'constant_200_stress': score(counts, movement_ticks(counts['moves_by_apples'], 200)),
        'constant_time_pop_stress': score(counts, move_ticks, shift_weight=0),
    }
    return {'algorithm': algorithm, 'seed': seed, 'size': size,
            'success': error is None, 'error': error, 'moves': game.steps,
            'apples': game.apples, 'counts': counts, 'route_setup_counts': setup,
            'estimates': scores, 'host_seconds_not_game_time': time.perf_counter() - started}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seeds', type=int, default=5)
    parser.add_argument('--size', type=simulator.even_size, default=32)
    parser.add_argument('--include-light', action='store_true', help='also simulate the production lightweight shortcut algorithm')
    parser.add_argument('--output', type=Path, default=Path('dinosaur_tick_model_results.json'))
    args = parser.parse_args()
    if args.seeds < 1:
        parser.error('--seeds must be positive')
    root = Path(__file__).resolve().parent
    sources = {'old': root / 'dinosaur_32_baseline.py',
               'new': root / 'dinosaur_32_full_cycle_experiment.py'}
    if args.include_light:
        sources['light'] = root / 'dinosaur_32.py'
    report = {'model_version': 3, 'status': 'source-informed estimated ticks, not native game measurements',
              'reference_source': SOURCE_CORE, 'language_weights': LANGUAGE_WEIGHTS,
              'assumptions': [
                  'Executed AST operations counted dynamically, preserving operand short circuiting.',
                  'No simulator/oracle validation or CPython wall time is charged.',
                  'Source snapshot: assignments/direct calls/unary/returns/iterations cost 0; loops cost 1 per entry.',
                  'Scalar arithmetic/comparison/index/if/binary boolean/len/range cost 1.',
                  'List literals cost max(1,length); dict literals 1+length; append costs 1.',
                  'Integer dict keys assumed size 1 for membership/index/write/pop.',
                  'Position queries and measure cost 1; movement modeled separately.',
                  'Dinosaur ticks recurrence T=T-floor(T*0.03), initial 400, first leg 388, eventual floor 33.',
                  'Funded rounds: decay applied on the first move departing each apple.',
                  'List pop(i) costs length_before-i: base 1 plus shifted slots.',
                  'Extra profiles vary language costs, movement and pop costs to test sensitivity; they are not game rules.',
                  'Round setup, cleanup and common outer-loop work excluded; route setup counted separately.',
                  'Seeds do not produce identical apple locations across strategies; uniform-free-cell RNG is a model.',
                  'Public third-party source snapshot has not been checked against the installed game build.',
              ],
              'sources': {name: {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                          for name, path in sources.items()}, 'runs': []}
    for seed in range(args.seeds):
        for name, path in sources.items():
            result = run(path, args.size, name, seed)
            report['runs'].append(result)
            print(name, 'seed', seed, 'complete', result['success'], 'moves', result['moves'],
                  'AST operations', sum(result['counts']['operations'].values()), flush=True)
    summaries = {}
    keys = report['runs'][0]['estimates']
    for key in keys:
        values = {}
        for name in sources:
            runs = [r for r in report['runs'] if r['algorithm'] == name and r['success']]
            values[name] = {'completed': len(runs), 'attempted': args.seeds,
                            'mean_estimated_ticks': sum(r['estimates'][key]['estimated_ticks'] for r in runs) / len(runs) if runs else None}
        if all(values[n]['completed'] == args.seeds for n in sources):
            values['new_over_old'] = values['new']['mean_estimated_ticks'] / values['old']['mean_estimated_ticks']
            if 'light' in sources:
                values['light_over_old'] = values['light']['mean_estimated_ticks'] / values['old']['mean_estimated_ticks']
                values['light_over_full_cycle'] = values['light']['mean_estimated_ticks'] / values['new']['mean_estimated_ticks']
        summaries[key] = values
    report['summary'] = summaries
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(summaries, indent=2))
    print('Saved', args.output)
    return 0 if all(r['success'] for r in report['runs'] if r['algorithm'] != 'old') else 1


if __name__ == '__main__':
    raise SystemExit(main())
