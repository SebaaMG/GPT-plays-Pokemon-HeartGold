from __future__ import annotations

import argparse
import json
import os
import struct
from pathlib import Path
from typing import Dict, Iterable, List, Optional

try:
    import ndspy.narc
    import ndspy.rom
except ImportError:  # pragma: no cover - caller gets a clear runtime error.
    ndspy = None  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROM = ROOT / ".codex_tmp" / "Pokemon - HeartGold Version (USA).nds"
MSGDATA_MSG_NARC = "/a/0/2/7"
EOS = 0xFFFF
EXT_CTRL_CODE_BEGIN = 0xFFFE
CHAR_LF = 0xE000
CHAR_PAGE = 0x25BC
CHAR_PROMPT = 0x25BD
TRNAMECODE = 0xF100
EOS_TRNAME = 0x01FF
STRVAR_BASE_NAMES = {
    0x0100: "STRVAR_1",
    0x0300: "STRVAR_3",
    0x0400: "STRVAR_4",
    0x3400: "STRVAR_34",
}
CONTROL_NAMES = {
    0x0200: "YESNO",
    0x0201: "PAUSE",
    0x0202: "WAIT",
    0x0203: "CURSOR_X",
    0x0204: "CURSOR_Y",
    0x0205: "ALN_CENTER",
    0x0206: "ALN_RIGHT",
    0x0207: "UNK_207",
    0x0208: "UNK_208",
    0xFF00: "COLOR",
    0xFF01: "SIZE",
    0xFF02: "UNK_FF02",
}


def _fallback_charmap() -> Dict[int, str]:
    charmap: Dict[int, str] = {
        CHAR_LF: "\n",
        CHAR_PAGE: "\r",
        CHAR_PROMPT: "\f",
        0x01DE: " ",
        0x01AB: "!",
        0x01AC: "?",
        0x01AD: ",",
        0x01AE: ".",
        0x01AF: "...",
        0x01B1: "/",
        0x01B2: "'",
        0x01B3: "'",
        0x01B4: '"',
        0x01B5: '"',
        0x01B9: "(",
        0x01BA: ")",
        0x01BD: "+",
        0x01BE: "-",
        0x01BF: "*",
        0x01C0: "#",
        0x01C1: "=",
        0x01C2: "&",
        0x01C3: "~",
        0x01C4: ":",
        0x01C5: ";",
        0x01D0: "@",
        0x01D2: "%",
        0x0188: "é",
        0x01E8: "°",
        0x01E9: "_",
    }
    for idx, char in enumerate("0123456789"):
        charmap[0x0121 + idx] = char
    for idx, char in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
        charmap[0x012B + idx] = char
    for idx, char in enumerate("abcdefghijklmnopqrstuvwxyz"):
        charmap[0x0145 + idx] = char
    return charmap


def load_charmap(path: Optional[Path] = None) -> Dict[int, str]:
    charmap = _fallback_charmap()
    if path is None:
        env_path = os.environ.get("HEARTGOLD_CHARMAP")
        if env_path:
            path = Path(env_path)
        else:
            repo_charmap = Path(".codex_tmp") / "pokeheartgold" / "charmap.txt"
            path = repo_charmap if repo_charmap.exists() else None
    if path is None or not path.exists():
        return charmap

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        # Preserve the right-hand side verbatim: HGSS maps 0x01DE to a literal
        # space, so stripping the whole line would silently corrupt decoded text.
        line = raw_line.lstrip()
        if not line or line.startswith("//") or "=" not in line:
            continue
        raw_code, raw_value = line.split("=", 1)
        try:
            code = int(raw_code.strip(), 16)
        except ValueError:
            continue
        if raw_value == r"\n":
            value = "\n"
        elif raw_value == r"\r":
            value = "\r"
        elif raw_value == r"\f":
            value = "\f"
        elif raw_value.startswith(r"\x"):
            value = ""
        else:
            value = raw_value
        charmap[code] = value
    return charmap


def _read_u16(data: bytes | bytearray, offset: int) -> int:
    if offset + 2 > len(data):
        raise ValueError("truncated u16")
    return struct.unpack_from("<H", data, offset)[0]


def _read_u32(data: bytes | bytearray, offset: int) -> int:
    if offset + 4 > len(data):
        raise ValueError("truncated u32")
    return struct.unpack_from("<I", data, offset)[0]


def _decrypt_alloc(value: int, key: int, message_number: int) -> int:
    alloc_key = (765 * message_number * key) & 0xFFFF
    alloc_key |= alloc_key << 16
    return value ^ alloc_key


def _decrypt_code_units(words: Iterable[int], message_number: int) -> List[int]:
    key = (message_number * 596947) & 0xFFFF
    out: List[int] = []
    for word in words:
        out.append(word ^ key)
        key = (key + 18749) & 0xFFFF
    return out


