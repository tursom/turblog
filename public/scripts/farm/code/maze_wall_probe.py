# Game file name: maze_wall_probe
# Run via maze_wall_simulate; parameters are supplied by sim_globals.
DIRECTIONS = [North, East, South, West]


def adjacent(node, direction, size):
	x = node % size
	y = node // size
	if direction == 0 and y < size - 1:
		return node + size
	if direction == 1 and x < size - 1:
		return node + 1
	if direction == 2 and y > 0:
		return node - size
	if direction == 3 and x > 0:
		return node - 1
	return -1


def probe_tile(graph, node, size):
	for direction in range(4):
		other = adjacent(node, direction, size)
		if other >= 0 and can_move(DIRECTIONS[direction]):
			graph[node][direction] = other


def full_scan(size):
	# Traverse the actual maze with iterative DFS. Never teleport through walls.
	graph = []
	for i in range(size * size):
		graph.append([-1, -1, -1, -1])
	start = get_pos_x() + get_pos_y() * size
	seen = {start: True}
	stack = [[start, 0, -1]]
	probe_tile(graph, start, size)
	while len(stack) > 0:
		frame = stack[len(stack) - 1]
		if frame[1] >= 4:
			stack.pop()
			if frame[2] >= 0:
				if not move(DIRECTIONS[frame[2]]):
					return None
			continue
		direction = frame[1]
		frame[1] += 1
		other = graph[frame[0]][direction]
		if other >= 0 and other not in seen:
			if not move(DIRECTIONS[direction]):
				return None
			seen[other] = True
			probe_tile(graph, other, size)
			stack.append([other, 0, (direction + 2) % 4])
	if len(seen) != size * size:
		return None
	return graph


def edge_counts(graph, previous):
	opened = 0
	closed = 0
	passages = 0
	for node in range(len(graph)):
		for direction in range(4):
			other = graph[node][direction]
			if other > node:
				passages += 1
				if previous != None and previous[node][direction] == -1:
					opened += 1
			if previous != None:
				if previous[node][direction] > node and other == -1:
					closed += 1
	return [passages, opened, closed]


def reach_treasure(graph, size):
	position = measure()
	if position == None:
		return False
	target = position[0] + position[1] * size
	start = get_pos_x() + get_pos_y() * size
	parent = {start: -1}
	came_from = {}
	queue = [start]
	head = 0
	while head < len(queue) and target not in parent:
		node = queue[head]
		head += 1
		for direction in range(4):
			other = graph[node][direction]
			if other >= 0 and other not in parent:
				parent[other] = node
				came_from[other] = direction
				queue.append(other)
	if target not in parent:
		return False
	path = []
	node = target
	while node != start:
		path.append(came_from[node])
		node = parent[node]
	while len(path) > 0:
		if not move(DIRECTIONS[path.pop()]):
			return False
	return get_entity_type() == Entities.Treasure


def output(value):
	if FAST_OUTPUT:
		quick_print(value)
	else:
		print(value)


def fail(message, rows):
	output(["ERROR", RUN_SEED, SAMPLE_SIZE, MAZE_LEVEL, message])
	output(rows)
	return False


def collect():
	rows = []
	if RELOCATIONS < 0 or RELOCATIONS > 300:
		return fail("RELOCATIONS must be 0..300", rows)
	set_world_size(SAMPLE_SIZE)
	size = get_world_size()
	level = num_unlocked(Unlocks.Mazes)
	if size != SAMPLE_SIZE or level != MAZE_LEVEL:
		return fail("simulation size/level mismatch", rows)
	amount = size * 2 ** (level - 1)
	if num_items(Items.Weird_Substance) < amount * (RELOCATIONS + 1):
		return fail("insufficient substance", rows)
	if get_entity_type() != None:
		harvest()
	if not plant(Entities.Bush):
		return fail("bush planting failed", rows)
	if not use_item(Items.Weird_Substance, amount):
		return fail("maze creation failed", rows)
	if get_entity_type() != Entities.Hedge and get_entity_type() != Entities.Treasure:
		return fail("maze was not created", rows)

	graph = full_scan(size)
	if graph == None:
		return fail("initial map is not fully reachable", rows)
	total_edges = 2 * size * (size - 1)
	counts = edge_counts(graph, None)
	# relocation, removed walls, added walls, remaining walls, open edges,
	# gold received by this relocation operation.
	rows.append([0, 0, 0, total_edges - counts[0], counts[0], 0])

	for relocation in range(1, RELOCATIONS + 1):
		if not reach_treasure(graph, size):
			return fail("treasure navigation failed", rows)
		before = num_items(Items.Gold)
		if not use_item(Items.Weird_Substance, amount):
			return fail("relocation operation failed", rows)
		gold_delta = num_items(Items.Gold) - before
		fresh = full_scan(size)
		if fresh == None:
			return fail("map became disconnected", rows)
		counts = edge_counts(fresh, graph)
		rows.append([relocation, counts[1], counts[2], total_edges - counts[0], counts[0], gold_delta])
		graph = fresh

	if not reach_treasure(graph, size):
		return fail("final treasure navigation failed", rows)
	before = num_items(Items.Gold)
	if not harvest():
		return fail("final harvest failed", rows)
	final_gold = num_items(Items.Gold) - before
	# No output during sampling: print() takes time and could alter RNG timing.
	output(["MAZE_WALL_CURVE", RUN_SEED, size, level, amount, RELOCATIONS])
	output(["relocation", "removed", "added", "walls_remaining", "open_edges", "gold_delta"])
	for row in rows:
		output(row)
	output(["END", RUN_SEED, "final_harvest_gold", final_gold])
	return True


collect()
