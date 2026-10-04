# The Farmer Was Replaced - 32x32 cactus megafarm
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


def plant_columns(column_count):
	for column in range(column_count):
		for row in range(WORLD_SIZE):
			if get_ground_type() != Grounds.Soil:
				till()
			water_tile()
			if get_entity_type() == None:
				plant(Entities.Cactus)
			move(North)
		move(East)

	# Each worker waits for its own newest cactus. Earlier cacti in the same
	# strip were planted sooner with at least the same minimum water level.
	last_x = (get_pos_x() - 1) % WORLD_SIZE
	goto(last_x, WORLD_SIZE - 1)
	while not can_harvest():
		water_tile()


def plant_field(drone_count, strip_width):
	clear()
	goto(0, 0)
	drones = []

	# Spawn workers for all strips except the final strip.
	for worker in range(drone_count - 1):
		drones.append(spawn_drone(plant_columns, strip_width))
		for step in range(strip_width):
			move(East)

	# The current drone handles the final strip.
	plant_columns(strip_width)

	for drone in drones:
		if drone != None:
			wait_for(drone)


def sort_column():
	column_x = get_pos_x()
	values = []
	goto(column_x, 0)
	for y in range(WORLD_SIZE):
		values.append(measure())
		move(North)

	# Cocktail sort: alternate northward and southward passes.
	start_y = 0
	end_y = WORLD_SIZE - 1
	while start_y < end_y:
		goto(column_x, start_y)
		swapped = False
		for y in range(start_y, end_y):
			if values[y] > values[y + 1]:
				swap(North)
				temp = values[y]
				values[y] = values[y + 1]
				values[y + 1] = temp
				swapped = True
			move(North)
		if not swapped:
			break
		end_y -= 1

		move(South)
		swapped = False
		for y in range(end_y, start_y, -1):
			if values[y] < values[y - 1]:
				swap(South)
				temp = values[y]
				values[y] = values[y - 1]
				values[y - 1] = temp
				swapped = True
			move(South)
		if not swapped:
			break
		start_y += 1
	return values


def sort_column_strip(strip_width):
	columns = []
	for column in range(strip_width):
		columns.append(sort_column())
		move(East)
	return columns


def sort_columns(drone_count, strip_width):
	goto(0, 0)
	drones = []

	for worker in range(drone_count - 1):
		drones.append(spawn_drone(sort_column_strip, strip_width))
		for step in range(strip_width):
			move(East)

	last_columns = sort_column_strip(strip_width)

	# Collect worker results in west-to-east strip order.
	field = []
	for drone in drones:
		if drone != None:
			columns = wait_for(drone)
			for column in columns:
				field.append(column)
	for column in last_columns:
		field.append(column)
	return field


def sort_row(field):
	row_y = get_pos_y()
	values = []
	for x in range(WORLD_SIZE):
		values.append(field[x][row_y])

	# Cocktail sort: alternate eastward and westward passes.
	start_x = 0
	end_x = WORLD_SIZE - 1
	while start_x < end_x:
		goto(start_x, row_y)
		swapped = False
		for x in range(start_x, end_x):
			if values[x] > values[x + 1]:
				swap(East)
				temp = values[x]
				values[x] = values[x + 1]
				values[x + 1] = temp
				swapped = True
			move(East)
		if not swapped:
			break
		end_x -= 1

		move(West)
		swapped = False
		for x in range(end_x, start_x, -1):
			if values[x] < values[x - 1]:
				swap(West)
				temp = values[x]
				values[x] = values[x - 1]
				values[x - 1] = temp
				swapped = True
			move(West)
		if not swapped:
			break
		start_x += 1


def sort_row_strip(strip_width, field):
	for row in range(strip_width):
		sort_row(field)
		move(North)


def sort_rows(drone_count, strip_width, field):
	goto(0, 0)
	drones = []

	for worker in range(drone_count - 1):
		drones.append(spawn_drone(sort_row_strip, strip_width, field))
		for step in range(strip_width):
			move(North)

	sort_row_strip(strip_width, field)

	for drone in drones:
		if drone != None:
			wait_for(drone)


def run_cactus_cycle():
	drone_count = max_drones()
	if drone_count > WORLD_SIZE:
		drone_count = WORLD_SIZE

	# Megafarm levels produce powers of two, so this divides 32 exactly.
	strip_width = WORLD_SIZE // drone_count

	plant_field(drone_count, strip_width)
	field = sort_columns(drone_count, strip_width)
	sort_rows(drone_count, strip_width, field)

	# Rows increase West->East and columns increase South->North.
	# One harvest propagates through all 1024 mature cacti.
	goto(0, 0)
	if can_harvest():
		harvest()
		return True
	return False


while can_afford_field():
	if not run_cactus_cycle():
		break
