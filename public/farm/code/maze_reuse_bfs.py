# The Farmer Was Replaced: reusable maze solver.
# Copy this file into the game as maze_reuse (no automatic execution).
MAX_RELOCATIONS = 300
DIRECTIONS = [North, East, South, West]


def node_id(size):
	return get_pos_x() + get_pos_y() * size


def neighbor(node, direction, size):
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


def probe(graph, node, size):
	changed = False
	for direction in range(4):
		other = neighbor(node, direction, size)
		if other >= 0 and graph[node][direction] == -1:
			if can_move(DIRECTIONS[direction]):
				graph[node][direction] = other
				graph[other][(direction + 2) % 4] = node
				changed = True
	return changed


def explore(size):
	graph = []
	for i in range(size * size):
		graph.append([-1, -1, -1, -1])
	start = node_id(size)
	visited = {start: True}
	# Frame: node, next direction to inspect, direction back to parent.
	stack = [[start, 0, -1]]
	probe(graph, start, size)
	while len(stack) > 0:
		frame = stack[len(stack) - 1]
		node = frame[0]
		if frame[1] == 4:
			stack.pop()
			if frame[2] >= 0:
				if not move(DIRECTIONS[frame[2]]):
					return None
			continue
		direction = frame[1]
		frame[1] += 1
		other = graph[node][direction]
		if other < 0 or other in visited:
			continue
		if not move(DIRECTIONS[direction]):
			return None
		visited[other] = True
		probe(graph, other, size)
		stack.append([other, 0, (direction + 2) % 4])
	return graph


def distances_to(graph, target):
	# A queue head avoids repeated O(n) pop(0).
	distance = {target: 0}
	queue = [target]
	head = 0
	while head < len(queue):
		node = queue[head]
		head += 1
		for other in graph[node]:
			if other >= 0 and other not in distance:
				distance[other] = distance[node] + 1
				queue.append(other)
	return distance


def navigate(graph, target, size):
	distance = distances_to(graph, target)
	current = node_id(size)
	while current != target:
		# Known passages stay valid; only old walls need probing.
		if probe(graph, current, size):
			distance = distances_to(graph, target)
		if current not in distance:
			return False
		chosen = -1
		for direction in range(4):
			other = graph[current][direction]
			if other >= 0 and other in distance:
				if distance[other] == distance[current] - 1:
					chosen = direction
					break
		if chosen < 0 or not move(DIRECTIONS[chosen]):
			return False
		current = node_id(size)
	probe(graph, current, size)
	return get_entity_type() == Entities.Treasure


def run_maze_batch(gold_target):
	# Caller must stop all other drones before entering this routine.
	size = get_world_size()
	level = num_unlocked(Unlocks.Mazes)
	if level == 0:
		return False
	multiplier = 2 ** (level - 1)
	amount = size * multiplier
	gold_per_treasure = size * size * multiplier
	if num_items(Items.Gold) >= gold_target:
		return True
	if num_items(Items.Weird_Substance) < amount:
		return False

	while num_items(Items.Gold) < gold_target:
		if num_items(Items.Weird_Substance) < amount:
			return False
		clear()
		if get_entity_type() != None:
			harvest()
		if not plant(Entities.Bush):
			return False
		if not use_item(Items.Weird_Substance, amount):
			return False
		if get_entity_type() != Entities.Hedge and get_entity_type() != Entities.Treasure:
			return False
		graph = explore(size)
		if graph == None:
			return False
		relocations = 0
		while True:
			position = measure()
			if position == None:
				return False
			target = position[0] + position[1] * size
			if not navigate(graph, target, size):
				return False
			# After relocation 300, reach that final treasure and harvest it.
			if relocations >= MAX_RELOCATIONS:
				if not harvest():
					return False
				break
			if num_items(Items.Gold) + gold_per_treasure >= gold_target:
				if not harvest():
					return False
				break
			if num_items(Items.Weird_Substance) < amount:
				harvest()
				return num_items(Items.Gold) >= gold_target
			if not use_item(Items.Weird_Substance, amount):
				harvest()
				return False
			relocations += 1
	return True
