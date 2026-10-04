"""CPython contract tests. Synthetic ticks verify accounting, NOT performance."""
import ast
from collections import deque
from pathlib import Path
import random
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parent
DIRECTIONS = dict(East=(1, 0), North=(0, 1), West=(-1, 0), South=(0, -1))


def tree(name):
    return ast.parse((ROOT / name).read_text(), filename=name)


def load():
    source = tree('dinosaur_tick_benchmark.py')
    # Keep constants/functions only: never execute the module's main() call.
    source.body = [n for n in source.body if isinstance(n, (ast.Assign, ast.FunctionDef))]
    ns = {}
    exec(compile(source, 'dinosaur_tick_benchmark.py', 'exec'), ns)
    return ns


class Game:
    def __init__(self, size, seed=7):
        self.ns, self.size = load(), size
        self.rng = random.Random(seed)
        self.events, self.logs = [], []
        self.bones, self.material = 0, 100000
        self.cost, self.fail_after = {'Material': 1}, None
        self.head, self.tail, self.occupied = 0, deque(), set()
        self.target, self.grow, self.apples, self.steps = None, True, 0, 0
        self.hat = 'Straw_Hat'
        self.ns.update(WORLD_SIZE=size, **{d: d for d in DIRECTIONS})
        for kind, names in dict(Entities=['Apple'], Items=['Bone', 'Power'],
                                Hats=['Dinosaur_Hat', 'Straw_Hat'], Unlocks=['Dinosaurs']).items():
            self.ns[kind] = SimpleNamespace(**{n: n for n in names})
        for name in ('clear', 'change_hat', 'measure', 'move', 'num_items',
                     'get_tick_count', 'quick_print'):
            self.ns[name] = getattr(self, name)
        self.ns.update(get_pos_x=lambda: self.head % size, get_pos_y=lambda: self.head // size,
                       get_cost=lambda _: self.cost, get_world_size=lambda: size,
                       num_drones=lambda: 1, num_unlocked=lambda _: 1)

    def event(self, name):
        self.events.append(name)

    def get_tick_count(self):
        self.event('tick')
        return len(self.events)  # Artificial monotonic counter, not game tick costs.

    def quick_print(self, *args):
        self.event('print')
        self.logs.append(args)

    def num_items(self, item):
        return self.bones if item == 'Bone' else 100 if item == 'Power' else self.material

    def clear(self):
        assert self.hat == 'Straw_Hat', 'clear before harvesting with hat change'
        self.event('clear')
        self.head, self.tail, self.occupied = 0, deque(), set()
        self.target, self.apples, self.steps = None, 0, 0

    def change_hat(self, hat):
        self.event(hat)
        if hat == 'Straw_Hat':
            self.bones += len(self.tail) ** 2  # Stub harvest; not a yield prediction.
        else:
            self.target, self.grow = None, True
        self.hat = hat

    def measure(self):
        self.event('measure')
        assert self.hat == 'Dinosaur_Hat'
        if self.target is not None:
            assert self.head == self.target, 'measured before reaching apple'
            self.apples += 1
            assert len(self.tail) == self.apples, 'must grow once per apple leg'
        free = [n for n in range(self.size ** 2) if n != self.head and n not in self.occupied]
        if not free:
            assert self.apples == self.size ** 2 - 1
            return None
        self.target, self.grow = self.rng.choice(free), True
        self.material -= 1
        return self.target % self.size, self.target // self.size

    def move(self, direction):
        self.event('move')
        if self.fail_after is not None and self.apples >= self.fail_after:
            return False
        dx, dy = DIRECTIONS[direction]
        x, y = self.head % self.size + dx, self.head // self.size + dy
        assert 0 <= x < self.size and 0 <= y < self.size, 'out of bounds'
        node = x + y * self.size
        assert node not in self.occupied or (not self.grow and node == self.tail[0]), 'collision'
        if not self.grow:
            self.occupied.remove(self.tail.popleft())
        self.tail.append(self.head)
        self.occupied.add(self.head)
        self.head, self.grow = node, False
        self.steps += 1
        assert self.steps <= self.size ** 4, 'route failed to reach target'
        assert self.head not in self.occupied and len(self.tail) == len(self.occupied)
        return True

    def run(self, mode):
        return self.ns['run_tick_round'](mode, self.ns['build_dino_route'](), 1)


def fields(row, start=2):
    return dict(zip(row[start::2], row[start + 1::2]))


