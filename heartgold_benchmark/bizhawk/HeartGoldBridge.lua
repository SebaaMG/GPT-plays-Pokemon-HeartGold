-- BizHawk-side bridge for Pokemon HeartGold.
-- Python writes request.txt; this script executes it on frame boundaries and writes response.txt.

IPC_DIR = [[__IPC_DIR__]]
SCREENSHOT_PATH = [[__SCREENSHOT_PATH__]]
HEARTBEAT_PATH = [[__HEARTBEAT_PATH__]]
REQUEST_PATH = IPC_DIR .. [[\request.txt]]
RESPONSE_PATH = IPC_DIR .. [[\response.txt]]
DS_SCREEN_WIDTH = 256
DS_SCREEN_HEIGHT = 384
BRIDGE_PROTOCOL_VERSION = __BRIDGE_PROTOCOL_VERSION__
BRIDGE_FEATURE_VERSION = 5
RECENT_TEXT_SAMPLE_INTERVAL = __RECENT_TEXT_SAMPLE_INTERVAL__
REQUEST_POLL_INTERVAL = __REQUEST_POLL_INTERVAL__

client.displaymessages(false)
client.setscreenshotosd(false)
client.SetSoundOn(false)
client.speedmode(__SPEED_MODE__)
if emu.limitframerate then emu.limitframerate(true) end
nds.setscreenlayout("Vertical")
nds.setscreengap(0)

function file_exists(path)
  local f = io.open(path, "rb")
  if f then
    f:close()
    return true
  end
  return false
end

