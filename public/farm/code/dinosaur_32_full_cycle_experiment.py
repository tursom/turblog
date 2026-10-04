# The Farmer Was Replaced - standalone 32x32 dinosaur snake farm.
# Run in the game, with no other drones working on the farm.
# Each round clears the entire farm before and after playing.
# Requires Dinosaurs and enough apple materials for a full round.
# A complete Hamilton cycle guarantees coverage without shortcut dead ends.
# Directions are built once; each movement needs no body tracking or search.
WORLD_SIZE = 32


def dino_cycle_index(x, y):
	if y == 0:
		return x
	if x == 0:
		return WORLD_SIZE * WORLD_SIZE - y
	if y % 2 == 1:
		return WORLD_SIZE + (y - 1) * (WORLD_SIZE - 1) + WORLD_SIZE - 1 - x
	return WORLD_SIZE + (y - 1) * (WORLD_SIZE - 1) + x - 1


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


def dinosaur_once(route):
	if num_unlocked(Unlocks.Dinosaurs) == 0:
		quick_print("Dinosaur farming stopped: Dinosaurs is not unlocked.")
		return False
	cost = get_cost(Entities.Apple)
	if cost == None:
		quick_print("Dinosaur farming stopped: apple cost is unavailable.")
		return False
	for item in cost:
		if num_items(item) < cost[item] * WORLD_SIZE * WORLD_SIZE:
			quick_print("Dinosaur farming stopped: not enough apple materials.")
			return False

	start_ticks = get_tick_count()
	start_bones = num_items(Items.Bone)
	clear()
	change_hat(Hats.Dinosaur_Hat)
	head_index = dino_cycle_index(get_pos_x(), get_pos_y())
	apples = 0
	steps = 0
	next_apple = measure()

	while next_apple != None:
		target_index = dino_cycle_index(next_apple[0], next_apple[1])
		if target_index == head_index:
			break
		if not follow_dino_route(route, head_index, target_index):
			break
		steps += (target_index - head_index) % (WORLD_SIZE * WORLD_SIZE)
		head_index = target_index
		apples += 1
		# Reaching the current apple reveals the following apple.
		next_apple = measure()

	change_hat(Hats.Straw_Hat)
	clear()
	elapsed = get_tick_count() - start_ticks
	bones = num_items(Items.Bone) - start_bones
	quick_print("Dinosaur round: apples", apples, "moves", steps, "ticks", elapsed, "bones", bones)
	if next_apple != None or apples != WORLD_SIZE * WORLD_SIZE - 1:
		quick_print("Dinosaur farming stopped: round ended before full coverage.")
		return False
	return True


def main():
	if get_world_size() != WORLD_SIZE:
		quick_print("Dinosaur script requires a 32x32 farm.")
		return
	route = build_dino_route()
	while dinosaur_once(route):
		pass


main()
