# The Farmer Was Replaced - 32x32 carrot polyculture
WORLD_SIZE = 32
WATER_LEVEL = 0.75
CARROT_TARGET = 10000000


def move_to(target_x, target_y):
	while get_pos_x() != target_x:
		distance = (target_x - get_pos_x()) % WORLD_SIZE
		if distance <= WORLD_SIZE / 2:
			move(East)
		else:
			move(West)

	while get_pos_y() != target_y:
		distance = (target_y - get_pos_y()) % WORLD_SIZE
		if distance <= WORLD_SIZE / 2:
			move(North)
		else:
			move(South)


def water_if_needed():
	if get_water() < WATER_LEVEL and num_items(Items.Water) > 0:
		use_item(Items.Water)


def make_soil():
	if get_ground_type() != Grounds.Soil:
		till()


def make_grassland():
	if get_ground_type() != Grounds.Grassland:
		till()


def plant_carrot():
	make_soil()
	return plant(Entities.Carrot)


def install_companion(companion_type):
	current = get_entity_type()

	if companion_type == Entities.Grass:
		if current != None and current != Entities.Grass:
			harvest()
		make_grassland()
		return True

	if current == companion_type:
		return True

	if current != None:
		harvest()

	# Bushes and trees may be planted on grassland or soil.
	return plant(companion_type)


def maintain_carrot():
	current = get_entity_type()

	# A companion left by an earlier carrot is restored when the normal
	# field scan reaches this tile.
	if current != Entities.Carrot:
		if current != None:
			harvest()
		plant_carrot()
		water_if_needed()
		return

	if not can_harvest():
		water_if_needed()
		return

	companion = get_companion()
	if companion == None:
		harvest()
		plant_carrot()
		water_if_needed()
		return

	companion_type = companion[0]
	companion_position = companion[1]
	target_x = companion_position[0]
	target_y = companion_position[1]
	carrot_x = get_pos_x()
	carrot_y = get_pos_y()

	# Satisfy the random companion immediately before harvesting.
	move_to(target_x, target_y)
	if not install_companion(companion_type):
		move_to(carrot_x, carrot_y)
		water_if_needed()
		return

	move_to(carrot_x, carrot_y)

	# The carrot stayed mature while the companion was installed.
	if can_harvest():
		harvest()
		plant_carrot()
		water_if_needed()


def run_field_pass():
	move_to(0, 0)
	direction = East

	for y in range(WORLD_SIZE):
		for step in range(WORLD_SIZE):
			maintain_carrot()

			# maintain_carrot() always returns to its original tile.
			if step < WORLD_SIZE - 1:
				move(direction)

		if direction == East:
			direction = West
		else:
			direction = East

		# Because 32 is even, the final move returns the drone to y=0.
		move(North)


clear()

while num_items(Items.Carrot) < CARROT_TARGET:
	run_field_pass()
