from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, List, Optional


MINIMAP_CODE_WALL = 0
MINIMAP_CODE_FREE_GROUND = 1
MINIMAP_CODE_INTERACTIVE = 11
MINIMAP_CODE_OOB_COLLISION = 25

DEFAULT_MIN_WIDTH = 24
DEFAULT_MIN_HEIGHT = 18
DEFAULT_VIEW_WIDTH = 16
DEFAULT_VIEW_HEIGHT = 12
DEFAULT_EXPAND_MARGIN_X = 8
DEFAULT_EXPAND_MARGIN_Y = 8

FogGrid = List[List[Optional[int]]]


def _safe_map_id(map_id: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in str(map_id or "unknown"))
    return cleaned or "unknown"


def _empty_grid(width: int, height: int) -> FogGrid:
    return [[None for _ in range(max(0, int(width)))] for _ in range(max(0, int(height)))]


def _grid_shape(grid: object) -> tuple[int, int] | None:
    if not isinstance(grid, list):
        return None
    width: int | None = None
    for row in grid:
        if not isinstance(row, list):
            return None
        if width is None:
            width = len(row)
        elif len(row) != width:
            return None
        for cell in row:
            if cell is None:
                continue
            if isinstance(cell, bool) or not isinstance(cell, int):
                return None
    return int(width or 0), len(grid)


