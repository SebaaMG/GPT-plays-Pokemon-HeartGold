from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

try:
    from heartgold_benchmark.minimap import HeartGoldMinimapStore
    from heartgold_benchmark.rom_data import HeartGoldRomData
    from heartgold_benchmark.hgss_text import HgssTextArchive
    from heartgold_benchmark.hgss_map_constants import HGSS_MAP_CONSTANTS
    from heartgold_benchmark.hgss_constants import (
        ability_name,
        item_allowed_in_bag_pocket,
        item_field_pocket,
        is_known_item_id,
        is_known_move_id,
        is_known_type_id,
        is_valid_form_id,
        item_registerable,
        item_name,
        legal_personal_ability_ids,
        legal_personal_type_ids,
        move_max_pp,
        move_name,
        species_exp_bounds_for_level,
        species_level_for_exp,
        species_personal_data,
        species_name as hgss_species_name,
        type_name,
    )
except ModuleNotFoundError:
    from minimap import HeartGoldMinimapStore
    from rom_data import HeartGoldRomData
    from hgss_text import HgssTextArchive
    from hgss_map_constants import HGSS_MAP_CONSTANTS
    from hgss_constants import ability_name, item_allowed_in_bag_pocket, item_field_pocket, is_known_item_id, is_known_move_id, is_known_type_id, is_valid_form_id, item_registerable, item_name, legal_personal_ability_ids, legal_personal_type_ids, move_max_pp, move_name, species_exp_bounds_for_level, species_level_for_exp, species_personal_data, species_name as hgss_species_name, type_name

try:
    from PIL import Image
except ImportError:  # pragma: no cover - bootstrap still has a non-visual fallback.
    Image = None


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BIZHAWK_EXE = ROOT / ".codex_tmp" / "BizHawk-2.11" / "EmuHawk.exe"
DEFAULT_ROM = ROOT / ".codex_tmp" / "Pokemon - HeartGold Version (USA).nds"
DEFAULT_RUNTIME = ROOT / ".heartgold_runtime"
BRIDGE_PROTOCOL_VERSION = 2
BRIDGE_FEATURE_VERSION = 5

BADGE_FLAGS = {
    "ZEPHYR": False,
    "HIVE": False,
    "PLAIN": False,
    "FOG": False,
    "STORM": False,
    "MINERAL": False,
    "GLACIER": False,
    "RISING": False,
    "BOULDER": False,
    "CASCADE": False,
    "THUNDER": False,
    "RAINBOW": False,
    "SOUL": False,
    "MARSH": False,
    "VOLCANO": False,
    "EARTH": False,
}

BUTTON_ALIASES = {
    "face_up": "up",
    "face_down": "down",
    "face_left": "left",
    "face_right": "right",
}

DIRECTION_DELTAS = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}

FIELD_MOVE_AFFORDANCE_CONTRACT = "rom_derived_current_facing_field_move_affordances_v1"
FIELD_MOVE_AFFORDANCE_BY_STATIC_TILE = {
    3: {"move": "surf", "target": "water"},
    4: {"move": "waterfall", "target": "waterfall"},
    35: {"move": "cut", "target": "cuttable_tree"},
    36: {"move": "rock_smash", "target": "breakable_rock"},
    56: {"move": "whirlpool", "target": "whirlpool"},
    57: {"move": "headbutt", "target": "headbutt_tree"},
}
FIELD_MOVE_AFFORDANCE_BY_RUNTIME_OBJECT_LABEL = {
    "rock": {"move": "strength", "target": "boulder"},
    "breakrock": {"move": "rock_smash", "target": "breakable_rock"},
    "tree": {"move": "cut", "target": "cuttable_tree"},
}

ORIENTATION_BY_FACING = {
    "down": 100,
    "up": 101,
    "left": 102,
    "right": 103,
}

HGSS_MAP_OVERRIDES = {
    "60": {"name": "New Bark Town", "code": "MAP_T20"},
    "61": {"name": "New Bark Elm's Lab 1F", "code": "MAP_T20R0101"},
    "62": {"name": "New Bark Elm's Lab 2F", "code": "MAP_T20R0102"},
    "63": {"name": "New Bark Player House 1F", "code": "MAP_T20R0201"},
    "64": {"name": "New Bark Player House 2F", "code": "MAP_T20R0202"},
    "65": {"name": "New Bark Southwest House", "code": "MAP_T20R0301"},
    "66": {"name": "New Bark Rival House 1F", "code": "MAP_T20R0401"},
    "67": {"name": "Cherrygrove City", "code": "MAP_T21"},
    "68": {"name": "Cherrygrove Pokemart", "code": "MAP_T21FS0101"},
    "69": {"name": "Cherrygrove Pokecenter 1F", "code": "MAP_T21PC0101"},
    "70": {"name": "Cherrygrove Southwest House", "code": "MAP_T21R0301"},
    "71": {"name": "Cherrygrove Guide Gent House", "code": "MAP_T21R0401"},
    "72": {"name": "Cherrygrove Southeast House", "code": "MAP_T21R0501"},
}
RUNTIME_FIELD_LOCATION_SOURCE = "FieldSystem.location"
CURRENT_POSITION_CONTRACT = "ram_fieldsystem_location_localmapobject_position_current_v1"
CURRENT_FACING_CONTRACT = "ram_localmapobject_current_facing_verified"

INVENTORY_POCKETS = [
    "item_pocket",
    "key_item_pocket",
    "ball_pocket",
    "tm_case",
    "berries_pocket",
    "medicine_pocket",
    "battle_items_pocket",
    "mail_pocket",
]

OBSERVATION_MODE_ALIASES = {
    "standard": "ram_assisted",
    "standard_assisted": "ram_assisted",
    "assisted": "ram_assisted",
}
OBSERVATION_MODES = {"visual", "ram_assisted", "oracle_debug", "harness_validation"}

def env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    if not value:
        return default
    path = Path(value)
    if path.is_absolute():
        return path
    return (ROOT / path).resolve()


def env_speed_mode() -> str:
    allow_fast_forward = os.environ.get("HEARTGOLD_ALLOW_FAST_FORWARD", "false").strip().lower() in {"1", "true", "yes"}
    if not allow_fast_forward:
        return "100"
    value = os.environ.get("HEARTGOLD_SPEED_MODE", "100").strip().lower()
    if value in {"", "normal"}:
        return "100"
    try:
        parsed = int(value)
    except ValueError:
        return "100"
    return str(max(1, min(parsed, 6400)))


def env_observation_mode() -> str:
    value = os.environ.get("HEARTGOLD_OBSERVATION_MODE", "ram_assisted").strip().lower()
    value = OBSERVATION_MODE_ALIASES.get(value, value)
    return value if value in OBSERVATION_MODES else "ram_assisted"


def env_action_settle_frames() -> int:
    value = os.environ.get("HEARTGOLD_ACTION_SETTLE_FRAMES", "24").strip()
    try:
        parsed = int(value)
    except ValueError:
        parsed = 24
    return max(0, min(parsed, 180))


def env_low_stall_actions() -> bool:
    return os.environ.get("HEARTGOLD_LOW_STALL_ACTIONS", "false").strip().lower() in {"1", "true", "yes", "on"}


def env_lua_interval(name: str, default: int, maximum: int) -> int:
    value = os.environ.get(name, str(default)).strip()
    try:
        parsed = int(value)
    except ValueError:
        parsed = default
    return max(1, min(parsed, maximum))


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def map_metadata(map_id: str) -> Dict[str, Any]:
    map_key = str(map_id)
    meta = HGSS_MAP_OVERRIDES.get(map_key)
    if not meta:
        meta = HGSS_MAP_CONSTANTS.get(map_key)
    if not meta:
        if map_key == "unknown":
            return {
                "id": map_key,
                "name": "Unknown",
                "nameSource": "unknown",
                "identityConfidence": "unknown",
            }
        return {
            "id": map_key,
            "name": f"Unknown HGSS map id {map_key} (unverified)",
            "nameSource": "generic_fallback",
            "identityConfidence": "unknown",
        }
    display_name = str(meta.get("name") or f"HGSS Map {map_key}")
    code = meta.get("code")
    diagnostic_name = display_name if not code else f"{display_name} ({code})"
    return {
        **meta,
        "id": map_key,
        "name": display_name,
        "displayName": display_name,
        "diagnosticName": diagnostic_name,
        "nameSource": meta.get("nameSource", "pret_pokeheartgold_constants"),
        "identityConfidence": meta.get("identityConfidence", "known_constant"),
    }


def current_map_id_from_field_location(field_location: Dict[str, Any]) -> tuple[Optional[Any], str, str]:
    """Return current semantic map id evidence from the runtime FieldSystem.

    pret/pokeheartgold defines FieldSystem.location as the active Location used
    by field scripts, map loading, encounters, and warps. That is the runtime
    current map source that can be paired with LocalMapObject x/z coordinates.
    Save-like roamer helper offsets remain diagnostics until separately proven.
    """

    if not isinstance(field_location, dict) or not bool(field_location.get("reasonable")):
        return None, "unknown", "field_system_location_missing_or_unreasonable"
    source = str(field_location.get("source") or "unknown")
    if source != RUNTIME_FIELD_LOCATION_SOURCE:
        return None, source, "field_system_location_source_unrecognized"
    map_id = field_location.get("map_id")
    if map_id is None:
        return None, source, "field_system_location_map_id_missing"
    meta = map_metadata(str(map_id))
    if meta.get("identityConfidence") not in {"known_constant", "verified_current"}:
        return None, source, "field_system_location_map_id_not_known_constant"
    return map_id, source, "field_system_location_current_map_id_evidence"


def current_map_id_from_save_position(save_position: Dict[str, Any]) -> tuple[Optional[Any], str, str]:
    """Return diagnostic save-position map evidence.

    The LocalMapObject carries current coordinates/facing, but its `mapId` field
    is often a local object map id. The save-position block can be useful for
    harness diagnostics, but it is not current enough to verify same-map
    navigation when runtime FieldSystem.location is not readable.
    """
    if not isinstance(save_position, dict) or not save_position:
        return None, "unknown", "save_position_missing"
    source = str(save_position.get("source") or "unknown")
    if "save block" not in source.lower():
        return None, source, "save_position_source_unrecognized"
    if save_position.get("reasonable") is False:
        return None, source, "save_position_unreasonable"
    map_id = save_position.get("map_id")
    if map_id is None:
        return None, source, "save_position_map_id_missing"
    meta = map_metadata(str(map_id))
    if meta.get("identityConfidence") not in {"known_constant", "verified_current"}:
        return None, source, "save_position_map_id_not_known_constant"
    return map_id, source, "save_position_current_map_id_fallback"


HGSS_RENDER_CONTROL_RE = re.compile(r"\{CTRL_[^}]*\}")
PLACEHOLDER_SCREENSHOT_HASHES = {
    "",
    "missing",
    "none",
    "null",
    "unknown",
    "placeholder",
    "stale_or_missing",
    "hash",
    "screenhash",
    "abcdef",
    "def456",
}


def sanitize_current_visible_text(text: Any) -> str:
    value = str(text or "")
    value = HGSS_RENDER_CONTROL_RE.sub("", value)
    value = value.replace("\r", " ").replace("\n", " ")
    return " ".join(value.split()).strip()


def normalized_screenshot_hash(value: Any) -> Optional[str]:
    screenshot_hash = str(value or "").strip()
    if len(screenshot_hash) < 10:
        return None
    if screenshot_hash.lower() in PLACEHOLDER_SCREENSHOT_HASHES:
        return None
    return screenshot_hash


def valid_text_context_epoch(value: Any) -> Optional[int]:
    epoch = safe_int(value, -1)
    return epoch if epoch >= 0 else None


BATTLE_CURRENT_VISIBLE_TEXT_DECODER_CONTRACTS = {
    "owner_bound_battle_msgbuffer_textprinter_current_v1",
}

BATTLE_RECENT_VISIBLE_TEXT_DECODER_CONTRACTS = {
    "owner_bound_battle_msgbuffer_textprinter_current_v1",
    "validated_battle_system_msgbuffer_event_v1",
}

BATTLE_COMPLETE_MSG_BUFFER_VISIBILITY_CONTRACT = "owner_bound_battle_textprinter_complete_v1"
FIELD_CURRENT_VISIBLE_TEXT_DECODER_CONTRACT = "owner_bound_script_environment_textprinter_current_visible_v1"
CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT = "owner_bound_current_ui_state_visible_text_v1"
OAK_SPEECH_CURRENT_UI_SOURCE = "OakSpeechData.current_overlay_app_state"
STARTER_CHOICE_CURRENT_UI_SOURCE = "ChooseStarterAppWork.current_overlay_app_state"
STARTER_CHOICE_CURRENT_UI_VALIDATION = "choose_starter_appwork_state_windows_msgdata_validated"
CURRENT_UI_OWNER_BOUND_SOURCES = {
    OAK_SPEECH_CURRENT_UI_SOURCE,
    STARTER_CHOICE_CURRENT_UI_SOURCE,
}
_HGSS_TEXT_ARCHIVE: Optional[HgssTextArchive] = None
_SPRITE_ROLE_NAME_BY_ID: Optional[Dict[int, str]] = None
_SPRITE_ROLE_ALIASES = {
    "monstarball": "poke_ball",
    "monsterball": "poke_ball",
    "signball": "sign_ball",
}


def hgss_text_archive() -> Optional[HgssTextArchive]:
    global _HGSS_TEXT_ARCHIVE
    if _HGSS_TEXT_ARCHIVE is not None:
        return _HGSS_TEXT_ARCHIVE
    archive = HgssTextArchive(DEFAULT_ROM, ROOT / ".codex_tmp" / "pokeheartgold" / "charmap.txt")
    if not archive.available():
        return None
    _HGSS_TEXT_ARCHIVE = archive
    return archive


def decode_current_ui_message(bank: Any, message_id: Any) -> str:
    archive = hgss_text_archive()
    if archive is None:
        return ""
    bank_id = safe_int(bank, -1)
    msg_id = safe_int(message_id, -1)
    if bank_id < 0 or msg_id < 0:
        return ""
    try:
        return sanitize_current_visible_text(archive.decode_message(bank_id, msg_id))
    except Exception:
        return ""


def _sprite_role_from_symbol(symbol: str) -> Optional[str]:
    name = str(symbol or "").strip()
    if not name.startswith("SPRITE_"):
        return None
    name = name[len("SPRITE_") :].lower()
    if not name or name.startswith("var_"):
        return None
    name = re.sub(r"\d+$", "", name)
    if name.endswith("m") and not name.endswith("man"):
        name = name[:-1]
    elif name.endswith("w"):
        name = name[:-1]
    role = name.strip("_")
    if not role:
        return None
    return _SPRITE_ROLE_ALIASES.get(role, role.replace("_", " "))


def sprite_role_names_by_id() -> Dict[int, str]:
    global _SPRITE_ROLE_NAME_BY_ID
    if _SPRITE_ROLE_NAME_BY_ID is not None:
        return _SPRITE_ROLE_NAME_BY_ID
    out: Dict[int, str] = {}
    path = ROOT / ".codex_tmp" / "pokeheartgold" / "include" / "constants" / "sprites.h"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        _SPRITE_ROLE_NAME_BY_ID = out
        return out
    for match in re.finditer(r"^\s*#define\s+(SPRITE_[A-Z0-9_]+)\s+(\d+)\b", text, re.MULTILINE):
        role = _sprite_role_from_symbol(match.group(1))
        if role:
            out[int(match.group(2))] = role
    _SPRITE_ROLE_NAME_BY_ID = out
    return out


def sprite_role_name(sprite_id: Any) -> Optional[str]:
    value = safe_int(sprite_id, -1)
    if value < 0:
        return None
    return sprite_role_names_by_id().get(value)


def _player_safe_species_name(species_id: Any) -> Optional[str]:
    value = safe_int(species_id, -1)
    if not 1 <= value <= 493:
        return None
    name = sanitize_current_visible_text(hgss_species_name(value))
    if not name or re.fullmatch(r"Species\s+\d+", name):
        return None
    return name


def _starter_choice_species_ids(current_ui: Dict[str, Any]) -> List[Any]:
    for key in ("starterSpeciesIds", "starter_species_ids", "speciesIds", "species_ids"):
        raw = current_ui.get(key)
        if isinstance(raw, list):
            return raw[:3]
    choices = current_ui.get("choices")
    if isinstance(choices, list):
        out = []
        for choice in choices[:3]:
            if isinstance(choice, dict):
                out.append(choice.get("speciesId", choice.get("species_id")))
            else:
                out.append(choice)
        return out
    return []


def _starter_choice_visible_lines(current_ui: Dict[str, Any]) -> List[str]:
    if current_ui.get("source") != STARTER_CHOICE_CURRENT_UI_SOURCE:
        return []
    if current_ui.get("validation") != STARTER_CHOICE_CURRENT_UI_VALIDATION:
        return []
    species_names = [_player_safe_species_name(species_id) for species_id in _starter_choice_species_ids(current_ui)]
    selected = safe_int(current_ui.get("selectedIndex", current_ui.get("curSelection")), -1)
    lines: List[str] = []
    if 0 <= selected < len(species_names) and species_names[selected]:
        lines.append(f"Current selection: {species_names[selected]}")
    visible_choices = [name for name in species_names if name]
    if visible_choices:
        lines.append(f"Choices: {', '.join(visible_choices)}")
    return lines


def promoted_current_ui_visible_text(current_ui: Any, *, dialog_visible: bool, screenshot_fresh: bool) -> Optional[Dict[str, Any]]:
    if not screenshot_fresh or not isinstance(current_ui, dict):
        return None
    if current_ui.get("active") is not True:
        return None
    if current_ui.get("contract") != CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT:
        return None
    if current_ui.get("source") not in CURRENT_UI_OWNER_BOUND_SOURCES:
        return None
    if (
        current_ui.get("source") == STARTER_CHOICE_CURRENT_UI_SOURCE
        and current_ui.get("validation") != STARTER_CHOICE_CURRENT_UI_VALIDATION
    ):
        return None
    source = current_ui.get("source")
    oak_speech_source = source == OAK_SPEECH_CURRENT_UI_SOURCE
    bank = current_ui.get("messageBank")
    lines: List[str] = []
    for message_id in current_ui.get("messageIds") if isinstance(current_ui.get("messageIds"), list) else []:
        text = decode_current_ui_message(bank, message_id)
        if text and text not in lines:
            lines.append(text)
    option_lines: List[str] = []
    selected = safe_int(current_ui.get("selectedIndex"), -1)
    for idx, message_id in enumerate(current_ui.get("optionMessageIds") if isinstance(current_ui.get("optionMessageIds"), list) else []):
        label = decode_current_ui_message(bank, message_id)
        if label:
            prefix = "" if oak_speech_source else ("> " if idx == selected else "  ")
            option_lines.append(f"{prefix}{label}")
    if option_lines:
        lines.append("\n".join(option_lines))
    lines.extend(_starter_choice_visible_lines(current_ui))
    text = sanitize_current_visible_text("\n\n".join(line for line in lines if line))
    epoch = valid_text_context_epoch(current_ui.get("contextEpoch"))
    if not text or epoch is None:
        return None
    return {
        "active": True,
        "surface": "current_ui",
        "text": text,
        "source": "ram_visible_text",
        "confidence": "validated_current",
        "contract": "current_visible_text_v1",
        "decoderContract": CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT,
        "decoderSource": current_ui.get("source"),
        "stableSamples": 1,
        "contextEpoch": epoch,
    }


def battle_recent_text_decoder_ok(item: Dict[str, Any]) -> bool:
    decoder_contract = item.get("decoderContract")
    return (
        decoder_contract in BATTLE_RECENT_VISIBLE_TEXT_DECODER_CONTRACTS
        and item.get("visibilityContract") == BATTLE_COMPLETE_MSG_BUFFER_VISIBILITY_CONTRACT
    )


def field_visible_text_decoder_ok(item: Dict[str, Any]) -> bool:
    return item.get("decoderContract") == FIELD_CURRENT_VISIBLE_TEXT_DECODER_CONTRACT


def current_visible_text_surfaces(*, in_battle: bool, dialog_visible: bool, screenshot_fresh: bool) -> List[str]:
    if not screenshot_fresh:
        return []
    if in_battle:
        return ["battle"]
    if dialog_visible:
        return ["field_dialogue", "current_ui"]
    return []


