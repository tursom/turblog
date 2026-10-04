# Game file name: maze_wall_simulate
# Create maze_wall_probe first, then run this driver (not the probe directly).
SEEDS = [1, 2, 3]
SIZES = [32]
MAZE_LEVELS = [6]
RELOCATIONS = 300
SIM_SPEEDUP = 64
# True prints to the output page without the one-second smoke animation.
# False uses print(); output is still buffered until sampling ends.
FAST_OUTPUT = True

for size in SIZES:
	for level in MAZE_LEVELS:
		for seed in SEEDS:
			sim_unlocks = {}
			for technology in Unlocks:
				sim_unlocks[technology] = -1
			sim_unlocks[Unlocks.Mazes] = level
			amount = size * 2 ** (level - 1)
			sim_items = {
				Items.Weird_Substance: amount * (RELOCATIONS + 2),
				Items.Power: 10000000,
			}
			sim_globals = {
				"RUN_SEED": seed,
				"SAMPLE_SIZE": size,
				"MAZE_LEVEL": level,
				"RELOCATIONS": RELOCATIONS,
				"FAST_OUTPUT": FAST_OUTPUT,
			}
			print("START_MAZE_SAMPLE", seed, size, level)
			run_time = simulate(
				"maze_wall_probe", sim_unlocks, sim_items,
				sim_globals, seed, SIM_SPEEDUP
			)
			print("END_MAZE_SAMPLE", seed, size, level, "simulation_seconds", run_time)
