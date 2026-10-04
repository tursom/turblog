# The Farmer Was Replaced - 32x32 all-in-one farm
import maze_reuse
WORLD_SIZE = 32
WATER_LEVEL = 0.75
DINO_SHORTCUT_LIMIT = 512

HAY_RESERVE = 10000000
WOOD_RESERVE = 10000000
CARROT_RESERVE = 10000000
PUMPKIN_RESERVE = 100000
CACTUS_RESERVE = 100000
POWER_RESERVE = 100000
WEIRD_RESERVE = 100000
GOLD_RESERVE = 100000
BONE_RESERVE = 100000

TARGET_TECHS = [
	Unlocks.Auto_Unlock, Unlocks.Cactus, Unlocks.Carrots,
	Unlocks.Costs, Unlocks.Debug, Unlocks.Debug_2,
	Unlocks.Dictionaries, Unlocks.Dinosaurs, Unlocks.Expand,
	Unlocks.Fertilizer, Unlocks.Functions,
	Unlocks.Grass, Unlocks.Hats, Unlocks.Import,
	Unlocks.Leaderboard, Unlocks.Lists, Unlocks.Loops,
	Unlocks.Mazes, Unlocks.Megafarm, Unlocks.Operators,
	Unlocks.Plant, Unlocks.Polyculture, Unlocks.Pumpkins,
	Unlocks.Senses, Unlocks.Simulation, Unlocks.Speed,
	Unlocks.Sunflowers, Unlocks.Timing, Unlocks.Utilities,
	Unlocks.Variables, Unlocks.Watering,
]

GRASS = 0
WOOD = 1
CARROT = 2
WEIRD = 3

SUNFLOWER_RESCAN_INTERVAL = 0
sunflower_initialized = False
sunflower_stable = False
sunflower_fixed_x = 24
sunflower_fixed_y = 16
sunflower_harvests = 0
sunflower_petals = [
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 0, 0, 0],
]


def clear_and_invalidate():
	global sunflower_initialized
	global sunflower_stable
	global sunflower_harvests
	clear()
	sunflower_initialized = False
	sunflower_stable = False
	sunflower_harvests = 0


def reserve_for(item):
	if item == Items.Hay:
		return HAY_RESERVE
	if item == Items.Wood:
		return WOOD_RESERVE
	if item == Items.Carrot:
		return CARROT_RESERVE
	if item == Items.Pumpkin:
		return PUMPKIN_RESERVE
	if item == Items.Cactus:
		return CACTUS_RESERVE
	if item == Items.Power:
		return POWER_RESERVE
	if item == Items.Weird_Substance:
		return WEIRD_RESERVE
	if item == Items.Gold:
		return GOLD_RESERVE
	if item == Items.Bone:
		return BONE_RESERVE
	return 0


def move_to(tx, ty):
	while get_pos_x() != tx:
		d = (tx - get_pos_x()) % WORLD_SIZE
		if d <= 16:
			move(East)
		else:
			move(West)
	while get_pos_y() != ty:
		d = (ty - get_pos_y()) % WORLD_SIZE
		if d <= 16:
			move(North)
		else:
			move(South)


def water():
	if get_water() < WATER_LEVEL and num_items(Items.Water) > 0:
		use_item(Items.Water)


def soil():
	if get_ground_type() != Grounds.Soil:
		till()


def grassland():
	if get_ground_type() != Grounds.Grassland:
		till()


def can_replace_with(companion_type, current):
	# Grass may only use an empty tile or an existing grass tile.
	if companion_type == Entities.Grass:
		return current == None or current == Entities.Grass

	# Trees may replace anything except cactus and pumpkin tiles.
	if companion_type == Entities.Tree:
		if current == Entities.Cactus:
			return False
		if current == Entities.Pumpkin or current == Entities.Dead_Pumpkin:
			return False

	return True


def install_companion(companion_type):
	current = get_entity_type()
	if not can_replace_with(companion_type, current):
		return False
	if current == companion_type:
		return True
	if current != None:
		harvest()

	if companion_type == Entities.Grass:
		grassland()
		return True
	if companion_type == Entities.Carrot:
		soil()
	return plant(companion_type)


