const DIRECTIONS = [
  { key: "up", dx: 0, dy: -1 },
  { key: "down", dx: 0, dy: 1 },
  { key: "left", dx: -1, dy: 0 },
  { key: "right", dx: 1, dy: 0 },
];

const UNKNOWN_TILE_COST = 50;
const TALL_GRASS_COST = 25;
const DEFAULT_TILE_COST = 1;
const KNOWN_WARP_CODE = 90;
const MAX_SEARCH_CELLS = 180000;
const MAX_KEYS_TO_RETURN = Number(process.env.HEARTGOLD_PATHFINDER_MAX_KEYS || 160);
const MAX_DETOUR_FACTOR = Number(process.env.HEARTGOLD_PATHFINDER_MAX_DETOUR_FACTOR || 6);
const MAX_DETOUR_EXTRA_KEYS = Number(process.env.HEARTGOLD_PATHFINDER_MAX_DETOUR_EXTRA_KEYS || 24);
const { fieldIsValidated, navigationValidation, validatedRuntimeObjectEntries } = require("./observationContract");

const HARD_BLOCKED = new Set([
  0, // wall
  4, // waterfall is not same-map walking/surfing traversal unless a future Waterfall-aware planner explicitly opts in
  10, // NPC
  11, // generic interactive collision
  14, // PC
  15, // region map
  16, // television
  18, // bookshelf
  21, // trash can
  22, // shop shelf
  33, // boulder
  35, // cuttable tree
  36, // breakable rock
  55, // item ball
  56, // whirlpool field-move obstacle
  57, // headbutt tree field-move obstacle
  66, // temporary wall
  67, // locked door
]);

const AVOID_UNLESS_TARGET = new Set([
  5, // ledge east (semantics not validated for HeartGold)
  6, // ledge west (semantics not validated for HeartGold)
  7, // ledge north (semantics not validated for HeartGold)
  8, // ledge south (semantics not validated for HeartGold)
  9, // warp
  26, // door
  27, // ladder
  28, // escalator
  29, // hole
  30, // stairs
  31, // entrance
  32, // warp arrow
  KNOWN_WARP_CODE, // ROM event warp tile
]);

const OPPOSITE_DIRECTION = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

const BLOCKED_EDGES_BY_CODE = new Map([
  [68, new Set(["up"])],
  [69, new Set(["down"])],
  [70, new Set(["right"])],
  [71, new Set(["left"])],
  [72, new Set(["up", "right"])],
  [73, new Set(["up", "left"])],
  [74, new Set(["down", "right"])],
  [75, new Set(["down", "left"])],
]);

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function sameMapId(a, b) {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  return left === right || `0-${left}` === right || left === `0-${right}`;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return first;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  sinkDown(index) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) {
        smallest = left;
      }
      if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
      index = smallest;
    }
  }
}

