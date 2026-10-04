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


def plant_field():
	clear()
	goto(0, 0)
	plant_columns(WORLD_SIZE)


def sort_column():
	column_x = get_pos_x()

	# Adjacent-swap insertion sort performs exactly one swap per inversion.
	for start_y in range(1, WORLD_SIZE):
		goto(column_x, start_y)
		y = start_y
		value = measure()
		while y > 0 and value < measure(South):
			swap(South)
			move(South)
			y -= 1


def sort_columns():
	goto(0, 0)
	for column in range(WORLD_SIZE):
		sort_column()
		move(East)


def sort_row():
	row_y = get_pos_y()

	# Adjacent-swap insertion sort performs exactly one swap per inversion.
	for start_x in range(1, WORLD_SIZE):
		goto(start_x, row_y)
		x = start_x
		value = measure()
		while x > 0 and value < measure(West):
			swap(West)
			move(West)
			x -= 1


def sort_rows():
	goto(0, 0)
	for row in range(WORLD_SIZE):
		sort_row()
		move(North)


def run_cactus_cycle():
	plant_field()
	sort_columns()
	sort_rows()

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
