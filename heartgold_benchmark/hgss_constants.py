from __future__ import annotations

import csv
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import ndspy.narc
except ImportError:  # pragma: no cover - optional ROM tooling dependency.
    ndspy = None  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRET_CONSTANTS = ROOT / ".codex_tmp" / "pret-pokeheartgold" / "include" / "constants"
DEFAULT_PRET_PERSONAL_JSON = ROOT / ".codex_tmp" / "pret-pokeheartgold" / "files" / "poketool" / "personal" / "personal.json"
DEFAULT_PRET_GROWTH_TABLE_CSV = ROOT / ".codex_tmp" / "pret-pokeheartgold" / "files" / "poketool" / "personal" / "growtbl.csv"
DEFAULT_PRET_MOVE_NARC = ROOT / ".codex_tmp" / "pret-pokeheartgold" / "files" / "poketool" / "waza" / "waza_tbl.narc"
DEFAULT_PRET_ITEM_DATA_CSV = ROOT / ".codex_tmp" / "pret-pokeheartgold" / "files" / "itemtool" / "itemdata" / "item_data.csv"
DEFAULT_PRET_ITEM_C = ROOT / ".codex_tmp" / "pret-pokeheartgold" / "src" / "item.c"

DEFINE_RE = re.compile(r"^\s*#define\s+([A-Z0-9_]+)\s+([0-9]+)\b")

FORM_PERSONAL_SPECIES: Dict[int, Dict[int, int]] = {
    386: {1: 496, 2: 497, 3: 498},  # Deoxys: Attack, Defense, Speed
    413: {1: 499, 2: 500},  # Wormadam: Sandy, Trash
    487: {1: 501},  # Giratina: Origin
    492: {1: 502},  # Shaymin: Sky
    479: {1: 503, 2: 504, 3: 505, 4: 506, 5: 507},  # Rotom appliance forms
}


def _display_name(symbol: str) -> str:
    if symbol.startswith("TM") and symbol[2:].isdigit():
        return symbol
    if symbol.startswith("HM") and symbol[2:].isdigit():
        return symbol
    words = symbol.split("_")
    return " ".join(part.capitalize() for part in words if part)


