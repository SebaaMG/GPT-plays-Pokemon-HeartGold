# Agent Instructions

These rules are persistent project guidance for future Codex turns and compacted sessions.

## Core Objective

Validate and harden the Pokemon HeartGold RAM+image harness so models can play the game from the official observation/action interface. The target benchmark flow is playing autonomously until the first rival battle. Compare a small model against `gpt-5.5` at `low` reasoning before making large fixes.

## Non-Negotiable Harness Contract

- `ram_assisted` is one synchronized observation: current DS screenshot plus decoded RAM from the same emulator moment.
- RAM+image must work as the primary game sensor. Do not frame missing RAM as acceptable screenshot-only play.
- Missing, stale, contradictory, or non-current gameplay state is a harness defect and is not benchmark-comparable.
- Fix generic engine primitives, not individual story states. A new map, object, menu, or dialog should work because the generic map/collision/object/text/menu/battle/action contracts work.
- Do not add walkthrough labels, route hints, or objective oracles. Labels like `starter_selector` are forbidden unless the game itself displays that text to the player.
- Do not solve confusion by adding state-specific validators. Add invariant checks over generic primitives.
- Do not proliferate model-visible variables for special cases. Extra fields are allowed only when they are stable engine primitives or compact summaries derived directly from canonical RAM+image before/after state. Do not add bespoke variables for one scene, NPC, script, or puzzle.
- Do not build a third gameplay layer that rescues individual failures with custom variables. If a model can only proceed after a case-specific field is added, the generic RAM/ROM primitive or the generic action-transition summary is still insufficient.
- A model-visible field is acceptable only if it is produced uniformly from the same engine source across the game. A field added because one run got stuck in one place is not acceptable unless it generalizes as a canonical primitive.
- Do not infer choice/selection semantics from proximity alone. Spatially nearby check targets may be ordered or grouped for readability, but the model-visible surface must not call them a selection cluster unless the game screen/RAM exposes an actual current selection UI.
- Model-visible RAM must be a canonical gameplay surface, not a raw bridge dump. Removing monitor-only internals, raw event flags, oracle/debug structures, and diagnostics is required; hiding a missing gameplay primitive is forbidden. If position, facing, movement, collision, object, text/menu/battle, or action-transition state is missing or wrong, repair that decoder/contract instead of filtering around it.
- The model is allowed to make gameplay mistakes. The harness must report what happened mechanically without pretending the input failed.

## Observation Requirements

- Expose current map, position, facing, movement state, collision/grid context, runtime objects/NPCs, visible interactables, warps/connections, party/inventory/progress, battle/menu/dialog/current screen state when relevant.
- Interactables must be engine-derived affordances, not story hints. `talk`, `check`, `warp`, `current facing target`, reachable `use_from`, distance, and required facing are acceptable.
- Interactables must be organized by relationship to the player before broad candidates: current facing target first, nearby visible affordances second. Avoid flat lists of unexplained points, but also avoid heuristic choice groups that imply gameplay semantics not exposed by the current screen.
- `use_from` tiles must be currently reachable and valid standing tiles according to generic collision/object rules.
- Current text/menu/battle state must be decoded as part of RAM+image. If a rendered prompt is active and structured state is insufficient to play, treat that as a harness defect to fix.
- The screenshot and RAM should be presented as related evidence for the same moment, not as unrelated sources.
- Touch and button inputs are both ordinary controller surfaces. The prompt may explain coordinate systems and reliability tradeoffs, but must not force a policy such as "never touch" or "always touch"; the model should choose from the visible current UI and verify the result.

## Action Result Requirements

- Preserve general mechanical outcomes for the model: input delivered, visible effect, interruption by dialog/battle/menu/collision/map transition, remaining queued commands, final map/position/facing/screen phase.
- Action outcomes must be derived from generic before/after RAM+image transition facts, not story-specific exceptions or new bespoke state variables. If an input opens text, triggers a script, changes facing/position, starts battle, or interrupts the remaining command queue, the model-visible result must say that mechanically using canonical fields.
- Forced/scripted movement is represented only as generic before/after transition facts such as position changed, facing changed, dialogue opened, battle started, or remaining commands skipped. Do not add labels like `professor_stopped_you`, `starter_selector`, or equivalent scene-specific helpers.
- Do not add behavioral heuristics that rescue confusion by watching repeated model failures. A compact action result may report what changed, what did not change, and whether input was accepted according to engine/RAM state; it must not become a separate gameplay coach.
- Keep action results compact. Report facts a player could experience; do not include verbose implementation logs unless needed for diagnostics.
- Separate action transport success from benchmark semantic success. A command interrupted by in-game dialog is normal gameplay progress, not a bridge failure.
- Do not expose `a_until_end_of_dialog` in the benchmark action surface or use it as a workaround for missing observation data.

## Validation Strategy

- Do not require firsthand live observation of every possible game state.
- Build and run contract/invariant tests over saved observations, action artifacts, and ROM-derived map data.
- Required invariant families: RAM+image freshness/synchrony, canonical position/facing consistency, collision/use_from reachability, current text/menu/battle state, action interruption reporting, stale snapshot rejection, and no model-visible story oracles.
- Live model runs are integration smoke tests and model-comprehension comparisons, not the sole proof that the harness works.

## Subagent Benchmark Protocol

- Use the standard startup prompt unless explicitly changing the experiment:

```text
Use the local HeartGold player HTTP interface.

First fetch:
GET http://127.0.0.1:9885/codexDesktop/observation

Read the returned observation and continue from it.

Run target: keep playing until the first rival battle starts. Stop only if the local interface itself returns an explicit concrete blocker, harness error, or ok:false that prevents further observation/input. Do not end the run because you are uncertain, lost, or out of ideas; if the interface still accepts observations/actions, keep playing from RAM+image.
```

- Do not give the subagent extra coordinates, explanations, route hints, or repo context.
- If the subagent stops for uncertainty while the interface works, that is a model/prompt comprehension issue unless the observation/action contract is objectively misleading.
- If the subagent finds a harness defect, fix the generic primitive that caused it and add a contract test.

## GPT-5.5 Prompting Guardrails

Based on OpenAI's GPT-5.5 reasoning-model guidance:

- Keep stable operating rules in persistent docs/prompts so compaction does not erase them.
- Put dynamic observations and action history near the end of model input; keep shared policy stable.
- Put tool-specific details in tool schema/descriptions where possible.
- Preserve completed actions, active assumptions, tool outcomes, unresolved blockers, and the next concrete goal across compaction.
- Use `gpt-5.5` guidance when the task is specifically about GPT-5.5; do not silently substitute generic GPT-5 guidance.

Official reference: https://developers.openai.com/api/docs/guides/prompt-guidance