function read_all(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

function write_all(path, text)
  local f = io.open(path, "wb")
  if not f then return false end
  f:write(text)
  f:close()
  return true
end

function escape_json(value)
  value = tostring(value or "")
  value = value:gsub("\\", "\\\\")
  value = value:gsub("\"", "\\\"")
  value = value:gsub("\r", "\\r")
  value = value:gsub("\n", "\\n")
  return value
end

function is_array_table(value)
  if type(value) ~= "table" then return false end
  local count = 0
  local max_index = 0
  for k, _ in pairs(value) do
    if type(k) ~= "number" then return false end
    if k > max_index then max_index = k end
    count = count + 1
  end
  return max_index == count
end

function json_encode(value)
  local t = type(value)
  if value == nil then
    return "null"
  elseif t == "boolean" then
    return value and "true" or "false"
  elseif t == "number" then
    if value ~= value or value == math.huge or value == -math.huge then return "null" end
    return tostring(math.floor(value) == value and math.floor(value) or value)
  elseif t == "string" then
    return '"' .. escape_json(value) .. '"'
  elseif t == "table" then
    local parts = {}
    if is_array_table(value) then
      for i = 1, #value do
        parts[#parts + 1] = json_encode(value[i])
      end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, v in pairs(value) do
      parts[#parts + 1] = json_encode(tostring(k)) .. ":" .. json_encode(v)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

function parse_request(text)
  local req = {}
  for line in string.gmatch(text or "", "[^\r\n]+") do
    local key, value = line:match("^([A-Za-z0-9_]+)=(.*)$")
    if key then req[key] = value end
  end
  return req
end

function request_id_from_text(text)
  for line in string.gmatch(text or "", "[^\r\n]+") do
    local value = line:match("^id=(.*)$")
    if value then return value end
  end
  return ""
end

local button_names = {
  a = "A",
  b = "B",
  x = "X",
  y = "Y",
  up = "Up",
  down = "Down",
  left = "Left",
  right = "Right",
  l = "L",
  r = "R",
  start = "Start",
  select = "Select",
}

function split_buttons(value)
  local buttons = {}
  for raw in string.gmatch(value or "", "[^,]+") do
    local key = string.lower((raw:gsub("^%s+", ""):gsub("%s+$", "")))
    local mapped = button_names[key]
    if mapped then buttons[mapped] = true end
  end
  return buttons
end

function frame_count(value, default)
  local frames = tonumber(value) or default
  if frames < 1 then frames = 1 end
  if frames > 1800 then frames = 1800 end
  return math.floor(frames)
end

function detect_memory_domain()
  local preferred = {
    "ARM9 System Bus",
    "Main RAM",
  }
  local ok_domains, domain_list = pcall(memory.getmemorydomainlist)
  if ok_domains and type(domain_list) == "table" then
    local domains = {}
    for _, domain in pairs(domain_list) do
      if type(domain) == "string" then
        domains[#domains + 1] = domain
      end
    end
    for _, wanted in ipairs(preferred) do
      for _, domain in ipairs(domains) do
        if domain == wanted then
          local mode = domain == "Main RAM" and "main_ram_offset" or "arm9_bus"
          print("HeartGoldBridge memory domain: " .. domain .. " (" .. mode .. ")")
          return domain, mode
        end
      end
    end
  end
  print("HeartGoldBridge memory domain unavailable; RAM reads disabled")
  return nil, "unavailable"
end

local SYSTEM_BUS, MEMORY_DOMAIN_MODE = detect_memory_domain()
LAST_TOUCH_DEBUG = nil
LAST_TEXT_DEBUG = nil
PLAYER_OBJECT_ADDR = nil
FAILED_RAM_READS = 0

SAVE_PLAYERDATA = 1
SAVE_PARTY = 2
SAVE_BAG = 3
SAVE_FLAGS = 4
SAVE_LOCAL_FIELD_DATA = 5
SAVE_POKEDEX = 6
SAVE_MAP_OBJECTS = 10
local SAVE_PCSTORAGE = 41
SAVE_COUNTER_OFFSET = 0x23010
SAVE_ARRAY_HEADERS_OFFSET = 0x23014
SAVE_SLOT_SPECS_OFFSET = 0x232B4
SAVE_SLOT_SPEC_SIZE = 0x0C
SAVE_LAST_GOOD_SAVE_SLOT_OFFSET = 0x232F0
SAVE_LAST_GOOD_SAVE_NO_OFFSET = 0x232F4
SAVE_LAST_GOOD_SECTOR_OFFSET = 0x2330A
SAVE_DYNAMIC_REGION_OFFSET = 0x10
SAVE_DYNAMIC_REGION_SIZE = 0x23000
SAVE_SECTOR_SIZE = 0x1000
SAVE_PAGE_MAX = 35
SAVE_CHUNK_MAGIC = 0x20060623
SAVE_CHUNK_CRC_TRAILER_SIZE = 4
HGSS_SAVED_MAP_OBJECT_SIZE = 0x50
HGSS_SAVE_MAP_OBJECTS_COUNT = 64
HGSS_SAVE_MAP_OBJECTS_PAYLOAD_SIZE = HGSS_SAVED_MAP_OBJECT_SIZE * HGSS_SAVE_MAP_OBJECTS_COUNT
HGSS_SAVE_MAP_OBJECTS_SAVE_ARRAY_SIZE = HGSS_SAVE_MAP_OBJECTS_PAYLOAD_SIZE + SAVE_CHUNK_CRC_TRAILER_SIZE
HGSS_SAVE_LOCAL_FIELD_DATA_PAYLOAD_SIZE = 0x80
HGSS_SAVE_LOCAL_FIELD_DATA_SAVE_ARRAY_SIZE = HGSS_SAVE_LOCAL_FIELD_DATA_PAYLOAD_SIZE + SAVE_CHUNK_CRC_TRAILER_SIZE
SAVE_CHUNK_FOOTER_SIZE = 0x10
PARTY_MAX_COUNT = 6
PARTY_CORE_SIZE = 0x590
PARTY_MONS_OFFSET = 0x08
PARTY_MON_SIZE = 0xEC
HGSS_PARTY_SIZE = 0x5B0
HGSS_PARTY_SAVE_ARRAY_SIZE = 0x5B4
HGSS_BAG_SIZE = 0x79C
HGSS_BAG_SAVE_ARRAY_SIZE = 0x7A0
HGSS_SAVE_VARS_FLAGS_SAVE_ARRAY_SIZE = 0x450
HGSS_PLAYER_PROFILE_SAVE_ARRAY_SIZE = 0x30
HGSS_POKEDEX_SAVE_ARRAY_SIZE = 0x344
HGSS_ITEM_MAX = 536
HGSS_MOVE_MAX = 467
local PC_BOX_COUNT = 18
local PC_MONS_PER_BOX = 30
local PC_BOX_SIZE = 0x1000
local PC_BOX_MON_SIZE = 0x88
local PC_BOX_NAME_LENGTH = 20
local PC_BOX_APP_OVERLAY_ID = 14
local PARTY_MENU_APP_OVERLAY_ID = 12
local PARTY_MENU_CONTEXT_NORMAL = 0
local PARTY_MENU_STATE_HANDLE_CONTEXT_MENU_INPUT = 2
local PARTY_MENU_STATE_SUMMARY_PANEL = 9
local PARTY_CONTEXT_MENU_MAX_ITEMS = 8
local POKEDEX_APP_OVERLAY_ID = 18
local POKEDEX_MAGIC = 0xBEEFCAFE
local POKEDEX_FLAG_WORDS = 16
local POKEDEX_LIST_PAGE_SIZE = 15
local POKEDEX_LIST_ENTRY_COUNT = 518
SAVE_VARS_FLAGS_NUM_VARS = 0x170
SAVE_VARS_FLAGS_FLAGS_OFFSET = SAVE_VARS_FLAGS_NUM_VARS * 2
SAVE_VARS_FLAGS_MIN_SIZE = SAVE_VARS_FLAGS_FLAGS_OFFSET + (2912 / 8)
VAR_BASE = 0x4000
VAR_PLAYER_STARTER = 0x4030
FLAG_GOT_STARTER = 0x6A
FLAG_GOT_POKEDEX = 0x6B
FLAG_GOT_POKEGEAR = 0x9C
FLAG_GOT_BAG = 0x11B
FLAG_STRENGTH_ACTIVE = 0x962
FLAG_SYS_SAFARI = 0x967
FLAG_SYS_FLASH = 0x973
FLAG_SYS_DEFOG = 0x974
local BATTLE_SYSTEM_BATTLE_INPUT_OFFSET = 0x19C
local BATTLE_CONTEXT_COMMAND_OFFSET = 0x08
local BATTLE_CONTEXT_COMMAND_NEXT_OFFSET = 0x0C
local BATTLE_CONTEXT_SELECTED_MON_INDEX_OFFSET = 0x219C
local BATTLE_CONTEXT_PLAYER_ACTIONS_OFFSET = 0x21A8
local BATTLE_CONTEXT_EXECUTION_ORDER_OFFSET = 0x21E8
local BATTLE_CONTEXT_TURN_ORDER_OFFSET = 0x21EC
local BATTLE_INPUT_BATTLER_TYPE_OFFSET = 0x66A
local BATTLE_INPUT_CUR_MENU_ID_OFFSET = 0x66B
local BATTLE_INPUT_MON_TARGET_TYPE_OFFSET = 0x66C
local BATTLE_INPUT_IS_TOUCH_DISABLED_OFFSET = 0x66E
local BATTLE_INPUT_CANCEL_RUN_DISPLAY_OFFSET = 0x66F
local IRONMON_GLOBAL_POINTER_ADDR = 0x02000BA8
local IRONMON_VERSION_POINTER_OFFSET = 0x20
local IRONMON_PLAYER_BATTLE_BASE_OFFSET = 0x4EA98
local IRONMON_ENEMY_BATTLE_BASE_OFFSET = 0x4F068
local IRONMON_ACTIVE_PLAYER_PID_OFFSET = 0x49E7C
local IRONMON_ACTIVE_ENEMY_PID_OFFSET = 0x49F3C
local IRONMON_STAT_STAGES_PLAYER_OFFSET = 0x49E2C
local IRONMON_STAT_STAGES_ENEMY_OFFSET = 0x49EEC
local IRONMON_ACTIVE_PID_SLOT_STRIDE = 0x180
local IRONMON_STAT_STAGE_SLOT_STRIDE = 0x180

function translate_addr(addr)
  if MEMORY_DOMAIN_MODE == "main_ram_offset" then
    if addr >= 0x02000000 and addr < 0x02400000 then
      return addr - 0x02000000
    end
    return nil
  end
  return addr
end

function safe_read(fn, addr)
  local ok, value
  if SYSTEM_BUS then
    local translated = translate_addr(addr)
    if translated == nil then
      FAILED_RAM_READS = FAILED_RAM_READS + 1
      return nil
    end
    ok, value = pcall(fn, translated, SYSTEM_BUS)
  else
    FAILED_RAM_READS = FAILED_RAM_READS + 1
    return nil
  end
  if ok then return value end
  FAILED_RAM_READS = FAILED_RAM_READS + 1
  return nil
end

function u8(addr) return safe_read(memory.read_u8, addr) end
function s8(addr)
  local value = u8(addr)
  if value == nil then return nil end
  if value >= 0x80 then return value - 0x100 end
  return value
end
function u16(addr) return safe_read(memory.read_u16_le, addr) end
function s16(addr)
  local value = u16(addr)
  if value == nil then return nil end
  if value >= 0x8000 then return value - 0x10000 end
  return value
end
function u32(addr) return safe_read(memory.read_u32_le, addr) end
function u24(addr)
  local b0 = u8(addr)
  local b1 = u8(addr + 1)
  local b2 = u8(addr + 2)
  if b0 == nil or b1 == nil or b2 == nil then return nil end
  return b0 + b1 * 256 + b2 * 65536
end

function bit_is_set(value, mask)
  if value == nil then return false end
  return (value & mask) ~= 0
end

function valid_arm9_ptr(value)
  return value ~= nil and value >= 0x02000000 and value < 0x02400000
end

function systask_data(task)
  if not valid_arm9_ptr(task) then return nil end
  return u32(task + SYS_TASK_DATA_OFFSET)
end

STRING_MAGIC = 0xB6F8D2EC
STRING_EOS = 0xFFFF
STRING_MAX_PROBE_WORDS = 96
TEXT_PROBE_SCAN_START = 0x02200000
TEXT_PROBE_SCAN_END = 0x02400000
TEXT_PROBE_SCAN_STEP = 4
TEXT_PROBE_SCAN_BUDGET = 8192
TEXT_PROBE_LOCK_MIN_SAMPLES = 3
FIELD_TEXT_PROBE_LOCK_MIN_SAMPLES = 1
TEXT_PROBE_MAX_CANDIDATES = 4
MAX_TEXT_PRINTERS = 8
FIELD_TEXT_PRINTER_SCAN_START = 0x02000000
FIELD_TEXT_PRINTER_SCAN_END = 0x02400000
FIELD_TEXT_PRINTER_SCAN_BUDGET = 131072
NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR = FIELD_TEXT_PRINTER_SCAN_START
PRINT_QUEUE_SCAN_START = 0x02000000
PRINT_QUEUE_SCAN_END = 0x02400000
PRINT_QUEUE_SCAN_BUDGET = 262144
NEXT_PRINT_QUEUE_SCAN_ADDR = PRINT_QUEUE_SCAN_START
LOCKED_PRINT_QUEUE_PTR = nil
SCRIPT_ENV_MAGIC = 222271
NEXT_TEXT_PROBE_SCAN_ADDR = TEXT_PROBE_SCAN_START
LOCKED_BATTLE_TEXT_PROBE = nil
LOCKED_FIELD_TEXT_PROBE = nil
RECENT_BATTLE_TEXT_EVENTS = {}
RECENT_BATTLE_TEXT_MAX = 8
LAST_BATTLE_TEXT_EVENT_KEY = ""
LAST_BATTLE_TEXT_EVENT_FRAME = -999999
CURRENT_BATTLE_TEXT_INSTANCE = nil
CURRENT_BATTLE_TEXT_EPOCH = 0
RECENT_FIELD_TEXT_EVENTS = {}
RECENT_FIELD_TEXT_MAX = 8
LAST_FIELD_TEXT_EVENT_KEY = ""
LAST_FIELD_TEXT_EVENT_FRAME = -999999
CURRENT_FIELD_TEXT_INSTANCE = nil
CURRENT_FIELD_TEXT_EPOCH = 0
BATTLE_SYSTEM_SCAN_START = 0x02000000
BATTLE_SYSTEM_SCAN_END = 0x02400000
NEXT_BATTLE_SYSTEM_SCAN_ADDR = BATTLE_SYSTEM_SCAN_START
LOCKED_BATTLE_SYSTEM_PROBE = nil
BATTLE_SYSTEM_SCAN_BUDGET = 131072
BATTLE_SYSTEM_PRIORITY_SCAN_START = 0x02280000
BATTLE_SYSTEM_PRIORITY_SCAN_END = 0x02300000
BATTLE_CONTEXT_BATTLE_MONS_OFFSET = 0x2D40
BATTLE_MON_SIZE = 0xC0
FIELD_SYSTEM_ADDR = nil
FIELD_SYSTEM_SCAN_START = 0x02000000
FIELD_SYSTEM_SCAN_END = 0x02400000
FIELD_SYSTEM_SCAN_BUDGET = 131072
FIELD_SYSTEM_SAVE_DATA_SCAN_RADIUS_BEFORE = 0x20000
FIELD_SYSTEM_SAVE_DATA_SCAN_RADIUS_AFTER = 0x80000
NEXT_FIELD_SYSTEM_SCAN_ADDR = FIELD_SYSTEM_SCAN_START
NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR = nil
FIELD_SYSTEM_SAVE_DATA_SCAN_SAVE_DATA = nil
SYS_TASK_DATA_OFFSET = 0x10
TOUCH_SAVE_APP_ID = 1
TOUCH_SAVE_STATE_HANDLE_SAVE_CONFIRMATION = 4
TOUCH_SAVE_STATE_HANDLE_OVERWRITE_CONFIRMATION = 7
TOUCH_SAVE_YES_NO_PROMPT_OFFSET = 0x48
YES_NO_PROMPT_CURSOR_POS_OFFSET = 0x75
YES_NO_PROMPT_RESULT_IGNORE_TOUCH_OFFSET = 0x76
YES_NO_PROMPT_BUTTONS_INIT_OFFSET = 0x77
YES_NO_PROMPT_BGCONFIG_OFFSET = 0x5C
YES_NO_PROMPT_BGID_OFFSET = 0x60
YES_NO_PROMPT_X_OFFSET = 0x70
YES_NO_PROMPT_Y_OFFSET = 0x71
YES_NO_PROMPT_WIDTH_OFFSET = 0x72
YES_NO_PROMPT_HEIGHT_OFFSET = 0x73
LOCAL_MAP_OBJECT_SCAN_START = 0x02000000
LOCAL_MAP_OBJECT_SCAN_END = 0x02400000
LOCAL_MAP_OBJECT_SCAN_BUDGET = 65536
NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR = LOCAL_MAP_OBJECT_SCAN_START
NAMING_SCREEN_APPDATA_SCAN_START = 0x02000000
NAMING_SCREEN_APPDATA_SCAN_END = 0x02400000
NAMING_SCREEN_APPDATA_SCAN_BUDGET = 32768
NAMING_SCREEN_PRIORITY_SCAN_START = 0x02270000
NAMING_SCREEN_PRIORITY_SCAN_END = 0x02300000
NAMING_SCREEN_PRIORITY_SCAN_BUDGET = 131072
NAMING_SCREEN_APPDATA_SIZE = 0x5D4
NEXT_NAMING_SCREEN_PRIORITY_SCAN_ADDR = NAMING_SCREEN_PRIORITY_SCAN_START
NEXT_NAMING_SCREEN_APPDATA_SCAN_ADDR = NAMING_SCREEN_APPDATA_SCAN_START

function reset_field_system_cache()
  FIELD_SYSTEM_ADDR = nil
  NEXT_FIELD_SYSTEM_SCAN_ADDR = FIELD_SYSTEM_SCAN_START
  NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR = nil
  FIELD_SYSTEM_SAVE_DATA_SCAN_SAVE_DATA = nil
end

function aligned_scan_addr(addr)
  if addr == nil then return nil end
  return math.floor(addr / 4) * 4
end

function clamp_arm9_scan_addr(addr)
  if addr == nil then return nil end
  if addr < FIELD_SYSTEM_SCAN_START then return FIELD_SYSTEM_SCAN_START end
  if addr >= FIELD_SYSTEM_SCAN_END then return FIELD_SYSTEM_SCAN_START end
  return aligned_scan_addr(addr)
end

function field_system_scan_start_for_save_data(expected_save_data)
  if valid_arm9_ptr(expected_save_data) then
    return clamp_arm9_scan_addr(expected_save_data - FIELD_SYSTEM_SAVE_DATA_SCAN_RADIUS_BEFORE)
  end
  return NEXT_FIELD_SYSTEM_SCAN_ADDR
end

function field_system_scan_end_for_save_data(expected_save_data)
  if valid_arm9_ptr(expected_save_data) then
    local scan_end = aligned_scan_addr(expected_save_data + FIELD_SYSTEM_SAVE_DATA_SCAN_RADIUS_AFTER)
    if scan_end > FIELD_SYSTEM_SCAN_END then return FIELD_SYSTEM_SCAN_END end
    if scan_end <= FIELD_SYSTEM_SCAN_START then return FIELD_SYSTEM_SCAN_START end
    return scan_end
  end
  return FIELD_SYSTEM_SCAN_END
end

function reset_local_map_object_cache()
  PLAYER_OBJECT_ADDR = nil
  reset_field_system_cache()
  NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR = LOCAL_MAP_OBJECT_SCAN_START
end
LOCKED_NAMING_SCREEN_APPDATA = nil

-- Generic HGSS text surfaces are rendered through TextPrinter objects allocated
-- on the print queue. Field scripts, starter selection, app prompts, and many
-- menus all eventually point TextPrinter.template.currentChar.raw into a String
-- object's data buffer. These globals intentionally avoid adding more top-level
-- locals; BizHawk's Lua chunk has a 200-local limit.
GENERIC_TEXT_PRINTER_SCAN_START = 0x02000000
GENERIC_TEXT_PRINTER_SCAN_END = 0x02400000
GENERIC_TEXT_PRINTER_SCAN_BUDGET = 131072
NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR = GENERIC_TEXT_PRINTER_SCAN_START
LOCKED_GENERIC_TEXT_PRINTERS = {}
RECENT_GENERIC_TEXT_EVENTS = {}
RECENT_GENERIC_TEXT_MAX = 12
LAST_GENERIC_TEXT_EVENT_KEY = ""
LAST_GENERIC_TEXT_EVENT_FRAME = -999999
OAK_SPEECH_DATA_SCAN_START = 0x02000000
OAK_SPEECH_DATA_SCAN_END = 0x02400000
OAK_SPEECH_DATA_SCAN_BUDGET = 524288
OAK_SPEECH_PRIORITY_SCAN_START = 0x02270000
OAK_SPEECH_PRIORITY_SCAN_END = 0x02300000
OAK_SPEECH_PRIORITY_SCAN_BUDGET = OAK_SPEECH_PRIORITY_SCAN_END - OAK_SPEECH_PRIORITY_SCAN_START
NEXT_OAK_SPEECH_DATA_SCAN_ADDR = OAK_SPEECH_DATA_SCAN_START
LOCKED_OAK_SPEECH_DATA = nil
HEAP_ID_OAKS_SPEECH = 80
OAK_SPEECH_MSG_BANK = 219

OAK_SPEECH_STATE_MESSAGE_IDS = {
  [2] = 7, [3] = 7, [4] = 7,
  [11] = 9, [12] = 10, [13] = 11, [14] = 12, [15] = 23,
  [16] = 25, [17] = 13, [18] = 14, [19] = 15, [20] = 16,
  [21] = 17, [22] = 26,
  [36] = 28, [37] = 29, [38] = 30, [39] = 31, [40] = 32, [41] = 33,
  [49] = 6, [51] = 34, [56] = 35, [60] = 36, [61] = 37,
  [93] = 40, [103] = 43,
}

CHOOSE_STARTER_APP_SCAN_START = 0x02200000
CHOOSE_STARTER_APP_SCAN_END = 0x02400000
CHOOSE_STARTER_APP_SCAN_BUDGET = 65536
NEXT_CHOOSE_STARTER_APP_SCAN_ADDR = CHOOSE_STARTER_APP_SCAN_START
LOCKED_CHOOSE_STARTER_APPWORK = nil
HEAP_ID_CHOOSE_STARTER = 46
CHOOSE_STARTER_MSG_BANK = 190
CHOOSE_STARTER_WORK_SIZE = 0x598
CHOOSE_STARTER_WORK_OFFSET_HEAP_ID = 0x04
CHOOSE_STARTER_WORK_OFFSET_BG_CONFIG = 0x08
CHOOSE_STARTER_WORK_OFFSET_CUR_SELECTION = 0x394
CHOOSE_STARTER_WORK_OFFSET_WIN_TOP = 0x39C
CHOOSE_STARTER_WORK_OFFSET_WIN_BOTTOM = 0x3A0
CHOOSE_STARTER_WORK_OFFSET_STATE = 0x3A8
CHOOSE_STARTER_WORK_OFFSET_SELECTION_STATE = CHOOSE_STARTER_WORK_OFFSET_STATE
CHOOSE_STARTER_WORK_OFFSET_CHOICES = 0x578
CHOOSE_STARTER_SELECTION_STATE_NULL = 0
CHOOSE_STARTER_SELECTION_STATE_INSPECT = 1
CHOOSE_STARTER_SELECTION_STATE_CONFIRM = 2
CHOOSE_STARTER_SPECIES_IDS = { 152, 155, 158 }
POKEGEAR_APP_OVERLAY_ID = 100
GEAR_APP_MAP = 2
POKEGEAR_MAP_TYPE_GEAR = 0
POKEGEAR_MAP_TYPE_FLY = 1
POKEGEAR_MAP_TYPE_TOWN_MAP = 2
POKEGEAR_MAP_MAIN_STATE_FLY_CONTEXT_MENU = 12
POKEGEAR_MAP_LOCATION_COUNT = 100
POKEGEAR_MAP_LOCATION_SPEC_SIZE = 0x10
FLYPOINT_FLAG_BASE = 0x9B0
POKEGEAR_FLYPOINTS = {
  { nameMapId = 49, warpMapId = 49, flypoint = 0, x = 32, y = 11, width = 1, height = 1 },
  { nameMapId = 50, warpMapId = 50, flypoint = 1, x = 31, y = 7, width = 2, height = 2 },
  { nameMapId = 51, warpMapId = 51, flypoint = 2, x = 32, y = 2, width = 2, height = 2 },
  { nameMapId = 52, warpMapId = 52, flypoint = 3, x = 40, y = 3, width = 2, height = 2 },
  { nameMapId = 53, warpMapId = 53, flypoint = 4, x = 44, y = 7, width = 1, height = 1 },
  { nameMapId = 54, warpMapId = 54, flypoint = 5, x = 40, y = 9, width = 2, height = 2 },
  { nameMapId = 55, warpMapId = 55, flypoint = 6, x = 37, y = 7, width = 2, height = 2 },
  { nameMapId = 56, warpMapId = 56, flypoint = 7, x = 37, y = 12, width = 2, height = 2 },
  { nameMapId = 57, warpMapId = 57, flypoint = 8, x = 32, y = 15, width = 1, height = 1 },
  { nameMapId = 58, warpMapId = 58, flypoint = 9, x = 28, y = 6, width = 1, height = 1 },
  { nameMapId = 59, warpMapId = 59, flypoint = 10, x = 40, y = 6, width = 2, height = 2 },
  { nameMapId = 60, warpMapId = 60, flypoint = 11, x = 21, y = 12, width = 1, height = 1 },
  { nameMapId = 67, warpMapId = 67, flypoint = 12, x = 16, y = 12, width = 2, height = 1 },
  { nameMapId = 73, warpMapId = 73, flypoint = 13, x = 14, y = 7, width = 2, height = 2 },
  { nameMapId = 74, warpMapId = 74, flypoint = 14, x = 12, y = 14, width = 2, height = 1 },
  { nameMapId = 75, warpMapId = 75, flypoint = 15, x = 5, y = 10, width = 1, height = 2 },
  { nameMapId = 76, warpMapId = 76, flypoint = 16, x = 9, y = 10, width = 3, height = 2 },
  { nameMapId = 77, warpMapId = 77, flypoint = 17, x = 8, y = 7, width = 2, height = 2 },
  { nameMapId = 78, warpMapId = 78, flypoint = 18, x = 11, y = 4, width = 2, height = 2 },
  { nameMapId = 87, warpMapId = 87, flypoint = 19, x = 16, y = 5, width = 1, height = 1 },
  { nameMapId = 89, warpMapId = 89, flypoint = 21, x = 20, y = 4, width = 2, height = 2 },
  { nameMapId = 88, warpMapId = 88, flypoint = 20, x = 15, y = 1, width = 3, height = 2 },
  { nameMapId = 90, warpMapId = 90, flypoint = 22, x = 25, y = 8, width = 1, height = 1 },
  { nameMapId = 174, warpMapId = 174, flypoint = 30, x = 2, y = 8, width = 2, height = 2 },
  { nameMapId = 272, warpMapId = 411, flypoint = 27, x = 6, y = 6, width = 2, height = 2 },
  { nameMapId = 96, warpMapId = 280, flypoint = 35, x = 10, y = 6, width = 2, height = 2 },
  { nameMapId = 124, warpMapId = 30, flypoint = 33, x = 28, y = 7, width = 1, height = 2 },
}

function hgss_char_preview(code)
  if code == 0xE000 then return "\n" end
  if code == 0x25BC then return "\r" end
  if code == 0x25BD then return "\f" end
  if code == 0x01DE then return " " end
  if code >= 0x0121 and code <= 0x012A then return string.char(48 + code - 0x0121) end
  if code >= 0x012B and code <= 0x0144 then return string.char(65 + code - 0x012B) end
  if code >= 0x0145 and code <= 0x015E then return string.char(97 + code - 0x0145) end
  local punctuation = {
    [0x01AB] = "!", [0x01AC] = "?", [0x01AD] = ",", [0x01AE] = ".",
    [0x01AF] = "...", [0x01B1] = "/", [0x01B2] = "'", [0x01B3] = "'",
    [0x01B4] = "\"", [0x01B5] = "\"", [0x01B9] = "(", [0x01BA] = ")",
    [0x01BD] = "+", [0x01BE] = "-", [0x01BF] = "*", [0x01C0] = "#",
    [0x01C1] = "=", [0x01C2] = "&", [0x01C3] = "~", [0x01C4] = ":",
    [0x01C5] = ";", [0x01D0] = "@", [0x01D2] = "%", [0x01E9] = "_",
    [0x0188] = "é",
  }
  return punctuation[code]
end

function decode_hgss_words_preview(words)
  local parts = {}
  local i = 1
  while i <= #words do
    local code = words[i]
    if code == STRING_EOS then break end
    if code == 0xFFFE then
      local command = words[i + 1] or 0
      local argc = words[i + 2] or 0
      local args = {}
      for j = 1, argc do
        args[#args + 1] = tostring(words[i + 2 + j] or 0)
      end
      if (command & 0xFF00) == 0x0100 then
        table.insert(args, 1, tostring(command & 0xFF))
        parts[#parts + 1] = "{STRVAR_1 " .. table.concat(args, ", ") .. "}"
      else
        parts[#parts + 1] = string.format("{CTRL_%04X %s}", command, table.concat(args, ", "))
      end
      i = i + 3 + argc
    else
      parts[#parts + 1] = hgss_char_preview(code) or string.format("{CHAR_%04X}", code)
      i = i + 1
    end
  end
  return table.concat(parts, "")
end

function hgss_words_printable_ratio(words)
  local printable = 0
  local total = 0
  local i = 1
  while i <= #words do
    local code = words[i]
    if code == STRING_EOS then break end
    if code == 0xFFFE then
      local argc = words[i + 2] or 0
      total = total + 1
      printable = printable + 1
      i = i + 3 + argc
    else
      total = total + 1
      if hgss_char_preview(code) ~= nil then
        printable = printable + 1
      end
      i = i + 1
    end
  end
  if total == 0 then return 0 end
  return printable / total
end

function copy_hgss_words_prefix(words, count)
  local out = {}
  local limit = count or 0
  if limit < 0 then limit = 0 end
  if limit > #words then limit = #words end
  for i = 1, limit do
    out[#out + 1] = words[i]
  end
  return out
end

function read_hgss_string_object(ptr)
  if not valid_arm9_ptr(ptr) then
    return nil, "invalid_string_pointer"
  end
  local maxsize = u16(ptr)
  local size = u16(ptr + 2)
  local magic = u32(ptr + 4)
  if magic ~= STRING_MAGIC then
    return nil, "bad_string_magic"
  end
  if maxsize == nil or size == nil or maxsize < 1 or maxsize > 0x400 or size >= maxsize or size > STRING_MAX_PROBE_WORDS then
    return nil, "invalid_string_size"
  end
  local eos = u16(ptr + 8 + size * 2)
  if eos ~= STRING_EOS then
    return nil, "missing_string_eos"
  end
  local words = {}
  for i = 0, size - 1 do
    local word = u16(ptr + 8 + i * 2)
    if word == nil then
      return nil, "string_read_failed"
    end
    words[#words + 1] = word
  end
  return {
    ptr = ptr,
    maxsize = maxsize,
    size = size,
    magic = magic,
    words = words,
    printableRatio = hgss_words_printable_ratio(words),
    preview = decode_hgss_words_preview(words),
  }, nil
end

function validate_battle_text_candidate_string(string_obj)
  if not string_obj then return false, "missing_string" end
  if string_obj.maxsize ~= 0x140 then return false, "battle_msgbuffer_maxsize_mismatch" end
  if string_obj.size <= 0 then return false, "empty_msgbuffer" end
  if (string_obj.printableRatio or 0) < 0.45 then return false, "low_printable_ratio" end
  return true, "ok"
end

function validate_field_dialog_candidate_string(string_obj)
  if not string_obj then return false, "missing_string" end
  if string_obj.maxsize ~= 0x400 then return false, "field_stringBuffer0_maxsize_mismatch" end
  if string_obj.size <= 0 then return false, "empty_stringBuffer0" end
  if (string_obj.printableRatio or 0) < 0.45 then return false, "low_printable_ratio" end
  return true, "ok"
end

function validate_generic_text_printer_string(string_obj)
  if not string_obj then return false, "missing_string" end
  if string_obj.maxsize < 1 or string_obj.maxsize > 0x400 then return false, "generic_text_maxsize_out_of_range" end
  if string_obj.size <= 0 or string_obj.size > STRING_MAX_PROBE_WORDS then return false, "generic_text_size_out_of_range" end
  if (string_obj.printableRatio or 0) < 0.45 then return false, "low_printable_ratio" end
  return true, "ok"
end

function infer_string_from_current_char(current_char_raw)
  if not valid_arm9_ptr(current_char_raw) then return nil, "invalid_current_char_pointer" end
  -- TextPrinter.currentChar.raw points at String_cstr(string), advancing as
  -- RenderText consumes characters. Walk backwards within the maximum probed
  -- String length until we find the String header documented by pret.
  local max_back = (STRING_MAX_PROBE_WORDS + 2) * 2
  local start = current_char_raw - 8
  local stop = current_char_raw - 8 - max_back
  if stop < 0x02000000 then stop = 0x02000000 end
  local addr = start
  while addr >= stop do
    if u32(addr + 4) == STRING_MAGIC then
      local string_obj, reason = read_hgss_string_object(addr)
      local ok_string = validate_generic_text_printer_string(string_obj)
      if ok_string and string_obj and current_char_raw >= addr + 8 and current_char_raw <= addr + 8 + (string_obj.size * 2) + 2 then
        return string_obj, "ok"
      end
      if reason ~= nil then
        -- Keep walking; currentChar can point into a later String-like buffer.
      end
    end
    addr = addr - 2
  end
  return nil, "string_header_not_found_before_current_char"
end

function script_list_menu_2d_candidate(env)
  if not valid_arm9_ptr(env) then
    return { active = false, reason = "script_environment_missing" }
  end
  -- ScriptEnvironment.listMenu2D is +0x24 in pret/pokeheartgold include/script.h.
  local menu = u32(env + 0x24)
  if not valid_arm9_ptr(menu) then
    return { active = false, reason = "list_menu_2d_pointer_null_or_invalid" }
  end
  -- struct ListMenu2D from include/list_menu_2d.h, size 0x20.
  local items_ptr = u32(menu + 0x00)
  local window_ptr = u32(menu + 0x04)
  local font_id = u8(menu + 0x08)
  local items_wide = u8(menu + 0x09)
  local items_high = u8(menu + 0x0A)
  local packed = u8(menu + 0x0B)
  local cursor_ptr = u32(menu + 0x0C)
  local cancel_key_raw = u32(menu + 0x10)
  local selected_index = u8(menu + 0x15)
  local max_item_width = u8(menu + 0x16)
  local x = u8(menu + 0x17)
  local y = u8(menu + 0x18)
  local scheduled_scroll = u8(menu + 0x1B)
  if not valid_arm9_ptr(items_ptr) or items_wide == nil or items_high == nil then
    return { active = false, reason = "list_menu_2d_layout_invalid", listMenu2DPtr = menu, itemsPtr = items_ptr }
  end
  local total_items = items_wide * items_high
  if total_items <= 0 or total_items > 32 or selected_index == nil or selected_index >= total_items then
    return { active = false, reason = "list_menu_2d_item_bounds_invalid", listMenu2DPtr = menu, totalItems = total_items, selectedIndex = selected_index }
  end
  local function signed32_local(value)
    if value == nil then return nil end
    if value >= 0x80000000 then return value - 0x100000000 end
    return value
  end
  local items = {}
  for i = 0, total_items - 1 do
    local item_ptr = items_ptr + (i * 8)
    local text_ptr = u32(item_ptr)
    local item_value = signed32_local(u32(item_ptr + 4))
    local text = nil
    if valid_arm9_ptr(text_ptr) then
      text = read_hgss_string_object(text_ptr)
    end
    items[#items + 1] = {
      index = i,
      value = item_value,
      selected = i == selected_index,
      text = text and text.preview or "",
    }
  end
  local menu_kind = "list_menu_2d"
  if total_items == 2 and (items[1].value == 0 and items[2].value == -2) then
    menu_kind = "yes_no_menu_2d"
  end
  return {
    active = true,
    source = "ScriptEnvironment.listMenu2D",
    contract = "ram_script_environment_list_menu_2d_current",
    menuKind = menu_kind,
    listMenu2DPtr = menu,
    itemsPtr = items_ptr,
    windowPtr = window_ptr,
    cursorPtr = cursor_ptr,
    fontId = font_id,
    itemsWide = items_wide,
    itemsHigh = items_high,
    selectedIndex = selected_index,
    cancelKey = signed32_local(cancel_key_raw),
    yTop = packed % 16,
    cursorType = math.floor(packed / 16) % 4,
    enableWrap = math.floor(packed / 64) % 4,
    x = x,
    y = y,
    maxItemWidth = max_item_width,
    scheduledScroll = scheduled_scroll,
    items = items,
  }
end

START_MENU_ACTION_LABELS = {
  [0] = "POKEDEX",
  [1] = "POKEMON",
  [2] = "BAG",
  [3] = "TRAINER CARD",
  [4] = "SAVE",
  [5] = "OPTIONS",
  [6] = "EXIT",
  [8] = "RETIRE",
  [9] = "POKEGEAR",
  [10] = "POKEGEAR",
  [11] = "POKEGEAR",
  [12] = "POKEGEAR",
}

function start_menu_action_label(action)
  return START_MENU_ACTION_LABELS[action]
end

function start_menu_menu_icon_unlocked(vars_flags, icon_idx)
  return save_vars_script_flag_from_ptr(vars_flags, FLAG_GOT_BAG + icon_idx) == true
end

function append_start_menu_item(items, action, cursor_index)
  local label = start_menu_action_label(action)
  if label == nil then
    return false
  end
  local index = #items
  items[#items + 1] = {
    index = index,
    action = action,
    text = label,
    selected = index == cursor_index,
  }
  return true
end

function decode_start_menu_fieldsystem_panel(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "start_menu_panel_no_valid_field_system" }
  end
  -- FieldSystem.unkD2_0 is set to 1 after Task_StartMenu_DrawCursor and
  -- reset to 0/2 when the Start Menu is hidden or closing.
  local menu_panel_raw = u8(field_system + 0xD2)
  local menu_panel_state = menu_panel_raw and (menu_panel_raw & 0x3F) or nil
  if menu_panel_state ~= 1 then
    return {
      active = false,
      reason = "start_menu_panel_not_visible",
      fieldSystemPtr = field_system,
      menuPanelState = menu_panel_state,
      menuPanelRaw = menu_panel_raw,
    }
  end
  local save_data = u32(field_system + 0x0C)
  local vars_flags, header, reason =
    save_array_from_save_data(save_data, SAVE_FLAGS, HGSS_SAVE_VARS_FLAGS_SAVE_ARRAY_SIZE, HGSS_SAVE_VARS_FLAGS_SAVE_ARRAY_SIZE)
  if vars_flags == nil then
    return {
      active = false,
      reason = reason or "start_menu_panel_save_flags_unavailable",
      fieldSystemPtr = field_system,
      saveDataPtr = save_data,
      menuPanelState = menu_panel_state,
    }
  end

  local cursor_index = u8(field_system + 0xD3)
  if cursor_index == nil then
    return {
      active = false,
      reason = "start_menu_panel_cursor_unreadable",
      fieldSystemPtr = field_system,
      saveDataPtr = save_data,
      saveFlagsPtr = vars_flags,
      menuPanelState = menu_panel_state,
    }
  end

  local unlock_flags = {
    gotPokedex = save_vars_script_flag_from_ptr(vars_flags, FLAG_GOT_POKEDEX) == true,
    gotStarter = save_vars_script_flag_from_ptr(vars_flags, FLAG_GOT_STARTER) == true,
    gotBag = start_menu_menu_icon_unlocked(vars_flags, 0),
    gotTrainerCard = start_menu_menu_icon_unlocked(vars_flags, 1),
    gotSave = start_menu_menu_icon_unlocked(vars_flags, 2),
    gotOptions = start_menu_menu_icon_unlocked(vars_flags, 3),
    gotPokegear = save_vars_script_flag_from_ptr(vars_flags, FLAG_GOT_POKEGEAR) == true,
  }
  local items = {}
  if unlock_flags.gotPokedex then append_start_menu_item(items, 0, cursor_index) end
  if unlock_flags.gotStarter then append_start_menu_item(items, 1, cursor_index) end
  if unlock_flags.gotBag then append_start_menu_item(items, 2, cursor_index) end
  if unlock_flags.gotPokegear then append_start_menu_item(items, 11, cursor_index) end
  if unlock_flags.gotTrainerCard then append_start_menu_item(items, 3, cursor_index) end
  if unlock_flags.gotSave then append_start_menu_item(items, 4, cursor_index) end
  if unlock_flags.gotOptions then append_start_menu_item(items, 5, cursor_index) end
  if #items == 0 then
    return {
      active = false,
      reason = "start_menu_panel_no_visible_unlocked_items",
      fieldSystemPtr = field_system,
      saveDataPtr = save_data,
      saveFlagsPtr = vars_flags,
      header = header,
      menuPanelState = menu_panel_state,
      unlockFlags = unlock_flags,
    }
  end
  if cursor_index >= #items then
    return {
      active = false,
      reason = "start_menu_panel_cursor_bounds_invalid",
      fieldSystemPtr = field_system,
      saveDataPtr = save_data,
      saveFlagsPtr = vars_flags,
      header = header,
      menuPanelState = menu_panel_state,
      cursorIndex = cursor_index,
      itemCount = #items,
      unlockFlags = unlock_flags,
    }
  end

  return {
    active = true,
    source = "FieldSystem.start_menu_panel+SaveVarsFlags",
    confidence = "validated_ram",
    contract = "ram_start_menu_fieldsystem_panel_current_visible_options_v1",
    validation = "fieldsystem_start_menu_panel_flags_current_visible",
    title = "Start menu",
    fieldSystemPtr = field_system,
    saveDataPtr = save_data,
    saveFlagsPtr = vars_flags,
    header = header,
    menuPanelState = menu_panel_state,
    menuPanelRaw = menu_panel_raw,
    cursorIndex = cursor_index,
    cursor = items[cursor_index + 1] and items[cursor_index + 1].text or nil,
    unlockFlags = unlock_flags,
    items = items,
  }
end

local BAG_POCKET_LABELS = {
  [0] = "Items",
  [1] = "Medicine",
  [2] = "Balls",
  [3] = "TMs/HMs",
  [4] = "Berries",
  [5] = "Mail",
  [6] = "Battle Items",
  [7] = "Key Items",
}

local BAG_POCKET_SLOT_LIMITS = {
  [0] = 165,
  [1] = 40,
  [2] = 24,
  [3] = 101,
  [4] = 64,
  [5] = 12,
  [6] = 30,
  [7] = 50,
}

local BAG_POCKET_SAVE_OFFSETS = {
  [0] = 0x000,
  [1] = 0x520,
  [2] = 0x6C0,
  [3] = 0x35C,
  [4] = 0x5C0,
  [5] = 0x4F0,
  [6] = 0x720,
  [7] = 0x294,
}

function bag_pocket_label(pocket_id)
  return BAG_POCKET_LABELS[pocket_id]
end

function decode_start_menu_taskdata(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "start_menu_no_valid_field_system" }
  end
  -- pret/pokeheartgold FieldSystem.taskman is +0x10; TaskManager.env is +0x0C.
  local taskman = u32(field_system + 0x10)
  if not valid_arm9_ptr(taskman) then
    local panel = decode_start_menu_fieldsystem_panel(field_system)
    if panel.active == true then
      return panel
    end
    return {
      active = false,
      reason = "start_menu_no_active_taskman",
      fieldSystemPtr = field_system,
      panelFallback = panel,
    }
  end
  local task_field_system = u32(taskman + 0x18)
  if task_field_system ~= field_system then
    return {
      active = false,
      reason = "start_menu_taskman_field_system_backlink_mismatch",
      fieldSystemPtr = field_system,
      taskManagerPtr = taskman,
      taskFieldSystemPtr = task_field_system,
    }
  end
  local env = u32(taskman + 0x0C)
  if not valid_arm9_ptr(env) then
    return { active = false, reason = "start_menu_no_task_environment", fieldSystemPtr = field_system, taskManagerPtr = taskman }
  end

  -- StartMenuTaskData offsets are source-backed by pret/pokeheartgold include/start_menu.h.
  local cursor_active = u32(env + 0x20)
  local last_button_selected = u16(env + 0x24)
  local state = u16(env + 0x26)
  local selected_index = signed32(u32(env + 0x28))
  local num_active_buttons = u32(env + 0x2C)
  local cursor_index = u8(field_system + 0xD3)
  local inhibit_icon_flags = u32(env + 0x34C)
  if cursor_active ~= 1 then
    return { active = false, reason = "start_menu_cursor_inactive", fieldSystemPtr = field_system, taskManagerPtr = taskman, envPtr = env, cursorActive = cursor_active }
  end
  if state ~= 3 then
    return { active = false, reason = "start_menu_not_in_handle_input_state", fieldSystemPtr = field_system, taskManagerPtr = taskman, envPtr = env, state = state }
  end
  if num_active_buttons == nil or num_active_buttons < 1 or num_active_buttons > 10 then
    return { active = false, reason = "start_menu_button_count_invalid", fieldSystemPtr = field_system, taskManagerPtr = taskman, envPtr = env, numActiveButtons = num_active_buttons }
  end
  if cursor_index == nil or cursor_index >= num_active_buttons then
    cursor_index = last_button_selected
  end
  if cursor_index == nil or cursor_index >= num_active_buttons then
    return { active = false, reason = "start_menu_cursor_bounds_invalid", fieldSystemPtr = field_system, taskManagerPtr = taskman, envPtr = env, cursorIndex = cursor_index, numActiveButtons = num_active_buttons }
  end
  if inhibit_icon_flags == nil or inhibit_icon_flags < 0 or inhibit_icon_flags >= 0x400 then
    return { active = false, reason = "start_menu_inhibit_flags_invalid", fieldSystemPtr = field_system, taskManagerPtr = taskman, envPtr = env, inhibitIconFlags = inhibit_icon_flags }
  end

  local insertion_order = {}
  local selection_to_action = {}
  local items = {}
  for i = 0, num_active_buttons - 1 do
    local insertion_action = u8(env + 0x30 + i)
    local action = u8(env + 0x3A + i)
    local label = start_menu_action_label(action)
    if label == nil then
      return { active = false, reason = "start_menu_action_unknown", fieldSystemPtr = field_system, taskManagerPtr = taskman, envPtr = env, action = action, index = i }
    end
    insertion_order[#insertion_order + 1] = insertion_action
    selection_to_action[#selection_to_action + 1] = action
    items[#items + 1] = {
      index = i,
      action = action,
      text = label,
      selected = i == cursor_index,
    }
  end

  return {
    active = true,
    source = "StartMenuTaskData.TaskManager.env",
    confidence = "validated_ram",
    contract = "ram_start_menu_taskdata_current_visible_options_v1",
    validation = "start_menu_taskdata_cursor_active_handle_input",
    fieldSystemPtr = field_system,
    taskManagerPtr = taskman,
    envPtr = env,
    state = state,
    cursorActive = cursor_active,
    cursorIndex = cursor_index,
    lastButtonSelected = last_button_selected,
    selectedIndex = selected_index,
    numActiveButtons = num_active_buttons,
    inhibitIconFlags = inhibit_icon_flags,
    insertionOrder = insertion_order,
    selectionToAction = selection_to_action,
    cursor = items[cursor_index + 1] and items[cursor_index + 1].text or nil,
    items = items,
  }
end

function decode_touch_save_choice_menu(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "touch_save_no_valid_field_system" }
  end
  -- FieldSystem.unk_D8 is the field app runner SysTask. Its SysTask.data
  -- stores the active app id and the current child task pointer.
  local app_manager_task = u32(field_system + 0xD8)
  if not valid_arm9_ptr(app_manager_task) then
    return { active = false, reason = "touch_save_no_app_manager_task", fieldSystemPtr = field_system }
  end
  local app_manager = systask_data(app_manager_task)
  if not valid_arm9_ptr(app_manager) then
    return { active = false, reason = "touch_save_no_app_manager_data", fieldSystemPtr = field_system, appManagerTaskPtr = app_manager_task }
  end
  local app_id = u8(app_manager + 0x00)
  local app_state = u8(app_manager + 0x01)
  local next_app_id = u8(app_manager + 0x02)
  local touch_save_task = u32(app_manager + 0x04)
  local manager_field_system = u32(app_manager + 0x08)
  if manager_field_system ~= field_system then
    return {
      active = false,
      reason = "touch_save_app_manager_field_system_mismatch",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      managerFieldSystemPtr = manager_field_system,
    }
  end
  if app_id ~= TOUCH_SAVE_APP_ID then
    return {
      active = false,
      reason = "touch_save_app_not_active",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      appId = app_id,
      appState = app_state,
      nextAppId = next_app_id,
    }
  end
  if app_state ~= 1 then
    return {
      active = false,
      reason = "touch_save_app_not_running",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      appId = app_id,
      appState = app_state,
      nextAppId = next_app_id,
    }
  end
  if not valid_arm9_ptr(touch_save_task) then
    return {
      active = false,
      reason = "touch_save_no_child_task",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      appId = app_id,
    }
  end
  local data = systask_data(touch_save_task)
  if not valid_arm9_ptr(data) then
    return {
      active = false,
      reason = "touch_save_no_child_task_data",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      touchSaveTaskPtr = touch_save_task,
    }
  end

  -- TouchSaveAppData layout is source-backed by pret/pokeheartgold
  -- src/touch_save_app.c. The app owns a YesNoPrompt while asking whether
  -- to save or overwrite the existing save file.
  local data_task = u32(data + 0x08)
  local state = signed32(u32(data + 0x0C))
  local data_field_system = u32(data + 0x1C)
  local data_bg_config = u32(data + 0x04)
  local field_bg_config = u32(field_system + 0x08)
  if data_task ~= touch_save_task or data_field_system ~= field_system or data_bg_config ~= field_bg_config then
    return {
      active = false,
      reason = "touch_save_data_owner_mismatch",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      touchSaveTaskPtr = touch_save_task,
      touchSaveDataPtr = data,
      dataTaskPtr = data_task,
      dataFieldSystemPtr = data_field_system,
      dataBgConfigPtr = data_bg_config,
      fieldBgConfigPtr = field_bg_config,
    }
  end
  if state ~= TOUCH_SAVE_STATE_HANDLE_SAVE_CONFIRMATION and state ~= TOUCH_SAVE_STATE_HANDLE_OVERWRITE_CONFIRMATION then
    return {
      active = false,
      reason = "touch_save_not_waiting_for_yes_no",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      touchSaveTaskPtr = touch_save_task,
      touchSaveDataPtr = data,
      state = state,
      appId = app_id,
    }
  end

  local yes_no_prompt = u32(data + TOUCH_SAVE_YES_NO_PROMPT_OFFSET)
  if not valid_arm9_ptr(yes_no_prompt) then
    return {
      active = false,
      reason = "touch_save_no_yes_no_prompt",
      fieldSystemPtr = field_system,
      appManagerTaskPtr = app_manager_task,
      appManagerDataPtr = app_manager,
      touchSaveTaskPtr = touch_save_task,
      touchSaveDataPtr = data,
      state = state,
    }
  end
  local touch_controller = u32(yes_no_prompt + 0x00)
  local cursor_pos = u8(yes_no_prompt + YES_NO_PROMPT_CURSOR_POS_OFFSET)
  local result_byte = u8(yes_no_prompt + YES_NO_PROMPT_RESULT_IGNORE_TOUCH_OFFSET)
  local buttons_byte = u8(yes_no_prompt + YES_NO_PROMPT_BUTTONS_INIT_OFFSET)
  local prompt_bg_config = u32(yes_no_prompt + YES_NO_PROMPT_BGCONFIG_OFFSET)
  local prompt_bg_id = u32(yes_no_prompt + YES_NO_PROMPT_BGID_OFFSET)
  local prompt_x = u8(yes_no_prompt + YES_NO_PROMPT_X_OFFSET)
  local prompt_y = u8(yes_no_prompt + YES_NO_PROMPT_Y_OFFSET)
  local prompt_width = u8(yes_no_prompt + YES_NO_PROMPT_WIDTH_OFFSET)
  local prompt_height = u8(yes_no_prompt + YES_NO_PROMPT_HEIGHT_OFFSET)
  local result = result_byte and (result_byte % 16) or nil
  local buttons_init = buttons_byte and (buttons_byte % 16) or nil
  local last_touch_event = buttons_byte and math.floor(buttons_byte / 16) or nil
  if cursor_pos == nil or cursor_pos > 1 or result == nil or (result ~= 0 and result ~= 1 and result ~= 3) then
    return {
      active = false,
      reason = "touch_save_yes_no_cursor_or_result_invalid",
      fieldSystemPtr = field_system,
      touchSaveDataPtr = data,
      yesNoPromptPtr = yes_no_prompt,
      cursorPos = cursor_pos,
      result = result,
    }
  end
  if buttons_init ~= 1 or prompt_bg_config ~= data_bg_config or prompt_bg_id ~= 6 or prompt_x ~= 26 or prompt_y ~= 10 or prompt_width ~= 6 or prompt_height ~= 4 then
    return {
      active = false,
      reason = "touch_save_yes_no_prompt_layout_invalid",
      fieldSystemPtr = field_system,
      touchSaveDataPtr = data,
      yesNoPromptPtr = yes_no_prompt,
      buttonsInit = buttons_init,
      promptBgConfigPtr = prompt_bg_config,
      dataBgConfigPtr = data_bg_config,
      promptBgId = prompt_bg_id,
      promptX = prompt_x,
      promptY = prompt_y,
      promptWidth = prompt_width,
      promptHeight = prompt_height,
    }
  end
  if not valid_arm9_ptr(touch_controller) then
    return {
      active = false,
      reason = "touch_save_yes_no_touch_controller_missing",
      fieldSystemPtr = field_system,
      touchSaveDataPtr = data,
      yesNoPromptPtr = yes_no_prompt,
      touchHitboxControllerPtr = touch_controller,
    }
  end
  local controller_hitboxes = u32(touch_controller + 0x00)
  local controller_num_templates = u32(touch_controller + 0x04)
  local controller_callback_arg = u32(touch_controller + 0x0C)
  if controller_hitboxes ~= (yes_no_prompt + 0x04) or controller_num_templates ~= 2 or controller_callback_arg ~= yes_no_prompt then
    return {
      active = false,
      reason = "touch_save_yes_no_touch_controller_not_bound",
      fieldSystemPtr = field_system,
      touchSaveDataPtr = data,
      yesNoPromptPtr = yes_no_prompt,
      touchHitboxControllerPtr = touch_controller,
      controllerHitboxesPtr = controller_hitboxes,
      controllerNumTemplates = controller_num_templates,
      controllerCallbackArg = controller_callback_arg,
    }
  end

  local items = {
    { index = 0, value = 0, text = "YES", selected = cursor_pos == 0 },
    { index = 1, value = 1, text = "NO", selected = cursor_pos == 1 },
  }
  return {
    active = true,
    source = "TouchSaveAppData.YesNoPrompt",
    confidence = "validated_ram",
    contract = "ram_touch_save_yes_no_prompt_current_v1",
    validation = "touch_save_app_yes_no_prompt_owner_bound",
    title = state == TOUCH_SAVE_STATE_HANDLE_OVERWRITE_CONFIRMATION and "Overwrite confirmation" or "Save confirmation",
    menuKind = "yes_no_prompt",
    selectedIndex = cursor_pos,
    cursor = items[cursor_pos + 1] and items[cursor_pos + 1].text or nil,
    items = items,
    fieldSystemPtr = field_system,
    appManagerTaskPtr = app_manager_task,
    appManagerDataPtr = app_manager,
    touchSaveTaskPtr = touch_save_task,
    touchSaveDataPtr = data,
    yesNoPromptPtr = yes_no_prompt,
    touchHitboxControllerPtr = touch_controller,
    state = state,
    appId = app_id,
    appState = app_state,
    nextAppId = next_app_id,
    cursorPos = cursor_pos,
    result = result,
    lastTouchEvent = last_touch_event,
  }
end

function decode_bag_menu_overlay(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "bag_menu_no_valid_field_system" }
  end
  -- pret/pokeheartgold FieldSystem.unk0 is +0x00; unk0->unk4 is the active application OverlayManager.
  local field_system_sub0 = u32(field_system + 0x00)
  if not valid_arm9_ptr(field_system_sub0) then
    return { active = false, reason = "bag_menu_no_field_system_sub0", fieldSystemPtr = field_system }
  end
  local overlay_manager = u32(field_system_sub0 + 0x04)
  if not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "bag_menu_no_active_application", fieldSystemPtr = field_system, fieldSystemSub0Ptr = field_system_sub0 }
  end
  -- OverlayManager.template.ovy_id is +0x0C; Bag_LaunchApp uses OVY_15.
  local ovy_id = signed32(u32(overlay_manager + 0x0C))
  if ovy_id ~= 15 then
    return { active = false, reason = "bag_menu_active_application_not_bag", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, ovyId = ovy_id }
  end
  -- OverlayManager.args is +0x18 and is the BagView passed by Bag_LaunchApp.
  local bag_view = u32(overlay_manager + 0x18)
  if not valid_arm9_ptr(bag_view) then
    return { active = false, reason = "bag_menu_no_bagview_args", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager }
  end
  local save_data = u32(field_system + 0x0C)
  if not valid_arm9_ptr(save_data) then
    return { active = false, reason = "bag_menu_no_valid_save_data", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, saveDataPtr = save_data }
  end
  local bag_save, header, header_reason = save_array_from_save_data(save_data, SAVE_BAG, HGSS_BAG_SAVE_ARRAY_SIZE, HGSS_BAG_SAVE_ARRAY_SIZE)
  local bag_view_save = u32(bag_view + 0x00)
  local cursor_ptr = u32(bag_view + 0x6C)
  local current_pocket = u8(bag_view + 0x64)
  local mode = u8(bag_view + 0x65)
  if bag_view_save ~= save_data then
    return { active = false, reason = "bag_menu_bagview_save_backlink_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, saveDataPtr = save_data, bagViewSaveDataPtr = bag_view_save }
  end
  if not valid_arm9_ptr(cursor_ptr) then
    return { active = false, reason = "bag_menu_no_valid_cursor", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, cursorPtr = cursor_ptr }
  end
  if current_pocket == nil or current_pocket < 0 or current_pocket > 7 then
    return { active = false, reason = "bag_menu_current_pocket_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, pocketId = current_pocket }
  end
  local pocket_label = bag_pocket_label(current_pocket)
  local slot_limit = BAG_POCKET_SLOT_LIMITS[current_pocket]
  local pocket_struct = bag_view + 0x04 + (current_pocket * 0x0C)
  local slots_ptr = u32(pocket_struct + 0x00)
  local pocket_id = u8(pocket_struct + 0x08)
  if not valid_arm9_ptr(slots_ptr) or pocket_id ~= current_pocket or slot_limit == nil or pocket_label == nil then
    return { active = false, reason = "bag_menu_pocket_slots_not_owner_bound", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, slotsPtr = slots_ptr, pocketId = pocket_id, currentPocket = current_pocket }
  end
  local expected_save_offset = BAG_POCKET_SAVE_OFFSETS[current_pocket]
  local save_backed_slots = false
  if bag_save ~= nil and expected_save_offset ~= nil then
    save_backed_slots = slots_ptr == (bag_save + expected_save_offset)
    if not save_backed_slots then
      return { active = false, reason = "bag_menu_slots_not_save_bag_bound", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, slotsPtr = slots_ptr, bagPtr = bag_save, pocketId = current_pocket, expectedSlotsPtr = bag_save + expected_save_offset }
    end
  end

  -- BagCursorField is source-backed by include/bag_cursor.h. Battle bag can use
  -- a different cursor area, so this field menu decoder accepts only field BagView
  -- modes launched by Start/Menu/script field contexts.
  if mode ~= 0 and mode ~= 1 and mode ~= 3 then
    return { active = false, reason = "bag_menu_mode_not_field_bag", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, mode = mode }
  end
  local scroll = u8(cursor_ptr + current_pocket)
  local position = u8(cursor_ptr + 0x08 + current_pocket)
  local cursor_pocket = u16(cursor_ptr + 0x10)
  if scroll == nil or position == nil or cursor_pocket == nil then
    return { active = false, reason = "bag_menu_cursor_unreadable", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, cursorPtr = cursor_ptr }
  end
  if cursor_pocket ~= current_pocket then
    return { active = false, reason = "bag_menu_cursor_pocket_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, cursorPtr = cursor_ptr, pocketId = current_pocket, cursorPocket = cursor_pocket }
  end
  if scroll < 0 or scroll >= slot_limit or position < 0 or position > 5 or (scroll + position) >= slot_limit then
    return { active = false, reason = "bag_menu_cursor_bounds_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, cursorPtr = cursor_ptr, pocketId = current_pocket, scroll = scroll, position = position, slotLimit = slot_limit }
  end

  local entries = {}
  local non_empty_count = 0
  local first_empty_seen = false
  for slot = 0, slot_limit - 1 do
    local item_id = u16(slots_ptr + (slot * 4))
    local quantity = u16(slots_ptr + (slot * 4) + 2)
    if item_id == nil or quantity == nil or item_id > HGSS_ITEM_MAX or quantity > 999 then
      return { active = false, reason = "bag_menu_slot_bounds_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, pocketId = current_pocket, slot = slot + 1, itemId = item_id, quantity = quantity }
    end
    if item_id == 0 and quantity == 0 then
      first_empty_seen = true
    elseif first_empty_seen then
      return { active = false, reason = "bag_menu_non_empty_after_empty_slot", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, pocketId = current_pocket, slot = slot + 1, itemId = item_id, quantity = quantity }
    elseif item_id > 0 and quantity > 0 then
      non_empty_count = non_empty_count + 1
      if slot >= scroll and slot < scroll + 6 then
        entries[#entries + 1] = {
          slot = slot + 1,
          item_id = item_id,
          quantity = quantity,
          selected = slot == (scroll + position),
        }
      end
    else
      return { active = false, reason = "bag_menu_slot_quantity_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, pocketId = current_pocket, slot = slot + 1, itemId = item_id, quantity = quantity }
    end
  end

  if #entries <= 0 then
    local empty_text = non_empty_count <= 0 and "No items" or "Empty slot"
    return {
      active = true,
      source = "BagOverlayManager.args.BagView",
      confidence = "validated_ram",
      contract = "ram_bag_overlay_manager_args_bagview_cursor_current_items_v1",
      validation = "bag_overlay_ovy15_bagview_cursor_slots_validated",
      fieldSystemPtr = field_system,
      fieldSystemSub0Ptr = field_system_sub0,
      overlayManagerPtr = overlay_manager,
      bagViewPtr = bag_view,
      cursorPtr = cursor_ptr,
      saveDataPtr = save_data,
      bagPtr = bag_save,
      header = header,
      saveHeaderReason = header_reason,
      saveBackedSlots = save_backed_slots,
      ovyId = ovy_id,
      mode = mode,
      pocketId = current_pocket,
      pocket = pocket_label,
      scroll = scroll,
      position = position,
      nonEmptyCount = non_empty_count,
      emptyPocket = non_empty_count <= 0,
      cursor = empty_text,
      items = {
        {
          slot = scroll + position + 1,
          item_id = 0,
          quantity = 0,
          text = empty_text,
          selected = true,
        },
      },
    }
  end
  local cursor_item = nil
  for _, entry in ipairs(entries) do
    if entry.selected then
      cursor_item = entry
      break
    end
  end
  if cursor_item == nil then
    return { active = false, reason = "bag_menu_cursor_item_missing", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, bagViewPtr = bag_view, pocketId = current_pocket, scroll = scroll, position = position }
  end

  return {
    active = true,
    source = "BagOverlayManager.args.BagView",
    confidence = "validated_ram",
    contract = "ram_bag_overlay_manager_args_bagview_cursor_current_items_v1",
    validation = "bag_overlay_ovy15_bagview_cursor_slots_validated",
    fieldSystemPtr = field_system,
    fieldSystemSub0Ptr = field_system_sub0,
    overlayManagerPtr = overlay_manager,
    bagViewPtr = bag_view,
    cursorPtr = cursor_ptr,
    saveDataPtr = save_data,
    bagPtr = bag_save,
    header = header,
    saveHeaderReason = header_reason,
    saveBackedSlots = save_backed_slots,
    ovyId = ovy_id,
    mode = mode,
    pocketId = current_pocket,
    pocket = pocket_label,
    scroll = scroll,
    position = position,
    nonEmptyCount = non_empty_count,
    cursorItemId = cursor_item.item_id,
    cursorQuantity = cursor_item.quantity,
    items = entries,
  }
end

function party_menu_battle_input_still_active(active_battle)
  if active_battle == nil or active_battle.battleInput == nil then return false end
  return active_battle.battleInput.validation == "battle_input_current_context_backref_validated"
end

function decode_party_context_menu_from_party_menu(party_menu_data, overlay_manager)
  if not valid_arm9_ptr(party_menu_data) or not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "party_context_menu_invalid_owner_ptrs" }
  end
  local proc_state = u32(overlay_manager + 0x14)
  if proc_state ~= PARTY_MENU_STATE_HANDLE_CONTEXT_MENU_INPUT then
    return {
      active = false,
      reason = "party_context_menu_not_handle_context_menu_input",
      procState = proc_state,
    }
  end

  -- pret/pokeheartgold PartyMenu.contextMenuCursor is +0x824. Its embedded
  -- PartyMenuContextMenu points at the current ListMenuItems array.
  local context_menu_cursor = u32(party_menu_data + 0x824)
  if not valid_arm9_ptr(context_menu_cursor) then
    return {
      active = false,
      reason = "party_context_menu_cursor_pointer_invalid",
      procState = proc_state,
      contextMenuCursorPtr = context_menu_cursor,
    }
  end

  local selection = u8(context_menu_cursor + 0x01)
  local cursor_num_items = u8(context_menu_cursor + 0x02)
  local cursor_state = u8(context_menu_cursor + 0x03)
  local list_menu_items = u32(context_menu_cursor + 0x04)
  local menu_num_items = u8(context_menu_cursor + 0x0E)
  local num_items = menu_num_items
  if num_items == nil or num_items <= 0 then
    num_items = cursor_num_items
  end
  if not valid_arm9_ptr(list_menu_items) then
    return {
      active = false,
      reason = "party_context_menu_list_menu_items_pointer_invalid",
      procState = proc_state,
      contextMenuCursorPtr = context_menu_cursor,
      listMenuItemsPtr = list_menu_items,
      selection = selection,
      numItems = num_items,
    }
  end
  if num_items == nil or num_items <= 0 or num_items > PARTY_CONTEXT_MENU_MAX_ITEMS then
    return {
      active = false,
      reason = "party_context_menu_num_items_out_of_bounds",
      procState = proc_state,
      contextMenuCursorPtr = context_menu_cursor,
      listMenuItemsPtr = list_menu_items,
      selection = selection,
      numItems = num_items,
    }
  end
  if cursor_num_items ~= nil and cursor_num_items > 0 and cursor_num_items ~= num_items then
    return {
      active = false,
      reason = "party_context_menu_cursor_count_mismatch",
      procState = proc_state,
      contextMenuCursorPtr = context_menu_cursor,
      listMenuItemsPtr = list_menu_items,
      selection = selection,
      numItems = num_items,
      cursorNumItems = cursor_num_items,
    }
  end
  if selection == nil or selection < 0 or selection >= num_items then
    return {
      active = false,
      reason = "party_context_menu_selection_out_of_bounds",
      procState = proc_state,
      contextMenuCursorPtr = context_menu_cursor,
      listMenuItemsPtr = list_menu_items,
      selection = selection,
      numItems = num_items,
    }
  end

  local items = {}
  for i = 0, num_items - 1 do
    local item_addr = list_menu_items + i * 8
    local string_ptr = u32(item_addr)
    if string_ptr == 0xFFFFFFFF then
      return {
        active = false,
        reason = "party_context_menu_sentinel_before_expected_count",
        procState = proc_state,
        contextMenuCursorPtr = context_menu_cursor,
        listMenuItemsPtr = list_menu_items,
        selection = selection,
        numItems = num_items,
        sentinelIndex = i,
      }
    end
    local string_obj, string_reason = read_hgss_string_object(string_ptr)
    if string_obj == nil or string_obj.preview == nil or string_obj.preview == "" or (string_obj.printableRatio or 0) < 0.60 then
      return {
        active = false,
        reason = "party_context_menu_item_string_invalid",
        stringReason = string_reason,
        procState = proc_state,
        contextMenuCursorPtr = context_menu_cursor,
        listMenuItemsPtr = list_menu_items,
        stringPtr = string_ptr,
        index = i,
      }
    end
    items[#items + 1] = {
      text = string_obj.preview,
      selected = selection == i,
      index = i,
      stringPtr = string_ptr,
    }
  end

  local cursor_text = nil
  for _, item in ipairs(items) do
    if item.selected then
      cursor_text = item.text
      break
    end
  end
  if cursor_text == nil or cursor_text == "" then
    return {
      active = false,
      reason = "party_context_menu_cursor_text_missing",
      procState = proc_state,
      contextMenuCursorPtr = context_menu_cursor,
      listMenuItemsPtr = list_menu_items,
      selection = selection,
      numItems = num_items,
    }
  end

  return {
    active = true,
    source = "PartyMenuOverlayManager.contextMenuCursor.ListMenuItems",
    confidence = "validated_ram",
    contract = "ram_party_menu_context_menu_current_options_v1",
    validation = "party_menu_context_menu_cursor_list_items_validated",
    title = "Party choice",
    cursor = cursor_text,
    items = items,
    procState = proc_state,
    contextMenuCursorPtr = context_menu_cursor,
    listMenuItemsPtr = list_menu_items,
    selection = selection,
    numItems = num_items,
    cursorState = cursor_state,
  }
end

function decode_party_menu_overlay(field_system, active_battle)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "party_menu_no_valid_field_system" }
  end
  -- pret/pokeheartgold FieldSystem.unk0 is +0x00; unk0->unk4 is the active application OverlayManager.
  local field_system_sub0 = u32(field_system + 0x00)
  if not valid_arm9_ptr(field_system_sub0) then
    return { active = false, reason = "party_menu_no_field_system_sub0", fieldSystemPtr = field_system }
  end
  local overlay_manager = u32(field_system_sub0 + 0x04)
  if not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "party_menu_no_active_application", fieldSystemPtr = field_system, fieldSystemSub0Ptr = field_system_sub0 }
  end
  local ovy_id = signed32(u32(overlay_manager + 0x0C))
  if party_menu_battle_input_still_active(active_battle) then
    local battle_input = active_battle.battleInput
    return {
      active = false,
      reason = "party_menu_battle_input_still_active",
      fieldSystemPtr = field_system,
      fieldSystemSub0Ptr = field_system_sub0,
      overlayManagerPtr = overlay_manager,
      ovyId = ovy_id,
      battleInputPtr = battle_input.battleInputPtr,
      battleMenuName = battle_input.curMenuName,
      battleMenuId = battle_input.curMenuId,
      battleInputValidation = battle_input.validation,
    }
  end

  local save_data = u32(field_system + 0x0C)
  local party_core, header = save_array_from_save_data(save_data, SAVE_PARTY, HGSS_PARTY_SAVE_ARRAY_SIZE, HGSS_PARTY_SAVE_ARRAY_SIZE)
  if party_core == nil then
    return { active = false, reason = "party_menu_save_party_header_not_validated", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, saveDataPtr = save_data }
  end

  -- OverlayManager.args is +0x18 and is PartyMenuArgs for gOverlayTemplate_PartyMenu.
  -- gOverlayTemplate_PartyMenu uses FS_OVERLAY_ID_NONE, so ownership is validated
  -- through args back-pointers instead of an overlay id alone.
  local args = u32(overlay_manager + 0x18)
  if not valid_arm9_ptr(args) then
    return { active = false, reason = "party_menu_no_party_menu_args", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager }
  end
  local args_party = u32(args + 0x00)
  local args_field_system = u32(args + 0x1C)
  local party_menu_data = u32(overlay_manager + 0x1C)
  local args_owner_bound = args_party == party_core and args_field_system == field_system
  local overlay_owner_valid = ovy_id == PARTY_MENU_APP_OVERLAY_ID
  local data_owner_valid = false
  if valid_arm9_ptr(party_menu_data) then
    local data_args = u32(party_menu_data + 0x654)
    if data_args == args then
      data_owner_valid = true
    end
  end
  if not args_owner_bound and not data_owner_valid and not overlay_owner_valid then
    return {
      active = false,
      reason = "party_menu_args_not_owner_bound",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuArgsPtr = args,
      partyPtr = args_party,
      expectedPartyPtr = party_core,
      argsFieldSystemPtr = args_field_system,
      partyMenuPtr = party_menu_data,
      ovyId = ovy_id,
    }
  end

  local context_raw = u8(args + 0x24)
  local context_id = context_raw % 128
  local party_slot = u8(args + 0x26)
  if context_raw == nil or context_id < 0 or context_id > 23 then
    return { active = false, reason = "party_menu_context_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, partyMenuArgsPtr = args, contextId = context_raw }
  end
  if party_slot == nil or party_slot > 7 then
    return { active = false, reason = "party_menu_args_party_slot_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, partyMenuArgsPtr = args, partySlot = party_slot }
  end

  local party_count = u32(party_core + 0x04)
  local max_count = u32(party_core + 0x00)
  if max_count ~= PARTY_MAX_COUNT or party_count == nil or party_count < 0 or party_count > PARTY_MAX_COUNT then
    return { active = false, reason = "party_menu_party_header_bounds_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, partyMenuArgsPtr = args, maxCount = max_count, partyCount = party_count }
  end

  local selected_slot = party_slot
  if valid_arm9_ptr(party_menu_data) then
    local data_selected_slot = u8(party_menu_data + 0xC65)
    if data_owner_valid and data_selected_slot ~= nil and data_selected_slot <= 7 then
      selected_slot = data_selected_slot
    end
  end

  local items = {}
  local stats_valid = 0
  for slot = 0, party_count - 1 do
    local mon = decrypt_party_mon(party_core + PARTY_MONS_OFFSET + slot * PARTY_MON_SIZE)
    if mon == nil or not party_mon_stats_reasonable(mon) then
      return { active = false, reason = "party_menu_party_mon_not_validated", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, partyMenuArgsPtr = args, partyPtr = party_core, slot = slot + 1 }
    end
    stats_valid = stats_valid + 1
    items[#items + 1] = {
      slot = slot + 1,
      species_id = mon.species_id,
      species_name = mon.species_name,
      nickname = mon.nickname,
      level = mon.level,
      current_hp = mon.current_hp,
      max_hp = mon.max_hp,
      status = mon.status,
      held_item_id = mon.held_item_id,
      selected = selected_slot == slot,
    }
  end

  if selected_slot == PARTY_MAX_COUNT then
    items[#items + 1] = { slot = PARTY_MAX_COUNT + 1, text = "Cancel", selected = true }
  elseif selected_slot == PARTY_MAX_COUNT + 1 then
    items[#items + 1] = { slot = PARTY_MAX_COUNT + 2, text = "Confirm", selected = true }
  elseif selected_slot >= party_count then
    return { active = false, reason = "party_menu_selected_slot_not_visible", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, partyMenuArgsPtr = args, selectedSlot = selected_slot, partyCount = party_count }
  end

  local cursor_text = nil
  for _, item in ipairs(items) do
    if item.selected then
      cursor_text = item.text
      break
    end
  end

  local proc_state = nil
  local party_context_menu = nil
  if valid_arm9_ptr(party_menu_data) and data_owner_valid then
    proc_state = u32(overlay_manager + 0x14)
    party_context_menu = decode_party_context_menu_from_party_menu(party_menu_data, overlay_manager)
  end

  return {
    active = true,
    source = "PartyMenuOverlayManager.args.PartyMenuArgs",
    confidence = "validated_ram",
    contract = "ram_party_menu_overlay_args_party_cursor_current_slots_v1",
    validation = "party_menu_overlay_args_party_cursor_current_slots_validated",
    fieldSystemPtr = field_system,
    fieldSystemSub0Ptr = field_system_sub0,
    overlayManagerPtr = overlay_manager,
    partyMenuArgsPtr = args,
    partyMenuPtr = party_menu_data,
    dataOwnerValid = data_owner_valid,
    argsOwnerBound = args_owner_bound,
    overlayOwnerValid = overlay_owner_valid,
    saveDataPtr = save_data,
    partyPtr = party_core,
    header = header,
    contextId = context_id,
    contextRaw = context_raw,
    procState = proc_state,
    partySlot = party_slot,
    selectedSlot = selected_slot,
    partyCount = party_count,
    ovyId = ovy_id,
    statsValid = stats_valid,
    cursor = cursor_text,
    items = items,
    partyContextMenu = party_context_menu,
  }
end

function decode_summary_screen_overlay(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "summary_screen_no_valid_field_system" }
  end
  local field_system_sub0 = u32(field_system + 0x00)
  if not valid_arm9_ptr(field_system_sub0) then
    return { active = false, reason = "summary_screen_no_field_system_sub0", fieldSystemPtr = field_system }
  end
  local overlay_manager = u32(field_system_sub0 + 0x04)
  if not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "summary_screen_no_active_application", fieldSystemPtr = field_system, fieldSystemSub0Ptr = field_system_sub0 }
  end

  local save_data = u32(field_system + 0x0C)
  local party_core, header = save_array_from_save_data(save_data, SAVE_PARTY, HGSS_PARTY_SAVE_ARRAY_SIZE, HGSS_PARTY_SAVE_ARRAY_SIZE)
  if party_core == nil then
    return { active = false, reason = "summary_screen_save_party_header_not_validated", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, saveDataPtr = save_data }
  end

  -- PokemonSummaryArgs is the OverlayManager args for gOverlayTemplate_PokemonSummary.
  -- The app work struct created by PokemonSummary_Init stores the same args pointer
  -- at +0x22C, giving an owner-bound check even though the overlay id is -1.
  local args = u32(overlay_manager + 0x18)
  local work = u32(overlay_manager + 0x1C)
  if not valid_arm9_ptr(args) or not valid_arm9_ptr(work) then
    return { active = false, reason = "summary_screen_no_args_or_work", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, summaryWorkPtr = work }
  end
  local work_args = u32(work + 0x22C)
  if work_args ~= args then
    return { active = false, reason = "summary_screen_work_args_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, summaryWorkPtr = work, workArgsPtr = work_args }
  end

  local args_party = u32(args + 0x00)
  local args_party_count = u8(args + 0x13)
  local args_party_slot = u8(args + 0x14)
  local move_to_learn = u16(args + 0x18)
  local menu_input_state_ptr = u32(args + 0x30)
  if args_party ~= party_core then
    return { active = false, reason = "summary_screen_party_args_not_owner_bound", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, partyPtr = args_party, expectedPartyPtr = party_core }
  end

  local party_count = u32(party_core + 0x04)
  local max_count = u32(party_core + 0x00)
  if max_count ~= PARTY_MAX_COUNT or party_count == nil or party_count < 0 or party_count > PARTY_MAX_COUNT then
    return { active = false, reason = "summary_screen_party_header_bounds_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, maxCount = max_count, partyCount = party_count }
  end
  if args_party_count == nil or args_party_count < 1 or args_party_count > PARTY_MAX_COUNT or args_party_count > party_count then
    return { active = false, reason = "summary_screen_args_party_count_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, argsPartyCount = args_party_count, partyCount = party_count }
  end
  if args_party_slot == nil or args_party_slot >= party_count then
    return { active = false, reason = "summary_screen_args_party_slot_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, partySlot = args_party_slot, partyCount = party_count }
  end
  if move_to_learn == nil or move_to_learn > HGSS_MOVE_MAX then
    return { active = false, reason = "summary_screen_move_to_learn_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, moveToLearn = move_to_learn }
  end

  local mon = decrypt_party_mon(party_core + PARTY_MONS_OFFSET + args_party_slot * PARTY_MON_SIZE)
  if mon == nil or not party_mon_stats_reasonable(mon) then
    return { active = false, reason = "summary_screen_current_mon_not_validated", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, summaryArgsPtr = args, partyPtr = party_core, partySlot = args_party_slot }
  end

  return {
    active = true,
    source = "PokemonSummaryOverlayManager.args.PokemonSummaryArgs",
    confidence = "validated_ram",
    contract = "ram_pokemon_summary_overlay_args_current_mon_v1",
    validation = "pokemon_summary_overlay_args_data_current_mon_validated",
    fieldSystemPtr = field_system,
    fieldSystemSub0Ptr = field_system_sub0,
    overlayManagerPtr = overlay_manager,
    summaryArgsPtr = args,
    summaryWorkPtr = work,
    saveDataPtr = save_data,
    partyPtr = party_core,
    header = header,
    partySlot = args_party_slot,
    partyCount = args_party_count,
    moveToLearn = move_to_learn,
    menuInputStatePtr = menu_input_state_ptr,
    mon = mon,
  }
end

function decode_party_menu_summary_screen_overlay(field_system, active_battle)
  local party_menu = decode_party_menu_overlay(field_system, active_battle)
  if party_menu == nil or party_menu.active ~= true then
    return {
      active = false,
      reason = "summary_screen_party_menu_not_active",
      partyMenuReason = party_menu and party_menu.reason or nil,
      fieldSystemPtr = field_system,
    }
  end

  if party_menu_battle_input_still_active(active_battle) then
    local battle_input = active_battle.battleInput
    return {
      active = false,
      reason = "summary_screen_party_menu_battle_input_still_active",
      fieldSystemPtr = field_system,
      overlayManagerPtr = party_menu.overlayManagerPtr,
      partyMenuPtr = party_menu.partyMenuPtr,
      battleInputPtr = battle_input.battleInputPtr,
      battleMenuName = battle_input.curMenuName,
      battleMenuId = battle_input.curMenuId,
      battleInputValidation = battle_input.validation,
    }
  end

  local overlay_manager = party_menu.overlayManagerPtr
  local party_menu_data = party_menu.partyMenuPtr
  local party_core = party_menu.partyPtr
  if not valid_arm9_ptr(overlay_manager) or not valid_arm9_ptr(party_menu_data) or not valid_arm9_ptr(party_core) then
    return {
      active = false,
      reason = "summary_screen_party_menu_ptrs_invalid",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuPtr = party_menu_data,
      partyPtr = party_core,
    }
  end

  local proc_state = u32(overlay_manager + 0x14)
  if proc_state ~= PARTY_MENU_STATE_SUMMARY_PANEL then
    return {
      active = false,
      reason = "summary_screen_party_menu_not_summary_panel",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuPtr = party_menu_data,
      procState = proc_state,
    }
  end

  local context_id = party_menu.contextId
  if context_id ~= PARTY_MENU_CONTEXT_NORMAL then
    return {
      active = false,
      reason = "summary_screen_party_menu_context_not_normal",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuPtr = party_menu_data,
      procState = proc_state,
      contextId = context_id,
    }
  end

  local top_screen_panel_y = signed32(u32(party_menu_data + 0xC78))
  local top_screen_panel_show = u32(party_menu_data + 0xC7C)

  local party_count = u32(party_core + 0x04)
  local max_count = u32(party_core + 0x00)
  if max_count ~= PARTY_MAX_COUNT or party_count == nil or party_count < 1 or party_count > PARTY_MAX_COUNT then
    return {
      active = false,
      reason = "summary_screen_party_menu_party_header_bounds_invalid",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuPtr = party_menu_data,
      partyPtr = party_core,
      maxCount = max_count,
      partyCount = party_count,
    }
  end

  local selected_slot = party_menu.selectedSlot
  if selected_slot == nil then selected_slot = party_menu.partySlot end
  if selected_slot == nil or selected_slot < 0 or selected_slot >= party_count then
    return {
      active = false,
      reason = "summary_screen_party_menu_selected_slot_invalid",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuPtr = party_menu_data,
      partyPtr = party_core,
      selectedSlot = selected_slot,
      partyCount = party_count,
    }
  end

  local mon = decrypt_party_mon(party_core + PARTY_MONS_OFFSET + selected_slot * PARTY_MON_SIZE)
  if mon == nil or not party_mon_stats_reasonable(mon) then
    return {
      active = false,
      reason = "summary_screen_party_menu_current_mon_not_validated",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      partyMenuPtr = party_menu_data,
      partyPtr = party_core,
      partySlot = selected_slot,
    }
  end

  return {
    active = true,
    source = "PartyMenuOverlayManager.procState.PartyMenuSummaryPanel",
    confidence = "validated_ram",
    contract = "ram_party_menu_summary_panel_current_mon_v1",
    validation = "party_menu_proc_state_summary_panel_current_mon_validated",
    fieldSystemPtr = field_system,
    fieldSystemSub0Ptr = party_menu.fieldSystemSub0Ptr,
    overlayManagerPtr = overlay_manager,
    partyMenuArgsPtr = party_menu.partyMenuArgsPtr,
    partyMenuPtr = party_menu_data,
    saveDataPtr = party_menu.saveDataPtr,
    partyPtr = party_core,
    header = party_menu.header,
    procState = proc_state,
    topScreenPanelShow = top_screen_panel_show,
    topScreenPanelYPos = top_screen_panel_y,
    partySlot = selected_slot,
    partyCount = party_count,
    mon = mon,
  }
end

function decode_current_summary_screen(field_system, active_battle)
  local standalone = decode_summary_screen_overlay(field_system)
  if standalone ~= nil and standalone.active == true then
    return standalone
  end
  local party_summary = decode_party_menu_summary_screen_overlay(field_system, active_battle)
  if party_summary ~= nil and party_summary.active == true then
    return party_summary
  end
  if standalone ~= nil then
    standalone.partyMenuSummaryReason = party_summary and party_summary.reason or nil
    standalone.partyMenuSummaryProcState = party_summary and party_summary.procState or nil
    standalone.partyMenuSummaryTopScreenPanelShow = party_summary and party_summary.topScreenPanelShow or nil
    standalone.partyMenuSummaryTopScreenPanelYPos = party_summary and party_summary.topScreenPanelYPos or nil
    return standalone
  end
  return party_summary
end

function save_vars_script_flag_from_ptr(vars_flags, flag_id)
  if not valid_arm9_ptr(vars_flags) or flag_id == nil or flag_id < 0 then return nil end
  local value = u8(vars_flags + SAVE_VARS_FLAGS_FLAGS_OFFSET + math.floor(flag_id / 8))
  if value == nil then return nil end
  return (value & (1 << (flag_id % 8))) ~= 0
end

function pokegear_flypoint_unlocked(vars_flags, flypoint)
  if flypoint == nil or flypoint < 0 or flypoint > 37 then return nil end
  return save_vars_script_flag_from_ptr(vars_flags, FLYPOINT_FLAG_BASE + flypoint)
end

function pokegear_flypoint_at_coord(vars_flags, x, y)
  if x == nil or y == nil then return nil, nil end
  for idx, flypoint in ipairs(POKEGEAR_FLYPOINTS) do
    if x >= flypoint.x and x < flypoint.x + flypoint.width and y >= flypoint.y and y < flypoint.y + flypoint.height then
      if pokegear_flypoint_unlocked(vars_flags, flypoint.flypoint) == true then
        return idx - 1, flypoint
      end
    end
  end
  return nil, nil
end

function pokegear_location_spec_map_id(map_app, location_spec)
  if not valid_arm9_ptr(map_app) or not valid_arm9_ptr(location_spec) then return nil end
  local location_specs = u32(map_app + 0x214)
  if not valid_arm9_ptr(location_specs) then return nil end
  local offset = location_spec - location_specs
  if offset < 0 or offset >= POKEGEAR_MAP_LOCATION_COUNT * POKEGEAR_MAP_LOCATION_SPEC_SIZE then return nil end
  if (offset % POKEGEAR_MAP_LOCATION_SPEC_SIZE) ~= 0 then return nil end
  return u16(location_spec + 0x00)
end

function decode_pokegear_fly_map_overlay(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "fly_map_no_valid_field_system" }
  end
  local field_system_sub0 = u32(field_system + 0x00)
  if not valid_arm9_ptr(field_system_sub0) then
    return { active = false, reason = "fly_map_no_field_system_sub0", fieldSystemPtr = field_system }
  end
  local overlay_manager = u32(field_system_sub0 + 0x04)
  if not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "fly_map_no_active_application", fieldSystemPtr = field_system, fieldSystemSub0Ptr = field_system_sub0 }
  end
  local ovy_id = signed32(u32(overlay_manager + 0x0C))
  if ovy_id ~= POKEGEAR_APP_OVERLAY_ID then
    return { active = false, reason = "fly_map_active_application_not_pokegear_app", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, ovyId = ovy_id }
  end

  local overlay_args = u32(overlay_manager + 0x18)
  local pokegear = u32(overlay_manager + 0x1C)
  if not valid_arm9_ptr(pokegear) then
    return { active = false, reason = "fly_map_no_pokegear_appdata", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, overlayPokegearArgsPtr = overlay_args, pokegearAppPtr = pokegear }
  end
  local active_app = u8(pokegear + 0x004)
  if active_app ~= GEAR_APP_MAP then
    return { active = false, reason = "fly_map_active_pokegear_app_not_map", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, overlayPokegearArgsPtr = overlay_args, pokegearAppPtr = pokegear, activePokegearApp = active_app }
  end

  local args = u32(pokegear + 0x020)
  local map_app = u32(pokegear + 0x064)
  if not valid_arm9_ptr(args) or not valid_arm9_ptr(map_app) then
    return { active = false, reason = "fly_map_no_active_map_child_appdata", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, overlayPokegearArgsPtr = overlay_args, pokegearArgsPtr = args, pokegearAppPtr = pokegear, mapAppPtr = map_app }
  end
  local map_app_pokegear = u32(map_app + 0x010)
  if map_app_pokegear ~= pokegear then
    return { active = false, reason = "fly_map_map_app_pokegear_backref_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, overlayPokegearArgsPtr = overlay_args, pokegearArgsPtr = args, pokegearAppPtr = pokegear, mapAppPtr = map_app, mapAppPokegearBackref = map_app_pokegear }
  end
  local save_data = u32(field_system + 0x0C)
  local pokegear_save_data = u32(pokegear + 0x024)
  local save_vars_flags = u32(pokegear + 0x02C)
  if (valid_arm9_ptr(overlay_args) and overlay_args ~= args) or pokegear_save_data ~= save_data or not valid_arm9_ptr(save_vars_flags) then
    return { active = false, reason = "fly_map_args_or_save_backlink_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, overlayPokegearArgsPtr = overlay_args, pokegearArgsPtr = args, pokegearAppPtr = pokegear, mapAppPtr = map_app, saveDataPtr = save_data, pokegearSaveDataPtr = pokegear_save_data, saveFlagsPtr = save_vars_flags }
  end

  local map_type = u8(map_app + 0x00D)
  if map_type ~= POKEGEAR_MAP_TYPE_GEAR and map_type ~= POKEGEAR_MAP_TYPE_FLY and map_type ~= POKEGEAR_MAP_TYPE_TOWN_MAP then
    return { active = false, reason = "fly_map_type_not_fly_or_town_map", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokegearArgsPtr = args, mapAppPtr = map_app, mapType = map_type }
  end
  local num_location_specs = u8(map_app + 0x136)
  local location_specs = u32(map_app + 0x214)
  if num_location_specs ~= POKEGEAR_MAP_LOCATION_COUNT or not valid_arm9_ptr(location_specs) then
    return { active = false, reason = "fly_map_location_specs_not_validated", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokegearArgsPtr = args, mapAppPtr = map_app, numLocationSpecs = num_location_specs, locationSpecsPtr = location_specs }
  end

  local state = u32(map_app + 0x004)
  local player_x = s16(map_app + 0x110)
  local player_y = s16(map_app + 0x112)
  local min_x = u16(map_app + 0x100)
  local max_x = u16(map_app + 0x102)
  local min_y = u16(map_app + 0x104)
  local max_y = u16(map_app + 0x106)
  if state == nil or state < 0 or state > 13 or player_x == nil or player_y == nil or min_x == nil or max_x == nil or min_y == nil or max_y == nil then
    return { active = false, reason = "fly_map_cursor_unreadable", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokegearArgsPtr = args, mapAppPtr = map_app }
  end
  if player_x < min_x or player_x > max_x or player_y < min_y or player_y > max_y + 2 or player_x < 0 or player_x > 64 or player_y < 0 or player_y > 64 then
    return { active = false, reason = "fly_map_cursor_bounds_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokegearArgsPtr = args, mapAppPtr = map_app, cursorX = player_x, cursorY = player_y, minX = min_x, maxX = max_x, minY = min_y, maxY = max_y }
  end

  local selected_loc_ptr = u32(map_app + 0x118)
  local cursor_location_map_id = pokegear_location_spec_map_id(map_app, selected_loc_ptr)
  local selected_dest_index = s8(map_app + 0x00F)
  local fly_coord_y = player_y - 2
  local flypoint_index, flypoint = pokegear_flypoint_at_coord(save_vars_flags, player_x, fly_coord_y)
  if map_type == POKEGEAR_MAP_TYPE_FLY and selected_dest_index ~= nil and selected_dest_index >= 0 then
    local selected_flypoint = POKEGEAR_FLYPOINTS[selected_dest_index + 1]
    if selected_flypoint == nil or pokegear_flypoint_unlocked(save_vars_flags, selected_flypoint.flypoint) ~= true then
      return { active = false, reason = "fly_map_selected_destination_not_unlocked", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokegearArgsPtr = args, mapAppPtr = map_app, flyDestination = selected_dest_index }
    end
    flypoint_index = selected_dest_index
    flypoint = selected_flypoint
  end

  local context_menu_active = state == POKEGEAR_MAP_MAIN_STATE_FLY_CONTEXT_MENU and valid_arm9_ptr(u32(map_app + 0x0C4))
  local title = map_type == POKEGEAR_MAP_TYPE_FLY and "Fly Map" or "Town Map"
  local items = {}
  local selected_destination_name_map_id = nil
  local selected_destination_warp_map_id = nil
  if flypoint ~= nil then
    selected_destination_name_map_id = flypoint.nameMapId
    selected_destination_warp_map_id = flypoint.warpMapId
    if context_menu_active then
      items[#items + 1] = { text = "Fly", selected = true }
      items[#items + 1] = { text = "Close", selected = false }
    else
      items[#items + 1] = { text = "Destination", selected = true }
    end
  elseif cursor_location_map_id ~= nil then
    items[#items + 1] = { text = "Cursor location", selected = true }
  end

  return {
    active = true,
    source = "PokegearTownMapOverlay.args.PokegearArgs",
    confidence = "validated_ram",
    contract = "ram_pokegear_flymap_overlay_args_cursor_current_destination_v1",
    validation = "pokegear_flymap_overlay_owner_bound_cursor_destination_validated",
    fieldSystemPtr = field_system,
    fieldSystemSub0Ptr = field_system_sub0,
    overlayManagerPtr = overlay_manager,
    pokegearArgsPtr = args,
    mapAppPtr = map_app,
    pokegearAppPtr = pokegear,
    saveDataPtr = save_data,
    saveFlagsPtr = save_vars_flags,
    ovyId = ovy_id,
    mapType = map_type,
    mapAppState = state,
    title = title,
    isFlyMode = map_type == POKEGEAR_MAP_TYPE_FLY,
    contextMenuActive = context_menu_active,
    cursorX = player_x,
    cursorY = player_y,
    cursorLocationMapId = cursor_location_map_id,
    flypoint = flypoint and flypoint.flypoint or nil,
    flypointIndex = flypoint_index,
    selectedDestinationMapId = selected_destination_name_map_id,
    selectedFlyDestMapId = selected_destination_warp_map_id,
    items = items,
  }
end

function update_battle_text_probe_lock(candidate)
  if not candidate then
    LOCKED_BATTLE_TEXT_PROBE = nil
    CURRENT_BATTLE_TEXT_INSTANCE = nil
    CURRENT_BATTLE_TEXT_EPOCH = CURRENT_BATTLE_TEXT_EPOCH + 1
    clear_recent_battle_text_events("battle_text_candidate_missing")
    return nil
  end
  local same_lock = LOCKED_BATTLE_TEXT_PROBE
    and LOCKED_BATTLE_TEXT_PROBE.battleSystemPtr == candidate.battleSystemPtr
    and LOCKED_BATTLE_TEXT_PROBE.msgBufferPtr == candidate.msgBufferPtr
    and LOCKED_BATTLE_TEXT_PROBE.ctxPtr == candidate.ctxPtr
  if same_lock then
    LOCKED_BATTLE_TEXT_PROBE.stableSamples = (LOCKED_BATTLE_TEXT_PROBE.stableSamples or 0) + 1
    LOCKED_BATTLE_TEXT_PROBE.preview = candidate.string and candidate.string.preview or LOCKED_BATTLE_TEXT_PROBE.preview
  else
    if LOCKED_BATTLE_TEXT_PROBE then
      clear_recent_battle_text_events("battle_text_lock_changed")
    end
    LOCKED_BATTLE_TEXT_PROBE = {
      battleSystemPtr = candidate.battleSystemPtr,
      msgBufferPtr = candidate.msgBufferPtr,
      ctxPtr = candidate.ctxPtr,
      stableSamples = 1,
      preview = candidate.string and candidate.string.preview or "",
    }
  end
  return LOCKED_BATTLE_TEXT_PROBE
end

function locked_battle_text_probe_candidate()
  if not LOCKED_BATTLE_TEXT_PROBE then return nil end
  local string_obj = read_hgss_string_object(LOCKED_BATTLE_TEXT_PROBE.msgBufferPtr)
  local valid_string = validate_battle_text_candidate_string(string_obj)
  local ctx_ptr = u32(LOCKED_BATTLE_TEXT_PROBE.battleSystemPtr + 0x30)
  if not valid_string or ctx_ptr ~= LOCKED_BATTLE_TEXT_PROBE.ctxPtr then
    LOCKED_BATTLE_TEXT_PROBE = nil
    CURRENT_BATTLE_TEXT_INSTANCE = nil
    CURRENT_BATTLE_TEXT_EPOCH = CURRENT_BATTLE_TEXT_EPOCH + 1
    clear_recent_battle_text_events("battle_text_lock_invalid")
    return nil
  end
  set_battle_text_instance(battle_text_instance_id(LOCKED_BATTLE_TEXT_PROBE.battleSystemPtr, LOCKED_BATTLE_TEXT_PROBE.ctxPtr))
  LOCKED_BATTLE_TEXT_PROBE.stableSamples = (LOCKED_BATTLE_TEXT_PROBE.stableSamples or 0) + 1
  LOCKED_BATTLE_TEXT_PROBE.preview = string_obj.preview
  return {
    active = true,
    status = LOCKED_BATTLE_TEXT_PROBE.stableSamples >= TEXT_PROBE_LOCK_MIN_SAMPLES and "locked" or "candidate",
    source = "ram_text_probe_monitor_only",
    contract = "candidate_battle_system_msg_buffer_not_in_current_observation",
    lockedBattleSystemPtr = LOCKED_BATTLE_TEXT_PROBE.battleSystemPtr,
    battleSystemPtr = LOCKED_BATTLE_TEXT_PROBE.battleSystemPtr,
    msgBufferPtr = LOCKED_BATTLE_TEXT_PROBE.msgBufferPtr,
    ctxPtr = LOCKED_BATTLE_TEXT_PROBE.ctxPtr,
    stableSamples = LOCKED_BATTLE_TEXT_PROBE.stableSamples,
    lockMinSamples = TEXT_PROBE_LOCK_MIN_SAMPLES,
    contextEpoch = CURRENT_BATTLE_TEXT_EPOCH,
    string = string_obj,
    candidate_scan_budget = 0,
  }
end

function mark_battle_text_probe_validated(battle_text_probe, active_battle)
  if not battle_text_probe or not active_battle then return battle_text_probe end
  if battle_text_probe.active ~= true then return battle_text_probe end
  if active_battle.validation ~= "battle_context_battle_mons_validated" then return battle_text_probe end
  if battle_text_probe.battleSystemPtr ~= active_battle.battleSystemPtr then return battle_text_probe end
  if battle_text_probe.ctxPtr ~= active_battle.ctxPtr then return battle_text_probe end
  if battle_text_probe.msgBufferPtr ~= active_battle.msgBufferPtr then return battle_text_probe end
  if active_battle.msgBufferString == nil or active_battle.msgBufferString.maxsize ~= 0x140 then return battle_text_probe end
  local printer, printer_reason = resolve_owner_bound_battle_text_printer(active_battle)
  if printer ~= nil then
    battle_text_probe.printer = printer
    battle_text_probe.visiblePreview = printer.visiblePreview
  end
  battle_text_probe.printerReason = printer_reason
  battle_text_probe.contract = "validated_battle_system_msgbuffer_event_v1"
  battle_text_probe.decoderContract = "validated_battle_system_msgbuffer_event_v1"
  battle_text_probe.decoderSource = "BattleSystem.msgBuffer+BattleContext.battleMons"
  battle_text_probe.source = "BattleSystem.msgBuffer"
  return battle_text_probe
end

function next_text_probe_scan_addr()
  local addr = NEXT_TEXT_PROBE_SCAN_ADDR
  NEXT_TEXT_PROBE_SCAN_ADDR = NEXT_TEXT_PROBE_SCAN_ADDR + TEXT_PROBE_SCAN_STEP
  if NEXT_TEXT_PROBE_SCAN_ADDR >= TEXT_PROBE_SCAN_END then
    NEXT_TEXT_PROBE_SCAN_ADDR = TEXT_PROBE_SCAN_START
  end
  return addr
end

function probe_battle_text_candidate(in_battle_candidate)
  if not in_battle_candidate then
    LOCKED_BATTLE_TEXT_PROBE = nil
    if CURRENT_BATTLE_TEXT_INSTANCE ~= nil or #RECENT_BATTLE_TEXT_EVENTS > 0 then
      CURRENT_BATTLE_TEXT_INSTANCE = nil
      CURRENT_BATTLE_TEXT_EPOCH = CURRENT_BATTLE_TEXT_EPOCH + 1
      clear_recent_battle_text_events("battle_inactive")
    end
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = "not_in_battle_candidate",
      candidate_scan_budget = TEXT_PROBE_SCAN_BUDGET,
    }
  end

  local locked = locked_battle_text_probe_candidate()
  if locked then return locked end

  local scanned = 0
  local start_addr = NEXT_TEXT_PROBE_SCAN_ADDR
  local candidates = {}
  while scanned < TEXT_PROBE_SCAN_BUDGET do
    local battle_system_addr = next_text_probe_scan_addr()
    scanned = scanned + 1
    local msg_buffer_ptr = u32(battle_system_addr + 0x18)
    if valid_arm9_ptr(msg_buffer_ptr) then
      local string_obj = read_hgss_string_object(msg_buffer_ptr)
      local ctx_ptr = u32(battle_system_addr + 0x30)
      local msg_data_ptr = u32(battle_system_addr + 0x0C)
      local msg_format_ptr = u32(battle_system_addr + 0x14)
      local string_valid = validate_battle_text_candidate_string(string_obj)
      if string_valid and valid_arm9_ptr(ctx_ptr) and valid_arm9_ptr(msg_data_ptr) and valid_arm9_ptr(msg_format_ptr) then
        local buff_msg_id = u16(ctx_ptr + 0xF6)
        local buff_msg_tag = u8(ctx_ptr + 0xF5)
        candidates[#candidates + 1] = {
          battleSystemPtr = battle_system_addr,
          msgBufferPtr = msg_buffer_ptr,
          ctxPtr = ctx_ptr,
          msgDataPtr = msg_data_ptr,
          msgFormatPtr = msg_format_ptr,
          buffMsgIdCandidate = buff_msg_id,
          buffMsgTagCandidate = buff_msg_tag,
          string = string_obj,
        }
        if #candidates >= TEXT_PROBE_MAX_CANDIDATES then
          break
        end
      end
    end
  end

  if #candidates > 1 then
    LOCKED_BATTLE_TEXT_PROBE = nil
    return {
      active = false,
      status = "ambiguous",
      source = "ram_text_probe_monitor_only",
      reason = "ambiguous_candidates",
      ambiguous_candidates = #candidates,
      scanned = scanned,
      scanStart = start_addr,
      nextScanStart = NEXT_TEXT_PROBE_SCAN_ADDR,
      candidate_scan_budget = TEXT_PROBE_SCAN_BUDGET,
    }
  end

  if #candidates == 1 then
    local lock = update_battle_text_probe_lock(candidates[1])
    candidates[1].active = true
    candidates[1].status = lock and lock.stableSamples >= TEXT_PROBE_LOCK_MIN_SAMPLES and "locked" or "candidate"
    candidates[1].source = "ram_text_probe_monitor_only"
    candidates[1].contract = "candidate_battle_system_msg_buffer_not_in_current_observation"
    candidates[1].lockedBattleSystemPtr = lock and lock.stableSamples >= TEXT_PROBE_LOCK_MIN_SAMPLES and lock.battleSystemPtr or nil
    candidates[1].stableSamples = lock and lock.stableSamples or 1
    candidates[1].lockMinSamples = TEXT_PROBE_LOCK_MIN_SAMPLES
    candidates[1].scanned = scanned
    candidates[1].scanStart = start_addr
    candidates[1].candidate_scan_budget = TEXT_PROBE_SCAN_BUDGET
    return candidates[1]
  end

  return {
    active = false,
    source = "ram_text_probe_monitor_only",
    reason = "candidate_not_found_in_scan_window",
    scanned = scanned,
    scanStart = start_addr,
    nextScanStart = NEXT_TEXT_PROBE_SCAN_ADDR,
    candidate_scan_budget = TEXT_PROBE_SCAN_BUDGET,
  }
end

function is_non_placeholder_visible_text(text)
  if text == nil then return false end
  local value = tostring(text)
  value = string.gsub(value, "{[^}]*}", "")
  value = string.gsub(value, "%s+", "")
  if value == "" then return false end
  return string.find(value, "[%w]") ~= nil
end

function clear_recent_battle_text_events(reason)
  RECENT_BATTLE_TEXT_EVENTS = {}
  LAST_BATTLE_TEXT_EVENT_KEY = ""
  LAST_BATTLE_TEXT_EVENT_FRAME = -999999
  if reason then
    CURRENT_BATTLE_TEXT_CLEAR_REASON = reason
  end
end

function clear_recent_field_text_events(reason)
  RECENT_FIELD_TEXT_EVENTS = {}
  LAST_FIELD_TEXT_EVENT_KEY = ""
  LAST_FIELD_TEXT_EVENT_FRAME = -999999
  if reason then
    CURRENT_FIELD_TEXT_CLEAR_REASON = reason
  end
end

function set_battle_text_instance(instance_id)
  if CURRENT_BATTLE_TEXT_INSTANCE ~= instance_id then
    CURRENT_BATTLE_TEXT_INSTANCE = instance_id
    CURRENT_BATTLE_TEXT_EPOCH = CURRENT_BATTLE_TEXT_EPOCH + 1
    clear_recent_battle_text_events("battle_text_instance_changed")
  end
end

function set_field_text_instance(instance_id)
  if CURRENT_FIELD_TEXT_INSTANCE ~= instance_id then
    CURRENT_FIELD_TEXT_INSTANCE = instance_id
    CURRENT_FIELD_TEXT_EPOCH = CURRENT_FIELD_TEXT_EPOCH + 1
    clear_recent_field_text_events("field_text_instance_changed")
  end
end

function battle_text_instance_id(battle_system_ptr, ctx_ptr)
  return string.format("battle:%08X:%08X", battle_system_ptr or 0, ctx_ptr or 0)
end

function field_text_instance_id(lock)
  if not lock then return "field:none" end
  return string.format(
    "field:%08X:%08X:%d:%d",
    lock.envPtr or 0,
    lock.stringBuffer0Ptr or 0,
    lock.textPrinterNum or -1,
    lock.activeScriptNumber or -1
  )
end

function push_recent_battle_text_event(text, decoder_contract, decoder_source, extra)
  if not is_non_placeholder_visible_text(text) then return end
  if decoder_contract ~= "validated_battle_system_msgbuffer_event_v1" and decoder_contract ~= "owner_bound_battle_msgbuffer_textprinter_current_v1" then return end
  local current_frame = emu.framecount()
  if current_frame == nil then return end
  local key = tostring(text)
  local event_key = tostring(CURRENT_BATTLE_TEXT_EPOCH) .. ":" .. key
  if event_key == LAST_BATTLE_TEXT_EVENT_KEY and (current_frame - LAST_BATTLE_TEXT_EVENT_FRAME) < 12 then return end
  LAST_BATTLE_TEXT_EVENT_KEY = event_key
  LAST_BATTLE_TEXT_EVENT_FRAME = current_frame
  RECENT_BATTLE_TEXT_EVENTS[#RECENT_BATTLE_TEXT_EVENTS + 1] = {
    active = true,
    surface = "battle",
    text = key,
    source = "ram_visible_text",
    confidence = "validated_current",
    contract = "current_visible_text_v1_recent_observed",
    decoderContract = decoder_contract,
    decoderSource = decoder_source or "BattleSystem.msgBuffer",
    visibilityContract = extra and extra.visibilityContract or nil,
    contextEpoch = CURRENT_BATTLE_TEXT_EPOCH,
    frame = current_frame,
    frameSource = "emu.framecount",
  }
  while #RECENT_BATTLE_TEXT_EVENTS > RECENT_BATTLE_TEXT_MAX do
    table.remove(RECENT_BATTLE_TEXT_EVENTS, 1)
  end
end

function sample_battle_msgbuffer_from_system(battle_system_ptr, expected_ctx_ptr)
  if u16(0x02247612) ~= 0x2801 then
    CURRENT_BATTLE_TEXT_INSTANCE = nil
    CURRENT_BATTLE_TEXT_EPOCH = CURRENT_BATTLE_TEXT_EPOCH + 1
    clear_recent_battle_text_events("battle_inactive")
    return
  end
  if not valid_arm9_ptr(battle_system_ptr) then return end
  local msg_buffer_ptr = u32(battle_system_ptr + 0x18)
  local ctx_ptr = u32(battle_system_ptr + 0x30)
  if expected_ctx_ptr and ctx_ptr ~= expected_ctx_ptr then return end
  set_battle_text_instance(battle_text_instance_id(battle_system_ptr, ctx_ptr))
  local msg_data_ptr = u32(battle_system_ptr + 0x0C)
  local msg_format_ptr = u32(battle_system_ptr + 0x14)
  if not valid_arm9_ptr(msg_data_ptr) or not valid_arm9_ptr(msg_format_ptr) then return end
  local string_obj = read_hgss_string_object(msg_buffer_ptr)
  local valid_string = validate_battle_text_candidate_string(string_obj)
  if not valid_string then return end
  local active_battle = decode_battle_system_candidate(battle_system_ptr)
  if not active_battle or active_battle.ctxPtr ~= ctx_ptr or active_battle.msgBufferPtr ~= msg_buffer_ptr or active_battle.validation ~= "battle_context_battle_mons_validated" then return end
  local printer, printer_reason = resolve_owner_bound_battle_text_printer(active_battle)
  if printer and printer.consumedWords >= string_obj.size then
    push_recent_battle_text_event(
      printer.visiblePreview or "",
      "validated_battle_system_msgbuffer_event_v1",
      "BattleSystem.msgBuffer+owner_bound_battle_textprinter_complete",
      { visibilityContract = "owner_bound_battle_textprinter_complete_v1" }
    )
  elseif printer_reason == "multiple_owner_bound_battle_text_printers" then
    clear_recent_battle_text_events(printer_reason)
  end
end

function sample_locked_battle_msgbuffer_recent_text()
  if u16(0x02247612) ~= 0x2801 then
    if CURRENT_BATTLE_TEXT_INSTANCE ~= nil or #RECENT_BATTLE_TEXT_EVENTS > 0 then
      CURRENT_BATTLE_TEXT_INSTANCE = nil
      CURRENT_BATTLE_TEXT_EPOCH = CURRENT_BATTLE_TEXT_EPOCH + 1
      clear_recent_battle_text_events("battle_inactive")
    end
    return
  end
  if LOCKED_BATTLE_TEXT_PROBE and (LOCKED_BATTLE_TEXT_PROBE.stableSamples or 0) >= TEXT_PROBE_LOCK_MIN_SAMPLES then
    sample_battle_msgbuffer_from_system(LOCKED_BATTLE_TEXT_PROBE.battleSystemPtr, LOCKED_BATTLE_TEXT_PROBE.ctxPtr)
  end
  if LOCKED_BATTLE_SYSTEM_PROBE then
    sample_battle_msgbuffer_from_system(LOCKED_BATTLE_SYSTEM_PROBE.battleSystemPtr, LOCKED_BATTLE_SYSTEM_PROBE.ctxPtr)
  end
end

function update_field_text_probe_lock(candidate)
  if not candidate then
    LOCKED_FIELD_TEXT_PROBE = nil
    CURRENT_FIELD_TEXT_INSTANCE = nil
    CURRENT_FIELD_TEXT_EPOCH = CURRENT_FIELD_TEXT_EPOCH + 1
    clear_recent_field_text_events("field_text_candidate_missing")
    return nil
  end
  local same_lock = LOCKED_FIELD_TEXT_PROBE
    and LOCKED_FIELD_TEXT_PROBE.fieldSystemPtr == candidate.fieldSystemPtr
    and LOCKED_FIELD_TEXT_PROBE.envPtr == candidate.envPtr
    and LOCKED_FIELD_TEXT_PROBE.stringBuffer0Ptr == candidate.stringBuffer0Ptr
    and LOCKED_FIELD_TEXT_PROBE.textPrinterNum == candidate.textPrinterNum
    and LOCKED_FIELD_TEXT_PROBE.activeScriptNumber == candidate.activeScriptNumber
  if same_lock then
    LOCKED_FIELD_TEXT_PROBE.stableSamples = (LOCKED_FIELD_TEXT_PROBE.stableSamples or 0) + 1
    LOCKED_FIELD_TEXT_PROBE.preview = candidate.string and candidate.string.preview or LOCKED_FIELD_TEXT_PROBE.preview
    LOCKED_FIELD_TEXT_PROBE.printerPtr = candidate.printer and candidate.printer.printerPtr or LOCKED_FIELD_TEXT_PROBE.printerPtr
    LOCKED_FIELD_TEXT_PROBE.printer = candidate.printer or LOCKED_FIELD_TEXT_PROBE.printer
  else
    if LOCKED_FIELD_TEXT_PROBE then
      clear_recent_field_text_events("field_text_lock_changed")
    end
    LOCKED_FIELD_TEXT_PROBE = {
      fieldSystemPtr = candidate.fieldSystemPtr,
      taskmanPtr = candidate.taskmanPtr,
      envPtr = candidate.envPtr,
      stringBuffer0Ptr = candidate.stringBuffer0Ptr,
      textPrinterNum = candidate.textPrinterNum,
      activeScriptNumber = candidate.activeScriptNumber,
      printerPtr = candidate.printer and candidate.printer.printerPtr or nil,
      printer = candidate.printer,
      stableSamples = 1,
      preview = candidate.string and candidate.string.preview or "",
    }
  end
  return LOCKED_FIELD_TEXT_PROBE
end

function push_recent_field_text_event(text, lock)
  if not is_non_placeholder_visible_text(text) then return end
  if not lock or not lock.printer or lock.printer.contract ~= "owner_bound_script_environment_textprinter_current_visible_v1" then return end
  local current_frame = emu.framecount()
  if current_frame == nil then return end
  local key = tostring(text)
  local event_key = tostring(CURRENT_FIELD_TEXT_EPOCH) .. ":" .. key
  if event_key == LAST_FIELD_TEXT_EVENT_KEY and (current_frame - LAST_FIELD_TEXT_EVENT_FRAME) < 12 then return end
  LAST_FIELD_TEXT_EVENT_KEY = event_key
  LAST_FIELD_TEXT_EVENT_FRAME = current_frame
  RECENT_FIELD_TEXT_EVENTS[#RECENT_FIELD_TEXT_EVENTS + 1] = {
    active = true,
    surface = "field_dialogue",
    text = key,
    source = "ram_visible_text",
    confidence = "validated_current",
    contract = "current_visible_text_v1_recent_observed",
    decoderContract = "owner_bound_script_environment_textprinter_current_visible_v1",
    decoderSource = lock.printer.source or "owner_bound_print_queue_systask",
    contextEpoch = CURRENT_FIELD_TEXT_EPOCH,
    frame = current_frame,
    frameSource = "emu.framecount",
  }
  while #RECENT_FIELD_TEXT_EVENTS > RECENT_FIELD_TEXT_MAX do
    table.remove(RECENT_FIELD_TEXT_EVENTS, 1)
  end
end

function sample_locked_field_dialog_recent_text()
  local lock = LOCKED_FIELD_TEXT_PROBE
  if not lock or (lock.stableSamples or 0) < FIELD_TEXT_PROBE_LOCK_MIN_SAMPLES then return end
  set_field_text_instance(field_text_instance_id(lock))
  if not valid_arm9_ptr(lock.fieldSystemPtr) or not valid_arm9_ptr(lock.envPtr) or not valid_arm9_ptr(lock.printerPtr) then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_lock_invalid_pointer")
    return
  end
  if u32(lock.envPtr + 0x00) ~= SCRIPT_ENV_MAGIC then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_script_environment_invalid")
    return
  end
  local current_string_buffer_0 = u32(lock.envPtr + 0x48)
  if current_string_buffer_0 ~= lock.stringBuffer0Ptr then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_string_buffer_changed")
    return
  end
  local string_obj = read_hgss_string_object(lock.stringBuffer0Ptr)
  local string_valid = validate_field_dialog_candidate_string(string_obj)
  if not string_valid or not string_obj.words then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_string_invalid")
    return
  end
  local window_ptr = lock.envPtr + 0x14
  if u32(lock.printerPtr + 0x04) ~= window_ptr or u8(lock.printerPtr + 0x27) ~= 1 or u8(lock.printerPtr + 0x2C) ~= lock.textPrinterNum then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_printer_mismatch")
    return
  end
  local string_data_start = string_obj.ptr + 8
  local string_data_end = string_data_start + (string_obj.size * 2)
  local current_char_raw = u32(lock.printerPtr)
  if current_char_raw == nil or current_char_raw < string_data_start or current_char_raw > string_data_end + 2 then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_current_char_out_of_range")
    return
  end
  local consumed_words = math.floor((current_char_raw - string_data_start) / 2)
  if consumed_words < 0 then consumed_words = 0 end
  if consumed_words > string_obj.size then consumed_words = string_obj.size end
  local visible_words = copy_hgss_words_prefix(string_obj.words, consumed_words)
  local visible_preview = decode_hgss_words_preview(visible_words)
  push_recent_field_text_event(visible_preview, lock)
end

function next_field_text_printer_scan_addr()
  local addr = NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR
  NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR = NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR + 4
  if NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR >= FIELD_TEXT_PRINTER_SCAN_END then
    NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR = FIELD_TEXT_PRINTER_SCAN_START
  end
  return addr
end

function validate_print_queue_candidate(queue)
  if not valid_arm9_ptr(queue) then return false, "invalid_print_queue_pointer" end
  if u16(queue + 0x00) ~= 4 then return false, "print_queue_capacity_not_4" end
  local count = u16(queue + 0x02)
  if count == nil or count > 4 then return false, "print_queue_count_out_of_range" end
  if u32(queue + 0x04) ~= queue then return false, "print_queue_sentinel_prev_mismatch" end
  if u32(queue + 0x20) ~= queue + 0x34 then return false, "print_queue_free_list_start_mismatch" end
  if u32(queue + 0x24) ~= queue + 0x44 then return false, "print_queue_task_list_start_mismatch" end
  local first = u32(queue + 0x0C)
  if first ~= queue + 0x04 and not valid_arm9_ptr(first) then return false, "print_queue_first_task_invalid" end
  return true, "ok"
end

function next_print_queue_scan_addr()
  local addr = NEXT_PRINT_QUEUE_SCAN_ADDR
  NEXT_PRINT_QUEUE_SCAN_ADDR = NEXT_PRINT_QUEUE_SCAN_ADDR + 4
  if NEXT_PRINT_QUEUE_SCAN_ADDR >= PRINT_QUEUE_SCAN_END then
    NEXT_PRINT_QUEUE_SCAN_ADDR = PRINT_QUEUE_SCAN_START
  end
  return addr
end

function resolve_print_queue()
  if LOCKED_PRINT_QUEUE_PTR ~= nil then
    local ok = validate_print_queue_candidate(LOCKED_PRINT_QUEUE_PTR)
    if ok then return LOCKED_PRINT_QUEUE_PTR, "locked_print_queue" end
    LOCKED_PRINT_QUEUE_PTR = nil
  end
  local scanned = 0
  while scanned < PRINT_QUEUE_SCAN_BUDGET do
    local addr = next_print_queue_scan_addr()
    scanned = scanned + 4
    local ok = validate_print_queue_candidate(addr)
    if ok then
      LOCKED_PRINT_QUEUE_PTR = addr
      return addr, "print_queue_structural_scan"
    end
  end
  return nil, "print_queue_not_found"
end

function field_text_printer_from_addr(addr, env, text_printer_num, string_obj, source, task_ptr, task_priority, queue_ptr)
  if not valid_arm9_ptr(addr) or not valid_arm9_ptr(env) or not string_obj or not string_obj.words then
    return nil
  end
  local window_ptr = env + 0x14
  if u32(addr + 0x04) ~= window_ptr or u8(addr + 0x27) ~= 1 or u8(addr + 0x2C) ~= text_printer_num then
    return nil
  end
  local string_data_start = string_obj.ptr + 8
  local string_data_end = string_data_start + (string_obj.size * 2)
  local current_char_raw = u32(addr)
  if current_char_raw == nil or current_char_raw < string_data_start or current_char_raw > string_data_end + 2 then
    return nil
  end
  local consumed_words = math.floor((current_char_raw - string_data_start) / 2)
  if consumed_words < 0 then consumed_words = 0 end
  if consumed_words > string_obj.size then consumed_words = string_obj.size end
  local visible_words = copy_hgss_words_prefix(string_obj.words, consumed_words)
  local visible_preview = decode_hgss_words_preview(visible_words)
  return {
    printerPtr = addr,
    currentCharRaw = current_char_raw,
    consumedWords = consumed_words,
    visibleWords = visible_words,
    visiblePreview = visible_preview,
    windowPtr = window_ptr,
    source = source,
    contract = "owner_bound_script_environment_textprinter_current_visible_v1",
    taskPtr = task_ptr,
    taskPriority = task_priority,
    queuePtr = queue_ptr,
  }
end

function battle_text_printer_from_addr(addr, active_battle, string_obj, source, task_ptr, task_priority, queue_ptr)
  if not valid_arm9_ptr(addr) or not active_battle or not string_obj or not string_obj.words then
    return nil
  end
  if active_battle.validation ~= "battle_context_battle_mons_validated" then
    return nil
  end
  if active_battle.msgBufferPtr ~= string_obj.ptr then
    return nil
  end
  local window_array_ptr = u32(active_battle.battleSystemPtr + 0x08)
  if not valid_arm9_ptr(window_array_ptr) then
    return nil
  end
  local current_char_raw = u32(addr)
  local window_ptr = u32(addr + 0x04)
  local font_id = u8(addr + 0x09)
  local active = u8(addr + 0x27)
  local state = u8(addr + 0x28)
  local id = u8(addr + 0x2C)
  local window_index = -1
  if window_ptr == window_array_ptr then
    window_index = 0
  elseif window_ptr == window_array_ptr + 0x10 then
    window_index = 1
  end
  if window_index < 0 or active ~= 1 or id == nil or id >= MAX_TEXT_PRINTERS then
    return nil
  end
  if font_id ~= 0 and font_id ~= 1 then
    return nil
  end
  local string_data_start = string_obj.ptr + 8
  local string_data_end = string_data_start + (string_obj.size * 2)
  if current_char_raw == nil or current_char_raw < string_data_start or current_char_raw > string_data_end + 2 then
    return nil
  end
  local consumed_words = math.floor((current_char_raw - string_data_start) / 2)
  if consumed_words < 0 then consumed_words = 0 end
  if consumed_words > string_obj.size then consumed_words = string_obj.size end
  local visible_words = copy_hgss_words_prefix(string_obj.words, consumed_words)
  local visible_preview = decode_hgss_words_preview(visible_words)
  return {
    printerPtr = addr,
    currentCharRaw = current_char_raw,
    consumedWords = consumed_words,
    visibleWords = visible_words,
    visiblePreview = visible_preview,
    windowPtr = window_ptr,
    windowIndex = window_index,
    fontId = font_id,
    state = state,
    id = id,
    source = source,
    contract = "owner_bound_battle_msgbuffer_textprinter_current_v1",
    visibilityContract = consumed_words >= string_obj.size and "owner_bound_battle_textprinter_complete_v1" or nil,
    taskPtr = task_ptr,
    taskPriority = task_priority,
    queuePtr = queue_ptr,
  }
end

function resolve_owner_bound_battle_text_printer(active_battle)
  if not active_battle or active_battle.validation ~= "battle_context_battle_mons_validated" then
    return nil, "active_battle_validation_required"
  end
  local string_obj = active_battle.msgBufferString
  local valid_string = validate_battle_text_candidate_string(string_obj)
  if not valid_string or not string_obj or not string_obj.words then
    return nil, "battle_msgbuffer_string_invalid"
  end
  if active_battle.msgBufferPtr ~= string_obj.ptr then
    return nil, "battle_msgbuffer_pointer_mismatch"
  end
  if u32(active_battle.battleSystemPtr + 0x18) ~= active_battle.msgBufferPtr then
    return nil, "battle_system_msgbuffer_backref_mismatch"
  end
  if u32(active_battle.battleSystemPtr + 0x30) ~= active_battle.ctxPtr then
    return nil, "battle_system_context_backref_mismatch"
  end
  local queue, queue_reason = resolve_print_queue()
  if not valid_arm9_ptr(queue) then
    return nil, queue_reason or "print_queue_not_found"
  end
  local sentinel = queue + 0x04
  local task = u32(queue + 0x0C)
  local matches = {}
  local seen = 0
  while valid_arm9_ptr(task) and task ~= sentinel and seen < 8 do
    seen = seen + 1
    if u32(task + 0x00) == queue then
      local printer_ptr = u32(task + 0x10)
      local candidate = battle_text_printer_from_addr(printer_ptr, active_battle, string_obj, "owner_bound_battle_print_queue_systask", task, u32(task + 0x0C), queue)
      if candidate then matches[#matches + 1] = candidate end
    end
    local next_task = u32(task + 0x08)
    if next_task == task then break end
    task = next_task
  end
  if #matches == 1 then return matches[1], "ok" end
  if #matches > 1 then return nil, "multiple_owner_bound_battle_text_printers" end
  return nil, "owner_bound_battle_text_printer_not_found"
end

function resolve_owner_bound_field_text_printer(env, text_printer_num, string_obj)
  if not valid_arm9_ptr(env) or not string_obj or not string_obj.words then
    return nil, "invalid_owner_bound_inputs"
  end
  local queue, queue_reason = resolve_print_queue()
  if not valid_arm9_ptr(queue) then
    return nil, queue_reason or "print_queue_missing"
  end
  local sentinel = queue + 0x04
  local task = u32(queue + 0x0C)
  local matches = {}
  local seen = 0
  while valid_arm9_ptr(task) and task ~= sentinel and seen < 8 do
    seen = seen + 1
    if u32(task + 0x00) == queue then
      local printer_ptr = u32(task + 0x10)
      local candidate = field_text_printer_from_addr(printer_ptr, env, text_printer_num, string_obj, "owner_bound_print_queue_systask", task, u32(task + 0x0C), queue)
      if candidate then matches[#matches + 1] = candidate end
    end
    local next_task = u32(task + 0x08)
    if next_task == task then break end
    task = next_task
  end
  if #matches == 1 then return matches[1], "ok" end
  if #matches > 1 then return nil, "multiple_owner_bound_text_printers" end
  return nil, "owner_bound_text_printer_not_found"
end

function scan_field_text_printer_candidate(env, text_printer_num, string_obj)
  if not valid_arm9_ptr(env) or not string_obj or not string_obj.words then
    return nil, "invalid_scan_inputs"
  end
  if text_printer_num < 0 or text_printer_num >= MAX_TEXT_PRINTERS then
    return nil, "text_printer_num_out_of_range"
  end
  local owner_bound, owner_reason = resolve_owner_bound_field_text_printer(env, text_printer_num, string_obj)
  if owner_bound then
    return owner_bound, "ok"
  end
  return nil, owner_reason or "owner_bound_field_text_printer_required"
end

function next_generic_text_printer_scan_addr()
  local addr = NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR
  NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR = NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR + 4
  if NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR >= GENERIC_TEXT_PRINTER_SCAN_END then
    NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR = GENERIC_TEXT_PRINTER_SCAN_START
  end
  return addr
end

function text_printer_candidate_from_addr(addr, source)
  if not valid_arm9_ptr(addr) then return nil end
  local current_char_raw = u32(addr)
  local window_ptr = u32(addr + 0x04)
  local font_id = u8(addr + 0x09)
  local active = u8(addr + 0x27)
  local state = u8(addr + 0x28)
  local id = u8(addr + 0x2C)
  if active ~= 1 or id == nil or id >= MAX_TEXT_PRINTERS then return nil end
  if not valid_arm9_ptr(current_char_raw) or not valid_arm9_ptr(window_ptr) then return nil end
  if font_id == nil or font_id > 7 then return nil end

  local string_obj, string_reason = infer_string_from_current_char(current_char_raw)
  local string_valid, validate_reason = validate_generic_text_printer_string(string_obj)
  if not string_valid or not string_obj then
    return nil, string_reason or validate_reason or "invalid_text_printer_string"
  end
  local string_data_start = string_obj.ptr + 8
  local consumed_words = math.floor((current_char_raw - string_data_start) / 2)
  if consumed_words < 0 then consumed_words = 0 end
  if consumed_words > string_obj.size then consumed_words = string_obj.size end
  local visible_words = copy_hgss_words_prefix(string_obj.words, consumed_words)
  local visible_preview = decode_hgss_words_preview(visible_words)
  local full_preview = string_obj.preview or ""
  local best_preview = visible_preview
  if best_preview == nil or best_preview == "" then best_preview = full_preview end
  if not is_non_placeholder_visible_text(best_preview) then return nil, "empty_or_placeholder_text" end
  return {
    active = true,
    source = source or "generic_text_printer_scan",
    contract = "ram_text_printer_current_visible",
    printerPtr = addr,
    currentCharRaw = current_char_raw,
    windowPtr = window_ptr,
    fontId = font_id,
    state = state,
    id = id,
    string = string_obj,
    consumedWords = consumed_words,
    visiblePreview = best_preview,
    fullPreview = full_preview,
  }, "ok"
end

function push_recent_generic_text_event(candidate)
  if not candidate or not is_non_placeholder_visible_text(candidate.visiblePreview) then return end
  local frame = emu.framecount()
  local key = tostring(candidate.printerPtr) .. ":" .. tostring(candidate.currentCharRaw) .. ":" .. tostring(candidate.visiblePreview)
  if key == LAST_GENERIC_TEXT_EVENT_KEY and frame - LAST_GENERIC_TEXT_EVENT_FRAME < 8 then return end
  LAST_GENERIC_TEXT_EVENT_KEY = key
  LAST_GENERIC_TEXT_EVENT_FRAME = frame
  RECENT_GENERIC_TEXT_EVENTS[#RECENT_GENERIC_TEXT_EVENTS + 1] = {
    active = false,
    text = candidate.visiblePreview,
    surface = "generic_text",
    source = "ram_text_probe_monitor_only",
    confidence = "candidate",
    contract = "monitor_only_monitor_surface_until_owner_bound",
    decoderSource = candidate.source,
    frame = frame,
    contextEpoch = frame,
    printerPtr = candidate.printerPtr,
    currentCharRaw = candidate.currentCharRaw,
  }
  while #RECENT_GENERIC_TEXT_EVENTS > RECENT_GENERIC_TEXT_MAX do
    table.remove(RECENT_GENERIC_TEXT_EVENTS, 1)
  end
end

function decode_generic_text_printers()
  local candidates = {}
  local locked = {}
  for ptr_key, _ in pairs(LOCKED_GENERIC_TEXT_PRINTERS) do
    local addr = tonumber(ptr_key)
    local candidate = text_printer_candidate_from_addr(addr, "locked_generic_text_printer")
    if candidate then
      locked[tostring(addr)] = true
      candidates[#candidates + 1] = candidate
      push_recent_generic_text_event(candidate)
    end
  end

  local scanned = 0
  local scan_start = NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR
  while scanned < GENERIC_TEXT_PRINTER_SCAN_BUDGET and #candidates < MAX_TEXT_PRINTERS do
    local addr = next_generic_text_printer_scan_addr()
    scanned = scanned + 4
    if not locked[tostring(addr)] then
      local candidate = text_printer_candidate_from_addr(addr, "generic_text_printer_scan")
      if candidate then
        LOCKED_GENERIC_TEXT_PRINTERS[tostring(addr)] = true
        candidates[#candidates + 1] = candidate
        push_recent_generic_text_event(candidate)
      end
    end
  end

  return {
    active = #candidates > 0,
    source = "generic_text_printer_scan",
    contract = "ram_text_printer_current_visible",
    candidates = candidates,
    count = #candidates,
    scanned = scanned,
    scanStart = scan_start,
    nextScanStart = NEXT_GENERIC_TEXT_PRINTER_SCAN_ADDR,
    scanBudget = GENERIC_TEXT_PRINTER_SCAN_BUDGET,
  }
end

function oak_speech_next_scan_addr()
  local addr = NEXT_OAK_SPEECH_DATA_SCAN_ADDR
  NEXT_OAK_SPEECH_DATA_SCAN_ADDR = NEXT_OAK_SPEECH_DATA_SCAN_ADDR + 4
  if NEXT_OAK_SPEECH_DATA_SCAN_ADDR >= OAK_SPEECH_DATA_SCAN_END then
    NEXT_OAK_SPEECH_DATA_SCAN_ADDR = OAK_SPEECH_DATA_SCAN_START
  end
  return addr
end

function scan_oak_speech_data_range(scan_start, scan_end, scan_budget)
  local scanned = 0
  local addr = scan_start
  while scanned < scan_budget and addr < scan_end do
    local candidate = validate_oak_speech_data(addr)
    scanned = scanned + 4
    if candidate then
      candidate.scanStart = scan_start
      candidate.scanned = scanned
      return candidate, scanned
    end
    addr = addr + 4
  end
  return nil, scanned
end

function oak_speech_surface_state_known(state)
  if OAK_SPEECH_STATE_MESSAGE_IDS[state] ~= nil then return true end
  if state == 2 or state == 3 or state == 4 then return true end
  if state == 23 or state == 24 then return true end
  if state == 46 or state == 67 or state == 97 then return true end
  if state == 68 or state == 69 or state == 98 then return true end
  return false
end

function oak_speech_candidate_evidence(addr)
  if not valid_arm9_ptr(addr) then return nil end
  local heap_id = u32(addr + 0x00)
  if heap_id ~= HEAP_ID_OAKS_SPEECH then return nil end
  local save_data = u32(addr + 0x04)
  local options = u32(addr + 0x08)
  local state = u32(addr + 0x0C)
  if state == nil or state < 0 or state > 126 then return nil end
  if not oak_speech_surface_state_known(state) then return nil end
  local bg_config = u32(addr + 0x18)
  local msg_data = u32(addr + 0x100)
  local msg_format = u32(addr + 0x118)
  if not valid_arm9_ptr(save_data) or not valid_arm9_ptr(options) or not valid_arm9_ptr(bg_config) or not valid_arm9_ptr(msg_data) or not valid_arm9_ptr(msg_format) then return nil end
  if u32(bg_config + 0x00) ~= HEAP_ID_OAKS_SPEECH then return nil end
  local full_window_backref = u32(addr + 0x1C) == bg_config
  local dialog_window_backref = u32(addr + 0x2C) == bg_config
  local num_options = u32(addr + 0x7C) or 0
  local num_options_valid = num_options >= 0 and num_options <= 3
  local menu_options = u8(addr + 0x161) or 0
  local cursor_pos = u8(addr + 0x163) or 0
  local menu_valid = menu_options <= 3 and cursor_pos <= 3
  if not menu_valid then
    menu_options = 0
    cursor_pos = 0
  end
  local evidence_count = 0
  if full_window_backref then evidence_count = evidence_count + 1 end
  if dialog_window_backref then evidence_count = evidence_count + 1 end
  if num_options_valid then evidence_count = evidence_count + 1 end
  if menu_valid then evidence_count = evidence_count + 1 end
  -- pret/pokeheartgold gives OakSpeechData, BgConfig, MsgData, and MessageFormat as
  -- owner-bound app state. Window backrefs are sampled as evidence because intro
  -- full-screen text and menu states do not always keep both windows initialized.
  if evidence_count < 2 then return nil end
  return {
    active = true,
    source = "OakSpeechData.current_overlay_app_state",
    contract = "owner_bound_current_ui_state_visible_text_v1",
    app = "oak_speech",
    validation = "oak_speech_appdata_state_msgdata_bgconfig_validated",
    windowBackrefsValid = full_window_backref or dialog_window_backref,
    fullWindowBackrefValid = full_window_backref,
    dialogWindowBackrefValid = dialog_window_backref,
    appDataPtr = addr,
    state = state,
    msgDataPtr = msg_data,
    msgFormatPtr = msg_format,
    messageBank = OAK_SPEECH_MSG_BANK,
    messageId = OAK_SPEECH_STATE_MESSAGE_IDS[state],
    queuedMsgId = u32(addr + 0x170),
    menu = {
      numOptions = menu_options,
      cursorPos = cursor_pos,
      numMultichoiceOptions = num_options,
    },
    frame = emu.framecount(),
    contextEpoch = emu.framecount(),
  }
end

function validate_oak_speech_data(addr)
  return oak_speech_candidate_evidence(addr)
end

function find_oak_speech_data()
  if LOCKED_OAK_SPEECH_DATA ~= nil then
    local locked = validate_oak_speech_data(LOCKED_OAK_SPEECH_DATA)
    if locked then return locked, "locked" end
    LOCKED_OAK_SPEECH_DATA = nil
  end
  local priority_candidate, priority_scanned = scan_oak_speech_data_range(OAK_SPEECH_PRIORITY_SCAN_START, OAK_SPEECH_PRIORITY_SCAN_END, OAK_SPEECH_PRIORITY_SCAN_BUDGET)
  if priority_candidate then
    LOCKED_OAK_SPEECH_DATA = priority_candidate.appDataPtr
    priority_candidate.scanSource = "oak_speech_priority_overlay_heap"
    return priority_candidate, "priority_overlay_heap"
  end
  local scanned = 0
  local scan_start = NEXT_OAK_SPEECH_DATA_SCAN_ADDR
  while scanned < OAK_SPEECH_DATA_SCAN_BUDGET do
    local addr = oak_speech_next_scan_addr()
    scanned = scanned + 4
    local candidate = validate_oak_speech_data(addr)
    if candidate then
      LOCKED_OAK_SPEECH_DATA = addr
      candidate.scanStart = scan_start
      candidate.scanned = scanned
      candidate.scanSource = "oak_speech_broad_rolling_scan"
      return candidate, "scanned"
    end
  end
  return {
    active = false,
    source = "OakSpeechData.current_overlay_app_state",
    contract = "owner_bound_current_ui_state_visible_text_v1",
    reason = "oak_speech_appdata_not_found",
    priorityScanStart = OAK_SPEECH_PRIORITY_SCAN_START,
    priorityScanEnd = OAK_SPEECH_PRIORITY_SCAN_END,
    priorityScanned = priority_scanned,
    priorityScanBudget = OAK_SPEECH_PRIORITY_SCAN_BUDGET,
    scanStart = scan_start,
    nextScanStart = NEXT_OAK_SPEECH_DATA_SCAN_ADDR,
    scanBudget = OAK_SPEECH_DATA_SCAN_BUDGET,
  }, "not_found"
end

function oak_speech_current_ui_surface()
  local data, reason = find_oak_speech_data()
  if not data or data.active ~= true then return data end
  local state = data.state or -1
  local message_ids = {}
  if data.messageId ~= nil then message_ids[#message_ids + 1] = data.messageId end
  if (state == 46 or state == 67 or state == 97) and data.queuedMsgId ~= nil and data.queuedMsgId >= 0 and data.queuedMsgId < 256 then
    message_ids[#message_ids + 1] = data.queuedMsgId
  end
  local option_ids = {}
  if state == 2 or state == 3 or state == 4 then
    option_ids = {44, 45, 46}
  elseif state == 23 or state == 24 then
    option_ids = {61, 62}
  elseif state == 68 or state == 69 or state == 97 or state == 98 then
    option_ids = {47, 48}
  end
  return {
    active = (#message_ids > 0 or #option_ids > 0),
    source = data.source,
    contract = data.contract,
    app = data.app,
    surface = "current_ui",
    messageBank = data.messageBank,
    messageIds = message_ids,
    optionMessageIds = option_ids,
    selectedIndex = data.menu and data.menu.cursorPos or nil,
    optionCount = data.menu and data.menu.numOptions or nil,
    frame = data.frame,
    contextEpoch = data.contextEpoch,
    scanReason = reason,
    scanSource = data.scanSource,
  }
end

function choose_starter_next_scan_addr()
  local addr = NEXT_CHOOSE_STARTER_APP_SCAN_ADDR
  NEXT_CHOOSE_STARTER_APP_SCAN_ADDR = NEXT_CHOOSE_STARTER_APP_SCAN_ADDR + 4
  if NEXT_CHOOSE_STARTER_APP_SCAN_ADDR >= CHOOSE_STARTER_APP_SCAN_END then
    NEXT_CHOOSE_STARTER_APP_SCAN_ADDR = CHOOSE_STARTER_APP_SCAN_START
  end
  return addr
end

function choose_starter_message_ids(selection_state, cur_selection)
  if selection_state == CHOOSE_STARTER_SELECTION_STATE_CONFIRM then
    return { 1 + cur_selection, 8 }
  end
  if selection_state == CHOOSE_STARTER_SELECTION_STATE_INSPECT then
    return { 4 + cur_selection, 7 }
  end
  return { 0, 7 }
end

function choose_starter_candidate_evidence(addr)
  if not valid_arm9_ptr(addr) or addr + CHOOSE_STARTER_WORK_SIZE >= CHOOSE_STARTER_APP_SCAN_END then return nil end
  local heap_id = u32(addr + CHOOSE_STARTER_WORK_OFFSET_HEAP_ID)
  if heap_id ~= HEAP_ID_CHOOSE_STARTER then return nil end

  local bg_config = u32(addr + CHOOSE_STARTER_WORK_OFFSET_BG_CONFIG)
  local win_top = u32(addr + CHOOSE_STARTER_WORK_OFFSET_WIN_TOP)
  local win_bottom = u32(addr + CHOOSE_STARTER_WORK_OFFSET_WIN_BOTTOM)
  if not valid_arm9_ptr(bg_config) or not valid_arm9_ptr(win_top) or not valid_arm9_ptr(win_bottom) then return nil end

  local cur_selection = u32(addr + CHOOSE_STARTER_WORK_OFFSET_CUR_SELECTION)
  local selection_state = u32(addr + CHOOSE_STARTER_WORK_OFFSET_SELECTION_STATE)
  if cur_selection == nil or cur_selection < 0 or cur_selection > 2 then return nil end
  if selection_state == nil or selection_state < 0 or selection_state > 2 then return nil end

  local starter_species_ids = {}
  for i = 0, 2 do
    local mon_ptr = u32(addr + CHOOSE_STARTER_WORK_OFFSET_CHOICES + i * 4)
    if not valid_arm9_ptr(mon_ptr) then return nil end
    local mon = decrypt_party_mon(mon_ptr)
    if mon == nil or mon.species_id ~= CHOOSE_STARTER_SPECIES_IDS[i + 1] then return nil end
    starter_species_ids[#starter_species_ids + 1] = mon.species_id
  end

  return {
    active = true,
    source = "ChooseStarterAppWork.current_overlay_app_state",
    contract = "owner_bound_current_ui_state_visible_text_v1",
    app = "choose_starter",
    validation = "choose_starter_appwork_state_windows_msgdata_validated",
    appDataPtr = addr,
    bgConfigPtr = bg_config,
    winTopPtr = win_top,
    winBottomPtr = win_bottom,
    selectedIndex = cur_selection,
    curSelection = cur_selection,
    state = selection_state,
    selectionState = selection_state,
    messageBank = CHOOSE_STARTER_MSG_BANK,
    messageIds = choose_starter_message_ids(selection_state, cur_selection),
    optionMessageIds = {},
    starterSpeciesIds = starter_species_ids,
    frame = emu.framecount(),
    contextEpoch = emu.framecount(),
  }
end

function validate_choose_starter_appwork(addr)
  return choose_starter_candidate_evidence(addr)
end

function find_choose_starter_appwork()
  if LOCKED_CHOOSE_STARTER_APPWORK ~= nil then
    local locked = validate_choose_starter_appwork(LOCKED_CHOOSE_STARTER_APPWORK)
    if locked then return locked, "locked" end
    LOCKED_CHOOSE_STARTER_APPWORK = nil
  end
  local scanned = 0
  local scan_start = NEXT_CHOOSE_STARTER_APP_SCAN_ADDR
  while scanned < CHOOSE_STARTER_APP_SCAN_BUDGET do
    local addr = choose_starter_next_scan_addr()
    scanned = scanned + 4
    local candidate = validate_choose_starter_appwork(addr)
    if candidate then
      LOCKED_CHOOSE_STARTER_APPWORK = addr
      candidate.scanStart = scan_start
      candidate.scanned = scanned
      return candidate, "scanned"
    end
  end
  return {
    active = false,
    source = "ChooseStarterAppWork.current_overlay_app_state",
    contract = "owner_bound_current_ui_state_visible_text_v1",
    reason = "choose_starter_appwork_not_found",
    scanStart = scan_start,
    nextScanStart = NEXT_CHOOSE_STARTER_APP_SCAN_ADDR,
    scanBudget = CHOOSE_STARTER_APP_SCAN_BUDGET,
  }, "not_found"
end

function choose_starter_current_ui_surface()
  local data, reason = find_choose_starter_appwork()
  if not data or data.active ~= true then return data end
  return {
    active = true,
    source = data.source,
    contract = data.contract,
    app = data.app,
    validation = data.validation,
    surface = "current_ui",
    messageBank = CHOOSE_STARTER_MSG_BANK,
    messageIds = data.messageIds,
    optionMessageIds = data.optionMessageIds,
    selectedIndex = data.selectedIndex,
    selectionState = data.selectionState,
    starterSpeciesIds = data.starterSpeciesIds,
    frame = data.frame,
    contextEpoch = data.contextEpoch,
    scanReason = reason,
  }
end

function decode_current_ui_state()
  local oak = oak_speech_current_ui_surface()
  if oak and oak.active == true then return oak end
  local starter = choose_starter_current_ui_surface()
  if starter and starter.active == true then return starter end
  return {
    active = false,
    source = "current_overlay_app_state",
    contract = "owner_bound_current_ui_state_visible_text_v1",
    reason = (starter and starter.reason) or (oak and oak.reason) or "current_ui_not_found",
  }
end

function probe_field_dialog_text_candidate(field_system)
  if not valid_arm9_ptr(field_system) then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_no_valid_field_system")
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = "no_valid_field_system",
    }
  end

  -- pret/pokeheartgold FieldSystem.taskman is at +0x10.
  local taskman = u32(field_system + 0x10)
  if not valid_arm9_ptr(taskman) then
    LOCKED_FIELD_TEXT_PROBE = nil
    clear_recent_field_text_events("field_text_no_active_taskman")
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = "no_active_field_taskman",
      fieldSystemPtr = field_system,
    }
  end

  -- TaskManager layout: env +0x0C, fieldSystem backlink +0x18.
  local task_field_system = u32(taskman + 0x18)
  if task_field_system ~= field_system then
    LOCKED_FIELD_TEXT_PROBE = nil
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = "taskman_field_system_backlink_mismatch",
      fieldSystemPtr = field_system,
      taskmanPtr = taskman,
      taskFieldSystemPtr = task_field_system,
    }
  end

  local env = u32(taskman + 0x0C)
  if not valid_arm9_ptr(env) then
    LOCKED_FIELD_TEXT_PROBE = nil
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = "no_script_environment",
      fieldSystemPtr = field_system,
      taskmanPtr = taskman,
    }
  end

  local env_check = u32(env + 0x00)
  if env_check ~= SCRIPT_ENV_MAGIC then
    LOCKED_FIELD_TEXT_PROBE = nil
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = "task_environment_is_not_script_environment",
      fieldSystemPtr = field_system,
      taskmanPtr = taskman,
      envPtr = env,
      envCheck = env_check,
    }
  end
  local menu_probe = script_list_menu_2d_candidate(env)

  -- ScriptEnvironment offsets from pret/pokeheartgold include/script.h:
  -- +0x44 msgfmt, +0x48 stringBuffer0 (expanded current field text),
  -- +0x4C stringBuffer1 (raw template buffer).
  local text_printer_num = u8(env + 0x05)
  local active_script_context_count = u8(env + 0x09)
  local active_script_number = u16(env + 0x0A)
  local msg_format_ptr = u32(env + 0x44)
  local string_buffer_0 = u32(env + 0x48)
  local stringBuffer0 = string_buffer_0
  local string_buffer_1 = u32(env + 0x4C)
  local string_obj, string_reason = read_hgss_string_object(string_buffer_0)
  local string_valid, validate_reason = validate_field_dialog_candidate_string(string_obj)

  -- pret/pokeheartgold defines MAX_TEXT_PRINTERS = 8 in text.h/text.c.
  local invalid_text_printer_num = text_printer_num == nil or text_printer_num >= MAX_TEXT_PRINTERS
  local no_active_script_context = active_script_context_count == nil or active_script_context_count <= 0
  if not string_valid or invalid_text_printer_num or no_active_script_context then
    LOCKED_FIELD_TEXT_PROBE = nil
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = validate_reason or string_reason or (invalid_text_printer_num and "text_printer_num_out_of_range") or (no_active_script_context and "no_active_script_context") or "invalid_stringBuffer0",
      fieldSystemPtr = field_system,
      taskmanPtr = taskman,
      envPtr = env,
      msgFormatPtr = msg_format_ptr,
      stringBuffer0Ptr = stringBuffer0,
      stringBuffer1Ptr = string_buffer_1,
      textPrinterNum = text_printer_num,
      activeScriptContextCount = active_script_context_count,
      activeScriptNumber = active_script_number,
      menu = menu_probe,
    }
  end

  local printer, printer_reason = scan_field_text_printer_candidate(env, text_printer_num, string_obj)
  if not printer or not printer.visiblePreview or printer.visiblePreview == "" then
    LOCKED_FIELD_TEXT_PROBE = nil
    return {
      active = false,
      source = "ram_text_probe_monitor_only",
      reason = printer_reason or "field_text_printer_visible_prefix_missing",
      fieldSystemPtr = field_system,
      taskmanPtr = taskman,
      envPtr = env,
      msgFormatPtr = msg_format_ptr,
      stringBuffer0Ptr = stringBuffer0,
      stringBuffer1Ptr = string_buffer_1,
      textPrinterNum = text_printer_num,
      activeScriptContextCount = active_script_context_count,
      activeScriptNumber = active_script_number,
      string = string_obj,
      menu = menu_probe,
      printerScanBudget = FIELD_TEXT_PRINTER_SCAN_BUDGET,
      nextPrinterScanStart = NEXT_FIELD_TEXT_PRINTER_SCAN_ADDR,
    }
  end

  local candidate = {
    fieldSystemPtr = field_system,
    taskmanPtr = taskman,
    envPtr = env,
    msgFormatPtr = msg_format_ptr,
    stringBuffer0Ptr = stringBuffer0,
    stringBuffer1Ptr = string_buffer_1,
    textPrinterNum = text_printer_num,
    activeScriptContextCount = active_script_context_count,
    activeScriptNumber = active_script_number,
    string = string_obj,
    printer = printer,
  }
  local lock = update_field_text_probe_lock(candidate)
  local stable_samples = lock and lock.stableSamples or 1

  return {
    active = true,
    status = stable_samples >= FIELD_TEXT_PROBE_LOCK_MIN_SAMPLES and "locked" or "candidate",
    source = "ram_text_probe_monitor_only",
    contract = printer.contract or "candidate_script_environment_stringBuffer0_current_visible_gate_required",
    fieldSystemPtr = field_system,
    taskmanPtr = taskman,
    envPtr = env,
    msgFormatPtr = msg_format_ptr,
    stringBuffer0Ptr = stringBuffer0,
    stringBuffer1Ptr = string_buffer_1,
    textPrinterNum = text_printer_num,
    activeScriptContextCount = active_script_context_count,
    activeScriptNumber = active_script_number,
    stableSamples = stable_samples,
    lockMinSamples = FIELD_TEXT_PROBE_LOCK_MIN_SAMPLES,
    contextEpoch = CURRENT_FIELD_TEXT_EPOCH,
    string = string_obj,
    printer = printer,
    menu = menu_probe,
    visiblePreview = printer.visiblePreview,
  }
end

function hgss_pointer_profile(language)
  local profiles = {
    [0x44] = { language = "GER", pid_pointer_addr = 0x0211184C, trainer_ids_pointer_addr = 0x021D2208, korean_offset = 0, japan_offset = 0 },
    [0x45] = { language = "EUR/USA", pid_pointer_addr = 0x0211186C, trainer_ids_pointer_addr = 0x021D2228, korean_offset = 0, japan_offset = 0 },
    [0x46] = { language = "FRE", pid_pointer_addr = 0x0211188C, trainer_ids_pointer_addr = 0x021D2248, korean_offset = 0, japan_offset = 0 },
    [0x49] = { language = "ITA", pid_pointer_addr = 0x0211180C, trainer_ids_pointer_addr = 0x021D21C8, korean_offset = 0, japan_offset = 0 },
    [0x4A] = { language = "JPN", pid_pointer_addr = 0x02110DAC, trainer_ids_pointer_addr = 0x021D1768, korean_offset = 0, japan_offset = 0x4 },
    [0x4B] = { language = "KOR", pid_pointer_addr = 0x0211226C, trainer_ids_pointer_addr = 0x021D2C28, korean_offset = 0x44, japan_offset = 0 },
    [0x53] = { language = "SPA", pid_pointer_addr = 0x0211188C, trainer_ids_pointer_addr = 0x021D2248, korean_offset = 0, japan_offset = 0 },
  }
  return profiles[language] or { language = "EUR/USA default", pid_pointer_addr = 0x0211186C, trainer_ids_pointer_addr = 0x021D2228, korean_offset = 0, japan_offset = 0 }
end

function signed32(value)
  if value == nil then return nil end
  if value >= 0x80000000 then return value - 0x100000000 end
  return value
end

local block_orders = {
  {0, 1, 2, 3}, {0, 1, 3, 2}, {0, 2, 1, 3}, {0, 3, 1, 2},
  {0, 2, 3, 1}, {0, 3, 2, 1}, {1, 0, 2, 3}, {1, 0, 3, 2},
  {2, 0, 1, 3}, {3, 0, 1, 2}, {2, 0, 3, 1}, {3, 0, 2, 1},
  {1, 2, 0, 3}, {1, 3, 0, 2}, {2, 1, 0, 3}, {3, 1, 0, 2},
  {2, 3, 0, 1}, {3, 2, 0, 1}, {1, 2, 3, 0}, {1, 3, 2, 0},
  {2, 1, 3, 0}, {3, 1, 2, 0}, {2, 3, 1, 0}, {3, 2, 1, 0},
}

function word_from_bytes(bytes, index)
  local lo = bytes[index] or 0
  local hi = bytes[index + 1] or 0
  return lo + hi * 256
end

function u32_from_bytes(bytes, index)
  local lo = word_from_bytes(bytes, index)
  local hi = word_from_bytes(bytes, index + 2)
  if lo == nil or hi == nil then return nil end
  return lo + hi * 0x10000
end

HGSS_CHARCODE_DIGIT_START = 289
HGSS_CHARCODE_UPPER_START = 299
HGSS_CHARCODE_LOWER_START = 325
HGSS_CHARCODE_JP_DIGIT_START = 162
HGSS_CHARCODE_JP_UPPER_START = 172
HGSS_CHARCODE_JP_LOWER_START = 198
HGSS_CHARCODE_EOS = 0xFFFF
local hgss_charcode_symbols = {
  [427] = "!",
  [428] = "?",
  [429] = ",",
  [430] = ".",
  [431] = "...",
  [433] = "/",
  [434] = "'",
  [435] = "'",
  [436] = '"',
  [437] = '"',
  [441] = "(",
  [442] = ")",
  [445] = "+",
  [446] = "-",
  [447] = "*",
  [448] = "#",
  [449] = "=",
  [450] = "&",
  [452] = ":",
  [453] = ";",
  [464] = "@",
  [466] = "%",
  [478] = " ",
}

function hgss_charcode_to_ascii(value)
  if value >= HGSS_CHARCODE_DIGIT_START and value <= HGSS_CHARCODE_DIGIT_START + 9 then
    return string.char(string.byte("0") + value - HGSS_CHARCODE_DIGIT_START)
  end
  if value >= HGSS_CHARCODE_UPPER_START and value <= HGSS_CHARCODE_UPPER_START + 25 then
    return string.char(string.byte("A") + value - HGSS_CHARCODE_UPPER_START)
  end
  if value >= HGSS_CHARCODE_LOWER_START and value <= HGSS_CHARCODE_LOWER_START + 25 then
    return string.char(string.byte("a") + value - HGSS_CHARCODE_LOWER_START)
  end
  if value >= HGSS_CHARCODE_JP_DIGIT_START and value <= HGSS_CHARCODE_JP_DIGIT_START + 9 then
    return string.char(string.byte("0") + value - HGSS_CHARCODE_JP_DIGIT_START)
  end
  if value >= HGSS_CHARCODE_JP_UPPER_START and value <= HGSS_CHARCODE_JP_UPPER_START + 25 then
    return string.char(string.byte("A") + value - HGSS_CHARCODE_JP_UPPER_START)
  end
  if value >= HGSS_CHARCODE_JP_LOWER_START and value <= HGSS_CHARCODE_JP_LOWER_START + 25 then
    return string.char(string.byte("a") + value - HGSS_CHARCODE_JP_LOWER_START)
  end
  return hgss_charcode_symbols[value]
end

function decode_hgss_charcode_text(bytes, index, max_chars)
  if bytes == nil or index == nil then return nil end
  local chars = {}
  for i = 0, max_chars - 1 do
    local value = word_from_bytes(bytes, index + i * 2)
    if value == nil or value == HGSS_CHARCODE_EOS or value == 0x0000 then break end
    local decoded = hgss_charcode_to_ascii(value)
    if decoded == nil then
      return nil
    end
    chars[#chars + 1] = decoded
  end
  if #chars == 0 then return nil end
  return table.concat(chars)
end

function decode_hgss_charcode_words_at(addr, max_chars)
  local chars = {}
  local raw = {}
  if not valid_arm9_ptr(addr) then return nil, raw, "invalid_addr" end
  for i = 0, max_chars - 1 do
    local value = u16(addr + i * 2)
    if value == nil then return nil, raw, "read_failed" end
    raw[#raw + 1] = value
    if value == HGSS_CHARCODE_EOS or value == 0x0000 then break end
    local decoded = hgss_charcode_to_ascii(value)
    if decoded == nil then return nil, raw, "undecodable_charcode" end
    chars[#chars + 1] = decoded
  end
  return table.concat(chars), raw, "ok"
end

function naming_keyboard_code_class(value)
  if value == nil then return nil end
  if value >= HGSS_CHARCODE_DIGIT_START and value <= HGSS_CHARCODE_DIGIT_START + 9 then return "digits" end
  if value >= HGSS_CHARCODE_UPPER_START and value <= HGSS_CHARCODE_UPPER_START + 25 then return "upper" end
  if value >= HGSS_CHARCODE_LOWER_START and value <= HGSS_CHARCODE_LOWER_START + 25 then return "lower" end
  if value >= HGSS_CHARCODE_JP_DIGIT_START and value <= HGSS_CHARCODE_JP_DIGIT_START + 9 then return "jp_digits" end
  if value >= HGSS_CHARCODE_JP_UPPER_START and value <= HGSS_CHARCODE_JP_UPPER_START + 25 then return "jp_upper" end
  if value >= HGSS_CHARCODE_JP_LOWER_START and value <= HGSS_CHARCODE_JP_LOWER_START + 25 then return "jp_lower" end
  if hgss_charcode_symbols[value] ~= nil then return "symbols" end
  if value == 0xE007 or value == 0xE008 then return "control" end
  return nil
end

function validate_naming_keyboard_layout(addr)
  local counts = {}
  local valid_count = 0
  for i = 0, 6 * 13 - 1 do
    local class = naming_keyboard_code_class(u16(addr + 0x3A + i * 2))
    if class ~= nil then
      valid_count = valid_count + 1
      counts[class] = (counts[class] or 0) + 1
    end
  end
  local home_back = u16(addr + 0x3A + 8 * 2)
  local home_ok = u16(addr + 0x3A + 11 * 2)
  if home_back ~= 0xE007 or home_ok ~= 0xE008 then return nil, "home_row_controls_mismatch" end
  if valid_count < 24 then return nil, "keyboard_layout_too_sparse" end
  local page = "mixed"
  local best_count = 0
  for class, count in pairs(counts) do
    if class ~= "control" and count > best_count then
      page = class
      best_count = count
    end
  end
  return {
    validCellCount = valid_count,
    page = page,
    counts = counts,
  }, "ok"
end

function validate_naming_screen_appdata(addr)
  if not valid_arm9_ptr(addr) or addr + NAMING_SCREEN_APPDATA_SIZE >= NAMING_SCREEN_APPDATA_SCAN_END then
    return nil, "invalid_appdata_addr"
  end
  local screen_type = u32(addr + 0x00)
  local max_len = u32(addr + 0x0C)
  local cursor_x = u32(addr + 0x1C)
  local cursor_y = u32(addr + 0x20)
  local show_cursor = u32(addr + 0x30)
  local ignore_input = u32(addr + 0x34)
  local text_cursor_pos = u16(addr + 0x158)
  local bg_config = u32(addr + 0x160)
  local msg_data_249 = u32(addr + 0x16C)
  if screen_type == nil or screen_type < 0 or screen_type > 6 then return nil, "screen_type_out_of_range" end
  if max_len == nil or max_len < 1 or max_len > 12 then return nil, "max_len_out_of_range" end
  if cursor_x == nil or cursor_x > 12 or cursor_y == nil or cursor_y > 5 then return nil, "cursor_out_of_range" end
  if show_cursor ~= 0 and show_cursor ~= 1 then return nil, "show_cursor_not_bool" end
  if ignore_input ~= 0 and ignore_input ~= 1 then return nil, "ignore_input_not_bool" end
  if text_cursor_pos == nil or text_cursor_pos > max_len then return nil, "text_cursor_out_of_range" end
  if not valid_arm9_ptr(bg_config) or not valid_arm9_ptr(msg_data_249) then return nil, "appdata_runtime_pointers_invalid" end
  local keyboard_layout, keyboard_reason = validate_naming_keyboard_layout(addr)
  if keyboard_layout == nil then return nil, keyboard_reason end
  local entry_text, raw_words, entry_reason = decode_hgss_charcode_words_at(addr + 0xD8, max_len + 1)
  if entry_text == nil and entry_reason ~= "ok" then return nil, entry_reason end
  return {
    active = true,
    source = "NamingScreenAppData.entryBuf",
    validation = "naming_screen_appdata_entry_buffer_validated",
    contract = "hgss_naming_appdata_entry_buffer_v1",
    appDataPtr = addr,
    screenType = screen_type,
    maxLen = max_len,
    cursor = { x = cursor_x, y = cursor_y },
    textCursorPos = text_cursor_pos,
    showCursor = show_cursor == 1,
    ignoreInput = ignore_input == 1,
    entryText = entry_text or "",
    entryRawWords = raw_words,
    keyboardPage = keyboard_layout.page,
    keyboardValidCellCount = keyboard_layout.validCellCount,
  }, "ok"
end

function scan_naming_screen_appdata_range(scan_start, scan_end, scan_budget)
  local scanned = 0
  local addr = scan_start
  while scanned < scan_budget and addr + NAMING_SCREEN_APPDATA_SIZE < scan_end do
    local candidate = validate_naming_screen_appdata(addr)
    scanned = scanned + 4
    if candidate then
      candidate.scanStart = scan_start
      candidate.scanned = scanned
      return candidate, scanned
    end
    addr = addr + 4
  end
  return nil, scanned
end

function next_naming_screen_priority_scan_addr()
  local addr = NEXT_NAMING_SCREEN_PRIORITY_SCAN_ADDR
  if addr + NAMING_SCREEN_APPDATA_SIZE >= NAMING_SCREEN_PRIORITY_SCAN_END then
    addr = NAMING_SCREEN_PRIORITY_SCAN_START
  end
  NEXT_NAMING_SCREEN_PRIORITY_SCAN_ADDR = addr + 4
  if NEXT_NAMING_SCREEN_PRIORITY_SCAN_ADDR + NAMING_SCREEN_APPDATA_SIZE >= NAMING_SCREEN_PRIORITY_SCAN_END then
    NEXT_NAMING_SCREEN_PRIORITY_SCAN_ADDR = NAMING_SCREEN_PRIORITY_SCAN_START
  end
  return addr
end

function decode_naming_screen_state()
  if LOCKED_NAMING_SCREEN_APPDATA then
    local locked, reason = validate_naming_screen_appdata(LOCKED_NAMING_SCREEN_APPDATA)
    if locked then return locked end
    LOCKED_NAMING_SCREEN_APPDATA = nil
  end
  local priority_candidate = nil
  local priority_scanned = 0
  local priority_scan_start = NEXT_NAMING_SCREEN_PRIORITY_SCAN_ADDR
  while priority_scanned < NAMING_SCREEN_PRIORITY_SCAN_BUDGET do
    local addr = next_naming_screen_priority_scan_addr()
    priority_scanned = priority_scanned + 4
    priority_candidate = validate_naming_screen_appdata(addr)
    if priority_candidate then
      break
    end
  end
  if priority_candidate then
    LOCKED_NAMING_SCREEN_APPDATA = priority_candidate.appDataPtr
    priority_candidate.scanSource = "naming_screen_priority_overlay_heap"
    priority_candidate.priorityScanStart = priority_scan_start
    priority_candidate.priorityScanEnd = NAMING_SCREEN_PRIORITY_SCAN_END
    priority_candidate.priorityScanned = priority_scanned
    priority_candidate.priorityScanBudget = NAMING_SCREEN_PRIORITY_SCAN_BUDGET
    return priority_candidate
  end
  local scanned = 0
  local start_addr = NEXT_NAMING_SCREEN_APPDATA_SCAN_ADDR
  local addr = start_addr
  while scanned < NAMING_SCREEN_APPDATA_SCAN_BUDGET do
    if addr + NAMING_SCREEN_APPDATA_SIZE >= NAMING_SCREEN_APPDATA_SCAN_END then
      addr = NAMING_SCREEN_APPDATA_SCAN_START
    end
    local candidate = validate_naming_screen_appdata(addr)
    if candidate then
      LOCKED_NAMING_SCREEN_APPDATA = addr
      candidate.scanStart = start_addr
      candidate.scanBudget = NAMING_SCREEN_APPDATA_SCAN_BUDGET
      candidate.scanned = scanned
      candidate.scanSource = "naming_screen_broad_rolling_scan"
      candidate.priorityScanStart = NAMING_SCREEN_PRIORITY_SCAN_START
      candidate.priorityScanEnd = NAMING_SCREEN_PRIORITY_SCAN_END
      candidate.priorityScanned = priority_scanned
      candidate.priorityScanBudget = NAMING_SCREEN_PRIORITY_SCAN_BUDGET
      NEXT_NAMING_SCREEN_APPDATA_SCAN_ADDR = addr + 4
      return candidate
    end
    addr = addr + 4
    scanned = scanned + 4
  end
  NEXT_NAMING_SCREEN_APPDATA_SCAN_ADDR = addr
  return {
    active = false,
    source = "NamingScreenAppData.entryBuf",
    validation = "not_found",
    contract = "hgss_naming_appdata_entry_buffer_v1",
    priorityScanStart = NAMING_SCREEN_PRIORITY_SCAN_START,
    priorityScanEnd = NAMING_SCREEN_PRIORITY_SCAN_END,
    priorityScanned = priority_scanned,
    priorityScanBudget = NAMING_SCREEN_PRIORITY_SCAN_BUDGET,
    scanStart = start_addr,
    scanBudget = NAMING_SCREEN_APPDATA_SCAN_BUDGET,
    nextScanStart = NEXT_NAMING_SCREEN_APPDATA_SCAN_ADDR,
  }
end

function decrypt_party_battle_stats(addr, pid)
  if pid == nil then return nil end
  local bytes = {}
  local seed = pid
  for i = 0, 49 do
    seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
    local key = seed >> 16
    local enc = u16(addr + 0x88 + i * 2)
    if enc == nil then return nil end
    local dec = enc ~ key
    bytes[i * 2 + 1] = dec & 0xFF
    bytes[i * 2 + 2] = (dec >> 8) & 0xFF
  end
  return {
    status = u32_from_bytes(bytes, 1) or 0,
    level = bytes[5] or 0,
    current_hp = word_from_bytes(bytes, 7),
    max_hp = word_from_bytes(bytes, 9),
    attack = word_from_bytes(bytes, 11),
    defense = word_from_bytes(bytes, 13),
    speed = word_from_bytes(bytes, 15),
    special_attack = word_from_bytes(bytes, 17),
    special_defense = word_from_bytes(bytes, 19),
    encryption = "pid_lcg",
  }
end

function decode_hidden_pokemon_mechanics_diagnostics(pid, bytes, growth, attacks)
  if pid == nil or bytes == nil or growth == nil then return nil end
  local diagnostics = {
    monitor_only = true,
    source = "project_pokemon_gen4_pkm_encrypted_blocks",
    nature_id = pid % 25,
  }
  if growth ~= nil then
    diagnostics.evs = {
      hp = bytes[growth + 16] or 0,
      attack = bytes[growth + 17] or 0,
      defense = bytes[growth + 18] or 0,
      speed = bytes[growth + 19] or 0,
      special_attack = bytes[growth + 20] or 0,
      special_defense = bytes[growth + 21] or 0,
    }
  end
  if attacks ~= nil then
    diagnostics.pp_ups = {
      bytes[attacks + 12] or 0,
      bytes[attacks + 13] or 0,
      bytes[attacks + 14] or 0,
      bytes[attacks + 15] or 0,
    }
    local ivs_and_flags = u32_from_bytes(bytes, attacks + 16)
    if ivs_and_flags ~= nil then
      diagnostics.ivs = {
        hp = ivs_and_flags & 0x1F,
        attack = (ivs_and_flags >> 5) & 0x1F,
        defense = (ivs_and_flags >> 10) & 0x1F,
        speed = (ivs_and_flags >> 15) & 0x1F,
        special_attack = (ivs_and_flags >> 20) & 0x1F,
        special_defense = (ivs_and_flags >> 25) & 0x1F,
      }
    end
  end
  return diagnostics
end

function decrypt_party_mon(addr)
  local pid = u32(addr)
  local checksum = u16(addr + 0x06)
  if pid == nil or checksum == nil or pid == 0 or pid == 0xFFFFFFFF then return nil end

  local seed = checksum
  local bytes = {}
  local checksum_calc = 0
  for i = 0, 63 do
    seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
    local key = seed >> 16
    local enc = u16(addr + 0x08 + i * 2)
    if enc == nil then return nil end
    local dec = enc ~ key
    checksum_calc = (checksum_calc + dec) & 0xFFFF
    bytes[i * 2 + 1] = dec & 0xFF
    bytes[i * 2 + 2] = (dec >> 8) & 0xFF
  end
  if checksum_calc ~= checksum then return nil end

  local order_index = (((pid & 0x3E000) >> 0xD) % 24) + 1
  local order = block_orders[order_index]
  local growth_pos = nil
  local attacks_pos = nil
  local misc_pos = nil
  for pos = 1, 4 do
    if order[pos] == 0 then growth_pos = pos - 1 end
    if order[pos] == 1 then attacks_pos = pos - 1 end
    if order[pos] == 2 then misc_pos = pos - 1 end
  end
  if growth_pos == nil then return nil end

  local growth = growth_pos * 32 + 1
  local attacks = attacks_pos and (attacks_pos * 32 + 1) or nil
  local misc = misc_pos and (misc_pos * 32 + 1) or nil
  local species = word_from_bytes(bytes, growth)
  if species <= 0 or species > 493 then return nil end
  local held_item_id = word_from_bytes(bytes, growth + 2)
  local original_trainer_id = word_from_bytes(bytes, growth + 4)
  local original_secret_id = word_from_bytes(bytes, growth + 6)
  local exp = u32_from_bytes(bytes, growth + 8) or 0
  local ability_id = bytes[growth + 13] or nil
  local nickname = misc and decode_hgss_charcode_text(bytes, misc, 11) or nil
  local is_nicknamed = nil
  local form_id = nil

  local moves = {}
  local pp = {}
  if attacks then
    for i = 0, 3 do
      local move_id = word_from_bytes(bytes, attacks + i * 2)
      if move_id > 0 then moves[#moves + 1] = move_id end
    end
    for i = 0, 3 do
      pp[#pp + 1] = bytes[attacks + 8 + i] or 0
    end
    local ivs_and_flags = u32_from_bytes(bytes, attacks + 16)
    if ivs_and_flags ~= nil then
      is_nicknamed = (ivs_and_flags & 0x80000000) ~= 0
    end
    local form_flags = bytes[attacks + 24]
    if form_flags ~= nil then
      form_id = form_flags >> 3
    end
  end

  local battle_stats = decrypt_party_battle_stats(addr, pid) or {}
  local hidden_mechanics = decode_hidden_pokemon_mechanics_diagnostics(pid, bytes, growth, attacks)

  return {
    species_id = species,
    species_name = "Species " .. tostring(species),
    nickname = nickname,
    is_nicknamed = is_nicknamed,
    level = battle_stats.level or 0,
    exp = exp,
    current_hp = battle_stats.current_hp or 0,
    max_hp = battle_stats.max_hp or 0,
    status = battle_stats.status or 0,
    ability_id = ability_id or 0,
    original_trainer_id = original_trainer_id or 0,
    original_secret_id = original_secret_id or 0,
    form_id = form_id or 0,
    attack = battle_stats.attack or 0,
    defense = battle_stats.defense or 0,
    speed = battle_stats.speed or 0,
    special_attack = battle_stats.special_attack or 0,
    special_defense = battle_stats.special_defense or 0,
    battle_stats_encryption = battle_stats.encryption or "unavailable",
    move_ids = moves,
    pp = pp,
    held_item_id = held_item_id or 0,
    block_order_index = order_index,
    pid = pid,
    hidden_mechanics_diagnostics = hidden_mechanics,
    checksum_valid = true,
  }
end

function decrypt_box_mon(addr)
  local pid = u32(addr)
  local checksum = u16(addr + 0x06)
  if pid == nil or checksum == nil or pid == 0 or pid == 0xFFFFFFFF then return nil end

  local seed = checksum
  local bytes = {}
  local checksum_calc = 0
  for i = 0, 63 do
    seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
    local key = seed >> 16
    local enc = u16(addr + 0x08 + i * 2)
    if enc == nil then return nil end
    local dec = enc ~ key
    checksum_calc = (checksum_calc + dec) & 0xFFFF
    bytes[i * 2 + 1] = dec & 0xFF
    bytes[i * 2 + 2] = (dec >> 8) & 0xFF
  end
  if checksum_calc ~= checksum then return nil end

  local order_index = (((pid & 0x3E000) >> 0xD) % 24) + 1
  local order = block_orders[order_index]
  local growth_pos = nil
  local attacks_pos = nil
  local misc_pos = nil
  for pos = 1, 4 do
    if order[pos] == 0 then growth_pos = pos - 1 end
    if order[pos] == 1 then attacks_pos = pos - 1 end
    if order[pos] == 2 then misc_pos = pos - 1 end
  end
  if growth_pos == nil then return nil end

  local growth = growth_pos * 32 + 1
  local attacks = attacks_pos and (attacks_pos * 32 + 1) or nil
  local misc = misc_pos and (misc_pos * 32 + 1) or nil
  local species = word_from_bytes(bytes, growth)
  if species == nil or species <= 0 or species > 493 then return nil end
  local held_item_id = word_from_bytes(bytes, growth + 2)
  local original_trainer_id = word_from_bytes(bytes, growth + 4)
  local original_secret_id = word_from_bytes(bytes, growth + 6)
  local exp = u32_from_bytes(bytes, growth + 8) or 0
  local ability_id = bytes[growth + 13] or 0
  local nickname = misc and decode_hgss_charcode_text(bytes, misc, 11) or nil
  local is_nicknamed = nil
  local form_id = nil
  local moves = {}
  local pp = {}
  if attacks then
    for i = 0, 3 do
      local move_id = word_from_bytes(bytes, attacks + i * 2)
      if move_id > 0 then moves[#moves + 1] = move_id end
    end
    for i = 0, 3 do
      pp[#pp + 1] = bytes[attacks + 8 + i] or 0
    end
    local ivs_and_flags = u32_from_bytes(bytes, attacks + 16)
    if ivs_and_flags ~= nil then
      is_nicknamed = (ivs_and_flags & 0x80000000) ~= 0
    end
    local form_flags = bytes[attacks + 24]
    if form_flags ~= nil then
      form_id = form_flags >> 3
    end
  end
  local hidden_mechanics = decode_hidden_pokemon_mechanics_diagnostics(pid, bytes, growth, attacks)

  return {
    species_id = species,
    species_name = "Species " .. tostring(species),
    nickname = nickname,
    is_nicknamed = is_nicknamed,
    level = 0,
    current_hp = 1,
    max_hp = 1,
    pc_box_mon = true,
    exp = exp,
    status = 0,
    ability_id = ability_id,
    original_trainer_id = original_trainer_id or 0,
    original_secret_id = original_secret_id or 0,
    form_id = form_id or 0,
    move_ids = moves,
    pp = pp,
    held_item_id = held_item_id or 0,
    block_order_index = order_index,
    pid = pid,
    hidden_mechanics_diagnostics = hidden_mechanics,
    checksum_valid = true,
  }
end

function party_mon_stats_reasonable(mon)
  if mon == nil then return false end
  if mon.level == nil or mon.level < 1 or mon.level > 100 then return false end
  if mon.max_hp == nil or mon.max_hp < 1 or mon.max_hp > 999 then return false end
  if mon.current_hp == nil or mon.current_hp < 0 or mon.current_hp > mon.max_hp then return false end
  if mon.move_ids ~= nil then
    for _, move_id in ipairs(mon.move_ids) do
      if move_id ~= nil and move_id ~= 0 and (move_id < 1 or move_id > 467) then return false end
    end
  end
  if mon.pp ~= nil then
    for _, pp in ipairs(mon.pp) do
      if pp ~= nil and (pp < 0 or pp > 64) then return false end
    end
  end
  return true
end

function decode_battle_context_mon(addr, battler_id)
  local species = u16(addr + 0x00)
  if species == nil or species <= 0 or species > 493 then return nil end
  local moves = {}
  for i = 0, 3 do
    local move_id = u16(addr + 0x0C + i * 2)
    if move_id == nil then return nil end
    if move_id > 0 then moves[#moves + 1] = move_id end
  end
  local pp = {}
  for i = 0, 3 do
    local value = u8(addr + 0x2C + i)
    if value == nil then return nil end
    pp[#pp + 1] = value
  end
  local level = u8(addr + 0x34)
  local current_hp = u32(addr + 0x4C)
  if current_hp ~= nil and current_hp >= 0x80000000 then current_hp = current_hp - 0x100000000 end
  local max_hp = u32(addr + 0x50)
  local status = u32(addr + 0x6C)
  local held_item_id = u16(addr + 0x78)
  local ability = u8(addr + 0x27)
  local type1 = u8(addr + 0x24)
  local type2 = u8(addr + 0x25)
  local attack = u16(addr + 0x02)
  local defense = u16(addr + 0x04)
  local speed = u16(addr + 0x06)
  local special_attack = u16(addr + 0x08)
  local special_defense = u16(addr + 0x0A)
  local personality = u32(addr + 0x68)
  if level == nil or current_hp == nil or max_hp == nil or status == nil then return nil end
  local mon = {
    battler_id = battler_id,
    slot_id = battler_id + 1,
    side = (battler_id % 2 == 0) and "player" or "enemy",
    species_id = species,
    species_name = "Species " .. tostring(species),
    level = level,
    current_hp = current_hp,
    max_hp = max_hp,
    status = status,
    attack = attack or 0,
    defense = defense or 0,
    speed = speed or 0,
    special_attack = special_attack or 0,
    special_defense = special_defense or 0,
    move_ids = moves,
    pp = pp,
    held_item_id = held_item_id or 0,
    ability_id = ability,
    type_ids = { type1 or 0, type2 or 0 },
    personality = personality,
    checksum_valid = true,
    source = "BattleContext.battleMons",
  }
  if not party_mon_stats_reasonable(mon) then return nil end
  return mon
end

function raw_battle_mon_probe(addr, battler_id)
  local hp_raw = u32(addr + 0x4C)
  if hp_raw and hp_raw >= 0x80000000 then hp_raw = hp_raw - 0x100000000 end
  return {
    addr = addr,
    battlerId = battler_id,
    species = u16(addr + 0x00),
    atk = u16(addr + 0x02),
    def = u16(addr + 0x04),
    speed = u16(addr + 0x06),
    spAtk = u16(addr + 0x08),
    spDef = u16(addr + 0x0A),
    move1 = u16(addr + 0x0C),
    move2 = u16(addr + 0x0E),
    move3 = u16(addr + 0x10),
    move4 = u16(addr + 0x12),
    level = u8(addr + 0x34),
    hp = hp_raw,
    maxHp = u32(addr + 0x50),
    item = u16(addr + 0x78),
  }
end

function battle_system_probe_diagnostics(battle_system_addr)
  if not valid_arm9_ptr(battle_system_addr) then return nil end
  local ctx_ptr = u32(battle_system_addr + 0x30)
  local max_battlers = u32(battle_system_addr + 0x44)
  local diag = {
    battleSystemPtr = battle_system_addr,
    msgBufferPtr = u32(battle_system_addr + 0x18),
    battleType = u32(battle_system_addr + 0x2C),
    ctxPtr = ctx_ptr,
    maxBattlers = max_battlers,
    expectedBattleMonsOffset = BATTLE_CONTEXT_BATTLE_MONS_OFFSET,
  }
  if not valid_arm9_ptr(ctx_ptr) then
    diag.reason = "invalid_ctx_ptr"
    return diag
  end
  diag.selectedMonIndex = {
    u8(ctx_ptr + 0x219C),
    u8(ctx_ptr + 0x219D),
    u8(ctx_ptr + 0x219E),
    u8(ctx_ptr + 0x219F),
  }
  diag.offsetProbes = {}
  local offsets = { 0x2D00, 0x2D20, 0x2D40, 0x2D5C, 0x2D60, 0x2D80 }
  for i = 1, #offsets do
    local offset = offsets[i]
    diag.offsetProbes[#diag.offsetProbes + 1] = {
      offset = offset,
      battler0 = raw_battle_mon_probe(ctx_ptr + offset, 0),
      battler1 = raw_battle_mon_probe(ctx_ptr + offset + BATTLE_MON_SIZE, 1),
    }
  end
  return diag
end

function next_battle_system_scan_addr()
  local addr = NEXT_BATTLE_SYSTEM_SCAN_ADDR
  NEXT_BATTLE_SYSTEM_SCAN_ADDR = NEXT_BATTLE_SYSTEM_SCAN_ADDR + 4
  if NEXT_BATTLE_SYSTEM_SCAN_ADDR >= BATTLE_SYSTEM_SCAN_END then
    NEXT_BATTLE_SYSTEM_SCAN_ADDR = BATTLE_SYSTEM_SCAN_START
  end
  return addr
end

function battle_menu_name(menu_id)
  local names = {
    [-1] = "none",
    [0] = "BATTLE_MENU_0",
    [1] = "MAIN_INITIAL",
    [2] = "MAIN",
    [9] = "PAL_PARK_INITIAL",
    [10] = "PAL_PARK",
    [11] = "FIGHT",
    [12] = "TARGET",
    [13] = "YES_NO",
    [14] = "KEEP_FORGET_MOVE",
    [15] = "GIVE_UP_ON_MOVE",
    [16] = "SWITCH_OR_FLEE",
    [17] = "SWITCH_OR_KEEP",
    [18] = "VS_RECORDER_PLAYBACK",
    [19] = "BATTLE_MENU_19",
    [20] = "BATTLE_MENU_20",
  }
  return names[menu_id] or ("BATTLE_MENU_" .. tostring(menu_id))
end

function controller_command_name(command)
  local names = {
    [0] = "GET_BATTLE_MON",
    [1] = "START_ENCOUNTER",
    [2] = "TRAINER_MESSAGE",
    [3] = "SEND_OUT",
    [4] = "SELECTION_SCREEN_INIT",
    [5] = "SELECTION_SCREEN_INPUT",
    [6] = "CALC_EXECUTION_ORDER",
    [7] = "BEFORE_TURN",
    [9] = "UPDATE_FIELD_CONDITION",
    [10] = "UPDATE_MON_CONDITION",
    [11] = "UPDATE_FIELD_CONDITION_EXTRA",
    [12] = "TURN_END",
    [13] = "FIGHT_INPUT",
    [14] = "ITEM_INPUT",
    [15] = "POKEMON_INPUT",
    [16] = "RUN_INPUT",
    [17] = "SAFARI_THROW_BALL",
    [18] = "SAFARI_THROW_MUD",
    [19] = "SAFARI_RUN",
    [20] = "SAFARI_WATCHING",
    [21] = "CATCHING_CONTEST_THROW_BALL",
    [22] = "RUN_SCRIPT",
    [28] = "HP_CALC",
  }
  return names[command] or ("CONTROLLER_COMMAND_" .. tostring(command))
end

function battle_input_selection_name(selection)
  local names = {
    [0] = "none_or_cancel",
    [1] = "fight_or_move_1_or_yes",
    [2] = "bag_or_move_2",
    [3] = "pokemon_or_move_3",
    [4] = "run_or_move_4",
    [0xFF] = "cancel",
  }
  return names[selection] or ("input_" .. tostring(selection))
end

function decode_battle_input_state(battle_system_addr, ctx_ptr, max_battlers)
  if not valid_arm9_ptr(battle_system_addr) or not valid_arm9_ptr(ctx_ptr) then
    return nil, "invalid_battle_or_ctx_pointer"
  end
  local battle_input_ptr = u32(battle_system_addr + BATTLE_SYSTEM_BATTLE_INPUT_OFFSET)
  if not valid_arm9_ptr(battle_input_ptr) then
    return nil, "invalid_battle_input_pointer"
  end
  local battle_system_backref = u32(battle_input_ptr + 0x00)
  if battle_system_backref ~= battle_system_addr then
    return nil, "battle_input_backref_mismatch"
  end
  local cur_menu_id = s8(battle_input_ptr + BATTLE_INPUT_CUR_MENU_ID_OFFSET)
  if cur_menu_id == nil or cur_menu_id < -1 or cur_menu_id > 20 then
    return nil, "battle_input_menu_id_unreasonable"
  end

  local actions = {}
  local execution_order = {}
  local turn_order = {}
  local selected_mon_index = {}
  local capped_battlers = math.max(0, math.min(max_battlers or 0, 4))
  for battler_id = 0, capped_battlers - 1 do
    local action_base = ctx_ptr + BATTLE_CONTEXT_PLAYER_ACTIONS_OFFSET + battler_id * 0x10
    local command = u32(action_base + 0x00)
    local input_selection = u32(action_base + 0x0C)
    actions[#actions + 1] = {
      battlerId = battler_id,
      command = command,
      commandName = controller_command_name(command),
      parameter1 = u32(action_base + 0x04),
      parameter2 = u32(action_base + 0x08),
      inputSelection = input_selection,
      inputSelectionName = battle_input_selection_name(input_selection),
    }
    execution_order[#execution_order + 1] = u8(ctx_ptr + BATTLE_CONTEXT_EXECUTION_ORDER_OFFSET + battler_id)
    turn_order[#turn_order + 1] = u8(ctx_ptr + BATTLE_CONTEXT_TURN_ORDER_OFFSET + battler_id)
    selected_mon_index[#selected_mon_index + 1] = u8(ctx_ptr + BATTLE_CONTEXT_SELECTED_MON_INDEX_OFFSET + battler_id)
  end

  return {
    source = "BattleSystem.battleInput + BattleContext.playerActions",
    battleInputPtr = battle_input_ptr,
    battleInputBackref = battle_system_backref,
    validation = "battle_input_current_context_backref_validated",
    curMenuId = cur_menu_id,
    curMenuName = battle_menu_name(cur_menu_id),
    battlerType = u8(battle_input_ptr + BATTLE_INPUT_BATTLER_TYPE_OFFSET),
    monTargetType = u8(battle_input_ptr + BATTLE_INPUT_MON_TARGET_TYPE_OFFSET),
    isTouchDisabled = u8(battle_input_ptr + BATTLE_INPUT_IS_TOUCH_DISABLED_OFFSET),
    cancelRunDisplay = u8(battle_input_ptr + BATTLE_INPUT_CANCEL_RUN_DISPLAY_OFFSET),
    contextCommand = u32(ctx_ptr + BATTLE_CONTEXT_COMMAND_OFFSET),
    contextCommandName = controller_command_name(u32(ctx_ptr + BATTLE_CONTEXT_COMMAND_OFFSET)),
    contextCommandNext = u32(ctx_ptr + BATTLE_CONTEXT_COMMAND_NEXT_OFFSET),
    contextCommandNextName = controller_command_name(u32(ctx_ptr + BATTLE_CONTEXT_COMMAND_NEXT_OFFSET)),
    selectedMonIndex = selected_mon_index,
    playerActions = actions,
    executionOrder = execution_order,
    turnOrder = turn_order,
  }, nil
end

function ironmon_hgss_global_base()
  local raw = u32(IRONMON_GLOBAL_POINTER_ADDR)
  if raw == nil or raw == 0 then return nil, "ironmon_global_pointer_unavailable" end
  local base = 0x02000000 + (raw & 0x00FFFFFF) + IRONMON_VERSION_POINTER_OFFSET
  if not valid_arm9_ptr(base) then return nil, "ironmon_global_pointer_out_of_range" end
  return base, "validated"
end

function ironmon_slot_index_for_battler(battler_id)
  return math.floor((battler_id or 0) / 2) + 1
end

function decode_ironmon_stat_stages(global_base, battler_id, side)
  if not valid_arm9_ptr(global_base) then return nil, "ironmon_global_base_unavailable" end
  local slot_index = ironmon_slot_index_for_battler(battler_id)
  if slot_index < 1 or slot_index > 2 then return nil, "ironmon_stat_stage_slot_out_of_range" end
  local offset = side == "enemy" and IRONMON_STAT_STAGES_ENEMY_OFFSET or IRONMON_STAT_STAGES_PLAYER_OFFSET
  local addr = global_base + offset + (slot_index - 1) * IRONMON_STAT_STAGE_SLOT_STRIDE
  local raw = {
    hp = u8(addr + 0),
    attack = u8(addr + 1),
    defense = u8(addr + 2),
    speed = u8(addr + 3),
    special_attack = u8(addr + 4),
    special_defense = u8(addr + 5),
    accuracy = u8(addr + 6),
    evasion = u8(addr + 7),
  }
  local sum = 0
  for _, value in pairs(raw) do
    if value == nil or value < 0 or value > 12 then
      return nil, "ironmon_stat_stage_value_out_of_range"
    end
    sum = sum + value
  end
  if sum < 3 then return nil, "ironmon_stat_stage_sum_unreasonable" end
  return {
    attack = raw.attack - 6,
    defense = raw.defense - 6,
    speed = raw.speed - 6,
    special_attack = raw.special_attack - 6,
    special_defense = raw.special_defense - 6,
    accuracy = raw.accuracy - 6,
    evasion = raw.evasion - 6,
  }, "validated"
end

function ironmon_active_pid_slot(global_base, battler_id, side)
  if not valid_arm9_ptr(global_base) then return nil, "ironmon_global_base_unavailable" end
  local slot_index = ironmon_slot_index_for_battler(battler_id)
  if slot_index < 1 or slot_index > 2 then return nil, "ironmon_pid_slot_out_of_range" end
  local offset = side == "enemy" and IRONMON_ACTIVE_ENEMY_PID_OFFSET or IRONMON_ACTIVE_PLAYER_PID_OFFSET
  local pid = u32(global_base + offset + (slot_index - 1) * IRONMON_ACTIVE_PID_SLOT_STRIDE)
  if pid == nil or pid == 0 then return nil, "ironmon_active_pid_unavailable" end
  return pid, "validated"
end

function decorate_battle_battlers_with_ironmon_current_state(battlers)
  local global_base, base_reason = ironmon_hgss_global_base()
  local crosscheck = {
    available = valid_arm9_ptr(global_base),
    validation = base_reason,
    checkedBattlers = 0,
    matchedBattlers = 0,
    playerMatched = false,
    enemyMatched = false,
    statStagesValidation = base_reason,
    source = "NDS-Ironmon-Tracker HGSS current battle offsets",
  }
  if not valid_arm9_ptr(global_base) or type(battlers) ~= "table" then
    return crosscheck
  end

  local stat_stage_ok = 0
  for _, mon in ipairs(battlers) do
    local side = mon.side
    local battler_id = mon.battler_id
    local stages, stages_reason = decode_ironmon_stat_stages(global_base, battler_id, side)
    if stages then
      mon.stat_stages = stages
      stat_stage_ok = stat_stage_ok + 1
    else
      crosscheck.statStagesValidation = stages_reason
    end

    local active_pid = nil
    local pid_reason = "personality_unavailable"
    if mon.personality ~= nil and mon.personality ~= 0 then
      active_pid, pid_reason = ironmon_active_pid_slot(global_base, battler_id, side)
      if active_pid ~= nil then
        crosscheck.checkedBattlers = crosscheck.checkedBattlers + 1
        if active_pid == mon.personality then
          crosscheck.matchedBattlers = crosscheck.matchedBattlers + 1
          if side == "player" then crosscheck.playerMatched = true end
          if side == "enemy" then crosscheck.enemyMatched = true end
        end
      end
    end
    crosscheck.lastPidValidation = pid_reason
  end

  if stat_stage_ok == #battlers and #battlers > 0 then
    crosscheck.statStagesValidation = "validated"
  end
  if crosscheck.checkedBattlers > 0 and crosscheck.checkedBattlers == crosscheck.matchedBattlers then
    crosscheck.validation = "active_pid_slots_match_battle_context_personality"
  elseif crosscheck.checkedBattlers > 0 then
    crosscheck.validation = "active_pid_slots_mismatch"
  else
    crosscheck.validation = crosscheck.lastPidValidation or "active_pid_slots_unavailable"
  end
  return crosscheck
end

function decode_battle_system_candidate(battle_system_addr)
  local msg_buffer_ptr = u32(battle_system_addr + 0x18)
  local battle_type = u32(battle_system_addr + 0x2C)
  local ctx_ptr = u32(battle_system_addr + 0x30)
  local max_battlers = u32(battle_system_addr + 0x44)
  if not valid_arm9_ptr(ctx_ptr) then return nil end
  if battle_type == nil or battle_type < 0 or battle_type > 0xFFFF then return nil end
  if max_battlers == nil or max_battlers < 2 or max_battlers > 4 then return nil end
  local msg_buffer = nil
  local msg_reason = "msgbuffer_not_checked"
  if valid_arm9_ptr(msg_buffer_ptr) then
    msg_buffer, msg_reason = read_hgss_string_object(msg_buffer_ptr)
    if not msg_buffer or msg_buffer.maxsize ~= 0x140 then
      msg_buffer = nil
    end
  else
    msg_reason = "msgbuffer_pointer_invalid_or_idle"
  end

  local battlers = {}
  local player_count = 0
  local enemy_count = 0
  for battler_id = 0, max_battlers - 1 do
    local mon = decode_battle_context_mon(ctx_ptr + BATTLE_CONTEXT_BATTLE_MONS_OFFSET + battler_id * BATTLE_MON_SIZE, battler_id)
    if mon then
      battlers[#battlers + 1] = mon
      if mon.side == "player" then player_count = player_count + 1 else enemy_count = enemy_count + 1 end
    end
  end
  if player_count == 0 or enemy_count == 0 then return nil end
  local active_pid_crosscheck = decorate_battle_battlers_with_ironmon_current_state(battlers)
  local selected_mon_index = {}
  for battler_id = 0, max_battlers - 1 do
    selected_mon_index[#selected_mon_index + 1] = u8(ctx_ptr + 0x219C + battler_id)
  end
  local battle_input, battle_input_reason = decode_battle_input_state(battle_system_addr, ctx_ptr, max_battlers)
  return {
    battleSystemPtr = battle_system_addr,
    ctxPtr = ctx_ptr,
    msgBufferPtr = msg_buffer_ptr,
    battleType = battle_type,
    maxBattlers = max_battlers,
    isTrainerBattle = bit_is_set(battle_type, 0x1),
    isDoubleBattle = bit_is_set(battle_type, 0x2),
    selectedMonIndex = selected_mon_index,
    battleInput = battle_input,
    battleInputValidation = battle_input and battle_input.validation or battle_input_reason,
    activePidCrosscheck = active_pid_crosscheck,
    battlers = battlers,
    playerCount = player_count,
    enemyCount = enemy_count,
    source = "BattleSystem->BattleContext.battleMons",
    validation = "battle_context_battle_mons_validated",
    msgBufferString = msg_buffer,
    msgBufferReason = msg_reason,
    textContextEpoch = CURRENT_BATTLE_TEXT_EPOCH,
  }
end

function scan_battle_system_range(start_addr, end_addr)
  local candidates = {}
  local scanned = 0
  local addr = start_addr
  while addr < end_addr do
    scanned = scanned + 1
    local candidate = decode_battle_system_candidate(addr)
    if candidate then
      candidates[#candidates + 1] = candidate
      if #candidates >= 2 then break end
    end
    addr = addr + 4
  end
  return candidates, {
    scanned = scanned,
    scanStart = start_addr,
    nextScanStart = addr,
  }
end

function decode_active_battle_system(in_battle_candidate, battle_text_probe)
  if not in_battle_candidate then
    LOCKED_BATTLE_SYSTEM_PROBE = nil
    return nil, "not_in_battle_candidate", {}
  end
  if battle_text_probe and battle_text_probe.active and battle_text_probe.battleSystemPtr then
    local text_probe_candidate = decode_battle_system_candidate(battle_text_probe.battleSystemPtr)
    if text_probe_candidate then
      LOCKED_BATTLE_SYSTEM_PROBE = {
        battleSystemPtr = text_probe_candidate.battleSystemPtr,
        ctxPtr = text_probe_candidate.ctxPtr,
      }
      text_probe_candidate.locked = true
      text_probe_candidate.seededByTextProbe = true
      return text_probe_candidate, "locked_from_battle_text_probe", {}
    end
  end
  if LOCKED_BATTLE_SYSTEM_PROBE then
    local locked = decode_battle_system_candidate(LOCKED_BATTLE_SYSTEM_PROBE.battleSystemPtr)
    if locked and locked.ctxPtr == LOCKED_BATTLE_SYSTEM_PROBE.ctxPtr then
      locked.locked = true
      return locked, "locked", {}
    end
    LOCKED_BATTLE_SYSTEM_PROBE = nil
  end

  local priority_candidates, priority_diagnostics = scan_battle_system_range(
    BATTLE_SYSTEM_PRIORITY_SCAN_START,
    BATTLE_SYSTEM_PRIORITY_SCAN_END
  )
  if #priority_candidates == 1 then
    LOCKED_BATTLE_SYSTEM_PROBE = {
      battleSystemPtr = priority_candidates[1].battleSystemPtr,
      ctxPtr = priority_candidates[1].ctxPtr,
    }
    priority_candidates[1].locked = true
    priority_candidates[1].scanStart = priority_diagnostics.scanStart
    priority_candidates[1].scanned = priority_diagnostics.scanned
    return priority_candidates[1], "locked_after_priority_scan", {}
  end
  if #priority_candidates > 1 then
    LOCKED_BATTLE_SYSTEM_PROBE = nil
    priority_diagnostics.candidates = #priority_candidates
    return nil, "ambiguous_priority_battle_system_candidates", priority_diagnostics
  end

  local scanned = 0
  local start_addr = NEXT_BATTLE_SYSTEM_SCAN_ADDR
  local candidates = {}
  while scanned < BATTLE_SYSTEM_SCAN_BUDGET do
    local addr = next_battle_system_scan_addr()
    scanned = scanned + 1
    local candidate = decode_battle_system_candidate(addr)
    if candidate then
      candidates[#candidates + 1] = candidate
      if #candidates >= 2 then break end
    end
  end
  if #candidates == 1 then
    LOCKED_BATTLE_SYSTEM_PROBE = {
      battleSystemPtr = candidates[1].battleSystemPtr,
      ctxPtr = candidates[1].ctxPtr,
    }
    candidates[1].locked = true
    candidates[1].scanStart = start_addr
    candidates[1].scanned = scanned
    return candidates[1], "locked_after_scan", {}
  end
  if #candidates > 1 then
    LOCKED_BATTLE_SYSTEM_PROBE = nil
    return nil, "ambiguous_battle_system_candidates", {
      scanned = scanned,
      scanStart = start_addr,
      nextScanStart = NEXT_BATTLE_SYSTEM_SCAN_ADDR,
      candidates = #candidates,
    }
  end
  return nil, "battle_system_candidate_not_found", {
    scanned = scanned,
    scanStart = start_addr,
    nextScanStart = NEXT_BATTLE_SYSTEM_SCAN_ADDR,
    priorityScan = priority_diagnostics,
    textProbeBattleSystem = battle_text_probe and battle_text_probe.battleSystemPtr and battle_system_probe_diagnostics(battle_text_probe.battleSystemPtr) or nil,
  }
end

function decode_party(base)
  if base == nil then return {}, 0, nil, "not_validated", {} end
  local candidates = {
    { count_addr = base + 0xD084, party_addr = base + 0xD088, source = "PokeLua base+0xD084/0xD088" },
    { count_addr = base + 0xD090, party_addr = base + 0xD094, source = "Bulbapedia base+0xD090/0xD094" },
  }

  local evaluations = {}
  local best_non_empty = nil
  local best_partial_non_empty = nil
  local best_empty = nil
  for _, candidate in ipairs(candidates) do
    local count = u8(candidate.count_addr)
    local evaluation = {
      source = candidate.source,
      count_addr = candidate.count_addr,
      party_addr = candidate.party_addr,
      count = count,
      valid_count = count ~= nil and count >= 0 and count <= 6,
      valid_decoded = 0,
      stats_valid = 0,
      validation = "invalid_count",
    }
    if count ~= nil and count >= 0 and count <= 6 then
      local party = {}
      local valid_decoded = 0
      local stats_valid = 0
      for i = 0, count - 1 do
        local mon = decrypt_party_mon(candidate.party_addr + i * 0xEC)
        if mon then
          mon.slot_id = i + 1
          party[#party + 1] = mon
          valid_decoded = valid_decoded + 1
          if party_mon_stats_reasonable(mon) then stats_valid = stats_valid + 1 end
        end
      end
      evaluation.valid_decoded = valid_decoded
      evaluation.stats_valid = stats_valid
      if count == 0 then
        evaluation.validation = "empty_party"
        best_empty = best_empty or { party = party, count = count, source = candidate.source }
      elseif valid_decoded == count and stats_valid == count then
        evaluation.validation = "checksum_and_stats_validated"
        best_non_empty = best_non_empty or { party = party, count = count, source = candidate.source }
      elseif valid_decoded == count then
        evaluation.validation = "checksum_validated_stats_failed"
        best_partial_non_empty = best_partial_non_empty or { party = party, count = count, source = candidate.source }
      else
        evaluation.validation = "checksum_failed"
      end
    end
    evaluations[#evaluations + 1] = evaluation
  end
  if best_non_empty then
    return best_non_empty.party, best_non_empty.count, best_non_empty.source, "checksum_validated", evaluations
  end
  if best_partial_non_empty then
    return best_partial_non_empty.party, best_partial_non_empty.count, best_partial_non_empty.source, "checksum_validated_partial_stats", evaluations
  end
  if best_empty then
    return best_empty.party, best_empty.count, best_empty.source, "checksum_validated", evaluations
  end
  return {}, 0, nil, "not_validated", evaluations
end

function decode_party_from_field_system(field_system)
  local evaluations = {}
  if not valid_arm9_ptr(field_system) then
    return {}, 0, nil, "not_validated", {
      { source = "FieldSystem.saveData SaveArray_Get(SAVE_PARTY).PartyCore", validation = "no_valid_field_system" },
    }
  end
  local save_data = u32(field_system + 0x0C)
  local party_core, header, reason = save_array_from_save_data(save_data, SAVE_PARTY, HGSS_PARTY_SAVE_ARRAY_SIZE, HGSS_PARTY_SAVE_ARRAY_SIZE)
  local source = "FieldSystem.saveData SaveArray_Get(SAVE_PARTY).PartyCore"
  if party_core == nil then
    return {}, 0, source, "not_validated", {
      { source = source, validation = reason or "save_party_unavailable", saveDataPtr = save_data, header = header },
    }
  end
  local max_count = u32(party_core + 0x00)
  local count = u32(party_core + 0x04)
  local party_validation_contract = "ram_save_party_header_validated_with_pokemon_checksum_and_stats"
  local evaluation = {
    source = source,
    saveDataPtr = save_data,
    partyCorePtr = party_core,
    header = header,
    expectedPartyCoreSize = PARTY_CORE_SIZE,
    expectedPayloadSize = HGSS_PARTY_SIZE,
    expectedSaveArraySize = HGSS_PARTY_SAVE_ARRAY_SIZE,
    monsOffset = PARTY_MONS_OFFSET,
    monSize = PARTY_MON_SIZE,
    maxCount = max_count,
    count = count,
    valid_count = count ~= nil and count >= 0 and count <= PARTY_MAX_COUNT,
    valid_max_count = max_count == PARTY_MAX_COUNT,
    valid_decoded = 0,
    stats_valid = 0,
    validation = "invalid_count",
  }
  if header == nil or header.size ~= HGSS_PARTY_SAVE_ARRAY_SIZE then
    evaluation.validation = "invalid_save_party_header_size"
    evaluations[#evaluations + 1] = evaluation
    return {}, 0, source, "not_validated", evaluations
  end
  if max_count ~= PARTY_MAX_COUNT then
    evaluation.validation = "invalid_max_count"
    evaluations[#evaluations + 1] = evaluation
    return {}, 0, source, "not_validated", evaluations
  end
  if count == nil or count < 0 or count > PARTY_MAX_COUNT then
    evaluations[#evaluations + 1] = evaluation
    return {}, 0, source, "not_validated", evaluations
  end
  local party = {}
  for i = 0, count - 1 do
    local mon = decrypt_party_mon(party_core + PARTY_MONS_OFFSET + i * PARTY_MON_SIZE)
    if mon then
      mon.slot_id = i + 1
      party[#party + 1] = mon
      evaluation.valid_decoded = evaluation.valid_decoded + 1
      if party_mon_stats_reasonable(mon) then evaluation.stats_valid = evaluation.stats_valid + 1 end
    end
  end
  if count == 0 then
    evaluation.validation = "empty_party"
  elseif evaluation.valid_decoded == count and evaluation.stats_valid == count then
    evaluation.validation = "checksum_and_stats_validated"
  elseif evaluation.valid_decoded == count then
    evaluation.validation = "checksum_validated_stats_failed"
  else
    evaluation.validation = "checksum_failed"
  end
  evaluations[#evaluations + 1] = evaluation
  if count == 0 or evaluation.validation == "checksum_and_stats_validated" then
    return party, count, source, party_validation_contract, evaluations
  end
  if evaluation.validation == "checksum_validated_stats_failed" then
    return party, count, source, "checksum_validated_partial_stats", evaluations
  end
  return {}, 0, source, "not_validated", evaluations
end

function decode_battle_enemy_party(base)
  if base == nil then
    return {}, 0, nil, "not_validated", {}
  end
  local candidates = {}
  local enemy_pointer = u32(base + 0x37970)
  if valid_arm9_ptr(enemy_pointer) then
    candidates[#candidates + 1] = {
      party_addr = enemy_pointer + 0x1C70,
      source = "TASVideos base+0x37970 enemy pointer +0x1C70",
      pointer_addr = base + 0x37970,
      pointer = enemy_pointer,
      max_slots = 6,
    }
  end
  candidates[#candidates + 1] = {
    party_addr = base + 0x38540,
    source = "TASVideos base+0x38540 wild encounter Pokemon",
    pointer_addr = base + 0x38540,
    pointer = nil,
    max_slots = 1,
  }

  local evaluations = {}
  local best = nil
  for _, candidate in ipairs(candidates) do
    local party = {}
    local valid_decoded = 0
    local stats_valid = 0
    for i = 0, (candidate.max_slots or 1) - 1 do
      local mon = decrypt_party_mon(candidate.party_addr + i * 0xEC)
      if mon and party_mon_stats_reasonable(mon) then
        mon.slot_id = i + 1
        party[#party + 1] = mon
        valid_decoded = valid_decoded + 1
        stats_valid = stats_valid + 1
      elseif mon then
        mon.slot_id = i + 1
        party[#party + 1] = mon
        valid_decoded = valid_decoded + 1
      end
    end
    local evaluation = {
      source = candidate.source,
      pointer_addr = candidate.pointer_addr,
      pointer = candidate.pointer,
      party_addr = candidate.party_addr,
      max_slots = candidate.max_slots,
      valid_decoded = valid_decoded,
      stats_valid = stats_valid,
      validation = stats_valid > 0 and "checksum_and_stats_validated" or (valid_decoded > 0 and "checksum_validated_stats_failed" or "not_found"),
    }
    evaluations[#evaluations + 1] = evaluation
    if stats_valid > 0 and (best == nil or stats_valid > best.count) then
      best = { party = party, count = stats_valid, source = candidate.source, validation = evaluation.validation }
    end
  end

  if best then
    return best.party, best.count, best.source, best.validation, evaluations
  end
  return {}, 0, nil, "not_validated", evaluations
end

function read_hgss_inline_string(addr, max_words)
  if not valid_arm9_ptr(addr) then return nil, "invalid_string_addr" end
  local words = {}
  for i = 0, (max_words or 8) - 1 do
    local word = u16(addr + i * 2)
    if word == nil then return nil, "read_failed" end
    words[#words + 1] = word
    if word == STRING_EOS then break end
  end
  if #words == 0 or words[1] == STRING_EOS then return nil, "empty_string" end
  local ratio = hgss_words_printable_ratio(words)
  if ratio < 0.60 then return nil, "low_printable_ratio" end
  return {
    words = words,
    printableRatio = ratio,
    preview = decode_hgss_words_preview(words),
  }, nil
end

function crc16_ccitt_byte(crc, byte)
  crc = crc ~ ((byte & 0xFF) << 8)
  for _ = 1, 8 do
    if (crc & 0x8000) ~= 0 then
      crc = ((crc << 1) ~ 0x1021) & 0xFFFF
    else
      crc = (crc << 1) & 0xFFFF
    end
  end
  return crc & 0xFFFF
end

function crc16_ccitt_at(addr, size, initial)
  if not valid_arm9_ptr(addr) or size == nil or size < 0 then return nil end
  local crc = initial or 0
  for i = 0, size - 1 do
    local value = u8(addr + i)
    if value == nil then return nil end
    crc = crc16_ccitt_byte(crc, value)
  end
  return crc & 0xFFFF
end

function crc16_ccitt_reflected_byte(crc, byte)
  crc = crc ~ (byte & 0xFF)
  for _ = 1, 8 do
    if (crc & 0x0001) ~= 0 then
      crc = ((crc >> 1) ~ 0x8408) & 0xFFFF
    else
      crc = (crc >> 1) & 0xFFFF
    end
  end
  return crc & 0xFFFF
end

function crc16_ccitt_reflected_at(addr, size, initial)
  if not valid_arm9_ptr(addr) or size == nil or size < 0 then return nil end
  local crc = initial or 0
  for i = 0, size - 1 do
    local value = u8(addr + i)
    if value == nil then return nil end
    crc = crc16_ccitt_reflected_byte(crc, value)
  end
  return crc & 0xFFFF
end

function save_array_crc_validation(data_ptr, header_size, expected_crc)
  if not valid_arm9_ptr(data_ptr) then
    return false, {
      status = "invalid",
      reason = "save_array_data_pointer_invalid",
    }
  end
  if header_size == nil or header_size <= SAVE_CHUNK_CRC_TRAILER_SIZE then
    return false, {
      status = "invalid",
      reason = "save_array_size_too_small_for_crc_trailer",
    }
  end
  local payload_size = header_size - SAVE_CHUNK_CRC_TRAILER_SIZE
  local stored_crc = u16(data_ptr + payload_size)
  if stored_crc == nil then
    return false, {
      status = "invalid",
      reason = "save_array_stored_crc_unreadable",
      payloadSize = payload_size,
    }
  end
  local calc_0000 = crc16_ccitt_at(data_ptr, payload_size, 0)
  local calc_header_0000 = crc16_ccitt_at(data_ptr, header_size, 0)
  local calc_ffff = crc16_ccitt_at(data_ptr, payload_size, 0xFFFF)
  local calc_header_ffff = crc16_ccitt_at(data_ptr, header_size, 0xFFFF)
  local reflected_calc_0000 = crc16_ccitt_reflected_at(data_ptr, payload_size, 0)
  local reflected_header_0000 = crc16_ccitt_reflected_at(data_ptr, header_size, 0)
  local reflected_calc_ffff = crc16_ccitt_reflected_at(data_ptr, payload_size, 0xFFFF)
  local reflected_header_ffff = crc16_ccitt_reflected_at(data_ptr, header_size, 0xFFFF)
  local valid_ffff = calc_ffff ~= nil and calc_ffff == stored_crc
  local valid_header = expected_crc ~= nil and expected_crc == calc_header_ffff
  local ok = valid_ffff and valid_header
  return ok, {
    status = ok and "validated" or "invalid",
    reason = ok and "save_substruct_crc16_ccitt_validated" or "save_substruct_crc16_ccitt_mismatch",
    payloadSize = payload_size,
    storedCrc = stored_crc,
    headerCrc = expected_crc,
    calculatedCrc0000 = calc_0000,
    calculatedHeaderCrc0000 = calc_header_0000,
    calculatedCrcFFFF = calc_ffff,
    calculatedHeaderCrcFFFF = calc_header_ffff,
    calculatedReflectedCrc0000 = reflected_calc_0000,
    calculatedReflectedHeaderCrc0000 = reflected_header_0000,
    calculatedReflectedCrcFFFF = reflected_calc_ffff,
    calculatedReflectedHeaderCrcFFFF = reflected_header_ffff,
    reflectedVariant = "crc16_ccitt_reflected",
    variant = valid_ffff and "crc16_ccitt_initial_ffff" or "none",
  }
end

function saveArrayFailureDiagnostics(save_id, header_id, header_size, header_offset, header_crc, header_slot, expected_block_id, slot_spec, footer_validation, crc_validation, save_data_validation)
  return {
    id = header_id,
    requestedId = save_id,
    size = header_size,
    offset = header_offset,
    crc = header_crc,
    slot = header_slot,
    blockId = header_slot,
    expectedBlockId = expected_block_id,
    validation = "save_array_header_validation_failed",
    slotSpec = slot_spec,
    chunkFooterValidation = footer_validation,
    crcValidation = crc_validation,
    saveDataValidation = save_data_validation,
  }
end

function expected_save_array_block_id(save_id)
  if save_id == SAVE_PCSTORAGE then
    return 1
  end
  return 0
end

function save_slot_spec_from_save_data(save_data, slot)
  if not valid_arm9_ptr(save_data) then
    return nil, "no_valid_save_data_pointer"
  end
  if slot == nil or slot < 0 or slot > 1 then
    return nil, "save_slot_spec_slot_unreasonable"
  end
  local spec = save_data + SAVE_SLOT_SPECS_OFFSET + slot * SAVE_SLOT_SPEC_SIZE
  local id = u8(spec + 0x00)
  local first_page = u8(spec + 0x01)
  local num_pages = u8(spec + 0x02)
  local offset = u32(spec + 0x04)
  local size = u32(spec + 0x08)
  if id ~= slot then
    return nil, "save_slot_spec_id_mismatch"
  end
  if offset == nil or size == nil or size <= SAVE_CHUNK_FOOTER_SIZE then
    return nil, "save_slot_spec_size_unreasonable"
  end
  if offset >= SAVE_DYNAMIC_REGION_SIZE or (offset + size) > SAVE_DYNAMIC_REGION_SIZE then
    return nil, "save_slot_spec_region_out_of_dynamic_bounds"
  end
  local expected_pages = math.floor((size + SAVE_SECTOR_SIZE - 1) / SAVE_SECTOR_SIZE)
  if num_pages == nil or num_pages ~= expected_pages then
    return nil, "save_slot_spec_num_pages_mismatch"
  end
  if first_page == nil or first_page < 0 or first_page >= SAVE_PAGE_MAX then
    return nil, "save_slot_spec_first_page_out_of_bounds"
  end
  if (first_page + num_pages) > SAVE_PAGE_MAX then
    return nil, "save_slot_spec_pages_out_of_bounds"
  end
  local expected_first_page = nil
  if slot == 0 then
    expected_first_page = 0
  elseif slot == 1 then
    local slot_0 = save_slot_spec_from_save_data(save_data, 0)
    if slot_0 == nil then
      return nil, "save_slot_spec_slot0_required_for_slot1_continuity"
    end
    expected_first_page = slot_0.firstPage + slot_0.numPages
  end
  if expected_first_page ~= nil and first_page ~= expected_first_page then
    return nil, "save_slot_spec_first_page_continuity_mismatch"
  end
  return {
    id = id,
    firstPage = first_page,
    numPages = num_pages,
    offset = offset,
    size = size,
  }, nil
end

function save_chunk_footer_metadata(save_data, slot)
  local spec, spec_reason = save_slot_spec_from_save_data(save_data, slot)
  if spec == nil then
    return false, {
      status = "invalid",
      reason = spec_reason,
      slot = slot,
    }
  end
  local chunk_ptr = save_data + SAVE_DYNAMIC_REGION_OFFSET + spec.offset
  local footer = chunk_ptr + spec.size - SAVE_CHUNK_FOOTER_SIZE
  if not valid_arm9_ptr(chunk_ptr) or not valid_arm9_ptr(footer) then
    return false, {
      status = "invalid",
      reason = "save_chunk_footer_pointer_invalid",
      slot = slot,
      slotSpec = spec,
    }
  end
  local count = u32(footer + 0x00)
  local size = u32(footer + 0x04)
  local magic = u32(footer + 0x08)
  local footer_slot = u16(footer + 0x0C)
  local stored_crc = u16(footer + 0x0E)
  if size ~= spec.size then
    return false, {
      status = "invalid",
      reason = "save_chunk_footer_size_mismatch",
      slot = slot,
      slotSpec = spec,
      footerSize = size,
    }
  end
  if magic ~= SAVE_CHUNK_MAGIC then
    return false, {
      status = "invalid",
      reason = "save_chunk_footer_magic_mismatch",
      slot = slot,
      slotSpec = spec,
      footerMagic = magic,
    }
  end
  if footer_slot ~= slot then
    return false, {
      status = "invalid",
      reason = "save_chunk_footer_slot_mismatch",
      slot = slot,
      slotSpec = spec,
      footerSlot = footer_slot,
    }
  end
  return true, {
    status = "validated",
    reason = "current_live_chunk_footer_metadata_validated",
    slot = slot,
    slotSpec = spec,
    count = count,
    size = size,
    magic = magic,
    footerSlot = footer_slot,
    storedCrc = stored_crc,
  }
end

function save_chunk_footer_validation(save_data, slot)
  local metadata_ok, metadata = save_chunk_footer_metadata(save_data, slot)
  if not metadata_ok then
    return false, metadata
  end
  local spec = metadata.slotSpec
  local chunk_ptr = save_data + SAVE_DYNAMIC_REGION_OFFSET + spec.offset
  local payload_size = spec.size - SAVE_CHUNK_FOOTER_SIZE
  local calc_0000 = crc16_ccitt_at(chunk_ptr, payload_size, 0)
  local calc_ffff = crc16_ccitt_at(chunk_ptr, payload_size, 0xFFFF)
  local reflected_calc_0000 = crc16_ccitt_reflected_at(chunk_ptr, payload_size, 0)
  local reflected_calc_ffff = crc16_ccitt_reflected_at(chunk_ptr, payload_size, 0xFFFF)
  local stored_crc = metadata.storedCrc
  local valid_ffff = calc_ffff ~= nil and calc_ffff == stored_crc
  local ok = valid_ffff
  return ok, {
    status = ok and "validated" or "invalid",
    reason = ok and "save_chunk_footer_crc16_ccitt_validated" or "save_chunk_footer_crc16_ccitt_mismatch",
    slot = slot,
    slotSpec = spec,
    count = metadata.count,
    size = metadata.size,
    magic = metadata.magic,
    footerSlot = metadata.footerSlot,
    storedCrc = stored_crc,
    calculatedCrc0000 = calc_0000,
    calculatedCrcFFFF = calc_ffff,
    calculatedReflectedCrc0000 = reflected_calc_0000,
    calculatedReflectedCrcFFFF = reflected_calc_ffff,
    reflectedVariant = "crc16_ccitt_reflected",
    variant = valid_ffff and "crc16_ccitt_initial_ffff" or "none",
  }
end

function save_data_runtime_validation(save_data)
  if not valid_arm9_ptr(save_data) then
    return {
      status = "invalid",
      reason = "no_valid_save_data_pointer",
    }
  end
  local save_counter = u32(save_data + SAVE_COUNTER_OFFSET)
  local last_good_save_slot = u32(save_data + SAVE_LAST_GOOD_SAVE_SLOT_OFFSET)
  local last_good_save_no = u32(save_data + SAVE_LAST_GOOD_SAVE_NO_OFFSET)
  local last_good_sector = u16(save_data + SAVE_LAST_GOOD_SECTOR_OFFSET)
  local chunk_0_ok, chunk_0 = save_chunk_footer_validation(save_data, 0)
  local chunk_1_ok, chunk_1 = save_chunk_footer_validation(save_data, 1)
  local sane_sector = last_good_sector == 0 or last_good_sector == 1
  local matching_counts = chunk_0_ok and chunk_1_ok
    and chunk_0.count ~= nil
    and save_counter ~= nil
    and chunk_0.count == chunk_1.count
    and save_counter == chunk_0.count
  local loaded_count_ok = sane_sector
    and chunk_0_ok and chunk_1_ok
    and ((last_good_sector == 0 and chunk_0.count == save_counter) or (last_good_sector == 1 and chunk_1.count == save_counter))
  local ok = chunk_0_ok and chunk_1_ok and sane_sector and matching_counts and loaded_count_ok
  return {
    status = ok and "validated" or "invalid",
    reason = ok and "save_data_chunk_footers_and_loaded_sector_validated" or "save_data_chunk_footer_validation_failed",
    saveCounter = save_counter,
    lastGoodSaveSlot = last_good_save_slot,
    lastGoodSaveNo = last_good_save_no,
    lastGoodSector = last_good_sector,
    loadedSectorValid = sane_sector,
    chunkCountsMatch = matching_counts,
    loadedSectorCountMatchesSaveCounter = loaded_count_ok,
    chunkFooters = {
      [1] = chunk_0,
      [2] = chunk_1,
    },
  }
end

function save_array_from_save_data(save_data, save_id, min_size, max_size)
  if not valid_arm9_ptr(save_data) then
    return nil, nil, "no_valid_save_data_pointer"
  end
  local header = save_data + SAVE_ARRAY_HEADERS_OFFSET + save_id * 0x10
  local header_id = u32(header + 0x00)
  local header_size = u32(header + 0x04)
  local header_offset = u32(header + 0x08)
  local header_crc = u16(header + 0x0C)
  local header_slot = u16(header + 0x0E)
  if header_id ~= save_id then
    return nil, nil, "save_array_header_id_mismatch"
  end
  if header_slot == nil or header_slot > 1 then
    return nil, nil, "save_array_header_slot_unreasonable"
  end
  local expected_block_id = expected_save_array_block_id(save_id)
  if header_slot ~= expected_block_id then
    return nil, nil, "save_array_header_block_id_mismatch"
  end
  if header_offset == nil or header_offset < 0 or header_offset >= 0x23000 then
    return nil, nil, "save_array_header_offset_unreasonable"
  end
  if header_size == nil or header_size < (min_size or 1) then
    return nil, nil, "save_array_header_size_too_small"
  end
  if max_size ~= nil and header_size > max_size then
    return nil, nil, "save_array_header_size_unreasonable"
  end
  local slot_spec, slot_spec_reason = save_slot_spec_from_save_data(save_data, header_slot)
  if slot_spec == nil then
    return nil, nil, slot_spec_reason or "save_array_slot_spec_validation_failed"
  end
  if header_offset < slot_spec.offset or (header_offset + header_size) > (slot_spec.offset + slot_spec.size - SAVE_CHUNK_FOOTER_SIZE) then
    return nil, nil, "save_array_outside_validated_chunk_region"
  end
  local footer_ok, footer_validation = save_chunk_footer_metadata(save_data, header_slot)
  local data_ptr = save_data + SAVE_DYNAMIC_REGION_OFFSET + header_offset
  if not footer_ok then
    return nil, saveArrayFailureDiagnostics(save_id, header_id, header_size, header_offset, header_crc, header_slot, expected_block_id, slot_spec, footer_validation, nil, nil), footer_validation.reason or "save_array_chunk_footer_validation_failed"
  end
  return data_ptr, {
    id = header_id,
    size = header_size,
    offset = header_offset,
    crc = header_crc,
    slot = header_slot,
    blockId = header_slot,
    expectedBlockId = expected_block_id,
    validation = "save_array_header_bounds_current_live",
    currentLiveData = true,
    liveFooterStale = true,
    crcValidation = {
      status = "diagnostic",
      reason = "current_live_array_crc_not_required",
    },
    chunkFooterValidation = footer_validation,
    slotSpec = slot_spec,
    saveDataValidation = {
      status = "diagnostic",
      reason = "save_data_chunk_footer_stale_after_live_mutation",
    },
  }, nil
end

function decode_saved_map_objects_from_field_system(field_system)
  local source = "FieldSystem.saveData SaveArray_Get(SAVE_MAP_OBJECTS).SavedMapObjectList"
  if not valid_arm9_ptr(field_system) then
    return {
      available = false,
      source = source,
      validation = "no_valid_field_system",
      contract = "save_map_objects_restore_slots_monitor_only_v1",
    }, "no_valid_field_system"
  end
  local save_data = u32(field_system + 0x0C)
  local payload, header, reason = save_array_from_save_data(
    save_data,
    SAVE_MAP_OBJECTS,
    HGSS_SAVE_MAP_OBJECTS_SAVE_ARRAY_SIZE,
    HGSS_SAVE_MAP_OBJECTS_SAVE_ARRAY_SIZE
  )
  if payload == nil then
    return {
      available = false,
      source = source,
      validation = reason or "save_map_objects_header_validation_failed",
      contract = "save_map_objects_restore_slots_monitor_only_v1",
      saveDataPtr = save_data,
    }, reason
  end

  local entries = {}
  for i = 0, HGSS_SAVE_MAP_OBJECTS_COUNT - 1 do
    local p = payload + i * HGSS_SAVED_MAP_OBJECT_SIZE
    local flags = u32(p + 0x00)
    entries[#entries + 1] = {
      slot = i,
      active = bit_is_set(flags, 0x00000001),
      visible_flag = bit_is_set(flags, 0x00000200),
      flagsHex = string.format("0x%08X", flags or 0),
      flags2Hex = string.format("0x%08X", u32(p + 0x04) or 0),
      object_id = u8(p + 0x08),
      movement = u8(p + 0x09),
      map_id = u16(p + 0x10),
      sprite_id = u16(p + 0x12),
      object_type = u16(p + 0x14),
      event_flag = u16(p + 0x16),
      script_id = u16(p + 0x18),
      initial_x = s16(p + 0x20),
      initial_y = s16(p + 0x22),
      initial_z = s16(p + 0x24),
      x = s16(p + 0x26),
      y = s16(p + 0x28),
      z = s16(p + 0x2A),
      source = source,
    }
  end

  return {
    available = true,
    source = source,
    validation = "save_map_objects_header_crc_validated_restore_slots_v1",
    contract = "save_map_objects_restore_slots_monitor_only_v1",
    header = header,
    count = #entries,
    entries = entries,
  }, nil
end

function decode_progress_flags_from_field_system(field_system)
  if not valid_arm9_ptr(field_system) then
    return nil, "no_valid_field_system"
  end
  local save_data = u32(field_system + 0x0C)
  local vars_flags, header, reason = save_array_from_save_data(save_data, SAVE_FLAGS, HGSS_SAVE_VARS_FLAGS_SAVE_ARRAY_SIZE, HGSS_SAVE_VARS_FLAGS_SAVE_ARRAY_SIZE)
  if vars_flags == nil then
    return nil, reason
  end

  local function script_flag(flag_id)
    local value = u8(vars_flags + SAVE_VARS_FLAGS_FLAGS_OFFSET + math.floor(flag_id / 8))
    if value == nil then return nil end
    return (value & (1 << (flag_id % 8))) ~= 0
  end

  local starter_species_id = u16(vars_flags + (VAR_PLAYER_STARTER - VAR_BASE) * 2)
  if starter_species_id ~= nil and (starter_species_id < 0 or starter_species_id > 65535) then
    starter_species_id = nil
  end

  return {
    source = "FieldSystem.saveData SaveArray_Get(SAVE_FLAGS).SaveVarsFlags",
    saveDataPtr = save_data,
    saveFlagsPtr = vars_flags,
    header = header,
    validation = "validated_save_vars_flags_header_and_named_bits",
    got_starter = script_flag(FLAG_GOT_STARTER),
    got_pokedex = script_flag(FLAG_GOT_POKEDEX),
    got_pokegear = script_flag(FLAG_GOT_POKEGEAR),
    got_bag = script_flag(FLAG_GOT_BAG),
    strength_enabled = script_flag(FLAG_STRENGTH_ACTIVE),
    safari_zone_active = script_flag(FLAG_SYS_SAFARI),
    flash_active = script_flag(FLAG_SYS_FLASH),
    defog_active = script_flag(FLAG_SYS_DEFOG),
    starter_species_id = starter_species_id,
  }, nil
end

function decode_local_field_data_from_field_system(field_system)
  if not valid_arm9_ptr(field_system) then
    return nil, "no_valid_field_system"
  end
  local save_data = u32(field_system + 0x0C)
  local local_field_data, header, reason = save_array_from_save_data(
    save_data,
    SAVE_LOCAL_FIELD_DATA,
    HGSS_SAVE_LOCAL_FIELD_DATA_SAVE_ARRAY_SIZE,
    HGSS_SAVE_LOCAL_FIELD_DATA_SAVE_ARRAY_SIZE
  )
  if local_field_data == nil then
    return nil, reason
  end

  return {
    source = "FieldSystem.saveData SaveArray_Get(SAVE_LOCAL_FIELD_DATA).LocalFieldData",
    saveDataPtr = save_data,
    localFieldDataPtr = local_field_data,
    header = header,
    validation = "validated_local_field_data_header_and_safari_counters",
    weather = u16(local_field_data + 0x64),
    safari_steps_counter = u16(local_field_data + 0x76),
    safari_balls_remaining = u16(local_field_data + 0x78),
  }, nil
end

function decode_pc_storage_from_field_system(field_system)
  if not valid_arm9_ptr(field_system) then
    return nil, "no_valid_field_system"
  end
  local save_data = u32(field_system + 0x0C)
  local pc_storage, header, reason = save_array_from_save_data(save_data, SAVE_PCSTORAGE, 0x122FC, 0x12300)
  if pc_storage == nil then
    return nil, reason
  end

  local current_box = signed32(u32(pc_storage + 0x12000) or 0)
  if current_box == nil or current_box < 0 or current_box >= PC_BOX_COUNT then
    return nil, "pc_current_box_out_of_range"
  end
  local boxes = {}
  local total_mons = 0
  for box_index = 0, PC_BOX_COUNT - 1 do
    local mons = {}
    local box_count = 0
    local box_base = pc_storage + box_index * PC_BOX_SIZE
    for slot_index = 0, PC_MONS_PER_BOX - 1 do
      local mon = decrypt_box_mon(box_base + slot_index * PC_BOX_MON_SIZE)
      if mon ~= nil then
        mon.box_index = box_index
        mon.box_slot = slot_index
        mons[#mons + 1] = mon
        box_count = box_count + 1
        total_mons = total_mons + 1
      end
    end
    boxes[#boxes + 1] = {
      box_index = box_index,
      box_number = box_index + 1,
      count = box_count,
      mons = mons,
      wallpaper = u8(pc_storage + 0x122D8 + box_index) or 0,
    }
  end

  return {
    source = "FieldSystem.saveData SaveArray_Get(SAVE_PCSTORAGE).PokemonStorageSystem",
    validation = "validated_pc_storage_header_and_box_mon_checksums",
    saveDataPtr = save_data,
    pcStoragePtr = pc_storage,
    header = header,
    current_box = current_box + 1,
    current_box_index = current_box,
    total_mons = total_mons,
    boxes = boxes,
    box_count = PC_BOX_COUNT,
    mons_per_box = PC_MONS_PER_BOX,
  }, nil
end

function pokedex_status_label(raw_status)
  if raw_status == 2 then return "caught" end
  if raw_status == 1 then return "seen" end
  if raw_status == 0 then return "unknown" end
  return nil
end

function pokedex_mode_label(mode)
  if mode == 1 then return "National Dex" end
  return "Johto Dex"
end

function pokedex_check_flag(flag_base, species)
  if not valid_arm9_ptr(flag_base) or species == nil or species <= 0 or species > 493 then
    return false
  end
  local flag_id = species - 1
  local word_index = math.floor(flag_id / 32)
  local bit_index = flag_id % 32
  if word_index < 0 or word_index >= POKEDEX_FLAG_WORDS then
    return false
  end
  local word = u32(flag_base + word_index * 4)
  if word == nil then return false end
  return ((word >> bit_index) & 1) ~= 0
end

function decode_pokedex_overlay(field_system)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "pokedex_no_valid_field_system" }
  end
  local save_data = u32(field_system + 0x0C)
  if not valid_arm9_ptr(save_data) then
    return { active = false, reason = "pokedex_no_valid_save_data", fieldSystemPtr = field_system }
  end
  local field_system_sub0 = u32(field_system + 0x00)
  if not valid_arm9_ptr(field_system_sub0) then
    return { active = false, reason = "pokedex_no_field_system_sub0", fieldSystemPtr = field_system }
  end
  local overlay_manager = u32(field_system_sub0 + 0x04)
  if not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "pokedex_no_active_application", fieldSystemPtr = field_system, fieldSystemSub0Ptr = field_system_sub0 }
  end
  local ovy_id = signed32(u32(overlay_manager + 0x0C))
  if ovy_id ~= POKEDEX_APP_OVERLAY_ID then
    return { active = false, reason = "pokedex_active_application_not_pokedex", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, ovyId = ovy_id }
  end

  local args = u32(overlay_manager + 0x18)
  local app = u32(overlay_manager + 0x1C)
  if not valid_arm9_ptr(args) or not valid_arm9_ptr(app) then
    return { active = false, reason = "pokedex_no_args_or_appdata", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app }
  end

  local args_pokedex = u32(args + 0x00)
  local app_args = u32(app + 0x00)
  if not valid_arm9_ptr(args_pokedex) then
    return { active = false, reason = "pokedex_args_pokedex_pointer_invalid", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, pokedexPtr = args_pokedex }
  end
  local pokedex_save, header, header_reason = pokedex_save_array_from_overlay_args(save_data, args_pokedex)
  if not valid_arm9_ptr(pokedex_save) then
    return {
      active = false,
      reason = "pokedex_overlay_args_pokedex_save_not_validated",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      saveDataPtr = save_data,
      pokedexArgsPtr = args,
      pokedexAppPtr = app,
      pokedexPtr = args_pokedex,
      validationReason = header_reason,
      saveHeaderDiagnostic = header,
    }
  end
  local magic = u32(args_pokedex)
  local save_magic = u32(pokedex_save)
  if app_args ~= args or magic ~= POKEDEX_MAGIC or save_magic ~= POKEDEX_MAGIC then
    return {
      active = false,
      reason = "pokedex_args_or_save_backlink_mismatch",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      pokedexArgsPtr = args,
      pokedexAppPtr = app,
      pokedexPtr = args_pokedex,
      expectedPokedexPtr = pokedex_save,
      appArgsPtr = app_args,
      pokedexMagic = magic,
      savePokedexMagic = save_magic,
      saveHeaderValidation = header and header.saveHeaderValidation or nil,
      saveHeaderDiagnostic = header and header.saveHeaderDiagnostic or nil,
    }
  end

  local main_seq = signed32(u32(app + 0x085C))
  if main_seq ~= 5 then
    return { active = false, reason = "pokedex_not_current_list_main_sequence", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, mainSeq = main_seq }
  end

  local mode = u8(app + 0x1858)
  local page_index = u8(app + 0x1859)
  local cursor_slot = u8(app + 0x185A)
  local screen_mode = u8(app + 0x185B)
  local nat_dex_enabled = u32(app + 0x1860)
  if mode == nil or mode < 0 or mode > 1 then
    return { active = false, reason = "pokedex_mode_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, pokedexMode = mode }
  end
  if mode == 1 and nat_dex_enabled == 0 then
    return { active = false, reason = "pokedex_national_mode_without_natdex", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, pokedexMode = mode, natDexEnabled = nat_dex_enabled }
  end
  if page_index == nil or cursor_slot == nil or cursor_slot < 0 or cursor_slot >= POKEDEX_LIST_PAGE_SIZE then
    return { active = false, reason = "pokedex_cursor_or_page_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, pageIndex = page_index, cursorSlot = cursor_slot }
  end

  local selected_index = page_index * POKEDEX_LIST_PAGE_SIZE + cursor_slot
  if selected_index < 0 or selected_index >= POKEDEX_LIST_ENTRY_COUNT then
    return { active = false, reason = "pokedex_selected_entry_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, pageIndex = page_index, cursorSlot = cursor_slot, entryIndex = selected_index }
  end

  local seen_flags = pokedex_save + 0x44
  local caught_flags = pokedex_save + 0x04
  local flags_crosscheck_available =
    header ~= nil and
    header.saveHeaderDiagnostic ~= nil and
    header.saveHeaderDiagnostic.status == "validated"
  local items = {}
  local cursor_text = nil
  for slot = 0, POKEDEX_LIST_PAGE_SIZE - 1 do
    local entry_index = page_index * POKEDEX_LIST_PAGE_SIZE + slot
    if entry_index < POKEDEX_LIST_ENTRY_COUNT then
      local entry_addr = app + 0x1030 + entry_index * 4
      local species_id = u16(entry_addr)
      local status_raw = u16(entry_addr + 0x02)
      local status = pokedex_status_label(status_raw)
      if species_id == nil or status == nil then
        return { active = false, reason = "pokedex_entry_read_or_status_failed", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, entryIndex = entry_index, speciesId = species_id, statusRaw = status_raw }
      end
      if species_id == 0 then
        if status_raw ~= 0 then
          return { active = false, reason = "pokedex_empty_entry_status_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, entryIndex = entry_index, speciesId = species_id, statusRaw = status_raw }
        end
        local selected = slot == cursor_slot
        items[#items + 1] = { speciesId = 0, status = "unknown", selected = selected, statusRaw = status_raw, entryIndex = entry_index }
        if selected then cursor_text = "???" end
      elseif species_id >= 1 and species_id <= 493 then
        if flags_crosscheck_available then
          local seen = pokedex_check_flag(seen_flags, species_id)
          local caught = pokedex_check_flag(caught_flags, species_id)
          local expected_status = caught and 2 or (seen and 1 or 0)
          if status_raw ~= expected_status then
            return { active = false, reason = "pokedex_entry_seen_caught_flag_mismatch", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, entryIndex = entry_index, speciesId = species_id, statusRaw = status_raw, expectedStatusRaw = expected_status }
          end
        end
        local selected = slot == cursor_slot
        items[#items + 1] = { speciesId = species_id, status = status, selected = selected, statusRaw = status_raw, entryIndex = entry_index }
        if selected and status == "unknown" then cursor_text = "???" end
      else
        return { active = false, reason = "pokedex_entry_species_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pokedexArgsPtr = args, pokedexAppPtr = app, entryIndex = entry_index, speciesId = species_id, statusRaw = status_raw }
      end
    end
  end

  return {
    active = true,
    source = "PokedexOverlayManager.args.PokedexArgs",
    confidence = "validated_ram",
    contract = "ram_pokedex_overlay_args_current_list_cursor_v1",
    validation = "pokedex_overlay_args_current_list_cursor_validated",
    title = "Pokedex",
    mode = pokedex_mode_label(mode),
    cursor = cursor_text,
    items = items,
    overlayManagerPtr = overlay_manager,
    pokedexArgsPtr = args,
    pokedexAppPtr = app,
    pokedexPtr = args_pokedex,
    saveDataPtr = save_data,
    savePokedexPtr = pokedex_save,
    header = header,
    ovyId = ovy_id,
    mainSeq = main_seq,
    pokedexMode = mode,
    screenMode = screen_mode,
    natDexEnabled = nat_dex_enabled,
    pageIndex = page_index,
    cursorSlot = cursor_slot,
    entryIndex = selected_index,
    saveHeaderValidation = header and header.saveHeaderValidation or nil,
    saveHeaderDiagnostic = header and header.saveHeaderDiagnostic or nil,
  }
end

function pokedex_save_array_from_overlay_args(save_data, args_pokedex)
  if not valid_arm9_ptr(save_data) then
    return nil, nil, "no_valid_save_data_pointer"
  end
  if not valid_arm9_ptr(args_pokedex) then
    return nil, nil, "pokedex_args_pokedex_pointer_invalid"
  end
  local save_payload, save_header, save_reason =
    save_array_from_save_data(save_data, SAVE_POKEDEX, HGSS_POKEDEX_SAVE_ARRAY_SIZE, HGSS_POKEDEX_SAVE_ARRAY_SIZE)
  if valid_arm9_ptr(save_payload) then
    save_header.saveHeaderValidation = save_header.validation
    save_header.saveHeaderDiagnostic = save_header.chunkFooterValidation
    if save_payload ~= args_pokedex then
      return nil, save_header, "pokedex_args_pokedex_pointer_header_mismatch"
    end
    return save_payload, save_header, nil
  end

  local header = save_data + SAVE_ARRAY_HEADERS_OFFSET + SAVE_POKEDEX * 0x10
  local header_id = u32(header + 0x00)
  local header_size = u32(header + 0x04)
  local header_offset = u32(header + 0x08)
  local header_crc = u16(header + 0x0C)
  local header_slot = u16(header + 0x0E)
  local expected_block_id = expected_save_array_block_id(SAVE_POKEDEX)
  if header_id ~= SAVE_POKEDEX then
    return nil, nil, "save_array_header_id_mismatch"
  end
  if header_slot == nil or header_slot > 1 then
    return nil, nil, "save_array_header_slot_unreasonable"
  end
  if header_slot ~= expected_block_id then
    return nil, nil, "save_array_header_block_id_mismatch"
  end
  if header_offset == nil or header_offset < 0 or header_offset >= SAVE_DYNAMIC_REGION_SIZE then
    return nil, nil, "save_array_header_offset_unreasonable"
  end
  if header_size == nil or header_size < HGSS_POKEDEX_SAVE_ARRAY_SIZE or header_size > HGSS_POKEDEX_SAVE_ARRAY_SIZE then
    return nil, nil, "save_array_header_size_unreasonable"
  end
  local slot_spec, slot_spec_reason = save_slot_spec_from_save_data(save_data, header_slot)
  if slot_spec == nil then
    return nil, nil, slot_spec_reason or "save_array_slot_spec_validation_failed"
  end
  if header_offset < slot_spec.offset or (header_offset + header_size) > (slot_spec.offset + slot_spec.size - SAVE_CHUNK_FOOTER_SIZE) then
    return nil, nil, "save_array_outside_validated_chunk_region"
  end
  local data_ptr = save_data + SAVE_DYNAMIC_REGION_OFFSET + header_offset
  if data_ptr ~= args_pokedex then
    return nil, {
      id = header_id,
      size = header_size,
      offset = header_offset,
      crc = header_crc,
      slot = header_slot,
      blockId = header_slot,
      expectedBlockId = expected_block_id,
      slotSpec = slot_spec,
      saveHeaderValidation = "pokedex_overlay_args_current_without_save_footer",
    }, "pokedex_args_pokedex_pointer_header_mismatch"
  end
  local footer_ok, footer_validation = save_chunk_footer_metadata(save_data, header_slot)
  local save_header = {
    id = header_id,
    size = header_size,
    offset = header_offset,
    crc = header_crc,
    slot = header_slot,
    blockId = header_slot,
    expectedBlockId = expected_block_id,
    validation = footer_ok and "save_array_header_bounds_current_live" or "pokedex_overlay_args_current_without_save_footer",
    currentLiveData = true,
    liveFooterStale = not footer_ok,
    crcValidation = {
      status = "diagnostic",
      reason = "current_live_pokedex_overlay_args_crc_not_required",
    },
    chunkFooterValidation = footer_validation,
    slotSpec = slot_spec,
    saveDataValidation = {
      status = "diagnostic",
      reason = footer_ok and "current_live_chunk_footer_metadata_validated" or "pokedex_overlay_args_current_without_save_footer",
    },
    saveHeaderValidation = footer_ok and "save_array_header_bounds_current_live" or "pokedex_overlay_args_current_without_save_footer",
    saveHeaderDiagnostic = footer_validation,
    saveArrayFallbackReason = save_reason,
  }
  return data_ptr, save_header, nil
end

function pc_storage_box_by_index(decoded_pc_storage, box_index)
  if decoded_pc_storage == nil or type(decoded_pc_storage.boxes) ~= "table" then return nil end
  for _, box in ipairs(decoded_pc_storage.boxes) do
    if box.box_index == box_index then return box end
  end
  return nil
end

function pc_box_display_name(decoded_pc_storage, pc_storage_ptr, box_index)
  local fallback = "Box " .. tostring((box_index or 0) + 1)
  if not valid_arm9_ptr(pc_storage_ptr) or box_index == nil or box_index < 0 or box_index >= PC_BOX_COUNT then
    return fallback
  end
  local name_addr = pc_storage_ptr + 0x12008 + box_index * PC_BOX_NAME_LENGTH * 2
  local name_string = read_hgss_inline_string(name_addr, PC_BOX_NAME_LENGTH)
  if name_string ~= nil and name_string.preview ~= nil and name_string.preview ~= "" then
    return name_string.preview
  end
  return fallback
end

function pc_box_mon_text(mon, box_name, slot_number)
  local slot_label = tostring(box_name) .. " slot " .. tostring(slot_number)
  if mon == nil then return slot_label .. ": empty" end
  local name = mon.nickname
  if name == nil or name == "" then name = mon.species_name end
  if name == nil or name == "" then name = "Pokemon" end
  local level = ""
  if mon.level ~= nil and mon.level > 0 then
    level = " Lv" .. tostring(mon.level)
  end
  return slot_label .. ": " .. tostring(name) .. level
end

function decode_pc_box_overlay(field_system, decoded_pc_storage)
  if not valid_arm9_ptr(field_system) then
    return { active = false, reason = "pokemon_storage_no_valid_field_system" }
  end
  local save_data = u32(field_system + 0x0C)
  if not valid_arm9_ptr(save_data) then
    return { active = false, reason = "pokemon_storage_no_valid_save_data", fieldSystemPtr = field_system }
  end
  local field_system_sub0 = u32(field_system + 0x00)
  if not valid_arm9_ptr(field_system_sub0) then
    return { active = false, reason = "pokemon_storage_no_field_system_sub0", fieldSystemPtr = field_system }
  end
  local overlay_manager = u32(field_system_sub0 + 0x04)
  if not valid_arm9_ptr(overlay_manager) then
    return { active = false, reason = "pokemon_storage_no_active_application", fieldSystemPtr = field_system, fieldSystemSub0Ptr = field_system_sub0 }
  end
  local ovy_id = signed32(u32(overlay_manager + 0x0C))
  if ovy_id ~= PC_BOX_APP_OVERLAY_ID then
    return { active = false, reason = "pokemon_storage_active_application_not_pcbox", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, ovyId = ovy_id }
  end

  local args = u32(overlay_manager + 0x18)
  local work = u32(overlay_manager + 0x1C)
  if not valid_arm9_ptr(args) or not valid_arm9_ptr(work) then
    return { active = false, reason = "pokemon_storage_no_args_or_work", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pcBoxArgsPtr = args, pcBoxWorkPtr = work }
  end

  local args_save_data = u32(args + 0x00)
  local work_args = u32(work + 0x00)
  local work_pc_storage = u32(work + 0x04)
  local expected_pc_storage = decoded_pc_storage and decoded_pc_storage.pcStoragePtr or nil
  if args_save_data ~= save_data or work_args ~= args or not valid_arm9_ptr(work_pc_storage) or expected_pc_storage ~= work_pc_storage then
    return {
      active = false,
      reason = "pokemon_storage_args_or_storage_backlink_mismatch",
      fieldSystemPtr = field_system,
      overlayManagerPtr = overlay_manager,
      pcBoxArgsPtr = args,
      pcBoxWorkPtr = work,
      saveDataPtr = save_data,
      argsSaveDataPtr = args_save_data,
      workArgsPtr = work_args,
      pcStoragePtr = work_pc_storage,
      expectedPcStoragePtr = expected_pc_storage,
    }
  end

  local current_box_index = u8(work + 0x1F)
  local cursor_slot = u8(work + 0x21)
  local pc_box_state = signed32(u32(work + 0x30))
  if current_box_index == nil or current_box_index < 0 or current_box_index >= PC_BOX_COUNT then
    return { active = false, reason = "pokemon_storage_current_box_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pcBoxArgsPtr = args, pcBoxWorkPtr = work, currentBoxIndex = current_box_index }
  end
  local cursor_is_current_box_overview = cursor_slot == 0xFF
  if cursor_slot == nil or (not cursor_is_current_box_overview and cursor_slot > (PC_MONS_PER_BOX + PARTY_MAX_COUNT - 1)) then
    return { active = false, reason = "pokemon_storage_cursor_not_current_or_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pcBoxArgsPtr = args, pcBoxWorkPtr = work, cursorSlot = cursor_slot }
  end
  if pc_box_state == nil or pc_box_state < 0 or pc_box_state > 0x200 then
    return { active = false, reason = "pokemon_storage_state_out_of_bounds", fieldSystemPtr = field_system, overlayManagerPtr = overlay_manager, pcBoxArgsPtr = args, pcBoxWorkPtr = work, pcBoxState = pc_box_state }
  end

  local box_name = pc_box_display_name(decoded_pc_storage, work_pc_storage, current_box_index)
  local current_box = pc_storage_box_by_index(decoded_pc_storage, current_box_index)
  local current_box_visible_mons = {}
  if current_box ~= nil and type(current_box.mons) == "table" then
    for _, mon in ipairs(current_box.mons) do
      local slot_number = mon.box_slot
      if slot_number ~= nil and slot_number >= 0 and slot_number < PC_MONS_PER_BOX then
        current_box_visible_mons[#current_box_visible_mons + 1] = mon
      end
    end
  end
  local items = {}
  local cursor_text = nil
  if cursor_is_current_box_overview then
    if #current_box_visible_mons == 0 then
      cursor_text = box_name .. ": empty"
    else
      cursor_text = box_name
    end
    items[#items + 1] = { text = cursor_text, selected = true }
  end
  for _, mon in ipairs(current_box_visible_mons) do
    local slot_number = mon.box_slot
    local text = pc_box_mon_text(mon, box_name, slot_number + 1)
    local selected = (not cursor_is_current_box_overview) and cursor_slot == slot_number
    if selected then cursor_text = text end
    items[#items + 1] = { text = text, selected = selected }
  end
  if cursor_text == nil then
    if cursor_slot < PC_MONS_PER_BOX then
      cursor_text = pc_box_mon_text(nil, box_name, cursor_slot + 1)
      items[#items + 1] = { text = cursor_text, selected = true }
    else
      cursor_text = "Party slot " .. tostring(cursor_slot - PC_MONS_PER_BOX + 1)
      items[#items + 1] = { text = cursor_text, selected = true }
    end
  end

  return {
    active = true,
    source = "PCBoxOverlayManager.args.PCBoxArgs",
    confidence = "validated_ram",
    contract = "ram_pcbox_overlay_args_storage_cursor_current_box_v1",
    validation = "pcbox_overlay_args_storage_cursor_current_box_validated",
    title = "Pokemon Storage",
    currentBoxName = box_name,
    cursor = cursor_text,
    items = items,
    overlayManagerPtr = overlay_manager,
    pcBoxArgsPtr = args,
    pcBoxWorkPtr = work,
    pcStoragePtr = work_pc_storage,
    ovyId = ovy_id,
    currentBoxIndex = current_box_index,
    cursorSlot = cursor_slot,
    pcBoxState = pc_box_state,
  }
end

function decode_player_profile_from_field_system(field_system)
  if not valid_arm9_ptr(field_system) then
    return nil, "no_valid_field_system"
  end
  local save_data = u32(field_system + 0x0C)
  if not valid_arm9_ptr(save_data) then
    return nil, "no_valid_save_data_pointer"
  end

  local player_data, header, header_reason = save_array_from_save_data(save_data, SAVE_PLAYERDATA, HGSS_PLAYER_PROFILE_SAVE_ARRAY_SIZE, HGSS_PLAYER_PROFILE_SAVE_ARRAY_SIZE)
  if player_data == nil then
    return nil, "playerdata_" .. tostring(header_reason)
  end
  local profile = player_data + 0x04
  local name_string, name_reason = read_hgss_inline_string(profile + 0x00, 8)
  local trainer_id = u32(profile + 0x10)
  local money = u32(profile + 0x14)
  local gender = u8(profile + 0x18)
  local language = u8(profile + 0x19)
  local johto = u8(profile + 0x1A)
  local kanto = u8(profile + 0x1F)

  if trainer_id == nil or money == nil or gender == nil or language == nil or johto == nil or kanto == nil then
    return nil, "profile_read_failed"
  end
  if money > 999999 then return nil, "money_unreasonable" end
  if gender > 1 then return nil, "gender_unreasonable" end

  return {
    source = "FieldSystem.saveData SaveArray_Get(SAVE_PLAYERDATA).PlayerProfile",
    saveDataPtr = save_data,
    playerDataPtr = player_data,
    profilePtr = profile,
    header = header,
    name = name_string and name_string.preview or nil,
    nameReason = name_reason,
    trainer_id = trainer_id,
    visible_trainer_id = trainer_id & 0xFFFF,
    money = money,
    gender = gender,
    language = language,
    johto_badge_byte = johto,
    kanto_badge_byte = kanto,
    validation = "validated_player_profile_header_and_bounds",
  }, nil
end

function is_reasonable_position(pos)
  if pos == nil then return false end
  if pos.map_id == nil or pos.x == nil or pos.y == nil then return false end
  if pos.map_id <= 0 or pos.map_id > 900 then return false end
  if pos.x < 0 or pos.x > 4096 or pos.y < 0 or pos.y > 4096 then return false end
  return true
end

function position_candidate(base, source, map_offset, x_offset, y_offset, z_offset)
  if base == nil or base <= 0 then return nil end
  local pos = {
    source = source,
    map_id = u16(base + map_offset),
    x = u16(base + x_offset),
    y = u16(base + y_offset),
    z = z_offset and u16(base + z_offset) or 0,
    offsets = {
      map_id = map_offset,
      x = x_offset,
      y = y_offset,
      z = z_offset,
    },
  }
  pos.reasonable = is_reasonable_position(pos)
  return pos
end

function save_position_candidate(save_like)
  if save_like == nil or save_like <= 0 then return nil end
  local pos = {
    source = "PokeLua trainerIDsPointer save block",
    map_id = u16(save_like + 0x1244),
    x = u16(save_like + 0x237E),
    y = u16(save_like + 0x2382),
    z = u16(save_like + 0x2386) or 0,
    offsets = {
      map_id = 0x1244,
      x = 0x237E,
      y = 0x2382,
      z = 0x2386,
    },
  }
  pos.reasonable = is_reasonable_position(pos)
  return pos
end

function position_probe(base)
  local out = {}
  if base == nil or base <= 0 then return out end
  for offset = 0x380, 0x3C0, 4 do
    out[#out + 1] = {
      offset = offset,
      u16 = u16(base + offset),
      u32 = u32(base + offset),
    }
  end
  return out
end

function field_system_location_candidate(field_system)
  if not valid_arm9_ptr(field_system) then return nil end
  -- pret/pokeheartgold: struct FieldSystem has Location *location at 0x20.
  -- Location is { int mapId, warpId, x, y, direction }.
  local location = u32(field_system + 0x20)
  if not valid_arm9_ptr(location) then return nil end
  local pos = {
    source = "FieldSystem.location",
    field_system = field_system,
    location_addr = location,
    map_id = u32(location + 0x00),
    warp_id = signed32(u32(location + 0x04)),
    x = signed32(u32(location + 0x08)),
    y = signed32(u32(location + 0x0C)),
    direction = signed32(u32(location + 0x10)),
    offsets = {
      location = 0x20,
      map_id = 0x00,
      warp_id = 0x04,
      x = 0x08,
      y = 0x0C,
      direction = 0x10,
    },
  }
  pos.reasonable =
    pos.map_id ~= nil and pos.map_id > 0 and pos.map_id <= 900 and
    pos.x ~= nil and pos.x >= 0 and pos.x <= 4096 and
    pos.y ~= nil and pos.y >= 0 and pos.y <= 4096 and
    pos.direction ~= nil and pos.direction >= -1 and pos.direction <= 4
  return pos
end

function local_map_object_candidate(addr, source)
  if not valid_arm9_ptr(addr) then return nil end
  local map_id = u32(addr + 0x0C)
  local current_facing = u32(addr + 0x28)
  local next_facing = u32(addr + 0x2C)
  local previous_facing = u32(addr + 0x30)
  local previous_x = u32(addr + 0x58)
  local previous_y = signed32(u32(addr + 0x5C))
  local previous_z = u32(addr + 0x60)
  local current_x = u32(addr + 0x64)
  local current_y = signed32(u32(addr + 0x68))
  local current_z = u32(addr + 0x6C)
  local manager = u32(addr + 0xB4)
  if map_id == nil or current_x == nil or current_z == nil then return nil end

  local field_system = nil
  local player_avatar = nil
  local manager_objects = nil
  local manager_field_system = nil
  local manager_object_count = nil
  local field_manager = nil
  local avatar_object = nil
  local player_stride_member = false
  if valid_arm9_ptr(manager) then
    manager_object_count = u32(manager + 0x04)
    manager_objects = u32(manager + 0x124)
    manager_field_system = u32(manager + 0x128)
    if valid_arm9_ptr(manager_field_system) then
      field_system = manager_field_system
      field_manager = u32(field_system + 0x3C)
      local avatar = u32(field_system + 0x40)
      avatar_object = valid_arm9_ptr(avatar) and u32(avatar + 0x30) or nil
      if valid_arm9_ptr(avatar) and avatar_object == addr then
        player_avatar = avatar
      end
    end
    if valid_arm9_ptr(manager_objects) and manager_object_count ~= nil and manager_object_count > 0 and manager_object_count <= 64 then
      for i = 0, manager_object_count - 1 do
        if manager_objects + (i * 0x12C) == addr then
          player_stride_member = true
          break
        end
      end
    end
  end
  local field_location = field_system_location_candidate(field_system)

  local direction_ok =
    current_facing ~= nil and current_facing >= 0 and current_facing <= 4 and
    next_facing ~= nil and next_facing >= 0 and next_facing <= 4 and
    previous_facing ~= nil and previous_facing >= 0 and previous_facing <= 4
  local coord_ok =
    current_x >= 0 and current_x <= 4096 and
    current_z >= 0 and current_z <= 4096 and
    (current_y == nil or (current_y >= -4096 and current_y <= 4096))
  local map_ok = map_id >= 1 and map_id <= 900
  local manager_ok = valid_arm9_ptr(manager)
  local field_ok = valid_arm9_ptr(field_system)
  local player_ok = valid_arm9_ptr(player_avatar)
  local location_ok = field_location ~= nil and field_location.reasonable == true
  local root_binding_valid =
    manager_ok and field_ok and player_ok and
    manager_field_system == field_system and
    field_manager == manager and
    avatar_object == addr and
    player_stride_member

  local score = 0
  if map_ok then score = score + 2 end
  if coord_ok then score = score + 2 end
  if direction_ok then score = score + 1 end
  if manager_ok then score = score + 1 end
  if field_ok then score = score + 2 end
  if player_ok then score = score + 4 end
  if location_ok then score = score + 2 end
  if manager_objects == addr then score = score + 1 end

  return {
    source = source or "LocalMapObject candidate",
    object_addr = addr,
    map_id = map_id,
    x = current_x,
    y = current_z,
    z = current_y or 0,
    current_y = current_y,
    previous_x = previous_x,
    previous_y = previous_y,
    previous_z = previous_z,
    facing = current_facing,
    next_facing = next_facing,
    previous_facing = previous_facing,
    manager = manager,
    field_system = field_system,
    field_system_location = field_location,
    player_avatar = player_avatar,
    manager_ok = manager_ok,
    field_ok = field_ok,
    player_ok = player_ok,
    location_ok = location_ok,
    field_system_manager = field_manager,
    manager_object_count = manager_object_count,
    player_stride_member = player_stride_member,
    rootBindingValid = root_binding_valid,
    score = score,
    reasonable = map_ok and coord_ok and direction_ok and manager_ok and field_ok and player_ok and location_ok and root_binding_valid and score >= 12,
  }
end

function field_system_candidate(field_system, expected_save_data, source)
  if not valid_arm9_ptr(field_system) then return nil end
  local save_data = u32(field_system + 0x0C)
  local taskman = u32(field_system + 0x10)
  local map_events = u32(field_system + 0x14)
  local map_matrix = u32(field_system + 0x30)
  local map_object_manager = u32(field_system + 0x3C)
  local player_avatar = u32(field_system + 0x40)
  local avatar_object = valid_arm9_ptr(player_avatar) and u32(player_avatar + 0x30) or nil
  local manager_object_count = valid_arm9_ptr(map_object_manager) and u32(map_object_manager + 0x04) or nil
  local manager_objects = valid_arm9_ptr(map_object_manager) and u32(map_object_manager + 0x124) or nil
  local manager_field_system = valid_arm9_ptr(map_object_manager) and u32(map_object_manager + 0x128) or nil
  local field_location = field_system_location_candidate(field_system)
  local expected_save_data_valid = valid_arm9_ptr(expected_save_data)
  local save_data_current = valid_arm9_ptr(save_data) and (not expected_save_data_valid or save_data == expected_save_data)
  local location_ok = field_location ~= nil and field_location.reasonable == true
  local manager_ok = valid_arm9_ptr(map_object_manager) and manager_field_system == field_system
  local player_avatar_ok = valid_arm9_ptr(player_avatar)
  local avatar_object_ok = valid_arm9_ptr(avatar_object)
  local object_count_valid = manager_object_count ~= nil and manager_object_count > 0 and manager_object_count <= 64
  local objects_ptr_valid = valid_arm9_ptr(manager_objects)
  local player_stride_member = false
  if objects_ptr_valid and object_count_valid and avatar_object_ok then
    for i = 0, manager_object_count - 1 do
      if manager_objects + (i * 0x12C) == avatar_object then
        player_stride_member = true
        break
      end
    end
  end

  local score = 0
  if save_data_current then score = score + 4 end
  if location_ok then score = score + 3 end
  if valid_arm9_ptr(taskman) then score = score + 1 end
  if valid_arm9_ptr(map_events) then score = score + 1 end
  if valid_arm9_ptr(map_matrix) then score = score + 1 end
  if manager_ok then score = score + 3 end
  if player_avatar_ok then score = score + 2 end
  if avatar_object_ok then score = score + 2 end
  if player_stride_member then score = score + 2 end

  return {
    source = source or "FieldSystem candidate",
    contract = "fieldsystem_savedata_manager_playeravatar_root_candidate_v1",
    field_system = field_system,
    saveDataPtr = save_data,
    expectedSaveDataPtr = expected_save_data,
    taskmanPtr = taskman,
    mapEventsPtr = map_events,
    mapMatrixPtr = map_matrix,
    mapObjectManagerPtr = map_object_manager,
    playerAvatarPtr = player_avatar,
    avatarObjectPtr = avatar_object,
    objectCount = manager_object_count,
    objectsPtr = manager_objects,
    managerFieldSystemPtr = manager_field_system,
    field_system_location = field_location,
    saveDataCurrent = save_data_current,
    locationOk = location_ok,
    managerFieldSystemBound = manager_ok,
    playerAvatarObjectBound = avatar_object_ok,
    objectCountValid = object_count_valid,
    objectsPtrValid = objects_ptr_valid,
    playerStrideMember = player_stride_member,
    rootBinding = {
      managerFieldSystemBound = manager_ok,
      fieldSystemManagerBound = manager_ok,
      playerAvatarObjectBound = avatar_object_ok,
      playerStrideMember = player_stride_member,
      objectCountValid = object_count_valid,
      objectsPtrValid = objects_ptr_valid,
      currentMapBound = location_ok,
    },
    score = score,
    reasonable = save_data_current and location_ok and manager_ok and player_avatar_ok,
  }
end

function find_field_system(allow_scan, expected_save_data)
  local candidates = {}
  local seen = {}

  local function add(ptr_addr, source)
    if not valid_arm9_ptr(ptr_addr) or seen[ptr_addr] then return end
    seen[ptr_addr] = true
    local candidate = field_system_candidate(ptr_addr, expected_save_data, source)
    if candidate and candidate.score >= 8 then
      candidates[#candidates + 1] = candidate
    end
  end

  if valid_arm9_ptr(FIELD_SYSTEM_ADDR) then
    add(FIELD_SYSTEM_ADDR, "cached FieldSystem")
    if #candidates > 0 and candidates[1].reasonable then
      return candidates[1], candidates
    end
    if allow_scan then
      FIELD_SYSTEM_ADDR = nil
    end
  end

  if not allow_scan then return nil, candidates end

  local expected_save_data_valid = valid_arm9_ptr(expected_save_data)
  local scanned = 0
  local scan_start = NEXT_FIELD_SYSTEM_SCAN_ADDR
  local save_data_scan_start = nil
  local save_data_scan_end = nil
  local save_data_scan_next = nil
  local save_data_scanned = 0

  if expected_save_data_valid then
    save_data_scan_start = field_system_scan_start_for_save_data(expected_save_data)
    save_data_scan_end = field_system_scan_end_for_save_data(expected_save_data)
    if FIELD_SYSTEM_SAVE_DATA_SCAN_SAVE_DATA ~= expected_save_data
        or not valid_arm9_ptr(NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR)
        or NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR < save_data_scan_start
        or NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR >= save_data_scan_end then
      FIELD_SYSTEM_SAVE_DATA_SCAN_SAVE_DATA = expected_save_data
      NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR = save_data_scan_start
    end
    save_data_scan_next = NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR
    while scanned < FIELD_SYSTEM_SCAN_BUDGET and NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR < save_data_scan_end do
      local ptr_addr = NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR
      NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR = NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR + 4
      scanned = scanned + 1
      save_data_scanned = save_data_scanned + 1
      if u32(ptr_addr + 0x0C) == expected_save_data then
        add(ptr_addr, string.format("FieldSystem SaveData-neighborhood scan at 0x%08X", ptr_addr))
      end
    end
    if NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR >= save_data_scan_end then
      NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR = save_data_scan_start
    end
  end

  while scanned < FIELD_SYSTEM_SCAN_BUDGET do
    local ptr_addr = NEXT_FIELD_SYSTEM_SCAN_ADDR
    NEXT_FIELD_SYSTEM_SCAN_ADDR = NEXT_FIELD_SYSTEM_SCAN_ADDR + 4
    if NEXT_FIELD_SYSTEM_SCAN_ADDR >= FIELD_SYSTEM_SCAN_END then
      NEXT_FIELD_SYSTEM_SCAN_ADDR = FIELD_SYSTEM_SCAN_START
    end
    scanned = scanned + 1
    if not expected_save_data_valid or u32(ptr_addr + 0x0C) == expected_save_data then
      add(ptr_addr, string.format("FieldSystem.scan SaveData backref at 0x%08X", ptr_addr + 0x0C))
    end
  end

  table.sort(candidates, function(a, b)
    if a.score == b.score then return (a.field_system or 0) < (b.field_system or 0) end
    return a.score > b.score
  end)

  local out = {}
  for i = 1, math.min(#candidates, 8) do
    out[#out + 1] = candidates[i]
  end
  out.scanStart = scan_start
  out.nextScanStart = NEXT_FIELD_SYSTEM_SCAN_ADDR
  out.scanned = scanned
  out.scanBudget = FIELD_SYSTEM_SCAN_BUDGET
  out.saveDataScanStart = save_data_scan_start
  out.saveDataScanEnd = save_data_scan_end
  out.saveDataScanNext = save_data_scan_next
  out.saveDataScanned = save_data_scanned
  out.nextSaveDataScanStart = NEXT_FIELD_SYSTEM_SAVE_DATA_SCAN_ADDR

  if #out > 0 and out[1].reasonable then
    FIELD_SYSTEM_ADDR = out[1].field_system
    return out[1], out
  end
  return nil, out
end

function field_system_object_position(field_system_root)
  if not field_system_root or not valid_arm9_ptr(field_system_root.avatarObjectPtr) then return nil end
  local object_position = local_map_object_candidate(field_system_root.avatarObjectPtr, "FieldSystem.playerAvatar.mapObject")
  if object_position ~= nil then
    object_position.field_system_root = field_system_root
  end
  return object_position
end

function local_map_object_runtime_entry(addr, index, semantic_map_id, player_object_addr)
  if not valid_arm9_ptr(addr) then return nil end
  local flags = u32(addr + 0x00)
  local object_id = u32(addr + 0x08)
  local local_map_id = u32(addr + 0x0C)
  local sprite_id = u32(addr + 0x10)
  local movement = u32(addr + 0x14)
  local object_type = u32(addr + 0x18)
  local event_flag = u32(addr + 0x1C)
  local script_id = u32(addr + 0x20)
  local initial_facing = u32(addr + 0x24)
  local facing = u32(addr + 0x28)
  local x_range = u32(addr + 0x44)
  local y_range = u32(addr + 0x48)
  local initial_x = u32(addr + 0x4C)
  local initial_y = signed32(u32(addr + 0x50))
  local initial_z = u32(addr + 0x54)
  local previous_x = u32(addr + 0x58)
  local previous_y = signed32(u32(addr + 0x5C))
  local previous_z = u32(addr + 0x60)
  local x = u32(addr + 0x64)
  local y = signed32(u32(addr + 0x68))
  local z = u32(addr + 0x6C)
  local manager = u32(addr + 0xB4)
  if flags == nil or object_id == nil or local_map_id == nil or sprite_id == nil or movement == nil or object_type == nil or facing == nil or x == nil or z == nil then return nil end
  -- pret/pokeheartgold MapObjectFlagBits: bit 0 = ACTIVE, bit 9 = VISIBLE.
  local active_flag = (math.floor(flags) % 2) == 1
  local visible_flag = (math.floor(flags / 0x200) % 2) == 1
  local coord_ok = x >= 0 and x <= 4096 and z >= 0 and z <= 4096 and (y == nil or (y >= -4096 and y <= 4096))
  local facing_ok = facing ~= nil and facing >= 0 and facing <= 4
  local active = active_flag and coord_ok and object_id < 1024 and sprite_id < 4096 and movement < 4096 and object_type < 256 and facing_ok
  if not active then return nil end
  return {
    index = index,
    object_addr = addr,
    object_id = object_id,
    local_map_id = local_map_id,
    semantic_map_id = semantic_map_id,
    x = x,
    y = z,
    z = y or 0,
    initial_x = initial_x,
    initial_y = initial_z,
    initial_z = initial_y or 0,
    previous_x = previous_x,
    previous_y = previous_z,
    previous_z = previous_y or 0,
    facing = facing,
    initial_facing = initial_facing,
    x_range = x_range,
    y_range = y_range,
    sprite_id = sprite_id,
    movement = movement,
    object_type = object_type,
    event_flag = event_flag,
    script_id = script_id,
    manager = manager,
    active_flag = active_flag,
    visible_flag = visible_flag,
    is_player = player_object_addr == addr,
    source = "MapObjectManager.objects",
    contract = "runtime_current_map_object",
  }
end

function enumerate_map_objects_from_player_object(player_object)
  if not player_object or not valid_arm9_ptr(player_object.manager) then
    return {
      available = false,
      reason = "player_object_manager_missing",
      entries = {},
    }
  end
  local manager = player_object.manager
  local count = u32(manager + 0x04)
  local objects = u32(manager + 0x124)
  local manager_field_system = u32(manager + 0x128)
  local semantic_map_id = player_object.field_system_location and player_object.field_system_location.map_id or player_object.map_id
  local field_manager = valid_arm9_ptr(player_object.field_system) and u32(player_object.field_system + 0x3C) or nil
  local field_avatar = valid_arm9_ptr(player_object.field_system) and u32(player_object.field_system + 0x40) or nil
  local avatar_object = valid_arm9_ptr(field_avatar) and u32(field_avatar + 0x30) or nil
  local player_stride_member = false
  if valid_arm9_ptr(objects) and valid_arm9_ptr(player_object.object_addr) and count ~= nil and count > 0 and count <= 64 then
    for i = 0, count - 1 do
      if objects + (i * 0x12C) == player_object.object_addr then
        player_stride_member = true
        break
      end
    end
  end
  if not valid_arm9_ptr(objects) or not valid_arm9_ptr(manager_field_system) or count == nil or count <= 0 or count > 64
     or manager_field_system ~= player_object.field_system or field_manager ~= manager or avatar_object ~= player_object.object_addr
     or not player_stride_member then
    return {
      available = false,
      reason = "map_object_manager_root_binding_invalid",
      manager = manager,
      objectCount = count,
      objectsPtr = objects,
      fieldSystemPtr = manager_field_system,
      expectedFieldSystemPtr = player_object.field_system,
      fieldSystemManagerPtr = field_manager,
      playerAvatarPtr = field_avatar,
      avatarObjectPtr = avatar_object,
      playerStrideMember = player_stride_member,
      managerFieldSystemBound = manager_field_system == player_object.field_system,
      fieldSystemManagerBound = field_manager == manager,
      playerAvatarObjectBound = avatar_object == player_object.object_addr,
      objectCountValid = count ~= nil and count > 0 and count <= 64,
      objectsPtrValid = valid_arm9_ptr(objects),
      entries = {},
    }
  end
  local entries = {}
  local player_object_addr = player_object.object_addr
  for i = 0, count - 1 do
    local addr = objects + (i * 0x12C)
    local entry = local_map_object_runtime_entry(addr, i, semantic_map_id, player_object_addr)
    if entry then entries[#entries + 1] = entry end
  end
  return {
    available = true,
    source = "FieldSystem.mapObjectManager",
    contract = "fieldsystem_mapobjectmanager_root_bound_visible_runtime_objects_v1",
    manager = manager,
    objectCount = count,
    objectsPtr = objects,
    fieldSystemPtr = manager_field_system,
    semanticMapId = semantic_map_id,
    managerFieldSystemBound = true,
    fieldSystemManagerBound = true,
    playerAvatarObjectBound = true,
    playerStrideMember = true,
    objectCountValid = true,
    objectsPtrValid = true,
    currentMapBound = true,
    entries = entries,
  }
end

function scan_local_map_object_candidates()
  local candidates = {}
  local seen = {}

  local function add(addr, source)
    if not valid_arm9_ptr(addr) or seen[addr] then return end
    seen[addr] = true
    local candidate = local_map_object_candidate(addr, source)
    if candidate and candidate.score >= 6 then
      candidates[#candidates + 1] = candidate
    end
  end

  -- Fast pointer-shaped scan: LocalMapObject+0xB4 points to MapObjectManager,
  -- whose +0x128 points to FieldSystem, whose +0x40 PlayerAvatar points back.
  local scanned = 0
  local scan_start = NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR
  while scanned < LOCAL_MAP_OBJECT_SCAN_BUDGET do
    local ptr_addr = NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR
    NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR = NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR + 4
    if NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR >= LOCAL_MAP_OBJECT_SCAN_END then
      NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR = LOCAL_MAP_OBJECT_SCAN_START
    end
    scanned = scanned + 1
    local maybe_obj = u32(ptr_addr)
    if valid_arm9_ptr(maybe_obj) and not seen[maybe_obj] then
      local manager = u32(maybe_obj + 0xB4)
      if valid_arm9_ptr(manager) then
        local field_system = u32(manager + 0x128)
        if valid_arm9_ptr(field_system) then
          local avatar = u32(field_system + 0x40)
          if valid_arm9_ptr(avatar) and u32(avatar + 0x30) == maybe_obj then
            add(maybe_obj, string.format("FieldSystem->PlayerAvatar scan via pointer 0x%08X", ptr_addr))
          end
        end
      end
    end
  end

  table.sort(candidates, function(a, b)
    if a.score == b.score then return (a.object_addr or 0) < (b.object_addr or 0) end
    return a.score > b.score
  end)

  local out = {}
  for i = 1, math.min(#candidates, 12) do
    out[#out + 1] = candidates[i]
  end
  out.scanStart = scan_start
  out.nextScanStart = NEXT_LOCAL_MAP_OBJECT_SCAN_ADDR
  out.scanned = scanned
  out.scanBudget = LOCAL_MAP_OBJECT_SCAN_BUDGET
  return out
end

function player_object_position(allow_scan, field_system_root)
  local rooted = field_system_object_position(field_system_root)
  if rooted and rooted.reasonable then
    PLAYER_OBJECT_ADDR = rooted.object_addr
    rooted.source = "FieldSystem.playerAvatar.mapObject"
    return rooted, {}
  end

  if valid_arm9_ptr(PLAYER_OBJECT_ADDR) then
    local cached = local_map_object_candidate(PLAYER_OBJECT_ADDR, "cached LocalMapObject")
    if cached and cached.reasonable then return cached, {} end
    if allow_scan then
      reset_local_map_object_cache()
    end
  end

  if not allow_scan then return nil, {} end
  local candidates = scan_local_map_object_candidates()
  for _, candidate in ipairs(candidates) do
    if candidate.reasonable then
      PLAYER_OBJECT_ADDR = candidate.object_addr
      candidate.source = "scanned LocalMapObject"
      return candidate, candidates
    end
  end
  return nil, candidates
end

function decode_pocket(save_like, name, offset, max_slots, max_quantity)
  local items = {}
  local issues = {}
  if save_like == nil or save_like <= 0 then return items, issues end
  local quantity_limit = max_quantity or 999
  local seen_empty_slot = false
  for i = 0, max_slots - 1 do
    local addr = save_like + offset + i * 4
    local item_id = u16(addr)
    local quantity = u16(addr + 2)
    if item_id == nil or quantity == nil then
      issues[#issues + 1] = {
        pocket = name,
        slot = i + 1,
        item_id = item_id,
        quantity = quantity,
        reason = "slot_unreadable",
      }
    elseif item_id == 0 and quantity == 0 then
      seen_empty_slot = true
    elseif item_id == 0 then
      seen_empty_slot = true
      issues[#issues + 1] = {
        pocket = name,
        slot = i + 1,
        item_id = item_id,
        quantity = quantity,
        reason = "empty_item_id_with_nonzero_quantity",
      }
    elseif item_id == 0xFFFF then
      issues[#issues + 1] = {
        pocket = name,
        slot = i + 1,
        item_id = item_id,
        quantity = quantity,
        reason = "invalid_ffff_item_id",
      }
    elseif seen_empty_slot then
      issues[#issues + 1] = {
        pocket = name,
        slot = i + 1,
        item_id = item_id,
        quantity = quantity,
        reason = "non_empty_after_empty_slot",
      }
    elseif item_id <= HGSS_ITEM_MAX and quantity > 0 and quantity <= quantity_limit then
      items[#items + 1] = {
        slot = i + 1,
        item_id = item_id,
        name = "Item " .. tostring(item_id),
        quantity = quantity,
      }
    else
      issues[#issues + 1] = {
        pocket = name,
        slot = i + 1,
        item_id = item_id,
        quantity = quantity,
        reason = item_id > HGSS_ITEM_MAX and "item_id_out_of_hgss_bounds" or "quantity_out_of_pocket_bounds",
      }
    end
  end
  return items, issues
end

function decode_inventory_from_field_system(field_system)
  if not valid_arm9_ptr(field_system) then
    return {
      source = "FieldSystem.saveData SaveArray_Get(SAVE_BAG).Bag",
      validation = "not_validated",
      reason = "no_valid_field_system",
    }
  end
  local save_data = u32(field_system + 0x0C)
  local bag, header, reason = save_array_from_save_data(save_data, SAVE_BAG, HGSS_BAG_SAVE_ARRAY_SIZE, HGSS_BAG_SAVE_ARRAY_SIZE)
  if bag == nil then
    return {
      source = "FieldSystem.saveData SaveArray_Get(SAVE_BAG).Bag",
      validation = "not_validated",
      reason = reason,
      saveDataPtr = save_data,
      header = header,
    }
  end
  -- Pocket offsets/counts follow pret/pokeheartgold Bag in include/bag_types_def.h.
  local inventory = {
    source = "FieldSystem.saveData SaveArray_Get(SAVE_BAG).Bag",
    validation = "validated_save_bag_header_and_pocket_bounds",
    saveDataPtr = save_data,
    bagPtr = bag,
    header = header,
    invalid_slots = {},
  }
  local function assign_pocket(field_name, display_name, offset, max_slots, max_quantity)
    local items, issues = decode_pocket(bag, display_name, offset, max_slots, max_quantity)
    inventory[field_name] = items
    for _, issue in ipairs(issues) do
      inventory.invalid_slots[#inventory.invalid_slots + 1] = issue
    end
  end
  assign_pocket("item_pocket", "Items", 0x000, 165, 999)
  assign_pocket("key_item_pocket", "Key Items", 0x294, 50, 1)
  assign_pocket("tm_case", "TMs/HMs", 0x35C, 101, 99)
  assign_pocket("mail_pocket", "Mail", 0x4F0, 12, 999)
  assign_pocket("medicine_pocket", "Medicine", 0x520, 40, 999)
  assign_pocket("berries_pocket", "Berries", 0x5C0, 64, 999)
  assign_pocket("ball_pocket", "Balls", 0x6C0, 24, 999)
  assign_pocket("battle_items_pocket", "Battle Items", 0x720, 30, 999)
  inventory.registered_items = {}
  if bag ~= nil and bag > 0 then
    -- pret/pokeheartgold Bag has u16 registeredItems[2] after battleItems.
    local registered_seen_item_ids = {}
    local registered_seen_empty_slot = false
    for i = 0, 1 do
      local item_id = u16(bag + 0x798 + i * 2)
      if item_id == nil or item_id == 0 then
        registered_seen_empty_slot = true
      elseif item_id > HGSS_ITEM_MAX then
        inventory.invalid_slots[#inventory.invalid_slots + 1] = {
          pocket = "Registered Items",
          slot = i + 1,
          item_id = item_id,
          quantity = 1,
          reason = "registered_item_id_out_of_hgss_bounds",
        }
      elseif registered_seen_empty_slot then
        inventory.invalid_slots[#inventory.invalid_slots + 1] = {
          pocket = "Registered Items",
          slot = i + 1,
          item_id = item_id,
          quantity = 1,
          reason = "registered_slot2_without_slot1",
        }
      elseif registered_seen_item_ids[item_id] then
        inventory.invalid_slots[#inventory.invalid_slots + 1] = {
          pocket = "Registered Items",
          slot = i + 1,
          item_id = item_id,
          quantity = 1,
          reason = "duplicate_registered_item_id",
        }
      else
        registered_seen_item_ids[item_id] = true
        inventory.registered_items[#inventory.registered_items + 1] = {
          slot = i + 1,
          item_id = item_id,
          name = "Item " .. tostring(item_id),
        }
      end
    end
  end
  if #inventory.invalid_slots > 0 then
    inventory.validation = "invalid_save_bag_slots"
    inventory.reason = "bag_contains_slots_outside_hgss_item_or_quantity_bounds"
  end
  return inventory
end

function decode_ram_state()
  local decode_timing = {}
  local decode_started = os.clock()
  local unpack_values = table.unpack or unpack
  local function timed_decode(label, fn)
    local started = os.clock()
    local values = { fn() }
    decode_timing[label] = math.floor(((os.clock() - started) * 1000) + 0.5)
    return unpack_values(values)
  end

  local domains = {}
  local ok_domains, domain_list = pcall(memory.getmemorydomainlist)
  if ok_domains and type(domain_list) == "table" then domains = domain_list end

  local rom_code = u24(0x02FFFE0C)
  local language = u8(0x02FFFE0F)
  local pointer_profile = hgss_pointer_profile(language)
  local base = u32(pointer_profile.pid_pointer_addr)
  local save_like = u32(pointer_profile.trainer_ids_pointer_addr)

  local runtime_position = timed_decode("runtime_position", function()
    return position_candidate(base, "pidPointer base+0x39C dynamic candidate", 0x39C, 0x3A4, 0x3A8, 0x3AC)
  end)
  local field_system_root, field_system_candidates = timed_decode("find_field_system", function()
    return find_field_system(true, save_like)
  end)
  local object_position, object_candidates = timed_decode("player_object_position", function()
    return player_object_position(true, field_system_root)
  end)
  local runtime_objects = timed_decode("runtime_objects", function()
    return enumerate_map_objects_from_player_object(object_position)
  end)
  local save_position = timed_decode("save_position", function()
    return save_position_candidate(save_like)
  end)
  local position_candidates = {}
  if object_position ~= nil then position_candidates[#position_candidates + 1] = object_position end
  if runtime_position ~= nil then position_candidates[#position_candidates + 1] = runtime_position end
  if save_position ~= nil then position_candidates[#position_candidates + 1] = save_position end
  local chosen_position = nil
  if object_position ~= nil and object_position.reasonable then
    chosen_position = object_position
  elseif runtime_position ~= nil and runtime_position.reasonable then
    chosen_position = runtime_position
  elseif save_position ~= nil and save_position.reasonable then
    chosen_position = save_position
  else
    chosen_position = runtime_position or save_position or {}
  end
  local active_field_system =
    (object_position and object_position.field_system) or
    (field_system_root and field_system_root.field_system) or
    nil
  if not valid_arm9_ptr(chosen_position.field_system) and valid_arm9_ptr(active_field_system) then
    chosen_position.field_system = active_field_system
    if field_system_root and field_system_root.field_system_location then
      chosen_position.field_system_location = field_system_root.field_system_location
    end
  end

  local player_profile, player_profile_reason = timed_decode("player_profile", function()
    return decode_player_profile_from_field_system(chosen_position.field_system)
  end)
  local progress_flags, progress_flags_reason = timed_decode("progress_flags", function()
    return decode_progress_flags_from_field_system(chosen_position.field_system)
  end)
  local local_field_data, local_field_data_reason = timed_decode("local_field_data", function()
    return decode_local_field_data_from_field_system(chosen_position.field_system)
  end)
  local pc_storage, pc_storage_reason = timed_decode("pc_storage", function()
    return decode_pc_storage_from_field_system(chosen_position.field_system)
  end)
  local saved_map_objects, saved_map_objects_reason = timed_decode("saved_map_objects", function()
    return decode_saved_map_objects_from_field_system(chosen_position.field_system)
  end)
  local money = nil
  local johto = 0
  local kanto = 0
  if player_profile ~= nil then
    money = player_profile.money
    johto = player_profile.johto_badge_byte or 0
    kanto = player_profile.kanto_badge_byte or 0
  end

  local party, party_count, party_source, party_validation, party_candidate_diagnostics =
    timed_decode("party", function()
      return decode_party_from_field_system(chosen_position.field_system)
    end)
  if party_validation ~= "ram_save_party_header_validated_with_pokemon_checksum_and_stats" then
    local fallback_party, fallback_party_count, fallback_party_source, fallback_party_validation, fallback_party_diagnostics = timed_decode("party_fallback", function()
      return decode_party(base)
    end)
    party_candidate_diagnostics[#party_candidate_diagnostics + 1] = {
      source = "runtime_party_fallback",
      promoted = false,
      validation = fallback_party_validation,
      count = fallback_party_count,
      diagnostics = fallback_party_diagnostics,
    }
  end
  local battle_magic = u16(0x02247612)
  local in_battle_candidate = battle_magic == 0x2801
  local enemy_party, enemy_party_count, enemy_party_source, enemy_party_validation, enemy_party_diagnostics = {}, 0, nil, "not_in_battle", {}
  if in_battle_candidate then
    enemy_party, enemy_party_count, enemy_party_source, enemy_party_validation, enemy_party_diagnostics = timed_decode("enemy_party", function()
      return decode_battle_enemy_party(base)
    end)
  end
  local battle_text_probe = timed_decode("battle_text_probe", function()
    return probe_battle_text_candidate(in_battle_candidate)
  end)
  local active_battle, active_battle_reason, active_battle_diagnostics = timed_decode("active_battle", function()
    return decode_active_battle_system(in_battle_candidate, battle_text_probe)
  end)
  battle_text_probe = timed_decode("battle_text_validation", function()
    return mark_battle_text_probe_validated(battle_text_probe, active_battle)
  end)
  local generic_text_probe = timed_decode("generic_text_probe", function()
    return decode_generic_text_printers()
  end)
  local language_offset = pointer_profile.korean_offset or 0
  local movement_raw = base and u8(base + 0x37888 + language_offset) or nil
  local vehicle_raw = base and u8(base + 0xE294 + language_offset) or nil
  local map_attribute_raw = base and u8(base + 0x32E0C + language_offset) or nil
  local inventory = timed_decode("inventory", function()
    return decode_inventory_from_field_system(chosen_position.field_system)
  end)
  local naming = timed_decode("naming", function()
    return decode_naming_screen_state()
  end)
  local position_probe_data = timed_decode("position_probe", function()
    return position_probe(base)
  end)
  local field_text_probe = nil
  local current_ui_probe = nil
  local touch_save_choice_probe = nil
  local start_menu_probe = nil
  local bag_menu_probe = nil
  local party_menu_probe = nil
  local summary_screen_probe = nil
  local fly_map_probe = nil
  local pokemon_storage_probe = nil
  local pokedex_probe = nil
  timed_decode("text_probe_overlays", function()
    field_text_probe = probe_field_dialog_text_candidate(chosen_position.field_system)
    current_ui_probe = decode_current_ui_state()
    touch_save_choice_probe = decode_touch_save_choice_menu(chosen_position.field_system)
    start_menu_probe = decode_start_menu_taskdata(chosen_position.field_system)
    bag_menu_probe = decode_bag_menu_overlay(chosen_position.field_system)
    party_menu_probe = decode_party_menu_overlay(chosen_position.field_system, active_battle)
    summary_screen_probe = decode_current_summary_screen(chosen_position.field_system, active_battle)
    fly_map_probe = decode_pokegear_fly_map_overlay(chosen_position.field_system)
    pokemon_storage_probe = decode_pc_box_overlay(chosen_position.field_system, pc_storage)
    pokedex_probe = decode_pokedex_overlay(chosen_position.field_system)
    return true
  end)
  decode_timing.total_ms = math.floor(((os.clock() - decode_started) * 1000) + 0.5)

  return {
    decode_timing = decode_timing,
    domain = SYSTEM_BUS,
    domain_mode = MEMORY_DOMAIN_MODE,
    available_domains = domains,
    failed_ram_reads = FAILED_RAM_READS,
    rom_code_u24 = rom_code,
    language_u8 = language,
    pointers = {
      base = base,
      save_like = save_like,
      pid_pointer_addr = pointer_profile.pid_pointer_addr,
      trainer_ids_pointer_addr = pointer_profile.trainer_ids_pointer_addr,
      language_profile = pointer_profile.language,
      language_offset = language_offset,
    },
    player = {
      name = player_profile and player_profile.name or nil,
      trainer_id = player_profile and player_profile.visible_trainer_id or nil,
      gender = player_profile and player_profile.gender or nil,
      profile = player_profile,
      profile_reason = player_profile_reason,
      progress_flags = progress_flags,
      progress_flags_reason = progress_flags_reason,
      local_field_data = local_field_data,
      local_field_data_reason = local_field_data_reason,
      money = money,
      position = {
        map_id = chosen_position.map_id,
        x = chosen_position.x,
        y = chosen_position.y,
        z = chosen_position.z,
        source = chosen_position.source,
        reasonable = chosen_position.reasonable,
        field_system_location = chosen_position.field_system_location,
        facing = chosen_position.facing,
        next_facing = chosen_position.next_facing,
        previous_facing = chosen_position.previous_facing,
      },
      save_position = save_position,
      runtime_position = runtime_position,
      field_system_root = field_system_root,
      field_system_candidates = field_system_candidates,
      object_position = object_position,
      object_position_candidates = object_candidates,
      runtime_objects = runtime_objects,
      position_candidates = position_candidates,
      movement = {
        raw = movement_raw,
        index = movement_raw and (movement_raw - 0x58) or nil,
        vehicle = vehicle_raw,
        map_attribute = map_attribute_raw,
      },
      badges = {
        ZEPHYR = bit_is_set(johto, 0x01),
        HIVE = bit_is_set(johto, 0x02),
        PLAIN = bit_is_set(johto, 0x04),
        FOG = bit_is_set(johto, 0x08),
        STORM = bit_is_set(johto, 0x10),
        MINERAL = bit_is_set(johto, 0x20),
        GLACIER = bit_is_set(johto, 0x40),
        RISING = bit_is_set(johto, 0x80),
        BOULDER = bit_is_set(kanto, 0x01),
        CASCADE = bit_is_set(kanto, 0x02),
        THUNDER = bit_is_set(kanto, 0x04),
        RAINBOW = bit_is_set(kanto, 0x08),
        SOUL = bit_is_set(kanto, 0x10),
        MARSH = bit_is_set(kanto, 0x20),
        VOLCANO = bit_is_set(kanto, 0x40),
        EARTH = bit_is_set(kanto, 0x80),
      },
      johto_badge_byte = johto,
      kanto_badge_byte = kanto,
    },
    inventory = inventory,
    naming = naming,
    pc_storage = pc_storage,
    pc_storage_reason = pc_storage_reason,
    saved_map_objects = saved_map_objects,
    saved_map_objects_reason = saved_map_objects_reason,
    position_probe = position_probe_data,
    party = party,
    party_count = party_count,
    party_source = party_source,
    party_header = party_candidate_diagnostics
      and party_candidate_diagnostics[1]
      and party_candidate_diagnostics[1].source == "FieldSystem.saveData SaveArray_Get(SAVE_PARTY).PartyCore"
      and party_candidate_diagnostics[1].header
      or nil,
    party_validation = party_validation,
    party_candidate_diagnostics = party_candidate_diagnostics,
    battle = {
      magic = battle_magic,
      in_battle_candidate = in_battle_candidate,
      active_battle = active_battle,
      active_battle_validation = active_battle and active_battle.validation or active_battle_reason,
      active_battle_diagnostics = active_battle_diagnostics,
      enemy_party = enemy_party,
      enemy_party_count = enemy_party_count,
      enemy_party_source = enemy_party_source,
      enemy_party_validation = enemy_party_validation,
      enemy_party_diagnostics = enemy_party_diagnostics,
    },
    text_probe = {
      battle = battle_text_probe,
      generic = generic_text_probe,
      recent_battle_events = RECENT_BATTLE_TEXT_EVENTS,
      recent_generic_events = RECENT_GENERIC_TEXT_EVENTS,
      recent_field_events = RECENT_FIELD_TEXT_EVENTS,
      field = field_text_probe,
      current_ui = current_ui_probe,
      touch_save_choice = touch_save_choice_probe,
      start_menu = start_menu_probe,
      bag_menu = bag_menu_probe,
      party_menu = party_menu_probe,
      summary_screen = summary_screen_probe,
      fly_map = fly_map_probe,
      pokemon_storage = pokemon_storage_probe,
      pokedex = pokedex_probe,
    },
  }
end

function capture_snapshot()
  client.screenshot(SCREENSHOT_PATH)
end

local last_heartbeat_frame = -1
local last_recent_text_sample_frame = -1

function write_heartbeat(force)
  local frame = emu.framecount()
  if force or frame - last_heartbeat_frame >= 60 then
    last_heartbeat_frame = frame
    write_all(
      HEARTBEAT_PATH,
      string.format(
        '{"ok":true,"frame":%d,"system":"%s","bridgeProtocolVersion":%d,"bridgeFeatureVersion":%d,"features":{"genericTextPrinter":true,"staleTouchGuard":true,"battleTextPrinter":true},"screenWidth":%d,"screenHeight":%d,"clientScreenWidth":%d,"clientScreenHeight":%d}',
        frame,
        escape_json(emu.getsystemid()),
        BRIDGE_PROTOCOL_VERSION,
        BRIDGE_FEATURE_VERSION,
        DS_SCREEN_WIDTH,
        DS_SCREEN_HEIGHT,
        client.screenwidth(),
        client.screenheight()
      )
    )
  end
end

function advance_frame()
  emu.frameadvance()
  local frame = emu.framecount()
  if last_recent_text_sample_frame < 0 or frame - last_recent_text_sample_frame >= RECENT_TEXT_SAMPLE_INTERVAL then
    last_recent_text_sample_frame = frame
    sample_locked_battle_msgbuffer_recent_text()
    sample_locked_field_dialog_recent_text()
  end
  write_heartbeat(false)
end

function decode_trace_ram_state()
  local language = u8(0x02FFFE0F)
  local pointer_profile = hgss_pointer_profile(language)
  local base = u32(pointer_profile.pid_pointer_addr)
  local save_like = u32(pointer_profile.trainer_ids_pointer_addr)
  local runtime_position = position_candidate(base, "pidPointer base+0x39C dynamic candidate", 0x39C, 0x3A4, 0x3A8, 0x3AC)
  local field_system_root, field_system_candidates = find_field_system(false, save_like)
  local object_position, object_candidates = player_object_position(false, field_system_root)
  local save_position = save_position_candidate(save_like)
  local chosen_position = nil
  if object_position ~= nil and object_position.reasonable then
    chosen_position = object_position
  elseif runtime_position ~= nil and runtime_position.reasonable then
    chosen_position = runtime_position
  elseif save_position ~= nil and save_position.reasonable then
    chosen_position = save_position
  else
    chosen_position = runtime_position or save_position or {}
  end
  local active_field_system =
    (object_position and object_position.field_system) or
    (field_system_root and field_system_root.field_system) or
    nil
  if not valid_arm9_ptr(chosen_position.field_system) and valid_arm9_ptr(active_field_system) then
    chosen_position.field_system = active_field_system
    if field_system_root and field_system_root.field_system_location then
      chosen_position.field_system_location = field_system_root.field_system_location
    end
  end
  local battle_magic = u16(0x02247612)
  local in_battle_candidate = battle_magic == 0x2801
  return {
    trace_only = true,
    domain = SYSTEM_BUS,
    domain_mode = MEMORY_DOMAIN_MODE,
    failed_ram_reads = FAILED_RAM_READS,
    language_u8 = language,
    pointers = {
      base = base,
      save_like = save_like,
      pid_pointer_addr = pointer_profile.pid_pointer_addr,
      trainer_ids_pointer_addr = pointer_profile.trainer_ids_pointer_addr,
      language_profile = pointer_profile.language,
      language_offset = pointer_profile.korean_offset or 0,
    },
    player = {
      position = {
        map_id = chosen_position.map_id,
        x = chosen_position.x,
        y = chosen_position.y,
        z = chosen_position.z,
        source = chosen_position.source,
        reasonable = chosen_position.reasonable,
        field_system_location = chosen_position.field_system_location,
        facing = chosen_position.facing,
        next_facing = chosen_position.next_facing,
        previous_facing = chosen_position.previous_facing,
      },
      save_position = save_position,
      runtime_position = runtime_position,
      field_system_root = field_system_root,
      field_system_candidates = field_system_candidates,
      object_position = object_position,
      object_position_candidates = object_candidates,
    },
    battle = {
      magic = battle_magic,
      in_battle_candidate = in_battle_candidate,
      active_battle_validation = in_battle_candidate and "trace_only_battle_context_unavailable" or "not_in_battle",
    },
    text_probe = {
      current_ui = decode_current_ui_state(),
      start_menu = active_field_system and decode_start_menu_taskdata(active_field_system) or { active = false },
      touch_save_choice = active_field_system and decode_touch_save_choice_menu(active_field_system) or { active = false },
    },
  }
end

function write_response(req, ok, error_message)
  local anchor_saved = nil
  local anchor_error = nil
  local anchor_path = req.anchor_state_path
  if anchor_path ~= nil and anchor_path ~= "" then
    anchor_saved = savestate.save(anchor_path, true)
    if not anchor_saved then
      anchor_error = "savestate.save anchor_state_path failed"
      ok = false
      error_message = error_message and error_message ~= "" and (error_message .. "; " .. anchor_error) or anchor_error
    end
  end
  local trace_only = req.trace_only == "1" or req.trace_only == "true" or req.trace_only == "True"
  local ram_ok, ram_or_error = pcall(trace_only and decode_trace_ram_state or decode_ram_state)
  write_heartbeat(true)
  capture_snapshot()
  local payload = {
    id = req.id or "",
    ok = ok,
    error = error_message or "",
    traceOnly = trace_only,
    frame = emu.framecount(),
    system = emu.getsystemid(),
    bridgeProtocolVersion = BRIDGE_PROTOCOL_VERSION,
    bridgeFeatureVersion = BRIDGE_FEATURE_VERSION,
    features = {
      genericTextPrinter = true,
      staleTouchGuard = true,
      battleTextPrinter = true,
    },
    screenWidth = DS_SCREEN_WIDTH,
    screenHeight = DS_SCREEN_HEIGHT,
    clientScreenWidth = client.screenwidth(),
    clientScreenHeight = client.screenheight(),
    screenshotRawPath = SCREENSHOT_PATH,
    anchorStatePath = anchor_path,
    anchorSaved = anchor_saved,
    anchorError = anchor_error,
    touchDebug = LAST_TOUCH_DEBUG,
    textDebug = LAST_TEXT_DEBUG,
    ram = ram_ok and ram_or_error or { error = tostring(ram_or_error) },
  }
  LAST_TOUCH_DEBUG = nil
  LAST_TEXT_DEBUG = nil
  write_all(RESPONSE_PATH, json_encode(payload))
end

function press_button_table(buttons, frames, release_frames)
  frames = frame_count(frames, 6)
  release_frames = frame_count(release_frames, 4)
  for _ = 1, frames do
    joypad.set(buttons)
    advance_frame()
  end
  joypad.set({})
  for _ = 1, release_frames do
    advance_frame()
  end
end

function press_buttons(req)
  local buttons = split_buttons(req.buttons)
  local frames = frame_count(req.frames, 8)
  for _ = 1, frames do
    joypad.set(buttons)
    advance_frame()
  end
  joypad.set({})
  advance_frame()
end

function type_text_buttons(req)
  local keyboard = {}
  local rows = { "ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ", "0123456789" }
  for row_index, letters in ipairs(rows) do
    for col = 1, string.len(letters) do
      local char = string.sub(letters, col, col)
      keyboard[char] = { row = row_index - 1, col = col - 1 }
    end
  end

  local cleaned = ""
  local raw = string.upper(req.text or "")
  for i = 1, string.len(raw) do
    local char = string.sub(raw, i, i)
    if keyboard[char] then cleaned = cleaned .. char end
    if string.len(cleaned) >= 7 then break end
  end

  local steps = {}
  local function press_named(name, times)
    times = times or 1
    local buttons = {}
    buttons[button_names[name] or name] = true
    for _ = 1, times do
      press_button_table(buttons, 6, 4)
      steps[#steps + 1] = name
    end
  end

  for _ = 1, 7 do press_named("b") end
  for _ = 1, 8 do press_named("up") end
  for _ = 1, 12 do press_named("left") end

  local cursor = { row = 0, col = 0 }
  local function move_to(target)
    while cursor.row > target.row do
      press_named("up")
      cursor.row = cursor.row - 1
    end
    while cursor.row < target.row do
      press_named("down")
      cursor.row = cursor.row + 1
    end
    while cursor.col > target.col do
      press_named("left")
      cursor.col = cursor.col - 1
    end
    while cursor.col < target.col do
      press_named("right")
      cursor.col = cursor.col + 1
    end
  end

  for i = 1, string.len(cleaned) do
    local char = string.sub(cleaned, i, i)
    local target = keyboard[char]
    move_to(target)
    press_named("a")
  end

  local entry_before_confirm = decode_naming_screen_state()
  if cleaned ~= "" then
    press_button_table({ Start = true }, 8, 90)
    steps[#steps + 1] = "start"
  end

  LAST_TEXT_DEBUG = {
    requested_text = req.text or "",
    typed_text = cleaned,
    entry_before_confirm = entry_before_confirm,
    method = "dpad_keyboard",
    anchored_at = "top_row_left_after_backspace_up_left",
    events = { "cleared_text_with_b", "anchored_cursor_with_up_left", "typed_text_with_dpad_keyboard", "confirmed_with_start" },
    steps = steps,
  }
end

function touch(req)
  local x = tonumber(req.x) or 128
  local y = tonumber(req.y) or 96
  local frames = frame_count(req.frames, 8)
  local before_buttons = nil
  local before_axes = nil
  local after_buttons = nil
  local after_axes = nil
  local ok_get, got_buttons = pcall(joypad.get)
  if ok_get then before_buttons = got_buttons end
  before_axes = {
    ["Touch X"] = before_buttons and before_buttons["Touch X"] or nil,
    ["Touch Y"] = before_buttons and before_buttons["Touch Y"] or nil,
  }
  client.clearautohold()
  for _ = 1, frames do
    joypad.setanalog({ ["Touch X"] = x, ["Touch Y"] = y })
    joypad.set({ ["Touch"] = true, ["Touch X"] = x, ["Touch Y"] = y })
    local ok_after_buttons, got_after_buttons = pcall(joypad.get)
    if ok_after_buttons then after_buttons = got_after_buttons end
    after_axes = {
      ["Touch X"] = after_buttons and after_buttons["Touch X"] or nil,
      ["Touch Y"] = after_buttons and after_buttons["Touch Y"] or nil,
    }
    advance_frame()
  end
  joypad.setanalog({ ["Touch X"] = 255, ["Touch Y"] = 191 })
  joypad.set({ ["Touch"] = false, ["Touch X"] = 255, ["Touch Y"] = 191 })
  client.clearautohold()
  for _ = 1, 4 do
    advance_frame()
  end
  LAST_TOUCH_DEBUG = {
    requested_x = x,
    requested_y = y,
    frames = frames,
    before_buttons = before_buttons,
    before_axes = before_axes,
    during_buttons = after_buttons,
    during_axes = after_axes,
    method = "joypad.set+setanalog",
  }
end

function wait_frames(req)
  local frames = frame_count(req.frames, 30)
  for _ = 1, frames do
    advance_frame()
  end
end

function auto_a(req)
  local frames = frame_count(req.frames, 120)
  local elapsed = 0
  while elapsed < frames do
    for _ = 1, 8 do
      if elapsed >= frames then break end
      joypad.set({ A = true })
      advance_frame()
      elapsed = elapsed + 1
    end
    joypad.set({})
    for _ = 1, 12 do
      if elapsed >= frames then break end
      advance_frame()
      elapsed = elapsed + 1
    end
  end
end

function handle_request(req)
  local op = string.lower(req.op or "snapshot")
  if op == "snapshot" then
    write_response(req, true, "")
  elseif op == "press" or op == "hold" then
    press_buttons(req)
    write_response(req, true, "")
  elseif op == "touch" then
    touch(req)
    write_response(req, true, "")
  elseif op == "type_text" then
    type_text_buttons(req)
    write_response(req, true, "")
  elseif op == "wait" then
    wait_frames(req)
    write_response(req, true, "")
  elseif op == "auto_a" then
    auto_a(req)
    write_response(req, true, "")
  elseif op == "calibrate_position" then
    reset_local_map_object_cache()
    player_object_position(true)
    write_response(req, true, "")
  elseif op == "save_state" then
    local path = req.path or (IPC_DIR .. [[\heartgold.State]])
    local ok = savestate.save(path, true)
    write_response(req, ok, ok and "" or "savestate.save failed")
  elseif op == "load_state" then
    local path = req.path or (IPC_DIR .. [[\heartgold.State]])
    reset_local_map_object_cache()
    local ok = savestate.load(path, true)
    if ok then
      reset_local_map_object_cache()
      emu.frameadvance()
      player_object_position(true)
    end
    write_response(req, ok, ok and "" or "savestate.load failed")
  else
    write_response(req, false, "unknown op: " .. op)
  end
end

local last_request_poll_frame = -1

while true do
  local current_frame = emu.framecount()
  local should_poll_request = last_request_poll_frame < 0 or current_frame - last_request_poll_frame >= REQUEST_POLL_INTERVAL
  if should_poll_request then
    last_request_poll_frame = current_frame
  end

  if should_poll_request and file_exists(REQUEST_PATH) then
    local text = read_all(REQUEST_PATH)
    os.remove(REQUEST_PATH)
    local req_ok, req_or_error = pcall(function()
      return parse_request(text)
    end)
    if not req_ok then
      local req = { id = request_id_from_text(text), op = "parse_request" }
      write_response(req, false, tostring(req_or_error))
    else
      local req = req_or_error
      local ok, err = pcall(function()
        handle_request(req)
      end)
      if not ok then
        local wrote, write_err = pcall(function()
          write_response(req, false, tostring(err))
        end)
        if not wrote then
          write_all(
            RESPONSE_PATH,
            '{"id":"' .. escape_json(req.id or "") .. '","ok":false,"op":"' .. escape_json(req.op or "") ..
              '","error":"' .. escape_json(tostring(err) .. " / response_write_failed: " .. tostring(write_err)) .. '"}'
          )
        end
      end
    end
  end

  advance_frame()
end