function gridTileAt(grid, x, y) {
  if (x < 0 || y < 0) return 0;
  const row = grid[y];
  if (!Array.isArray(row)) return null;
  if (x >= row.length) return null;
  const value = row[x];
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function gridWidth(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return 0;
  return Math.max(...grid.map((row) => (Array.isArray(row) ? row.length : 0)), 0);
}

function movementAllowsSurfableWater(gameDataJson) {
  if (!fieldIsValidated(gameDataJson, "movement")) return false;
  const movement = gameDataJson?.ram_assisted?.modeDetector?.movement || {};
  const mode = String(gameDataJson?.player_movement_mode || movement.mode || "").trim().toUpperCase();
  const vehicle = String(movement.vehicle || "").trim().toLowerCase();
  return mode === "SURFING" || movement.surfing === true || vehicle === "surfing";
}

function makeTileReader({ observedGrid, staticGrid, staticValidated, staticOriginX = 0, staticOriginY = 0, warpTiles, dynamicBlockers }) {
  return (x, y) => {
    if (dynamicBlockers?.has(`${x},${y}`)) return 10;
    const staticCode =
      staticValidated && Array.isArray(staticGrid) ? gridTileAt(staticGrid, x - staticOriginX, y - staticOriginY) : null;
    const observed = gridTileAt(observedGrid, x, y);
    if (staticCode !== null && staticCode !== undefined) {
      if (HARD_BLOCKED.has(staticCode) || BLOCKED_EDGES_BY_CODE.has(staticCode)) return staticCode;
      if (warpTiles?.has(`${x},${y}`)) return KNOWN_WARP_CODE;
      if (staticCode !== 1) return staticCode;
      if (observed !== null && observed !== undefined) return observed;
      return staticCode;
    }
    if (warpTiles?.has(`${x},${y}`)) return KNOWN_WARP_CODE;
    if (observed !== null && observed !== undefined) return observed;
    return null;
  };
}

function isPassable(code, isGoal, options = {}) {
  if (code == null) return true;
  if (code === 3) return options.allowSurfableWater === true;
  if (HARD_BLOCKED.has(code)) return false;
  if (!isGoal && AVOID_UNLESS_TARGET.has(code)) return false;
  return true;
}

function movementCost(code) {
  if (code == null) return UNKNOWN_TILE_COST;
  if (code === 2) return TALL_GRASS_COST;
  return DEFAULT_TILE_COST;
}

function heuristic(x, y, goalX, goalY) {
  return Math.abs(goalX - x) + Math.abs(goalY - y);
}

function reconstruct(cameFrom, endKey) {
  const keys = [];
  let cur = endKey;
  while (cameFrom.has(cur)) {
    const step = cameFrom.get(cur);
    keys.push(step.key);
    cur = step.prev;
  }
  keys.reverse();
  return keys;
}

function describeTile(code, isGoal = false, options = {}) {
  if (code == null) return "unknown/high-cost";
  if (code === 3) {
    return options.allowSurfableWater === true ? "water(surfable,code=3)" : "water(blocked-without-surfing,code=3)";
  }
  if (code === 4) return "waterfall(blocked-for-walking,code=4)";
  if (code === 56) return "whirlpool(blocked-field-move-obstacle,code=56)";
  if (code === 57) return "headbutt-tree(blocked-field-move-obstacle,code=57)";
  if (HARD_BLOCKED.has(code)) return `blocked(code=${code})`;
  if (BLOCKED_EDGES_BY_CODE.has(code)) {
    return `passable-with-blocked-edge(code=${code},blocked=${[...BLOCKED_EDGES_BY_CODE.get(code)].join("+")})`;
  }
  if (code === KNOWN_WARP_CODE) return `known-warp(code=${code}${isGoal ? ",target" : ""})`;
  if (code >= 5 && code <= 8) return `ledge-unvalidated(code=${code}${isGoal ? ",target" : ""})`;
  if (!isGoal && AVOID_UNLESS_TARGET.has(code)) return `transition/avoid-unless-target(code=${code})`;
  if (code === 2) return "tall-grass(code=2)";
  return `passable(code=${code})`;
}

function blockedEdgeReason(fromCode, toCode, direction) {
  const targetEntrySide = OPPOSITE_DIRECTION[direction];
  const fromBlocked = BLOCKED_EDGES_BY_CODE.get(fromCode);
  if (fromBlocked?.has(direction)) {
    return `source tile code ${fromCode} blocks exit ${direction}`;
  }
  const toBlocked = BLOCKED_EDGES_BY_CODE.get(toCode);
  if (toBlocked?.has(targetEntrySide)) {
    return `target tile code ${toCode} blocks entry from ${targetEntrySide}`;
  }
  return null;
}

function canMove(tileAt, from, to, direction, isGoal, options = {}) {
  const toCode = tileAt(to.x, to.y);
  if (!isPassable(toCode, isGoal, options)) return false;
  const fromCode = tileAt(from.x, from.y);
  if (blockedEdgeReason(fromCode, toCode, direction)) return false;
  return true;
}

function astar(tileAt, start, goal, bounds, options = {}) {
  const startKey = `${start.x},${start.y}`;
  const goalKey = `${goal.x},${goal.y}`;
  const frontier = new MinHeap();
  const cameFrom = new Map();
  const bestCost = new Map([[startKey, 0]]);

  frontier.push({ key: startKey, x: start.x, y: start.y, priority: 0 });

  while (frontier.size > 0) {
    const current = frontier.pop();
    if (!current) break;
    if (current.key === goalKey) {
      return reconstruct(cameFrom, goalKey);
    }

    const currentCost = bestCost.get(current.key);
    for (const dir of DIRECTIONS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;
      if (nx < bounds.minX || ny < bounds.minY || nx > bounds.maxX || ny > bounds.maxY) continue;

      const isGoal = nx === goal.x && ny === goal.y;
      if (!canMove(tileAt, { x: current.x, y: current.y }, { x: nx, y: ny }, dir.key, isGoal, options)) continue;

      const code = tileAt(nx, ny);
      const nextKey = `${nx},${ny}`;
      const nextCost = currentCost + movementCost(code);
      if (!bestCost.has(nextKey) || nextCost < bestCost.get(nextKey)) {
        bestCost.set(nextKey, nextCost);
        cameFrom.set(nextKey, { prev: current.key, key: dir.key });
        frontier.push({
          key: nextKey,
          x: nx,
          y: ny,
          priority: nextCost + heuristic(nx, ny, goal.x, goal.y),
        });
      }
    }
  }

  return null;
}

function analyzeNoRoute(tileAt, start, goal, bounds, options = {}) {
  const startKey = `${start.x},${start.y}`;
  const queue = [{ x: start.x, y: start.y, key: startKey }];
  const visited = new Set([startKey]);
  let closest = {
    x: start.x,
    y: start.y,
    distance: heuristic(start.x, start.y, goal.x, goal.y),
  };

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const distance = heuristic(current.x, current.y, goal.x, goal.y);
    if (distance < closest.distance) {
      closest = { x: current.x, y: current.y, distance };
    }

    for (const dir of DIRECTIONS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;
      if (nx < bounds.minX || ny < bounds.minY || nx > bounds.maxX || ny > bounds.maxY) continue;
      if (!canMove(tileAt, { x: current.x, y: current.y }, { x: nx, y: ny }, dir.key, false, options)) continue;
      const nextKey = `${nx},${ny}`;
      if (visited.has(nextKey)) continue;
      visited.add(nextKey);
      queue.push({ x: nx, y: ny, key: nextKey });
    }
  }

  const goalCode = tileAt(goal.x, goal.y);
  const startCode = tileAt(start.x, start.y);
  const goalNeighbors = DIRECTIONS.map((dir) => {
    const nx = goal.x + dir.dx;
    const ny = goal.y + dir.dy;
    if (nx < bounds.minX || ny < bounds.minY || nx > bounds.maxX || ny > bounds.maxY) {
      return `${dir.key}=out-of-bounds`;
    }
    const code = tileAt(nx, ny);
    const reverseDirection = OPPOSITE_DIRECTION[dir.key];
    const edgeReason = blockedEdgeReason(code, goalCode, reverseDirection);
    return `${dir.key}=(${nx},${ny}) ${describeTile(code, false, options)}${edgeReason ? `, crossing-blocked=${edgeReason}` : ""}`;
  });

  return {
    reachableCells: visited.size,
    closestReachable: closest,
    startTile: describeTile(startCode, false, options),
    targetTile: describeTile(goalCode, true, options),
    targetNeighborSummary: goalNeighbors.join("; "),
  };
}

