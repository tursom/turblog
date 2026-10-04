"""Independent shortcut regressions; equivalence is not a full-board guarantee."""
import ast
from collections import deque
from pathlib import Path
import unittest

import dinosaur_tick_model as model

ROOT = Path(__file__).resolve().parent


def load(algorithm, size, instrumented=False):
    path = ROOT / ('dinosaur_32_baseline.py' if algorithm == 'old' else
                   'dinosaur_32.py')
    meter = model.Meter()
    if instrumented:
        return model.load_instrumented(path, size, algorithm, meter), meter
    tree = ast.parse(path.read_text(), filename=str(path))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef)
             and n.name in model.FUNCTIONS[algorithm]]
    ns = {d: d for d in model.simulator.DIRECTIONS}
    for n in tree.body:
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name) and t.id == 'DINO_SHORTCUT_LIMIT':
                    ns[t.id] = ast.literal_eval(n.value)
    ns['WORLD_SIZE'] = size
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    ns['_reference_rank'] = ns['dino_cycle_index']
    return ns, meter


class ObservedGame(model.TickGame):
    def __init__(self, algorithm='light', size=32, instrumented=False):
        ns, meter = load(algorithm, size, instrumented)
        tables = ns['build_shortcut_tables']() if algorithm == 'light' else None
        super().__init__(ns, algorithm, tables, 0, meter)
        self.trace, self.handoffs = [], []
        self.failed_moves = 0
        if algorithm == 'light':
            follow = ns['follow_dino_route']

            def observed(route, head, target):
                self.handoffs.append((len(self.tail), self.leg_steps, head, target))
                return follow(route, head, target)
            ns['follow_dino_route'] = observed

    def rank(self, node):
        return self.ns['_reference_rank'](node % self.size, node // self.size)

    def move(self, direction):
        dx, dy = model.simulator.DIRECTIONS[direction]
        x, y = self.head % self.size + dx, self.head // self.size + dy
        node = x + y * self.size
        # Game API rejects illegal movement with False, without mutating state.
        if not (0 <= x < self.size and 0 <= y < self.size) or (
                node in self.occupied and not
                (self.leg_steps > 0 and self.tail and node == self.tail[0])):
            self.failed_moves += 1
            self.trace.append((direction, self.head, self.head, False))
            return False
        before = self.head
        result = super().move(direction)
        self.trace.append((direction, before, self.head, result))
        return result

    def attempt(self, target):
        self.target, self.leg_steps = target, 0
        if self.algorithm == 'light':
            return self.ns['move_shortcut_to'](
                target % self.size, target // self.size, self.light_state, self.route)
        return self.ns['move_dinosaur_to'](
            target % self.size, target // self.size, self.old_body, self.old_occupied)


class ShortcutTests(unittest.TestCase):
    def test_production_matches_tested_experiment(self):
        production = ast.parse((ROOT / 'dinosaur_32.py').read_text())
        experiment = ast.parse((ROOT / 'dinosaur_32_shortcut_experiment.py').read_text())
        self.assertEqual(ast.dump(production), ast.dump(experiment))

    def test_production_round_and_early_exit_cleanup(self):
        from dinosaur_tick_benchmark_test import Game
        tree = ast.parse((ROOT / 'dinosaur_32.py').read_text())
        tree.body = [node for node in tree.body if isinstance(node, (ast.Assign, ast.FunctionDef))]
        code = compile(tree, 'dinosaur_32.py', 'exec')
        for blocked in (False, True):
            with self.subTest(blocked=blocked):
                game = Game(32, seed=0)
                exec(code, game.ns)
                game.material = 1024
                if blocked:
                    game.fail_after = 3
                game.ns['main']()
                self.assertEqual(game.events.count('clear'), 2)
                self.assertEqual(game.events.count('Dinosaur_Hat'), 1)
                self.assertEqual(game.events.count('Straw_Hat'), 1)
                self.assertEqual(game.hat, 'Straw_Hat')
                self.assertEqual(game.bones, (3 if blocked else 1023) ** 2)
                self.assertEqual(game.head, 0)
                self.assertFalse(game.tail)
                self.assertIn('Stopped:', game.logs[-1][0])

    def test_production_preflight_does_not_clear(self):
        from dinosaur_tick_benchmark_test import Game
        tree = ast.parse((ROOT / 'dinosaur_32.py').read_text())
        tree.body = [node for node in tree.body if isinstance(node, (ast.Assign, ast.FunctionDef))]
        code = compile(tree, 'dinosaur_32.py', 'exec')
        for reason in ('size', 'unlock', 'cost', 'materials'):
            with self.subTest(reason=reason):
                game = Game(32)
                exec(code, game.ns)
                if reason == 'size':
                    game.ns['get_world_size'] = lambda: 16
                elif reason == 'unlock':
                    game.ns['num_unlocked'] = lambda _: 0
                elif reason == 'cost':
                    game.cost = None
                else:
                    game.material = 1023
                game.ns['main']()
                self.assertNotIn('clear', game.events)
                self.assertNotIn('Dinosaur_Hat', game.events)

    def test_tables_and_route(self):
        for size in (2, 4, 6, 8, 32):
            with self.subTest(size=size):
                ns, _ = load('light', size)
                route, neighbors = ns['build_shortcut_tables']()
                model.simulator.validate_route(ns, route)
                self.assertEqual(len(neighbors), size * size)
                rank = ns['dino_cycle_index']
                for y in range(size):
                    for x in range(size):
                        head = rank(x, y)
                        expected = []
                        for d, (dx, dy) in model.simulator.DIRECTIONS.items():
                            nx, ny = x + dx, y + dy
                            if 0 <= nx < size and 0 <= ny < size:
                                dest = rank(nx, ny)
                                expected.append([d, dest, (dest - head) % (size * size)])
                        self.assertEqual(neighbors[head],
                                         sorted(expected, key=lambda e: -e[2]))

    def test_seed0_complete_step_trajectory(self):
        baseline, light = ObservedGame('old'), ObservedGame()
        baseline.run()
        light.run()
        self.assertEqual(light.apples, 1023)
        self.assertEqual(light.trace, baseline.trace)  # Direction AND both positions.
        self.assertEqual(light.tail, baseline.tail)
        self.assertTrue(light.handoffs)

    def test_early_ring_wrap_matches_independent_deque(self):
        game = ObservedGame(size=8)
        previous = (0, 0)
        wrapped = [False, False]
        for _ in range(25):
            free = [n for n in range(game.area)
                    if n != game.head and n not in game.occupied]
            if not game.attempt(game.rng.choice(free)):
                break
            ring, read, write, length, head = game.light_state
            self.assertLess(length, game.ns['DINO_SHORTCUT_LIMIT'])
            actual = deque(ring[(read + i) % game.area] for i in range(length))
            self.assertEqual(actual, deque(map(game.rank, game.tail)))
            self.assertEqual(head, game.rank(game.head))
            self.assertEqual(read, (game.steps - length) % game.area)
            self.assertEqual(write, game.steps % game.area)
            for i, cursor in enumerate((read, write)):
                wrapped[i] |= cursor < previous[i]
            previous = read, write
        self.assertEqual(wrapped, [True, True])

    def test_511_to_512_handoff_grows_only_once(self):
        game = ObservedGame()
        cells = sorted(range(game.area), key=game.rank)
        game.tail = deque(cells[:511])
        game.occupied = set(game.tail)
        game.head = cells[511]
        game.light_state = [list(range(511)) + [0] * 513, 0, 511, 511, 511]
        self.assertIs(game.attempt(cells[513]), True)
        self.assertEqual(game.handoffs, [(512, 1, 512, 513)])
        self.assertEqual(game.light_state[3:], [512, 513])
        self.assertEqual(game.tail, deque(cells[1:513]))
        self.assertIs(game.attempt(cells[515]), True)
        self.assertEqual(game.handoffs[-1], (512, 0, 513, 515))
        self.assertEqual(game.light_state[3:], [513, 515])
        self.assertEqual(len(game.tail), 513)
        for direction, before, after, ok in game.trace:
            self.assertTrue(ok)
            self.assertEqual(game.rank(after), (game.rank(before) + 1) % game.area)
            self.assertEqual(direction, game.route[0][game.rank(before)])

    def test_two_apple_dead_end_is_not_fixed(self):
        for algorithm in ('old', 'light'):
            game = ObservedGame(algorithm)
            self.assertIs(game.attempt(32), True)  # (0, 1)
            self.assertIs(game.attempt(1), False)  # (1, 0)
            self.assertEqual(game.head, 32)
            self.assertEqual(len(game.tail), 1)
        game = ObservedGame(size=4)
        game.ns['DINO_SHORTCUT_LIMIT'] = 1
        self.assertIs(game.attempt(4), True)
        self.assertIs(game.attempt(1), False)
        self.assertEqual(game.failed_moves, 1)
        self.assertEqual(game.handoffs, [(1, 0, 15, 1)])
        self.assertEqual(game.trace[-1], ('South', 4, 4, False))

    def test_validation_does_not_charge_meter(self):
        for algorithm in ('old', 'light'):
            checked = ObservedGame(algorithm, size=4, instrumented=True)
            direct = ObservedGame(algorithm, size=4, instrumented=True)
            for target in (1, 2, 3):
                checked.travel(target)
                self.assertIs(direct.attempt(target), True)
                direct.apples += 1
                self.assertEqual(checked.meter.export(), direct.meter.export())
            self.assertEqual(checked.trace, direct.trace)
            self.assertGreater(sum(checked.meter.operations.values()), 0)
            self.assertEqual(sum(checked.meter.moves_by_apples.values()), checked.steps)


if __name__ == '__main__':
    unittest.main()