def replant_source(source):
	if source == Entities.Grass:
		grassland()
	else:
		plant(source)
	water()


def harvest_with_companion(source):
	companion = get_companion()
	if companion == None:
		return False

	source_x = get_pos_x()
	source_y = get_pos_y()
	move_to(companion[1][0], companion[1][1])
	installed = install_companion(companion[0])
	move_to(source_x, source_y)

	# Another worker may have changed the source while this drone was away.
	if installed and get_entity_type() == source and can_harvest():
		harvest()
		replant_source(source)
		return True
	return False


def maintain_grass():
	e = get_entity_type()
	# Grass never destroys another growing crop. It may reclaim the tile only
	# after that crop naturally becomes harvestable.
	if e != None and e != Entities.Grass:
		if can_harvest():
			harvest()
			grassland()
			water()
		return
	grassland()
	if can_harvest():
		if harvest_with_companion(Entities.Grass):
			return
		if get_entity_type() == Entities.Grass and can_harvest():
			harvest()
	water()


def maintain_crop(target):
	e = get_entity_type()
	if e != target:
		if target == Entities.Tree and not can_replace_with(target, e):
			return
		if e != None:
			harvest()
		if target == Entities.Carrot:
			soil()
		plant(target)
	elif can_harvest():
		if target == Entities.Tree or target == Entities.Bush:
			if harvest_with_companion(target):
				return
		if get_entity_type() != target or not can_harvest():
			return
		harvest()
		plant(target)
	water()


def install_carrot_companion(companion_type):
	return install_companion(companion_type)


def maintain_poly_carrot(x0, y0, width, height):
	current = get_entity_type()
	if current != Entities.Carrot:
		if current != None:
			harvest()
		soil()
		plant(Entities.Carrot)
		water()
		return
	if not can_harvest():
		water()
		return

	companion = get_companion()
	if companion != None:
		target_x = companion[1][0]
		target_y = companion[1][1]
		# Never leave this worker's exclusive 8x8 block.
		if target_x >= x0 and target_x < x0 + width:
			if target_y >= y0 and target_y < y0 + height:
				carrot_x = get_pos_x()
				carrot_y = get_pos_y()
				move_to(target_x, target_y)
				installed = install_carrot_companion(companion[0])
				move_to(carrot_x, carrot_y)
				if installed and get_entity_type() == Entities.Carrot:
					if can_harvest():
						harvest()
						soil()
						plant(Entities.Carrot)
						water()
						return

	# Requests outside the owned block are harvested without the multiplier.
	harvest()
	soil()
	plant(Entities.Carrot)
	water()


def scan_carrot_rect(x0, y0, width, height):
	move_to(x0, y0)
	direction = East
	for row in range(height):
		for step in range(width):
			maintain_poly_carrot(x0, y0, width, height)
			if step < width - 1:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if row < height - 1:
			move(North)


def maintain_weird():
	e = get_entity_type()
	if e != None and e != Entities.Grass:
		harvest()
	grassland()
	if can_harvest():
		harvest()
	if num_items(Items.Fertilizer) > 0:
		use_item(Items.Fertilizer)
		if can_harvest():
			harvest()
	else:
		water()


def maintain_mode(mode):
	if mode == GRASS:
		maintain_grass()
	elif mode == WOOD:
		if (get_pos_x() + get_pos_y()) % 2 == 0:
			maintain_crop(Entities.Tree)
		else:
			maintain_crop(Entities.Bush)
	elif mode == CARROT:
		maintain_crop(Entities.Carrot)
	else:
		maintain_weird()


def scan_rect(x0, y0, width, height, mode):
	move_to(x0, y0)
	direction = East
	for row in range(height):
		for step in range(width):
			maintain_mode(mode)
			if step < width - 1:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if row < height - 1:
			move(North)