function countUnknownSteps(tileAt, start, keys) {
  let x = start.x;
  let y = start.y;
  let count = 0;
  for (const key of keys) {
    const dir = DIRECTIONS.find((d) => d.key === key);
    if (!dir) continue;
    x += dir.dx;
    y += dir.dy;
    if (tileAt(x, y) == null) count += 1;
  }
  return count;
}

function routeCellsFromKeys(start, keys) {
  let x = start.x;
  let y = start.y;
  const cells = [];
  for (const key of keys || []) {
    const dir = DIRECTIONS.find((d) => d.key === key);
    if (!dir) continue;
    x += dir.dx;
    y += dir.dy;
    cells.push({ x, y });
  }
  return cells;
}

function gridSignature({ staticOriginX, staticOriginY, staticGrid, staticValidated }) {
  if (!staticValidated || !Array.isArray(staticGrid)) return null;
  return {
    originX: staticOriginX,
    originY: staticOriginY,
    width: gridWidth(staticGrid),
    height: staticGrid.length,
  };
}

function addWarpTile(set, warp) {
  if (!warp || typeof warp !== "object") return;
  const x = Number(warp.x);
  const y = Number(warp.y ?? warp.z);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  set.add(`${Math.trunc(x)},${Math.trunc(y)}`);
}

