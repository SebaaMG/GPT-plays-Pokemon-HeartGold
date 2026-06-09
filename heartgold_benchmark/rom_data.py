from __future__ import annotations

import json
import os
import struct
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from .hgss_map_headers import HGSS_MAP_HEADERS
    from .hgss_map_constants import HGSS_MAP_CONSTANTS
except ImportError:  # pragma: no cover - allows direct script-style imports.
    from hgss_map_headers import HGSS_MAP_HEADERS  # type: ignore[no-redef]
    from hgss_map_constants import HGSS_MAP_CONSTANTS  # type: ignore[no-redef]


try:
    import ndspy.narc
    import ndspy.rom
except ImportError:  # pragma: no cover - runtime reports a clear unavailable state.
    ndspy = None  # type: ignore[assignment]


MINIMAP_CODE_WALL = 0
MINIMAP_CODE_FREE_GROUND = 1
MINIMAP_CODE_TALL_GRASS = 2
MINIMAP_CODE_WATER = 3
MINIMAP_CODE_WATERFALL = 4
MINIMAP_CODE_WARP = 9
MINIMAP_CODE_INTERACTIVE = 11
MINIMAP_CODE_REGION_MAP = 15
MINIMAP_CODE_WHIRLPOOL = 56
MINIMAP_CODE_HEADBUTT_TREE = 57
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROM = ROOT / ".codex_tmp" / "Pokemon - HeartGold Version (USA).nds"
LAND_DATA_NARC = "/a/0/6/5"
MAP_MATRIX_NARC = "/a/0/4/1"
ZONE_EVENT_NARC = "/a/0/3/2"
GRID_WIDTH = 32
GRID_HEIGHT = 32
LAND_DATA_HEADER_SIZE = 0x14
MOVEMENT_SECTION_SIZE = GRID_WIDTH * GRID_HEIGHT * 2
CACHE_PARSER_VERSION = 4
MAX_ZONE_EVENT_COUNT = 512

# Source: pret/pokeheartgold src/metatile_behavior.c. These are semantic
# behavior IDs, not raw addresses. We expose only current tile categories that
# are visible/current and useful for navigation.
TILE_BEHAVIOR_ENCOUNTER_GRASS = 2
TILE_BEHAVIOR_ENCOUNTER_GRASS_ALT = 3
TILE_BEHAVIOR_HEADBUTT = 6
TILE_BEHAVIOR_WHIRLPOOL = 17
TILE_BEHAVIOR_WATERFALL = 19
TILE_BEHAVIOR_TOWN_MAP = 133
SURFABLE_WATER_BEHAVIORS = frozenset({16, 17, 18, 19, 20, 21, 25, 42, 80, 81, 82, 83, 115, 120, 124})


def _read_u32(data: bytes | bytearray, offset: int) -> int:
    if offset + 4 > len(data):
        return 0
    return struct.unpack_from("<I", data, offset)[0]


def _read_u16(data: bytes | bytearray, offset: int) -> int:
    if offset + 2 > len(data):
        return 0
    return struct.unpack_from("<H", data, offset)[0]


def _read_i16(data: bytes | bytearray, offset: int) -> int:
    if offset + 2 > len(data):
        return 0
    return struct.unpack_from("<h", data, offset)[0]


def _read_i32(data: bytes | bytearray, offset: int) -> int:
    if offset + 4 > len(data):
        return 0
    return struct.unpack_from("<i", data, offset)[0]


def _tile_code_from_movement(behavior: int, movement_flag: int) -> int:
    behavior = int(behavior) & 0xFF
    movement_flag = int(movement_flag) & 0xFF

    if behavior == TILE_BEHAVIOR_WATERFALL:
        return MINIMAP_CODE_WATERFALL
    if behavior == TILE_BEHAVIOR_WHIRLPOOL:
        return MINIMAP_CODE_WHIRLPOOL
    if behavior in SURFABLE_WATER_BEHAVIORS:
        return MINIMAP_CODE_WATER
    if behavior == TILE_BEHAVIOR_TOWN_MAP:
        return MINIMAP_CODE_REGION_MAP
    if behavior == TILE_BEHAVIOR_HEADBUTT:
        return MINIMAP_CODE_HEADBUTT_TREE
    if movement_flag & 0x80:
        return MINIMAP_CODE_WALL
    if behavior in {TILE_BEHAVIOR_ENCOUNTER_GRASS, TILE_BEHAVIOR_ENCOUNTER_GRASS_ALT}:
        return MINIMAP_CODE_TALL_GRASS
    return MINIMAP_CODE_FREE_GROUND