def harvest_with_companion_in_rect(source, x0, y0, width, height):
	companion = get_companion()
	if companion == None:
		return False

	target_x = companion[1][0]
	target_y = companion[1][1]
	if target_x < x0 or target_x >= x0 + width:
		return False
	if target_y < y0 or target_y >= y0 + height:
		return False

	source_x = get_pos_x()
	source_y = get_pos_y()
	move_to(target_x, target_y)
	installed = install_companion(companion[0])
	move_to(source_x, source_y)

	if installed and get_entity_type() == source and can_harvest():
		harvest()
		replant_source(source)
		return True
	return False


def maintain_bounded_grass(x0, y0, width, height):
	e = get_entity_type()
	if e != None and e != Entities.Grass:
		if can_harvest():
			harvest()
			grassland()
			water()
		return
	grassland()
	if can_harvest():
		if harvest_with_companion_in_rect(
			Entities.Grass, x0, y0, width, height
		):
			return
		harvest()
	water()


def maintain_bounded_wood(x0, y0, width, height):
	if (get_pos_x() + get_pos_y()) % 2 == 0:
		target = Entities.Tree
	else:
		target = Entities.Bush

	e = get_entity_type()
	if e != target:
		if target == Entities.Tree and not can_replace_with(target, e):
			return
		if e != None:
			harvest()
		plant(target)
	elif can_harvest():
		if harvest_with_companion_in_rect(
			target, x0, y0, width, height
		):
			return
		harvest()
		plant(target)
	water()


def maintain_safe_mode(mode, x0, y0, width, height):
	if mode == GRASS:
		maintain_bounded_grass(x0, y0, width, height)
	elif mode == WOOD:
		maintain_bounded_wood(x0, y0, width, height)
	elif mode == CARROT:
		maintain_poly_carrot(x0, y0, width, height)
	else:
		maintain_weird()


def scan_safe_rect(x0, y0, width, height, mode):
	move_to(x0, y0)
	direction = East
	for row in range(height):
		for step in range(width):
			maintain_safe_mode(mode, x0, y0, width, height)
			if step < width - 1:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if row < height - 1:
			move(North)


def next_cost(tech):
	cost = get_cost(tech)
	if cost == None or len(cost) == 0:
		return None
	return cost


def safe_to_buy(cost):
	for item in cost:
		if num_items(item) - cost[item] < reserve_for(item):
			return False
	return True


def auto_unlock():
	for tech in TARGET_TECHS:
		cost = next_cost(tech)
		if cost != None and safe_to_buy(cost):
			unlock(tech)


def techs_complete():
	for tech in TARGET_TECHS:
		if next_cost(tech) != None:
			return False
	return True


def pending_target(item):
	# No pending technology means no special production and no clear().
	target = 0
	for tech in TARGET_TECHS:
		cost = next_cost(tech)
		if cost != None and item in cost:
			need = cost[item] + reserve_for(item)
			if need > target:
				target = need
	return target


# Pumpkin zone: x=0..15, y=0..15.
def plant_pumpkin():
	soil()
	return plant(Entities.Pumpkin)


def seed_pumpkin_rows(start_y, row_count):
	pending = []
	move_to(0, start_y)
	direction = East

	for row in range(row_count):
		y = start_y + row
		for step in range(16):
			x = get_pos_x()
			e = get_entity_type()
			if e == Entities.Dead_Pumpkin:
				if not plant_pumpkin():
					return None
			elif e != Entities.Pumpkin:
				if e != None:
					harvest()
				if not plant_pumpkin():
					return None
			if not can_harvest():
				pending.append([x, y])
				water()
			if step < 15:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if row < row_count - 1:
			move(North)

	return pending


def append_positions(target, positions):
	if positions == None:
		return False
	for position in positions:
		target.append(position)
	return True


def pumpkin_pending():
	pending = []
	drones = []

	for start_y in range(0, 16, 2):
		drone = spawn_drone(seed_pumpkin_rows, start_y, 2)
		if drone == None:
			if not append_positions(pending, seed_pumpkin_rows(start_y, 2)):
				return None
		else:
			drones.append(drone)

	for drone in drones:
		if not append_positions(pending, wait_for(drone)):
			return None

	return pending


