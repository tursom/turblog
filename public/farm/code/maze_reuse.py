# Game module: maze_reuse. No work runs merely by importing it.
# Only one drone may control the maze. Other farm workers must be joined first.
MAX_RELOCATIONS = 300
# 0 disables periodic tree rebuilding; 32 is a more aggressive alternative.
TREE_REBUILD_INTERVAL = 64
DIRECTIONS = [North, East, South, West]
graph_revision = 0


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


def manhattan(a, b, size):
	dx = a % size - b % size
	dy = a // size - b // size
	if dx < 0:
		dx = -dx
	if dy < 0:
		dy = -dy
	return dx + dy


def probe(graph, node, size):
	global graph_revision
	# A former wall can open after reuse. Known passages never close.
	for direction in range(4):
		other = neighbor(node, direction, size)
		if other >= 0 and graph[node][direction] == -1:
			if can_move(DIRECTIONS[direction]):
				graph[node][direction] = other
				graph[other][(direction + 2) % 4] = node
				graph_revision += 1


def step_to(graph, current, target):
	for direction in range(4):
		if graph[current][direction] == target:
			return move(DIRECTIONS[direction])
	return False


def discover_target(graph, parent, depth, target, size):
	# Iterative target-directed DFS. Reuse the spanning tree across treasures.
	current = node_id(size)
	probe(graph, current, size)
	visited = {current: True}
	stack = [current]
	while target not in parent:
		best = -1
		best_known = 2
		best_distance = size * size + 1
		for other in graph[current]:
			if other >= 0 and other not in visited:
				known = 0
				if other in parent:
					known = 1
				distance = manhattan(other, target, size)
				if known < best_known or (known == best_known and distance < best_distance):
					best = other
					best_known = known
					best_distance = distance
		if best >= 0:
			if not step_to(graph, current, best):
				return False
			if best not in parent:
				parent[best] = current
				depth[best] = depth[current] + 1
			current = best
			visited[current] = True
			stack.append(current)
			probe(graph, current, size)
		else:
			stack.pop()
			if len(stack) == 0:
				return False
			back = stack[len(stack) - 1]
			if not step_to(graph, current, back):
				return False
			current = back
	return True


def direct_route(graph, start, target, size, horizontal_first):
	route = []
	current = start
	for phase in range(2):
		horizontal = horizontal_first
		if phase == 1:
			horizontal = not horizontal_first
		while True:
			if horizontal:
				if current % size == target % size:
					break
				direction = 1
				if current % size > target % size:
					direction = 3
			else:
				if current // size == target // size:
					break
				direction = 0
				if current // size > target // size:
					direction = 2
			other = graph[current][direction]
			if other < 0:
				return None
			route.append(other)
			current = other
	return route


def tree_route(parent, depth, start, target):
	up = []
	down = []
	u = start
	v = target
	while depth[u] > depth[v]:
		u = parent[u]
		up.append(u)
	while depth[v] > depth[u]:
		down.append(v)
		v = parent[v]
	while u != v:
		u = parent[u]
		up.append(u)
		down.append(v)
		v = parent[v]
	while len(down) > 0:
		up.append(down.pop())
	return up


def navigate(graph, parent, depth, target, size):
	if target not in parent:
		if not discover_target(graph, parent, depth, target, size):
			return False
	current = node_id(size)
	if current == target:
		return get_entity_type() == Entities.Treasure
	probe(graph, current, size)
	route = direct_route(graph, current, target, size, True)
	if route == None:
		route = direct_route(graph, current, target, size, False)
	if route != None:
		for other in route:
			probe(graph, current, size)
			if not step_to(graph, current, other):
				return False
			if other not in parent:
				parent[other] = current
				depth[other] = depth[current] + 1
			current = other
	else:
		route = tree_route(parent, depth, current, target)
		order = {}
		for index in range(len(route)):
			order[route[index]] = index
		cursor = -1
		while cursor < len(route) - 1:
			probe(graph, current, size)
			chosen = cursor + 1
			for other in graph[current]:
				if other in order and order[other] > chosen:
					chosen = order[other]
			other = route[chosen]
			if not step_to(graph, current, other):
				return False
			current = other
			cursor = chosen
	probe(graph, current, size)
	return get_entity_type() == Entities.Treasure


def rebuild_tree(graph, root):
	# Build a shallow spanning tree over known passages only. No drone moves,
	# probing, clearing, or maze relocation happens in this function.
	parent = {root: -1}
	depth = {root: 0}
	queue = [root]
	head = 0
	while head < len(queue):
		current = queue[head]
		head += 1
		for other in graph[current]:
			if other >= 0 and other not in parent:
				parent[other] = current
				depth[other] = depth[current] + 1
				queue.append(other)
	return [parent, depth]


def run_maze_batch(gold_target):
	global graph_revision
	size = get_world_size()
	level = num_unlocked(Unlocks.Mazes)
	if level == 0:
		return False
	multiplier = 2 ** (level - 1)
	amount = size * multiplier
	gold_per_treasure = size * size * multiplier
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
		# No full-field exploration. Map grows only as the drone needs it.
		graph = []
		graph_revision = 0
		tree_revision = 0
		for index in range(size * size):
			graph.append([-1, -1, -1, -1])
		start = node_id(size)
		parent = {start: -1}
		depth = {start: 0}
		relocations = 0
		while True:
			# At most one rebuild per scheduled relocation. Discovery of new
			# passages marks the cache dirty; unchanged maps skip the work.
			if TREE_REBUILD_INTERVAL > 0 and relocations > 0:
				if relocations % TREE_REBUILD_INTERVAL == 0:
					if graph_revision != tree_revision:
						tree = rebuild_tree(graph, node_id(size))
						parent = tree[0]
						depth = tree[1]
						tree_revision = graph_revision
			position = measure()
			if position == None:
				return False
			target = position[0] + position[1] * size
			if not navigate(graph, parent, depth, target, size):
				return False
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
