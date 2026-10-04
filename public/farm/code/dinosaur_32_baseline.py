# The Farmer Was Replaced - standalone 32x32 dinosaur snake farm.
# Run this file in the game, with no other drones working on the farm.
# Each round clears the entire farm before and after playing.
# Requires Dinosaurs and enough apple materials to fund a full 32x32 round.
# Stops when a full round can no longer be funded.
WORLD_SIZE = 32
# Use target-aware shortcuts below this tail length, then follow the cycle.
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


def dinosaur_once():
	if num_unlocked(Unlocks.Dinosaurs) == 0:
		return False
	cost = get_cost(Entities.Apple)
	if cost == None:
		return False
	for item in cost:
		if num_items(item) < cost[item] * WORLD_SIZE * WORLD_SIZE:
			return False

	clear()
	change_hat(Hats.Dinosaur_Hat)
	body = []
	occupied = {}
	next_apple = measure()

	while next_apple != None:
		if not move_dinosaur_to(next_apple[0], next_apple[1], body, occupied):
			break
		# Standing on the current apple reveals the following apple.
		next_apple = measure()

	change_hat(Hats.Straw_Hat)
	clear()
	return True



def main():
	if get_world_size() != WORLD_SIZE:
		quick_print("Dinosaur script requires a 32x32 farm.")
		return
	while dinosaur_once():
		pass
	quick_print("Dinosaur farming stopped: check Dinosaurs unlock and apple materials.")


main()
