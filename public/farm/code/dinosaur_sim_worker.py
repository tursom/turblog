# Native simulate() worker; launch through dinosaur_simulate_benchmark.
# BENCH_MODE and BENCH_SEED are injected by sim_globals before execution.
# Do not assign defaults here: that would overwrite the injected values.
WORLD_SIZE = 32
DINO_SHORTCUT_LIMIT = 512


def dino_cycle_index(x, y):
	if y == 0:
		return x
	if x == 0:
		return WORLD_SIZE * WORLD_SIZE - y
	if y % 2 == 1:
		return WORLD_SIZE + (y - 1) * (WORLD_SIZE - 1) + WORLD_SIZE - 1 - x
	return WORLD_SIZE + (y - 1) * (WORLD_SIZE - 1) + x - 1


def choose_dino_move(target_x, target_y, body, occupied, grow):
	x = get_pos_x()
	y = get_pos_y()
	head_index = dino_cycle_index(x, y)
	target_index = dino_cycle_index(target_x, target_y)
	cycle_size = WORLD_SIZE * WORLD_SIZE
	food_distance = (target_index - head_index) % cycle_size

	directions = [East, North, West, South]
	next_x = [x + 1, x, x - 1, x]
	next_y = [y, y + 1, y, y - 1]
	best_direction = None
	best_advance = 0
	tail = -1
	if len(body) > 0:
		tail = body[0]
		tail_x = tail % WORLD_SIZE
		tail_y = tail // WORLD_SIZE
		tail_distance = (
			dino_cycle_index(tail_x, tail_y) - head_index
		) % cycle_size
		if grow:
			tail_distance -= 1
		if tail_distance < food_distance:
			food_distance = tail_distance

	for index in range(4):
		nx = next_x[index]
		ny = next_y[index]
		if nx >= 0 and nx < WORLD_SIZE and ny >= 0 and ny < WORLD_SIZE:
			node = nx + ny * WORLD_SIZE
			blocked = node in occupied
			# On a normal move the final tail segment moves out of the way.
			if blocked and not (not grow and node == tail):
				continue
			advance = (dino_cycle_index(nx, ny) - head_index) % cycle_size
			# Never overtake the next apple in Hamilton-cycle order.
			if advance > 0 and advance <= food_distance:
				if best_direction == None:
					best_advance = advance
					best_direction = directions[index]
				elif len(body) < DINO_SHORTCUT_LIMIT:
					if advance > best_advance:
						best_advance = advance
						best_direction = directions[index]
				elif advance < best_advance:
					best_advance = advance
					best_direction = directions[index]

	return best_direction


def move_dinosaur_to(target_x, target_y, body, occupied):
	# Leaving the current apple grows the tail on the first move only.
	grow = True
	while get_pos_x() != target_x or get_pos_y() != target_y:
		direction = choose_dino_move(target_x, target_y, body, occupied, grow)
		if direction == None:
			return False

		old_position = get_pos_x() + get_pos_y() * WORLD_SIZE
		if not move(direction):
			return False

		if grow:
			body.append(old_position)
			occupied[old_position] = True
			grow = False
		else:
			if len(body) > 0:
				tail = body.pop(0)
				occupied.pop(tail)
			body.append(old_position)
			occupied[old_position] = True

	return True


def build_dino_route():
	# Every entry is the direction leaving that Hamilton-cycle index.
	# Reserve column 0 for the return path from the top to the origin.
	route = []
	for x in range(WORLD_SIZE - 1):
		route.append(East)
	for y in range(1, WORLD_SIZE):
		route.append(North)
		direction = East
		if y % 2 == 1:
			direction = West
		for x in range(WORLD_SIZE - 2):
			route.append(direction)
	route.append(West)
	for y in range(WORLD_SIZE - 1):
		route.append(South)
	return route


def follow_dino_route(route, head_index, target_index):
	# Split at the wrap point: no modulo, position queries, scoring or queue
	# operations in the movement loop. The game tracks growth and the tail.
	if target_index < head_index:
		for index in range(head_index, WORLD_SIZE * WORLD_SIZE):
			if not move(route[index]):
				return False
		head_index = 0
	for index in range(head_index, target_index):
		if not move(route[index]):
			return False
	return True


def run_tick_round(mode, route, pair):
	cost = get_cost(Entities.Apple)
	if cost == None:
		quick_print("STOP: apple cost unavailable.")
		return None
	for item in cost:
		if num_items(item) < cost[item] * WORLD_SIZE * WORLD_SIZE:
			quick_print("STOP: not enough materials for a full round.")
			return None

	bones_before = num_items(Items.Bone)
	power_before = num_items(Items.Power)
	total_start = get_tick_count()
	clear()
	change_hat(Hats.Dinosaur_Hat)
	play_start = get_tick_count()
	body = []
	occupied = {}
	head_index = dino_cycle_index(get_pos_x(), get_pos_y())
	apples = 0
	next_apple = measure()
	while next_apple != None:
		if mode == "baseline":
			if not move_dinosaur_to(next_apple[0], next_apple[1], body, occupied):
				break
		else:
			target_index = dino_cycle_index(next_apple[0], next_apple[1])
			if target_index == head_index:
				break
			if not follow_dino_route(route, head_index, target_index):
				break
			head_index = target_index
		apples += 1
		next_apple = measure()
	play_ticks = get_tick_count() - play_start
	change_hat(Hats.Straw_Hat)
	clear()
	total_ticks = get_tick_count() - total_start
	bones = num_items(Items.Bone) - bones_before
	power_after = num_items(Items.Power)
	complete = next_apple == None and apples == WORLD_SIZE * WORLD_SIZE - 1
	# All reporting is outside the timed interval. Failed rounds stay visible.
	quick_print("ROUND", mode, "pair", pair, "complete", complete, "apples", apples, "play_ticks", play_ticks, "total_ticks", total_ticks, "bones", bones, "power_before", power_before, "power_after", power_after)
	return [complete, play_ticks, total_ticks, bones]


def main():
	if BENCH_MODE != "baseline" and BENCH_MODE != "full_cycle":
		quick_print("SIM_ERROR", "invalid BENCH_MODE")
		return
	set_world_size(WORLD_SIZE)
	if get_world_size() != WORLD_SIZE:
		quick_print("SIM_ERROR", "cannot set 32x32 world")
		return
	route = []
	build_ticks = 0
	if BENCH_MODE == "full_cycle":
		build_start = get_tick_count()
		route = build_dino_route()
		build_ticks = get_tick_count() - build_start
	result = run_tick_round(BENCH_MODE, route, BENCH_SEED)
	if result == None:
		quick_print("SIM_ERROR", BENCH_MODE, "seed", BENCH_SEED, "round did not start")
		return
	quick_print("NATIVE_SIM", BENCH_MODE, "seed", BENCH_SEED, "complete", result[0], "play_ticks", result[1], "total_ticks", result[2], "route_build_ticks", build_ticks, "cold_total_ticks", result[2] + build_ticks, "bones", result[3])


main()
