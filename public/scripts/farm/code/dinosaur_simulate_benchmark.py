# Run this driver IN THE GAME alongside the dinosaur_sim_worker code window.
# Native simulations use copied virtual inventories and fixed initial unlocks.
# Main farm scripts and real farm contents are not used as the test world.
# simulate() returns simulated seconds, not ticks; worker prints actual ticks.
SEED_COUNT = 5
SIMULATION_SPEEDUP = 1000


for seed in range(SEED_COUNT):
	order = ["baseline", "full_cycle"]
	if seed % 2 == 1:
		order = ["full_cycle", "baseline"]
	for mode in order:
		run_time = simulate(
			"dinosaur_sim_worker",
			Unlocks,
			{Items.Cactus: 100000000, Items.Power: 0},
			{"BENCH_MODE": mode, "BENCH_SEED": seed},
			seed,
			SIMULATION_SPEEDUP
		)
		quick_print("SIMULATED_SECONDS", mode, "seed", seed, "seconds", run_time)