def _movement_grid(entry: bytes | bytearray) -> List[List[int]]:
    grid: List[List[int]] = []
    movement = entry[LAND_DATA_HEADER_SIZE : LAND_DATA_HEADER_SIZE + MOVEMENT_SECTION_SIZE]
    if len(movement) < MOVEMENT_SECTION_SIZE:
        return grid

    for y in range(GRID_HEIGHT):
        row: List[int] = []
        for x in range(GRID_WIDTH):
            offset = (y * GRID_WIDTH + x) * 2
            behavior = movement[offset]
            movement_flag = movement[offset + 1]
            # HGSS stores two movement bytes per tile after a 0x14-byte header;
            # pret names the first byte as metatile behavior and the second
            # byte's 0x80 bit as hard collision.
            row.append(_tile_code_from_movement(behavior, movement_flag))
        grid.append(row)
    return grid


def _parse_map_matrix(entry: bytes | bytearray, fallback_map_id: int | None = None) -> Dict[str, Any]:
    if len(entry) < 5:
        return {"ok": False, "error": "matrix_entry_too_short"}

    cursor = 0
    width = int(entry[cursor])
    cursor += 1
    height = int(entry[cursor])
    cursor += 1
    has_headers = bool(entry[cursor])
    cursor += 1
    has_altitudes = bool(entry[cursor])
    cursor += 1
    name_length = int(entry[cursor])
    cursor += 1
    name = bytes(entry[cursor : cursor + name_length]).decode("ascii", errors="ignore")
    cursor += name_length
    cell_count = width * height

    if width <= 0 or height <= 0 or cell_count > 4096:
        return {"ok": False, "error": f"invalid_matrix_shape:{width}x{height}"}

    if has_headers:
        needed = cursor + cell_count * 2
        if needed > len(entry):
            return {"ok": False, "error": "matrix_headers_truncated"}
        headers = [_read_u16(entry, cursor + i * 2) for i in range(cell_count)]
        cursor = needed
    else:
        headers = [int(fallback_map_id or 0) for _ in range(cell_count)]

    if has_altitudes:
        needed = cursor + cell_count
        if needed > len(entry):
            return {"ok": False, "error": "matrix_altitudes_truncated"}
        altitudes = [int(entry[cursor + i]) for i in range(cell_count)]
        cursor = needed
    else:
        altitudes = [0 for _ in range(cell_count)]

    needed = cursor + cell_count * 2
    if needed > len(entry):
        return {"ok": False, "error": "matrix_models_truncated"}
    models = [_read_u16(entry, cursor + i * 2) for i in range(cell_count)]

    return {
        "ok": True,
        "width": width,
        "height": height,
        "hasHeaders": has_headers,
        "hasAltitudes": has_altitudes,
        "name": name,
        "headers": headers,
        "altitudes": altitudes,
        "models": models,
    }


