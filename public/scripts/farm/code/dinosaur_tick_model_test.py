"""Validate documented cost examples and instrumentation; not in-game tests."""
import ast
from pathlib import Path
import unittest

import dinosaur_tick_model as model


class TickModelTests(unittest.TestCase):
    def execute(self, text):
        meter = model.Meter()
        ns = {'_tick_value': meter.value, '_tick_event': meter.event,
              '_tick_method': meter.method, '_tick_call': meter.call}
        tree = model.Instrument().visit(ast.parse(text))
        exec(compile(ast.fix_missing_locations(tree), '<cost-test>', 'exec'), ns)
        costs = model.score(meter.export(), 0)
        return costs['estimated_ticks'], ns, meter

    def test_loop_examples(self):
        # Timing rules: range 1, loop entry 1, pass 1, no iteration fee.
        ticks, _, _ = self.execute('for i in range(10):\n    pass')
        self.assertEqual(ticks, 12)
        ticks, ns, _ = self.execute('i = 0\nwhile i < 10:\n    i += 1')
        self.assertEqual(ticks, 22)
        self.assertEqual(ns['i'], 10)

    def test_front_pop_costs_length(self):
        ticks, ns, meter = self.execute('q = [4, 5, 6, 7]\nx = q.pop(0)')
        self.assertEqual(ns['q'], [5, 6, 7])
        self.assertEqual(ns['x'], 4)
        self.assertEqual(meter.shifted_slots, 3)
        self.assertEqual(ticks, 8)  # literal 4 + pop 4, assignment 0
        ticks, _, _ = self.execute('q = [4, 5, 6, 7]\nx = q.pop()')
        self.assertEqual(ticks, 5)

    def test_short_circuit_preserved_and_charged(self):
        ticks, ns, _ = self.execute('x = False and (1 / 0)')
        self.assertIs(ns['x'], False)
        self.assertEqual(ticks, 1)
        ticks, ns, _ = self.execute('x = True or (1 / 0) or (2 / 0)')
        self.assertIs(ns['x'], True)
        self.assertEqual(ticks, 2)

    def test_dinosaur_recurrence(self):
        self.assertEqual(model.movement_ticks({0: 1}), 388)
        self.assertEqual(model.movement_ticks({1: 1}), 377)
        self.assertEqual(model.movement_ticks({98: 1}), 33)
        self.assertEqual(model.movement_ticks({1022: 100}), 3300)
        self.assertEqual(model.movement_ticks({0: 1, 1022: 100}, 200), 20200)

    def test_simulation_trajectories_unchanged(self):
        root = Path(__file__).resolve().parent
        old = model.run(root / 'dinosaur_32_baseline.py', 4, 'old', 0)
        new = model.run(root / 'dinosaur_32_full_cycle_experiment.py', 4, 'new', 0)
        self.assertFalse(old['success'])
        self.assertEqual(old['moves'], 52)
        self.assertTrue(new['success'])
        self.assertEqual(new['moves'], 77)
        for run in (old, new):
            self.assertEqual(sum(run['counts']['moves_by_apples'].values()), run['moves'])
            self.assertEqual(run['counts']['api_calls']['measure'], run['apples'] + 1)


if __name__ == '__main__':
    unittest.main()