def promoted_visible_text(
    text_probe: Dict[str, Any],
    *,
    in_battle: bool,
    dialog_visible: bool,
    screenshot_fresh: bool,
    active_battle: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    if not screenshot_fresh or not isinstance(text_probe, dict):
        return None

    battle_probe = text_probe.get("battle") if isinstance(text_probe.get("battle"), dict) else {}
    battle_string = battle_probe.get("string") if isinstance(battle_probe.get("string"), dict) else {}
    battle_printer = battle_probe.get("printer") if isinstance(battle_probe.get("printer"), dict) else {}
    battle_printer_text = sanitize_current_visible_text(battle_printer.get("visiblePreview"))
    battle_stable = safe_int(battle_probe.get("stableSamples"), 0)
    battle_lock_min = safe_int(battle_probe.get("lockMinSamples"), 3)
    battle_epoch = valid_text_context_epoch(battle_probe.get("contextEpoch"))
    battle_printer_contract = str(battle_printer.get("contract") or "")
    battle_printer_consumed = safe_int(battle_printer.get("consumedWords"), 0)
    battle_string_size = safe_int(battle_string.get("size"), 0)
    active_battle_epoch = (
        valid_text_context_epoch(active_battle.get("textContextEpoch"))
        if isinstance(active_battle, dict)
        else None
    )
    if (
        in_battle
        and battle_probe.get("active") is True
        and battle_probe.get("status") == "locked"
        and battle_stable >= battle_lock_min
        and battle_epoch is not None
        and active_battle_epoch is not None
        and active_battle_epoch == battle_epoch
    ):
        if (
            battle_printer_contract == "owner_bound_battle_msgbuffer_textprinter_current_v1"
            and battle_printer_consumed > 0
            and battle_printer_text
        ):
            result = {
                "active": True,
                "surface": "battle",
                "text": battle_printer_text,
                "source": "ram_visible_text",
                "confidence": "validated_current",
                "contract": "current_visible_text_v1",
                "decoderContract": "owner_bound_battle_msgbuffer_textprinter_current_v1",
                "stableSamples": battle_stable,
                "contextEpoch": battle_epoch,
            }
            if battle_string_size > 0 and battle_printer_consumed >= battle_string_size:
                result["visibilityContract"] = BATTLE_COMPLETE_MSG_BUFFER_VISIBILITY_CONTRACT
            return result
    field_probe = text_probe.get("field") if isinstance(text_probe.get("field"), dict) else {}
    field_printer = field_probe.get("printer") if isinstance(field_probe.get("printer"), dict) else {}
    field_text = sanitize_current_visible_text(field_printer.get("visiblePreview"))
    field_stable = safe_int(field_probe.get("stableSamples"), 0)
    field_lock_min = safe_int(field_probe.get("lockMinSamples"), 3)
    field_epoch = valid_text_context_epoch(field_probe.get("contextEpoch"))
    text_printer_num = safe_int(field_probe.get("textPrinterNum"), 255)
    active_script_context_count = safe_int(field_probe.get("activeScriptContextCount"), 0)
    consumed_words = safe_int(field_printer.get("consumedWords"), 0)
    if (
        (not in_battle)
        and dialog_visible
        and field_probe.get("active") is True
        and field_probe.get("status") == "locked"
        and field_stable >= field_lock_min
        and field_epoch is not None
        and field_probe.get("contract") == FIELD_CURRENT_VISIBLE_TEXT_DECODER_CONTRACT
        and field_printer.get("contract") == FIELD_CURRENT_VISIBLE_TEXT_DECODER_CONTRACT
        and 0 <= text_printer_num < 8
        and active_script_context_count > 0
        and field_printer.get("currentCharRaw") is not None
        and consumed_words > 0
        and field_text
    ):
        return {
            "active": True,
            "surface": "field_dialogue",
            "text": field_text,
            "source": "ram_visible_text",
            "confidence": "validated_current",
            "contract": "current_visible_text_v1",
            "decoderContract": FIELD_CURRENT_VISIBLE_TEXT_DECODER_CONTRACT,
            "decoderSource": field_printer.get("source") or "owner_bound_print_queue_systask",
            "stableSamples": field_stable,
            "contextEpoch": field_epoch,
        }

    current_ui_text = promoted_current_ui_visible_text(
        text_probe.get("current_ui"),
        dialog_visible=dialog_visible and not in_battle,
        screenshot_fresh=screenshot_fresh,
    )
    if current_ui_text:
        return current_ui_text

    return None


def update_visible_text_history(
    history: Any,
    current_visible_text: Optional[Dict[str, Any]],
    *,
    frame: Optional[int],
    screenshot_hash: Optional[str],
    observed_at_ms: Optional[int],
    recent_events: Optional[Any] = None,
    allowed_recent_surfaces: Optional[Any] = None,
    max_entries: int = 6,
    max_age_ms: int = 90_000,
) -> List[Dict[str, Any]]:
    entries = list(history) if isinstance(history, list) else []
    now_ms = observed_at_ms if isinstance(observed_at_ms, int) else int(time.time() * 1000)
    allowed_recent_surface_set = None
    if allowed_recent_surfaces is not None:
        allowed_recent_surface_set = {
            str(surface)
            for surface in allowed_recent_surfaces
            if str(surface or "").strip()
        }

    cleaned: List[Dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        if (
            item.get("active") is not True
            or item.get("source") != "ram_visible_text"
            or item.get("confidence") != "validated_current"
            or item.get("contract") != "current_visible_text_v1_recent_observed"
        ):
            continue
        text = sanitize_current_visible_text(item.get("text"))
        if not text:
            continue
        item_hash = normalized_screenshot_hash(item.get("screenshotHash"))
        if item_hash is None:
            continue
        item_time = safe_int(item.get("observedAtMs"), now_ms)
        if max_age_ms > 0 and now_ms - item_time > max_age_ms:
            continue
        surface = str(item.get("surface") or "unknown")
        if surface == "battle" and not battle_recent_text_decoder_ok(item):
            continue
        if surface == "field_dialogue" and not field_visible_text_decoder_ok(item):
            continue
        if allowed_recent_surface_set is not None and surface not in allowed_recent_surface_set:
            continue
        item_epoch = valid_text_context_epoch(item.get("contextEpoch"))
        if item_epoch is None:
            continue
        cleaned.append(
            {
                "active": True,
                "surface": surface,
                "text": text,
                "source": "ram_visible_text",
                "confidence": "validated_current",
                "contract": "current_visible_text_v1_recent_observed",
                "frame": safe_int(item.get("frame"), frame if isinstance(frame, int) else 0),
                "screenshotHash": item_hash,
                "screenshotHashSource": str(item.get("screenshotHashSource") or "event"),
                "contextEpoch": item_epoch,
                "decoderContract": item.get("decoderContract"),
                "decoderSource": item.get("decoderSource"),
                "visibilityContract": item.get("visibilityContract"),
                "observedAtMs": item_time,
            }
        )

    if isinstance(recent_events, list):
        for event in recent_events:
            if not isinstance(event, dict):
                continue
            text = sanitize_current_visible_text(event.get("text"))
            surface = str(event.get("surface") or "unknown")
            event_hash_direct = normalized_screenshot_hash(event.get("screenshotHash"))
            event_hash = event_hash_direct or normalized_screenshot_hash(screenshot_hash)
            surface_allowed = allowed_recent_surface_set is None or surface in allowed_recent_surface_set
            event_epoch = valid_text_context_epoch(event.get("contextEpoch"))
            field_decoder_ok = (
                surface != "field_dialogue"
                or field_visible_text_decoder_ok(event)
            )
            battle_decoder_ok = (
                surface != "battle"
                or battle_recent_text_decoder_ok(event)
            )
            if (
                event.get("active") is True
                and event.get("source") == "ram_visible_text"
                and event.get("confidence") == "validated_current"
                and event.get("contract") == "current_visible_text_v1_recent_observed"
                and field_decoder_ok
                and battle_decoder_ok
                and surface_allowed
                and event_hash is not None
                and event_epoch is not None
                and text
            ):
                next_entry = {
                    "active": True,
                    "surface": surface,
                    "text": text,
                    "source": "ram_visible_text",
                    "confidence": "validated_current",
                    "contract": "current_visible_text_v1_recent_observed",
                    "frame": safe_int(event.get("frame"), frame if isinstance(frame, int) else 0),
                    "screenshotHash": event_hash,
                    "screenshotHashSource": "event" if event_hash_direct else "current_snapshot_fallback",
                    "contextEpoch": event_epoch,
                    "decoderContract": event.get("decoderContract"),
                    "decoderSource": event.get("decoderSource"),
                    "visibilityContract": event.get("visibilityContract"),
                    "observedAtMs": safe_int(event.get("observedAtMs"), now_ms),
                }
                duplicate_index = next(
                    (
                        idx
                        for idx, existing in enumerate(cleaned)
                        if existing.get("surface") == next_entry["surface"]
                        and existing.get("text") == next_entry["text"]
                        and existing.get("frame") == next_entry["frame"]
                        and existing.get("contextEpoch") == next_entry["contextEpoch"]
                        and (
                            existing.get("screenshotHash") == next_entry["screenshotHash"]
                            or (
                                event_hash_direct is None
                                and existing.get("screenshotHashSource") == "current_snapshot_fallback"
                            )
                        )
                    ),
                    None,
                )
                if duplicate_index is not None:
                    cleaned[duplicate_index] = {**cleaned[duplicate_index], **next_entry}
                    continue
                cleaned.append(next_entry)

    if isinstance(current_visible_text, dict):
        text = sanitize_current_visible_text(current_visible_text.get("text"))
        entry_hash = normalized_screenshot_hash(screenshot_hash)
        entry_epoch = valid_text_context_epoch(current_visible_text.get("contextEpoch"))
        entry_surface = str(current_visible_text.get("surface") or "unknown")
        entry_battle_decoder_ok = (
            entry_surface != "battle"
            or current_visible_text.get("decoderContract") in BATTLE_CURRENT_VISIBLE_TEXT_DECODER_CONTRACTS
        )
        entry_battle_recent_ok = (
            entry_surface != "battle"
            or current_visible_text.get("visibilityContract") == BATTLE_COMPLETE_MSG_BUFFER_VISIBILITY_CONTRACT
        )
        entry_field_decoder_ok = (
            entry_surface != "field_dialogue"
            or field_visible_text_decoder_ok(current_visible_text)
        )
        if (
            current_visible_text.get("active") is True
            and current_visible_text.get("source") == "ram_visible_text"
            and current_visible_text.get("confidence") == "validated_current"
            and current_visible_text.get("contract") == "current_visible_text_v1"
            and entry_battle_decoder_ok
            and entry_battle_recent_ok
            and entry_field_decoder_ok
            and entry_hash is not None
            and entry_epoch is not None
            and text
        ):
            next_entry = {
                "active": True,
                "surface": entry_surface,
                "text": text,
                "source": "ram_visible_text",
                "confidence": "validated_current",
                "contract": "current_visible_text_v1_recent_observed",
                "frame": frame if isinstance(frame, int) else None,
                "screenshotHash": entry_hash,
                "screenshotHashSource": "current_snapshot",
                "contextEpoch": entry_epoch,
                "decoderContract": current_visible_text.get("decoderContract"),
                "decoderSource": current_visible_text.get("decoderSource"),
                "visibilityContract": current_visible_text.get("visibilityContract"),
                "observedAtMs": now_ms,
            }
            cleaned.append(next_entry)

    max_entries = max(1, min(12, safe_int(max_entries, 6)))
    return cleaned[-max_entries:]


def save_array_header_validated(
    header: Any,
    *,
    expected_id: Optional[int] = None,
    expected_size: Optional[int] = None,
    expected_block_id: Optional[int] = None,
) -> bool:
    if not isinstance(header, dict):
        return False
    if expected_id is not None and safe_int(header.get("id"), -1) != expected_id:
        return False
    if expected_size is not None and safe_int(header.get("size"), -1) != expected_size:
        return False
    if expected_block_id is not None and safe_int(header.get("blockId"), -1) != expected_block_id:
        return False
    if expected_block_id is not None and safe_int(header.get("expectedBlockId"), -2) != expected_block_id:
        return False
    validation = header.get("validation")
    if validation == "save_array_header_bounds_current_live":
        if header.get("currentLiveData") is not True:
            return False
        if safe_int(header.get("blockId"), -1) != safe_int(header.get("expectedBlockId"), -2):
            return False
        return True
    if validation != "save_array_header_block_crc16_and_current_chunk_footer_validated":
        return False
    if safe_int(header.get("blockId"), -1) != safe_int(header.get("expectedBlockId"), -2):
        return False
    chunk_footer = header.get("chunkFooterValidation")
    if not isinstance(chunk_footer, dict) or chunk_footer.get("status") != "validated":
        return False
    if chunk_footer.get("variant") != "crc16_ccitt_initial_ffff":
        return False
    crc_validation = header.get("crcValidation")
    if not isinstance(crc_validation, dict) or crc_validation.get("status") != "validated":
        return False
    if crc_validation.get("variant") != "crc16_ccitt_initial_ffff":
        return False
    save_data_validation = header.get("saveDataValidation")
    if not isinstance(save_data_validation, dict) or save_data_validation.get("status") != "validated":
        return False
    if save_data_validation.get("loadedSectorValid") is not True or save_data_validation.get("chunkCountsMatch") is not True:
        return False
    if save_data_validation.get("loadedSectorCountMatchesSaveCounter") is not True:
        return False
    if safe_int(save_data_validation.get("saveCounter"), -1) < 0:
        return False
    if safe_int(save_data_validation.get("lastGoodSector"), -1) not in {0, 1}:
        return False
    chunk_footers = save_data_validation.get("chunkFooters")
    if isinstance(chunk_footers, dict):
        footer_values = list(chunk_footers.values())
    elif isinstance(chunk_footers, list):
        footer_values = chunk_footers
    else:
        return False
    if len(footer_values) < 2:
        return False
    save_counter = safe_int(save_data_validation.get("saveCounter"), -1)
    for footer in footer_values[:2]:
        if not isinstance(footer, dict):
            return False
        if safe_int(footer.get("count"), -2) != save_counter:
            return False
    return True


def normalize_inventory(raw_inventory: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {name: [] for name in INVENTORY_POCKETS}
    out["registered_items"] = []
    validation_issues: List[str] = []
    if not isinstance(raw_inventory, dict):
        out["source"] = "unavailable"
        out["validation"] = "not_available"
        return out
    out["source"] = raw_inventory.get("source") or "FieldSystem.saveData SaveArray_Get(SAVE_BAG).Bag"
    out["validation"] = raw_inventory.get("validation") or "not_validated"
    if raw_inventory.get("reason"):
        out["reason"] = raw_inventory.get("reason")
    header = raw_inventory.get("header") if isinstance(raw_inventory.get("header"), dict) else {}
    header_validated = save_array_header_validated(header, expected_id=3, expected_size=0x7A0, expected_block_id=0)
    if raw_inventory.get("validation") != "validated_save_bag_header_and_pocket_bounds" or not header_validated:
        out["validation"] = "not_validated"
        out["reason"] = "save_array_header_crc_validation_required" if not header_validated else "save_bag_validation_required"
        return out
    if header_validated:
        out["saveArrayValidation"] = header.get("validation")
    out["contract"] = "ram_save_bag_slots_header_validated_with_pocket_bounds_and_itemdata_field_pocket_legality"
    raw_invalid_slots = raw_inventory.get("invalid_slots")
    if isinstance(raw_invalid_slots, list):
        for issue in raw_invalid_slots:
            if isinstance(issue, dict):
                validation_issues.append(
                    f"{issue.get('pocket') or 'unknown'}:{safe_int(issue.get('slot'), 0)}:{issue.get('reason') or 'invalid_slot'}"
                )
    for pocket_name in INVENTORY_POCKETS:
        items = raw_inventory.get(pocket_name)
        if not isinstance(items, list):
            continue
        normalized = []
        for slot_index, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                validation_issues.append(f"{pocket_name}:{slot_index}:not_object")
                continue
            item_id = safe_int(item.get("item_id"), 0)
            quantity = safe_int(item.get("quantity"), 0)
            if item_id <= 0 or quantity <= 0:
                validation_issues.append(f"{pocket_name}:{slot_index}:invalid_empty_item_or_quantity")
                continue
            if not is_known_item_id(item_id):
                validation_issues.append(f"{pocket_name}:{slot_index}:unknown_item_id:{item_id}")
                continue
            if not item_allowed_in_bag_pocket(item_id, pocket_name):
                expected_pocket = item_field_pocket(item_id) or "unknown"
                validation_issues.append(f"{pocket_name}:{slot_index}:wrong_pocket:{item_id}:expected:{expected_pocket}")
                continue
            raw_name = str(item.get("name") or "")
            name = item_name(item_id) if re.fullmatch(r"Item\s+\d+", raw_name) else (raw_name or item_name(item_id))
            normalized.append([name, quantity])
        out[pocket_name] = normalized
    registered = raw_inventory.get("registered_items")
    if isinstance(registered, list):
        normalized_registered = []
        seen_registered_slots: set[int] = set()
        seen_registered_item_ids: set[int] = set()
        for slot_index, entry in enumerate(registered, start=1):
            if not isinstance(entry, dict):
                validation_issues.append(f"registered_items:{slot_index}:not_object")
                continue
            slot = safe_int(entry.get("slot"), len(normalized_registered) + 1)
            if slot < 1 or slot > 2:
                validation_issues.append(f"registered_items:{slot_index}:slot_out_of_bounds:{slot}")
                continue
            if slot in seen_registered_slots:
                validation_issues.append(f"registered_items:{slot_index}:duplicate_slot:{slot}")
                continue
            if slot == 2 and 1 not in seen_registered_slots:
                validation_issues.append("registered_items:2:slot_2_without_slot_1")
                continue
            item_id = safe_int(entry.get("item_id"), 0)
            if item_id <= 0 or not is_known_item_id(item_id):
                validation_issues.append(f"registered_items:{slot_index}:unknown_item_id:{item_id}")
                continue
            if not item_registerable(item_id):
                expected_pocket = item_field_pocket(item_id) or "unknown"
                validation_issues.append(f"registered_items:{slot_index}:not_registerable:{item_id}:field_pocket:{expected_pocket}")
                continue
            if item_id in seen_registered_item_ids:
                validation_issues.append(f"registered_items:{slot_index}:duplicate_registered_item:{item_id}")
                continue
            seen_registered_slots.add(slot)
            seen_registered_item_ids.add(item_id)
            raw_name = str(entry.get("name") or "")
            name = item_name(item_id) if re.fullmatch(r"Item\s+\d+", raw_name) else (raw_name or item_name(item_id))
            normalized_registered.append({"slot": slot, "name": name, "item_id": item_id})
        out["registered_items"] = normalized_registered
    if validation_issues:
        out["validation"] = "invalid_save_bag_slots"
        out["validation_issues"] = validation_issues
        out["reason"] = out.get("reason") or "bag_contains_unusable_slots"
        out["contract"] = "save_bag_itemdata_field_pocket_legality_rejected"
    return out


def normalize_progress_flags(raw_progress: Any) -> Dict[str, Any]:
    empty = {
        "source": "unavailable",
        "validation": "not_available",
        "validated": False,
        "got_starter": False,
        "got_pokedex": False,
        "got_pokegear": False,
        "got_bag": False,
        "strength_enabled": False,
        "safari_zone_active": False,
        "safari_zone_has_step_limit": False,
        "safari_zone_steps_remaining": None,
        "safari_zone_balls_remaining": None,
        "flash_active": False,
        "defog_active": False,
        "starter_species_id": None,
        "starter_species_name": None,
    }
    if not isinstance(raw_progress, dict):
        return empty
    header = raw_progress.get("header") if isinstance(raw_progress.get("header"), dict) else {}
    header_validated = save_array_header_validated(header, expected_id=4, expected_size=0x450, expected_block_id=0)
    if raw_progress.get("validation") != "validated_save_vars_flags_header_and_named_bits" or not header_validated:
        out = dict(empty)
        out["source"] = raw_progress.get("source") or "SaveVarsFlags"
        out["validation"] = raw_progress.get("validation") or "not_validated"
        out["reason"] = "save_array_header_crc_validation_required" if not header_validated else out["validation"]
        return out

    starter_species_id = safe_int(raw_progress.get("starter_species_id"), 0)
    if starter_species_id <= 0 or starter_species_id > 65535:
        starter_species_id = None
    starter_species_name = hgss_species_name(starter_species_id) if starter_species_id else None
    return {
        "source": "ram_save_vars_flags_named_current_progress",
        "rawSource": raw_progress.get("source"),
        "validation": "validated_save_vars_flags_header_and_named_bits",
        "saveArrayValidation": header.get("validation"),
        "validated": True,
        "got_starter": bool(raw_progress.get("got_starter")),
        "got_pokedex": bool(raw_progress.get("got_pokedex")),
        "got_pokegear": bool(raw_progress.get("got_pokegear")),
        "got_bag": bool(raw_progress.get("got_bag")),
        "strength_enabled": bool(raw_progress.get("strength_enabled")),
        "safari_zone_active": bool(raw_progress.get("safari_zone_active")),
        "safari_zone_has_step_limit": raw_progress.get("safari_zone_has_step_limit") is True,
        "safari_zone_steps_remaining": (
            int(raw_progress["safari_zone_steps_remaining"])
            if isinstance(raw_progress.get("safari_zone_steps_remaining"), int)
            else None
        ),
        "safari_zone_balls_remaining": (
            int(raw_progress["safari_zone_balls_remaining"])
            if isinstance(raw_progress.get("safari_zone_balls_remaining"), int)
            and 0 <= int(raw_progress["safari_zone_balls_remaining"]) <= 30
            else None
        ),
        "flash_active": bool(raw_progress.get("flash_active")),
        "defog_active": bool(raw_progress.get("defog_active")),
        "starter_species_id": starter_species_id,
        "starter_species_name": starter_species_name,
    }


def normalize_local_field_data(raw_local_field_data: Any) -> Dict[str, Any]:
    empty = {
        "source": "unavailable",
        "validation": "not_available",
        "validated": False,
        "safari_zone_has_step_limit": False,
        "safari_zone_steps_remaining": None,
        "safari_zone_balls_remaining": None,
        "flash_needed": False,
        "defog_needed": False,
        "visibility_reduced": False,
        "visibility_state": "unknown",
    }
    if not isinstance(raw_local_field_data, dict):
        return empty
    header = raw_local_field_data.get("header") if isinstance(raw_local_field_data.get("header"), dict) else {}
    validated = (
        raw_local_field_data.get("validation") == "validated_local_field_data_header_and_safari_counters"
        and save_array_header_validated(header, expected_id=5, expected_size=0x84, expected_block_id=0)
    )
    if not validated:
        return {
            **empty,
            "source": str(raw_local_field_data.get("source") or "unavailable"),
            "validation": str(raw_local_field_data.get("validation") or "not_available"),
        }
    balls = raw_local_field_data.get("safari_balls_remaining")
    weather = safe_int(raw_local_field_data.get("weather"), -1)
    flash_needed = weather == 11
    defog_needed = weather == 9
    visibility_reduced = weather in (9, 10, 11)
    if weather == 9:
        visibility_state = "fog_required_defog"
    elif weather == 10:
        visibility_state = "mist"
    elif weather == 11:
        visibility_state = "flash_required_darkness"
    elif weather == 12:
        visibility_state = "flash_cleared"
    elif weather == 13:
        visibility_state = "low_light"
    elif 0 <= weather < 14:
        visibility_state = "normal"
    else:
        visibility_state = "unknown"
    return {
        "source": "ram_local_field_data_weather_and_safari_counters",
        "rawSource": raw_local_field_data.get("source"),
        "validation": "validated_local_field_data_header_and_safari_counters",
        "saveArrayValidation": header.get("validation"),
        "validated": True,
        "safari_zone_has_step_limit": False,
        "safari_zone_steps_remaining": None,
        "safari_zone_balls_remaining": int(balls) if isinstance(balls, int) and 0 <= balls <= 30 else None,
        "flash_needed": flash_needed,
        "defog_needed": defog_needed,
        "visibility_reduced": visibility_reduced,
        "visibility_state": visibility_state,
    }


def visibility_evidence(local_field_data: Any, progress_flags: Any) -> Dict[str, Any]:
    data = local_field_data if isinstance(local_field_data, dict) else {}
    progress = progress_flags if isinstance(progress_flags, dict) else {}
    validated = data.get("validated") is True
    state = str(data.get("visibility_state") or "")
    field_effect_status_visible = (
        data.get("flash_needed") is True
        or data.get("defog_needed") is True
        or "flash" in state.lower()
        or "defog" in state.lower()
    )
    progress_validated = progress.get("validated") is True
    return {
        "localFieldDataHeaderValid": bool(validated),
        "currentWeatherDecoded": bool(validated and state and state != "unknown"),
        "flashOrDefogFlagNamedFactWhenFieldEffectStatusVisible": bool(
            validated and (not field_effect_status_visible or progress_validated)
        ),
        "visibilityState": state if state else "unknown",
    }


def pokemon_species_name(species_id: int, fallback: Any = None) -> str:
    return hgss_species_name(species_id, fallback)


def pokemon_status_name(status: Any) -> str:
    value = safe_int(status, 0)
    if value <= 0:
        return "OK"
    if not pokemon_status_is_legal(value):
        return f"INVALID_STATUS_{value}"
    flags = []
    if value & 0x7:
        flags.append("SLP")
    if value & 0x8:
        flags.append("PSN")
    if value & 0x10:
        flags.append("BRN")
    if value & 0x20:
        flags.append("FRZ")
    if value & 0x40:
        flags.append("PAR")
    if value & 0x80:
        flags.append("TOX")
    return "+".join(flags) if flags else f"STATUS_{value}"


def pokemon_status_is_legal(status: Any) -> bool:
    value = safe_int(status, -1)
    if value < 0 or value > 0xFF:
        return False
    if value == 0:
        return True
    sleep_bits = value & 0x7
    nonvolatile_bits = value & 0xF8
    if sleep_bits:
        return sleep_bits <= 7 and nonvolatile_bits == 0
    return nonvolatile_bits in {0x8, 0x10, 0x20, 0x40, 0x80}


def comparable_type_ids(type_ids: Any) -> List[int]:
    if not isinstance(type_ids, list):
        return []
    out: List[int] = []
    for type_id in type_ids:
        safe_type_id = safe_int(type_id, -1)
        if safe_type_id == 255:
            continue
        if safe_type_id not in out:
            out.append(safe_type_id)
    return out


def pokemon_is_shiny(mon: Dict[str, Any]) -> bool:
    raw_pid = mon.get("pid", mon.get("personality"))
    if raw_pid is None:
        return False
    if mon.get("original_trainer_id") is None or mon.get("original_secret_id") is None:
        return False
    pid = safe_int(raw_pid, -1)
    trainer_id = safe_int(mon.get("original_trainer_id"), -1)
    secret_id = safe_int(mon.get("original_secret_id"), -1)
    if pid < 0 or trainer_id < 0 or secret_id < 0:
        return False
    shiny_value = ((pid & 0xFFFF) ^ ((pid >> 16) & 0xFFFF) ^ (trainer_id & 0xFFFF) ^ (secret_id & 0xFFFF))
    return shiny_value < 8


def normalize_battle_stat_stages(value: Any) -> Optional[Dict[str, int]]:
    if not isinstance(value, dict):
        return None
    keys = ("attack", "defense", "speed", "special_attack", "special_defense", "accuracy", "evasion")
    out: Dict[str, int] = {}
    for key in keys:
        if key not in value:
            return None
        stage = safe_int(value.get(key), 999)
        if stage < -6 or stage > 6:
            return None
        out[key] = stage
    return out


def normalize_ram_pokemon(mon: Dict[str, Any], index: int) -> Dict[str, Any]:
    move_ids = mon.get("move_ids") if isinstance(mon.get("move_ids"), list) else []
    pp_values = mon.get("pp") if isinstance(mon.get("pp"), list) else []
    moves = []
    for move_index, move_id in enumerate(move_ids):
        safe_move_id = safe_int(move_id, 0)
        if safe_move_id <= 0:
            continue
        moves.append(
            {
                "name": move_name(safe_move_id),
                "pp": safe_int(pp_values[move_index], 0) if move_index < len(pp_values) else 0,
                "move_id": safe_move_id,
            }
        )
    species_id = safe_int(mon.get("species_id"), 0)
    held_item_id = safe_int(mon.get("held_item_id"), 0)
    nickname = str(mon.get("nickname") or "").strip()
    form_id = safe_int(mon.get("form_id"), 0)
    personal = species_personal_data(species_id, form_id)
    raw_type_ids = [safe_int(type_id, 0) for type_id in mon.get("type_ids", [])] if isinstance(mon.get("type_ids"), list) else []
    type_ids = [safe_int(type_id, 0) for type_id in personal.get("type_ids", [])]
    ability_id = safe_int(mon.get("ability_id"), 0) if mon.get("ability_id") is not None else None
    if ability_id is None:
        personal_abilities = [safe_int(value, 0) for value in personal.get("ability_ids", [])]
        non_zero_abilities = [value for value in personal_abilities if value > 0]
        if len(set(non_zero_abilities)) == 1:
            ability_id = non_zero_abilities[0]
    type_names = []
    for type_id in type_ids:
        if type_id == 255:
            continue
        name = type_name(type_id)
        if name not in type_names:
            type_names.append(name)
    stat_stages = normalize_battle_stat_stages(mon.get("stat_stages"))
    out = {
        "slot_id": safe_int(mon.get("slot_id"), index + 1),
        "species_name": pokemon_species_name(species_id, mon.get("species_name")),
        "species_id": species_id,
        "form_id": form_id,
        "nickname": nickname or None,
        "is_nicknamed": bool(mon.get("is_nicknamed")) if mon.get("is_nicknamed") is not None else None,
        "level": safe_int(mon.get("level"), 0),
        "exp": safe_int(mon.get("exp"), 0) if mon.get("exp") is not None else None,
        "current_hp": safe_int(mon.get("current_hp"), 0),
        "max_hp": safe_int(mon.get("max_hp"), 0),
        "moves": moves,
        "types": type_names,
        "ability": ability_name(ability_id) if ability_id is not None else None,
        "status": pokemon_status_name(mon.get("status")),
        "status_raw": safe_int(mon.get("status"), 0),
        "attack": safe_int(mon.get("attack"), 0),
        "defense": safe_int(mon.get("defense"), 0),
        "speed": safe_int(mon.get("speed"), 0),
        "special_attack": safe_int(mon.get("special_attack"), 0),
        "special_defense": safe_int(mon.get("special_defense"), 0),
        "base_stats": personal.get("base_stats") if isinstance(personal.get("base_stats"), dict) else None,
        "growth_rate": personal.get("growth_rate"),
        "growth_rate_id": personal.get("growth_rate_id"),
        "personal_data_source": personal.get("source"),
        "personal_species_id": personal.get("personal_species_id"),
        "form_personal_data": bool(personal.get("form_personal_data")),
        "held_item_id": held_item_id,
        "held_item_name": item_name(held_item_id) if held_item_id > 0 else None,
        "is_shiny": pokemon_is_shiny(mon),
        "checksum_valid": mon.get("checksum_valid") is True,
    }
    if stat_stages is not None:
        out["stat_stages"] = stat_stages
    if mon.get("battler_id") is not None:
        out["battler_id"] = safe_int(mon.get("battler_id"), index)
    if mon.get("side"):
        out["side"] = str(mon.get("side"))
    if type_ids:
        out["type_ids"] = type_ids
    if raw_type_ids:
        out["raw_type_ids"] = raw_type_ids
    if ability_id is not None:
        out["ability_id"] = ability_id
    return out


def ram_pokemon_validation_issue(mon: Dict[str, Any]) -> Optional[str]:
    if not isinstance(mon, dict):
        return "not_object"
    species_id = safe_int(mon.get("species_id"), 0)
    if species_id <= 0 or species_id > 493:
        return "invalid_species_id"
    form_id = safe_int(mon.get("form_id"), 0)
    if not is_valid_form_id(species_id, form_id):
        return "invalid_form_id"
    level = safe_int(mon.get("level"), 0)
    if level < 1 or level > 100:
        return "invalid_level"
    if mon.get("exp") is not None:
        exp = safe_int(mon.get("exp"), -1)
        if exp < 0 or exp > 0x00FFFFFF:
            return "invalid_exp"
        exp_bounds = species_exp_bounds_for_level(species_id, form_id, level)
        if exp_bounds is None:
            return "invalid_exp_growth_rate"
        min_exp = safe_int(exp_bounds.get("min_exp"), -1)
        max_exp_exclusive = exp_bounds.get("max_exp_exclusive")
        max_exp = safe_int(exp_bounds.get("max_exp"), 0x00FFFFFF)
        if exp < min_exp:
            return "exp_level_mismatch"
        if max_exp_exclusive is not None and exp >= safe_int(max_exp_exclusive, 0):
            return "exp_level_mismatch"
        if level >= 100 and exp > max_exp:
            return "exp_level_mismatch"
    current_hp = safe_int(mon.get("current_hp"), 0)
    max_hp = safe_int(mon.get("max_hp"), 0)
    if current_hp < 0 or current_hp > 999 or max_hp < 1 or max_hp > 999 or current_hp > max_hp:
        return "invalid_hp"
    for stat_name in ("attack", "defense", "speed", "special_attack", "special_defense"):
        if mon.get(stat_name) is None:
            continue
        stat_value = safe_int(mon.get(stat_name), -1)
        if stat_value < 0 or stat_value > 999:
            return f"invalid_{stat_name}"
    move_ids = mon.get("move_ids") if isinstance(mon.get("move_ids"), list) else []
    pp_values = mon.get("pp") if isinstance(mon.get("pp"), list) else []
    if len(move_ids) > 4 or len(pp_values) > 4:
        return "too_many_moves"
    for move_index, move_id in enumerate(move_ids):
        safe_move_id = safe_int(move_id, 0)
        if safe_move_id <= 0:
            continue
        if not is_known_move_id(safe_move_id):
            return "invalid_move_ids"
        if move_index < len(pp_values):
            pp = safe_int(pp_values[move_index], -1)
            max_pp = move_max_pp(safe_move_id, 3)
            if pp < 0 or max_pp is None or pp > max_pp:
                return "invalid_move_pp"
    held_item_id = safe_int(mon.get("held_item_id"), 0)
    if held_item_id < 0 or (held_item_id > 0 and not is_known_item_id(held_item_id)):
        return "invalid_held_item_id"
    if "stat_stages" in mon and normalize_battle_stat_stages(mon.get("stat_stages")) is None:
        return "invalid_stat_stages"
    if mon.get("ability_id") is not None:
        ability_id = safe_int(mon.get("ability_id"), -1)
        legal_abilities = legal_personal_ability_ids(species_id, form_id)
        if ability_id < 0 or ability_id not in legal_abilities:
            return "invalid_ability_id"
    if mon.get("status") is not None:
        if not pokemon_status_is_legal(mon.get("status")):
            return "invalid_status"
    if isinstance(mon.get("type_ids"), list):
        for type_id in mon.get("type_ids", []):
            if not is_known_type_id(safe_int(type_id, -1)):
                return "invalid_type_ids"
        raw_types = comparable_type_ids(mon.get("type_ids"))
        personal_types = comparable_type_ids(legal_personal_type_ids(species_id, form_id))
        if raw_types and personal_types and raw_types != personal_types:
            return "type_ids_species_mismatch"
    return None


def boxed_pokemon_validation_issue(mon: Dict[str, Any]) -> Optional[str]:
    if not isinstance(mon, dict):
        return "not_object"
    species_id = safe_int(mon.get("species_id"), 0)
    if species_id <= 0 or species_id > 493:
        return "invalid_species_id"
    form_id = safe_int(mon.get("form_id"), 0)
    if not is_valid_form_id(species_id, form_id):
        return "invalid_form_id"
    move_ids = mon.get("move_ids") if isinstance(mon.get("move_ids"), list) else []
    pp_values = mon.get("pp") if isinstance(mon.get("pp"), list) else []
    if len(move_ids) > 4 or len(pp_values) > 4:
        return "too_many_moves"
    for move_index, move_id in enumerate(move_ids):
        safe_move_id = safe_int(move_id, 0)
        if safe_move_id <= 0:
            continue
        if not is_known_move_id(safe_move_id):
            return "invalid_move_ids"
        if move_index < len(pp_values):
            pp = safe_int(pp_values[move_index], -1)
            max_pp = move_max_pp(safe_move_id, 3)
            if pp < 0 or max_pp is None or pp > max_pp:
                return "invalid_move_pp"
    held_item_id = safe_int(mon.get("held_item_id"), 0)
    if held_item_id < 0 or (held_item_id > 0 and not is_known_item_id(held_item_id)):
        return "invalid_held_item_id"
    if mon.get("exp") is not None:
        exp = safe_int(mon.get("exp"), -1)
        if exp < 0 or exp > 0x00FFFFFF:
            return "invalid_exp"
        if species_level_for_exp(species_id, form_id, exp) is None:
            return "invalid_exp_growth_rate"
    if mon.get("ability_id") is not None:
        ability_id = safe_int(mon.get("ability_id"), -1)
        legal_abilities = legal_personal_ability_ids(species_id, form_id)
        if ability_id < 0 or ability_id not in legal_abilities:
            return "invalid_ability_id"
    if isinstance(mon.get("type_ids"), list):
        for type_id in mon.get("type_ids", []):
            if not is_known_type_id(safe_int(type_id, -1)):
                return "invalid_type_ids"
        raw_types = comparable_type_ids(mon.get("type_ids"))
        personal_types = comparable_type_ids(legal_personal_type_ids(species_id, form_id))
        if raw_types and personal_types and raw_types != personal_types:
            return "type_ids_species_mismatch"
    return None


def normalize_party_from_ram(ram: Dict[str, Any]) -> tuple[List[Dict[str, Any]], int, str, bool, bool, List[str]]:
    raw_party = ram.get("party") if isinstance(ram.get("party"), list) else []
    party: List[Dict[str, Any]] = []
    validation_issues: List[str] = []
    party_validation = str(ram.get("party_validation") or "not_validated")
    validated_party_validation = "ram_save_party_header_validated_with_pokemon_checksum_and_stats"
    if party_validation != validated_party_validation:
        party_count = safe_int(ram.get("party_count"), 0)
        if party_count > 0:
            validation_issues.append(f"party_validation_not_complete:{party_validation}")
        return [], 0, party_validation, False, False, validation_issues
    party_source = str(ram.get("party_source") or "")
    if not party_source.startswith("FieldSystem.saveData SaveArray_Get(SAVE_PARTY).PartyCore"):
        validation_issues.append("party_save_array_source_required")
        return [], 0, party_validation, False, False, validation_issues
    party_header = ram.get("party_header") if isinstance(ram.get("party_header"), dict) else {}
    if not save_array_header_validated(party_header, expected_id=2, expected_size=0x5B4, expected_block_id=0):
        validation_issues.append("party_save_array_header_required")
        return [], 0, party_validation, False, False, validation_issues
    for index, mon in enumerate(raw_party):
        if not isinstance(mon, dict):
            validation_issues.append(f"slot_{index + 1}:not_object")
            continue
        if mon.get("checksum_valid") is not True:
            validation_issues.append(f"slot_{index + 1}:checksum_invalid")
            continue
        issue = ram_pokemon_validation_issue(mon)
        if issue:
            validation_issues.append(f"slot_{index + 1}:{issue}")
            continue
        party.append(normalize_ram_pokemon(mon, index))
    party_count = safe_int(ram.get("party_count"), len(party))
    if party_count < 0 or party_count > 6:
        validation_issues.append(f"count_out_of_range:{party_count}")
    if len(party) != party_count:
        validation_issues.append(f"count_mismatch:decoded={len(party)} expected={party_count}")
    if len(party) > 6:
        validation_issues.append("too_many_party_mons")
    for mon in party:
        slot = mon.get("slot_id")
        species_id = safe_int(mon.get("species_id"), 0)
        level = safe_int(mon.get("level"), 0)
        current_hp = safe_int(mon.get("current_hp"), 0)
        max_hp = safe_int(mon.get("max_hp"), 0)
        if not 1 <= species_id <= 493:
            validation_issues.append(f"slot_{slot}:species_out_of_range:{species_id}")
        if not 1 <= level <= 100:
            validation_issues.append(f"slot_{slot}:level_out_of_range:{level}")
        if not 1 <= max_hp <= 999:
            validation_issues.append(f"slot_{slot}:max_hp_out_of_range:{max_hp}")
        if current_hp < 0 or current_hp > max_hp:
            validation_issues.append(f"slot_{slot}:current_hp_out_of_range:{current_hp}/{max_hp}")
        if mon.get("checksum_valid") is not True:
            validation_issues.append(f"slot_{slot}:checksum_invalid")
    party_presence_detected = False
    party_validated = party_validation == validated_party_validation and not validation_issues
    if party_count == 0 and party_validation == validated_party_validation and not raw_party:
        party_validated = True
    return party, party_count, party_validation, party_validated, party_presence_detected, validation_issues


def normalize_pc_storage(raw_pc_storage: Any) -> Dict[str, Any]:
    if not isinstance(raw_pc_storage, dict):
        return {
            "source": "unavailable",
            "validation": "not_available",
            "current_box": 1,
            "total_mons": 0,
            "pokemons": [],
            "boxes": [],
        }
    validation = raw_pc_storage.get("validation") or "not_validated"
    header = raw_pc_storage.get("header") if isinstance(raw_pc_storage.get("header"), dict) else {}
    header_validated = save_array_header_validated(
        header,
        expected_id=41,
        expected_size=0x12300,
        expected_block_id=1,
    )
    if validation != "validated_pc_storage_header_and_box_mon_checksums" or not header_validated:
        return {
            "source": raw_pc_storage.get("source") or "FieldSystem.saveData SaveArray_Get(SAVE_PCSTORAGE).PokemonStorageSystem",
            "validation": "not_validated",
            "reason": "save_array_header_crc_validation_required" if not header_validated else "pc_storage_validation_required",
            "current_box": None,
            "total_mons": 0,
            "box_count": safe_int(raw_pc_storage.get("box_count"), 0),
            "mons_per_box": safe_int(raw_pc_storage.get("mons_per_box"), 30),
            "pokemons": [],
            "boxes": [],
        }
    boxes_out: List[Dict[str, Any]] = []
    raw_current_box = safe_int(raw_pc_storage.get("current_box"), -1)
    if validation == "validated_pc_storage_header_and_box_mon_checksums" and not (1 <= raw_current_box <= 18):
        return {
            "source": raw_pc_storage.get("source") or "FieldSystem.saveData SaveArray_Get(SAVE_PCSTORAGE).PokemonStorageSystem",
            "validation": "invalid_pc_storage_current_box",
            "reason": "current_box_out_of_range",
            "current_box": None,
            "total_mons": 0,
            "box_count": safe_int(raw_pc_storage.get("box_count"), 0),
            "mons_per_box": safe_int(raw_pc_storage.get("mons_per_box"), 30),
            "pokemons": [],
            "boxes": [],
        }
    current_box = raw_current_box if 1 <= raw_current_box <= 18 else 1
    for raw_box in raw_pc_storage.get("boxes", []) if isinstance(raw_pc_storage.get("boxes"), list) else []:
        if not isinstance(raw_box, dict):
            continue
        box_number = safe_int(raw_box.get("box_number"), safe_int(raw_box.get("box_index"), 0) + 1)
        if box_number < 1 or box_number > 18:
            continue
        mons = []
        for mon_index, raw_mon in enumerate(raw_box.get("mons", []) if isinstance(raw_box.get("mons"), list) else []):
            if not isinstance(raw_mon, dict) or raw_mon.get("checksum_valid") is not True:
                continue
            species_id = safe_int(raw_mon.get("species_id"), 0)
            if species_id <= 0 or species_id > 493:
                continue
            issue = boxed_pokemon_validation_issue(raw_mon)
            if issue:
                continue
            normalized = normalize_ram_pokemon(raw_mon, mon_index)
            normalized["box"] = box_number
            normalized["box_slot"] = safe_int(raw_mon.get("box_slot"), mon_index) + 1
            normalized["pc_box_mon"] = True
            for transient_field in (
                "level",
                "current_hp",
                "max_hp",
                "attack",
                "defense",
                "speed",
                "special_attack",
                "special_defense",
                "status",
            ):
                normalized.pop(transient_field, None)
            if raw_mon.get("exp") is not None:
                exp = safe_int(raw_mon.get("exp"), 0)
                normalized["exp"] = exp
                derived_level = species_level_for_exp(species_id, safe_int(raw_mon.get("form_id"), 0), exp)
                if derived_level is not None:
                    normalized["level"] = safe_int(derived_level.get("level"), 0)
                    normalized["level_known"] = True
                    normalized["level_source"] = "pc_box_exp_growth_table"
                    normalized["exp_level_bounds"] = {
                        "min_exp": safe_int(derived_level.get("min_exp"), 0),
                        "max_exp_exclusive": derived_level.get("max_exp_exclusive"),
                    }
                else:
                    normalized["level_known"] = False
                    normalized["level_source"] = "pc_box_exp_growth_table_unavailable"
            else:
                normalized["level_known"] = False
                normalized["level_source"] = "pc_box_exp_missing"
            normalized["hp_known"] = False
            normalized["transient_stats_source"] = "not_stored_in_box_pokemon"
            mons.append(normalized)
        boxes_out.append(
            {
                "box_number": box_number,
                "count": len(mons),
                "wallpaper": safe_int(raw_box.get("wallpaper"), 0),
                "mons": mons,
            }
        )
    current_box_mons = []
    for box in boxes_out:
        if box["box_number"] == current_box:
            current_box_mons = box["mons"]
            break
    total_mons = sum(box["count"] for box in boxes_out)
    return {
        "source": raw_pc_storage.get("source") or "FieldSystem.saveData SaveArray_Get(SAVE_PCSTORAGE).PokemonStorageSystem",
        "validation": validation,
        "saveArrayValidation": header.get("validation") if header_validated else None,
        "current_box": current_box,
        "total_mons": total_mons,
        "box_count": safe_int(raw_pc_storage.get("box_count"), len(boxes_out)),
        "mons_per_box": safe_int(raw_pc_storage.get("mons_per_box"), 30),
        "pokemons": current_box_mons,
        "boxes": boxes_out,
    }


def _valid_battle_order(values: Any, max_battlers: int) -> bool:
    if not isinstance(values, list):
        return False
    return all(isinstance(value, (int, float)) and 0 <= int(value) < max_battlers for value in values)


def _valid_selected_mon_indices(values: Any) -> bool:
    if not isinstance(values, list):
        return False
    return all(isinstance(value, (int, float)) and 0 <= int(value) <= 5 for value in values)


def _battle_input_invalid_reason(raw_input: Dict[str, Any], max_battlers: int) -> Optional[str]:
    menu_id = safe_int(raw_input.get("curMenuId"), -999)
    if menu_id < -1 or menu_id > 20:
        return "invalid_battle_menu_id"
    selected_indices = raw_input.get("selectedMonIndex")
    if not _valid_selected_mon_indices(selected_indices):
        return "invalid_selected_mon_index"
    if not _valid_battle_order(raw_input.get("executionOrder"), max_battlers):
        return "invalid_execution_order"
    if not _valid_battle_order(raw_input.get("turnOrder"), max_battlers):
        return "invalid_turn_order"
    for action in raw_input.get("playerActions") if isinstance(raw_input.get("playerActions"), list) else []:
        if not isinstance(action, dict):
            return "invalid_player_action"
        battler_id = safe_int(action.get("battlerId"), -1)
        command = safe_int(action.get("command"), -1)
        input_selection = safe_int(action.get("inputSelection"), -1)
        if battler_id < 0 or battler_id >= max_battlers:
            return "invalid_player_action_battler"
        if command < 0 or command > 45:
            return "invalid_player_action_command"
        if input_selection not in {0, 1, 2, 3, 4, 0xFF}:
            return "invalid_player_action_input_selection"
        command_name = str(action.get("commandName") or "")
        parameter2 = safe_int(action.get("parameter2"), 0)
        if command_name == "FIGHT_INPUT" and (parameter2 < 0 or parameter2 > 4):
            return "invalid_player_action_move_selection"
    return None


def _battle_action_details(
    action: Dict[str, Any],
    active_player_pokemons: List[Dict[str, Any]],
    *,
    zero_menu_fight_selection: bool = False,
) -> Dict[str, Any]:
    command_name = str(action.get("commandName") or "unknown")
    input_selection = safe_int(action.get("inputSelection"), 0)
    details: Dict[str, Any] = {
        "battler_id": safe_int(action.get("battlerId"), -1),
        "command": safe_int(action.get("command"), -1),
        "command_name": command_name,
        "parameter1": safe_int(action.get("parameter1"), 0),
        "parameter2": safe_int(action.get("parameter2"), 0),
        "input_selection": input_selection,
        "input_selection_name": str(action.get("inputSelectionName") or "unknown"),
    }
    raw_move_input = details["parameter2"]
    move_input = raw_move_input
    if (
        command_name == "FIGHT_INPUT"
        and zero_menu_fight_selection
        and not (1 <= move_input <= 4)
        and 1 <= input_selection <= 4
    ):
        move_input = input_selection
    if command_name == "FIGHT_INPUT" and input_selection == 1 and 1 <= move_input <= 4:
        move_slot = move_input - 1
        details["selected_move_input"] = move_input
        details["selected_move_slot"] = move_slot
        battler_id = details["battler_id"]
        active_mon = next(
            (
                mon
                for mon in active_player_pokemons
                if safe_int(mon.get("battler_id"), -1) == battler_id
                or (battler_id == 0 and str(mon.get("position") or "") == "player_1")
            ),
            None,
        )
        moves = active_mon.get("moves") if isinstance(active_mon, dict) and isinstance(active_mon.get("moves"), list) else []
        if 0 <= move_slot < len(moves):
            move = moves[move_slot]
            if isinstance(move, dict):
                details["selected_move_name"] = str(move.get("name") or move.get("move_name") or move.get("id") or "")
            elif isinstance(move, str):
                details["selected_move_name"] = move
        target_battler_id = details["parameter1"]
        if 1 <= raw_move_input <= 4 and 0 <= target_battler_id <= 3:
            details["target_battler_id"] = target_battler_id
    elif command_name == "POKEMON_INPUT" and 0 <= move_input <= 5:
        details["switch_party_slot"] = move_input
    return details


def battle_input_player_action(raw_input: Dict[str, Any]) -> Dict[str, Any]:
    actions = raw_input.get("playerActions")
    if not isinstance(actions, list):
        return {}
    for action in actions:
        if isinstance(action, dict) and safe_int(action.get("battlerId"), -1) == 0:
            return action
    return next((action for action in actions if isinstance(action, dict)), {})


def battle_input_zero_menu_fight_selection(raw_input: Dict[str, Any]) -> bool:
    raw_name = str(raw_input.get("curMenuName") or "unknown")
    menu_id = safe_int(raw_input.get("curMenuId"), -1)
    context_command = str(raw_input.get("contextCommandName") or "")
    if menu_id != 0 or raw_name != "BATTLE_MENU_0" or context_command != "SELECTION_SCREEN_INPUT":
        return False
    player_action = battle_input_player_action(raw_input)
    return str(player_action.get("commandName") or "") == "FIGHT_INPUT"


def semantic_battle_menu_name(raw_input: Dict[str, Any]) -> str:
    raw_name = str(raw_input.get("curMenuName") or "unknown")
    menu_id = safe_int(raw_input.get("curMenuId"), -1)
    context_command = str(raw_input.get("contextCommandName") or "")
    if menu_id == 0 and raw_name == "BATTLE_MENU_0" and context_command == "SELECTION_SCREEN_INPUT":
        if battle_input_zero_menu_fight_selection(raw_input):
            return "FIGHT"
        return "MAIN"
    return raw_name


def _is_hidden_party_summary_panel(summary_screen: Any) -> bool:
    if not isinstance(summary_screen, dict) or summary_screen.get("active") is not True:
        return False
    if summary_screen.get("contract") != "ram_party_menu_summary_panel_current_mon_v1":
        return False
    if summary_screen.get("validation") != "party_menu_proc_state_summary_panel_current_mon_validated":
        return False
    source = str(summary_screen.get("source") or "")
    if source != "PartyMenuOverlayManager.procState.PartyMenuSummaryPanel":
        return False
    panel_show = summary_screen.get("topScreenPanelShow")
    if panel_show is False or panel_show == 0:
        return True
    if isinstance(panel_show, str) and panel_show.strip().lower() in {"0", "false", "no"}:
        return True
    return False


def _normalize_party_menu_projection(
    party_menu: Any,
    *,
    output_contract: str = "ram_party_menu_overlay_args_party_cursor_current_slots_v1",
    title: Optional[str] = None,
) -> Dict[str, Any]:
    if not isinstance(party_menu, dict) or party_menu.get("active") is not True:
        return {"active": False, "confidence": "unavailable", "reason": "party_menu_inactive"}
    contract = str(party_menu.get("contract") or "")
    validation = str(party_menu.get("validation") or "")
    if (
        contract != "ram_party_menu_overlay_args_party_cursor_current_slots_v1"
        or validation != "party_menu_overlay_args_party_cursor_current_slots_validated"
    ):
        return {
            "active": False,
            "source": "PartyMenuOverlayManager.args.PartyMenuArgs",
            "confidence": "unavailable",
            "contract": output_contract,
            "validation": validation or "missing",
            "reason": "party_menu_contract_or_validation_not_validated",
        }
    raw_items = party_menu.get("items")
    items: List[Dict[str, Any]] = []
    if isinstance(raw_items, list):
        for entry in raw_items[:6]:
            if not isinstance(entry, dict):
                continue
            text = sanitize_current_visible_text(entry.get("text"))
            if not text:
                nickname = sanitize_current_visible_text(entry.get("nickname"))
                species_id = safe_int(entry.get("species_id"), 0)
                name = nickname or pokemon_species_name(species_id, entry.get("species_name"))
                level = safe_int(entry.get("level"), 0)
                hp = safe_int(entry.get("current_hp"), 0)
                max_hp = safe_int(entry.get("max_hp"), 0)
                if not name or level <= 0 or max_hp <= 0:
                    continue
                status = pokemon_status_name(entry.get("status"))
                held_item_id = safe_int(entry.get("held_item_id"), 0)
                held_item = f" holding {item_name(held_item_id)}" if held_item_id > 0 and is_known_item_id(held_item_id) else ""
                status_suffix = f" {status}" if status and status != "OK" else ""
                text = sanitize_current_visible_text(f"{name} Lv{level} HP {hp}/{max_hp}{status_suffix}{held_item}")
            if not text:
                continue
            items.append(
                {
                    "text": text,
                    "selected": bool(entry.get("selected")),
                }
            )
    cursor = sanitize_current_visible_text(party_menu.get("cursor"))
    if not cursor:
        selected = next((item.get("text") for item in items if item.get("selected")), "")
        cursor = sanitize_current_visible_text(selected)
    if not items or not cursor:
        return {
            "active": False,
            "source": "PartyMenuOverlayManager.args.PartyMenuArgs",
            "confidence": "unavailable",
            "contract": output_contract,
            "validation": validation,
            "reason": "party_menu_visible_items_or_cursor_missing",
        }
    menu = {
        "active": True,
        "source": "PartyMenuOverlayManager.args.PartyMenuArgs",
        "confidence": "validated_ram",
        "contract": output_contract,
        "validation": validation,
        "cursor": cursor,
        "items": items,
    }
    clean_title = sanitize_current_visible_text(title)
    if clean_title:
        menu["title"] = clean_title
    return menu


def _normalize_party_context_menu_projection(party_context_menu: Any) -> Dict[str, Any]:
    source = "PartyMenuOverlayManager.contextMenuCursor.ListMenuItems"
    if not isinstance(party_context_menu, dict) or party_context_menu.get("active") is not True:
        return {"active": False, "confidence": "unavailable", "reason": "party_context_menu_inactive"}
    contract = str(party_context_menu.get("contract") or "")
    validation = str(party_context_menu.get("validation") or "")
    if (
        contract != "ram_party_menu_context_menu_current_options_v1"
        or validation != "party_menu_context_menu_cursor_list_items_validated"
    ):
        return {
            "active": False,
            "source": source,
            "confidence": "unavailable",
            "contract": contract or "ram_party_menu_context_menu_current_options_v1",
            "validation": validation or "missing",
            "reason": "party_context_menu_contract_or_validation_not_validated",
        }

    raw_items = party_context_menu.get("items")
    items: List[Dict[str, Any]] = []
    if isinstance(raw_items, list):
        for entry in raw_items[:8]:
            if not isinstance(entry, dict):
                continue
            text = sanitize_current_visible_text(entry.get("text"))
            if not text:
                continue
            items.append(
                {
                    "text": text,
                    "selected": bool(entry.get("selected")),
                }
            )

    cursor = sanitize_current_visible_text(party_context_menu.get("cursor"))
    if not cursor:
        selected = next((item.get("text") for item in items if item.get("selected")), "")
        cursor = sanitize_current_visible_text(selected)
    title = sanitize_current_visible_text(party_context_menu.get("title")) or "Party choice"
    if not items or not cursor:
        return {
            "active": False,
            "source": source,
            "confidence": "unavailable",
            "contract": contract,
            "validation": validation,
            "reason": "party_context_menu_visible_items_or_cursor_missing",
        }

    return {
        "active": True,
        "source": source,
        "confidence": "validated_ram",
        "contract": contract,
        "validation": validation,
        "title": title,
        "cursor": cursor,
        "items": items,
    }


def normalize_battle_input_state(active_battle: Dict[str, Any], active_player_pokemons: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    raw_input = active_battle.get("battleInput") if isinstance(active_battle.get("battleInput"), dict) else {}
    if raw_input.get("validation") != "battle_input_current_context_backref_validated":
        return {
            "available": False,
            "validation": active_battle.get("battleInputValidation") or "not_validated",
        }

    max_battlers = max(1, min(4, safe_int(active_battle.get("maxBattlers"), 4)))
    invalid_reason = _battle_input_invalid_reason(raw_input, max_battlers)
    if invalid_reason:
        return {
            "available": False,
            "validation": invalid_reason,
        }

    def int_list(value: Any, default: int = -1) -> List[int]:
        if not isinstance(value, list):
            return []
        return [safe_int(item, default) for item in value]

    player_actions = []
    zero_menu_fight_selection = battle_input_zero_menu_fight_selection(raw_input)
    for action in raw_input.get("playerActions") if isinstance(raw_input.get("playerActions"), list) else []:
        if not isinstance(action, dict):
            continue
        player_actions.append(
            _battle_action_details(
                action,
                active_player_pokemons or [],
                zero_menu_fight_selection=zero_menu_fight_selection,
            )
        )

    return {
        "available": True,
        "source": "BattleSystem.battleInput + BattleContext.playerActions",
        "validation": "battle_input_current_context_backref_validated",
        "menu_id": safe_int(raw_input.get("curMenuId"), -1),
        "menu_name": semantic_battle_menu_name(raw_input),
        "context_command": safe_int(raw_input.get("contextCommand"), -1),
        "context_command_name": str(raw_input.get("contextCommandName") or "unknown"),
        "context_command_next": safe_int(raw_input.get("contextCommandNext"), -1),
        "context_command_next_name": str(raw_input.get("contextCommandNextName") or "unknown"),
        "selected_mon_indices": int_list(raw_input.get("selectedMonIndex"), 0),
        "execution_order": int_list(raw_input.get("executionOrder"), -1),
        "turn_order": int_list(raw_input.get("turnOrder"), -1),
        "touch_disabled": bool(safe_int(raw_input.get("isTouchDisabled"), 0)),
        "cancel_run_display": safe_int(raw_input.get("cancelRunDisplay"), 0),
        "player_actions": player_actions,
    }


def normalize_field_menu_from_ram(text_probe: Any) -> Dict[str, Any]:
    touch_save_choice = text_probe.get("touch_save_choice") if isinstance(text_probe, dict) else {}
    if isinstance(touch_save_choice, dict) and touch_save_choice.get("active") is True:
        contract = str(touch_save_choice.get("contract") or "")
        validation = str(touch_save_choice.get("validation") or "")
        source = str(touch_save_choice.get("source") or "TouchSaveAppData.YesNoPrompt")
        if (
            contract != "ram_touch_save_yes_no_prompt_current_v1"
            or validation != "touch_save_app_yes_no_prompt_owner_bound"
        ):
            return {
                "active": False,
                "source": source,
                "confidence": "unavailable",
                "contract": contract or "ram_touch_save_yes_no_prompt_current_v1",
                "validation": validation or "missing",
                "reason": "touch_save_choice_contract_or_validation_not_validated",
            }
        raw_items = touch_save_choice.get("items")
        items: List[Dict[str, Any]] = []
        if isinstance(raw_items, list):
            for item in raw_items[:2]:
                if not isinstance(item, dict):
                    continue
                text = sanitize_current_visible_text(item.get("text"))
                if not text:
                    continue
                items.append(
                    {
                        "text": text,
                        "selected": bool(item.get("selected")),
                    }
                )
        cursor = sanitize_current_visible_text(touch_save_choice.get("cursor"))
        if not cursor:
            selected = next((item.get("text") for item in items if item.get("selected")), "")
            cursor = sanitize_current_visible_text(selected)
        title = sanitize_current_visible_text(touch_save_choice.get("title"))
        if not title or not items or not cursor:
            return {
                "active": False,
                "source": source,
                "confidence": "unavailable",
                "contract": contract,
                "validation": validation,
                "reason": "touch_save_choice_visible_items_or_cursor_missing",
            }
        return {
            "active": True,
            "source": source,
            "confidence": "validated_ram",
            "contract": contract,
            "validation": validation,
            "title": title,
            "cursor": cursor,
            "items": items,
        }

    party_menu = text_probe.get("party_menu") if isinstance(text_probe, dict) else {}
    summary_screen = text_probe.get("summary_screen") if isinstance(text_probe, dict) else {}
    party_context_menu = {}
    if isinstance(party_menu, dict):
        party_context_menu = party_menu.get("partyContextMenu")
    if not isinstance(party_context_menu, dict) and isinstance(text_probe, dict):
        party_context_menu = text_probe.get("party_context_menu")
    if isinstance(party_context_menu, dict) and party_context_menu.get("active") is True:
        return _normalize_party_context_menu_projection(party_context_menu)
    if (
        isinstance(party_menu, dict)
        and party_menu.get("active") is True
        and safe_int(party_menu.get("contextId"), -1) == 0
        and _is_hidden_party_summary_panel(summary_screen)
    ):
        return _normalize_party_menu_projection(
            party_menu,
            output_contract="ram_party_menu_overlay_args_battle_item_target_current_slots_v1",
            title="Battle target",
        )

    start_menu = text_probe.get("start_menu") if isinstance(text_probe, dict) else {}
    if isinstance(start_menu, dict) and start_menu.get("active") is True:
        start_menu_contracts = {
            "ram_start_menu_taskdata_current_visible_options_v1",
            "ram_start_menu_fieldsystem_panel_current_visible_options_v1",
        }
        start_menu_validations = {
            "start_menu_taskdata_cursor_active_handle_input",
            "fieldsystem_start_menu_panel_flags_current_visible",
        }
        contract = str(start_menu.get("contract") or "")
        validation = str(start_menu.get("validation") or "")
        source = str(start_menu.get("source") or "StartMenuTaskData.TaskManager.env")
        if contract not in start_menu_contracts or validation not in start_menu_validations:
            return {
                "active": False,
                "source": source,
                "confidence": "unavailable",
                "contract": contract or "ram_start_menu_taskdata_current_visible_options_v1",
                "validation": validation or "missing",
                "reason": "start_menu_contract_or_validation_not_validated",
            }
        raw_items = start_menu.get("items")
        items: List[Dict[str, Any]] = []
        if isinstance(raw_items, list):
            for item in raw_items[:10]:
                if not isinstance(item, dict):
                    continue
                text = sanitize_current_visible_text(item.get("text"))
                if not text:
                    continue
                items.append(
                    {
                        "text": text,
                        "selected": bool(item.get("selected")),
                    }
                )
        cursor = sanitize_current_visible_text(start_menu.get("cursor"))
        if not cursor:
            selected = next((item.get("text") for item in items if item.get("selected")), "")
            cursor = sanitize_current_visible_text(selected)
        if not items or not cursor:
            return {
                "active": False,
                "source": source,
                "confidence": "unavailable",
                "contract": contract,
                "validation": validation,
                "reason": "start_menu_visible_items_or_cursor_missing",
            }
        menu = {
            "active": True,
            "source": source,
            "confidence": "validated_ram",
            "contract": contract,
            "validation": validation,
            "cursor": cursor,
            "items": items,
        }
        title = sanitize_current_visible_text(start_menu.get("title"))
        if title:
            menu["title"] = title
        return menu

    if isinstance(summary_screen, dict) and summary_screen.get("active") is True:
        contract = str(summary_screen.get("contract") or "")
        validation = str(summary_screen.get("validation") or "")
        source = str(summary_screen.get("source") or "PokemonSummaryOverlayManager.args.PokemonSummaryArgs")
        summary_contract_validations = {
            "ram_pokemon_summary_overlay_args_current_mon_v1": "pokemon_summary_overlay_args_data_current_mon_validated",
            "ram_party_menu_summary_panel_current_mon_v1": "party_menu_proc_state_summary_panel_current_mon_validated",
        }
        if summary_contract_validations.get(contract) != validation:
            return {
                "active": False,
                "source": source,
                "confidence": "unavailable",
                "contract": contract or "ram_pokemon_summary_overlay_args_current_mon_v1",
                "validation": validation or "missing",
                "reason": "summary_screen_contract_or_validation_not_validated",
            }
        mon = summary_screen.get("mon") if isinstance(summary_screen.get("mon"), dict) else {}
        species_id = safe_int(mon.get("species_id"), 0)
        nickname = sanitize_current_visible_text(mon.get("nickname"))
        name = nickname or pokemon_species_name(species_id, mon.get("species_name"))
        level = safe_int(mon.get("level"), 0)
        hp = safe_int(mon.get("current_hp"), 0)
        max_hp = safe_int(mon.get("max_hp"), 0)
        if not name or level <= 0 or max_hp <= 0:
            return {
                "active": False,
                "source": source,
                "confidence": "unavailable",
                "contract": contract,
                "validation": validation,
                "reason": "summary_screen_current_mon_missing",
            }
        status = pokemon_status_name(mon.get("status"))
        status_suffix = f" {status}" if status and status != "OK" else ""
        held_item_id = safe_int(mon.get("held_item_id"), 0)
        held_item = f" holding {item_name(held_item_id)}" if held_item_id > 0 and is_known_item_id(held_item_id) else ""
        cursor = sanitize_current_visible_text(summary_screen.get("cursor")) or sanitize_current_visible_text(
            f"{name} Lv{level} HP {hp}/{max_hp}{status_suffix}{held_item}"
        )
        items: List[Dict[str, Any]] = [{"text": cursor, "selected": True}]
        move_ids = mon.get("move_ids") if isinstance(mon.get("move_ids"), list) else []
        pp_values = mon.get("pp") if isinstance(mon.get("pp"), list) else []
        move_parts = []
        for move_index, move_id in enumerate(move_ids[:4]):
            safe_move_id = safe_int(move_id, 0)
            if safe_move_id <= 0:
                continue
            pp = safe_int(pp_values[move_index], 0) if move_index < len(pp_values) else 0
            move_parts.append(f"{move_name(safe_move_id)} PP {pp}")
        if move_parts:
            items.append({"text": sanitize_current_visible_text("Moves: " + ", ".join(move_parts)), "selected": False})
        stats_parts = [
            f"Atk {safe_int(mon.get('attack'), 0)}",
            f"Def {safe_int(mon.get('defense'), 0)}",
            f"SpA {safe_int(mon.get('special_attack'), 0)}",
            f"SpD {safe_int(mon.get('special_defense'), 0)}",
            f"Spe {safe_int(mon.get('speed'), 0)}",
        ]
        if any(part.split(" ")[1] != "0" for part in stats_parts):
            items.append({"text": sanitize_current_visible_text("Stats: " + ", ".join(stats_parts)), "selected": False})
        return {
            "active": True,
            "source": source,
            "confidence": "validated_ram",
            "contract": contract,
            "validation": validation,
            "title": "Pokemon summary",
            "cursor": cursor,
            "items": items,
        }

    if isinstance(party_menu, dict) and party_menu.get("active") is True:
        return _normalize_party_menu_projection(party_menu)

    bag_menu = text_probe.get("bag_menu") if isinstance(text_probe, dict) else {}
    if isinstance(bag_menu, dict) and bag_menu.get("active") is True:
        contract = str(bag_menu.get("contract") or "")
        validation = str(bag_menu.get("validation") or "")
        if (
            contract != "ram_bag_overlay_manager_args_bagview_cursor_current_items_v1"
            or validation != "bag_overlay_ovy15_bagview_cursor_slots_validated"
        ):
            return {
                "active": False,
                "source": "BagOverlayManager.args.BagView",
                "confidence": "unavailable",
                "contract": "ram_bag_overlay_manager_args_bagview_cursor_current_items_v1",
                "validation": validation or "missing",
                "reason": "bag_menu_contract_or_validation_not_validated",
            }
        pocket = sanitize_current_visible_text(bag_menu.get("pocket"))
        raw_items = bag_menu.get("items")
        items: List[Dict[str, Any]] = []
        if isinstance(raw_items, list):
            for entry in raw_items[:8]:
                if not isinstance(entry, dict):
                    continue
                item_id = safe_int(entry.get("item_id"), 0)
                quantity = safe_int(entry.get("quantity"), 0)
                text = sanitize_current_visible_text(entry.get("text"))
                if bag_menu.get("emptyPocket") is True and item_id == 0 and quantity == 0 and text:
                    items.append(
                        {
                            "text": text,
                            "selected": bool(entry.get("selected")),
                        }
                    )
                    continue
                if item_id <= 0 or quantity <= 0 or not is_known_item_id(item_id):
                    continue
                if not text:
                    text = sanitize_current_visible_text(f"{item_name(item_id)} x{quantity}")
                if not text:
                    continue
                items.append(
                    {
                        "text": text,
                        "selected": bool(entry.get("selected")),
                    }
                )
        cursor = sanitize_current_visible_text(bag_menu.get("cursor"))
        if not cursor:
            selected = next((item.get("text") for item in items if item.get("selected")), "")
            cursor = sanitize_current_visible_text(selected)
        if not pocket or not items or not cursor:
            return {
                "active": False,
                "source": "BagOverlayManager.args.BagView",
                "confidence": "unavailable",
                "contract": "ram_bag_overlay_manager_args_bagview_cursor_current_items_v1",
                "validation": validation,
                "reason": "bag_menu_visible_items_or_cursor_missing",
            }
        return {
            "active": True,
            "source": "BagOverlayManager.args.BagView",
            "confidence": "validated_ram",
            "contract": "ram_bag_overlay_manager_args_bagview_cursor_current_items_v1",
            "validation": validation,
            "pocket": pocket,
            "cursor": cursor,
            "items": items,
        }

    fly_map = text_probe.get("fly_map") if isinstance(text_probe, dict) else {}
    if isinstance(fly_map, dict) and fly_map.get("active") is True:
        contract = str(fly_map.get("contract") or "")
        validation = str(fly_map.get("validation") or "")
        if (
            contract != "ram_pokegear_flymap_overlay_args_cursor_current_destination_v1"
            or validation != "pokegear_flymap_overlay_owner_bound_cursor_destination_validated"
        ):
            return {
                "active": False,
                "source": "PokegearTownMapOverlay.args.PokegearArgs",
                "confidence": "unavailable",
                "contract": "ram_pokegear_flymap_overlay_args_cursor_current_destination_v1",
                "validation": validation or "missing",
                "reason": "fly_map_contract_or_validation_not_validated",
            }
        title = sanitize_current_visible_text(fly_map.get("title")) or (
            "Fly Map" if fly_map.get("isFlyMode") is True else "Town Map"
        )
        selected_destination_name = sanitize_current_visible_text(fly_map.get("selectedDestinationName"))
        if not selected_destination_name:
            selected_destination_map_id = safe_int(fly_map.get("selectedDestinationMapId"), -1)
            if selected_destination_map_id >= 0:
                selected_destination_name = sanitize_current_visible_text(
                    map_metadata(str(selected_destination_map_id)).get("name")
                )
        cursor_location_name = sanitize_current_visible_text(fly_map.get("cursorLocationName"))
        if not cursor_location_name:
            cursor_location_map_id = safe_int(fly_map.get("cursorLocationMapId"), -1)
            if cursor_location_map_id >= 0:
                cursor_location_name = sanitize_current_visible_text(
                    map_metadata(str(cursor_location_map_id)).get("name")
                )
        cursor = sanitize_current_visible_text(fly_map.get("cursor")) or selected_destination_name or cursor_location_name
        raw_items = fly_map.get("items")
        items: List[Dict[str, Any]] = []
        if isinstance(raw_items, list):
            for entry in raw_items[:4]:
                if not isinstance(entry, dict):
                    continue
                raw_text = sanitize_current_visible_text(entry.get("text"))
                if not raw_text:
                    continue
                text = raw_text
                if raw_text == "Fly" and selected_destination_name:
                    text = f"Fly to {selected_destination_name}"
                elif raw_text == "Destination" and selected_destination_name:
                    text = f"Destination: {selected_destination_name}"
                elif raw_text == "Cursor location" and cursor_location_name:
                    text = f"Cursor: {cursor_location_name}"
                text = sanitize_current_visible_text(text)
                if not text:
                    continue
                items.append({"text": text, "selected": bool(entry.get("selected"))})
        if not items:
            if selected_destination_name:
                items.append({"text": sanitize_current_visible_text(f"Destination: {selected_destination_name}"), "selected": True})
            elif cursor_location_name:
                items.append({"text": sanitize_current_visible_text(f"Cursor: {cursor_location_name}"), "selected": True})
        if not title or not cursor or not items:
            return {
                "active": False,
                "source": "PokegearTownMapOverlay.args.PokegearArgs",
                "confidence": "unavailable",
                "contract": "ram_pokegear_flymap_overlay_args_cursor_current_destination_v1",
                "validation": validation,
                "reason": "fly_map_visible_items_or_cursor_missing",
            }
        return {
            "active": True,
            "source": "PokegearTownMapOverlay.args.PokegearArgs",
            "confidence": "validated_ram",
            "contract": "ram_pokegear_flymap_overlay_args_cursor_current_destination_v1",
            "validation": validation,
            "title": title,
            "cursor": cursor,
            "items": items,
        }

    pokemon_storage = text_probe.get("pokemon_storage") if isinstance(text_probe, dict) else {}
    if isinstance(pokemon_storage, dict) and pokemon_storage.get("active") is True:
        contract = str(pokemon_storage.get("contract") or "")
        validation = str(pokemon_storage.get("validation") or "")
        if (
            contract != "ram_pcbox_overlay_args_storage_cursor_current_box_v1"
            or validation != "pcbox_overlay_args_storage_cursor_current_box_validated"
        ):
            return {
                "active": False,
                "source": "PCBoxOverlayManager.args.PCBoxArgs",
                "confidence": "unavailable",
                "contract": "ram_pcbox_overlay_args_storage_cursor_current_box_v1",
                "validation": validation or "missing",
                "reason": "pokemon_storage_contract_or_validation_not_validated",
            }
        title = sanitize_current_visible_text(pokemon_storage.get("title")) or "Pokemon Storage"
        box = sanitize_current_visible_text(pokemon_storage.get("currentBoxName")) or "Current box"
        cursor = sanitize_current_visible_text(pokemon_storage.get("cursor"))
        raw_items = pokemon_storage.get("items")
        items: List[Dict[str, Any]] = []
        if isinstance(raw_items, list):
            for entry in raw_items[:30]:
                if not isinstance(entry, dict):
                    continue
                text = sanitize_current_visible_text(entry.get("text"))
                if not text:
                    continue
                item = {"text": text, "selected": bool(entry.get("selected"))}
                items.append(item)
                if item["selected"] and not cursor:
                    cursor = text
        if not cursor or not items:
            return {
                "active": False,
                "source": "PCBoxOverlayManager.args.PCBoxArgs",
                "confidence": "unavailable",
                "contract": "ram_pcbox_overlay_args_storage_cursor_current_box_v1",
                "validation": validation,
                "reason": "pokemon_storage_visible_items_or_cursor_missing",
            }
        return {
            "active": True,
            "source": "PCBoxOverlayManager.args.PCBoxArgs",
            "confidence": "validated_ram",
            "contract": "ram_pcbox_overlay_args_storage_cursor_current_box_v1",
            "validation": validation,
            "title": title,
            "box": box,
            "cursor": cursor,
            "items": items,
        }

    pokedex = text_probe.get("pokedex") if isinstance(text_probe, dict) else {}
    if isinstance(pokedex, dict) and pokedex.get("active") is True:
        contract = str(pokedex.get("contract") or "")
        validation = str(pokedex.get("validation") or "")
        if (
            contract != "ram_pokedex_overlay_args_current_list_cursor_v1"
            or validation != "pokedex_overlay_args_current_list_cursor_validated"
        ):
            return {
                "active": False,
                "source": "PokedexOverlayManager.args.PokedexArgs",
                "confidence": "unavailable",
                "contract": "ram_pokedex_overlay_args_current_list_cursor_v1",
                "validation": validation or "missing",
                "reason": "pokedex_contract_or_validation_not_validated",
            }
        title = sanitize_current_visible_text(pokedex.get("title")) or "Pokedex"
        mode = sanitize_current_visible_text(pokedex.get("mode")) or "Pokedex"
        raw_items = pokedex.get("items")
        items: List[Dict[str, Any]] = []
        if isinstance(raw_items, list):
            for entry in raw_items[:15]:
                if not isinstance(entry, dict):
                    continue
                status = str(entry.get("status") or "").strip().lower()
                if status not in {"caught", "seen", "unknown"}:
                    status_raw = safe_int(entry.get("statusRaw", entry.get("status")), -1)
                    status = "caught" if status_raw == 2 else ("seen" if status_raw == 1 else "unknown")
                text = ""
                if status in {"caught", "seen"}:
                    species_id = safe_int(entry.get("speciesId", entry.get("species_id")), 0)
                    name = pokemon_species_name(species_id, entry.get("speciesName", entry.get("species_name")))
                    if name and not name.lower().startswith("species "):
                        text = f"{name} ({status})"
                    elif name:
                        text = f"{name} ({status})"
                else:
                    text = "???"
                text = sanitize_current_visible_text(text)
                if not text:
                    continue
                items.append({"text": text, "selected": bool(entry.get("selected"))})
        cursor = sanitize_current_visible_text(pokedex.get("cursor"))
        if not cursor:
            selected = next((item.get("text") for item in items if item.get("selected")), "")
            cursor = sanitize_current_visible_text(selected)
        if not title or not mode or not cursor or not items:
            return {
                "active": False,
                "source": "PokedexOverlayManager.args.PokedexArgs",
                "confidence": "unavailable",
                "contract": "ram_pokedex_overlay_args_current_list_cursor_v1",
                "validation": validation,
                "reason": "pokedex_visible_items_or_cursor_missing",
            }
        return {
            "active": True,
            "source": "PokedexOverlayManager.args.PokedexArgs",
            "confidence": "validated_ram",
            "contract": "ram_pokedex_overlay_args_current_list_cursor_v1",
            "validation": validation,
            "title": title,
            "mode": mode,
            "cursor": cursor,
            "items": items,
        }

    field = text_probe.get("field") if isinstance(text_probe, dict) else {}
    menu = field.get("menu") if isinstance(field, dict) else {}
    if not isinstance(menu, dict) or menu.get("active") is not True:
        return {
            "active": False,
            "source": "ScriptEnvironment.listMenu2D",
            "confidence": "unavailable",
            "contract": "ram_script_environment_list_menu_2d_current",
            "reason": menu.get("reason") if isinstance(menu, dict) else "field_menu_not_active",
        }
    raw_items = menu.get("items")
    items: List[Dict[str, Any]] = []
    if isinstance(raw_items, list):
        for item in raw_items[:32]:
            if not isinstance(item, dict):
                continue
            items.append(
                {
                    "index": safe_int(item.get("index"), -1),
                    "value": safe_int(item.get("value"), -9999),
                    "selected": bool(item.get("selected")),
                    "text": str(item.get("text") or ""),
                }
            )
    return {
        "active": True,
        "source": "ScriptEnvironment.listMenu2D",
        "confidence": "validated_ram",
        "contract": "ram_script_environment_list_menu_2d_current",
        "menuKind": str(menu.get("menuKind") or "list_menu_2d"),
        "selectedIndex": safe_int(menu.get("selectedIndex"), -1),
        "itemsWide": safe_int(menu.get("itemsWide"), 0),
        "itemsHigh": safe_int(menu.get("itemsHigh"), 0),
        "enableWrap": safe_int(menu.get("enableWrap"), 0),
        "scheduledScroll": safe_int(menu.get("scheduledScroll"), 0),
        "items": items,
    }


def normalize_naming_from_ram(naming: Any) -> Dict[str, Any]:
    if not isinstance(naming, dict):
        return {
            "active": False,
            "source": "NamingScreenAppData.entryBuf",
            "confidence": "unavailable",
            "contract": "hgss_naming_appdata_entry_buffer_v1",
            "validation": "missing",
        }
    validation = str(naming.get("validation") or "")
    active = naming.get("active") is True and validation == "naming_screen_appdata_entry_buffer_validated"
    if not active:
        return {
            "active": False,
            "source": "NamingScreenAppData.entryBuf",
            "confidence": "unavailable",
            "contract": "hgss_naming_appdata_entry_buffer_v1",
            "validation": validation or "not_found",
            "reason": naming.get("reason") or naming.get("lastReason"),
        }
    entry_text = sanitize_current_visible_text(naming.get("entryText"))
    max_len = safe_int(naming.get("maxLen"), 0)
    text_cursor_pos = safe_int(naming.get("textCursorPos"), len(entry_text))
    cursor = naming.get("cursor") if isinstance(naming.get("cursor"), dict) else {}
    return {
        "active": True,
        "source": "validated_ram_naming_screen_entry_buffer",
        "confidence": "validated_ram",
        "contract": "hgss_naming_appdata_entry_buffer_v1",
        "validation": validation,
        "screenType": safe_int(naming.get("screenType"), -1),
        "maxLen": max_len,
        "textCursorPos": text_cursor_pos,
        "entryText": entry_text[: max(0, max_len)],
        "entryLength": len(entry_text),
        "cursor": {
            "x": safe_int(cursor.get("x"), 0),
            "y": safe_int(cursor.get("y"), 0),
        },
    }


def normalize_battle_from_ram(ram: Dict[str, Any], party: List[Dict[str, Any]]) -> Dict[str, Any]:
    battle = ram.get("battle") if isinstance(ram.get("battle"), dict) else {}
    in_battle = bool(battle.get("in_battle_candidate"))
    if not in_battle:
        return {
            "enemy": None,
            "enemy_pokemons": [],
            "in_battle": False,
            "is_trainer_battle": False,
            "is_double_battle": False,
            "party_index": 0,
            "party_indices": [],
            "player_pokemon": None,
            "player_pokemons": [],
            "battle_input": {"available": False, "validation": "not_in_battle"},
            "source": battle.get("source") or "hgss_ram_battle_flag",
            "validation": battle.get("enemy_party_validation") or "not_in_battle",
        }

    active_battle = battle.get("active_battle") if isinstance(battle.get("active_battle"), dict) else {}
    raw_active_battlers = active_battle.get("battlers") if isinstance(active_battle.get("battlers"), list) else []
    active_player_pokemons: List[Dict[str, Any]] = []
    active_enemy_pokemons: List[Dict[str, Any]] = []
    active_issues: List[str] = []
    for index, mon in enumerate(raw_active_battlers):
        if not isinstance(mon, dict):
            active_issues.append(f"active_{index}:not_object")
            continue
        issue = ram_pokemon_validation_issue(mon)
        if issue:
            active_issues.append(f"active_{index}:{issue}")
            continue
        normalized = normalize_ram_pokemon(mon, index)
        side = str(mon.get("side") or normalized.get("side") or "")
        if side == "enemy":
            active_enemy_pokemons.append({**normalized, "position": f"enemy_{len(active_enemy_pokemons) + 1}"})
        elif side == "player":
            active_player_pokemons.append({**normalized, "position": f"player_{len(active_player_pokemons) + 1}"})
        else:
            active_issues.append(f"active_{index}:unknown_side")
    active_validation = str(battle.get("active_battle_validation") or active_battle.get("validation") or "")
    if (
        active_enemy_pokemons
        and active_player_pokemons
        and active_validation == "battle_context_battle_mons_validated"
        and not active_issues
    ):
        selected_indices = active_battle.get("selectedMonIndex") if isinstance(active_battle.get("selectedMonIndex"), list) else []
        safe_selected_indices = selected_indices if _valid_selected_mon_indices(selected_indices) else []
        battle_input = normalize_battle_input_state(active_battle, active_player_pokemons)
        return {
            "enemy": active_enemy_pokemons[0],
            "enemy_pokemons": active_enemy_pokemons,
            "in_battle": True,
            "is_trainer_battle": bool(active_battle.get("isTrainerBattle")),
            "is_double_battle": bool(active_battle.get("isDoubleBattle")),
            "party_index": safe_int(safe_selected_indices[0], 0) if safe_selected_indices else 0,
            "party_indices": [safe_int(value, 0) for value in safe_selected_indices],
            "player_pokemon": active_player_pokemons[0],
            "player_pokemons": active_player_pokemons,
            "battle_input": battle_input,
            "source": active_battle.get("source") or "BattleSystem->BattleContext.battleMons",
            "validation": active_validation,
            "battle_type": safe_int(active_battle.get("battleType"), 0),
            "max_battlers": safe_int(active_battle.get("maxBattlers"), len(raw_active_battlers)),
        }

    player_pokemons = [{**mon, "position": f"player_{index + 1}"} for index, mon in enumerate(party)]
    return {
        "enemy": None,
        "enemy_pokemons": [],
        "in_battle": True,
        "is_trainer_battle": bool(battle.get("is_trainer_battle")),
        "is_double_battle": bool(battle.get("is_double_battle")),
        "party_index": 0,
        "party_indices": list(range(len(player_pokemons))),
        "player_pokemon": player_pokemons[0] if player_pokemons else None,
        "player_pokemons": player_pokemons,
        "battle_input": {"available": False, "validation": battle.get("active_battle_validation") or "active_battle_unavailable"},
        "source": battle.get("source") or "hgss_ram_battle_flag",
        "validation": "active_battle_unavailable_enemy_party_not_shown",
        "not_shown_reason": "enemy_party_pointer_can_include_non_active_trainer_backline",
        "diagnostic_enemy_party_validation": battle.get("enemy_party_validation") or "not_validated",
        "diagnostic_enemy_party_count": len(battle.get("enemy_party") if isinstance(battle.get("enemy_party"), list) else []),
    }


def nearby_warps_from_events(events: Any, player_x: int, player_y: int) -> List[Dict[str, Any]]:
    if not isinstance(events, dict):
        return []
    warps = events.get("warps")
    if not isinstance(warps, list):
        return []
    nearby: List[Dict[str, Any]] = []
    for warp in warps:
        if not isinstance(warp, dict):
            continue
        try:
            x = int(warp.get("x"))
            y = int(warp.get("z"))
        except (TypeError, ValueError):
            continue
        distance = abs(x - int(player_x)) + abs(y - int(player_y))
        if distance > 1:
            continue
        nearby.append(
            {
                "x": x,
                "y": y,
                "localX": safe_int(warp.get("localX"), x),
                "localY": safe_int(warp.get("localY"), y),
                "distance": distance,
                "targetMapId": warp.get("destinationMapId"),
                "targetMapName": warp.get("destinationMapName"),
                "targetMapConstant": warp.get("destinationMapConstant"),
                "anchor": safe_int(warp.get("anchor"), 0),
                "confidence": "rom_derived",
                "source": "heartgold_rom_zone_event",
            }
        )
    nearby.sort(key=lambda item: (item["distance"], item["y"], item["x"]))
    return nearby


def visible_warps_from_events(events: Any, visible_area: Any, player_x: int, player_y: int) -> List[Dict[str, Any]]:
    if not isinstance(events, dict) or not isinstance(visible_area, dict):
        return []
    warps = events.get("warps")
    if not isinstance(warps, list):
        return []
    origin = visible_area.get("origin") if isinstance(visible_area.get("origin"), dict) else {}
    try:
        min_x = int(origin.get("x"))
        min_y = int(origin.get("y"))
        width = int(visible_area.get("width"))
        height = int(visible_area.get("height"))
    except (TypeError, ValueError):
        return []
    max_x = min_x + max(0, width) - 1
    max_y = min_y + max(0, height) - 1
    visible: List[Dict[str, Any]] = []
    for warp in warps:
        if not isinstance(warp, dict):
            continue
        try:
            x = int(warp.get("x"))
            y = int(warp.get("z"))
        except (TypeError, ValueError):
            continue
        if x < min_x or x > max_x or y < min_y or y > max_y:
            continue
        visible.append(
            {
                "x": x,
                "y": y,
                "localX": safe_int(warp.get("localX"), x),
                "localY": safe_int(warp.get("localY"), y),
                "distance": abs(x - int(player_x)) + abs(y - int(player_y)),
                "targetMapId": warp.get("destinationMapId"),
                "targetMapName": warp.get("destinationMapName"),
                "targetMapConstant": warp.get("destinationMapConstant"),
                "anchor": safe_int(warp.get("anchor"), 0),
                "confidence": "rom_derived_visible_current_map",
                "source": "heartgold_rom_zone_event_visible_viewport",
            }
        )
    visible.sort(key=lambda item: (item["distance"], item["y"], item["x"]))
    return visible[:8]


def visible_warp_view_evidence(
    events: Any,
    visible_area: Any,
    visible_warps: Any,
    player_x: int,
    player_y: int,
    map_id: Any,
) -> Dict[str, Any]:
    evidence: Dict[str, Any] = {
        "currentMapVerified": False,
        "eventsBankBoundToCurrentMap": False,
        "visibleViewportVerified": False,
        "playerPositionBoundToViewport": False,
        "warpsFilteredToVisibleView": False,
        "destinationLabelsUnavailable": True,
        "visibleCount": len(visible_warps) if isinstance(visible_warps, list) else 0,
    }
    if isinstance(events, dict):
        event_map_id = events.get("map_id")
        evidence["currentMapVerified"] = (
            event_map_id is not None
            and str(event_map_id) == str(map_id)
            and str(map_id).lower() not in {"", "unknown", "none", "0", "0-0"}
        )
        evidence["eventsBankBoundToCurrentMap"] = evidence["currentMapVerified"] and events.get("eventsBank") is not None
    if isinstance(visible_area, dict):
        origin = visible_area.get("origin") if isinstance(visible_area.get("origin"), dict) else {}
        try:
            min_x = int(origin.get("x"))
            min_y = int(origin.get("y"))
            width = int(visible_area.get("width"))
            height = int(visible_area.get("height"))
            max_x = min_x + width - 1
            max_y = min_y + height - 1
            evidence["visibleViewportVerified"] = width > 0 and height > 0
            evidence["playerPositionBoundToViewport"] = (
                evidence["visibleViewportVerified"]
                and min_x <= int(player_x) <= max_x
                and min_y <= int(player_y) <= max_y
            )
            if isinstance(visible_warps, list):
                evidence["warpsFilteredToVisibleView"] = all(
                    isinstance(warp, dict)
                    and min_x <= int(warp.get("x")) <= max_x
                    and min_y <= int(warp.get("y")) <= max_y
                    for warp in visible_warps
                )
        except (TypeError, ValueError):
            pass
    return evidence


def static_object_lookup(rom_events: Any) -> Dict[tuple[int, int, int], Dict[str, Any]]:
    if not isinstance(rom_events, dict):
        return {}
    candidates = rom_events.get("objectEventCandidates")
    if not isinstance(candidates, list):
        return {}
    out: Dict[tuple[int, int, int], Dict[str, Any]] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        object_id = safe_int(candidate.get("id"), -1)
        x = safe_int(candidate.get("localX", candidate.get("x")), -1)
        y = safe_int(candidate.get("localY", candidate.get("z")), -1)
        if object_id >= 0 and x >= 0 and y >= 0:
            out[(object_id, x, y)] = candidate
    return out


def point_in_visible_area(visible_area: Any, x: int, y: int) -> bool:
    if not isinstance(visible_area, dict):
        return False
    origin = visible_area.get("origin") if isinstance(visible_area.get("origin"), dict) else {}
    try:
        origin_x = int(origin.get("x"))
        origin_y = int(origin.get("y"))
        width = int(visible_area.get("width"))
        height = int(visible_area.get("height"))
    except (TypeError, ValueError):
        return False
    if width <= 0 or height <= 0:
        return False
    return origin_x <= int(x) < origin_x + width and origin_y <= int(y) < origin_y + height


def facing_target(player_x: int, player_y: int, player_facing: str) -> tuple[int, int] | None:
    delta = DIRECTION_DELTAS.get(str(player_facing or "").lower())
    if not delta:
        return None
    dx, dy = delta
    return int(player_x) + int(dx), int(player_y) + int(dy)


def _static_grid_tile_at(minimap_data: Any, x: int, y: int) -> int | None:
    if not isinstance(minimap_data, dict):
        return None
    if minimap_data.get("static_confidence") != "rom_derived":
        return None
    static_grid = minimap_data.get("static_grid")
    if not isinstance(static_grid, list):
        return None
    origin_x = safe_int(minimap_data.get("static_origin_x"), 0)
    origin_y = safe_int(minimap_data.get("static_origin_y"), 0)
    row_index = int(y) - origin_y
    col_index = int(x) - origin_x
    if row_index < 0 or row_index >= len(static_grid):
        return None
    row = static_grid[row_index]
    if not isinstance(row, list) or col_index < 0 or col_index >= len(row):
        return None
    try:
        return int(row[col_index])
    except (TypeError, ValueError):
        return None


def field_move_affordances_from_minimap(
    minimap_data: Any,
    player_x: int,
    player_y: int,
    player_facing: str,
) -> Dict[str, Any]:
    facing = str(player_facing or "").lower()
    target = facing_target(player_x, player_y, facing)
    base = {
        "available": False,
        "source": "heartgold_rom_land_data_current_facing_tile",
        "confidence": "unavailable",
        "contract": FIELD_MOVE_AFFORDANCE_CONTRACT,
        "facing": facing or "unknown",
        "target": None,
        "affordances": [],
    }
    if not target:
        return base
    tx, ty = target
    base["target"] = {"x": int(tx), "y": int(ty)}
    tile = _static_grid_tile_at(minimap_data, tx, ty)
    if tile is None:
        return base
    match = FIELD_MOVE_AFFORDANCE_BY_STATIC_TILE.get(tile)
    if not match:
        base["confidence"] = "rom_derived"
        return base
    base["available"] = True
    base["confidence"] = "rom_derived"
    base["affordances"] = [
        {
            "move": match["move"],
            "target": match["target"],
            "x": int(tx),
            "y": int(ty),
            "requiredFacing": facing or "unknown",
        }
    ]
    return base


def merge_runtime_field_move_affordances(
    field_move_affordances: Any,
    runtime_objects_visible: Any,
) -> Dict[str, Any]:
    if isinstance(field_move_affordances, dict):
        result = dict(field_move_affordances)
        result["affordances"] = [
            dict(item) for item in field_move_affordances.get("affordances", []) if isinstance(item, dict)
        ]
    else:
        result = {
            "available": False,
            "source": "heartgold_current_facing_tile_or_object",
            "confidence": "unavailable",
            "contract": FIELD_MOVE_AFFORDANCE_CONTRACT,
            "facing": "unknown",
            "target": None,
            "affordances": [],
        }
    if not isinstance(runtime_objects_visible, list):
        return result
    seen = {
        (str(item.get("move") or ""), str(item.get("target") or ""))
        for item in result.get("affordances", [])
        if isinstance(item, dict)
    }
    for entry in runtime_objects_visible:
        if not isinstance(entry, dict) or entry.get("inFrontOfPlayer") is not True:
            continue
        label = str(entry.get("objectLabel") or entry.get("name") or "").strip().lower().replace(" ", "")
        match = FIELD_MOVE_AFFORDANCE_BY_RUNTIME_OBJECT_LABEL.get(label)
        if not match:
            continue
        key = (str(match.get("move") or ""), str(match.get("target") or ""))
        if key in seen:
            continue
        seen.add(key)
        result["available"] = True
        result["source"] = "FieldSystem.mapObjectManager_current_facing_object"
        result["confidence"] = "validated_ram"
        result["contract"] = FIELD_MOVE_AFFORDANCE_CONTRACT
        result["target"] = {"x": safe_int(entry.get("x"), 0), "y": safe_int(entry.get("y"), 0)}
        result["affordances"].append({"move": match["move"], "target": match["target"]})
    return result


def field_move_affordance_evidence(
    field_move_affordances: Any,
    resolved_position: Any,
    coordinate_confidence: str,
    position_confidence: str,
    facing_confidence: str,
) -> Dict[str, Any]:
    data = field_move_affordances if isinstance(field_move_affordances, dict) else {}
    position = resolved_position if isinstance(resolved_position, dict) else {}
    affordances = data.get("affordances") if isinstance(data.get("affordances"), list) else []
    target = data.get("target") if isinstance(data.get("target"), dict) else None
    confidence = str(data.get("confidence") or "").lower()
    facing = str(position.get("facing") or data.get("facing") or "").lower()
    decoded_confidence = confidence in {"rom_derived", "validated_ram", "validated_current", "verified", "verified_ram"}
    target_decoded = target is not None and decoded_confidence
    return {
        "currentPositionVerified": bool(
            coordinate_confidence == "high"
            and position_confidence == "high"
            and position.get("liveRam") is True
        ),
        "currentFacingVerified": bool(
            facing_confidence in {"validated_ram", "validated_current", "verified", "verified_ram"}
            and facing in DIRECTION_DELTAS
        ),
        "currentFacingTileFromRomLandDataOrCurrentFacingObjectFromMapObjectManager": bool(target_decoded),
        "fieldMoveOrObstacleMetatileOrObjectPredicateDecoded": bool(target_decoded),
        "affordanceCount": len(affordances),
    }


def static_grid_visible_area(static_grid: Any, origin_x: int, origin_y: int, visible_area: Any) -> Dict[str, Any] | None:
    if not isinstance(static_grid, list) or not isinstance(visible_area, dict):
        return None
    origin = visible_area.get("origin") if isinstance(visible_area.get("origin"), dict) else {}
    try:
        view_x = int(origin.get("x"))
        view_y = int(origin.get("y"))
        width = int(visible_area.get("width"))
        height = int(visible_area.get("height"))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    grid: List[List[Any]] = []
    for yy in range(view_y, view_y + height):
        row: List[Any] = []
        static_y = yy - int(origin_y)
        for xx in range(view_x, view_x + width):
            static_x = xx - int(origin_x)
            if 0 <= static_y < len(static_grid) and isinstance(static_grid[static_y], list) and 0 <= static_x < len(static_grid[static_y]):
                row.append(static_grid[static_y][static_x])
            else:
                row.append(None)
        grid.append(row)
    out = dict(visible_area)
    out["grid"] = grid
    out["source"] = "heartgold_rom_visible_viewport_current_position"
    out["gridSource"] = "rom_static_collision_and_visible_interactives"
    return out


def visible_interactables_from_events(events: Any, visible_area: Any, player_x: int, player_y: int, player_facing: str = "") -> Dict[str, Any]:
    contract = "rom_derived_visible_current_map_bg_events_no_raw_scripts"
    if not isinstance(events, dict) or not isinstance(visible_area, dict):
        return {
            "available": False,
            "source": "heartgold_rom_zone_event_visible_bg_events",
            "confidence": "unavailable",
            "contract": contract,
            "entries": [],
            "visibleCount": 0,
        }
    raw_bgs = events.get("bgEvents") if isinstance(events.get("bgEvents"), list) else []
    target = facing_target(player_x, player_y, player_facing)

    def use_from_tiles(x: int, y: int) -> List[Dict[str, Any]]:
        tiles = [
            {"x": x, "y": y - 1, "requiredFacing": "down"},
            {"x": x, "y": y + 1, "requiredFacing": "up"},
            {"x": x - 1, "y": y, "requiredFacing": "right"},
            {"x": x + 1, "y": y, "requiredFacing": "left"},
        ]
        out: List[Dict[str, Any]] = []
        for tile in tiles:
            tx = safe_int(tile.get("x"), -1)
            ty = safe_int(tile.get("y"), -1)
            if tx < 0 or ty < 0:
                continue
            out.append({"x": tx, "y": ty, "requiredFacing": str(tile["requiredFacing"])})
        out.sort(key=lambda item: (abs(item["x"] - int(player_x)) + abs(item["y"] - int(player_y)), item["y"], item["x"]))
        return out

    entries: List[Dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    for bg in raw_bgs:
        if not isinstance(bg, dict):
            continue
        # pret fieldmap.c uses BG_EVENT type 2 for hidden item checks. Keep these
        # out of the model-visible interactable surface.
        if safe_int(bg.get("type"), -1) == 2:
            continue
        x = safe_int(bg.get("localX", bg.get("x")), -1)
        y = safe_int(bg.get("localY", bg.get("z")), -1)
        if x < 0 or y < 0 or not point_in_visible_area(visible_area, x, y):
            continue
        key = (x, y)
        if key in seen:
            continue
        seen.add(key)
        distance = abs(x - int(player_x)) + abs(y - int(player_y))
        required_facing = "unknown"
        in_front = bool(target and target[0] == x and target[1] == y)
        if x == int(player_x) and y == int(player_y) - 1:
            required_facing = "up"
        elif x == int(player_x) and y == int(player_y) + 1:
            required_facing = "down"
        elif x == int(player_x) - 1 and y == int(player_y):
            required_facing = "left"
        elif x == int(player_x) + 1 and y == int(player_y):
            required_facing = "right"
        entries.append(
            {
                "kind": "check",
                "x": x,
                "y": y,
                "distance": distance,
                "useFrom": use_from_tiles(x, y),
                "requiredFacing": required_facing,
                "inFrontOfPlayer": in_front,
                "source": "heartgold_rom_zone_event_visible_bg_event",
                "confidence": "rom_derived",
                "contract": "current_visible_bg_event_interactable_no_raw_script",
            }
        )
    entries.sort(key=lambda item: (item["distance"], item["y"], item["x"]))
    current = next((entry for entry in entries if entry.get("inFrontOfPlayer") is True), None)
    return {
        "available": True,
        "source": "heartgold_rom_zone_event_visible_bg_events",
        "confidence": "rom_derived",
        "contract": contract,
        "entries": entries[:32],
        "visibleCount": len(entries),
        "current": current,
    }


def merge_runtime_object_interactables(
    visible_interactables: Any,
    runtime_objects_visible: Any,
    visible_area: Any,
    player_x: int,
    player_y: int,
    player_facing: str = "",
) -> Dict[str, Any]:
    base = visible_interactables if isinstance(visible_interactables, dict) else {}
    entries = [dict(item) for item in base.get("entries", []) if isinstance(item, dict)]
    current = base.get("current") if isinstance(base.get("current"), dict) else None
    if not isinstance(runtime_objects_visible, list):
        return {
            **base,
            "entries": entries,
            "visibleCount": len(entries),
            "current": current,
        }

    target = facing_target(player_x, player_y, player_facing)
    seen = {
        (str(item.get("kind") or ""), safe_int(item.get("x"), -1), safe_int(item.get("y"), -1))
        for item in entries
        if isinstance(item, dict)
    }

    def use_from_tiles(x: int, y: int) -> List[Dict[str, Any]]:
        tiles = [
            {"x": x, "y": y - 1, "requiredFacing": "down"},
            {"x": x, "y": y + 1, "requiredFacing": "up"},
            {"x": x - 1, "y": y, "requiredFacing": "right"},
            {"x": x + 1, "y": y, "requiredFacing": "left"},
        ]
        out: List[Dict[str, Any]] = []
        for tile in tiles:
            tx = safe_int(tile.get("x"), -1)
            ty = safe_int(tile.get("y"), -1)
            if tx < 0 or ty < 0:
                continue
            if isinstance(visible_area, dict) and not point_in_visible_area(visible_area, tx, ty):
                continue
            out.append({"x": tx, "y": ty, "requiredFacing": str(tile["requiredFacing"])})
        out.sort(key=lambda item: (abs(item["x"] - int(player_x)) + abs(item["y"] - int(player_y)), item["y"], item["x"]))
        return out

    for obj in runtime_objects_visible:
        if not isinstance(obj, dict):
            continue
        if obj.get("isVisible") is not True and obj.get("visible") is not True:
            continue
        if obj.get("isBlocking") is not True and obj.get("blocking") is not True:
            continue
        x = safe_int(obj.get("x"), -1)
        y = safe_int(obj.get("y"), -1)
        if x < 0 or y < 0 or (isinstance(visible_area, dict) and not point_in_visible_area(visible_area, x, y)):
            continue
        key = ("talk", x, y)
        if key in seen:
            continue
        seen.add(key)
        distance = abs(x - int(player_x)) + abs(y - int(player_y))
        required_facing = "unknown"
        if x == int(player_x) and y == int(player_y) - 1:
            required_facing = "up"
        elif x == int(player_x) and y == int(player_y) + 1:
            required_facing = "down"
        elif x == int(player_x) - 1 and y == int(player_y):
            required_facing = "left"
        elif x == int(player_x) + 1 and y == int(player_y):
            required_facing = "right"
        in_front = bool(target and target[0] == x and target[1] == y)
        entry = {
            "kind": "talk",
            "targetType": "npc",
            "name": obj.get("name") or obj.get("objectLabel") or "npc",
            "x": x,
            "y": y,
            "distance": distance,
            "useFrom": use_from_tiles(x, y),
            "requiredFacing": required_facing,
            "inFrontOfPlayer": in_front,
            "source": "FieldSystem.mapObjectManager_visible_runtime_object",
            "confidence": "validated_ram",
            "contract": "current_visible_runtime_object_talk_interactable_v1",
        }
        entries.append(entry)
        if in_front:
            current = entry

    entries.sort(key=lambda item: (safe_int(item.get("distance"), 9999), safe_int(item.get("y"), 9999), safe_int(item.get("x"), 9999), str(item.get("kind") or "")))
    return {
        **base,
        "available": bool(entries) or bool(base.get("available", False)),
        "source": "heartgold_rom_bg_events_plus_runtime_object_interactables",
        "confidence": "validated_ram" if entries else base.get("confidence", "unavailable"),
        "contract": "current_visible_interactable_affordances_v2",
        "entries": entries[:32],
        "visibleCount": len(entries),
        "current": current,
    }


def visible_interactable_view_evidence(events: Any, visible_area: Any, visible_interactables: Any) -> Dict[str, Any]:
    """Audit-only proof for visible BG_EVENT interactables; not player text."""
    raw_bgs = events.get("bgEvents") if isinstance(events, dict) and isinstance(events.get("bgEvents"), list) else []
    confidence = str(events.get("confidence") or "") if isinstance(events, dict) else ""
    source = str(events.get("source") or "") if isinstance(events, dict) else ""
    visible_count = (
        safe_int(visible_interactables.get("visibleCount"), 0)
        if isinstance(visible_interactables, dict)
        else 0
    )
    return {
        "currentMapVerified": bool(
            isinstance(events, dict)
            and (
                confidence in {"rom_derived", "rom_derived_static"}
                or "zone_event" in source
                or isinstance(events.get("bgEvents"), list)
            )
        ),
        "bgEventsVisibleInCurrentView": bool(isinstance(visible_area, dict) and isinstance(raw_bgs, list)),
        "hiddenItemBgEventsFiltered": bool(isinstance(raw_bgs, list)),
        "visibleCount": visible_count,
    }


def runtime_object_root_binding_evidence(runtime_objects: Dict[str, Any], available: bool, semantic_map_id: str, map_id: str) -> Dict[str, Any]:
    """Internal proof that runtime objects came from the active FieldSystem root."""

    def flag(name: str) -> bool:
        return runtime_objects.get(name) is True

    semantic_matches_current = bool(
        str(semantic_map_id or "").lower() not in {"", "unknown", "none"}
        and str(map_id or "").lower() not in {"", "unknown", "none"}
        and str(semantic_map_id) == str(map_id)
    )
    return {
        "managerFieldSystemBound": flag("managerFieldSystemBound"),
        "fieldSystemManagerBound": flag("fieldSystemManagerBound"),
        "playerAvatarObjectBound": flag("playerAvatarObjectBound"),
        "playerStrideMember": flag("playerStrideMember"),
        "objectCountValid": flag("objectCountValid"),
        "objectsPtrValid": flag("objectsPtrValid"),
        "currentMapBound": flag("currentMapBound") or (available and semantic_matches_current),
    }


def normalize_runtime_map_objects(runtime_objects: Any, player_x: int, player_y: int, map_id: str, rom_events: Any = None, player_facing: str = "", visible_area: Any = None) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    if not isinstance(runtime_objects, dict):
        return [], [], {
            "available": False,
            "source": "not_decoded",
            "confidence": "unknown",
            "contract": "runtime_map_objects_missing",
            "reason": "runtime_objects_missing",
            "count": 0,
        }
    entries = runtime_objects.get("entries")
    if not isinstance(entries, list):
        entries = []
    available = bool(runtime_objects.get("available")) and str(runtime_objects.get("contract") or "") == "fieldsystem_mapobjectmanager_root_bound_visible_runtime_objects_v1"
    semantic_map_id = str(runtime_objects.get("semanticMapId") or map_id or "unknown")
    root_binding = runtime_object_root_binding_evidence(runtime_objects, available, semantic_map_id, map_id)
    if not available:
        return [], [], {
            "available": False,
            "source": runtime_objects.get("source") or "FieldSystem.mapObjectManager",
            "confidence": "candidate",
            "contract": runtime_objects.get("contract") or "runtime_map_objects_missing",
            "reason": runtime_objects.get("reason") or "runtime_objects_not_root_bound_to_current_fieldsystem",
            "count": 0,
            "visibleCount": 0,
            "objectCount": safe_int(runtime_objects.get("objectCount"), len(entries)),
            "staticBoundCount": 0,
            "semanticMapId": semantic_map_id,
            "rootBinding": root_binding,
        }
    static_lookup = static_object_lookup(rom_events)
    normalized: List[Dict[str, Any]] = []
    visible: List[Dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict) or bool(entry.get("is_player")):
            continue
        x = safe_int(entry.get("x"), -1)
        y = safe_int(entry.get("y"), -1)
        initial_x = safe_int(entry.get("initial_x"), x)
        initial_y = safe_int(entry.get("initial_y"), y)
        if x < 0 or y < 0 or x > 4096 or y > 4096:
            continue
        facing, _, facing_confidence = facing_from_local_map_object(entry.get("facing"))
        distance = abs(x - int(player_x)) + abs(y - int(player_y))
        required_facing = "unknown"
        in_front_of_player = False
        if distance == 1:
            dx = x - int(player_x)
            dy = y - int(player_y)
            if dx == 0 and dy == -1:
                required_facing = "up"
            elif dx == 0 and dy == 1:
                required_facing = "down"
            elif dx == -1 and dy == 0:
                required_facing = "left"
            elif dx == 1 and dy == 0:
                required_facing = "right"
            player_facing_normalized = str(player_facing or "").lower()
            in_front_of_player = bool(required_facing != "unknown" and player_facing_normalized == required_facing)
        static_match = static_lookup.get((safe_int(entry.get("object_id"), -1), initial_x, initial_y))
        static_bound = isinstance(static_match, dict)
        semantic_kind = "npc" if static_bound else "runtime_object"
        sprite_id = safe_int(static_match.get("spriteId") if static_bound else entry.get("sprite_id"), -1)
        object_label = sprite_role_name(sprite_id)
        active_flag = bool(entry.get("active_flag"))
        visible_flag = bool(entry.get("visible_flag"))
        viewport_visible = point_in_visible_area(visible_area, x, y)
        model_visible = active_flag and (visible_flag or (static_bound and viewport_visible))
        blocking = active_flag and model_visible
        obj = {
            "id": safe_int(entry.get("object_id"), -1),
            "localId": safe_int(entry.get("object_id"), -1),
            "uid": f"hgss-runtime-object-{semantic_map_id}-{safe_int(entry.get('object_id'), -1)}-{initial_x}-{initial_y}",
            "x": x,
            "y": y,
            "initial_x": initial_x,
            "initial_y": initial_y,
            "elevation": safe_int(entry.get("z"), 0),
            "type": semantic_kind,
            "name": object_label or f"{semantic_kind}_{safe_int(entry.get('object_id'), -1)}",
            "objectLabel": object_label or semantic_kind,
            "isActive": active_flag,
            "isVisible": model_visible,
            "isBlocking": blocking,
            "isAdjacent": distance == 1,
            "isInteractableCandidate": distance == 1 and model_visible and in_front_of_player,
            "requiredFacing": required_facing,
            "inFrontOfPlayer": in_front_of_player,
            "facing": facing or "unknown",
            "facing_raw": safe_int(entry.get("facing"), -1),
            "facing_confidence": facing_confidence,
            "initial_facing_raw": safe_int(entry.get("initial_facing"), -1),
            "sprite_id": sprite_id,
            "movement": safe_int(entry.get("movement"), -1),
            "object_type": safe_int(entry.get("object_type"), -1),
            "x_range": safe_int(entry.get("x_range"), 0),
            "y_range": safe_int(entry.get("y_range"), 0),
            "staticObjectBound": static_bound,
            "staticObjectSource": "heartgold_rom_zone_event_current_map" if static_bound else None,
            "distance": distance,
            "map_id": semantic_map_id,
            "source": "FieldSystem.mapObjectManager",
            "confidence": "validated_ram" if available else "candidate",
            "contract": "current_runtime_map_object_bound_to_current_static_object" if static_bound else "current_runtime_map_object",
        }
        normalized.append(obj)
        if model_visible:
            visible.append(obj)
    normalized.sort(key=lambda item: (item["distance"], item["y"], item["x"], item["id"]))
    visible.sort(key=lambda item: (item["distance"], item["y"], item["x"], item["id"]))
    confidence = "validated_ram" if available else "candidate"
    summary = {
        "available": available,
        "source": runtime_objects.get("source") or "FieldSystem.mapObjectManager",
        "confidence": confidence,
        "contract": runtime_objects.get("contract") or "runtime_map_objects_missing",
        "count": len(normalized),
        "visibleCount": len(visible),
        "objectCount": safe_int(runtime_objects.get("objectCount"), len(entries)),
        "staticBoundCount": sum(1 for item in normalized if item.get("staticObjectBound") is True),
        "semanticMapId": semantic_map_id,
        "rootBinding": root_binding,
        "reason": runtime_objects.get("reason"),
    }
    return normalized, visible, summary


def movement_mode_from_ram(ram_player: Dict[str, Any]) -> str:
    movement = ram_player.get("movement") if isinstance(ram_player.get("movement"), dict) else {}
    vehicle = movement.get("vehicle")
    if vehicle == 0x1:
        return "BIKING"
    if vehicle == 0x2:
        return "SURFING"
    index = movement.get("index")
    if isinstance(index, int) and 0 <= index <= 3:
        return "MOVING"
    if isinstance(movement.get("raw"), int):
        return "WALK"
    return "UNKNOWN"


def vehicle_state_from_ram(ram_player: Dict[str, Any]) -> Dict[str, Any]:
    movement = ram_player.get("movement") if isinstance(ram_player.get("movement"), dict) else {}
    vehicle = movement.get("vehicle")
    if not isinstance(vehicle, int):
        return {
            "vehicle": "unknown",
            "surfing": False,
            "biking": False,
            "bikeType": None,
            "diving": False,
            "confidence": "unknown",
            "contract": "player_vehicle_state_required",
        }
    if vehicle == 0x0:
        label = "foot"
    elif vehicle == 0x1:
        label = "bicycle"
    elif vehicle == 0x2:
        label = "surfing"
    else:
        return {
            "vehicle": "unknown",
            "surfing": False,
            "biking": False,
            "bikeType": None,
            "diving": False,
            "confidence": "unknown",
            "contract": "player_vehicle_state_unknown",
        }
    return {
        "vehicle": label,
        "surfing": vehicle == 0x2,
        "biking": vehicle == 0x1,
        "bikeType": "bicycle" if vehicle == 0x1 else None,
        "diving": False,
        "confidence": "validated_ram",
        "contract": "ram_localmapobject_movement_mode_and_vehicle_current_v1",
    }


def movement_mode_reliability(ram_player: Dict[str, Any], movement_mode: str) -> Dict[str, Any]:
    movement = ram_player.get("movement") if isinstance(ram_player.get("movement"), dict) else {}
    vehicle_state = vehicle_state_from_ram(ram_player)
    raw = movement.get("raw")
    index = movement.get("index")
    vehicle_validated = vehicle_state.get("confidence") == "validated_ram"
    validated = movement_mode in {"WALK", "MOVING", "BIKING", "SURFING"} and isinstance(raw, int)
    return {
        "source": "LocalMapObject.movement+player_vehicle_state" if vehicle_validated else "LocalMapObject.movement",
        "confidence": "validated_ram" if validated else "unknown",
        "value": movement_mode,
        "contract": (
            "ram_localmapobject_movement_mode_and_vehicle_current_v1"
            if validated and vehicle_validated
            else "ram_localmapobject_movement_mode_current_v1"
            if validated
            else "local_map_object_movement_mode_required"
        ),
        "raw": raw,
        "index": index,
        "vehicle": vehicle_state,
    }


def movement_mode_evidence(movement_reliability: Any, resolved_position: Any) -> Dict[str, Any]:
    data = movement_reliability if isinstance(movement_reliability, dict) else {}
    position = resolved_position if isinstance(resolved_position, dict) else {}
    vehicle = data.get("vehicle") if isinstance(data.get("vehicle"), dict) else {}
    mode = str(data.get("value") or "")
    vehicle_label = str(vehicle.get("vehicle") or "")
    current_bound = data.get("confidence") == "validated_ram" and position.get("liveRam") is True
    return {
        "currentPlayerLocalMapObjectBound": bool(current_bound),
        "movementModeDecoded": bool(current_bound and mode in {"WALK", "MOVING", "BIKING", "SURFING"}),
        "vehicleStateDecoded": bool(current_bound and vehicle.get("confidence") == "validated_ram" and vehicle_label in {"foot", "bicycle", "surfing"}),
        "movementMode": mode if mode else "UNKNOWN",
        "vehicle": vehicle_label if vehicle_label else "unknown",
    }


def movement_reliability_with_currentness(
    movement_reliability: Dict[str, Any],
    movement_evidence: Dict[str, Any],
) -> Dict[str, Any]:
    data = dict(movement_reliability) if isinstance(movement_reliability, dict) else {}
    evidence = movement_evidence if isinstance(movement_evidence, dict) else {}
    data["movementModeEvidence"] = evidence
    if data.get("confidence") != "validated_ram":
        return data
    if (
        evidence.get("currentPlayerLocalMapObjectBound") is True
        and evidence.get("movementModeDecoded") is True
        and evidence.get("vehicleStateDecoded") is True
    ):
        return data

    vehicle = data.get("vehicle") if isinstance(data.get("vehicle"), dict) else {}
    data["confidence"] = "candidate"
    data["contract"] = "local_map_object_movement_currentness_required"
    data["source"] = data.get("source") or "LocalMapObject.movement"
    data["vehicle"] = {
        **vehicle,
        "confidence": "candidate",
        "contract": "player_vehicle_state_currentness_required",
    }
    return data


def facing_from_local_map_object(value: Any) -> tuple[Optional[str], str, str]:
    if value is None:
        return None, "local_map_object_current_facing_missing", "unknown"
    try:
        raw = int(value)
    except (TypeError, ValueError):
        return None, "local_map_object_current_facing_invalid", "unknown"
    direction = {
        0: "up",
        1: "down",
        2: "left",
        3: "right",
    }.get(raw)
    if direction is None:
        return None, "local_map_object_current_facing_unknown", "unknown"
    return direction, "local_map_object_current_facing", "verified_ram"


class HeartGoldBridge:
    def __init__(self) -> None:
        self.bizhawk_exe = env_path("BIZHAWK_EXE", DEFAULT_BIZHAWK_EXE)
        self.rom_path = env_path("HEARTGOLD_ROM", DEFAULT_ROM)
        self.runtime_dir = env_path("HEARTGOLD_RUNTIME_DIR", DEFAULT_RUNTIME)
        self.ipc_dir = self.runtime_dir / "ipc"
        self.screenshot_path = self.runtime_dir / "screenshots" / "ds_raw.png"
        self.observation_screenshot_dir = self.runtime_dir / "screenshots" / "observations"
        self.heartbeat_path = self.ipc_dir / "heartbeat.json"
        self.request_path = self.ipc_dir / "request.txt"
        self.response_path = self.ipc_dir / "response.txt"
        self.emulator_pid_path = self.runtime_dir / "emuhawk_pid.txt"
        self.emulator_scheduling_path = self.runtime_dir / "emuhawk_scheduling.json"
        self.runtime_lua_path = self.runtime_dir / "HeartGoldBridge.runtime.lua"
        self.touch_config_repair_path = self.runtime_dir / "bizhawk_touch_config_repair.json"
        self.performance_config_repair_path = self.runtime_dir / "bizhawk_performance_config_repair.json"
        self.process: Optional[subprocess.Popen] = None
        self.minimap_store = HeartGoldMinimapStore(self.runtime_dir / "minimaps")
        self.rom_data = HeartGoldRomData(self.rom_path, self.runtime_dir / "rom_cache")
        self.observed_position_path = self.runtime_dir / "observed_positions.json"
        self.position_lock = threading.RLock()
        self.last_facing: Optional[str] = None
        self.last_position_calibration_attempt_s = 0.0
        self.heartbeat_max_age_s = float(os.environ.get("HEARTGOLD_HEARTBEAT_MAX_AGE_S", "5.0"))
        self.bootstrap_on_launch = os.environ.get("HEARTGOLD_BOOTSTRAP_ON_LAUNCH", "false").lower() == "true"
        self.request_lock = threading.RLock()
        self.observation_mode = env_observation_mode()
        self.expose_oracle = os.environ.get("HEARTGOLD_EXPOSE_ORACLE", "false").lower() == "true"
        self.confidence_required = os.environ.get("HEARTGOLD_STATE_CONFIDENCE_REQUIRED", "true").lower() != "false"
        self.action_settle_frames = env_action_settle_frames()
        self.low_stall_actions = env_low_stall_actions()
        self.temporal_sample_count = max(0, min(8, safe_int(os.environ.get("HEARTGOLD_TEMPORAL_SAMPLE_COUNT"), 0)))
        self.temporal_sample_frames = max(1, min(60, safe_int(os.environ.get("HEARTGOLD_TEMPORAL_SAMPLE_FRAMES"), 12)))
        try:
            self.full_snapshot_timeout_s = float(os.environ.get("HEARTGOLD_FULL_SNAPSHOT_TIMEOUT_S", "20.0"))
        except ValueError:
            self.full_snapshot_timeout_s = 20.0
        self.full_snapshot_timeout_s = max(1.0, min(self.full_snapshot_timeout_s, 45.0))
        try:
            self.request_lock_timeout_s = float(os.environ.get("HEARTGOLD_REQUEST_LOCK_TIMEOUT_S", "2.0"))
        except ValueError:
            self.request_lock_timeout_s = 2.0
        self.request_lock_timeout_s = max(0.1, min(self.request_lock_timeout_s, 10.0))
        self.last_temporal_observation: Optional[Dict[str, Any]] = None
        self.recent_visible_text: List[Dict[str, Any]] = []
        self.ipc_timeout_count = 0
        self.last_ipc_timeout: Optional[Dict[str, Any]] = None
        self.last_ipc_success: Optional[Dict[str, Any]] = None
        self.last_scheduling_apply_s = 0.0
        self.last_blocking_dialog_recovery: Optional[Dict[str, Any]] = None

    def ensure_dirs(self) -> None:
        self.ipc_dir.mkdir(parents=True, exist_ok=True)
        self.screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        self.observation_screenshot_dir.mkdir(parents=True, exist_ok=True)

    def render_lua(self) -> None:
        template = ROOT / "heartgold_benchmark" / "bizhawk" / "HeartGoldBridge.lua"
        text = template.read_text(encoding="utf-8")
        replacements = {
            "__IPC_DIR__": str(self.ipc_dir),
            "__SCREENSHOT_PATH__": str(self.screenshot_path),
            "__HEARTBEAT_PATH__": str(self.heartbeat_path),
            "__SPEED_MODE__": env_speed_mode(),
            "__BRIDGE_PROTOCOL_VERSION__": str(BRIDGE_PROTOCOL_VERSION),
            "__RECENT_TEXT_SAMPLE_INTERVAL__": str(env_lua_interval("HEARTGOLD_RECENT_TEXT_SAMPLE_INTERVAL", 4, 60)),
            "__REQUEST_POLL_INTERVAL__": str(env_lua_interval("HEARTGOLD_REQUEST_POLL_INTERVAL", 4, 30)),
        }
        for key, value in replacements.items():
            text = text.replace(key, value.replace("]]", "] ]"))
        self.runtime_lua_path.write_text(text, encoding="utf-8")

    def repair_bizhawk_touch_config(self) -> Dict[str, Any]:
        """Remove host mouse touch bindings that can override scripted NDS touch input."""
        enabled = os.environ.get("HEARTGOLD_REPAIR_BIZHAWK_TOUCH_CONFIG", "true").lower() != "false"
        config_path = self.bizhawk_exe.parent / "config.ini"
        report: Dict[str, Any] = {
            "enabled": enabled,
            "configPath": str(config_path),
            "changed": False,
            "removedBindings": [],
        }
        if not enabled:
            return report
        if not config_path.exists():
            report["warning"] = "bizhawk_config_missing"
            return report
        try:
            config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            report["warning"] = f"bizhawk_config_parse_failed:{exc}"
            return report

        def remove_binding(binding: Any, blocked: set[str]) -> str:
            if not isinstance(binding, str):
                return ""
            parts = [part.strip() for part in binding.split(",") if part.strip()]
            kept = []
            for part in parts:
                if part in blocked:
                    report["removedBindings"].append(part)
                    continue
                kept.append(part)
            return ", ".join(kept)

        all_trollers = config.get("AllTrollers")
        if isinstance(all_trollers, dict):
            nds = all_trollers.get("NDS Controller")
            if isinstance(nds, dict):
                old_touch = nds.get("Touch", "")
                new_touch = remove_binding(old_touch, {"WMouse L", "X1 Touchpad"})
                if new_touch != old_touch:
                    nds["Touch"] = new_touch
                    report["changed"] = True

        all_analogs = config.get("AllTrollersAnalog")
        if isinstance(all_analogs, dict):
            nds_analog = all_analogs.get("NDS Controller")
            if isinstance(nds_analog, dict):
                for axis, mouse_binding in (("Touch X", "WMouse X"), ("Touch Y", "WMouse Y")):
                    axis_config = nds_analog.get(axis)
                    if isinstance(axis_config, dict) and axis_config.get("Value") == mouse_binding:
                        axis_config["Value"] = ""
                        report["removedBindings"].append(f"{axis}:{mouse_binding}")
                        report["changed"] = True

        if report["changed"]:
            backup_path = config_path.with_suffix(config_path.suffix + ".heartgold-touch-backup")
            if not backup_path.exists():
                shutil.copy2(config_path, backup_path)
            report["backupPath"] = str(backup_path)
            config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

        try:
            self.touch_config_repair_path.parent.mkdir(parents=True, exist_ok=True)
            self.touch_config_repair_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        except OSError:
            pass
        return report

    def repair_bizhawk_performance_config(self) -> Dict[str, Any]:
        """Keep BizHawk at smooth 100% realtime playback for live DS observation."""
        enabled = os.environ.get("HEARTGOLD_REPAIR_BIZHAWK_PERFORMANCE_CONFIG", "true").lower() != "false"
        config_path = self.bizhawk_exe.parent / "config.ini"
        report: Dict[str, Any] = {
            "enabled": enabled,
            "configPath": str(config_path),
            "changed": False,
            "updatedSettings": {},
        }
        if not enabled:
            return report
        if not config_path.exists():
            report["warning"] = "bizhawk_config_missing"
            return report
        try:
            config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            report["warning"] = f"bizhawk_config_parse_failed:{exc}"
            return report
        if not isinstance(config, dict):
            report["warning"] = "bizhawk_config_not_object"
            return report

        desired = {
            "FrameSkip": 0,
            "SkipLagFrame": False,
            "SpeedPercent": 100,
            "ClockThrottle": True,
            "Unthrottled": False,
            "AutoMinimizeSkipping": False,
            "VSyncThrottle": False,
            "VSync": False,
            "SoundThrottle": False,
            "AutosaveSaveRAM": False,
            "FlushSaveRamFrames": 0,
        }
        for key, new_value in desired.items():
            old_value = config.get(key)
            if old_value != new_value:
                config[key] = new_value
                report["updatedSettings"][key] = {"old": old_value, "new": new_value}
                report["changed"] = True

        rewind = config.get("Rewind")
        if isinstance(rewind, dict) and rewind.get("Enabled") is not False:
            old_value = rewind.get("Enabled")
            rewind["Enabled"] = False
            report["updatedSettings"]["Rewind.Enabled"] = {"old": old_value, "new": False}
            report["changed"] = True

        savestates = config.get("Savestates")
        if isinstance(savestates, dict) and savestates.get("SaveScreenshot") is not False:
            old_value = savestates.get("SaveScreenshot")
            savestates["SaveScreenshot"] = False
            report["updatedSettings"]["Savestates.SaveScreenshot"] = {"old": old_value, "new": False}
            report["changed"] = True

        if report["changed"]:
            backup_path = config_path.with_suffix(config_path.suffix + ".heartgold-performance-backup")
            if not backup_path.exists():
                shutil.copy2(config_path, backup_path)
            report["backupPath"] = str(backup_path)
            config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

        try:
            self.performance_config_repair_path.parent.mkdir(parents=True, exist_ok=True)
            self.performance_config_repair_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        except OSError:
            pass
        return report

    def emulator_creationflags(self) -> int:
        if os.name != "nt":
            return 0
        priority = os.environ.get("HEARTGOLD_EMUHAWK_PRIORITY_CLASS", "HIGH_PRIORITY_CLASS").strip().upper()
        if priority in {"", "FALSE", "NONE", "NORMAL", "NORMAL_PRIORITY_CLASS"}:
            return 0
        if priority in {"HIGH", "HIGH_PRIORITY_CLASS"}:
            return int(getattr(subprocess, "HIGH_PRIORITY_CLASS", 0))
        if priority in {"ABOVE_NORMAL", "ABOVE_NORMAL_PRIORITY_CLASS"}:
            return int(getattr(subprocess, "ABOVE_NORMAL_PRIORITY_CLASS", 0))
        return int(getattr(subprocess, "HIGH_PRIORITY_CLASS", 0))

    def apply_emulator_windows_scheduling(self, pid: int) -> Dict[str, Any]:
        report: Dict[str, Any] = {
            "enabled": os.name == "nt",
            "pid": int(pid),
            "priorityClass": os.environ.get("HEARTGOLD_EMUHAWK_PRIORITY_CLASS", "HIGH_PRIORITY_CLASS"),
            "affinityMask": os.environ.get("HEARTGOLD_EMUHAWK_AFFINITY_MASK", "0xF"),
            "changed": False,
        }
        if os.name != "nt":
            return report
        try:
            import ctypes
        except Exception as exc:
            report["warning"] = f"ctypes_unavailable:{exc}"
            return report

        priority_value_by_name = {
            "HIGH": 0x00000080,
            "HIGH_PRIORITY_CLASS": 0x00000080,
            "ABOVE_NORMAL": 0x00008000,
            "ABOVE_NORMAL_PRIORITY_CLASS": 0x00008000,
            "NORMAL": 0x00000020,
            "NORMAL_PRIORITY_CLASS": 0x00000020,
        }
        priority_name_by_value = {
            0x00000080: "HIGH_PRIORITY_CLASS",
            0x00008000: "ABOVE_NORMAL_PRIORITY_CLASS",
            0x00000020: "NORMAL_PRIORITY_CLASS",
            0x00004000: "BELOW_NORMAL_PRIORITY_CLASS",
            0x00000100: "REALTIME_PRIORITY_CLASS",
            0x00000040: "IDLE_PRIORITY_CLASS",
        }
        priority_name = str(report["priorityClass"] or "").strip().upper()
        priority_value = None if priority_name in {"", "FALSE", "NONE"} else priority_value_by_name.get(priority_name, 0x00000080)
        affinity_mask = 0
        raw_affinity = str(report["affinityMask"] or "").strip()
        if raw_affinity and raw_affinity.lower() not in {"false", "none", "0"}:
            try:
                affinity_mask = int(raw_affinity, 0)
            except ValueError:
                report["affinityParseError"] = raw_affinity

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_SET_INFORMATION = 0x0200
        PROCESS_QUERY_INFORMATION = 0x0400
        handle = kernel32.OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION, False, int(pid))
        if not handle:
            report["warning"] = f"open_process_failed:{ctypes.get_last_error()}"
            return report

        def read_observed_scheduling() -> Dict[str, Any]:
            observed: Dict[str, Any] = {}
            if priority_value is not None:
                observed_priority = int(kernel32.GetPriorityClass(handle))
                if observed_priority:
                    observed["observedPriorityClassValue"] = observed_priority
                    observed["observedPriorityClass"] = priority_name_by_value.get(
                        observed_priority,
                        hex(observed_priority),
                    )
                else:
                    observed["observedPriorityError"] = ctypes.get_last_error()
            if affinity_mask > 0:
                process_affinity = ctypes.c_size_t()
                system_affinity = ctypes.c_size_t()
                ok = bool(
                    kernel32.GetProcessAffinityMask(
                        handle,
                        ctypes.byref(process_affinity),
                        ctypes.byref(system_affinity),
                    )
                )
                if ok:
                    observed["observedAffinityMask"] = f"0x{int(process_affinity.value):X}"
                    observed["observedSystemAffinityMask"] = f"0x{int(system_affinity.value):X}"
                else:
                    observed["observedAffinityError"] = ctypes.get_last_error()
            observed_priority_ok = (
                priority_value is None or observed.get("observedPriorityClassValue") == int(priority_value)
            )
            observed_affinity_raw = observed.get("observedAffinityMask")
            try:
                observed_affinity_value = int(str(observed_affinity_raw), 0) if observed_affinity_raw else None
            except ValueError:
                observed_affinity_value = None
            observed_affinity_ok = affinity_mask <= 0 or observed_affinity_value == int(affinity_mask)
            observed["schedulingVerified"] = bool(observed_priority_ok and observed_affinity_ok)
            return observed

        try:
            if priority_value is not None:
                ok = bool(kernel32.SetPriorityClass(handle, int(priority_value)))
                report["priorityApplied"] = ok
                report["changed"] = report["changed"] or ok
                if not ok:
                    report["priorityError"] = ctypes.get_last_error()
            if affinity_mask > 0:
                ok = bool(kernel32.SetProcessAffinityMask(handle, ctypes.c_size_t(affinity_mask)))
                report["affinityApplied"] = ok
                report["changed"] = report["changed"] or ok
                if not ok:
                    report["affinityError"] = ctypes.get_last_error()
            for attempt in range(3):
                observed = read_observed_scheduling()
                report.update(observed)
                report["schedulingVerifyAttempts"] = attempt + 1
                if observed.get("schedulingVerified") is True:
                    break
                if priority_value is not None:
                    kernel32.SetPriorityClass(handle, int(priority_value))
                if affinity_mask > 0:
                    kernel32.SetProcessAffinityMask(handle, ctypes.c_size_t(affinity_mask))
                time.sleep(0.05)
        finally:
            kernel32.CloseHandle(handle)

        try:
            self.emulator_scheduling_path.parent.mkdir(parents=True, exist_ok=True)
            self.emulator_scheduling_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        except OSError:
            pass
        return report

    def refresh_emulator_scheduling_if_due(self, force: bool = False) -> Optional[Dict[str, Any]]:
        now = time.time()
        if not force and now - self.last_scheduling_apply_s < 5.0:
            return None
        pid = 0
        if self.process and self.process.poll() is None:
            pid = int(self.process.pid)
        elif self.emulator_pid_path.exists():
            try:
                pid = int(self.emulator_pid_path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                pid = 0
        if pid <= 0:
            return None
        report = self.apply_emulator_windows_scheduling(pid)
        self.last_scheduling_apply_s = now
        return report

    def bizhawk_performance_config_summary(self) -> Dict[str, Any]:
        config_path = self.bizhawk_exe.parent / "config.ini"
        summary: Dict[str, Any] = {"configPath": str(config_path), "available": False}
        if not config_path.exists():
            return summary
        try:
            config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            summary["warning"] = f"bizhawk_config_parse_failed:{exc}"
            return summary
        if not isinstance(config, dict):
            summary["warning"] = "bizhawk_config_not_object"
            return summary
        keys = (
            "FrameSkip",
            "SkipLagFrame",
            "SpeedPercent",
            "ClockThrottle",
            "Unthrottled",
            "AutoMinimizeSkipping",
            "VSyncThrottle",
            "VSync",
            "SoundThrottle",
            "AutosaveSaveRAM",
            "FlushSaveRamFrames",
        )
        summary["available"] = True
        for key in keys:
            summary[key] = config.get(key)
        rewind = config.get("Rewind") if isinstance(config.get("Rewind"), dict) else {}
        savestates = config.get("Savestates") if isinstance(config.get("Savestates"), dict) else {}
        summary["Rewind.Enabled"] = rewind.get("Enabled")
        summary["Rewind.BufferSize"] = rewind.get("BufferSize")
        summary["Savestates.SaveScreenshot"] = savestates.get("SaveScreenshot")
        return summary

    def launch(self) -> Dict[str, Any]:
        self.ensure_dirs()
        self.render_lua()
        if not self.bizhawk_exe.exists():
            raise HTTPException(status_code=500, detail=f"BizHawk not found: {self.bizhawk_exe}")
        if not self.rom_path.exists():
            raise HTTPException(status_code=500, detail=f"HeartGold ROM not found: {self.rom_path}")
        self.repair_bizhawk_performance_config()
        self.repair_bizhawk_touch_config()

        if self.process is None:
            heartbeat = self.read_json_file(self.heartbeat_path)
            heartbeat_age = self.heartbeat_age_s()
            if self.is_usable_heartbeat(heartbeat, heartbeat_age):
                return self.health()

        if self.process and self.process.poll() is None:
            heartbeat_age = self.heartbeat_age_s()
            heartbeat = self.read_json_file(self.heartbeat_path)
            if self.is_usable_heartbeat(heartbeat, heartbeat_age):
                return self.health()
            self.stop()

        for stale in (self.request_path, self.response_path, self.heartbeat_path, self.screenshot_path):
            try:
                stale.unlink()
            except FileNotFoundError:
                pass

        args = [str(self.bizhawk_exe), "--lua", str(self.runtime_lua_path), str(self.rom_path)]
        popen_kwargs: Dict[str, Any] = {"cwd": str(self.bizhawk_exe.parent)}
        creationflags = self.emulator_creationflags()
        if creationflags:
            popen_kwargs["creationflags"] = creationflags
        self.process = subprocess.Popen(args, **popen_kwargs)
        self.emulator_pid_path.write_text(str(self.process.pid), encoding="utf-8")
        self.apply_emulator_windows_scheduling(self.process.pid)
        min_frame = int(os.environ.get("HEARTGOLD_LAUNCH_MIN_FRAME", "600"))
        health = self.wait_for_heartbeat(timeout_s=30.0, min_frame=min_frame)
        if self.bootstrap_on_launch:
            self.bootstrap_intro_menu()
            health = self.health()
        return health

    def health(self) -> Dict[str, Any]:
        process_running = self.process is not None and self.process.poll() is None
        scheduling_report = self.refresh_emulator_scheduling_if_due()
        heartbeat = self.read_json_file(self.heartbeat_path)
        heartbeat_age_s = self.heartbeat_age_s()
        heartbeat_fresh = heartbeat_age_s is not None and heartbeat_age_s <= self.heartbeat_max_age_s
        running = process_running or bool(heartbeat_fresh)
        return {
            "ok": True,
            "running": running,
            "processRunning": process_running,
            "attachedViaHeartbeat": (not process_running) and bool(heartbeat_fresh),
            "heartbeatFresh": heartbeat_fresh,
            "heartbeatAgeSeconds": heartbeat_age_s,
            "bizhawkExe": str(self.bizhawk_exe),
            "romPath": str(self.rom_path),
            "runtimeDir": str(self.runtime_dir),
            "observationMode": self.observation_mode,
            "exposeOracle": self.expose_oracle,
            "stateConfidenceRequired": self.confidence_required,
            "expectedBridgeProtocolVersion": BRIDGE_PROTOCOL_VERSION,
            "bridgeProtocolCurrent": int(heartbeat.get("bridgeProtocolVersion") or 0) if isinstance(heartbeat, dict) else 0,
            "expectedBridgeFeatureVersion": BRIDGE_FEATURE_VERSION,
            "bridgeFeatureCurrent": int(heartbeat.get("bridgeFeatureVersion") or 0) if isinstance(heartbeat, dict) else 0,
            "bridgeFeatureStale": int(heartbeat.get("bridgeFeatureVersion") or 0) < BRIDGE_FEATURE_VERSION
            if isinstance(heartbeat, dict)
            else True,
            "requestPending": self.request_path.exists(),
            "responseAvailable": self.response_path.exists(),
            "ipcTimeoutCount": self.ipc_timeout_count,
            "lastIpcTimeout": self.last_ipc_timeout,
            "lastIpcSuccess": self.last_ipc_success,
            "lastBlockingDialogRecovery": self.last_blocking_dialog_recovery,
            "lastSchedulingRefresh": scheduling_report,
            "bizhawkPerformanceConfig": self.bizhawk_performance_config_summary(),
            "screenshot": self.screenshot_file_info(self.screenshot_path),
            "heartbeat": heartbeat,
        }

    def detach_exited_process_if_heartbeat_fresh(self) -> bool:
        if self.process is None or self.process.poll() is None:
            return False
        heartbeat = self.read_json_file(self.heartbeat_path)
        age_s = self.heartbeat_age_s()
        if self.is_usable_heartbeat(heartbeat, age_s):
            self.process = None
            return True
        return False

    def stop(self, timeout_s: float = 5.0) -> None:
        if not self.process or self.process.poll() is not None:
            self.process = None
            try:
                self.emulator_pid_path.unlink()
            except FileNotFoundError:
                pass
            return

        self.process.terminate()
        try:
            self.process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=timeout_s)
        finally:
            self.process = None
            try:
                self.emulator_pid_path.unlink()
            except FileNotFoundError:
                pass

    def restart(self, autosave: Optional[bool] = None) -> Dict[str, Any]:
        if autosave is None:
            autosave = os.environ.get("HEARTGOLD_AUTOSAVE_BEFORE_RESTART", "true").lower() != "false"
        heartbeat = self.read_json_file(self.heartbeat_path)
        heartbeat_fresh = self.is_usable_heartbeat(heartbeat, self.heartbeat_age_s())
        if autosave and heartbeat_fresh:
            try:
                self.save_state()
            except Exception:
                pass
        self.stop()
        health = self.launch()
        return {
            "status": True,
            "ok": True,
            "message": "BizHawk restarted and HeartGold relaunched.",
            "details": health,
        }

    def wait_for_heartbeat(self, timeout_s: float, min_frame: int = 1) -> Dict[str, Any]:
        start = time.time()
        while time.time() - start < timeout_s:
            if self.process and self.process.poll() is not None:
                if not self.detach_exited_process_if_heartbeat_fresh():
                    raise HTTPException(status_code=500, detail=f"BizHawk exited with {self.process.returncode}")
            heartbeat = self.read_json_file(self.heartbeat_path)
            frame = int(heartbeat.get("frame") or 0) if heartbeat else 0
            if self.is_usable_heartbeat(heartbeat, self.heartbeat_age_s()) and frame >= min_frame:
                return self.health()
            time.sleep(0.1)
        raise HTTPException(status_code=504, detail="Timed out waiting for BizHawk heartbeat")

    def heartbeat_age_s(self) -> Optional[float]:
        try:
            return max(0.0, time.time() - self.heartbeat_path.stat().st_mtime)
        except FileNotFoundError:
            return None

    def is_usable_heartbeat(self, heartbeat: Any, age_s: Optional[float]) -> bool:
        if not isinstance(heartbeat, dict):
            return False
        try:
            protocol_version = int(heartbeat.get("bridgeProtocolVersion") or 0)
        except (TypeError, ValueError):
            protocol_version = 0
        return (
            heartbeat.get("system") == "NDS"
            and age_s is not None
            and age_s <= self.heartbeat_max_age_s
            and protocol_version == BRIDGE_PROTOCOL_VERSION
        )

    def emulator_pid(self) -> int:
        if self.process and self.process.poll() is None:
            return int(self.process.pid)
        if self.emulator_pid_path.exists():
            try:
                return int(self.emulator_pid_path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                return 0
        return 0

    def blocking_emulator_dialog_titles(self) -> List[str]:
        raw = os.environ.get("HEARTGOLD_BIZHAWK_BLOCKING_DIALOG_TITLES", "Display Configuration")
        if raw.strip().lower() in {"", "0", "false", "none", "off"}:
            return []
        return [part.strip() for part in re.split(r"[;\n]", raw) if part.strip()]

    def close_blocking_emulator_dialogs(self) -> Dict[str, Any]:
        titles = self.blocking_emulator_dialog_titles()
        report: Dict[str, Any] = {
            "enabled": bool(titles),
            "platform": os.name,
            "pid": self.emulator_pid(),
            "titles": titles,
            "closed": [],
        }
        if not titles:
            return report
        if os.name != "nt":
            report["skipped"] = "windows_only"
            return report
        if report["pid"] <= 0:
            report["skipped"] = "emulator_pid_unavailable"
            return report

        try:
            import ctypes
            from ctypes import wintypes
        except Exception as exc:
            report["warning"] = f"ctypes_unavailable:{exc}"
            return report

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        enum_windows_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        WM_CLOSE = 0x0010

        user32.EnumWindows.argtypes = [enum_windows_proc, wintypes.LPARAM]
        user32.EnumWindows.restype = wintypes.BOOL
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.SendMessageW.restype = wintypes.LPARAM

        target_titles = set(titles)
        target_pid = int(report["pid"])

        def callback(hwnd: Any, _lparam: Any) -> bool:
            try:
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if int(pid.value) != target_pid:
                    return True
                if not bool(user32.IsWindowVisible(hwnd)):
                    return True
                length = int(user32.GetWindowTextLengthW(hwnd))
                if length <= 0:
                    return True
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                title = buffer.value
                if title not in target_titles:
                    return True
                user32.SendMessageW(hwnd, WM_CLOSE, 0, 0)
                report["closed"].append({"title": title, "hwnd": f"0x{int(hwnd):X}"})
            except Exception as exc:
                report.setdefault("errors", []).append(str(exc))
            return True

        user32.EnumWindows(enum_windows_proc(callback), 0)
        if report["closed"]:
            report["atMs"] = int(time.time() * 1000)
        return report

    def recover_blocking_emulator_dialogs_if_needed(
        self,
        heartbeat: Optional[Dict[str, Any]] = None,
        age_s: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        if heartbeat is None:
            heartbeat = self.read_json_file(self.heartbeat_path)
        if age_s is None:
            age_s = self.heartbeat_age_s()
        if self.is_usable_heartbeat(heartbeat, age_s):
            return None
        report = self.close_blocking_emulator_dialogs()
        if report.get("closed"):
            self.last_blocking_dialog_recovery = report
            time.sleep(0.5)
            return report
        if report.get("warning") or report.get("skipped"):
            self.last_blocking_dialog_recovery = report
        return report

    def wait_for_recovered_heartbeat(self, timeout_s: float = 2.0) -> bool:
        start = time.time()
        while time.time() - start < timeout_s:
            heartbeat = self.read_json_file(self.heartbeat_path)
            if self.is_usable_heartbeat(heartbeat, self.heartbeat_age_s()):
                return True
            time.sleep(0.1)
        return False

    @staticmethod
    def unlink_if_exists(path: Path, retries: int = 20, delay_s: float = 0.025) -> None:
        for attempt in range(retries):
            try:
                path.unlink()
                return
            except FileNotFoundError:
                return
            except PermissionError:
                if attempt == retries - 1:
                    raise
                time.sleep(delay_s)

    @staticmethod
    def replace_with_retry(source: Path, target: Path, retries: int = 40, delay_s: float = 0.025) -> None:
        for attempt in range(retries):
            try:
                source.replace(target)
                return
            except PermissionError:
                if attempt == retries - 1:
                    raise
                time.sleep(delay_s)

    def record_ipc_timeout(self, op: str, detail: str) -> None:
        self.ipc_timeout_count += 1
        self.last_ipc_timeout = {
            "op": op or "unknown",
            "detail": detail,
            "atMs": int(time.time() * 1000),
            "requestPending": self.request_path.exists(),
            "responseAvailable": self.response_path.exists(),
        }

    def record_ipc_success(self, op: str) -> None:
        self.last_ipc_success = {
            "op": op or "unknown",
            "atMs": int(time.time() * 1000),
        }

    def ensure_runtime_ready(self) -> None:
        if self.process is None or self.process.poll() is not None:
            heartbeat = self.read_json_file(self.heartbeat_path)
            age_s = self.heartbeat_age_s()
            if self.is_usable_heartbeat(heartbeat, age_s):
                self.process = None
                return
            self.launch()
            return

        heartbeat = self.read_json_file(self.heartbeat_path)
        age_s = self.heartbeat_age_s()
        if self.is_usable_heartbeat(heartbeat, age_s):
            return
        recovery = self.recover_blocking_emulator_dialogs_if_needed(heartbeat, age_s)
        if recovery and recovery.get("closed") and self.wait_for_recovered_heartbeat():
            return
        # A running emulator may be handling a slow load/action while the
        # heartbeat is stale. Let the IPC request prove liveness or timeout.
        return

    def request(self, fields: Dict[str, Any], timeout_s: float = 10.0) -> Dict[str, Any]:
        op = str(fields.get("op") or "")
        lock_acquired = self.request_lock.acquire(timeout=self.request_lock_timeout_s)
        if not lock_acquired:
            detail = f"Timed out waiting for bridge IPC request lock for {op or 'unknown'}"
            self.record_ipc_timeout(op, detail)
            raise HTTPException(status_code=504, detail=detail)
        try:
            self.ensure_dirs()
            self.ensure_runtime_ready()
            max_attempts = 2 if op == "snapshot" else 1
            for attempt in range(1, max_attempts + 1):
                req_id = str(uuid.uuid4())
                request_fields = {"id": req_id, **fields}
                request_text = "\n".join(f"{key}={value}" for key, value in request_fields.items()) + "\n"
                self.unlink_if_exists(self.response_path)
                request_tmp = self.request_path.with_name(f"request.{req_id}.tmp")
                request_tmp.write_text(request_text, encoding="utf-8")
                self.replace_with_retry(request_tmp, self.request_path)

                start = time.time()
                while time.time() - start < timeout_s:
                    if self.process and self.process.poll() is not None:
                        if not self.detach_exited_process_if_heartbeat_fresh():
                            raise HTTPException(status_code=500, detail=f"BizHawk exited with {self.process.returncode}")
                    response = self.read_json_file(self.response_path)
                    if response and response.get("id") == req_id:
                        self.record_ipc_success(op)
                        return response
                    if response and not response.get("id"):
                        self.unlink_if_exists(self.response_path)
                    time.sleep(0.05)
                recovery = self.recover_blocking_emulator_dialogs_if_needed()
                if recovery and recovery.get("closed"):
                    recovery_start = time.time()
                    recovery_timeout_s = max(1.0, min(5.0, timeout_s))
                    while time.time() - recovery_start < recovery_timeout_s:
                        response = self.read_json_file(self.response_path)
                        if response and response.get("id") == req_id:
                            self.record_ipc_success(op)
                            return response
                        time.sleep(0.05)
                self.unlink_if_exists(self.request_path)
                self.unlink_if_exists(self.response_path)
                detail = f"Timed out waiting for bridge response to {op}"
                self.record_ipc_timeout(op, detail)
                if attempt < max_attempts:
                    time.sleep(0.1)
                    self.ensure_runtime_ready()
                    continue
                raise HTTPException(status_code=504, detail=detail)
        finally:
            self.request_lock.release()

    def recover_timed_out_action(
        self,
        op: str,
        before_state: Dict[str, Any],
        error: HTTPException,
        timeout_s: float = 5.0,
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        try:
            after_response = self.request(trace_only_request({"op": "snapshot"}), timeout_s=timeout_s)
        except HTTPException as recovery_error:
            raise error from recovery_error

        after_state = self.trace_state(after_response)
        before_hash = before_state.get("screenshot", {}).get("sha256")
        after_hash = after_state.get("screenshot", {}).get("sha256")
        screen_changed = bool(before_hash and after_hash and before_hash != after_hash)
        payload = {
            "ok": screen_changed,
            "status": screen_changed,
            "timeoutRecovered": True,
            "timeoutRecoverySnapshotOk": True,
            "inputDelivered": True if screen_changed else None,
            "inputAccepted": True if screen_changed else None,
            "visibleEffectObserved": screen_changed,
            "effectVerified": screen_changed,
            "actionOutcome": "timeout_recovered_visible_effect" if screen_changed else "timeout_recovered_no_visible_effect",
            "harnessWarning": f"bridge command response timed out for {op}; recovered from post-timeout snapshot",
            "timeoutError": str(getattr(error, "detail", error)),
        }
        if not screen_changed:
            payload["error"] = "bridge command response timed out and recovery snapshot showed no visible effect"
            payload["unreliable"] = True
            payload["harnessFailureReason"] = payload["error"]
        return payload, after_response

    def screen_color_stats(self) -> Dict[str, Any]:
        if Image is None or not self.screenshot_path.exists():
            return {"available": False}
        try:
            with Image.open(self.screenshot_path) as image:
                rgb = image.convert("RGB")
                width, height = rgb.size
                step = max(1, int((width * height / 40000) ** 0.5))
                total = 0
                orange = 0
                cyan = 0
                green = 0
                for y in range(0, height, step):
                    for x in range(0, width, step):
                        r, g, b = rgb.getpixel((x, y))
                        total += 1
                        if 150 <= r <= 230 and 80 <= g <= 170 and b <= 90:
                            orange += 1
                        if r <= 80 and g >= 150 and b >= 130:
                            cyan += 1
                        if r <= 90 and g >= 130 and b <= 120:
                            green += 1
                if total == 0:
                    return {"available": False}
                return {
                    "available": True,
                    "width": width,
                    "height": height,
                    "orangeRatio": orange / total,
                    "cyanRatio": cyan / total,
                    "greenRatio": green / total,
                }
        except OSError:
            return {"available": False}

    def is_intro_info_menu(self) -> bool:
        stats = self.screen_color_stats()
        return bool(
            stats.get("available")
            and stats.get("orangeRatio", 0) >= 0.35
            and stats.get("cyanRatio", 0) >= 0.01
        )

    def is_intro_optional_info_page(self) -> bool:
        stats = self.screen_color_stats()
        return bool(
            stats.get("available")
            and stats.get("greenRatio", 0) >= 0.35
            and stats.get("cyanRatio", 0) <= 0.02
        )

    def bootstrap_intro_menu(self) -> Dict[str, Any]:
        """Dismiss the mandatory HGSS info menu after a cold launch.

        HeartGold advertises this as a touch prompt, but the menu is also
        controllable with D-pad + A. Prefer buttons because they are easier to
        replay deterministically, and keep stylus available as a manual/fallback
        command for true touch-only lower-screen UI.
        """
        phases: List[Dict[str, Any]] = []
        last_response: Dict[str, Any] = {}

        for attempt in range(36):
            last_response = self.request({"op": "snapshot"})
            stats = self.screen_color_stats()
            phases.append(
                {
                    "phase": "wait_for_info_menu",
                    "attempt": attempt,
                    "frame": last_response.get("frame"),
                    "screen": stats,
                }
            )
            if self.is_intro_info_menu():
                break
            # HGSS title screen is literally "Touch to Start" on this core.
            # Try A first because it is the preferred reproducible control
            # when accepted, then tap the title prompt if A is ignored.
            last_response = self.request({"op": "press", "buttons": "A", "frames": 18}, timeout_s=10.0)
            last_response = self.request({"op": "wait", "frames": 45}, timeout_s=10.0)
            if not self.is_intro_info_menu():
                last_response = self.request({"op": "touch", "x": 128, "y": 172, "frames": 30}, timeout_s=10.0)
                last_response = self.request({"op": "wait", "frames": 90}, timeout_s=10.0)

        for attempt in range(2):
            if not self.is_intro_info_menu() and not self.is_intro_optional_info_page():
                break
            if self.is_intro_optional_info_page():
                for page in range(8):
                    if self.is_intro_info_menu():
                        break
                    for command in [
                        {"op": "press", "buttons": "A", "frames": 20},
                        {"op": "wait", "frames": 120},
                    ]:
                        last_response = self.request(command, timeout_s=15.0)
                    phases.append(
                        {
                            "phase": "return_from_optional_info",
                            "attempt": attempt,
                            "page": page,
                            "frame": last_response.get("frame"),
                            "screen": self.screen_color_stats(),
                            "stillInfoMenu": self.is_intro_info_menu(),
                            "optionalInfoPage": self.is_intro_optional_info_page(),
                        }
                    )
                if not self.is_intro_info_menu():
                    continue

            for command in [
                {"op": "press", "buttons": "Down", "frames": 20},
                {"op": "wait", "frames": 60},
                {"op": "press", "buttons": "Down", "frames": 20},
                {"op": "wait", "frames": 60},
                {"op": "press", "buttons": "Down", "frames": 20},
                {"op": "wait", "frames": 90},
                {"op": "press", "buttons": "A", "frames": 20},
                {"op": "wait", "frames": 360},
            ]:
                last_response = self.request(command, timeout_s=15.0)
            stats = self.screen_color_stats()
            phases.append(
                {
                    "phase": "button_select_no_info",
                    "attempt": attempt,
                    "frame": last_response.get("frame"),
                    "screen": stats,
                    "stillInfoMenu": self.is_intro_info_menu(),
                    "optionalInfoPage": self.is_intro_optional_info_page(),
                }
            )
            if not self.is_intro_info_menu() and not self.is_intro_optional_info_page():
                break

        if self.is_intro_info_menu() or self.is_intro_optional_info_page():
            for command in [
                {"op": "touch", "x": 128, "y": 154, "frames": 24},
                {"op": "wait", "frames": 240},
            ]:
                last_response = self.request(command, timeout_s=15.0)
            phases.append(
                {
                    "phase": "stylus_fallback_no_info",
                    "frame": last_response.get("frame"),
                    "screen": self.screen_color_stats(),
                    "stillInfoMenu": self.is_intro_info_menu(),
                    "optionalInfoPage": self.is_intro_optional_info_page(),
                }
            )

        return {
            "status": True,
            "ok": True,
            "message": "HeartGold intro info screen bootstrap sequence completed.",
            "completed": not self.is_intro_info_menu() and not self.is_intro_optional_info_page(),
            "phases": phases,
            "lastResponse": last_response,
        }

    def state_path(self, requested: Optional[str] = None) -> Path:
        if requested:
            path = Path(requested)
            if not path.is_absolute():
                path = (ROOT / path).resolve()
            else:
                path = path.resolve()
        else:
            path = self.runtime_dir / "saves" / "heartgold_autosave.State"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def save_state(self, path: Optional[str] = None) -> Dict[str, Any]:
        target = self.state_path(path)
        response = self.request({"op": "save_state", "path": str(target)}, timeout_s=20.0)
        return {"ok": bool(response.get("ok")), "status": bool(response.get("ok")), "path": str(target), "response": response}

    def load_state(self, path: Optional[str] = None) -> Dict[str, Any]:
        target = self.state_path(path)
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"Savestate not found: {target}")
        response = self.request({"op": "load_state", "path": str(target)}, timeout_s=20.0)
        if response.get("ok"):
            self.reset_observed_positions()
        return {"ok": bool(response.get("ok")), "status": bool(response.get("ok")), "path": str(target), "response": response}

    def calibrate_position(self) -> Dict[str, Any]:
        self.last_position_calibration_attempt_s = time.monotonic()
        response = self.request({"op": "calibrate_position"}, timeout_s=90.0)
        data = self.build_snapshot_data(response)
        return {
            "ok": bool(response.get("ok")),
            "status": bool(response.get("ok")),
            "position": data.get("current_trainer_data", {}).get("position"),
            "raw_position": data.get("raw_state", {}).get("position_resolution"),
            "object_position": response.get("ram", {}).get("player", {}).get("object_position")
            if isinstance(response.get("ram"), dict)
            else None,
            "candidates": response.get("ram", {}).get("player", {}).get("object_position_candidates")
            if isinstance(response.get("ram"), dict)
            else None,
        }

    def should_auto_calibrate_position(self, data: Dict[str, Any]) -> bool:
        if time.monotonic() - self.last_position_calibration_attempt_s < 30.0:
            return False
        if bool(data.get("is_talking_to_npc")) or bool(data.get("is_in_battle")):
            return False
        position = data.get("current_trainer_data", {}).get("position")
        if not isinstance(position, dict):
            return False
        if bool(position.get("live_ram")):
            return False
        return self.has_valid_minimap_position(
            str(position.get("map_id") or ""),
            safe_int(position.get("x"), -1),
            safe_int(position.get("y"), -1),
        )

    @staticmethod
    def file_digest(path: Path) -> Optional[str]:
        try:
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest()
        except (FileNotFoundError, OSError):
            return None

    def screenshot_file_info(self, path: Path) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "path": str(path),
            "exists": False,
            "hash": None,
            "mtimeMs": None,
            "ageMs": None,
            "rawWidth": None,
            "rawHeight": None,
            "visualAvailable": Image is not None,
        }
        try:
            stat = path.stat()
            info["exists"] = True
            info["mtimeMs"] = int(stat.st_mtime * 1000)
            info["ageMs"] = max(0, int((time.time() - stat.st_mtime) * 1000))
            info["hash"] = self.file_digest(path)
            if Image is not None:
                try:
                    with Image.open(path) as image:
                        info["rawWidth"], info["rawHeight"] = image.size
                except OSError:
                    info["visualAvailable"] = False
        except FileNotFoundError:
            pass
        except OSError:
            info["visualAvailable"] = False
        return info

    def create_observation_screenshot(self, raw_path: Path, screenshot_info: Dict[str, Any], frame: Any) -> Optional[str]:
        digest = screenshot_info.get("hash")
        if not screenshot_info.get("exists") or not digest or not raw_path.exists():
            return None
        try:
            frame_part = str(int(frame)) if frame is not None else "unknown"
        except (TypeError, ValueError):
            frame_part = "unknown"
        target = self.observation_screenshot_dir / f"ds_{frame_part}_{str(digest)[:12]}.png"
        try:
            if not target.exists():
                shutil.copy2(raw_path, target)
                copied_digest = self.file_digest(target)
                if copied_digest and copied_digest != digest:
                    corrected = self.observation_screenshot_dir / f"ds_{frame_part}_{str(copied_digest)[:12]}.png"
                    if corrected != target:
                        if corrected.exists():
                            target.unlink(missing_ok=True)
                        else:
                            target.rename(corrected)
                        target = corrected
            return str(target)
        except OSError:
            return None

    def advance_dialog_by_screenshot(self, frames: int = 180) -> Dict[str, Any]:
        started = time.monotonic()
        initial_response = self.request({"op": "snapshot"})
        initial_hash = self.file_digest(Path(initial_response.get("screenshotRawPath") or self.screenshot_path))
        frames = max(30, min(1800, int(frames or 120)))
        final_response = initial_response
        transcript: List[Dict[str, Any]] = [
            self.temporal_sample_from_response("before", initial_response)
        ]
        saw_dialog = self.is_dialog_box_visible()
        max_taps = max(1, min(30, frames // 45))
        changed_count = 0
        unchanged_streak = 0
        for tap_index in range(1, max_taps + 1):
            before_hash = self.file_digest(Path(final_response.get("screenshotRawPath") or self.screenshot_path))
            self.request({"op": "press", "buttons": "a", "frames": 30}, timeout_s=10.0)
            final_response = self.request({"op": "wait", "frames": 12}, timeout_s=10.0)
            chunk_hash = self.file_digest(Path(final_response.get("screenshotRawPath") or self.screenshot_path))
            dialog_visible = self.is_dialog_box_visible()
            changed_this_tap = chunk_hash is not None and chunk_hash != before_hash
            if changed_this_tap:
                changed_count += 1
                unchanged_streak = 0
            else:
                unchanged_streak += 1
            sample = self.temporal_sample_from_response(
                f"tap_{tap_index}",
                final_response,
                frames=42,
                changed=changed_this_tap,
            )
            sample["dialogVisible"] = dialog_visible
            transcript.append(sample)
            if saw_dialog and not dialog_visible:
                break
            saw_dialog = saw_dialog or dialog_visible
            if unchanged_streak >= 2:
                break
        final_hash = self.file_digest(Path(final_response.get("screenshotRawPath") or self.screenshot_path))
        changed = final_hash is not None and final_hash != initial_hash

        final_response["trace"] = {
            "stopReason": "dialog_cleared" if saw_dialog and not self.is_dialog_box_visible() else "fixed_auto_a_window",
            "pressCount": len(transcript) - 1,
            "autoPressCount": len(transcript) - 1,
            "durationMs": int((time.monotonic() - started) * 1000),
            "transcript": transcript,
            "events": ["screen_changed_during_auto_a"] if changed else ["no_screen_change_during_auto_a_possible_prompt"],
            "initialScreenshotHash": initial_hash,
            "finalScreenshotHash": final_hash,
            "changedCount": changed_count,
        }
        return final_response

    def type_text_by_dpad(self, text: str) -> Dict[str, Any]:
        allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        cleaned = "".join(ch for ch in str(text or "").upper() if ch in allowed)[:7]
        if not cleaned:
            snapshot = self.request({"op": "snapshot"})
            snapshot["ok"] = False
            snapshot["status"] = False
            snapshot["unreliable"] = True
            snapshot["actionOutcome"] = "failed_invalid_text"
            snapshot["harnessFailureReason"] = "type_text received no A-Z/0-9 characters after sanitization"
            snapshot["trace"] = {
                "requestedText": str(text or ""),
                "typedText": "",
                "method": "dpad_keyboard",
                "events": ["type_text_rejected_empty_sanitized_text"],
            }
            return snapshot

        pre_snapshot = self.request({"op": "snapshot"}, timeout_s=10.0)
        pre_snapshot_path = Path(pre_snapshot.get("screenshotRawPath") or self.screenshot_path)
        pre_ram = pre_snapshot.get("ram") if isinstance(pre_snapshot.get("ram"), dict) else {}
        pre_naming = pre_ram.get("naming") if isinstance(pre_ram.get("naming"), dict) else {}
        pre_naming_active = (
            pre_naming.get("active") is True
            and pre_naming.get("validation") == "naming_screen_appdata_entry_buffer_validated"
        )
        if not pre_naming_active:
            snapshot = pre_snapshot
            snapshot["ok"] = False
            snapshot["status"] = False
            snapshot["unreliable"] = True
            snapshot["actionOutcome"] = "failed_type_text_not_in_naming_keyboard"
            snapshot["harnessFailureReason"] = (
                "type_text refused to send destructive keyboard inputs because validated HeartGold RAM naming "
                "state was not active in the current observation"
            )
            snapshot["preConfirm"] = {
                "namingRam": pre_naming,
                "screenshotRawPath": snapshot.get("screenshotRawPath"),
                "screenshotHash": self.file_digest(pre_snapshot_path),
            }
            snapshot["trace"] = {
                "requestedText": str(text or ""),
                "typedText": "",
                "expectedText": cleaned,
                "acceptedString": "",
                "acceptedStringMatchesRequested": False,
                "preConfirmNamingRamActive": False,
                "events": ["type_text_rejected_no_active_naming_keyboard"],
                "steps": [],
                "method": "dpad_keyboard",
                "verified": False,
            }
            return snapshot

        response = self.request({"op": "type_text", "text": cleaned}, timeout_s=45.0)
        post_confirm_response = self.request({"op": "wait", "frames": 30}, timeout_s=10.0)
        post_confirm_path = Path(post_confirm_response.get("screenshotRawPath") or self.screenshot_path)
        post_ram = post_confirm_response.get("ram") if isinstance(post_confirm_response.get("ram"), dict) else {}
        post_naming = post_ram.get("naming") if isinstance(post_ram.get("naming"), dict) else {}
        post_naming_active = (
            post_naming.get("active") is True
            and post_naming.get("validation") == "naming_screen_appdata_entry_buffer_validated"
        )
        text_debug = response.get("textDebug") if isinstance(response.get("textDebug"), dict) else {}
        debug_typed_text = text_debug.get("typed_text")
        entry_before_confirm = (
            text_debug.get("entry_before_confirm")
            if isinstance(text_debug.get("entry_before_confirm"), dict)
            else {}
        )
        entry_text = entry_before_confirm.get("entryText")
        entry_verified = (
            entry_before_confirm.get("active") is True
            and entry_before_confirm.get("validation") == "naming_screen_appdata_entry_buffer_validated"
            and entry_text == cleaned
        )
        verified_text = (
            response.get("ok") is True
            and debug_typed_text == cleaned
            and entry_verified
            and not post_naming_active
        )
        if not verified_text:
            response["ok"] = False
            response["status"] = False
            response["unreliable"] = True
            response["actionOutcome"] = "unverified_type_text"
            if post_naming_active:
                response["harnessFailureReason"] = "type_text naming RAM still active after confirmation"
            else:
                response["harnessFailureReason"] = (
                    "type_text did not return matching Lua keyboard debug evidence"
                    if text_debug
                    else "type_text response did not include Lua keyboard debug evidence"
                )
        response["postConfirm"] = {
            "frame": post_confirm_response.get("frame"),
            "screenshotRawPath": post_confirm_response.get("screenshotRawPath"),
            "screenshotHash": self.file_digest(post_confirm_path),
            "namingRam": post_naming,
        }
        response["preConfirm"] = {
            "namingRam": pre_naming,
            "frame": pre_snapshot.get("frame"),
            "screenshotRawPath": pre_snapshot.get("screenshotRawPath"),
            "screenshotHash": self.file_digest(pre_snapshot_path),
        }
        response["acceptedString"] = entry_text if entry_verified and not post_naming_active else None
        response["acceptedStringSource"] = "ram_naming_entry_buffer_before_start_confirm" if entry_verified else None
        response["acceptedStringMatchesRequested"] = bool(verified_text)
        response["trace"] = {
            "requestedText": str(text or ""),
            "typedText": debug_typed_text or "",
            "acceptedString": response["acceptedString"] or "",
            "expectedText": cleaned,
            "acceptedStringMatchesRequested": bool(verified_text),
            "entryBeforeConfirmValidation": entry_before_confirm.get("validation"),
            "preConfirmNamingRamActive": pre_naming_active,
            "postConfirmNamingRamActive": post_naming_active,
            "events": text_debug.get("events")
            if isinstance(text_debug.get("events"), list)
            else ["type_text_unverified_missing_debug"],
            "steps": text_debug.get("steps") if isinstance(text_debug.get("steps"), list) else [],
            "method": text_debug.get("method") or "dpad_keyboard",
            "verified": verified_text,
        }
        return response

    @staticmethod
    def read_json_file(path: Path) -> Optional[Dict[str, Any]]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    @staticmethod
    def direction_from_buttons(buttons: List[str]) -> Optional[str]:
        for button in buttons:
            key = BUTTON_ALIASES.get(str(button).lower(), str(button).lower())
            if key in DIRECTION_DELTAS:
                return key
        return None

    @staticmethod
    def has_valid_minimap_position(map_id: str, x: int, y: int) -> bool:
        if not map_id or map_id in {"unknown", "0"}:
            return False
        return 0 <= int(x) <= 4096 and 0 <= int(y) <= 4096

    @staticmethod
    def is_live_ram_position(position: Dict[str, Any], map_id: str, x: int, y: int) -> bool:
        if not bool(position.get("reasonable")):
            return False
        if not HeartGoldBridge.has_valid_minimap_position(map_id, x, y):
            return False
        source = str(position.get("source") or "").lower()
        if "localmapobject" not in source and source != "fieldsystem.playeravatar.mapobject":
            return False
        # The HGSS save-block candidate exposes useful trainer fields, but its
        # x/y values did not change during verified overworld movement.
        if "save" in source:
            return False
        if position.get("rootBindingValid") is not True:
            return False
        return True

    def load_observed_positions(self) -> Dict[str, Dict[str, Any]]:
        try:
            data = json.loads(self.observed_position_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        if not isinstance(data, dict):
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        for key, value in data.items():
            if isinstance(value, dict):
                out[str(key)] = value
        return out

    def save_observed_positions(self, positions: Dict[str, Dict[str, Any]]) -> None:
        self.observed_position_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.observed_position_path.with_name(f".{self.observed_position_path.name}.tmp.{os.getpid()}")
        tmp.write_text(json.dumps(positions, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.observed_position_path)

    def reset_observed_positions(self) -> None:
        with self.position_lock:
            try:
                self.observed_position_path.unlink()
            except FileNotFoundError:
                pass

    def observed_position_for_map(self, *, map_id: str, seed_x: int = 0, seed_y: int = 0, seed_z: int = 0) -> Dict[str, Any]:
        with self.position_lock:
            positions = self.load_observed_positions()
            current = positions.get(map_id)
            if not isinstance(current, dict):
                current = {
                    "x": int(seed_x),
                    "y": int(seed_y),
                    "z": int(seed_z),
                    "source": "observed_motion_origin",
                    "updatedFrame": None,
                }
                positions[map_id] = current
                self.save_observed_positions(positions)
            return {
                "x": safe_int(current.get("x"), int(seed_x)),
                "y": safe_int(current.get("y"), int(seed_y)),
                "z": safe_int(current.get("z"), int(seed_z)),
                "source": str(current.get("source") or "observed_motion_fallback"),
                "updatedFrame": current.get("updatedFrame"),
            }

    def set_observed_position(
        self,
        *,
        map_id: str,
        x: int,
        y: int,
        z: int = 0,
        source: str = "observed_motion_fallback",
        frame: Optional[int] = None,
    ) -> None:
        if not self.has_valid_minimap_position(map_id, x, y):
            return
        with self.position_lock:
            positions = self.load_observed_positions()
            positions[map_id] = {
                "x": int(x),
                "y": int(y),
                "z": int(z),
                "source": source,
                "updatedFrame": frame,
            }
            self.save_observed_positions(positions)

    def resolve_player_position(self, ram_position: Dict[str, Any], frame: Any = None) -> Dict[str, Any]:
        raw_map_value = ram_position.get("map_id")
        map_id = str(raw_map_value) if raw_map_value is not None else "unknown"
        raw_x = safe_int(ram_position.get("x"), 0)
        raw_y = safe_int(ram_position.get("y"), 0)
        raw_z = safe_int(ram_position.get("z"), 0)
        raw_source = str(ram_position.get("source") or "unknown")
        facing_value, facing_source, facing_confidence = facing_from_local_map_object(ram_position.get("facing"))
        facing_contract = CURRENT_FACING_CONTRACT if facing_confidence == "verified_ram" else "unknown"
        live = self.is_live_ram_position(ram_position, map_id, raw_x, raw_y)

        if live:
            self.set_observed_position(
                map_id=map_id,
                x=raw_x,
                y=raw_y,
                z=raw_z,
                source="live_ram_position",
                frame=safe_int(frame, 0) if frame is not None else None,
            )
            return {
                "map_id": map_id,
                "x": raw_x,
                "y": raw_y,
                "z": raw_z,
                "source": raw_source,
                "liveRam": True,
                "stateReliability": "ram_first_with_visual_guard",
                "facing": facing_value,
                "facingRaw": ram_position.get("facing"),
                "facingSource": facing_source,
                "facingConfidence": facing_confidence,
                "facingContract": facing_contract,
                "localMapObjectMapId": ram_position.get("local_map_object_map_id"),
                "mapIdSource": ram_position.get("map_id_source") or raw_source,
                "mapIdCandidateSource": ram_position.get("map_id_candidate_source"),
                "mapIdCandidateRejectedReason": ram_position.get("map_id_candidate_rejected_reason"),
                "raw": dict(ram_position),
            }

        if self.has_valid_minimap_position(map_id, raw_x, raw_y):
            observed = self.observed_position_for_map(map_id=map_id, seed_x=raw_x, seed_y=raw_y, seed_z=raw_z)
            return {
                "map_id": map_id,
                "x": safe_int(observed.get("x"), raw_x),
                "y": safe_int(observed.get("y"), raw_y),
                "z": safe_int(observed.get("z"), raw_z),
                "source": str(observed.get("source") or "observed_motion_fallback"),
                "liveRam": False,
                "stateReliability": "ram_map_observed_motion_with_visual_guard",
                "facing": facing_value,
                "facingRaw": ram_position.get("facing"),
                "facingSource": facing_source,
                "facingConfidence": facing_confidence,
                "facingContract": facing_contract,
                "localMapObjectMapId": ram_position.get("local_map_object_map_id"),
                "mapIdSource": ram_position.get("map_id_source") or raw_source,
                "mapIdCandidateSource": ram_position.get("map_id_candidate_source"),
                "mapIdCandidateRejectedReason": ram_position.get("map_id_candidate_rejected_reason"),
                "raw": dict(ram_position),
            }

        return {
            "map_id": map_id,
            "x": raw_x,
            "y": raw_y,
            "z": raw_z,
            "source": raw_source,
            "liveRam": False,
            "stateReliability": "ram_candidate_with_visual_guard",
            "facing": facing_value,
            "facingRaw": ram_position.get("facing"),
            "facingSource": facing_source,
            "facingConfidence": facing_confidence,
            "facingContract": facing_contract,
            "localMapObjectMapId": ram_position.get("local_map_object_map_id"),
            "mapIdSource": ram_position.get("map_id_source") or raw_source,
            "mapIdCandidateSource": ram_position.get("map_id_candidate_source"),
            "mapIdCandidateRejectedReason": ram_position.get("map_id_candidate_rejected_reason"),
            "raw": dict(ram_position),
        }

    def apply_observed_directional_motion(
        self,
        before_state: Dict[str, Any],
        after_state: Dict[str, Any],
        direction: Optional[str],
        *,
        screen_changed: bool,
        collided: bool,
        frame: Any = None,
    ) -> bool:
        if direction not in DIRECTION_DELTAS or collided or not screen_changed:
            return False
        before_player = before_state.get("player") if isinstance(before_state.get("player"), dict) else {}
        after_player = after_state.get("player") if isinstance(after_state.get("player"), dict) else {}
        # Do not synthesize tile motion from screenshot changes when live RAM
        # coordinates are available. Facing changes, sprite animation, or bump
        # animation can change pixels without moving a tile; using that as
        # position truth would corrupt the benchmark observation contract.
        if before_player.get("positionSource") == "cached LocalMapObject" or after_player.get("positionSource") == "cached LocalMapObject":
            return False
        if before_player.get("positionSource") != "observed_motion_origin" and before_player.get("positionSource") != "observed_motion_fallback":
            return False
        if bool(before_state.get("dialog", {}).get("inDialog")) or bool(after_state.get("dialog", {}).get("inDialog")):
            return False
        if bool(after_state.get("battle", {}).get("in_battle")):
            return False

        before_map_id = str(before_state.get("map", {}).get("id") or "")
        after_map_id = str(after_state.get("map", {}).get("id") or "")
        if before_map_id != after_map_id:
            return False
        before_pos = before_player.get("position")
        if not isinstance(before_pos, list) or len(before_pos) < 2:
            return False
        try:
            before_x = int(before_pos[0])
            before_y = int(before_pos[1])
        except (TypeError, ValueError):
            return False
        dx, dy = DIRECTION_DELTAS[direction]
        next_x = before_x + dx
        next_y = before_y + dy
        if not self.has_valid_minimap_position(before_map_id, next_x, next_y):
            return False
        self.set_observed_position(
            map_id=before_map_id,
            x=next_x,
            y=next_y,
            z=safe_int(before_player.get("elevation"), 0),
            source="observed_motion_fallback",
            frame=safe_int(frame, 0) if frame is not None else None,
        )
        return True

    def _region_visual_stats(self, rgb: Any, x0: int, y0: int, x1: int, y1: int) -> Dict[str, float]:
        total = 0
        white = 0
        border = 0
        dark = 0
        area = max(1, (x1 - x0) * (y1 - y0))
        step = max(1, int((area / 8000) ** 0.5))
        for y in range(max(0, y0), max(0, y1), step):
            for x in range(max(0, x0), max(0, x1), step):
                r, g, b = rgb.getpixel((x, y))
                total += 1
                if r >= 220 and g >= 220 and b >= 220:
                    white += 1
                if 55 <= r <= 175 and 55 <= g <= 175 and 55 <= b <= 175:
                    border += 1
                if r <= 110 and g <= 110 and b <= 110:
                    dark += 1
        if total == 0:
            return {"whiteRatio": 0.0, "borderRatio": 0.0, "darkRatio": 0.0}
        return {
            "whiteRatio": white / total,
            "borderRatio": border / total,
            "darkRatio": dark / total,
        }

    def dialog_visual_detection(self) -> Dict[str, Any]:
        if Image is None or not self.screenshot_path.exists():
            return {"active": False, "kind": "unavailable", "confidence": "none"}
        try:
            with Image.open(self.screenshot_path) as image:
                rgb = image.convert("RGB")
                width, height = rgb.size
                top_h = max(1, height // 2)
                regions = [
                    ("top_center_text_box", int(width * 0.02), int(top_h * 0.04), int(width * 0.98), int(top_h * 0.58)),
                    ("top_full_text_box", int(width * 0.02), int(top_h * 0.04), int(width * 0.98), int(top_h * 0.995)),
                    ("top_dialog_box", int(width * 0.02), int(top_h * 0.62), int(width * 0.98), int(top_h * 0.995)),
                    ("top_text_overlay", int(width * 0.02), int(top_h * 0.48), int(width * 0.98), int(top_h * 0.995)),
                    ("lower_top_prompt", int(width * 0.02), int(top_h * 0.78), int(width * 0.98), int(top_h * 0.995)),
                ]
                best: Dict[str, Any] = {"name": "none", "whiteRatio": 0.0, "borderRatio": 0.0, "darkRatio": 0.0}
                for name, x0, y0, x1, y1 in regions:
                    stats = self._region_visual_stats(rgb, x0, y0, x1, y1)
                    candidate = {"name": name, **stats}
                    if candidate["whiteRatio"] > best["whiteRatio"]:
                        best = candidate
                white_ratio = float(best.get("whiteRatio") or 0.0)
                border_ratio = float(best.get("borderRatio") or 0.0)
                dark_ratio = float(best.get("darkRatio") or 0.0)
                tutorial_total = 0
                tutorial_orange = 0
                tutorial_white = 0
                tutorial_blue = 0
                step = max(1, int(((width * top_h) / 9000) ** 0.5))
                for y in range(0, top_h, step):
                    for x in range(0, width, step):
                        r, g, b = rgb.getpixel((x, y))
                        tutorial_total += 1
                        if 135 <= r <= 230 and 70 <= g <= 180 and b <= 95 and r >= g + 25:
                            tutorial_orange += 1
                        if r >= 215 and g >= 215 and b >= 215:
                            tutorial_white += 1
                        if b >= 140 and g >= 120 and r <= 185:
                            tutorial_blue += 1
                tutorial_orange_ratio = tutorial_orange / max(1, tutorial_total)
                tutorial_white_ratio = tutorial_white / max(1, tutorial_total)
                tutorial_blue_ratio = tutorial_blue / max(1, tutorial_total)
                tutorial_text_page = tutorial_orange_ratio >= 0.45 and tutorial_white_ratio >= 0.008
                # Field dialogue boxes are anchored in the lower part of the top
                # DS screen. A global blue/white ratio is too broad in HGSS labs
                # and houses because floors, machines, and windows can mimic it.
                top_dialog_region = next((r for r in [
                    {"name": name, **self._region_visual_stats(rgb, x0, y0, x1, y1)}
                    for name, x0, y0, x1, y1 in regions
                ] if r["name"] == "top_dialog_box"), {})
                top_text_box_page = (
                    float(top_dialog_region.get("whiteRatio") or 0.0) >= 0.25
                    and float(top_dialog_region.get("borderRatio") or 0.0) >= 0.10
                )
                active = (
                    (white_ratio >= 0.20 and border_ratio >= 0.004)
                    or (white_ratio >= 0.28 and dark_ratio >= 0.008)
                    or (white_ratio >= 0.42)
                    or tutorial_text_page
                    or top_text_box_page
                )
                confidence = (
                    "heuristic_high"
                    if active and (white_ratio >= 0.28 or tutorial_text_page or top_text_box_page)
                    else ("heuristic" if active else "none")
                )
                return {
                    "active": bool(active),
                    "kind": (
                        "tutorial_or_intro_text"
                        if tutorial_text_page
                        else ("top_text_box" if top_text_box_page else (str(best.get("name") or "unknown") if active else "none"))
                    ),
                    "confidence": confidence,
                    "whiteRatio": round(white_ratio, 4),
                    "borderRatio": round(border_ratio, 4),
                    "darkRatio": round(dark_ratio, 4),
                    "tutorialOrangeRatio": round(tutorial_orange_ratio, 4),
                    "tutorialWhiteRatio": round(tutorial_white_ratio, 4),
                    "tutorialBlueRatio": round(tutorial_blue_ratio, 4),
                }
        except OSError:
            return {"active": False, "kind": "unavailable", "confidence": "none"}

    def is_dialog_box_visible(self) -> bool:
        return bool(self.dialog_visual_detection().get("active"))

    def temporal_sample_from_response(
        self,
        phase: str,
        response: Dict[str, Any],
        *,
        frames: int = 0,
        changed: Optional[bool] = None,
    ) -> Dict[str, Any]:
        raw_path = Path(response.get("screenshotRawPath") or self.screenshot_path)
        screenshot_info = self.screenshot_file_info(raw_path)
        snapshot_path = self.create_observation_screenshot(raw_path, screenshot_info, response.get("frame"))
        screenshot_hash = normalized_screenshot_hash(screenshot_info.get("hash"))
        ram = response.get("ram") if isinstance(response.get("ram"), dict) else {}
        battle = ram.get("battle") if isinstance(ram.get("battle"), dict) else {}
        text_probe = ram.get("text_probe") if isinstance(ram.get("text_probe"), dict) else {}
        field_menu = normalize_field_menu_from_ram(text_probe)
        dialog_detection = self.dialog_visual_detection()
        battle_candidate = bool(battle.get("in_battle_candidate"))
        screen_mode = "battle" if battle_candidate else ("dialogue" if dialog_detection.get("active") else ("menu" if field_menu.get("active") else "unknown"))
        screenshot_fresh = (
            bool(screenshot_info.get("exists"))
            and isinstance(screenshot_info.get("ageMs"), int)
            and int(screenshot_info["ageMs"]) <= 5000
            and screenshot_info.get("visualAvailable") is not False
            and screenshot_hash is not None
        )
        current_visible_text = promoted_visible_text(
            text_probe,
            in_battle=battle_candidate,
            dialog_visible=bool(dialog_detection.get("active")),
            screenshot_fresh=screenshot_fresh,
            active_battle=battle.get("active_battle") if isinstance(battle.get("active_battle"), dict) else None,
        )
        if screen_mode == "dialogue" and not current_visible_text:
            screen_mode = "inspect_screenshot"
        recent_text_events: List[Dict[str, Any]] = []
        current_frame = response.get("frame") if isinstance(response.get("frame"), int) else safe_int(response.get("frame"), 0)
        for key in ("recent_battle_events", "recent_field_events", "recent_generic_events"):
            events = text_probe.get(key)
            if isinstance(events, list):
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    event_frame = safe_int(event.get("frame"), current_frame)
                    if event_frame > current_frame:
                        continue
                    if current_frame - event_frame > 3600:
                        continue
                    recent_text_events.append(event)
        self.recent_visible_text = update_visible_text_history(
            self.recent_visible_text,
            current_visible_text,
            frame=current_frame,
            screenshot_hash=screenshot_hash,
            observed_at_ms=int(time.time() * 1000),
            recent_events=recent_text_events,
            allowed_recent_surfaces=current_visible_text_surfaces(
                in_battle=battle_candidate,
                dialog_visible=bool(dialog_detection.get("active")),
                screenshot_fresh=screenshot_fresh,
            ),
        )
        sample = {
            "phase": phase,
            "frame": response.get("frame"),
            "frames": int(frames or 0),
            "screenshotHash": screenshot_hash,
            "screenshotPath": snapshot_path or str(raw_path),
            "dialogVisible": bool(dialog_detection.get("active")),
            "dialogKind": dialog_detection.get("kind"),
            "dialogConfidence": dialog_detection.get("confidence"),
            "battleCandidate": battle_candidate,
            "screenMode": screen_mode,
        }
        if current_visible_text:
            sample["currentVisibleText"] = {
                "surface": current_visible_text.get("surface"),
                "source": current_visible_text.get("source"),
                "confidence": current_visible_text.get("confidence"),
                "contract": current_visible_text.get("contract"),
                "decoderContract": current_visible_text.get("decoderContract"),
                "decoderSource": current_visible_text.get("decoderSource"),
                "visibilityContract": current_visible_text.get("visibilityContract"),
                "stableSamples": current_visible_text.get("stableSamples"),
                "contextEpoch": current_visible_text.get("contextEpoch"),
                "text": current_visible_text.get("text"),
            }
        recent_sample_text: List[Dict[str, Any]] = []
        for item in self.recent_visible_text[-3:]:
            if not isinstance(item, dict):
                continue
            recent_sample_text.append(
                {
                    "surface": item.get("surface"),
                    "source": item.get("source"),
                    "confidence": item.get("confidence"),
                    "contract": item.get("contract"),
                    "decoderContract": item.get("decoderContract"),
                    "decoderSource": item.get("decoderSource"),
                    "visibilityContract": item.get("visibilityContract"),
                    "frame": item.get("frame"),
                    "contextEpoch": item.get("contextEpoch"),
                    "screenshotHash": item.get("screenshotHash"),
                    "text": item.get("text"),
                }
            )
        if recent_sample_text:
            sample["recentVisibleText"] = recent_sample_text
        if changed is not None:
            sample["changed"] = bool(changed)
        return sample

    def collect_temporal_observation_samples(
        self,
        *,
        op: str,
        before_state: Dict[str, Any],
        after_state: Dict[str, Any],
        initial_response: Dict[str, Any],
        screen_changed: bool,
    ) -> Dict[str, Any]:
        before_dialog = bool(before_state.get("dialog", {}).get("inDialog")) if isinstance(before_state.get("dialog"), dict) else False
        after_dialog = bool(after_state.get("dialog", {}).get("inDialog")) if isinstance(after_state.get("dialog"), dict) else False
        before_battle = bool(before_state.get("battle", {}).get("in_battle")) if isinstance(before_state.get("battle"), dict) else False
        after_battle = bool(after_state.get("battle", {}).get("in_battle")) if isinstance(after_state.get("battle"), dict) else False
        should_sample = (
            self.temporal_sample_count > 0
            and op in {"press", "hold", "touch", "wait", "a_until_end_of_dialog"}
            and (before_dialog or after_dialog or before_battle or after_battle or op == "a_until_end_of_dialog")
        )
        if not should_sample:
            return {"enabled": False, "frames": [], "events": []}
        samples: List[Dict[str, Any]] = [
            self.temporal_sample_from_response("after_command", initial_response, changed=screen_changed)
        ]
        events: List[str] = ["temporal_observation_samples_captured"]
        last_hash = samples[-1].get("screenshotHash")
        for idx in range(1, self.temporal_sample_count + 1):
            response = self.request({"op": "wait", "frames": self.temporal_sample_frames}, timeout_s=10.0)
            sample_hash = self.file_digest(Path(response.get("screenshotRawPath") or self.screenshot_path))
            changed = bool(sample_hash and sample_hash != last_hash)
            sample = self.temporal_sample_from_response(
                f"sample_{idx}",
                response,
                frames=self.temporal_sample_frames,
                changed=changed,
            )
            samples.append(sample)
            if changed:
                events.append("temporal_sample_screen_changed")
            last_hash = sample_hash or last_hash
        unique_events = list(dict.fromkeys(events))
        result = {
            "enabled": True,
            "reason": "dialog_or_battle_context",
            "sampleFrames": self.temporal_sample_frames,
            "frames": samples[-6:],
            "events": unique_events,
            "dialogObserved": any(bool(sample.get("dialogVisible")) for sample in samples),
            "battleObserved": any(bool(sample.get("battleCandidate")) for sample in samples),
            "screenChangedDuringSamples": any(bool(sample.get("changed")) for sample in samples[1:]),
        }
        self.last_temporal_observation = result
        return result

    def minimap_payload(
        self,
        *,
        map_id: str,
        map_name: str,
        player_x: int,
        player_y: int,
    ) -> Dict[str, Any]:
        if not self.has_valid_minimap_position(map_id, player_x, player_y):
            return {}
        try:
            state = self.minimap_store.build_state(
                map_id=map_id,
                map_name=map_name,
                player_x=player_x,
                player_y=player_y,
                orientation=ORIENTATION_BY_FACING.get(self.last_facing or ""),
            )
            static = self.rom_data.grid_for_position(map_id, player_x, player_y)
            if static and isinstance(state.get("minimap_data"), dict):
                static_grid = static.get("grid")
                if isinstance(static_grid, list) and static_grid:
                    static_confidence = str(static.get("confidence") or "candidate")
                    state["minimap_data"]["static_grid_available"] = True
                    if static_confidence == "rom_derived":
                        state["minimap_data"]["static_grid"] = static_grid
                    state["minimap_data"]["static_width"] = int(static.get("width") or 0)
                    state["minimap_data"]["static_height"] = int(static.get("height") or 0)
                    state["minimap_data"]["static_origin_x"] = int(static.get("originX") or 0)
                    state["minimap_data"]["static_origin_y"] = int(static.get("originY") or 0)
                    state["minimap_data"]["static_source"] = static.get("source")
                    state["minimap_data"]["static_confidence"] = static_confidence
                    state["minimap_data"]["static_coordinate_mode"] = static.get("coordinateMode")
                    if static_confidence == "rom_derived":
                        static_visible = static_grid_visible_area(
                            static_grid,
                            int(static.get("originX") or 0),
                            int(static.get("originY") or 0),
                            state.get("visible_area_data"),
                        )
                        if isinstance(static_visible, dict):
                            state["visible_area_data"] = static_visible
                            state["game_area_meta_tiles"] = static_visible.get("grid")
                    state["rom_map_data"] = {
                        "map_id": map_id,
                        "source": static.get("source"),
                        "confidence": static_confidence,
                        "validationFailure": static.get("validationFailure"),
                        "width": int(static.get("width") or 0),
                        "height": int(static.get("height") or 0),
                        "originX": int(static.get("originX") or 0),
                        "originY": int(static.get("originY") or 0),
                        "coordinateMode": static.get("coordinateMode"),
                        "matrixId": static.get("matrixId"),
                        "matrixName": static.get("matrixName"),
                        "matchingCells": static.get("matchingCells"),
                        "blockedCount": int(static.get("blockedCount") or 0),
                        "freeCount": int(static.get("freeCount") or 0),
                        "events": static.get("events"),
                    }
            return state
        except Exception as error:
            return {
                "minimap_error": str(error),
            }

    def mark_collision_from_trace(self, before_state: Dict[str, Any], direction: Optional[str]) -> None:
        if direction not in DIRECTION_DELTAS:
            return
        map_id = str(before_state.get("map", {}).get("id") or "")
        pos = before_state.get("player", {}).get("position")
        if not isinstance(pos, list) or len(pos) < 2:
            return
        try:
            x = int(pos[0])
            y = int(pos[1])
        except (TypeError, ValueError):
            return
        if not self.has_valid_minimap_position(map_id, x, y):
            return
        dx, dy = DIRECTION_DELTAS[direction]
        try:
            self.minimap_store.mark_collision(map_id=map_id, x=x + dx, y=y + dy)
        except Exception:
            pass

    def observe_movement_from_trace(
        self,
        before_state: Dict[str, Any],
        after_state: Dict[str, Any],
        direction: Optional[str],
        *,
        collided: bool,
    ) -> Dict[str, Any]:
        before_map_id = str(before_state.get("map", {}).get("id") or "")
        after_map_id = str(after_state.get("map", {}).get("id") or "")
        before_pos = before_state.get("player", {}).get("position")
        after_pos = after_state.get("player", {}).get("position")
        if not isinstance(before_pos, list) or not isinstance(after_pos, list) or len(before_pos) < 2 or len(after_pos) < 2:
            return {}
        try:
            before_x = int(before_pos[0])
            before_y = int(before_pos[1])
            after_x = int(after_pos[0])
            after_y = int(after_pos[1])
        except (TypeError, ValueError):
            return {}

        if before_map_id != after_map_id:
            if self.has_valid_minimap_position(before_map_id, before_x, before_y):
                self.minimap_store.update_player_tile(map_id=before_map_id, x=before_x, y=before_y)
            if self.has_valid_minimap_position(after_map_id, after_x, after_y):
                self.minimap_store.update_player_tile(map_id=after_map_id, x=after_x, y=after_y)
            return {"events": ["heartgold_map_transition_observed"]}

        if not self.has_valid_minimap_position(before_map_id, before_x, before_y):
            return {}

        attempted_x = None
        attempted_y = None
        if direction in DIRECTION_DELTAS:
            dx, dy = DIRECTION_DELTAS[direction]
            attempted_x = before_x + dx
            attempted_y = before_y + dy

        try:
            return self.minimap_store.observe_movement(
                map_id=before_map_id,
                before_x=before_x,
                before_y=before_y,
                after_x=after_x,
                after_y=after_y,
                attempted_x=attempted_x,
                attempted_y=attempted_y,
                collided=collided,
            )
        except Exception as error:
            return {"events": [f"heartgold_minimap_observation_failed:{error}"]}

    def build_snapshot_data(self, response: Dict[str, Any]) -> Dict[str, Any]:
        screenshot_raw_path = response.get("screenshotRawPath") or str(self.screenshot_path)
        screenshot_path = Path(screenshot_raw_path)
        screenshot_info = self.screenshot_file_info(screenshot_path)
        heartbeat_age_s = self.heartbeat_age_s()
        frame = response.get("frame")
        screenshot_snapshot_path = self.create_observation_screenshot(screenshot_path, screenshot_info, frame)
        screenshot_hash = normalized_screenshot_hash(screenshot_info.get("hash"))
        screenshot_info["hash"] = screenshot_hash
        if screenshot_snapshot_path:
            snapshot_hash = self.file_digest(Path(screenshot_snapshot_path))
            snapshot_hash = normalized_screenshot_hash(snapshot_hash)
            if snapshot_hash:
                screenshot_hash = snapshot_hash
                screenshot_info["hash"] = snapshot_hash
        screenshot_cache_key = "_".join(
            str(part)
            for part in (
                frame if frame is not None else "unknown",
                str(screenshot_hash)[:12] if screenshot_hash else screenshot_info.get("mtimeMs") or "missing",
            )
            if part is not None
        )
        client_screen_width = response.get("clientScreenWidth")
        client_screen_height = response.get("clientScreenHeight")
        screen_width = screenshot_info.get("rawWidth") or response.get("screenWidth") or 256
        screen_height = screenshot_info.get("rawHeight") or response.get("screenHeight") or 384
        screenshot_fresh = (
            bool(screenshot_info.get("exists"))
            and isinstance(screenshot_info.get("ageMs"), int)
            and int(screenshot_info["ageMs"]) <= 5000
            # Heartbeat freshness is a harness health diagnostic. A response-bound
            # screenshot can still be current when the heartbeat file lags behind.
            and screenshot_info.get("visualAvailable") is not False
            and screenshot_hash is not None
            and bool(screenshot_snapshot_path or screenshot_raw_path)
            and frame is not None
            and int(screen_width or 0) == 256
            and int(screen_height or 0) == 384
        )
        ram = response.get("ram") if isinstance(response.get("ram"), dict) else {}
        ram_player = ram.get("player") if isinstance(ram.get("player"), dict) else {}
        player_profile = ram_player.get("profile") if isinstance(ram_player.get("profile"), dict) else {}
        player_profile_header = player_profile.get("header") if isinstance(player_profile.get("header"), dict) else {}
        player_profile_validated = (
            player_profile.get("validation") == "validated_player_profile_header_and_bounds"
            and save_array_header_validated(player_profile_header, expected_id=1, expected_size=0x30, expected_block_id=0)
            and str(player_profile.get("source") or "").startswith("FieldSystem.saveData")
        )
        ram_position = ram_player.get("position") if isinstance(ram_player.get("position"), dict) else {}
        object_position = ram_player.get("object_position") if isinstance(ram_player.get("object_position"), dict) else {}
        save_position = ram_player.get("save_position") if isinstance(ram_player.get("save_position"), dict) else {}
        if ram_position:
            ram_position = dict(ram_position)
        field_location = (
            object_position.get("field_system_location")
            if isinstance(object_position, dict) and isinstance(object_position.get("field_system_location"), dict)
            else ram_position.get("field_system_location")
            if isinstance(ram_position.get("field_system_location"), dict)
            else {}
        )
        field_map_id, field_map_source, field_map_reason = current_map_id_from_field_location(field_location)
        if field_map_id is not None:
            ram_position["local_map_object_map_id"] = ram_position.get("map_id")
            ram_position["map_id"] = field_map_id
            ram_position["map_id_source"] = field_map_source
            ram_position["map_id_currentness"] = "verified_current"
            ram_position["map_id_evidence"] = field_map_reason
            ram_position["field_system_location"] = field_location
        else:
            save_map_id, save_map_source, save_map_reason = current_map_id_from_save_position(save_position)
            ram_position["map_id_candidate_source"] = field_map_source
            ram_position["map_id_candidate_rejected_reason"] = field_map_reason
            if save_position:
                ram_position["save_position_currentness"] = "diagnostic_not_runtime_currentness"
                ram_position["save_position_candidate_map_id"] = save_map_id
                ram_position["save_position_candidate_source"] = save_map_source
                ram_position["save_position_candidate_rejected_reason"] = save_map_reason
            if field_location:
                ram_position["field_system_location"] = field_location
        if object_position and "facing" not in ram_position:
            for key in ("facing", "next_facing", "previous_facing"):
                if key in object_position:
                    ram_position[key] = object_position.get(key)
        if object_position and "rootBindingValid" in object_position:
            ram_position["rootBindingValid"] = object_position.get("rootBindingValid")
        ram_badges = ram_player.get("badges") if player_profile_validated and isinstance(ram_player.get("badges"), dict) else {}
        badge_flags = {name: bool(ram_badges.get(name)) for name in BADGE_FLAGS}
        badge_count = sum(1 for value in badge_flags.values() if value)
        resolved_position = self.resolve_player_position(ram_position, frame)
        map_id = str(resolved_position.get("map_id") or "unknown")
        map_meta = map_metadata(map_id)
        map_name = str(map_meta.get("name") or "Unknown")
        map_name_source = str(map_meta.get("nameSource") or "unknown")
        map_constant_confidence = str(map_meta.get("identityConfidence") or "unknown")
        map_currentness = str(resolved_position.get("raw", {}).get("map_id_currentness") or "unknown")
        if map_constant_confidence in {"known_constant", "verified_current"} and map_currentness == "verified_current":
            map_identity_confidence = "verified"
        else:
            map_identity_confidence = map_constant_confidence
        player_x = safe_int(resolved_position.get("x"), 0)
        player_y = safe_int(resolved_position.get("y"), 0)
        player_z = safe_int(resolved_position.get("z"), 0)
        facing_value = resolved_position.get("facing") or self.last_facing
        facing_source = str(
            resolved_position.get("facingSource")
            or ("command_trace_last_direction" if self.last_facing else "unknown")
        )
        facing_confidence = str(
            resolved_position.get("facingConfidence")
            or ("candidate" if self.last_facing else "unknown")
        )
        facing_contract = str(
            resolved_position.get("facingContract")
            or ("inferred_from_last_directional_input" if self.last_facing else "unknown")
        )
        state_reliability = str(resolved_position.get("stateReliability") or "ram_candidate_with_visual_guard")
        coordinate_confidence = "high" if resolved_position.get("liveRam") else "medium_or_candidate"
        if coordinate_confidence == "high" and map_identity_confidence == "unknown" and map_id != "unknown":
            map_identity_confidence = "stable_internal_id_name_unknown"
        if coordinate_confidence == "high" and map_identity_confidence == "verified":
            position_confidence = "high"
            position_contract = CURRENT_POSITION_CONTRACT
        elif coordinate_confidence == "high":
            position_confidence = "coordinate_high_map_identity_unverified"
            position_contract = "local_map_object_internal_id_when_source_valid"
            state_reliability = "ram_coordinates_with_stable_internal_map_id"
        else:
            position_confidence = "medium_or_candidate"
            position_contract = "observed_or_candidate_with_visual_guard"
        minimap_state = self.minimap_payload(
            map_id=map_id,
            map_name=map_name,
            player_x=player_x,
            player_y=player_y,
        )
        visible_area = minimap_state.get("visible_area_data") if isinstance(minimap_state, dict) else None
        minimap_data = minimap_state.get("minimap_data") if isinstance(minimap_state, dict) else None
        minimap_grid = minimap_data.get("grid") if isinstance(minimap_data, dict) else None
        static_grid = minimap_data.get("static_grid") if isinstance(minimap_data, dict) else None
        static_grid_confidence = minimap_data.get("static_confidence") if isinstance(minimap_data, dict) else None
        static_grid_available = (
            static_grid_confidence == "rom_derived"
            and isinstance(static_grid, list)
            and len(static_grid) > 0
        )
        battle = ram.get("battle") if isinstance(ram.get("battle"), dict) else {}
        in_battle = bool(battle.get("in_battle_candidate"))
        dialog_detection = self.dialog_visual_detection()
        dialog_visible = bool(dialog_detection.get("active"))
        text_probe = ram.get("text_probe") if isinstance(ram.get("text_probe"), dict) else {}
        global_app = ram.get("global_app") if isinstance(ram.get("global_app"), dict) else {}
        global_app_data = global_app.get("app") if isinstance(global_app.get("app"), dict) else {}
        global_app_name = str(global_app_data.get("app") or "")
        global_app_active = bool(
            global_app.get("active") is True
            and global_app_data.get("active") is True
            and global_app_name
            and global_app_name not in {"none", "unknown"}
        )
        field_menu = normalize_field_menu_from_ram(text_probe)
        naming_state = normalize_naming_from_ram(ram.get("naming"))
        naming_active = naming_state.get("active") is True
        current_visible_text = promoted_visible_text(
            text_probe,
            in_battle=in_battle,
            dialog_visible=dialog_visible,
            screenshot_fresh=screenshot_fresh,
            active_battle=battle.get("active_battle") if isinstance(battle.get("active_battle"), dict) else None,
        )
        if current_visible_text:
            current_visible_text["frame"] = frame if isinstance(frame, int) else safe_int(frame, 0)
            current_visible_text["screenshotHash"] = str(screenshot_hash or "")
        validated_dialog_visible = bool(
            current_visible_text
            and current_visible_text.get("surface") == "field_dialogue"
        )

        party, party_count, party_validation, party_validated, party_presence_detected, party_validation_issues = normalize_party_from_ram(ram)
        battle_data = normalize_battle_from_ram(ram, party)
        battle_enemy_count = len(battle_data.get("enemy_pokemons") or [])
        battle_validated = bool(
            in_battle
            and battle_enemy_count > 0
            and battle_data.get("validation") == "battle_context_battle_mons_validated"
        )
        progress_flags = normalize_progress_flags(ram_player.get("progress_flags"))
        local_field_data = normalize_local_field_data(ram_player.get("local_field_data"))
        if progress_flags.get("validated") and local_field_data.get("validated"):
            progress_flags = {
                **progress_flags,
                "safari_zone_has_step_limit": local_field_data.get("safari_zone_has_step_limit"),
                "safari_zone_steps_remaining": local_field_data.get("safari_zone_steps_remaining"),
                "safari_zone_balls_remaining": (
                    local_field_data.get("safari_zone_balls_remaining")
                    if progress_flags.get("safari_zone_active")
                    else None
                ),
            }
        visibility_evidence_value = visibility_evidence(local_field_data, progress_flags)
        pc_storage = normalize_pc_storage(ram.get("pc_storage"))
        inventory_data = normalize_inventory(ram.get("inventory"))
        inventory_validated = inventory_data.get("validation") == "validated_save_bag_header_and_pocket_bounds"
        important_events = {
            "EVENT_GOT_STARTER": bool(progress_flags.get("got_starter")),
            "EVENT_GOT_POKEDEX": bool(progress_flags.get("got_pokedex")),
            "EVENT_GOT_POKEGEAR": bool(progress_flags.get("got_pokegear")),
            "EVENT_GOT_BAG": bool(progress_flags.get("got_bag")),
        }
        movement_mode = movement_mode_from_ram(ram_player)
        vehicle_state = vehicle_state_from_ram(ram_player)
        mode_sources = {
            "battle": "ram_candidate_flag",
            "dialog": "current_visible_text_v1" if validated_dialog_visible else "visual_dialog_box_monitor_only",
            "naming": naming_state.get("source"),
            "movement": "ram_movement_index_and_vehicle_state",
            "global_app": global_app.get("source"),
        }
        menu_visible = field_menu.get("active") is True and not validated_dialog_visible
        if in_battle:
            screen_mode = "battle"
            screen_mode_confidence = "candidate"
        elif naming_active:
            screen_mode = "naming"
            screen_mode_confidence = "validated_ram"
        elif validated_dialog_visible:
            screen_mode = "dialogue"
            screen_mode_confidence = "ram_visible_text"
        elif menu_visible:
            screen_mode = "menu"
            screen_mode_confidence = "validated_ram"
        elif global_app_active:
            screen_mode = global_app_name
            screen_mode_confidence = "ram_global_overlay"
        elif dialog_visible:
            screen_mode = "inspect_screenshot"
            screen_mode_confidence = "visual_dialog_box_without_ram_visible_text"
        elif movement_mode == "MOVING":
            screen_mode = "overworld_moving"
            screen_mode_confidence = "candidate"
        elif position_confidence != "high":
            screen_mode = "unknown_or_transition"
            screen_mode_confidence = "ram_position_unvalidated"
        else:
            screen_mode = "overworld"
            screen_mode_confidence = "validated_ram"
        rom_map_data = minimap_state.get("rom_map_data") if isinstance(minimap_state, dict) else None
        rom_events = rom_map_data.get("events") if isinstance(rom_map_data, dict) else None
        nearby_warps = nearby_warps_from_events(rom_events, player_x, player_y)
        visible_warps = visible_warps_from_events(rom_events, visible_area, player_x, player_y)
        visible_warp_evidence = visible_warp_view_evidence(
            rom_events,
            visible_area,
            visible_warps,
            player_x,
            player_y,
            map_id,
        )
        visible_interactables = visible_interactables_from_events(
            rom_events,
            visible_area,
            player_x,
            player_y,
            str(resolved_position.get("facing") or ""),
        )
        field_move_affordances = field_move_affordances_from_minimap(
            minimap_data,
            player_x,
            player_y,
            str(resolved_position.get("facing") or ""),
        )
        try:
            current_connections = self.rom_data.current_connections_for_position(map_id, player_x, player_y)
        except Exception as error:
            current_connections = {
                "map_id": map_id,
                "source": "heartgold_rom_map_matrix_current_adjacency",
                "confidence": "validation_failed",
                "validationFailure": str(error),
            }
        current_connections_list = (
            current_connections.get("connections")
            if isinstance(current_connections, dict) and isinstance(current_connections.get("connections"), list)
            else []
        )
        runtime_objects = ram_player.get("runtime_objects") if isinstance(ram_player.get("runtime_objects"), dict) else {}
        npc_entries, npc_entries_visible, npc_summary = normalize_runtime_map_objects(
            runtime_objects,
            player_x,
            player_y,
            map_id,
            rom_events,
            str(resolved_position.get("facing") or ""),
            visible_area,
        )
        visible_interactables = merge_runtime_object_interactables(
            visible_interactables,
            npc_entries_visible,
            visible_area,
            player_x,
            player_y,
            str(resolved_position.get("facing") or ""),
        )
        visible_interactable_evidence = visible_interactable_view_evidence(
            rom_events,
            visible_area,
            visible_interactables,
        )
        field_move_affordances = merge_runtime_field_move_affordances(
            field_move_affordances,
            npc_entries_visible,
        )
        field_move_affordance_evidence_value = field_move_affordance_evidence(
            field_move_affordances,
            resolved_position,
            coordinate_confidence,
            position_confidence,
            facing_confidence,
        )
        pathfinding_available = (
            self.observation_mode == "ram_assisted"
            and screenshot_fresh
            and coordinate_confidence == "high"
            and position_confidence == "high"
            and map_id not in {"unknown", "0", "0-0"}
            and static_grid_available
        )
        pathfinding_disabled_reason = None
        if not pathfinding_available:
            reasons = []
            if self.observation_mode != "ram_assisted":
                reasons.append(f"observation_mode={self.observation_mode}")
            if not screenshot_fresh:
                reasons.append("screenshot_not_fresh")
            if coordinate_confidence != "high":
                reasons.append(f"coordinate_confidence={coordinate_confidence}")
            if position_confidence != "high":
                reasons.append(f"position_confidence={position_confidence}")
            if map_id in {"unknown", "0", "0-0"}:
                reasons.append(f"map_id={map_id}")
            if not isinstance(minimap_grid, list) or len(minimap_grid) == 0:
                reasons.append("minimap_grid_missing")
            if static_grid_confidence != "rom_derived":
                reasons.append(f"static_grid_confidence={static_grid_confidence or 'missing'}")
            if not isinstance(static_grid, list) or len(static_grid) == 0:
                reasons.append("static_grid_missing")
            pathfinding_disabled_reason = ";".join(reasons) or "pathfinding_inputs_unavailable"
        collision_evidence = {
            "currentMapVerified": bool(
                isinstance(rom_map_data, dict)
                and rom_map_data.get("confidence") == "rom_derived"
                and map_id not in {"unknown", "0", "0-0"}
            ),
            "livePositionValidated": bool(
                coordinate_confidence == "high"
                and position_confidence == "high"
                and resolved_position.get("liveRam") is True
            ),
            "metatileBehaviorDecodedForKnownSurfaceCodes": bool(
                static_grid_available
                and isinstance(rom_map_data, dict)
                and rom_map_data.get("confidence") == "rom_derived"
            ),
            "pathfindingAvailable": bool(pathfinding_available),
        }
        recent_text_events: List[Dict[str, Any]] = []
        current_frame = frame if isinstance(frame, int) else safe_int(frame, 0)
        if screenshot_fresh:
            for key in ("recent_battle_events", "recent_field_events"):
                if not isinstance(text_probe.get(key), list):
                    continue
                for event in text_probe.get(key, []):
                    if not isinstance(event, dict):
                        continue
                    event_frame = safe_int(event.get("frame"), current_frame)
                    if event_frame > current_frame:
                        continue
                    if current_frame - event_frame > 3600:
                        continue
                    recent_text_events.append(event)
        self.recent_visible_text = update_visible_text_history(
            self.recent_visible_text,
            current_visible_text,
            frame=current_frame,
            screenshot_hash=screenshot_hash,
            observed_at_ms=int(time.time() * 1000),
            recent_events=recent_text_events,
            allowed_recent_surfaces=current_visible_text_surfaces(
                in_battle=in_battle,
                dialog_visible=dialog_visible,
                screenshot_fresh=screenshot_fresh,
            ),
        )
        battle_contract = (
            "ram_battle_context_active_battlers_and_input_validated"
            if battle_data.get("validation") == "battle_context_battle_mons_validated"
            and isinstance(battle_data.get("battle_input"), dict)
            and battle_data["battle_input"].get("available") is True
            else "ram_battle_context_active_battlers_validated"
            if battle_data.get("validation") == "battle_context_battle_mons_validated"
            else "ram_battle_flag_active_battlers_required_enemy_party_unavailable"
        )
        movement_reliability = movement_mode_reliability(ram_player, movement_mode)
        movement_mode_evidence_value = movement_mode_evidence(movement_reliability, resolved_position)
        movement_reliability = movement_reliability_with_currentness(
            movement_reliability,
            movement_mode_evidence_value,
        )
        movement_vehicle_state = (
            movement_reliability.get("vehicle")
            if isinstance(movement_reliability.get("vehicle"), dict)
            else vehicle_state
        )
        reliability_details = {
            "profile": "heartgold",
            "overall": state_reliability,
            "screenshot": {
                "source": "observed",
                "confidence": "high" if screenshot_fresh else "stale_or_missing",
                "freshness": "fresh" if screenshot_fresh else "stale_or_missing",
            },
            "position": {
                "source": resolved_position.get("source"),
                "mapIdSource": resolved_position.get("mapIdSource"),
                "localMapObjectMapId": resolved_position.get("localMapObjectMapId"),
                "confidence": position_confidence,
                "coordinateConfidence": coordinate_confidence,
                "mapIdentityConfidence": map_identity_confidence,
                "mapConstantConfidence": map_constant_confidence,
                "mapCurrentness": map_currentness,
                "mapNameSource": map_name_source,
                "contract": position_contract,
            },
            "facing": {
                "source": facing_source,
                "confidence": facing_confidence,
                "value": facing_value,
                "raw": resolved_position.get("facingRaw"),
                "contract": facing_contract,
            },
            "movement": movement_reliability,
            "party": {
                "source": ram.get("party_source"),
                "confidence": "validated_ram" if party_validated else "unavailable",
                "contract": "ram_save_party_header_validated_with_pokemon_checksum_and_stats"
                if party_validated
                else "party_checksum_and_stats_validation_required",
                "validation": party_validation,
                "validationIssues": party_validation_issues,
            },
            "inventory": {
                "source": inventory_data.get("source"),
                "confidence": "validated_ram" if inventory_validated else "unavailable",
                "contract": (
                    (
                        inventory_data.get("contract")
                        or "ram_save_bag_slots_header_validated_with_pocket_bounds_and_itemdata_field_pocket_legality"
                    )
                    if inventory_validated
                    else "save_bag_header_validation_required"
                ),
                "validation": inventory_data.get("validation"),
                "reason": inventory_data.get("reason"),
                "validationIssues": inventory_data.get("validation_issues"),
            },
            "pcStorage": {
                "source": pc_storage.get("source"),
                "confidence": (
                    "validated_ram"
                    if pc_storage.get("validation") == "validated_pc_storage_header_and_box_mon_checksums"
                    else "unavailable"
                ),
                "contract": (
                    "ram_pc_storage_current_box_checksums_validated"
                    if pc_storage.get("validation") == "validated_pc_storage_header_and_box_mon_checksums"
                    else "pc_storage_unavailable"
                ),
                "validation": pc_storage.get("validation"),
                "currentBox": pc_storage.get("current_box"),
                "totalMons": pc_storage.get("total_mons"),
            },
            "progress": {
                "source": progress_flags.get("source"),
                "confidence": "validated_ram" if progress_flags.get("validated") else "unavailable",
                "contract": (
                    "ram_save_vars_flags_named_current_progress_no_raw_flags"
                    if progress_flags.get("validated")
                    else "save_vars_flags_named_progress_required"
                ),
                "validation": progress_flags.get("validation"),
            },
            "strength": {
                "source": progress_flags.get("source"),
                "confidence": "validated_ram" if progress_flags.get("validated") else "unavailable",
                "contract": (
                    "ram_save_vars_flags_named_current_progress_no_raw_flags"
                    if progress_flags.get("validated")
                    else "save_vars_flags_named_progress_required"
                ),
                "validation": progress_flags.get("validation"),
            },
            "flash": {
                "source": local_field_data.get("source"),
                "confidence": "validated_ram" if local_field_data.get("validated") and progress_flags.get("validated") else "unavailable",
                "contract": (
                    "ram_local_field_data_current_weather_and_flash_flag_validated"
                    if local_field_data.get("validated") and progress_flags.get("validated")
                    else "local_field_weather_and_flash_flag_validation_required"
                ),
                "validation": local_field_data.get("validation"),
            },
            "visibility": {
                "source": local_field_data.get("source"),
                "confidence": "validated_ram" if local_field_data.get("validated") else "unavailable",
                "contract": (
                    "ram_local_field_data_current_weather_visibility_v1"
                    if local_field_data.get("validated")
                    else "local_field_weather_validation_required"
                ),
                "validation": local_field_data.get("validation"),
                "visibilityState": local_field_data.get("visibility_state"),
                "defogNeeded": local_field_data.get("defog_needed"),
                "visibilityEvidence": visibility_evidence_value,
            },
            "badges": {
                "source": "validated_ram_player_profile_badge_bytes"
                if player_profile_validated
                else "unavailable",
                "confidence": "validated_ram" if player_profile_validated else "unavailable",
                "contract": "ram_player_profile_johto_kanto_badge_flags"
                if player_profile_validated
                else "player_profile_save_array_crc_validation_required",
            },
            "battle": {
                "source": battle_data.get("source") or "hgss_ram_battle_flag",
                "confidence": "validated_ram" if battle_validated else ("candidate" if in_battle else "validated_ram"),
                "contract": battle_contract,
                "enemyCount": battle_enemy_count,
                "validation": battle_data.get("validation"),
            },
            "dialogue": {
                "source": current_visible_text.get("source") if current_visible_text else "screenshot_pixel_heuristic",
                "confidence": current_visible_text.get("confidence") if current_visible_text else (dialog_detection.get("confidence") or "heuristic"),
                "kind": dialog_detection.get("kind"),
                "text": "validated_current_ram" if current_visible_text else "unknown",
                "contract": current_visible_text.get("contract") if current_visible_text else "screenshot_observed_pixel_heuristic",
                "surface": current_visible_text.get("surface") if current_visible_text else None,
            },
            "menu": {
                "source": field_menu.get("source"),
                "confidence": field_menu.get("confidence"),
                "contract": field_menu.get("contract"),
                "active": field_menu.get("active"),
                "menuKind": field_menu.get("menuKind"),
                "selectedIndex": field_menu.get("selectedIndex"),
            },
            "naming": {
                "source": naming_state.get("source"),
                "confidence": naming_state.get("confidence"),
                "contract": naming_state.get("contract"),
                "active": naming_state.get("active"),
                "validation": naming_state.get("validation"),
                "entryLength": naming_state.get("entryLength"),
                "maxLen": naming_state.get("maxLen"),
            },
            "npcs": {
                "source": npc_summary.get("source"),
                "confidence": npc_summary.get("confidence"),
                "contract": npc_summary.get("contract"),
                "count": npc_summary.get("count"),
                "visibleCount": npc_summary.get("visibleCount"),
                "staticBoundCount": npc_summary.get("staticBoundCount"),
                "rootBinding": npc_summary.get("rootBinding"),
            },
            "money": {
                "source": "ram_player_profile_money"
                if player_profile_validated
                else "unavailable",
                "confidence": "validated_ram" if player_profile_validated else "unavailable",
                "contract": "ram_player_profile_money_bounds_validated"
                if player_profile_validated
                else "player_profile_save_array_crc_validation_required",
            },
            "warps": {
                "source": "heartgold_rom_zone_event_visible_viewport" if isinstance(rom_events, dict) else "not_decoded",
                "confidence": "rom_derived" if isinstance(rom_events, dict) else "unknown",
                "contract": "rom_derived_static_warp_events_current_map" if isinstance(rom_events, dict) else "unknown",
                "eventsBank": rom_events.get("eventsBank") if isinstance(rom_events, dict) else None,
                "count": len(rom_events.get("warps") or []) if isinstance(rom_events, dict) else 0,
                "visibleWarpEvidence": visible_warp_evidence,
            },
            "interactables": {
                "source": visible_interactables.get("source") if isinstance(visible_interactables, dict) else "not_decoded",
                "confidence": visible_interactables.get("confidence") if isinstance(visible_interactables, dict) else "unknown",
                "contract": visible_interactables.get("contract") if isinstance(visible_interactables, dict) else "unknown",
                "count": visible_interactables.get("visibleCount") if isinstance(visible_interactables, dict) else 0,
                "visibleInteractableEvidence": visible_interactable_evidence,
            },
            "fieldMoveAffordances": {
                "source": field_move_affordances.get("source") if isinstance(field_move_affordances, dict) else "not_decoded",
                "confidence": field_move_affordances.get("confidence") if isinstance(field_move_affordances, dict) else "unknown",
                "contract": field_move_affordances.get("contract") if isinstance(field_move_affordances, dict) else "unknown",
                "count": len(field_move_affordances.get("affordances") or []) if isinstance(field_move_affordances, dict) else 0,
                "fieldMoveAffordanceEvidence": field_move_affordance_evidence_value,
            },
            "currentConnections": {
                "source": current_connections.get("source") if isinstance(current_connections, dict) else "not_decoded",
                "confidence": current_connections.get("confidence") if isinstance(current_connections, dict) else "unknown",
                "contract": current_connections.get("contract") if isinstance(current_connections, dict) else "unknown",
                "count": len(current_connections_list),
                "currentCellEvidence": current_connections.get("currentCellEvidence") if isinstance(current_connections, dict) else None,
                "validationFailure": current_connections.get("validationFailure") if isinstance(current_connections, dict) else None,
            },
            "romCollision": {
                "source": rom_map_data.get("source") if isinstance(rom_map_data, dict) else "rom_narc_a_0_6_5",
                "confidence": rom_map_data.get("confidence") if isinstance(rom_map_data, dict) else "candidate_until_map_mapping_verified",
                "contract": "rom_derived_matrix_land_data_with_live_position_validation"
                if isinstance(rom_map_data, dict) and rom_map_data.get("confidence") == "rom_derived"
                else "candidate_until_map_mapping_verified",
                "collisionEvidence": collision_evidence,
            },
        }
        primary_visual_observation = [
            "ds_screenshot",
            "screenshot_freshness_hash_timestamp",
            "deterministic_model_image_metadata",
            "sanitized_action_traces",
            "model_owned_memory_objectives",
            "tool_contract_without_pathfinding",
            "ram_gameplay_state_excluded_from_model_input",
        ]
        ram_assisted_observation = [
            "ds_screenshot",
            "screenshot_freshness_hash_timestamp",
            "current_position_map",
            "verified_visible_minimap_fog_of_war",
            "current_party_inventory_basics",
            "current_mode_detector",
            "memory_objectives_markers",
            "action_traces_collisions",
            "current_visible_text",
            "current_naming_entry_text",
            "current_runtime_npcs_current_map",
            "current_visible_interactable_affordances",
            "current_facing_field_move_affordances",
            "recent_visible_text_history",
        ]
        observation_policy = {
            "mode": self.observation_mode,
            "exposeOracle": self.expose_oracle,
            "stateConfidenceRequired": self.confidence_required,
            "surfaceLane": "visual" if self.observation_mode == "visual" else (
                "ram_assisted" if self.observation_mode == "ram_assisted" else "monitor"
            ),
            "runComparable": self.observation_mode in {"visual", "ram_assisted"} and not self.expose_oracle,
            "gameObservation": primary_visual_observation
            if self.observation_mode == "visual"
            else ram_assisted_observation,
            "modelInputBoundary": "prompt_builder_must_use_sanitized_model_surface_only",
            "monitorOnlyNotSentToModel": True,
            "monitorOnlyArtifacts": [
                "raw_ram_candidates",
                "decoder_confidence",
                "stale_screenshot_counters",
                "ipc_timeout_counters",
                "pathfinder_failure_reason",
                "command_success_failure",
                "map_transition_evidence",
                "detector_disagreement",
            ],
            "oracleDebug": "disabled" if not self.expose_oracle else "enabled_for_debug_only",
        }
        harness_diagnostics = {
            "rawRamCandidatesAvailable": bool(ram),
            "decodeTiming": ram.get("decode_timing"),
            "preferredMemoryDomain": ram.get("domain"),
            "memoryDomainMode": ram.get("domain_mode"),
            "failedRamReads": ram.get("failed_ram_reads"),
            "availableMemoryDomains": ram.get("available_domains"),
            "bridgeFeatures": {
                "expectedFeatureVersion": BRIDGE_FEATURE_VERSION,
                "currentFeatureVersion": safe_int(response.get("bridgeFeatureVersion"), 0),
                "stale": safe_int(response.get("bridgeFeatureVersion"), 0) < BRIDGE_FEATURE_VERSION,
                "features": response.get("features") if isinstance(response.get("features"), dict) else {},
                "genericTextPrinterAvailable": (
                    isinstance(response.get("features"), dict)
                    and response.get("features", {}).get("genericTextPrinter") is True
                ),
            },
            "ramTextProbe": {
                "source": "ram_text_probe_monitor_only",
                "contract": "monitor_only_monitor_surface_until_validated",
                "battle": text_probe.get("battle"),
                "field": text_probe.get("field"),
                "generic": text_probe.get("generic"),
                "recent_battle_events": text_probe.get("recent_battle_events")
                if isinstance(text_probe.get("recent_battle_events"), list)
                else [],
                "recent_generic_events": text_probe.get("recent_generic_events")
                if isinstance(text_probe.get("recent_generic_events"), list)
                else [],
                "recent_field_events": text_probe.get("recent_field_events")
                if isinstance(text_probe.get("recent_field_events"), list)
                else [],
            },
            "decoderConfidence": reliability_details,
            "positionResolution": resolved_position,
            "mapMetadata": map_meta,
            "screenshot": screenshot_info,
            "heartbeatAgeSeconds": heartbeat_age_s,
            "recentTemporalObservation": self.last_temporal_observation or {
                "enabled": False,
                "frames": [],
                "events": [],
            },
        }

        return {
            "game": {
                "profile": "heartgold",
                "title": "Pokemon HeartGold",
                "platform": "Nintendo DS",
                "generation": 4,
                "region": "Johto/Kanto",
                "badgeTotal": 16,
                "romMd5": "258CEA3A62AC0D6EB04B5A0FD764D788",
                "romSha256": "65F02A56842B75AA92D775D56D657A56FE3FA993550B04DC20704AB82D760105",
                "stateReliability": state_reliability,
                "observationContract": "ram_assisted_current_game_state_by_default; visual_and_monitor_modes_are_separate",
                "observationMode": self.observation_mode,
                "exposeOracle": self.expose_oracle,
                "stateConfidenceRequired": self.confidence_required,
            },
            "observationPolicy": observation_policy,
            "emulator": {
                "name": "BizHawk",
                "core": "melonDS",
                "system": response.get("system"),
                "frame": frame,
                "screenWidth": screen_width,
                "screenHeight": screen_height,
                "clientScreenWidth": client_screen_width,
                "clientScreenHeight": client_screen_height,
                "screenshotRawPath": screenshot_raw_path,
                "screenshotSnapshotPath": screenshot_snapshot_path,
                "screenshotCacheKey": screenshot_cache_key,
                "screenshotFresh": screenshot_fresh,
                "screenshotHash": screenshot_hash,
                "screenshotAgeMs": screenshot_info.get("ageMs"),
                "screenshotMtimeMs": screenshot_info.get("mtimeMs"),
                "screenshotExists": screenshot_info.get("exists"),
                "screenshotRawWidth": screenshot_info.get("rawWidth"),
                "screenshotRawHeight": screenshot_info.get("rawHeight"),
                "anchorStatePath": response.get("anchorStatePath"),
                "anchorSaved": response.get("anchorSaved"),
                "anchorError": response.get("anchorError"),
                "heartbeatAgeSeconds": heartbeat_age_s,
            },
            "screenshot_raw_path": screenshot_raw_path,
            "screenshotSnapshotPath": screenshot_snapshot_path,
            "screenshotCacheKey": screenshot_cache_key,
            "screenshotFresh": screenshot_fresh,
            "screenshotHash": screenshot_hash,
            "screenshotAgeMs": screenshot_info.get("ageMs"),
            "observationFreshness": {
                "screenshotPath": screenshot_raw_path,
                "screenshotSnapshotPath": screenshot_snapshot_path,
                "screenshotCacheKey": screenshot_cache_key,
                "screenshotFresh": screenshot_fresh,
                "screenshotHash": screenshot_hash,
                "screenshotAgeMs": screenshot_info.get("ageMs"),
                "screenshotMtimeMs": screenshot_info.get("mtimeMs"),
                "screenshotExists": screenshot_info.get("exists"),
                "screenshotRawWidth": screenshot_info.get("rawWidth"),
                "screenshotRawHeight": screenshot_info.get("rawHeight"),
                "heartbeatAgeSeconds": heartbeat_age_s,
                "visualAvailable": screenshot_info.get("visualAvailable"),
                "frame": frame,
            },
            "stateReliability": state_reliability,
            "stateReliabilityDetails": reliability_details,
            "harnessDiagnostics": harness_diagnostics,
            "oracleDebug": {"raw_state": "redacted_in_standard_mode"}
            if not self.expose_oracle
            else {"raw_ram": ram, "rom_data_metadata": self.rom_data.metadata()},
            "ramDecoderConfidence": "partial",
            "screen_mode": screen_mode,
            "screen_mode_confidence": screen_mode_confidence,
            "global_app": global_app,
            "positionConfidence": reliability_details["position"]["confidence"],
            "battleConfidence": reliability_details["battle"]["confidence"],
            "inventoryConfidence": reliability_details["inventory"]["confidence"],
            "partyConfidence": reliability_details["party"]["confidence"],
            "ram_assisted": {
                "map": {
                    "id": map_id,
                    "name": map_name,
                    "nameSource": map_name_source,
                    "identityConfidence": map_identity_confidence,
                    "contract": "stable_internal_map_id"
                    if map_identity_confidence == "stable_internal_id_name_unknown"
                    else map_identity_confidence,
                },
                "position": {
                    "x": player_x,
                    "y": player_y,
                    "elevation": player_z,
                    "source": resolved_position.get("source"),
                    "mapIdSource": resolved_position.get("mapIdSource"),
                    "localMapObjectMapId": resolved_position.get("localMapObjectMapId"),
                    "liveRam": bool(resolved_position.get("liveRam")),
                    "coordinateConfidence": coordinate_confidence,
                    "positionConfidence": position_confidence,
                    "contract": position_contract,
                },
                "facing": {
                    "value": facing_value,
                    "raw": resolved_position.get("facingRaw"),
                    "source": facing_source,
                    "confidence": facing_confidence,
                    "contract": facing_contract,
                },
                "modeDetector": {
                    "mode": screen_mode,
                    "confidence": screen_mode_confidence,
                    "battle": {
                        "active": in_battle,
                        "source": "ram_candidate_flag",
                        "confidence": "candidate",
                    },
                    "dialog": {
                        "active": validated_dialog_visible,
                        "source": "current_visible_text_v1" if validated_dialog_visible else "visual_dialog_box_monitor_only",
                        "confidence": "ram_visible_text" if validated_dialog_visible else "visual_only_unvalidated_for_model",
                        "kind": dialog_detection.get("kind"),
                        "visualActive": dialog_visible,
                        "visualConfidence": dialog_detection.get("confidence") or "heuristic",
                    },
                    "menu": {
                        "active": menu_visible,
                        "source": field_menu.get("source") if field_menu.get("active") is True else "unavailable",
                        "confidence": field_menu.get("confidence") if field_menu.get("active") is True else "none",
                        "contract": field_menu.get("contract"),
                        "title": field_menu.get("title"),
                        "pocket": field_menu.get("pocket"),
                        "cursor": field_menu.get("cursor"),
                        "mode": field_menu.get("mode"),
                        "box": field_menu.get("box"),
                        "menuKind": field_menu.get("menuKind"),
                        "selectedIndex": field_menu.get("selectedIndex"),
                        "items": field_menu.get("items") if field_menu.get("active") is True else [],
                    },
                    "naming": naming_state,
                    "movement": {
                        "mode": movement_mode,
                        "source": movement_reliability.get("source"),
                        "confidence": movement_reliability.get("confidence"),
                        "contract": movement_reliability.get("contract"),
                        "vehicle": movement_vehicle_state.get("vehicle"),
                        "surfing": movement_vehicle_state.get("surfing"),
                        "biking": movement_vehicle_state.get("biking"),
                        "bikeType": movement_vehicle_state.get("bikeType"),
                        "diving": movement_vehicle_state.get("diving"),
                        "movementModeEvidence": movement_mode_evidence_value,
                    },
                    "global_app": global_app,
                    "sources": mode_sources,
                },
                "party": {
                    "count": party_count,
                    "source": ram.get("party_source"),
                    "confidence": reliability_details["party"]["confidence"],
                    "validation": party_validation,
                    "presenceDetected": party_presence_detected,
                    "statsValidated": party_validated,
                    "validationIssues": party_validation_issues,
                    "mons": party,
                },
                "progress": progress_flags,
                "screenshotFreshness": {
                    "fresh": screenshot_fresh,
                    "hash": screenshot_hash,
                    "ageMs": screenshot_info.get("ageMs"),
                    "mtimeMs": screenshot_info.get("mtimeMs"),
                    "rawWidth": screenshot_info.get("rawWidth"),
                    "rawHeight": screenshot_info.get("rawHeight"),
                    "visualAvailable": screenshot_info.get("visualAvailable"),
                    "frame": frame,
                    "heartbeatAgeSeconds": heartbeat_age_s,
                },
                "pathfinding": {
                    "available": pathfinding_available,
                    "disabledReason": pathfinding_disabled_reason,
                    "gridSource": "rom_static_collision_and_visible_interactives" if static_grid_available else ("observed_minimap_fog" if isinstance(minimap_grid, list) else "missing"),
                    "staticGridConfidence": static_grid_confidence,
                    "staticGridAvailable": static_grid_available,
                    "observedGridAvailable": isinstance(minimap_grid, list) and len(minimap_grid) > 0,
                    "unknownStepPolicy": "disabled_for_path_to_location_without_rom_static_grid",
                    "warpEventCount": len(rom_events.get("warps") or []) if isinstance(rom_events, dict) else 0,
                    "nearbyWarpCount": len(nearby_warps),
                    "visibleWarpCount": len(visible_warps),
                    "visibleInteractableCount": visible_interactables.get("visibleCount") if isinstance(visible_interactables, dict) else 0,
                    "currentConnectionCount": len(current_connections_list),
                },
                "warps": {
                    "source": "heartgold_rom_zone_event_visible_viewport" if isinstance(rom_events, dict) else "not_decoded",
                    "confidence": reliability_details["warps"]["confidence"],
                    "contract": reliability_details["warps"]["contract"],
                    "eventsBank": reliability_details["warps"].get("eventsBank"),
                    "nearby": nearby_warps,
                    "visible": visible_warps,
                    "count": reliability_details["warps"].get("count"),
                    "visibleWarpEvidence": visible_warp_evidence,
                },
                "interactables": {
                    "source": visible_interactables.get("source") if isinstance(visible_interactables, dict) else "not_decoded",
                    "confidence": visible_interactables.get("confidence") if isinstance(visible_interactables, dict) else "unknown",
                    "contract": visible_interactables.get("contract") if isinstance(visible_interactables, dict) else "unknown",
                    "visible": visible_interactables.get("entries") if isinstance(visible_interactables, dict) else [],
                    "current": visible_interactables.get("current") if isinstance(visible_interactables, dict) else None,
                    "count": visible_interactables.get("visibleCount") if isinstance(visible_interactables, dict) else 0,
                    "visibleInteractableEvidence": visible_interactable_evidence,
                },
                "field_move_affordances": {
                    **field_move_affordances,
                    "fieldMoveAffordanceEvidence": field_move_affordance_evidence_value,
                } if isinstance(field_move_affordances, dict) else field_move_affordances,
                "visibility": {
                    "source": reliability_details["visibility"]["source"],
                    "confidence": reliability_details["visibility"]["confidence"],
                    "contract": reliability_details["visibility"]["contract"],
                    "reduced": bool(local_field_data.get("visibility_reduced")) if local_field_data.get("validated") else False,
                    "state": local_field_data.get("visibility_state") if local_field_data.get("validated") else "unknown",
                    "flashNeeded": bool(local_field_data.get("flash_needed")) if local_field_data.get("validated") else False,
                    "flashActive": bool(progress_flags.get("flash_active")) if progress_flags.get("validated") else False,
                    "defogNeeded": bool(local_field_data.get("defog_needed")) if local_field_data.get("validated") else False,
                    "defogActive": bool(progress_flags.get("defog_active")) if progress_flags.get("validated") else False,
                    "windowWidthTiles": int(visible_area.get("width") or 0) if isinstance(visible_area, dict) else 0,
                    "windowHeightTiles": int(visible_area.get("height") or 0) if isinstance(visible_area, dict) else 0,
                    "visibilityEvidence": visibility_evidence_value,
                },
                "current_connections": {
                    "source": current_connections.get("source") if isinstance(current_connections, dict) else "not_decoded",
                    "confidence": current_connections.get("confidence") if isinstance(current_connections, dict) else "unknown",
                    "contract": current_connections.get("contract") if isinstance(current_connections, dict) else "unknown",
                    "connections": current_connections_list,
                    "count": len(current_connections_list),
                    "matrixId": current_connections.get("matrixId") if isinstance(current_connections, dict) else None,
                    "matrixName": current_connections.get("matrixName") if isinstance(current_connections, dict) else None,
                    "currentCellX": current_connections.get("currentCellX") if isinstance(current_connections, dict) else None,
                    "currentCellY": current_connections.get("currentCellY") if isinstance(current_connections, dict) else None,
                    "currentCellEvidence": current_connections.get("currentCellEvidence") if isinstance(current_connections, dict) else None,
                    "validationFailure": current_connections.get("validationFailure") if isinstance(current_connections, dict) else None,
                },
                "npcs": {
                    "source": npc_summary.get("source"),
                    "confidence": npc_summary.get("confidence"),
                    "contract": npc_summary.get("contract"),
                    "count": npc_summary.get("count"),
                    "visible": npc_entries_visible,
                    "rootBinding": npc_summary.get("rootBinding"),
                },
            },
            "current_trainer_data": {
                "name": str(ram_player.get("name") or "UNKNOWN"),
                "trainer_id": ram_player.get("trainer_id"),
                "gender": (
                    "male"
                    if safe_int(ram_player.get("gender"), -1) == 0
                    else "female"
                    if safe_int(ram_player.get("gender"), -1) == 1
                    else "unknown"
                ),
                "money": int(ram_player.get("money") or 0) if player_profile_validated else None,
                "badge_count": badge_count if player_profile_validated else None,
                "badge_total": 16,
                "badges": badge_flags if player_profile_validated else {},
                "position": {
                    "map_id": map_id,
                    "map_name": map_name,
                    "map_name_source": map_name_source,
                    "map_identity_confidence": map_identity_confidence,
                    "coordinate_confidence": coordinate_confidence,
                    "position_confidence": position_confidence,
                    "facing": facing_value,
                    "facing_raw": resolved_position.get("facingRaw"),
                    "facing_source": facing_source,
                    "facing_confidence": facing_confidence,
                    "facing_contract": facing_contract,
                    "x": player_x,
                    "y": player_y,
                    "elevation": player_z,
                    "source": resolved_position.get("source"),
                    "map_id_source": resolved_position.get("mapIdSource"),
                    "local_map_object_map_id": resolved_position.get("localMapObjectMapId"),
                    "live_ram": bool(resolved_position.get("liveRam")),
                },
            },
            "current_pokemon_data": party,
            "inventory_data": inventory_data,
            "progress_flags": progress_flags,
            "pc_items": [],
            "pc_data": pc_storage,
            "rom_map_data": rom_map_data,
            "minimap_data": minimap_data,
            "nearby_warps": nearby_warps,
            "visible_warps": visible_warps,
            "visible_interactables": visible_interactables.get("entries") if isinstance(visible_interactables, dict) else [],
            "current_interaction": visible_interactables.get("current") if isinstance(visible_interactables, dict) else None,
            "field_move_affordances": field_move_affordances,
            "current_connections": current_connections,
            "game_area_meta_tiles": minimap_state.get("game_area_meta_tiles"),
            "visible_area_data": visible_area,
            "minimap_legend": {
                "0": "Wall (Collision/Impassable)",
                "1": "Free Ground",
                "2": "Tall Grass",
                "3": "Water",
                "4": "Waterfall",
                "9": "Warp",
                "11": "Interactive (Collision)",
                "15": "Region Map (Collision)",
                "25": "OOB (Collision)",
                "56": "Whirlpool (Collision)",
                "57": "Headbutt Tree (Collision)",
                "null": "Fog of War (Unknown)",
            },
            "npc_entries": npc_entries,
            "npc_entries_visible": npc_entries_visible,
            "is_talking_to_npc": validated_dialog_visible,
            "open_dialog_text": current_visible_text.get("text") if current_visible_text else "",
            "current_visible_text": {
                "active": bool(current_visible_text),
                "surface": current_visible_text.get("surface") if current_visible_text else None,
                "frame": frame if isinstance(frame, int) else safe_int(frame, 0),
                "contextEpoch": current_visible_text.get("contextEpoch") if current_visible_text else None,
                "screenshotHash": str(screenshot_hash or "") if current_visible_text else "",
                "text": current_visible_text.get("text") if current_visible_text else "",
            },
            "recent_visible_text": [
                {
                    "surface": item.get("surface"),
                    "frame": item.get("frame"),
                    "contextEpoch": item.get("contextEpoch"),
                    "screenshotHash": item.get("screenshotHash"),
                    "text": item.get("text"),
                }
                for item in self.recent_visible_text
                if isinstance(item, dict)
            ],
            "current_visible_text": current_visible_text
            if current_visible_text
            else {
                "active": False,
                "source": "ram_visible_text",
                "confidence": "unavailable",
                "contract": "current_visible_text_v1",
            },
            "naming_state": naming_state,
            "recent_visible_text": self.recent_visible_text,
            "is_in_battle": in_battle,
            "battle_data": battle_data,
            "flash_needed": bool(local_field_data.get("flash_needed")) if local_field_data.get("validated") else False,
            "flash_active": bool(progress_flags.get("flash_active")) if progress_flags.get("validated") else False,
            "defog_needed": bool(local_field_data.get("defog_needed")) if local_field_data.get("validated") else False,
            "defog_active": bool(progress_flags.get("defog_active")) if progress_flags.get("validated") else False,
            "visibility_reduced": bool(local_field_data.get("visibility_reduced")) if local_field_data.get("validated") else False,
            "visibility_state": local_field_data.get("visibility_state") if local_field_data.get("validated") else "unknown",
            "visibility_window_width_tiles": int(visible_area.get("width") or 0) if isinstance(visible_area, dict) else 0,
            "visibility_window_height_tiles": int(visible_area.get("height") or 0) if isinstance(visible_area, dict) else 0,
            "visibility_hint": (
                "HeartGold ram_assisted mode is the default gameplay observation. RAM map, "
                "position, minimap, party, bag, battle, money, and badge fields may be "
                "model-visible as current gameplay state."
            ),
            "strength_enabled": bool(progress_flags.get("strength_enabled")) if progress_flags.get("validated") else False,
            "safari_zone_counter": progress_flags.get("safari_zone_balls_remaining") if progress_flags.get("validated") else None,
            "safari_zone_has_step_limit": progress_flags.get("safari_zone_has_step_limit") is True if progress_flags.get("validated") else False,
            "safari_zone_steps_remaining": progress_flags.get("safari_zone_steps_remaining") if progress_flags.get("validated") else None,
            "safari_zone_balls_remaining": progress_flags.get("safari_zone_balls_remaining") if progress_flags.get("validated") else None,
            "safari_zone_active": bool(progress_flags.get("safari_zone_active")) if progress_flags.get("validated") else False,
            "player_movement_mode": movement_mode,
            "important_events": important_events,
            "observation_note": (
                "Primary HeartGold mode is ram_assisted: model-visible state may include "
                "decoded current RAM state, screenshot freshness, model-owned memory/objectives, "
                "markers, minimap/fog-of-war, and sanitized action traces. Monitor-only data remains excluded."
            ),
            "raw_state": {
                "bridge": response,
                "mode": state_reliability,
                "minimap": minimap_state,
                "map_metadata": map_meta,
                "rom_map_data": minimap_state.get("rom_map_data") if isinstance(minimap_state, dict) else None,
                "rom_data_metadata": self.rom_data.metadata(),
                "position_resolution": resolved_position,
                "ram": ram,
            },
        }

    def trace_state_from_response(self, response: Dict[str, Any]) -> Dict[str, Any]:
        screenshot_raw_path = response.get("screenshotRawPath") or str(self.screenshot_path)
        screenshot_path = Path(screenshot_raw_path)
        screenshot_info = self.screenshot_file_info(screenshot_path)
        screenshot_hash = normalized_screenshot_hash(screenshot_info.get("hash"))
        frame = response.get("frame")
        screen_width = screenshot_info.get("rawWidth") or response.get("screenWidth") or 256
        screen_height = screenshot_info.get("rawHeight") or response.get("screenHeight") or 384
        screenshot_fresh = (
            bool(screenshot_info.get("exists"))
            and isinstance(screenshot_info.get("ageMs"), int)
            and int(screenshot_info["ageMs"]) <= 5000
            and screenshot_info.get("visualAvailable") is not False
            and screenshot_hash is not None
            and frame is not None
            and int(screen_width or 0) == 256
            and int(screen_height or 0) == 384
        )

        ram = response.get("ram") if isinstance(response.get("ram"), dict) else {}
        ram_player = ram.get("player") if isinstance(ram.get("player"), dict) else {}
        ram_position = ram_player.get("position") if isinstance(ram_player.get("position"), dict) else {}
        object_position = ram_player.get("object_position") if isinstance(ram_player.get("object_position"), dict) else {}
        save_position = ram_player.get("save_position") if isinstance(ram_player.get("save_position"), dict) else {}
        if ram_position:
            ram_position = dict(ram_position)
        field_location = (
            object_position.get("field_system_location")
            if isinstance(object_position, dict) and isinstance(object_position.get("field_system_location"), dict)
            else ram_position.get("field_system_location")
            if isinstance(ram_position.get("field_system_location"), dict)
            else {}
        )
        field_map_id, field_map_source, field_map_reason = current_map_id_from_field_location(field_location)
        if field_map_id is not None:
            ram_position["local_map_object_map_id"] = ram_position.get("map_id")
            ram_position["map_id"] = field_map_id
            ram_position["map_id_source"] = field_map_source
            ram_position["map_id_currentness"] = "verified_current"
            ram_position["map_id_evidence"] = field_map_reason
            ram_position["field_system_location"] = field_location
        else:
            save_map_id, save_map_source, save_map_reason = current_map_id_from_save_position(save_position)
            ram_position["map_id_candidate_source"] = field_map_source
            ram_position["map_id_candidate_rejected_reason"] = field_map_reason
            if save_position:
                ram_position["save_position_currentness"] = "diagnostic_not_runtime_currentness"
                ram_position["save_position_candidate_map_id"] = save_map_id
                ram_position["save_position_candidate_source"] = save_map_source
                ram_position["save_position_candidate_rejected_reason"] = save_map_reason
            if field_location:
                ram_position["field_system_location"] = field_location
        if object_position and "facing" not in ram_position:
            for key in ("facing", "next_facing", "previous_facing"):
                if key in object_position:
                    ram_position[key] = object_position.get(key)
        if object_position and "rootBindingValid" in object_position:
            ram_position["rootBindingValid"] = object_position.get("rootBindingValid")

        position = self.resolve_player_position(ram_position, frame)
        map_id = position.get("map_id")
        try:
            map_number: Any = int(map_id)
        except (TypeError, ValueError):
            map_number = map_id
        map_meta = map_metadata(str(map_id or "unknown"))
        text_probe = ram.get("text_probe") if isinstance(ram.get("text_probe"), dict) else {}
        battle_data = normalize_battle_from_ram(ram, [])
        field_menu = normalize_field_menu_from_ram(text_probe)
        dialog_detection = self.dialog_visual_detection()
        current_ui = text_probe.get("current_ui") if isinstance(text_probe.get("current_ui"), dict) else {}
        visible_text = ""
        if bool(dialog_detection.get("active")):
            current_ui_text = promoted_current_ui_visible_text(
                current_ui,
                dialog_visible=True,
                screenshot_fresh=screenshot_fresh,
            )
            if isinstance(current_ui_text, dict):
                visible_text = sanitize_current_visible_text(current_ui_text.get("text"))
        state = {
            "map": {
                "group": 0 if isinstance(map_number, int) else None,
                "number": map_number,
                "id": map_id,
                "name": map_meta.get("name") or position.get("map_name"),
            },
            "player": {
                "position": [position.get("x"), position.get("y")],
                "facing": position.get("facing"),
                "facingSource": position.get("facing_source"),
                "facingConfidence": position.get("facing_confidence"),
                "elevation": position.get("elevation"),
                "positionSource": position.get("source"),
                "liveRamPosition": bool(position.get("live_ram")),
            },
            "screenshot": {
                "path": screenshot_raw_path,
                "sha256": screenshot_hash,
                "fresh": screenshot_fresh,
                "ageMs": screenshot_info.get("ageMs"),
                "cacheKey": "_".join(
                    str(part)
                    for part in (
                        frame if frame is not None else "unknown",
                        str(screenshot_hash)[:12] if screenshot_hash else screenshot_info.get("mtimeMs") or "missing",
                    )
                    if part is not None
                ),
            },
            "dialog": {
                "inDialog": bool(dialog_detection.get("active")),
                "visibleText": visible_text,
                "menuType": None,
                "kind": dialog_detection.get("kind"),
                "confidence": dialog_detection.get("confidence"),
            },
            "menu": {
                "inMenu": bool(field_menu.get("active")),
            },
            "battle": battle_data or {"in_battle": False},
            "frame": frame,
        }
        state["phase"] = self.trace_phase(state)
        return state

    def trace_state(self, response: Dict[str, Any]) -> Dict[str, Any]:
        return self.trace_state_from_response(response)

    @staticmethod
    def trace_phase(state: Dict[str, Any]) -> str:
        battle = state.get("battle") if isinstance(state.get("battle"), dict) else {}
        dialog = state.get("dialog") if isinstance(state.get("dialog"), dict) else {}
        menu = state.get("menu") if isinstance(state.get("menu"), dict) else {}
        if bool(battle.get("in_battle")):
            return "battle"
        if bool(dialog.get("inDialog")):
            return "dialogue"
        if bool(menu.get("inMenu")):
            return "menu"
        return "overworld"

    @staticmethod
    def same_tile(before: Dict[str, Any], after: Dict[str, Any]) -> bool:
        before_player = before.get("player", {}) if isinstance(before.get("player"), dict) else {}
        after_player = after.get("player", {}) if isinstance(after.get("player"), dict) else {}
        if not before_player.get("liveRamPosition") or not after_player.get("liveRamPosition"):
            return False
        before_map = before.get("map", {}).get("id")
        after_map = after.get("map", {}).get("id")
        before_position = before_player.get("position")
        after_position = after_player.get("position")
        if before_map is None or after_map is None:
            return False
        if before_position is None or after_position is None:
            return False
        return before_map == after_map and before_position == after_position

    @staticmethod
    def map_changed(before: Dict[str, Any], after: Dict[str, Any]) -> bool:
        before_map = before.get("map", {}).get("id") if isinstance(before.get("map"), dict) else None
        after_map = after.get("map", {}).get("id") if isinstance(after.get("map"), dict) else None
        return before_map is not None and after_map is not None and before_map != after_map

    @staticmethod
    def classify_directional_input_context(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
        before_battle = bool(before.get("battle", {}).get("in_battle")) if isinstance(before.get("battle"), dict) else False
        after_battle = bool(after.get("battle", {}).get("in_battle")) if isinstance(after.get("battle"), dict) else False
        before_dialog = bool(before.get("dialog", {}).get("inDialog")) if isinstance(before.get("dialog"), dict) else False
        after_dialog = bool(after.get("dialog", {}).get("inDialog")) if isinstance(after.get("dialog"), dict) else False
        before_menu = bool(before.get("menu", {}).get("inMenu")) if isinstance(before.get("menu"), dict) else False
        after_menu = bool(after.get("menu", {}).get("inMenu")) if isinstance(after.get("menu"), dict) else False
        if before_battle or after_battle:
            mode = "battle"
        elif before_dialog or after_dialog or before_menu or after_menu:
            mode = "dialogue_or_menu"
        else:
            mode = "overworld"
        return {
            "mode": mode,
            "overworldCollisionCandidate": mode == "overworld",
            "battle": before_battle or after_battle,
            "dialogueOrMenu": before_dialog or after_dialog or before_menu or after_menu,
            "menu": before_menu or after_menu,
        }

    @staticmethod
    def normalize_touch_coordinates(
        x: Optional[int],
        y: Optional[int],
        coordinate_space: Optional[str] = "bottom",
        source_width: Optional[int] = None,
        source_height: Optional[int] = None,
        screen: Optional[str] = "bottom",
    ) -> tuple[int, int]:
        touch_x = 128 if x is None else int(x)
        touch_y = 96 if y is None else int(y)
        space = str(coordinate_space or "bottom").lower().replace("-", "_")
        screen_name = str(screen or ("full" if space != "bottom" else "bottom")).lower()

        if space in {"bottom", "touch", "bottom_screen"}:
            if touch_x < 0 or touch_x > 255 or touch_y < 0 or touch_y > 191:
                raise ValueError("touch coordinates are outside bottom-screen touch range 0..255,0..191")
            return touch_x, touch_y

        if space in {"display", "displayed"}:
            raise ValueError(
                "display/displayed touch coordinates are window-size dependent; "
                "use bottom, full_raw, or model_scaled with explicit source dimensions"
            )

        if space in {"full_raw", "screenshot"}:
            width = int(source_width or 256)
            height = int(source_height or 384)
        elif space in {"model_scaled"}:
            if not source_width or not source_height:
                raise ValueError("model-scaled touch coordinates require source_width and source_height")
            width = int(source_width)
            height = int(source_height)
        else:
            raise ValueError(f"unsupported touch coordinate_space: {coordinate_space}")

        if width <= 0 or height <= 0:
            raise ValueError("touch source dimensions must be positive")
        if touch_x < 0 or touch_x >= width or touch_y < 0 or touch_y >= height:
            raise ValueError("touch coordinates are outside the declared source image dimensions")

        scaled_x = min(255, max(0, (touch_x * 256) // width))
        if screen_name == "bottom":
            scaled_y = min(191, max(0, (touch_y * 192) // height))
        elif screen_name == "full":
            full_y = min(383, max(0, (touch_y * 384) // height))
            if full_y < 192:
                raise ValueError("touch coordinates resolve to the top screen; only bottom-screen touch is valid")
            scaled_y = full_y - 192
        else:
            raise ValueError(f"unsupported touch screen: {screen}")

        if scaled_x < 0 or scaled_x > 255 or scaled_y < 0 or scaled_y > 191:
            raise ValueError("normalized touch coordinates are outside bottom-screen touch range")
        return scaled_x, scaled_y


class Command(BaseModel):
    type: str = Field(default="press")
    buttons: List[str] = Field(default_factory=list)
    frames: int = Field(default=8, ge=1, le=1800)
    allow_collision: bool = False
    intent: Optional[str] = None
    target_x: Optional[int] = None
    target_y: Optional[int] = None
    target_map_id: Optional[str] = None
    target_label: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    screen: str = Field(default="bottom")
    coordinate_space: str = Field(default="bottom")
    source_width: Optional[int] = None
    source_height: Optional[int] = None
    text: Optional[str] = None


class SendCommandsBody(BaseModel):
    commands: List[Command]


class StateBody(BaseModel):
    path: Optional[str] = None


bridge = HeartGoldBridge()
app = FastAPI(title="Pokemon HeartGold BizHawk Bridge")


@app.get("/health")
def health() -> Dict[str, Any]:
    return bridge.health()


@app.post("/launchEmulator")
def launch_emulator() -> Dict[str, Any]:
    return bridge.launch()


@app.post("/bootstrapIntro")
def bootstrap_intro() -> Dict[str, Any]:
    return bridge.bootstrap_intro_menu()


@app.get("/requestData")
def request_data(anchorStatePath: Optional[str] = None) -> Dict[str, Any]:
    request: Dict[str, Any] = {"op": "snapshot"}
    if anchorStatePath:
        request["anchor_state_path"] = str(Path(anchorStatePath))
    full_snapshot_timeout_error = None
    try:
        response = bridge.request(request, timeout_s=bridge.full_snapshot_timeout_s)
    except HTTPException as error:
        if getattr(error, "status_code", None) != 504:
            raise
        full_snapshot_timeout_error = str(getattr(error, "detail", error))
        response = bridge.request(trace_only_request({"op": "snapshot"}), timeout_s=5.0)
        response["fullSnapshotTimeoutRecovered"] = True
        response["fullSnapshotTimeoutError"] = full_snapshot_timeout_error
    data = bridge.build_snapshot_data(response)
    if full_snapshot_timeout_error:
        diagnostics = data.get("harnessDiagnostics") if isinstance(data.get("harnessDiagnostics"), dict) else {}
        diagnostics["fullSnapshotTimeoutRecovered"] = True
        diagnostics["fullSnapshotTimeoutError"] = full_snapshot_timeout_error
        diagnostics["observationFallback"] = "trace_only_visual_after_full_snapshot_timeout"
        data["harnessDiagnostics"] = diagnostics
        raw_state = data.get("raw_state") if isinstance(data.get("raw_state"), dict) else {}
        raw_state["fullSnapshotTimeoutRecovered"] = True
        raw_state["fullSnapshotTimeoutError"] = full_snapshot_timeout_error
        raw_state["observationFallback"] = "trace_only_visual_after_full_snapshot_timeout"
        data["raw_state"] = raw_state
    if not full_snapshot_timeout_error and bridge.should_auto_calibrate_position(data):
        try:
            calibrated = bridge.calibrate_position()
            if calibrated.get("ok"):
                response = bridge.request(request)
                data = bridge.build_snapshot_data(response)
        except Exception as error:
            data.setdefault("raw_state", {})["auto_calibration_error"] = str(error)
    freshness = data.get("observationFreshness") if isinstance(data.get("observationFreshness"), dict) else {}
    screenshot_fresh = (
        data.get("screenshotFresh") is True
        and freshness.get("visualAvailable") is not False
        and bool(data.get("screenshotHash"))
        and bool(data.get("screenshotSnapshotPath") or data.get("screenshot_raw_path"))
        and int(data.get("emulator", {}).get("screenWidth") or 0) == 256
        and int(data.get("emulator", {}).get("screenHeight") or 0) == 384
    )
    response_ok = bool(response.get("ok"))
    return {
        "ok": response_ok and screenshot_fresh,
        "error": (response.get("error") or "Bridge snapshot failed") if not response_ok else (None if screenshot_fresh else "Screenshot is stale or missing"),
        "data": data,
    }


@app.post("/restartConsole")
def restart_console() -> Dict[str, Any]:
    return bridge.restart()


@app.post("/saveState")
def save_state(body: Optional[StateBody] = None) -> Dict[str, Any]:
    return bridge.save_state(body.path if body else None)


@app.post("/loadState")
def load_state(body: Optional[StateBody] = None) -> Dict[str, Any]:
    return bridge.load_state(body.path if body else None)


@app.post("/calibratePosition")
def calibrate_position() -> Dict[str, Any]:
    return bridge.calibrate_position()


@app.get("/minimapSnapshot")
def minimap_snapshot() -> Dict[str, Any]:
    response = bridge.request({"op": "snapshot"})
    data = bridge.build_snapshot_data(response)
    minimap_data = data.get("minimap_data") if isinstance(data.get("minimap_data"), dict) else None
    return {
        "ok": True,
        "data": {
            **(
                minimap_data
                if minimap_data is not None
                else {
                    "map_id": "unknown",
                    "map_name": "Unknown",
                    "grid": None,
                    "width": 0,
                    "height": 0,
                    "player_x": 0,
                    "player_y": 0,
                    "orientation": None,
                }
            ),
            "seq": data["emulator"]["frame"],
            "updatedAtMs": int(time.time() * 1000),
            "visibility_reduced": False,
            "visibility_window_width_tiles": data["visibility_window_width_tiles"],
            "visibility_window_height_tiles": data["visibility_window_height_tiles"],
            "visibility_hint": data["visibility_hint"],
        },
    }


def monotonic_frame_delta(before_frame: Any, after_frame: Any) -> tuple[Optional[int], Optional[int], bool]:
    if not isinstance(before_frame, int) or not isinstance(after_frame, int):
        return None, None, False
    raw_delta = int(after_frame) - int(before_frame)
    if raw_delta < 0:
        return None, raw_delta, False
    return raw_delta, raw_delta, True


def trace_only_request(fields: Dict[str, Any]) -> Dict[str, Any]:
    return {"trace_only": "1", **fields}


@app.post("/sendCommands")
def send_commands(body: SendCommandsBody) -> Dict[str, Any]:
    sequence_started = time.monotonic()
    sequence_before_state = None
    started_in_dialog = False
    started_in_battle = False
    interrupted_by_dialog = False
    interrupted_by_battle = False
    interrupted_at_index = None
    interrupted_by_collision = False
    collision_streak = 0
    remaining_commands: List[Dict[str, Any]] = []
    events: List[str] = []
    results = []
    previous_after_state: Optional[Dict[str, Any]] = None
    target_spec = next(
        (
            {
                "map_id": str(command.target_map_id),
                "x": int(command.target_x),
                "y": int(command.target_y),
                "label": command.target_label,
            }
            for command in body.commands
            if command.target_map_id is not None and command.target_x is not None and command.target_y is not None
        ),
        None,
    )
    def command_payload(command: Command) -> Dict[str, Any]:
        if hasattr(command, "model_dump"):
            return command.model_dump()
        return command.dict()

    for index, command in enumerate(body.commands):
        step_started = time.monotonic()
        op = command.type.lower()
        low_stall_trace = bool(bridge.low_stall_actions and op in {"press", "hold", "wait"})
        buttons = [BUTTON_ALIASES.get(button.lower(), button.lower()) for button in command.buttons]
        direction = None
        timeout_recovered_after_response = None
        if not bridge.low_stall_actions:
            before_response = bridge.request(trace_only_request({"op": "snapshot"}))
            before_state = bridge.trace_state(before_response)
        elif low_stall_trace:
            before_response = None
            before_state = previous_after_state or {}
        else:
            before_response = bridge.request(trace_only_request({"op": "snapshot"}))
            before_state = bridge.trace_state(before_response)
        if sequence_before_state is None:
            sequence_before_state = before_state
            started_in_dialog = bool(sequence_before_state.get("dialog", {}).get("inDialog"))
            started_in_battle = bool(sequence_before_state.get("battle", {}).get("in_battle"))
        if op in {"press", "hold"}:
            direction = bridge.direction_from_buttons(buttons)
            if direction is not None:
                bridge.last_facing = direction
            try:
                response = bridge.request(
                    trace_only_request({
                        "op": op,
                        "buttons": ",".join(buttons),
                        "frames": command.frames,
                    }),
                    timeout_s=max(10.0, command.frames / 30.0 + 5.0),
                )
            except HTTPException as error:
                if getattr(error, "status_code", None) != 504:
                    raise
                response, timeout_recovered_after_response = bridge.recover_timed_out_action(op, before_state, error)
        elif op == "wait":
            try:
                response = bridge.request(
                    trace_only_request({
                        "op": "wait",
                        "frames": command.frames,
                    }),
                    timeout_s=max(10.0, command.frames / 30.0 + 5.0),
                )
            except HTTPException as error:
                if getattr(error, "status_code", None) != 504:
                    raise
                response, timeout_recovered_after_response = bridge.recover_timed_out_action(op, before_state, error)
        elif op == "a_until_end_of_dialog":
            response = bridge.advance_dialog_by_screenshot(command.frames)
        elif op == "touch":
            try:
                touch_x, touch_y = bridge.normalize_touch_coordinates(
                    command.x,
                    command.y,
                    command.coordinate_space,
                    command.source_width,
                    command.source_height,
                    command.screen,
                )
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            try:
                response = bridge.request(
                    trace_only_request({
                        "op": "touch",
                        "x": touch_x,
                        "y": touch_y,
                        "frames": command.frames,
                    }),
                    timeout_s=max(10.0, command.frames / 30.0 + 5.0),
                )
            except HTTPException as error:
                if getattr(error, "status_code", None) != 504:
                    raise
                response, timeout_recovered_after_response = bridge.recover_timed_out_action(op, before_state, error)
        elif op == "type_text":
            response = bridge.type_text_by_dpad(command.text or "")
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported command type: {command.type}")
        next_command = body.commands[index + 1] if index + 1 < len(body.commands) else None
        next_op = next_command.type.lower() if next_command is not None else None
        skip_settle_for_following_wait = bool(bridge.low_stall_actions and op in {"press", "hold"} and next_op == "wait")
        settle_frames = 0 if low_stall_trace or skip_settle_for_following_wait else (
            bridge.action_settle_frames
            if op in {"press", "hold", "touch"} and bridge.action_settle_frames > 0
            else 0
        )
        settle_response = None
        if settle_frames and timeout_recovered_after_response is None:
            try:
                settle_response = bridge.request(
                    trace_only_request({"op": "wait", "frames": settle_frames}),
                    timeout_s=max(10.0, settle_frames / 30.0 + 5.0),
                )
            except HTTPException as error:
                if getattr(error, "status_code", None) != 504:
                    raise
                recovery_payload, timeout_recovered_after_response = bridge.recover_timed_out_action(
                    "settle",
                    before_state,
                    error,
                )
                response.update(recovery_payload)
                response["settleTimeoutRecovered"] = True
        if op in {"a_until_end_of_dialog", "type_text"}:
            after_response = response
        elif timeout_recovered_after_response is not None:
            after_response = timeout_recovered_after_response
        elif settle_response is not None:
            after_response = settle_response
        elif low_stall_trace:
            after_response = response
        else:
            try:
                after_response = bridge.request(trace_only_request({"op": "snapshot"}))
            except HTTPException as error:
                if getattr(error, "status_code", None) != 504:
                    raise
                recovery_payload, timeout_recovered_after_response = bridge.recover_timed_out_action(
                    "post_action_snapshot",
                    before_state,
                    error,
                )
                response.update(recovery_payload)
                after_response = timeout_recovered_after_response
        after_state = bridge.trace_state(after_response)
        response["type"] = op
        response["index"] = index
        response["low_stall_trace"] = low_stall_trace
        response["skip_settle_for_following_wait"] = skip_settle_for_following_wait
        response["command"] = {
            "type": op,
            "buttons": buttons,
            "frames": command.frames,
            "allow_collision": command.allow_collision,
            "intent": command.intent,
            "target_x": command.target_x,
            "target_y": command.target_y,
            "target_map_id": command.target_map_id,
            "target_label": command.target_label,
            "x": command.x,
            "y": command.y,
            "normalized_x": touch_x if op == "touch" else None,
            "normalized_y": touch_y if op == "touch" else None,
            "screen": command.screen,
            "coordinate_space": command.coordinate_space,
            "source_width": command.source_width,
            "source_height": command.source_height,
            "text": command.text,
        }
        response["settleFrames"] = settle_frames
        response["before"] = before_state
        response["after"] = after_state
        response["beforePhase"] = bridge.trace_phase(before_state)
        response["afterPhase"] = bridge.trace_phase(after_state)
        response["postActionPhase"] = response["afterPhase"]
        response["phaseChanged"] = response["beforePhase"] != response["afterPhase"]
        before_frame = before_state.get("frame")
        after_frame = after_state.get("frame")
        frame_delta, raw_frame_delta, frame_delta_reliable = monotonic_frame_delta(before_frame, after_frame)
        response["frameDelta"] = frame_delta
        response["rawFrameDelta"] = raw_frame_delta
        response["frameDeltaReliable"] = frame_delta_reliable
        response["durationMs"] = int((time.monotonic() - step_started) * 1000)
        response["ms"] = response["durationMs"]
        before_screenshot_hash = before_state.get("screenshot", {}).get("sha256")
        after_screenshot_hash = after_state.get("screenshot", {}).get("sha256")
        response["screenChanged"] = bool(
            before_screenshot_hash
            and after_screenshot_hash
            and before_screenshot_hash != after_screenshot_hash
        )
        response["screenChangedUnknown"] = bool(low_stall_trace and not before_screenshot_hash)
        response["mapChanged"] = bridge.map_changed(before_state, after_state)
        if op == "touch":
            touch_debug = response.get("touchDebug") if isinstance(response.get("touchDebug"), dict) else {}
            during_axes = touch_debug.get("during_axes") if isinstance(touch_debug.get("during_axes"), dict) else {}
            actual_x = during_axes.get("Touch X")
            actual_y = during_axes.get("Touch Y")
            expected_x = touch_x
            expected_y = touch_y
            axis_echo_matched = (
                isinstance(actual_x, (int, float))
                and isinstance(actual_y, (int, float))
                and abs(float(actual_x) - float(expected_x)) <= 2
                and abs(float(actual_y) - float(expected_y)) <= 2
            )
            response["inputDelivered"] = bool(response.get("ok"))
            response["inputAccepted"] = bool(response.get("ok"))
            response["axisEchoMatched"] = axis_echo_matched
            response["axisEchoVerified"] = bool(axis_echo_matched)
            response["visibleEffectObserved"] = bool(response["screenChanged"])
            response["effectVerified"] = bool(response["screenChanged"])
            response["semanticTargetVerified"] = None
            response["semanticTargetLabel"] = command.target_label
            if not axis_echo_matched:
                response["axisEchoReliable"] = False
                response["touchAxisEchoWarning"] = (
                    f"touch axis echo mismatch: requested=({expected_x},{expected_y}) "
                    f"actual=({actual_x},{actual_y})"
                )
                if response["effectVerified"]:
                    response["actionOutcome"] = "verified_visible_effect_with_unreliable_axis_echo"
                    response["harnessWarning"] = response["touchAxisEchoWarning"]
                else:
                    response["ok"] = False
                    response["status"] = False
                    response["unreliable"] = True
                    response["actionOutcome"] = "unverified_touch_no_axis_echo_or_visible_effect"
                    response["harnessFailureReason"] = response["touchAxisEchoWarning"]
            elif not response["effectVerified"]:
                response["unreliable"] = True
                response["actionOutcome"] = "unverified_touch_no_visible_effect"
                response["harnessFailureReason"] = "touch axes matched but no visible effect was observed after settle frames"
            elif command.target_label:
                response["actionOutcome"] = "input_delivered_visible_effect_semantic_unverified"
                response["semanticTargetVerified"] = False
                response["harnessWarning"] = (
                    f"touch changed the visible screen, but semantic target '{command.target_label}' "
                    "was not independently verified"
                )
        is_directional = any(button in {"up", "down", "left", "right"} for button in buttons)
        before_state_has_player = isinstance(before_state.get("player"), dict) and isinstance(before_state.get("map"), dict)
        if op in {"press", "hold"} and is_directional and before_state_has_player:
            same_tile_after_command = bridge.same_tile(before_state, after_state)
            input_context = bridge.classify_directional_input_context(before_state, after_state)
            before_facing = before_state.get("player", {}).get("facing") if isinstance(before_state.get("player"), dict) else None
            after_facing = after_state.get("player", {}).get("facing") if isinstance(after_state.get("player"), dict) else None
            facing_changed = bool(before_facing and after_facing and before_facing != after_facing)
            response["sameTileAfterCommand"] = same_tile_after_command
            response["facingChanged"] = facing_changed
            response["directionalInputContext"] = input_context
            preliminary_collision = (
                same_tile_after_command
                and bool(input_context["overworldCollisionCandidate"])
                and not facing_changed
                and not response["mapChanged"]
            )
            if input_context["overworldCollisionCandidate"]:
                response["observedPositionUpdated"] = bridge.apply_observed_directional_motion(
                    before_state,
                    after_state,
                    direction,
                    screen_changed=bool(response["screenChanged"]),
                    collided=preliminary_collision,
                    frame=after_state.get("frame"),
                )
            else:
                response["observedPositionUpdated"] = False
                if same_tile_after_command:
                    response["menuOrBattleInputNoPositionChange"] = True
            if response["observedPositionUpdated"]:
                after_state = bridge.trace_state(after_response)
                response["after"] = after_state
            response["interruptedByCollision"] = (
                bool(input_context["overworldCollisionCandidate"])
                and bridge.same_tile(before_state, after_state)
                and not facing_changed
                and not response["mapChanged"]
                and not command.allow_collision
            )
            response["collisionStreak"] = 1 if response["interruptedByCollision"] else 0
            movement_trace = (
                bridge.observe_movement_from_trace(
                    before_state,
                    after_state,
                    direction,
                    collided=(
                        bool(bridge.same_tile(before_state, after_state))
                        and not facing_changed
                        and not response["mapChanged"]
                        and int(command.frames or 0) >= 6
                    ),
                )
                if input_context["overworldCollisionCandidate"]
                else None
            )
            if movement_trace:
                trace_payload = response.get("trace") if isinstance(response.get("trace"), dict) else {}
                existing_events = trace_payload.get("events") if isinstance(trace_payload.get("events"), list) else []
                trace_payload.update({key: value for key, value in movement_trace.items() if key != "events"})
                trace_payload["events"] = existing_events + [
                    str(event) for event in movement_trace.get("events", []) if event is not None
                ]
                response["trace"] = trace_payload
        else:
            response["interruptedByCollision"] = False
            response["collisionStreak"] = 0
        temporal_observation = bridge.collect_temporal_observation_samples(
            op=op,
            before_state=before_state,
            after_state=after_state,
            initial_response=after_response,
            screen_changed=bool(response["screenChanged"]),
        )
        if temporal_observation.get("enabled"):
            trace_payload = response.get("trace") if isinstance(response.get("trace"), dict) else {}
            trace_payload["temporalSamples"] = temporal_observation.get("frames", [])
            trace_payload["temporalObservationDiagnostic"] = {
                "enabled": True,
                "sampleCount": len(temporal_observation.get("frames", [])),
                "screenChangedDuringSamples": bool(temporal_observation.get("screenChangedDuringSamples")),
            }
            response["trace"] = trace_payload
        if response["interruptedByCollision"]:
            interrupted_by_collision = True
            collision_streak = max(collision_streak, int(response["collisionStreak"]))
            if interrupted_at_index is None:
                interrupted_at_index = index
        before_dialog_active = before_state.get("dialog", {}).get("inDialog")
        after_dialog_active = after_state.get("dialog", {}).get("inDialog")
        before_battle_active = before_state.get("battle", {}).get("in_battle")
        after_battle_active = after_state.get("battle", {}).get("in_battle")
        response["interruptedByDialog"] = bool(after_dialog_active is True and before_dialog_active is False)
        response["interruptedByBattle"] = bool(after_battle_active is True and before_battle_active is False)
        if response["interruptedByDialog"] and interrupted_at_index is None:
            interrupted_by_dialog = True
            interrupted_at_index = index
        if response["interruptedByBattle"]:
            interrupted_by_battle = True
            if interrupted_at_index is None:
                interrupted_at_index = index
        if response["screenChanged"]:
            events.append(f"screen_changed_at_{index}")
        if response.get("mapChanged"):
            events.append("heartgold_map_transition_observed")
        trace_events = response.get("trace", {}).get("events") if isinstance(response.get("trace"), dict) else None
        if isinstance(trace_events, list):
            events.extend(str(event) for event in trace_events)
        results.append(response)
        previous_after_state = after_state
        if response["interruptedByCollision"] or response["interruptedByDialog"] or interrupted_by_battle or response.get("mapChanged"):
            remaining_commands = [command_payload(item) for item in body.commands[index + 1 :]]
            if response.get("mapChanged") and interrupted_at_index is None:
                interrupted_at_index = index
            break
    ok = all(bool(item.get("ok")) for item in results)
    final_state = results[-1]["after"] if results else (sequence_before_state or {})
    semantic_target_verified = None
    semantic_target_reason = None
    if target_spec:
        final_player = final_state.get("player", {}) if isinstance(final_state.get("player"), dict) else {}
        final_position = final_player.get("position") if isinstance(final_player.get("position"), dict) else None
        final_map_id = final_state.get("map", {}).get("id") if isinstance(final_state.get("map"), dict) else None
        if final_position is not None:
            semantic_target_verified = (
                str(final_map_id) == str(target_spec["map_id"])
                and int(final_position.get("x", -999999)) == int(target_spec["x"])
                and int(final_position.get("y", -999999)) == int(target_spec["y"])
            )
            if not semantic_target_verified:
                semantic_target_reason = (
                    f"target_not_reached: expected {target_spec['map_id']} "
                    f"({target_spec['x']},{target_spec['y']}), observed {final_map_id} "
                    f"({final_position.get('x')},{final_position.get('y')})"
                )
                ok = False
        else:
            semantic_target_verified = False
            semantic_target_reason = "target_not_verified: final RAM position unavailable"
            ok = False
    sequence_frame_before = sequence_before_state.get("frame") if isinstance(sequence_before_state, dict) else None
    sequence_frame_after = final_state.get("frame")
    sequence_frame_delta, sequence_raw_frame_delta, sequence_frame_delta_reliable = monotonic_frame_delta(
        sequence_frame_before,
        sequence_frame_after,
    )
    return {
        "ok": ok,
        "status": ok,
        "semanticTarget": target_spec,
        "semanticTargetVerified": semantic_target_verified,
        "semanticTargetReason": semantic_target_reason,
        "startedInDialog": started_in_dialog,
        "startedInBattle": started_in_battle,
        "interruptedByDialog": interrupted_by_dialog,
        "interruptedByBattle": interrupted_by_battle,
        "interruptedByCollision": interrupted_by_collision,
        "interruptedByMapTransition": any(bool(item.get("mapChanged")) for item in results),
        "interruptedAtIndex": interrupted_at_index,
        "remaining_keys": remaining_commands,
        "collisionStreak": collision_streak,
        "frameDelta": sequence_frame_delta,
        "rawFrameDelta": sequence_raw_frame_delta,
        "frameDeltaReliable": sequence_frame_delta_reliable,
        "durationMs": int((time.monotonic() - sequence_started) * 1000),
        "events": events,
        "results": results,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("HEARTGOLD_BRIDGE_PORT", "8010")))