function collectKnownWarpTiles(gameDataJson) {
  const out = new Set();
  if (!fieldIsValidated(gameDataJson, "warps")) return out;
  const collections = [
    gameDataJson?.rom_map_data?.events?.warps,
    gameDataJson?.ram_assisted?.warps?.nearby,
    gameDataJson?.ram_assisted?.warps?.visible,
    gameDataJson?.nearby_warps,
    gameDataJson?.visible_warps,
  ];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const warp of collection) addWarpTile(out, warp);
  }
  return out;
}

function collectDynamicBlockers(gameDataJson, start) {
  const out = new Set();
  const validated = fieldIsValidated(gameDataJson, "npcs");
  if (!validated) {
    return { blockers: out, count: 0, validated: false };
  }
  const entries = validatedRuntimeObjectEntries(gameDataJson, { requireBlocking: true });
  for (const npc of entries) {
    const x = Number(npc.x);
    const y = Number(npc.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const tx = Math.trunc(x);
    const ty = Math.trunc(y);
    if (start && tx === start.x && ty === start.y) continue;
    out.add(`${tx},${ty}`);
  }
  return { blockers: out, count: out.size, validated: true };
}

function implausibleDetour(keys, start, goal) {
  const manhattan = heuristic(start.x, start.y, goal.x, goal.y);
  if (manhattan <= 0 || !Array.isArray(keys) || keys.length === 0) return null;
  const factorLimit = Math.max(12, manhattan * MAX_DETOUR_FACTOR);
  const extraLimit = manhattan + MAX_DETOUR_EXTRA_KEYS;
  if (keys.length <= factorLimit || keys.length <= extraLimit) return null;
  return {
    rejected: true,
    manhattanDistance: manhattan,
    plannedKeyCount: keys.length,
    factorLimit,
    extraLimit,
    maxDetourFactor: MAX_DETOUR_FACTOR,
    maxDetourExtraKeys: MAX_DETOUR_EXTRA_KEYS,
  };
}

function findHeartGoldPath(gameDataJson, x, y, mapId, explanation = "") {
  const validation = navigationValidation(gameDataJson);
  if (!validation.validated) {
    throw new Error(
      "HeartGold path_to_location disabled: current map identity and position are not available. Use screenshot-guided key_press/touch actions."
    );
  }
  const pathfindingContract = gameDataJson?.ram_assisted?.pathfinding;
  if (pathfindingContract?.available !== true) {
    throw new Error(
      `HeartGold path_to_location disabled: ${pathfindingContract?.disabledReason || "pathfinding contract unavailable"}. Use screenshot-guided key_press/touch actions.`
    );
  }
  if (!fieldIsValidated(gameDataJson, "romCollision")) {
    throw new Error(
      "HeartGold path_to_location disabled: same-map collision data is not available. Use screenshot-guided key_press/touch actions."
    );
  }

  const position = gameDataJson?.current_trainer_data?.position || {};
  const currentMapId = position.map_id;
  const minimap = gameDataJson?.minimap_data || {};
  const minimapMapId = minimap.map_id;
  if (!sameMapId(mapId, currentMapId) && !sameMapId(mapId, minimapMapId)) {
    throw new Error(`Player is not on map ${mapId}. Current map: ${currentMapId || minimapMapId || "unknown"}`);
  }

  const observedGrid = Array.isArray(minimap.grid) ? minimap.grid : null;
  const start = { x: toInt(position.x), y: toInt(position.y) };
  const goal = { x: toInt(x), y: toInt(y) };
  const dynamicBlockers = collectDynamicBlockers(gameDataJson, start);
  const staticGrid = Array.isArray(minimap.static_grid) ? minimap.static_grid : null;
  const staticValidated =
    Array.isArray(staticGrid) &&
    staticGrid.length > 0 &&
    (
      pathfindingContract?.staticGridConfidence === "rom_derived" ||
      minimap.static_confidence === "rom_derived"
    );
  const staticOriginX = toInt(minimap.static_origin_x, 0);
  const staticOriginY = toInt(minimap.static_origin_y, 0);
  const staticGridSignature = gridSignature({ staticOriginX, staticOriginY, staticGrid, staticValidated });
  const staticBounds =
    staticValidated && staticGrid
      ? {
          minX: staticOriginX,
          minY: staticOriginY,
          maxX: staticOriginX + gridWidth(staticGrid) - 1,
          maxY: staticOriginY + staticGrid.length - 1,
        }
      : null;
  const tileAt = makeTileReader({
    observedGrid,
    staticGrid,
    staticValidated,
    staticOriginX,
    staticOriginY,
    warpTiles: collectKnownWarpTiles(gameDataJson),
    dynamicBlockers: dynamicBlockers.blockers,
  });
  const traversalOptions = {
    allowSurfableWater: movementAllowsSurfableWater(gameDataJson),
  };
  if (!staticValidated || !staticGrid || staticGrid.length === 0) {
    throw new Error("HeartGold ROM-derived static collision grid is unavailable; path_to_location is disabled to avoid treating observed fog as a full map.");
  }

  if (start.x === goal.x && start.y === goal.y) {
    return {
      keys: [],
      explanation: `Already at target (${goal.x}, ${goal.y}). ${explanation}`.trim(),
      updated_code_path: "",
      atTarget: true,
      mapId: currentMapId,
      start,
      goal,
      staticGridSignature,
      routeCells: [],
    };
  }

  if (goal.x < 0 || goal.y < 0 || goal.x > 4096 || goal.y > 4096) {
    throw new Error(`Refusing HeartGold pathfind to out-of-range target (${goal.x}, ${goal.y}).`);
  }
  if (
    staticBounds &&
    (goal.x < staticBounds.minX ||
      goal.y < staticBounds.minY ||
      goal.x > staticBounds.maxX ||
      goal.y > staticBounds.maxY)
  ) {
    const nearest = {
      x: Math.min(Math.max(goal.x, staticBounds.minX), staticBounds.maxX),
      y: Math.min(Math.max(goal.y, staticBounds.minY), staticBounds.maxY),
    };
    throw new Error(
      `Refusing HeartGold pathfind outside current ROM map bounds (${staticBounds.minX},${staticBounds.minY})-(${staticBounds.maxX},${staticBounds.maxY}). Nearest same-map edge target is (${nearest.x}, ${nearest.y}); use that or direct key presses for map transitions.`
    );
  }
  if (
    staticBounds &&
    (start.x < staticBounds.minX ||
      start.y < staticBounds.minY ||
      start.x > staticBounds.maxX ||
      start.y > staticBounds.maxY)
  ) {
    throw new Error(
      `Refusing HeartGold pathfind from start tile outside current ROM map bounds (${staticBounds.minX},${staticBounds.minY})-(${staticBounds.maxX},${staticBounds.maxY}); current RAM position/map origin is not consistent enough for path_to_location.`
    );
  }

  const observedWidth = gridWidth(observedGrid);
  const observedHeight = Array.isArray(observedGrid) ? observedGrid.length : 0;
  const staticWidth = staticValidated && staticGrid ? gridWidth(staticGrid) : 0;
  const staticHeight = staticValidated && staticGrid ? staticGrid.length : 0;
  const bounds = {
    minX: staticValidated && staticGrid ? Math.min(staticOriginX, start.x, goal.x) : 0,
    minY: staticValidated && staticGrid ? Math.min(staticOriginY, start.y, goal.y) : 0,
    maxX: Math.max(
      staticValidated && staticGrid ? 0 : observedWidth - 1,
      staticValidated && staticGrid ? staticOriginX + staticWidth - 1 : 0,
      start.x,
      goal.x
    ),
    maxY: Math.max(
      staticValidated && staticGrid ? 0 : observedHeight - 1,
      staticValidated && staticGrid ? staticOriginY + staticHeight - 1 : 0,
      start.y,
      goal.y
    ),
  };
  const searchWidth = bounds.maxX - bounds.minX + 1;
  const searchHeight = bounds.maxY - bounds.minY + 1;
  if (searchWidth * searchHeight > MAX_SEARCH_CELLS) {
    throw new Error(`HeartGold path search area is too large (${searchWidth}x${searchHeight}).`);
  }

  const keys = astar(tileAt, start, goal, bounds, traversalOptions);
  if (!keys) {
    const noRoute = analyzeNoRoute(tileAt, start, goal, bounds, traversalOptions);
    return {
      keys: [],
      explanation:
        `No route found from (${start.x}, ${start.y}) to (${goal.x}, ${goal.y}) on the current HeartGold ${staticValidated && staticGrid ? "ROM collision + observed overlay" : "observed fog"} grid. ` +
        `Reachable component from the current tile contains ${noRoute.reachableCells} tile(s); closest reachable tile to target is (${noRoute.closestReachable.x}, ${noRoute.closestReachable.y}), distance ${noRoute.closestReachable.distance}. ` +
        `Start tile: ${noRoute.startTile}. Target tile: ${noRoute.targetTile}. Target neighbors: ${noRoute.targetNeighborSummary}. ` +
        `This means the target is outside the currently reachable same-map component, blocked by known collision/transition tiles, or needs a direct one-tile probe/map transition rather than a same-map path.`,
      updated_code_path: "",
      noRoute,
      mapId: currentMapId,
      start,
      goal,
      staticGridSignature,
      routeCells: [],
    };
  }

  const detour = implausibleDetour(keys, start, goal);
  if (detour) {
    return {
      keys: [],
      explanation:
        `Rejected implausibly indirect HeartGold path from (${start.x}, ${start.y}) to nearby target (${goal.x}, ${goal.y}): ` +
        `${detour.plannedKeyCount} generated key(s) for Manhattan distance ${detour.manhattanDistance}. ` +
        `This usually means the ROM collision grid, observed overlay, or chosen target implies a long same-map loop rather than the visible local intent. ` +
        `Use screenshot-guided short key_press actions, pick a closer waypoint, or fetch a fresh observation before relying on path_to_location. ${explanation}`.trim(),
      updated_code_path: "",
      atTarget: false,
      plannedKeyCount: keys.length,
      returnedKeyCount: 0,
      unknownStepCount: countUnknownSteps(tileAt, start, keys),
      implausibleRoute: detour,
      mapId: currentMapId,
      start,
      goal,
      staticGridSignature,
      routeCells: [],
    };
  }

  const unknownCount = countUnknownSteps(tileAt, start, keys);
  const goalIsKnownWarp = tileAt(goal.x, goal.y) === KNOWN_WARP_CODE;
  const truncated = keys.length > MAX_KEYS_TO_RETURN;
  const returnedKeys = truncated ? keys.slice(0, MAX_KEYS_TO_RETURN) : keys;
  const routeCells = routeCellsFromKeys(start, returnedKeys);
  const uncertainty =
    unknownCount > 0
      ? ` Route crosses ${unknownCount} unexplored tile(s); execution may stop early if one proves to be collision.`
      : "";
  const safety =
    truncated
      ? ` Returned only the first ${MAX_KEYS_TO_RETURN} keys of ${keys.length} to keep HeartGold RAM-observed navigation bounded.`
      : "";
  const warpNote = goalIsKnownWarp ? " Target is a known warp tile, so entering that transition is explicit." : "";
  const dynamicNote =
    dynamicBlockers.count > 0
      ? ` Current runtime objects add ${dynamicBlockers.count} dynamic blocker tile(s).`
      : "";

  return {
    keys: returnedKeys,
    explanation:
      `HeartGold local ${staticValidated && staticGrid ? "ROM collision + observed overlay" : "observed fog"} path from (${start.x}, ${start.y}) to (${goal.x}, ${goal.y}) with ${returnedKeys.length} key(s).${uncertainty}${safety}${warpNote}${dynamicNote}`.trim(),
    updated_code_path: "",
    atTarget: false,
    plannedKeyCount: keys.length,
    returnedKeyCount: returnedKeys.length,
    unknownStepCount: unknownCount,
    mapId: currentMapId,
    start,
    goal,
    staticGridSignature,
    routeCells,
  };
}

module.exports = { findHeartGoldPath };
