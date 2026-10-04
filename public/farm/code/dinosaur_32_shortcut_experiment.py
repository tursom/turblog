# Experimental lightweight version of the original shortcut policy.
# For simulations first. Same policy means the original growth dead end remains.
# Early phase: cached candidates and a ring queue of cycle ranks.
# Once the tail reaches 512, only follow the cycle; no software tail tracking.
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


def build_shortcut_tables():
	area = WORLD_SIZE * WORLD_SIZE
	route = []
	neighbors = []
	for index in range(area):
		route.append(None)
		neighbors.append(None)
	directions = [East, North, West, South]
	for y in range(WORLD_SIZE):
		for x in range(WORLD_SIZE):
			head = dino_cycle_index(x, y)
			xs = [x + 1, x, x - 1, x]
			ys = [y, y + 1, y, y - 1]
			options = []
			for index in range(4):
				nx = xs[index]
				ny = ys[index]
				if nx >= 0 and nx < WORLD_SIZE and ny >= 0 and ny < WORLD_SIZE:
					next_head = dino_cycle_index(nx, ny)
					advance = (next_head - head) % area
					entry = [directions[index], next_head, advance]
					options.append(entry)
					position = len(options) - 1
					while position > 0 and options[position - 1][2] < advance:
						options[position] = options[position - 1]
						position -= 1
					options[position] = entry
					if advance == 1:
						route[head] = directions[index]
			neighbors[head] = options
	return [route, neighbors]


def new_shortcut_state():
	ring = []
	for index in range(WORLD_SIZE * WORLD_SIZE):
		ring.append(0)
	# Ring, read cursor, write cursor, tail length, current head cycle rank.
	return [ring, 0, 0, 0, 0]


def move_shortcut_to(target_x, target_y, state, tables):
	area = WORLD_SIZE * WORLD_SIZE
	ring = state[0]
	read = state[1]
	write = state[2]
	length = state[3]
	head = state[4]
	target = dino_cycle_index(target_x, target_y)
	grow = True
	ok = True
	while head != target:
		if length >= DINO_SHORTCUT_LIMIT:
			# The minimum positive cycle advance is always the successor.
			# Never re-enable shortcuts this round; let the game track the tail.
			ok = follow_dino_route(tables[0], head, target)
			if ok:
				head = target
				if grow:
					length += 1
			break

		limit = (target - head) % area
		if length > 0:
			tail_distance = (ring[read] - head) % area
			if grow:
				tail_distance -= 1
			if tail_distance < limit:
				limit = tail_distance
		if limit <= 0:
			ok = False
			break
		# Body ranks stay ordered. The tail is the first occupied rank ahead,
		# so this interval check also replaces the occupied dictionary.
		for entry in tables[1][head]:
			if entry[2] <= limit:
				direction = entry[0]
				next_head = entry[1]
				break
		if not move(direction):
			ok = False
			break
		if grow:
			length += 1
			grow = False
		else:
			read = (read + 1) % area
		ring[write] = head
		write = (write + 1) % area
		head = next_head

	state[1] = read
	state[2] = write
	state[3] = length
	state[4] = head
	return ok


def dinosaur_once(tables):
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
	state = new_shortcut_state()
	next_apple = measure()
	ok = True
	while next_apple != None:
		if not move_shortcut_to(next_apple[0], next_apple[1], state, tables):
			ok = False
			break
		next_apple = measure()
	change_hat(Hats.Straw_Hat)
	clear()
	return ok


def main():
	if get_world_size() != WORLD_SIZE:
		quick_print("Requires a 32x32 farm.")
		return
	tables = build_shortcut_tables()
	while dinosaur_once(tables):
		pass
	quick_print("Stopped: check materials, unlocks, or shortcut dead end.")


main()
