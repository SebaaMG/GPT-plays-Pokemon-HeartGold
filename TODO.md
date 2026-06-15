# TODO

## P0 - Harness Contract

- Add a contract test suite for RAM+image observations that fails when current gameplay state is missing, stale, contradictory, or presented as an alternate mode.
- Add invariant tests for visible interactables: every `use_from` tile must be reachable, passable, and not occupied by a blocking runtime object.
- Add invariant tests for action artifacts: in-game interruptions must report interruption type, remaining queued commands, and final state without marking delivered input as bridge failure.
- Add invariant tests for generic action transition summaries: before/after RAM+image differences must expose opened text, screen phase changes, facing/position changes, map transitions, battle starts, and skipped remaining commands without story-specific rules or bespoke model-visible variables.
- Add negative contract tests that fail if a harness fix introduces scene-specific model-visible helpers, one-off validators, or route/oracle labels instead of canonical engine primitives.
- Add decoded-RAM surface invariants that fail if model-visible `decoded_ram` contains raw bridge dumps, monitor/debug/oracle data, raw event flags, or story-progress labels; also fail if required gameplay primitives are absent instead of decoded.
- Add a compact model-visible action outcome summary so the model sees final mechanical facts without verbose per-frame logs.
- Audit model-visible prompts for any language that normalizes missing RAM, screenshot-only play, state-specific fixes, or route hints.
- Add negative contract tests that fail if proximity alone creates model-visible choice semantics such as `selection_cluster`; grouped affordances may improve readability, but actual selection state must come from current screen/menu/dialog/RAM state.

## P1 - Engine Primitives

- Strengthen generic current text/menu/dialog decoding so rendered prompts are represented in RAM+image state across the game.
- Normalize the player-facing observation surface around canonical primitives: player, screen, world, party, progress, action history, image.
- Ensure visible objects/check targets are ordered by player relation, engine affordance, and spatial readability without implying choice/selection semantics that the current game screen has not exposed.
- Use one canonical player-facing state surface across Codex Desktop, CLI, and API modes so models do not receive a different, less structured game description depending on runner.
- Avoid adding new gameplay fields unless they are stable engine primitives. Prefer organizing existing RAM fields and deriving compact before/after summaries from them.
- Treat forced movement, scripts, and failed experiments as ordinary action transitions. Do not create custom variables for each script; expose the generic before/after facts that a player would experience through the controller and screen.
- Audit object-selection/current-screen UIs as generic screen state, not object-cluster heuristics. If a device rotates or highlights options through D-pad/touch input, the RAM+image surface should expose the current screen, current text/prompt, highlighted/confirmable option when engine-visible, and action outcomes.
- Keep touch support as a virtual DS control surface with clear coordinate contracts and result verification. Do not add prompt rules that force or forbid stylus use; benchmark behavior should come from the model's own control choice.
- Add ROM/map-data audits that run without a live model and check map bounds, collision semantics, object/event affordance shape, and warp/connectivity consistency.

## P2 - Benchmark Runs

- Run the standard startup prompt with `gpt-5.4-mini` and `gpt-5.5` `low` from comparable starting states.
- Do not apply large fixes after a small-model failure until `gpt-5.5 low` has been tested against the same RAM+image contract.
- Treat live runs as integration smoke tests. They can reveal defects, but coverage must come from generic contract/invariant tests.
- Record whether a run ended because of model uncertainty, gameplay error, harness observation failure, harness action failure, or reaching the first rival battle.

## P3 - Documentation

- Keep `AGENTS.md`, `README.md`, `server/prompts_heartgold/game.txt`, and this TODO aligned after every harness contract change.
- When OpenAI model-specific guidance is needed, use GPT-5.5 guidance explicitly and cite the official docs link in project docs or PR notes.