class HeartGoldMinimapStore:
    """Persistent observed fog-of-war for HeartGold.

    This records facts observed through live RAM position changes when
    available, or through conservative controller-motion tracking when HGSS
    live x/y RAM has not been calibrated yet. The current tile is walkable,
    and a failed directional movement marks the attempted tile as collision.
    """

    def __init__(
        self,
        root: Path,
        *,
        min_width: int = DEFAULT_MIN_WIDTH,
        min_height: int = DEFAULT_MIN_HEIGHT,
        view_width: int = DEFAULT_VIEW_WIDTH,
        view_height: int = DEFAULT_VIEW_HEIGHT,
    ) -> None:
        self.root = Path(root)
        self.min_width = int(min_width)
        self.min_height = int(min_height)
        self.view_width = int(view_width)
        self.view_height = int(view_height)
        self._guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    def _lock_for(self, map_id: str) -> threading.RLock:
        safe_id = _safe_map_id(map_id)
        with self._guard:
            lock = self._locks.get(safe_id)
            if lock is None:
                lock = threading.RLock()
                self._locks[safe_id] = lock
            return lock

    def path_for(self, map_id: str) -> Path:
        return self.root / f"{_safe_map_id(map_id)}.json"

    def load(self, map_id: str) -> FogGrid:
        path = self.path_for(map_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []

        grid = data.get("grid") if isinstance(data, dict) else data
        if _grid_shape(grid) is None:
            return []
        return grid  # type: ignore[return-value]

    def save(self, map_id: str, grid: FogGrid) -> None:
        path = self.path_for(map_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
        tmp.write_text(json.dumps(grid, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)

    def ensure_bounds(self, grid: FogGrid, *, x: int, y: int) -> FogGrid:
        target_w = max(self.min_width, int(x) + DEFAULT_EXPAND_MARGIN_X + 1)
        target_h = max(self.min_height, int(y) + DEFAULT_EXPAND_MARGIN_Y + 1)

        shape = _grid_shape(grid)
        if shape is None:
            grid = []
            current_w = 0
            current_h = 0
        else:
            current_w, current_h = shape

        width = max(current_w, target_w)
        height = max(current_h, target_h)
        if not grid:
            return _empty_grid(width, height)

        for row in grid:
            if len(row) < width:
                row.extend([None] * (width - len(row)))
        for _ in range(len(grid), height):
            grid.append([None for _ in range(width)])
        return grid

    def update_player_tile(self, *, map_id: str, x: int, y: int) -> FogGrid:
        if x < 0 or y < 0:
            return self.load(map_id)
        lock = self._lock_for(map_id)
        with lock:
            grid = self.ensure_bounds(self.load(map_id), x=x, y=y)
            grid[y][x] = MINIMAP_CODE_FREE_GROUND
            self.save(map_id, grid)
            return grid

    def mark_collision(self, *, map_id: str, x: int, y: int) -> FogGrid:
        if x < 0 or y < 0:
            return self.load(map_id)
        lock = self._lock_for(map_id)
        with lock:
            grid = self.ensure_bounds(self.load(map_id), x=x, y=y)
            grid[y][x] = MINIMAP_CODE_WALL
            self.save(map_id, grid)
            return grid

    def observe_movement(
        self,
        *,
        map_id: str,
        before_x: int,
        before_y: int,
        after_x: int,
        after_y: int,
        attempted_x: int | None = None,
        attempted_y: int | None = None,
        collided: bool = False,
    ) -> dict[str, Any]:
        if not map_id or map_id == "unknown":
            return {}

        changed_free: list[list[int]] = []
        changed_wall: list[list[int]] = []
        discovered: list[list[int]] = []

        lock = self._lock_for(map_id)
        with lock:
            target_x = attempted_x if attempted_x is not None else after_x
            target_y = attempted_y if attempted_y is not None else after_y
            max_x = max(before_x, after_x, target_x, 0)
            max_y = max(before_y, after_y, target_y, 0)
            grid = self.ensure_bounds(self.load(map_id), x=max_x, y=max_y)

            def set_tile(x: int, y: int, value: int) -> None:
                if x < 0 or y < 0:
                    return
                prev = grid[y][x]
                if prev == value:
                    return
                grid[y][x] = value
                if value == MINIMAP_CODE_FREE_GROUND:
                    discovered.append([x, y])
                    if prev == MINIMAP_CODE_WALL:
                        changed_free.append([x, y])
                elif value == MINIMAP_CODE_WALL:
                    changed_wall.append([x, y])

            set_tile(before_x, before_y, MINIMAP_CODE_FREE_GROUND)
            set_tile(after_x, after_y, MINIMAP_CODE_FREE_GROUND)
            if collided and attempted_x is not None and attempted_y is not None:
                set_tile(attempted_x, attempted_y, MINIMAP_CODE_WALL)

            self.save(map_id, grid)

        out: dict[str, Any] = {}
        if discovered:
            out["tilesDiscovered"] = {"mapId": map_id, "positions": discovered}
        if changed_free or changed_wall:
            out["groundWallChanged"] = {
                "mapId": map_id,
                "wallsToFree": changed_free,
                "freeToWalls": changed_wall,
            }
        events = []
        if discovered:
            events.append("heartgold_minimap_tiles_discovered")
        if changed_free or changed_wall:
            events.append("heartgold_minimap_collision_changed")
        if events:
            out["events"] = events
        return out

    def tile_at(self, grid: FogGrid, x: int, y: int) -> Optional[int]:
        if x < 0 or y < 0:
            return MINIMAP_CODE_OOB_COLLISION
        if y >= len(grid):
            return None
        row = grid[y]
        if x >= len(row):
            return None
        return row[x]

    def crop_visible(self, grid: FogGrid, *, player_x: int, player_y: int) -> tuple[dict[str, int], FogGrid]:
        origin_x = int(player_x) - (self.view_width // 2)
        origin_y = int(player_y) - 6
        out: FogGrid = []
        for yy in range(origin_y, origin_y + self.view_height):
            row: list[Optional[int]] = []
            for xx in range(origin_x, origin_x + self.view_width):
                row.append(self.tile_at(grid, xx, yy))
            out.append(row)
        return {"x": origin_x, "y": origin_y}, out

    def build_state(
        self,
        *,
        map_id: str,
        map_name: str,
        player_x: int,
        player_y: int,
        orientation: int | None,
    ) -> dict[str, Any]:
        grid = self.update_player_tile(map_id=map_id, x=player_x, y=player_y)
        height = len(grid)
        width = len(grid[0]) if height > 0 else 0
        origin, visible = self.crop_visible(grid, player_x=player_x, player_y=player_y)

        return {
            "minimap_data": {
                "map_id": map_id,
                "map_name": map_name,
                "grid": grid,
                "width": width,
                "height": height,
                "player_x": player_x,
                "player_y": player_y,
                "orientation": orientation,
                "source": "heartgold_ram_observed_fog",
            },
            "visible_area_data": {
                "grid": visible,
                "origin": origin,
                "width": self.view_width,
                "height": self.view_height,
                "source": "heartgold_ram_observed_fog",
            },
            "game_area_meta_tiles": visible,
        }