def _parse_zone_events(entry: bytes | bytearray) -> Dict[str, Any]:
    cursor = 0

    def read_count(section: str) -> int | None:
        nonlocal cursor
        if cursor + 4 > len(entry):
            return None
        value = _read_u32(entry, cursor)
        cursor += 4
        if value > MAX_ZONE_EVENT_COUNT:
            return None
        return value

    bg_count = read_count("bgs")
    if bg_count is None:
        return {"ok": False, "error": "bg_count_invalid_or_truncated"}
    bgs = []
    for index in range(bg_count):
        if cursor + 20 > len(entry):
            return {"ok": False, "error": f"bg_event_{index}_truncated"}
        bgs.append(
            {
                "index": index,
                "scriptId": _read_u16(entry, cursor),
                "type": _read_u16(entry, cursor + 2),
                "x": _read_i32(entry, cursor + 4),
                "z": _read_i32(entry, cursor + 8),
                "y": _read_i32(entry, cursor + 12),
                "dir": _read_u32(entry, cursor + 16),
            }
        )
        cursor += 20

    object_count = read_count("objects")
    if object_count is None:
        return {"ok": False, "error": "object_count_invalid_or_truncated"}
    objects = []
    for index in range(object_count):
        if cursor + 32 > len(entry):
            return {"ok": False, "error": f"object_event_{index}_truncated"}
        objects.append(
            {
                "index": index,
                "id": _read_u16(entry, cursor),
                "spriteId": _read_u16(entry, cursor + 2),
                "movement": _read_u16(entry, cursor + 4),
                "type": _read_u16(entry, cursor + 6),
                "eventFlag": _read_u16(entry, cursor + 8),
                "scriptId": _read_u16(entry, cursor + 10),
                "facingDirection": _read_i16(entry, cursor + 12),
                "param0": _read_u16(entry, cursor + 14),
                "param1": _read_u16(entry, cursor + 16),
                "param2": _read_u16(entry, cursor + 18),
                "xRange": _read_i16(entry, cursor + 20),
                "yRange": _read_i16(entry, cursor + 22),
                "x": _read_u16(entry, cursor + 24),
                "z": _read_u16(entry, cursor + 26),
                "y": _read_i32(entry, cursor + 28),
            }
        )
        cursor += 32

    warp_count = read_count("warps")
    if warp_count is None:
        return {"ok": False, "error": "warp_count_invalid_or_truncated"}
    warps = []
    for index in range(warp_count):
        if cursor + 12 > len(entry):
            return {"ok": False, "error": f"warp_event_{index}_truncated"}
        warps.append(
            {
                "index": index,
                "x": _read_u16(entry, cursor),
                "z": _read_u16(entry, cursor + 2),
                "header": _read_u16(entry, cursor + 4),
                "anchor": _read_u16(entry, cursor + 6),
                "y": _read_u32(entry, cursor + 8),
            }
        )
        cursor += 12

    coord_count = read_count("coords")
    if coord_count is None:
        return {"ok": False, "error": "coord_count_invalid_or_truncated"}
    coords = []
    for index in range(coord_count):
        if cursor + 16 > len(entry):
            return {"ok": False, "error": f"coord_event_{index}_truncated"}
        coords.append(
            {
                "index": index,
                "scriptId": _read_u16(entry, cursor),
                "x": _read_i16(entry, cursor + 2),
                "z": _read_i16(entry, cursor + 4),
                "w": _read_u16(entry, cursor + 6),
                "h": _read_u16(entry, cursor + 8),
                "y": _read_u16(entry, cursor + 10),
                "val": _read_u16(entry, cursor + 12),
                "var": _read_u16(entry, cursor + 14),
            }
        )
        cursor += 16

    return {
        "ok": True,
        "source": ZONE_EVENT_NARC,
        "confidence": "rom_derived_static",
        "counts": {
            "bgs": len(bgs),
            "objects": len(objects),
            "warps": len(warps),
            "coords": len(coords),
        },
        "bgs": bgs,
        "objects": objects,
        "warps": warps,
        "coords": coords,
    }