def decode_code_units(words: Iterable[int], charmap: Optional[Dict[int, str]] = None) -> str:
    mapping = charmap or load_charmap()
    decoded: List[str] = []
    values = list(words)
    i = 0
    while i < len(values):
        code = values[i]
        if code == EOS:
            break
        if code == TRNAMECODE:
            decoded.append("{TRNAME}")
            i += 1
            continue
        if code == EXT_CTRL_CODE_BEGIN:
            if i + 2 >= len(values):
                decoded.append("{CTRL_TRUNCATED}")
                break
            command = values[i + 1]
            argc = values[i + 2]
            args = values[i + 3 : i + 3 + argc]
            command_base = command & 0xFF00
            if command_base in STRVAR_BASE_NAMES:
                command_name = STRVAR_BASE_NAMES[command_base]
                rendered_values = [command & 0xFF, *args]
            else:
                command_name = CONTROL_NAMES.get(command, f"CTRL_{command:04X}")
                rendered_values = args
            rendered_args = ", ".join(str(arg) for arg in rendered_values)
            if rendered_args:
                decoded.append(f"{{{command_name} {rendered_args}}}")
            else:
                decoded.append(f"{{{command_name}}}")
            i += 3 + argc
            continue
        decoded.append(mapping.get(code, f"{{CHAR_{code:04X}}}"))
        i += 1
    return "".join(decoded)


class HgssTextArchive:
    def __init__(self, rom_path: Path = DEFAULT_ROM, charmap_path: Optional[Path] = None) -> None:
        self.rom_path = Path(os.environ.get("HEARTGOLD_ROM", str(rom_path)))
        self.charmap = load_charmap(charmap_path)
        self._msg_files: Optional[List[bytes]] = None

    def available(self) -> bool:
        return ndspy is not None and self.rom_path.exists()

    def _load_msg_files(self) -> List[bytes]:
        if self._msg_files is not None:
            return self._msg_files
        if ndspy is None:
            raise RuntimeError("ndspy is not installed; run pip install -r requirements.txt")
        if not self.rom_path.exists():
            raise RuntimeError(f"HeartGold ROM not found: {self.rom_path}")
        rom = ndspy.rom.NintendoDSRom.fromFile(str(self.rom_path))
        narc = ndspy.narc.NARC(rom.getFileByName(MSGDATA_MSG_NARC))
        self._msg_files = list(narc.files)
        return self._msg_files

    def decode_bank(self, file_id: int) -> List[str]:
        files = self._load_msg_files()
        if file_id < 0 or file_id >= len(files):
            raise IndexError(f"message file id out of range: {file_id}")
        return self._decode_message_file(files[file_id])

    def decode_message(self, file_id: int, message_id: int) -> str:
        bank = self.decode_bank(file_id)
        if message_id < 0 or message_id >= len(bank):
            raise IndexError(f"message id out of range: {file_id}:{message_id}")
        return bank[message_id]

    def _decode_message_file(self, data: bytes) -> List[str]:
        if len(data) < 4:
            raise ValueError("message file too short")
        count = _read_u16(data, 0)
        key = _read_u16(data, 2)
        table_end = 4 + count * 8
        if table_end > len(data):
            raise ValueError("message allocation table is truncated")

        decoded: List[str] = []
        for index in range(count):
            message_number = index + 1
            entry_offset = 4 + index * 8
            offset = _decrypt_alloc(_read_u32(data, entry_offset), key, message_number)
            length = _decrypt_alloc(_read_u32(data, entry_offset + 4), key, message_number)
            start = int(offset)
            end = start + int(length) * 2
            if start < table_end or end > len(data):
                raise ValueError(f"message {index} has invalid span {start}:{end}")
            encrypted_words = [_read_u16(data, start + i * 2) for i in range(int(length))]
            words = _decrypt_code_units(encrypted_words, message_number)
            decoded.append(decode_code_units(words, self.charmap))
        return decoded


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode HeartGold/SoulSilver message text from ROM NARC data.")
    parser.add_argument("file_id", type=int, help="msgdata/msg file id, for example 197 for battle text")
    parser.add_argument("message_id", type=int, nargs="?", help="message row id")
    parser.add_argument("--rom", type=Path, default=None, help="HeartGold/SoulSilver ROM path")
    parser.add_argument("--charmap", type=Path, default=None, help="pret/pokeheartgold charmap.txt path")
    args = parser.parse_args()

    archive = HgssTextArchive(args.rom or DEFAULT_ROM, args.charmap)
    if args.message_id is None:
        messages = archive.decode_bank(args.file_id)
        payload = {"file_id": args.file_id, "count": len(messages), "messages": messages}
    else:
        payload = {
            "file_id": args.file_id,
            "message_id": args.message_id,
            "text": archive.decode_message(args.file_id, args.message_id),
        }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
