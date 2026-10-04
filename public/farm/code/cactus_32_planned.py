# The Farmer Was Replaced - 32x32 planned cactus farm
WORLD_SIZE = 32
WATER_MINIMUM = 0.5


def goto(x, y):
	while get_pos_x() != x:
		dx = (x - get_pos_x() + WORLD_SIZE) % WORLD_SIZE
		if dx <= WORLD_SIZE / 2:
			move(East)
		else:
			move(West)
	while get_pos_y() != y:
		dy = (y - get_pos_y() + WORLD_SIZE) % WORLD_SIZE
		if dy <= WORLD_SIZE / 2:
			move(North)
		else:
			move(South)


def water_tile():
	while get_water() < WATER_MINIMUM and num_items(Items.Water) > 0:
		use_item(Items.Water)


def can_afford_field():
	cost = get_cost(Entities.Cactus)
	if cost == None:
		return False
	for item in cost:
		if num_items(item) < cost[item] * WORLD_SIZE * WORLD_SIZE:
			return False
	return True


def plant_field():
	clear()
	goto(0, 0)
	direction = East
	last_x = 0
	last_y = 0

	for y in range(WORLD_SIZE):
		for step in range(WORLD_SIZE):
			if get_ground_type() != Grounds.Soil:
				till()
			water_tile()
			plant(Entities.Cactus)
			last_x = get_pos_x()
			last_y = get_pos_y()
			if step < WORLD_SIZE - 1:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if y < WORLD_SIZE - 1:
			move(North)

	# The last planted cactus is the newest one.
	goto(last_x, last_y)
	while not can_harvest():
		water_tile()


def empty_grid():
	grid = []
	for y in range(WORLD_SIZE):
		row = []
		for x in range(WORLD_SIZE):
			row.append(0)
		grid.append(row)
	return grid


def scan_field():
	grid = empty_grid()
	counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
	goto(0, 0)
	direction = East

	for y in range(WORLD_SIZE):
		for step in range(WORLD_SIZE):
			x = get_pos_x()
			size = measure()
			grid[y][x] = size
			counts[size] += 1
			if step < WORLD_SIZE - 1:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if y < WORLD_SIZE - 1:
			move(North)

	return [grid, counts]


def sorted_targets(counts):
	targets = []
	for size in range(10):
		for count in range(counts[size]):
			targets.append(size)
	return targets


def find_nearest_source(grid, target_x, target_y, wanted):
	# Search expanding Manhattan rings. The first match is a true nearest
	# source, without scanning every remaining tile.
	for radius in range(1, WORLD_SIZE * 2):
		for dy in range(radius + 1):
			source_y = target_y + dy
			if source_y < WORLD_SIZE:
				dx = radius - dy
				left_x = target_x - dx
				right_x = target_x + dx

				if left_x >= 0:
					if source_y > target_y or left_x > target_x:
						if grid[source_y][left_x] == wanted:
							return [left_x, source_y]

				if right_x != left_x and right_x < WORLD_SIZE:
					if source_y > target_y or right_x > target_x:
						if grid[source_y][right_x] == wanted:
							return [right_x, source_y]

	return [-1, -1]


def simulate_placement(grid, source_x, source_y, target_x, target_y):
	value = grid[source_y][source_x]
	x = source_x
	y = source_y

	while x > target_x:
		grid[y][x] = grid[y][x - 1]
		x -= 1
	while x < target_x:
		grid[y][x] = grid[y][x + 1]
		x += 1
	while y > target_y:
		grid[y][target_x] = grid[y - 1][target_x]
		y -= 1

	grid[target_y][target_x] = value


def build_sort_plan(grid, counts):
	targets = sorted_targets(counts)
	plan = []
	flat_index = 0

	for target_y in range(WORLD_SIZE):
		for target_x in range(WORLD_SIZE):
			wanted = targets[flat_index]
			flat_index += 1

			if grid[target_y][target_x] != wanted:
				source = find_nearest_source(
					grid, target_x, target_y, wanted
				)
				source_x = source[0]
				source_y = source[1]
				plan.append([
					source_x, source_y, target_x, target_y
				])
				simulate_placement(
					grid, source_x, source_y, target_x, target_y
				)

	return plan


def execute_placement(operation):
	source_x = operation[0]
	source_y = operation[1]
	target_x = operation[2]
	target_y = operation[3]
	goto(source_x, source_y)

	while source_x > target_x:
		swap(West)
		move(West)
		source_x -= 1
	while source_x < target_x:
		swap(East)
		move(East)
		source_x += 1
	while source_y > target_y:
		swap(South)
		move(South)
		source_y -= 1


def execute_sort_plan(plan):
	for operation in plan:
		execute_placement(operation)


def run_cactus_cycle():
	plant_field()
	scan = scan_field()
	plan = build_sort_plan(scan[0], scan[1])
	execute_sort_plan(plan)

	# The target matrix is globally sorted in row-major order, so values are
	# nondecreasing West->East and South->North.
	goto(0, 0)
	if can_harvest():
		harvest()
		return True
	return False


while can_afford_field():
	if not run_cactus_cycle():
		break