class HeartGoldRomData:
    def __init__(self, rom_path: Path = DEFAULT_ROM, cache_dir: Optional[Path] = None) -> None:
        self.rom_path = Path(os.environ.get("HEARTGOLD_ROM", str(rom_path)))
        self.cache_dir = Path(cache_dir or Path(os.environ.get("HEARTGOLD_RUNTIME_DIR", ".heartgold_runtime")) / "rom_cache")
        self._land_grids: Optional[Dict[str, Any]] = None
        self._map_matrices: Optional[Dict[str, Any]] = None
        self._zone_events: Optional[Dict[str, Any]] = None
        self._metadata: Optional[Dict[str, Any]] = None

    @property
    def available(self) -> bool:
        return ndspy is not None and self.rom_path.exists()

    def _cache_path(self, name: str) -> Path:
        return self.cache_dir / name

    def _load_cache(self, name: str, source: str) -> Optional[Dict[str, Any]]:
        path = self._cache_path(name)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None
        if (
            not isinstance(data, dict)
            or data.get("source") != source
            or data.get("parserVersion") != CACHE_PARSER_VERSION
        ):
            return None
        return data

    def _save_cache(self, name: str, data: Dict[str, Any]) -> None:
        path = self._cache_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)

    def _narc_files(self, narc_path: str) -> List[bytes]:
        if ndspy is None:
            raise RuntimeError("ndspy is not installed; run pip install -r requirements.txt")
        if not self.rom_path.exists():
            raise RuntimeError(f"HeartGold ROM not found: {self.rom_path}")
        rom = ndspy.rom.NintendoDSRom.fromFile(str(self.rom_path))
        narc = ndspy.narc.NARC(rom.getFileByName(narc_path))
        return list(narc.files)

    def load_land_grids(self) -> Dict[str, Any]:
        if self._land_grids is not None:
            return self._land_grids

        cached = self._load_cache("land_grids.json", LAND_DATA_NARC)
        if cached is not None:
            self._land_grids = cached
            return cached

        land_files = self._narc_files(LAND_DATA_NARC)
        grids: Dict[str, Any] = {}
        metadata: Dict[str, Any] = {
            "source": LAND_DATA_NARC,
            "parserVersion": CACHE_PARSER_VERSION,
            "mappingConfidence": "candidate_until_matrix_header_mapping_verified",
            "entryCount": len(land_files),
            "width": GRID_WIDTH,
            "height": GRID_HEIGHT,
        }

        for index, entry in enumerate(land_files):
            grid = _movement_grid(entry)
            if not grid:
                continue
            grids[str(index)] = {
                "grid": grid,
                "width": GRID_WIDTH,
                "height": GRID_HEIGHT,
                "blockedCount": sum(1 for row in grid for cell in row if cell == MINIMAP_CODE_WALL),
                "freeCount": sum(1 for row in grid for cell in row if cell == MINIMAP_CODE_FREE_GROUND),
                "sectionSizes": [_read_u32(entry, offset) for offset in (0, 4, 8, 12)],
                "mappingConfidence": "candidate_until_matrix_header_mapping_verified",
            }

        data = {"source": LAND_DATA_NARC, "parserVersion": CACHE_PARSER_VERSION, "metadata": metadata, "grids": grids}
        self._save_cache("land_grids.json", data)
        self._land_grids = data
        return data

    def load_map_matrices(self) -> Dict[str, Any]:
        if self._map_matrices is not None:
            return self._map_matrices

        cached = self._load_cache("map_matrices.json", MAP_MATRIX_NARC)
        if cached is not None:
            self._map_matrices = cached
            return cached

        matrix_files = self._narc_files(MAP_MATRIX_NARC)
        matrices: Dict[str, Any] = {}
        for index, entry in enumerate(matrix_files):
            parsed = _parse_map_matrix(entry)
            if parsed.get("ok"):
                matrices[str(index)] = parsed
            else:
                matrices[str(index)] = {"ok": False, "error": parsed.get("error") or "parse_failed"}
        data = {
            "source": MAP_MATRIX_NARC,
            "parserVersion": CACHE_PARSER_VERSION,
            "metadata": {"entryCount": len(matrix_files), "source": MAP_MATRIX_NARC},
            "matrices": matrices,
        }
        self._save_cache("map_matrices.json", data)
        self._map_matrices = data
        return data

    def load_zone_events(self) -> Dict[str, Any]:
        if self._zone_events is not None:
            return self._zone_events

        cached = self._load_cache("zone_events.json", ZONE_EVENT_NARC)
        if cached is not None:
            self._zone_events = cached
            return cached

        event_files = self._narc_files(ZONE_EVENT_NARC)
        events: Dict[str, Any] = {}
        for index, entry in enumerate(event_files):
            parsed = _parse_zone_events(entry)
            if parsed.get("ok"):
                events[str(index)] = parsed
            else:
                events[str(index)] = {"ok": False, "error": parsed.get("error") or "parse_failed"}
        data = {
            "source": ZONE_EVENT_NARC,
            "parserVersion": CACHE_PARSER_VERSION,
            "metadata": {"entryCount": len(event_files), "source": ZONE_EVENT_NARC},
            "events": events,
        }
        self._save_cache("zone_events.json", data)
        self._zone_events = data
        return data

    def events_for_map_id(
        self,
        map_id: str | int | None,
        *,
        origin_x: int | None = None,
        origin_y: int | None = None,
    ) -> Optional[Dict[str, Any]]:
        if map_id is None:
            return None
        map_key = str(map_id)
        header = HGSS_MAP_HEADERS.get(map_key)
        if not isinstance(header, dict):
            return None
        bank = header.get("events_bank")
        if bank is None:
            return None
        events = self.load_zone_events().get("events", {}).get(str(bank))
        if not isinstance(events, dict) or not events.get("ok"):
            return None

        ox = int(origin_x or 0)
        oy = int(origin_y or 0)

        def with_local(entry: Dict[str, Any]) -> Dict[str, Any]:
            x = int(entry.get("x") or 0)
            z = int(entry.get("z") or 0)
            out = dict(entry)
            out["localX"] = x - ox
            out["localY"] = z - oy
            return out

        raw_warps = events.get("warps") if isinstance(events.get("warps"), list) else []
        raw_bgs = events.get("bgs") if isinstance(events.get("bgs"), list) else []
        raw_objects = events.get("objects") if isinstance(events.get("objects"), list) else []
        raw_coords = events.get("coords") if isinstance(events.get("coords"), list) else []

        warps = []
        for warp in raw_warps:
            out = with_local(warp)
            dest_id = str(out.get("header"))
            dest_meta = HGSS_MAP_CONSTANTS.get(dest_id) if isinstance(HGSS_MAP_CONSTANTS, dict) else None
            out["destinationMapId"] = dest_id
            out["destinationMapName"] = dest_meta.get("name") if isinstance(dest_meta, dict) else None
            out["destinationMapConstant"] = dest_meta.get("constant") if isinstance(dest_meta, dict) else None
            warps.append(out)

        return {
            "map_id": map_key,
            "eventsBank": int(bank),
            "eventsSymbol": header.get("events_symbol"),
            "source": ZONE_EVENT_NARC,
            "confidence": "rom_derived",
            "originX": ox,
            "originY": oy,
            "counts": dict(events.get("counts") or {}),
            "warps": warps,
            "bgEvents": [with_local(bg) for bg in raw_bgs],
            "objectEventCandidates": [with_local(obj) for obj in raw_objects],
            "coordEvents": [with_local(coord) for coord in raw_coords],
        }

    def grid_for_map_id(self, map_id: str | int | None) -> Optional[Dict[str, Any]]:
        if map_id is None:
            return None
        return self.grid_for_position(map_id, None, None)

    def current_connections_for_position(
        self,
        map_id: str | int | None,
        x: int | None,
        y: int | None,
    ) -> Optional[Dict[str, Any]]:
        if map_id is None:
            return None
        map_key = str(map_id)
        header = HGSS_MAP_HEADERS.get(map_key)
        if not isinstance(header, dict):
            return None
        matrix_id = header.get("matrix_id")
        if matrix_id is None:
            return None

        matrices = self.load_map_matrices().get("matrices", {})
        matrix_raw = matrices.get(str(matrix_id))
        if not isinstance(matrix_raw, dict) or not matrix_raw.get("ok"):
            return None

        width = int(matrix_raw.get("width") or 0)
        height = int(matrix_raw.get("height") or 0)
        headers = matrix_raw.get("headers") if isinstance(matrix_raw.get("headers"), list) else []
        if width <= 0 or height <= 0 or len(headers) < width * height or matrix_raw.get("hasHeaders") is False:
            return {
                "map_id": map_key,
                "source": "heartgold_rom_map_matrix_current_adjacency",
                "confidence": "validation_failed",
                "validationFailure": "matrix_headers_required_for_current_connections",
                "matrixId": int(matrix_id),
            }

        map_num = int(map_key)
        cells = [
            {"index": idx, "cellX": idx % width, "cellY": idx // width}
            for idx, cell_header in enumerate(headers[: width * height])
            if int(cell_header) == map_num
        ]
        if not cells:
            return {
                "map_id": map_key,
                "source": "heartgold_rom_map_matrix_current_adjacency",
                "confidence": "validation_failed",
                "validationFailure": "map_header_not_present_in_matrix",
                "matrixId": int(matrix_id),
                "matrixWidth": width,
                "matrixHeight": height,
            }

        selected_cell: Dict[str, int] | None = None
        position_binding_mode = "unknown"
        if x is not None and y is not None:
            cell_x = int(x) // GRID_WIDTH
            cell_y = int(y) // GRID_HEIGHT
            if 0 <= cell_x < width and 0 <= cell_y < height:
                idx = cell_y * width + cell_x
                if int(headers[idx]) != map_num:
                    return {
                        "map_id": map_key,
                        "source": "heartgold_rom_map_matrix_current_adjacency",
                        "confidence": "validation_failed",
                        "validationFailure": f"position_cell_header_mismatch:{headers[idx]}",
                        "matrixId": int(matrix_id),
                        "matrixCellX": cell_x,
                        "matrixCellY": cell_y,
                    }
                selected_cell = {"cellX": cell_x, "cellY": cell_y}
                position_binding_mode = "matrix_global_position"
            elif len(cells) == 1 and 0 <= int(x) < GRID_WIDTH and 0 <= int(y) < GRID_HEIGHT:
                selected_cell = {"cellX": int(cells[0]["cellX"]), "cellY": int(cells[0]["cellY"])}
                position_binding_mode = "single_cell_local_position"
            else:
                return {
                    "map_id": map_key,
                    "source": "heartgold_rom_map_matrix_current_adjacency",
                    "confidence": "validation_failed",
                    "validationFailure": "position_outside_matrix_and_not_single_cell_local",
                    "matrixId": int(matrix_id),
                    "matrixWidth": width,
                    "matrixHeight": height,
                }
        elif len(cells) == 1:
            selected_cell = {"cellX": int(cells[0]["cellX"]), "cellY": int(cells[0]["cellY"])}
            position_binding_mode = "single_cell_without_position"
        else:
            return {
                "map_id": map_key,
                "source": "heartgold_rom_map_matrix_current_adjacency",
                "confidence": "candidate_requires_position_validation",
                "validationFailure": "multi_cell_map_requires_live_position",
                "matrixId": int(matrix_id),
                "matchingCells": cells,
            }

        directions = [
            ("north", 0, -1),
            ("south", 0, 1),
            ("west", -1, 0),
            ("east", 1, 0),
        ]
        connections: List[Dict[str, Any]] = []
        for direction, dx, dy in directions:
            neighbor_x = int(selected_cell["cellX"]) + dx
            neighbor_y = int(selected_cell["cellY"]) + dy
            if not (0 <= neighbor_x < width and 0 <= neighbor_y < height):
                continue
            idx = neighbor_y * width + neighbor_x
            neighbor_map = int(headers[idx])
            if neighbor_map == 0 or neighbor_map == map_num:
                continue
            neighbor_key = str(neighbor_map)
            meta = HGSS_MAP_CONSTANTS.get(neighbor_key) or {}
            neighbor_header = HGSS_MAP_HEADERS.get(neighbor_key) or {}
            connections.append(
                {
                    "direction": direction,
                    "map_id": neighbor_key,
                    "map_name": meta.get("name") or neighbor_header.get("constant") or f"HGSS Map {neighbor_key}",
                    "map_constant": meta.get("constant") or neighbor_header.get("constant"),
                    "matrixCellX": neighbor_x,
                    "matrixCellY": neighbor_y,
                    "source": "current_matrix_cardinal_neighbor",
                }
            )

        return {
            "map_id": map_key,
            "source": "heartgold_rom_map_matrix_current_adjacency",
            "confidence": "rom_derived",
            "contract": "rom_derived_current_matrix_adjacency_current_position",
            "matrixId": int(matrix_id),
            "matrixName": matrix_raw.get("name"),
            "matrixWidth": width,
            "matrixHeight": height,
            "currentCellX": int(selected_cell["cellX"]),
            "currentCellY": int(selected_cell["cellY"]),
            "currentCellEvidence": {
                "mapId": map_key,
                "matrixId": int(matrix_id),
                "matrixWidth": width,
                "matrixHeight": height,
                "currentCellX": int(selected_cell["cellX"]),
                "currentCellY": int(selected_cell["cellY"]),
                "headersPresent": True,
                "currentCellInBounds": (
                    0 <= int(selected_cell["cellX"]) < width
                    and 0 <= int(selected_cell["cellY"]) < height
                ),
                "currentCellHeaderMatchesMap": True,
                "positionBoundToCurrentCell": position_binding_mode != "single_cell_without_position",
                "positionBindingMode": position_binding_mode,
                "connectionsDerivedFromCurrentCell": True,
            },
            "connections": connections,
        }

    def grid_for_position(self, map_id: str | int | None, x: int | None, y: int | None) -> Optional[Dict[str, Any]]:
        if map_id is None:
            return None
        map_key = str(map_id)
        header = HGSS_MAP_HEADERS.get(map_key)
        if not isinstance(header, dict):
            return None
        matrix_id = header.get("matrix_id")
        if matrix_id is None:
            return None

        matrices = self.load_map_matrices().get("matrices", {})
        matrix_raw = matrices.get(str(matrix_id))
        if not isinstance(matrix_raw, dict) or not matrix_raw.get("ok"):
            return None

        width = int(matrix_raw.get("width") or 0)
        height = int(matrix_raw.get("height") or 0)
        headers = matrix_raw.get("headers") if isinstance(matrix_raw.get("headers"), list) else []
        models = matrix_raw.get("models") if isinstance(matrix_raw.get("models"), list) else []
        if width <= 0 or height <= 0 or len(models) < width * height:
            return None
        if not headers or len(headers) < width * height or matrix_raw.get("hasHeaders") is False:
            headers = [int(map_key) for _ in range(width * height)]

        map_num = int(map_key)
        cells = []
        for idx, cell_header in enumerate(headers[: width * height]):
            if int(cell_header) == map_num:
                cells.append(
                    {
                        "index": idx,
                        "cellX": idx % width,
                        "cellY": idx // width,
                        "model": int(models[idx]),
                    }
                )
        if not cells:
            return {
                "map_id": map_key,
                "source": "heartgold_rom_map_matrix",
                "confidence": "validation_failed",
                "validationFailure": "map_header_not_present_in_matrix",
                "matrixId": matrix_id,
                "matrixWidth": width,
                "matrixHeight": height,
            }

        selected_mode = "unknown"
        if x is not None and y is not None:
            cell_x = int(x) // GRID_WIDTH
            cell_y = int(y) // GRID_HEIGHT
            if 0 <= cell_x < width and 0 <= cell_y < height:
                idx = cell_y * width + cell_x
                if int(headers[idx]) == map_num:
                    selected_mode = "matrix_global_position"
                elif len(cells) == 1 and 0 <= int(x) < GRID_WIDTH and 0 <= int(y) < GRID_HEIGHT:
                    selected_mode = "single_cell_local_position"
                else:
                    return {
                        "map_id": map_key,
                        "source": "heartgold_rom_map_matrix",
                        "confidence": "validation_failed",
                        "validationFailure": f"position_cell_header_mismatch:{headers[idx]}",
                        "matrixId": matrix_id,
                        "matrixCellX": cell_x,
                        "matrixCellY": cell_y,
                    }
            elif len(cells) == 1 and 0 <= int(x) < GRID_WIDTH and 0 <= int(y) < GRID_HEIGHT:
                selected_mode = "single_cell_local_position"
            else:
                return {
                    "map_id": map_key,
                    "source": "heartgold_rom_map_matrix",
                    "confidence": "validation_failed",
                    "validationFailure": "position_outside_matrix_and_not_single_cell_local",
                    "matrixId": matrix_id,
                    "matrixWidth": width,
                    "matrixHeight": height,
                }
        elif len(cells) == 1:
            selected_mode = "single_cell_without_position"
        else:
            return {
                "map_id": map_key,
                "source": "heartgold_rom_map_matrix",
                "confidence": "candidate_requires_position_validation",
                "validationFailure": "multi_cell_map_requires_live_position",
                "matrixId": matrix_id,
                "matchingCells": cells,
            }

        min_cell_x = min(cell["cellX"] for cell in cells)
        min_cell_y = min(cell["cellY"] for cell in cells)
        max_cell_x = max(cell["cellX"] for cell in cells)
        max_cell_y = max(cell["cellY"] for cell in cells)
        composite_width = (max_cell_x - min_cell_x + 1) * GRID_WIDTH
        composite_height = (max_cell_y - min_cell_y + 1) * GRID_HEIGHT
        composite = [[MINIMAP_CODE_WALL for _ in range(composite_width)] for _ in range(composite_height)]
        land_grids = self.load_land_grids().get("grids", {})
        blocked_count = 0
        free_count = 0
        for cell in cells:
            land = land_grids.get(str(cell["model"]))
            land_grid = land.get("grid") if isinstance(land, dict) else None
            if not isinstance(land_grid, list) or len(land_grid) != GRID_HEIGHT:
                continue
            base_x = (cell["cellX"] - min_cell_x) * GRID_WIDTH
            base_y = (cell["cellY"] - min_cell_y) * GRID_HEIGHT
            for yy, row in enumerate(land_grid):
                if not isinstance(row, list):
                    continue
                for xx, value in enumerate(row[:GRID_WIDTH]):
                    tile = int(value)
                    composite[base_y + yy][base_x + xx] = tile
                    if tile == MINIMAP_CODE_WALL:
                        blocked_count += 1
                    else:
                        free_count += 1

        origin_x = min_cell_x * GRID_WIDTH if selected_mode == "matrix_global_position" else 0
        origin_y = min_cell_y * GRID_HEIGHT if selected_mode == "matrix_global_position" else 0
        events = self.events_for_map_id(map_key, origin_x=origin_x, origin_y=origin_y)
        if isinstance(events, dict):
            raw_warps = events.get("warps") if isinstance(events.get("warps"), list) else []
            for warp in raw_warps:
                local_x = int(warp.get("localX") or 0)
                local_y = int(warp.get("localY") or 0)
                if 0 <= local_y < composite_height and 0 <= local_x < composite_width:
                    composite[local_y][local_x] = MINIMAP_CODE_WARP
            raw_bgs = events.get("bgEvents") if isinstance(events.get("bgEvents"), list) else []
            for bg in raw_bgs:
                # BG_EVENT type 2 is a hidden-item check in pret's fieldmap.c.
                # Hidden items are not present-tense visible map affordances, so
                # do not promote them into interactive tiles.
                if int(bg.get("type") or 0) == 2:
                    continue
                local_x = int(bg.get("localX") or 0)
                local_y = int(bg.get("localY") or 0)
                if 0 <= local_y < composite_height and 0 <= local_x < composite_width:
                    composite[local_y][local_x] = MINIMAP_CODE_INTERACTIVE
        blocked_count = sum(1 for row in composite for cell in row if cell == MINIMAP_CODE_WALL)
        free_count = sum(1 for row in composite for cell in row if cell == MINIMAP_CODE_FREE_GROUND)
        warp_count = sum(1 for row in composite for cell in row if cell == MINIMAP_CODE_WARP)

        return {
            "map_id": map_key,
            "source": "heartgold_rom_matrix_land_data",
            "confidence": "rom_derived",
            "grid": composite,
            "width": composite_width,
            "height": composite_height,
            "originX": origin_x,
            "originY": origin_y,
            "coordinateMode": selected_mode,
            "matrixId": int(matrix_id),
            "matrixName": matrix_raw.get("name"),
            "matrixWidth": width,
            "matrixHeight": height,
            "matchingCells": cells,
            "blockedCount": blocked_count,
            "freeCount": free_count,
            "warpCount": warp_count,
            "events": events,
        }

    def metadata(self) -> Dict[str, Any]:
        try:
            data = self.load_land_grids()
            out = dict(data.get("metadata") or {})
            try:
                matrices = self.load_map_matrices()
                out["matrixEntryCount"] = matrices.get("metadata", {}).get("entryCount")
                out["matrixSource"] = MAP_MATRIX_NARC
                zone_events = self.load_zone_events()
                out["zoneEventEntryCount"] = zone_events.get("metadata", {}).get("entryCount")
                out["zoneEventSource"] = ZONE_EVENT_NARC
            except Exception as matrix_error:
                out["matrixError"] = str(matrix_error)
            return out
        except Exception as error:
            return {"available": False, "error": str(error)}
