# GPT Plays Pokémon HeartGold

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20BizHawk-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)

An AI agent harness that plays **Pokémon HeartGold** in a live Nintendo DS emulator.

The observation contains the current game screen and a decoded snapshot of the game's live RAM. The agent then sends controller-style actions back to BizHawk, playing from the state the emulator is running at that moment.

No ROMs, BIOS files, savestates, API keys, or gameplay run artifacts are included.

## Overview

This project connects a model to Pokémon HeartGold through a small local stack:

| Layer | Component | Role |
| --- | --- | --- |
| Emulator | BizHawk 2.11 with the NDS melonDS core | Runs Pokémon HeartGold |
| Lua bridge | `heartgold_benchmark/bizhawk/HeartGoldBridge.lua` | Lets BizHawk expose screen, memory, and input hooks |
| Python bridge | `heartgold_benchmark/heartgold_bridge.py` | Reads RAM, captures screenshots, and talks to BizHawk |
| Agent server | `server/` | Serves observation and action endpoints |
| Dashboard | `frontend/` | Shows what the agent is seeing and doing |

The main observation mode is `ram_assisted`: each response contains the current DS screenshot and a decoded RAM snapshot from that same moment. During overworld play, that means map, position, facing, nearby collisions/objects, and visible text. If a menu or battle is open, the RAM snapshot reflects that screen instead.

## Core Features

- Live BizHawk/NDS bridge for screen capture, RAM reads, controller input, and memory-domain detection.
- HeartGold RAM decoders for map state, text/dialog, battles, menus, party/inventory, PC storage, and progress systems.
- OpenAI API, Codex Desktop, and Codex CLI support through the same local observation/action server.
- Action helpers for movement, touch input, dialog advancement, and path-to-location attempts.
- Benchmark metrics for steps, actions, map transitions, unique maps, battles, progress, deadlock signals, and run comparability.
- PowerShell scripts for startup, shutdown, reset, smoke tests, and validation.

## Requirements

| Requirement | Notes |
| --- | --- |
| Windows | The start scripts are PowerShell-first. |
| Python | 3.10+ recommended. |
| Node.js | 18+ recommended. |
| BizHawk | 2.11 with the NDS melonDS core. |
| Pokémon HeartGold ROM | User-provided legal copy. Not included. |
| Codex Desktop, Codex CLI, or OpenAI API | Player runtime. Choose one mode below. |

## Player Modes

| Mode | Pick this if... | What happens |
| --- | --- | --- |
| Codex Desktop | You want to play from a Codex Desktop chat. | You choose the model in Codex Desktop. The harness serves the live observation/action endpoints and the chat uses them to play. |
| Codex CLI | You want the harness to run a Codex CLI model for you. | The harness calls `codex exec -m <model>` for each turn and applies the returned action to the emulator. |
| OpenAI API | You want the classic server-run agent loop. | The Node server calls the OpenAI API for each turn and applies the returned tool/action response to the emulator. |

## Quick Start

Install dependencies from the repo root:

```powershell
python -m pip install -r requirements.txt
cd server
npm install
cd ..
```

Set local paths:

```powershell
$env:BIZHAWK_EXE = 'C:\path\to\EmuHawk.exe'
$env:HEARTGOLD_ROM = 'C:\path\to\PokémonHeartGold(USA).nds'
```

Then choose one startup path:

<details>
<summary><strong>Codex Desktop</strong> - choose a model in Codex Desktop</summary>

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-heartgold-codex-desktop.ps1 -ReasoningEffort xhigh
```

The script starts the Python bridge, launches BizHawk, loads the Lua bridge, starts the Node server, and serves the dashboard.
When the stack is ready, choose a player model in Codex Desktop and start a chat with:

```text
Use the local HeartGold player HTTP interface.

First fetch:
GET http://127.0.0.1:9885/codexDesktop/observation

Read the returned observation and continue from it.
```

The returned observation includes the runtime prompt, current screenshot, decoded RAM state, recent history, and action schema.

</details>

<details>
<summary><strong>Codex CLI</strong> - run through codex exec</summary>

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-heartgold-benchmark.ps1 -AgentProvider codex-cli -Model <your-model>
```

This starts the same local stack, builds the prompt and action schema, runs `codex exec`, reads the returned JSON action, and applies it to the emulator.

</details>

<details>
<summary><strong>OpenAI API</strong> - run through the OpenAI API</summary>

```powershell
$env:OPENAI_API_KEY = '<your-api-key>'
powershell -ExecutionPolicy Bypass -File scripts\start-heartgold-benchmark.ps1 -AgentProvider openai -Model <your-model>
```

This starts the same local stack, runs the player loop inside the Node server, and applies each tool/action response to the emulator.

</details>

Stop harness-owned processes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-heartgold-benchmark.ps1
```

Reset local benchmark state:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\reset-heartgold-benchmark.ps1
```

## Local Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET http://127.0.0.1:8010/health` | Python bridge health check |
| `GET http://127.0.0.1:9885/health` | Node server health check |
| `GET http://127.0.0.1:9885/codexDesktop/observation` | Current screen and decoded game-state snapshot |
| `POST http://127.0.0.1:9885/codexDesktop/action` | Submit the next action |
| `http://127.0.0.1:5173` | Dashboard when enabled |

## What The Agent Sees

The player surface contains the current screenshot, decoded RAM state, recent history, memory/objectives, and the action schema.

In Codex Desktop mode, the player receives that surface from `GET /codexDesktop/observation`, including `model_input.operator_prompt` and `model_input.user_input_text`. In Codex CLI and OpenAI API modes, the server builds the same gameplay prompt/action context internally before asking the selected model for the next action.

## Dashboard

The dashboard is for human inspection. It shows the current screenshot, decoded RAM, recent actions, and action-verifier state so you can check what the agent is using during a run.

By default, the dashboard reads cached server state instead of polling the emulator bridge directly. That keeps live gameplay from being slowed down by monitoring.

## Project Layout

```text
heartgold_benchmark/
  bizhawk/HeartGoldBridge.lua       BizHawk Lua bridge
  heartgold_bridge.py               Python bridge and RAM decoder
server/                             Node server and agent endpoints
frontend/                           Dashboard
scripts/                            Start, stop, reset, and smoke-test scripts
```

## Validation

Useful static checks:

```powershell
node --check server/index.js
node --check server/src/services/codexDesktopService.js
node --check server/src/services/codexCliService.js
node --check server/src/ai/promptBuilder.js
node --check frontend/app.js
python -m py_compile heartgold_benchmark\heartgold_bridge.py heartgold_benchmark\rom_data.py
```

With BizHawk and the ROM configured:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke-heartgold-stack.ps1
powershell -ExecutionPolicy Bypass -File scripts\test-heartgold-actions.ps1
powershell -ExecutionPolicy Bypass -File scripts\test-heartgold-pathfinding.ps1
```

## License

This repository is released under the MIT License. See [LICENSE](LICENSE).

## Credits

This project was inspired by [Clad3815/gpt-play-pokemon-firered](https://github.com/Clad3815/gpt-play-pokemon-firered), which established the original emulator plus LLM-agent bridge idea for Pokémon FireRed.

This HeartGold version uses a separate Nintendo DS/BizHawk implementation with HeartGold-specific RAM decoding, map/navigation state, action verification, and a local dashboard.