def _read_prefixed_constants(path: Path, prefix: str) -> Dict[int, str]:
    out: Dict[int, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = DEFINE_RE.match(line)
        if not match:
            continue
        name, raw_value = match.groups()
        if not name.startswith(prefix):
            continue
        try:
            value = int(raw_value)
        except ValueError:
            continue
        suffix = name[len(prefix) :]
        if not suffix or suffix in {"NONE", "EGG"}:
            continue
        out.setdefault(value, _display_name(suffix))
    return out


def _read_prefixed_ids(path: Path, prefix: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = DEFINE_RE.match(line)
        if not match:
            continue
        name, raw_value = match.groups()
        if not name.startswith(prefix):
            continue
        try:
            out[name] = int(raw_value)
        except ValueError:
            continue
    return out


def _growth_rate_constant(symbol: object) -> Optional[str]:
    raw = str(symbol or "").strip().upper()
    if not raw:
        return None
    if not raw.startswith("GROWTH_"):
        raw = f"GROWTH_{raw}"
    return raw


@lru_cache(maxsize=1)
def species_names() -> Dict[int, str]:
    names = _read_prefixed_constants(DEFAULT_PRET_CONSTANTS / "species.h", "SPECIES_")
    names.update(
        {
            1: "Bulbasaur",
            4: "Charmander",
            7: "Squirtle",
            25: "Pikachu",
            152: "Chikorita",
            153: "Bayleef",
            154: "Meganium",
            155: "Cyndaquil",
            156: "Quilava",
            157: "Typhlosion",
            158: "Totodile",
            159: "Croconaw",
            160: "Feraligatr",
            161: "Sentret",
        }
    )
    return names


@lru_cache(maxsize=1)
def move_names() -> Dict[int, str]:
    names = _read_prefixed_constants(DEFAULT_PRET_CONSTANTS / "moves.h", "MOVE_")
    names.update({1: "Pound", 33: "Tackle", 39: "Tail Whip", 45: "Growl", 52: "Ember", 55: "Water Gun", 75: "Razor Leaf"})
    return names


@lru_cache(maxsize=1)
def move_base_pp() -> Dict[int, int]:
    pp_by_move: Dict[int, int] = {}
    if ndspy is not None and DEFAULT_PRET_MOVE_NARC.exists():
        try:
            narc = ndspy.narc.NARC(DEFAULT_PRET_MOVE_NARC.read_bytes())
            for move_id, entry in enumerate(narc.files):
                if len(entry) >= 7:
                    pp_by_move[move_id] = int(entry[6])
        except Exception:
            pp_by_move = {}
    pp_by_move.update({1: 35, 33: 35, 39: 30, 45: 40, 52: 25, 55: 25, 75: 25})
    return pp_by_move


def move_max_pp(move_id: int, pp_ups: int = 3) -> Optional[int]:
    base_pp = move_base_pp().get(int(move_id or 0))
    if base_pp is None or base_pp <= 0:
        return None
    safe_pp_ups = max(0, min(3, int(pp_ups or 0)))
    return int(base_pp + ((base_pp * 20 * safe_pp_ups) // 100))


@lru_cache(maxsize=1)
def item_names() -> Dict[int, str]:
    names = _read_prefixed_constants(DEFAULT_PRET_CONSTANTS / "items.h", "ITEM_")
    names.update({1: "Master Ball", 4: "Poke Ball", 17: "Potion"})
    return names


@lru_cache(maxsize=1)
def item_data_indices_by_item_id() -> Dict[int, int]:
    item_ids = _read_prefixed_ids(DEFAULT_PRET_CONSTANTS / "items.h", "ITEM_")
    indices: Dict[int, int] = {}
    if not DEFAULT_PRET_ITEM_C.exists():
        return indices
    entry_re = re.compile(
        r"\[\s*(ITEM_[A-Z0-9_]+)\s*\]\s*=\s*\{\s*NARC_item_data_([0-9]{4})_bin",
        re.IGNORECASE,
    )
    for match in entry_re.finditer(DEFAULT_PRET_ITEM_C.read_text(encoding="utf-8")):
        item_constant = match.group(1)
        item_id = item_ids.get(item_constant)
        if item_id is None:
            continue
        indices[item_id] = int(match.group(2), 10)
    return indices


@lru_cache(maxsize=1)
def item_data_rows_by_index() -> Dict[int, Dict[str, str]]:
    rows: Dict[int, Dict[str, str]] = {}
    if DEFAULT_PRET_ITEM_DATA_CSV.exists():
        with DEFAULT_PRET_ITEM_DATA_CSV.open(newline="", encoding="utf-8") as handle:
            for index, row in enumerate(csv.DictReader(handle)):
                rows[index] = dict(row)
    return rows


@lru_cache(maxsize=1)
def item_field_pockets() -> Dict[int, str]:
    item_ids = _read_prefixed_ids(DEFAULT_PRET_CONSTANTS / "items.h", "ITEM_")
    pockets: Dict[int, str] = {}
    rows_by_index = item_data_rows_by_index()
    for index, row in rows_by_index.items():
        item_id = item_ids.get(str(row.get("item") or ""))
        field_pocket = str(row.get("fieldPocket") or "")
        if item_id is not None and field_pocket.startswith("POCKET_"):
            pockets[item_id] = field_pocket
    for item_id, data_index in item_data_indices_by_item_id().items():
        row = rows_by_index.get(data_index)
        field_pocket = str((row or {}).get("fieldPocket") or "")
        if field_pocket.startswith("POCKET_"):
            pockets.setdefault(item_id, field_pocket)
    pockets.update(
        {
            1: "POCKET_BALLS",
            4: "POCKET_BALLS",
            17: "POCKET_MEDICINE",
            328: "POCKET_TMHMS",
            420: "POCKET_TMHMS",
            445: "POCKET_KEY_ITEMS",
            450: "POCKET_KEY_ITEMS",
            468: "POCKET_KEY_ITEMS",
            485: "POCKET_ITEMS",
            486: "POCKET_ITEMS",
            487: "POCKET_ITEMS",
            488: "POCKET_ITEMS",
            489: "POCKET_ITEMS",
            490: "POCKET_ITEMS",
            491: "POCKET_ITEMS",
        }
    )
    return pockets


@lru_cache(maxsize=1)
def item_selectability() -> Dict[int, bool]:
    item_ids = _read_prefixed_ids(DEFAULT_PRET_CONSTANTS / "items.h", "ITEM_")
    selectable: Dict[int, bool] = {}
    rows_by_index = item_data_rows_by_index()
    for index, row in rows_by_index.items():
        item_id = item_ids.get(str(row.get("item") or ""))
        if item_id is not None:
            selectable[item_id] = str(row.get("selectable") or "").lower() == "true"
    for item_id, data_index in item_data_indices_by_item_id().items():
        row = rows_by_index.get(data_index)
        if row is not None:
            selectable.setdefault(item_id, str(row.get("selectable") or "").lower() == "true")
    selectable.update({445: True, 450: True, 468: True})
    return selectable


@lru_cache(maxsize=1)
def growth_rate_ids() -> Dict[str, int]:
    ids = _read_prefixed_ids(DEFAULT_PRET_CONSTANTS / "pokemon.h", "GROWTH_")
    ids.update(
        {
            "GROWTH_MEDIUM_FAST": 0,
            "GROWTH_ERRATIC": 1,
            "GROWTH_FLUCTUATING": 2,
            "GROWTH_MEDIUM_SLOW": 3,
            "GROWTH_FAST": 4,
            "GROWTH_SLOW": 5,
            "GROWTH_UNUSED_6": 6,
            "GROWTH_UNUSED_7": 7,
        }
    )
    return ids


def growth_rate_id_from_symbol(symbol: object) -> Optional[int]:
    constant = _growth_rate_constant(symbol)
    if constant is None:
        return None
    return growth_rate_ids().get(constant)


@lru_cache(maxsize=1)
def growth_exp_tables() -> Dict[int, List[int]]:
    tables: Dict[int, List[int]] = {}
    if DEFAULT_PRET_GROWTH_TABLE_CSV.exists():
        with DEFAULT_PRET_GROWTH_TABLE_CSV.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                rate_id = growth_rate_id_from_symbol(row.get("rate"))
                if rate_id is None:
                    continue
                levels: List[int] = []
                for level in range(0, 101):
                    raw_value = row.get(f"lv{level:03d}")
                    if raw_value is None:
                        levels = []
                        break
                    try:
                        levels.append(int(raw_value))
                    except ValueError:
                        levels = []
                        break
                if len(levels) == 101:
                    tables[rate_id] = levels
    if not tables:
        tables = _fallback_growth_exp_tables()
    return tables


def _fallback_growth_exp_tables() -> Dict[int, List[int]]:
    # Formula fallback mirrors the canonical Pokemon growth curves; the pret
    # growtbl.csv path above is the preferred source for HGSS validation.
    def exp_for(rate_id: int, level: int) -> int:
        n = level
        if rate_id == 0:  # Medium Fast
            return n**3
        if rate_id == 3:  # Medium Slow
            return max(0, (6 * n**3) // 5 - 15 * n**2 + 100 * n - 140)
        if rate_id == 4:  # Fast
            return (4 * n**3) // 5
        if rate_id == 5:  # Slow
            return (5 * n**3) // 4
        if rate_id == 1:  # Erratic
            if n <= 50:
                return (n**3 * (100 - n)) // 50
            if n <= 68:
                return (n**3 * (150 - n)) // 100
            if n <= 98:
                return (n**3 * ((1911 - 10 * n) // 3)) // 500
            return (n**3 * (160 - n)) // 100
        if rate_id == 2:  # Fluctuating
            if n <= 15:
                return (n**3 * (((n + 1) // 3) + 24)) // 50
            if n <= 36:
                return (n**3 * (n + 14)) // 50
            return (n**3 * ((n // 2) + 32)) // 50
        return n**3

    return {rate_id: [exp_for(rate_id, level) for level in range(0, 101)] for rate_id in range(0, 8)}


@lru_cache(maxsize=1)
def ability_names() -> Dict[int, str]:
    names = _read_prefixed_constants(DEFAULT_PRET_CONSTANTS / "abilities.h", "ABILITY_")
    names.update({0: "None", 34: "Chlorophyll", 65: "Overgrow", 66: "Blaze", 67: "Torrent"})
    return names


@lru_cache(maxsize=1)
def type_names() -> Dict[int, str]:
    names = _read_prefixed_constants(DEFAULT_PRET_CONSTANTS / "pokemon.h", "TYPE_")
    names.update(
        {
            0: "Normal",
            1: "Fighting",
            2: "Flying",
            3: "Poison",
            4: "Ground",
            5: "Rock",
            6: "Bug",
            7: "Ghost",
            8: "Steel",
            9: "Mystery",
            10: "Fire",
            11: "Water",
            12: "Grass",
            13: "Electric",
            14: "Psychic",
            15: "Ice",
            16: "Dragon",
            17: "Dark",
            255: "None",
        }
    )
    return names


@lru_cache(maxsize=1)
def type_symbol_ids() -> Dict[str, int]:
    ids = _read_prefixed_ids(DEFAULT_PRET_CONSTANTS / "pokemon.h", "TYPE_")
    ids.update(
        {
            "TYPE_NORMAL": 0,
            "TYPE_FIGHTING": 1,
            "TYPE_FLYING": 2,
            "TYPE_POISON": 3,
            "TYPE_GROUND": 4,
            "TYPE_ROCK": 5,
            "TYPE_BUG": 6,
            "TYPE_GHOST": 7,
            "TYPE_STEEL": 8,
            "TYPE_MYSTERY": 9,
            "TYPE_FIRE": 10,
            "TYPE_WATER": 11,
            "TYPE_GRASS": 12,
            "TYPE_ELECTRIC": 13,
            "TYPE_PSYCHIC": 14,
            "TYPE_ICE": 15,
            "TYPE_DRAGON": 16,
            "TYPE_DARK": 17,
            "TYPE_NONE": 255,
        }
    )
    return ids


@lru_cache(maxsize=1)
def ability_symbol_ids() -> Dict[str, int]:
    ids = _read_prefixed_ids(DEFAULT_PRET_CONSTANTS / "abilities.h", "ABILITY_")
    ids.update(
        {
            "ABILITY_NONE": 0,
            "ABILITY_CHLOROPHYLL": 34,
            "ABILITY_OVERGROW": 65,
            "ABILITY_BLAZE": 66,
            "ABILITY_TORRENT": 67,
        }
    )
    return ids


@lru_cache(maxsize=1)
def personal_data() -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {}
    if DEFAULT_PRET_PERSONAL_JSON.exists():
        raw = json.loads(DEFAULT_PRET_PERSONAL_JSON.read_text(encoding="utf-8"))
        base_stats = raw.get("baseStats", []) if isinstance(raw, dict) else []
        for species_id, entry in enumerate(base_stats):
            if isinstance(entry, dict):
                out[species_id] = entry
    out.setdefault(
        152,
        {"species": "CHIKORITA", "types": ["TYPE_GRASS", "TYPE_GRASS"], "abilities": ["ABILITY_OVERGROW", "ABILITY_NONE"]},
    )
    out.setdefault(
        155,
        {"species": "CYNDAQUIL", "types": ["TYPE_FIRE", "TYPE_FIRE"], "abilities": ["ABILITY_BLAZE", "ABILITY_NONE"]},
    )
    out.setdefault(
        158,
        {"species": "TOTODILE", "types": ["TYPE_WATER", "TYPE_WATER"], "abilities": ["ABILITY_TORRENT", "ABILITY_NONE"]},
    )
    return out


def species_personal_data(species_id: int, form_id: int = 0) -> Dict[str, Any]:
    base_species_id = int(species_id or 0)
    safe_form_id = int(form_id or 0)
    personal_species_id = FORM_PERSONAL_SPECIES.get(base_species_id, {}).get(safe_form_id, base_species_id)
    entry = personal_data().get(personal_species_id, {})
    growth_rate = str(entry.get("growthRate") or "")
    growth_rate_id = growth_rate_id_from_symbol(growth_rate)
    types: List[int] = []
    for symbol in entry.get("types", []) if isinstance(entry.get("types"), list) else []:
        type_id = type_symbol_ids().get(str(symbol))
        if type_id is not None:
            types.append(type_id)
    abilities: List[int] = []
    for symbol in entry.get("abilities", []) if isinstance(entry.get("abilities"), list) else []:
        ability_id = ability_symbol_ids().get(str(symbol))
        if ability_id is not None:
            abilities.append(ability_id)
    return {
        "source": "pret_pokeheartgold_personal_json",
        "species": entry.get("species"),
        "species_id": base_species_id,
        "personal_species_id": personal_species_id,
        "form_id": safe_form_id,
        "form_personal_data": personal_species_id != base_species_id,
        "growth_rate": growth_rate or None,
        "growth_rate_id": growth_rate_id,
        "base_stats": {
            "hp": int(entry.get("hp") or 0),
            "attack": int(entry.get("atk") or 0),
            "defense": int(entry.get("def") or 0),
            "speed": int(entry.get("speed") or 0),
            "special_attack": int(entry.get("spatk") or 0),
            "special_defense": int(entry.get("spdef") or 0),
        },
        "type_ids": types[:2],
        "ability_ids": abilities[:2],
    }


def species_exp_bounds_for_level(species_id: int, form_id: int, level: int) -> Optional[Dict[str, Any]]:
    safe_level = int(level or 0)
    if safe_level < 1 or safe_level > 100:
        return None
    personal = species_personal_data(species_id, form_id)
    growth_rate_id = personal.get("growth_rate_id")
    if growth_rate_id is None:
        return None
    table = growth_exp_tables().get(int(growth_rate_id))
    if table is None or len(table) < 101:
        return None
    minimum = int(table[safe_level])
    maximum_exclusive = None if safe_level >= 100 else int(table[safe_level + 1])
    return {
        "growth_rate": personal.get("growth_rate"),
        "growth_rate_id": int(growth_rate_id),
        "level": safe_level,
        "min_exp": minimum,
        "max_exp_exclusive": maximum_exclusive,
        "max_exp": int(table[100]),
    }


def species_level_for_exp(species_id: int, form_id: int, exp: int) -> Optional[Dict[str, Any]]:
    safe_exp = int(exp)
    if safe_exp < 0:
        return None
    personal = species_personal_data(species_id, form_id)
    growth_rate_id = personal.get("growth_rate_id")
    if growth_rate_id is None:
        return None
    table = growth_exp_tables().get(int(growth_rate_id))
    if table is None or len(table) < 101 or safe_exp > int(table[100]):
        return None
    level = 1
    for candidate_level in range(1, 101):
        if safe_exp >= int(table[candidate_level]):
            level = candidate_level
        else:
            break
    max_exp_exclusive = None if level >= 100 else int(table[level + 1])
    return {
        "growth_rate": personal.get("growth_rate"),
        "growth_rate_id": int(growth_rate_id),
        "level": level,
        "exp": safe_exp,
        "min_exp": int(table[level]),
        "max_exp_exclusive": max_exp_exclusive,
        "max_exp": int(table[100]),
    }


def is_valid_form_id(species_id: int, form_id: int) -> bool:
    safe_species_id = int(species_id or 0)
    safe_form_id = int(form_id or 0)
    if safe_form_id == 0:
        return True
    return safe_form_id in FORM_PERSONAL_SPECIES.get(safe_species_id, {})


def legal_personal_type_ids(species_id: int, form_id: int = 0) -> List[int]:
    personal = species_personal_data(species_id, form_id)
    return [int(type_id) for type_id in personal.get("type_ids", []) if int(type_id) != 255]


def legal_personal_ability_ids(species_id: int, form_id: int = 0) -> List[int]:
    personal = species_personal_data(species_id, form_id)
    return [int(ability_id) for ability_id in personal.get("ability_ids", []) if int(ability_id) > 0]


def species_name(species_id: int, fallback: object = None) -> str:
    if species_id in species_names():
        return species_names()[species_id]
    if fallback and not str(fallback).startswith("Species "):
        return str(fallback)
    return f"Species {species_id}" if species_id > 0 else "Unknown"


def move_name(move_id: int) -> str:
    return move_names().get(move_id, f"Move {move_id}" if move_id > 0 else "None")


def item_name(item_id: int) -> str:
    return item_names().get(item_id, f"Item {item_id}" if item_id > 0 else "None")


def item_field_pocket(item_id: int) -> Optional[str]:
    return item_field_pockets().get(int(item_id or 0))


def item_allowed_in_bag_pocket(item_id: int, pocket_name: str) -> bool:
    pocket_to_field = {
        "item_pocket": "POCKET_ITEMS",
        "medicine_pocket": "POCKET_MEDICINE",
        "ball_pocket": "POCKET_BALLS",
        "tm_case": "POCKET_TMHMS",
        "berries_pocket": "POCKET_BERRIES",
        "mail_pocket": "POCKET_MAIL",
        "battle_items_pocket": "POCKET_BATTLE_ITEMS",
        "key_item_pocket": "POCKET_KEY_ITEMS",
    }
    expected = pocket_to_field.get(str(pocket_name or ""))
    actual = item_field_pocket(item_id)
    return expected is not None and actual == expected


def item_registerable(item_id: int) -> bool:
    safe_item_id = int(item_id or 0)
    return item_field_pocket(safe_item_id) == "POCKET_KEY_ITEMS" and item_selectability().get(safe_item_id) is True


def ability_name(ability_id: int) -> str:
    return ability_names().get(ability_id, f"Ability {ability_id}" if ability_id > 0 else "None")


def type_name(type_id: int) -> str:
    return type_names().get(type_id, f"Type {type_id}" if type_id >= 0 else "Unknown")


def is_known_move_id(move_id: int) -> bool:
    return int(move_id or 0) in move_names()


def is_known_item_id(item_id: int) -> bool:
    return int(item_id or 0) in item_names()


def is_known_ability_id(ability_id: int) -> bool:
    return int(ability_id or 0) in ability_names()


def is_known_type_id(type_id: int) -> bool:
    return int(type_id or 0) in type_names()