def check_pumpkin_part(positions):
	next_pending = []
	for position in positions:
		move_to(position[0], position[1])
		e = get_entity_type()

		if e == Entities.Dead_Pumpkin:
			if not plant_pumpkin():
				return None
			water()
			next_pending.append(position)
		elif e != Entities.Pumpkin:
			if e != None:
				harvest()
			if not plant_pumpkin():
				return None
			water()
			next_pending.append(position)
		elif not can_harvest():
			water()
			next_pending.append(position)

	return next_pending


def finish_pumpkins(pending):
	while len(pending) > 0:
		parts = []
		for index in range(8):
			parts.append([])

		# Keep each two-row strip spatially local between retry rounds.
		for position in pending:
			parts[position[1] // 2].append(position)

		next_pending = []
		drones = []
		for part in parts:
			if len(part) > 0:
				drone = spawn_drone(check_pumpkin_part, part)
				if drone == None:
					if not append_positions(next_pending, check_pumpkin_part(part)):
						return False
				else:
					drones.append(drone)

		for drone in drones:
			if not append_positions(next_pending, wait_for(drone)):
				return False

		pending = next_pending

	return True


def pumpkin_cycle():
	pending = pumpkin_pending()
	if not finish_pumpkins(pending):
		return False
	move_to(0, 0)
	if can_harvest():
		harvest()
		return True
	return False


# Cactus zone: x=16..23, y=16..23.
def plant_cactus():
	soil()
	return plant(Entities.Cactus)


def cactus_pending():
	pending = []
	move_to(16, 16)
	direction = East
	for row in range(8):
		for step in range(8):
			x = get_pos_x()
			y = get_pos_y()
			e = get_entity_type()
			if e != Entities.Cactus:
				if e != None:
					harvest()
				if not plant_cactus():
					return None
			if not can_harvest():
				pending.append([x, y])
				water()
			if step < 7:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if row < 7:
			move(North)
	return pending


def finish_cacti(pending):
	while len(pending) > 0:
		next_pending = []
		for p in pending:
			move_to(p[0], p[1])
			if get_entity_type() != Entities.Cactus:
				if get_entity_type() != None:
					harvest()
				if not plant_cactus():
					return False
			if not can_harvest():
				water()
				next_pending.append(p)
		pending = next_pending
	return True


def sort_cactus_row(y):
	for start_x in range(17, 24):
		move_to(start_x, y)
		x = start_x
		value = measure()
		while x > 16 and value < measure(West):
			swap(West)
			move(West)
			x -= 1


def sort_cactus_column(x):
	for start_y in range(17, 24):
		move_to(x, start_y)
		y = start_y
		value = measure()
		while y > 16 and value < measure(South):
			swap(South)
			move(South)
			y -= 1


def wait_for_all(drones):
	for drone in drones:
		if drone != None:
			wait_for(drone)


def sort_cacti():
	# Rows are independent and can be sorted concurrently.
	drones = []
	for y in range(16, 24):
		drone = spawn_drone(sort_cactus_row, y)
		if drone == None:
			sort_cactus_row(y)
		else:
			drones.append(drone)
	wait_for_all(drones)

	# Columns are independent after every row worker has finished.
	drones = []
	for x in range(16, 24):
		drone = spawn_drone(sort_cactus_column, x)
		if drone == None:
			sort_cactus_column(x)
		else:
			drones.append(drone)
	wait_for_all(drones)


def cactus_cycle():
	pending = cactus_pending()
	if pending == None or not finish_cacti(pending):
		return False
	sort_cacti()
	move_to(16, 16)
	if can_harvest():
		harvest()
		return True
	return False


# Sunflower zone: x=24..31, y=16..23.
def initialize_sunflowers():
	global sunflower_initialized
	global sunflower_stable
	global sunflower_harvests

	move_to(24, 16)
	direction = East
	for row in range(8):
		for step in range(8):
			x = get_pos_x()
			y = get_pos_y()
			e = get_entity_type()
			if e != Entities.Sunflower:
				if e != None:
					harvest()
				soil()
				if not plant(Entities.Sunflower):
					return False
			sunflower_petals[y - 16][x - 24] = measure()
			water()
			if step < 7:
				move(direction)
		if direction == East:
			direction = West
		else:
			direction = East
		if row < 7:
			move(North)

	sunflower_initialized = True
	sunflower_stable = False
	sunflower_harvests = 0
	return True


def cached_max_sunflower():
	best = -1
	target_x = 24
	target_y = 16
	for y in range(8):
		for x in range(8):
			if sunflower_petals[y][x] > best:
				best = sunflower_petals[y][x]
				target_x = x + 24
				target_y = y + 16
	return [target_x, target_y, best]


def sunflower_cycle():
	global sunflower_initialized
	global sunflower_stable
	global sunflower_fixed_x
	global sunflower_fixed_y
	global sunflower_harvests

	if not sunflower_initialized:
		if not initialize_sunflowers():
			return False
	if SUNFLOWER_RESCAN_INTERVAL > 0:
		if sunflower_harvests >= SUNFLOWER_RESCAN_INTERVAL:
			if not initialize_sunflowers():
				return False

	if sunflower_stable:
		target_x = sunflower_fixed_x
		target_y = sunflower_fixed_y
	else:
		target = cached_max_sunflower()
		target_x = target[0]
		target_y = target[1]
		if target[2] == 7:
			sunflower_stable = True
			sunflower_fixed_x = target_x
			sunflower_fixed_y = target_y

	move_to(target_x, target_y)
	if get_entity_type() != Entities.Sunflower:
		sunflower_initialized = False
		sunflower_stable = False
		return False

	while not can_harvest():
		water()
	if num_items(Items.Carrot) == 0:
		return False

	harvest()
	if not plant(Entities.Sunflower):
		sunflower_initialized = False
		return False

	if not sunflower_stable:
		sunflower_petals[target_y - 16][target_x - 24] = measure()
	sunflower_harvests += 1
	water()
	return True


def launch_rect(drones, x0, y0, width, height, mode):
	drone = spawn_drone(scan_rect, x0, y0, width, height, mode)
	if drone == None:
		scan_rect(x0, y0, width, height, mode)
	else:
		drones.append(drone)


def launch_carrot(drones, x0, y0, width, height):
	drone = spawn_drone(scan_carrot_rect, x0, y0, width, height)
	if drone == None:
		scan_carrot_rect(x0, y0, width, height)
	else:
		drones.append(drone)


def launch_worker(drones, worker):
	drone = spawn_drone(worker)
	if drone == None:
		worker()
	else:
		drones.append(drone)


def add_safe_jobs(jobs, x0, y0, width, height, mode):
	for y in range(y0, y0 + height, 4):
		for x in range(x0, x0 + width, 4):
			jobs.append([x, y, 4, 4, mode])


def build_safe_jobs():
	jobs = []
	add_safe_jobs(jobs, 16, 0, 16, 16, CARROT)
	add_safe_jobs(jobs, 16, 24, 16, 8, CARROT)
	add_safe_jobs(jobs, 0, 16, 16, 4, GRASS)
	add_safe_jobs(jobs, 0, 28, 8, 4, GRASS)
	add_safe_jobs(jobs, 0, 20, 16, 4, WOOD)
	add_safe_jobs(jobs, 8, 28, 8, 4, WOOD)
	add_safe_jobs(jobs, 0, 24, 16, 4, WEIRD)
	return jobs


def run_safe_job(job):
	scan_safe_rect(job[0], job[1], job[2], job[3], job[4])
	return True


def find_free_job(busy, start):
	for offset in range(len(busy)):
		index = (start + offset) % len(busy)
		if not busy[index]:
			return index
	return -1


def keep_workers_busy(cactus_drone, pumpkin_drone):
	jobs = build_safe_jobs()
	busy = []
	for job in jobs:
		busy.append(False)
	active = []
	next_job = 0
	cactus_done = cactus_drone == None
	pumpkin_done = pumpkin_drone == None

	while not cactus_done or not pumpkin_done:
		if not cactus_done and has_finished(cactus_drone):
			wait_for(cactus_drone)
			cactus_done = True
		if not pumpkin_done and has_finished(pumpkin_drone):
			wait_for(pumpkin_drone)
			pumpkin_done = True

		still_active = []
		for entry in active:
			if has_finished(entry[0]):
				wait_for(entry[0])
				busy[entry[1]] = False
			else:
				still_active.append(entry)
		active = still_active

		while num_drones() < max_drones():
			index = find_free_job(busy, next_job)
			if index < 0:
				break
			drone = spawn_drone(run_safe_job, jobs[index])
			if drone == None:
				break
			busy[index] = True
			active.append([drone, index])
			next_job = (index + 1) % len(jobs)

	# Do not start new work after the long tasks finish, but let every tile
	# operation already in flight complete before upgrades or clear().
	for entry in active:
		wait_for(entry[0])


def static_round():
	drones = []

	# Phase 1: one companion-aware pass over every basic-resource region.
	for y in range(0, 16, 8):
		launch_carrot(drones, 16, y, 8, 8)
		launch_carrot(drones, 24, y, 8, 8)
	launch_carrot(drones, 16, 24, 8, 8)
	launch_carrot(drones, 24, 24, 8, 8)
	launch_rect(drones, 0, 16, 16, 4, GRASS)
	launch_rect(drones, 0, 28, 8, 4, GRASS)
	launch_rect(drones, 0, 20, 16, 4, WOOD)
	launch_rect(drones, 8, 28, 8, 4, WOOD)
	launch_rect(drones, 0, 24, 16, 4, WEIRD)
	wait_for_all(drones)

	# Phase 2: start the long special jobs. Safe 4x4 jobs continuously reuse
	# every free drone while cactus and pumpkin work remains.
	cactus_drone = spawn_drone(cactus_cycle)
	if cactus_drone == None:
		cactus_cycle()
	pumpkin_drone = spawn_drone(pumpkin_cycle)
	if pumpkin_drone == None:
		pumpkin_cycle()

	# The coordinator owns the persistent sunflower cache.
	sunflower_cycle()
	keep_workers_busy(cactus_drone, pumpkin_drone)


# Gold stage. A maze temporarily owns the whole farm.
# Cached mapping, BFS and relocation accounting live in maze_reuse.py.


def gold_until(target):
	level = num_unlocked(Unlocks.Mazes)
	if level == 0:
		return False

	multiplier = 2 ** (level - 1)
	maze_cost = WORLD_SIZE * multiplier
	maze_yield = WORLD_SIZE * WORLD_SIZE * multiplier
	missing = target - num_items(Items.Gold)
	runs = (missing + maze_yield - 1) // maze_yield

	# Do not clear the static farm until the whole pending requirement can
	# be completed in one maze batch.
	if num_items(Items.Weird_Substance) < runs * maze_cost:
		return False

	# The reusable solver owns map state for each maze. All static workers
	# have already joined before this function is called.
	global sunflower_initialized
	global sunflower_stable
	global sunflower_harvests
	sunflower_initialized = False
	sunflower_stable = False
	sunflower_harvests = 0
	return maze_reuse.run_maze_batch(target)


# Bone stage: Hamilton cycle with target-aware safe shortcuts.
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

	clear_and_invalidate()
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
	clear_and_invalidate()
	return True


def bones_until(target):
	missing = target - num_items(Items.Bone)
	run_yield = (WORLD_SIZE * WORLD_SIZE - 1) ** 2
	runs = (missing + run_yield - 1) // run_yield
	apple_cost = get_cost(Entities.Apple)
	if apple_cost == None:
		return False

	# As with mazes, wait until every required full tail run is funded.
	for item in apple_cost:
		required = apple_cost[item] * WORLD_SIZE * WORLD_SIZE * runs
		if num_items(item) < required:
			return False

	while num_items(Items.Bone) < target:
		if not dinosaur_once():
			return False
	return True


def special_resources():
	bone_target = pending_target(Items.Bone)
	if num_items(Items.Bone) < bone_target:
		if bones_until(bone_target):
			return True
	gold_target = pending_target(Items.Gold)
	if num_items(Items.Gold) < gold_target:
		if gold_until(gold_target):
			return True
	return False


clear_and_invalidate()

while not techs_complete():
	static_round()
	auto_unlock()
	special_resources()

# Functional technologies are maxed. Never clear the farm again.
while True:
	static_round()