class TickBenchmarkTest(unittest.TestCase):
    def test_source_functions_identical(self):
        benchmark = {n.name: n for n in tree('dinosaur_tick_benchmark.py').body
                     if isinstance(n, ast.FunctionDef)}
        for filename, names in [
            ('dinosaur_32_baseline.py', ['dino_cycle_index', 'choose_dino_move', 'move_dinosaur_to']),
            ('dinosaur_32_full_cycle_experiment.py', ['build_dino_route', 'follow_dino_route'])]:
            original = {n.name: n for n in tree(filename).body if isinstance(n, ast.FunctionDef)}
            for name in names:
                with self.subTest(file=filename, function=name):
                    self.assertEqual(ast.dump(benchmark[name]), ast.dump(original[name]))

    def check_round(self, game, result, complete):
        self.assertEqual(result[0], complete)
        ticks = [i for i, e in enumerate(game.events) if e == 'tick']
        self.assertEqual(len(ticks), 4)
        a, b, c, d = ticks
        self.assertEqual(game.events[a:b + 1], ['tick', 'clear', 'Dinosaur_Hat', 'tick'])
        self.assertEqual(game.events[c:d + 1], ['tick', 'Straw_Hat', 'clear', 'tick'])
        self.assertNotIn('print', game.events[a:d + 1])
        self.assertEqual(game.events[d + 1:], ['print'])
        self.assertEqual(result[1:3], [c - b, d - a])
        self.assertEqual(result[3], game.bones)
        self.assertEqual(game.hat, 'Straw_Hat')
        self.assertEqual((game.head, len(game.tail)), (0, 0))
        row = fields(game.logs[-1])
        self.assertEqual([row[k] for k in ('complete', 'play_ticks', 'total_ticks', 'bones')], result)
        self.assertEqual(row['power_before'], row['power_after'])
        return row

    def test_complete_games(self):
        for size, mode in [(4, 'baseline'), (8, 'baseline'), (4, 'full_cycle'),
                           (8, 'full_cycle'), (32, 'full_cycle')]:
            with self.subTest(size=size, mode=mode):
                game = Game(size)
                row = self.check_round(game, game.run(mode), True)
                self.assertEqual(row['apples'], size ** 2 - 1)
                self.assertGreater(row['bones'], 0)

    def test_failed_round_and_statistics(self):
        for mode in ('baseline', 'full_cycle'):
            with self.subTest(mode=mode):
                game = Game(4)
                game.fail_after = 3
                failed = game.run(mode)
                self.assertEqual(self.check_round(game, failed, False)['apples'], 3)
                self.assertGreater(failed[3], 0)
                stats = game.ns['new_tick_stats']()
                for result in ([True, 10, 20, 5], failed, [True, 30, 40, 7]):
                    game.ns['record_tick_round'](stats, result)
                self.assertEqual(stats, [3, 2, 40, 60, 60 + failed[2], 12 + failed[3], 20, 40])
                game.ns['print_tick_summary'](mode, stats)
                self.assertEqual(fields(game.logs[-2]), dict(mean_play_ticks=20, mean_total_ticks=30,
                                                             min_total_ticks=20, max_total_ticks=40))
                self.assertEqual(fields(game.logs[-1]), dict(total_ticks=stats[4], bones=stats[5],
                                                             ticks_per_bone=stats[4] / stats[5]))
                game.logs.clear()
                game.ns['print_tick_summary'](mode, [1, 0, 0, 0, failed[2], failed[3], 0, 0])
                self.assertEqual([r[0] for r in game.logs], ['SUMMARY', 'ALL_ATTEMPTS'])

    def test_insufficient_resources_never_clears(self):
        for cost, material in [(None, 1000), ({'Material': 1}, 15)]:
            for mode in ('baseline', 'full_cycle'):
                with self.subTest(cost=cost, mode=mode):
                    game = Game(4)
                    game.cost, game.material, game.head = cost, material, 7
                    self.assertIsNone(game.run(mode))
                    self.assertEqual(game.events, ['print'])
                    self.assertEqual(game.head, 7)

    def test_main_alternates_and_summarizes_partial_run(self):
        for material, expected_count in [(100000, 6), (5 * 15, 5)]:
            with self.subTest(material=material):
                game = Game(4)
                game.material = material
                game.ns['ROUNDS_PER_ALGORITHM'] = 3
                game.ns['main']()
                rounds = [r for r in game.logs if r[0] == 'ROUND']
                expected = [('baseline', 1), ('full_cycle', 1), ('full_cycle', 2),
                            ('baseline', 2), ('baseline', 3), ('full_cycle', 3)]
                self.assertEqual([(r[1], fields(r)['pair']) for r in rounds], expected[:expected_count])
                summaries = [r for r in game.logs if r[0] == 'SUMMARY']
                self.assertEqual([r[1] for r in summaries], ['baseline', 'full_cycle'])
                for row in summaries:
                    attempts = [fields(r) for r in rounds if r[1] == row[1]]
                    full = [r for r in attempts if r['complete']]
                    self.assertEqual(fields(row), dict(attempts=len(attempts), full_rounds=len(full)))
                    report = {r[0]: fields(r) for r in game.logs
                              if r[0] in ('FULL_ONLY', 'ALL_ATTEMPTS') and r[1] == row[1]}
                    self.assertEqual(report['FULL_ONLY']['mean_total_ticks'],
                                     sum(r['total_ticks'] for r in full) / len(full))
                    self.assertEqual(report['ALL_ATTEMPTS']['total_ticks'],
                                     sum(r['total_ticks'] for r in attempts))
                    self.assertEqual(report['ALL_ATTEMPTS']['bones'], sum(r['bones'] for r in attempts))
                # Seed 7 also exercises an unforced baseline early termination.
                self.assertEqual(fields(rounds[3])['complete'], False)
                self.assertEqual(fields(rounds[3])['apples'], 11)
                self.assertEqual(game.events.count('clear'), 2 * expected_count)
                self.assertEqual(any(str(r[0]).startswith('STOP:') for r in game.logs), expected_count == 5)
                self.assertEqual(game.logs[-1][0], 'SETUP_NOTE')


if __name__ == '__main__':
    unittest.main()
