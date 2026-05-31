# Rumble Initiative Tracker

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension for running **Rumble Combat** — a three-rumbles-per-round initiative system with a hidden declare → simultaneous reveal → in-order resolve loop.

Initiative is tied to **scene tokens**, not to logged-in players, so you can run NPCs, summons, mounts, and absent characters from the same UI a player uses for their own token.

![icon](public/icon.svg)

## What it does

Each round of Rumble Combat has 3 rumbles, and each rumble has 3 phases:

1. **Declare** — everyone secretly writes what their token is doing.
2. **Reveal** — once everyone is ready, all declarations flip face-up at the same instant.
3. **Resolve** — actions resolve in initiative order.

The extension automates that loop:

- Tracks **round number, current rumble (1/2/3), and phase** for the whole table.
- Surfaces **beginning-of-turn / mid / end-of-turn** cues automatically (rumble 1 / 2 / 3).
- Lets each token's controller declare an action privately. Declarations only become visible once the GM advances to **Reveal** — or automatically when every participant is marked **Ready**.
- Shows a live **initiative order** sorted by each token's initiative value.
- Keeps a **timestamped combat log** of declarations across the session, with one-click clipboard export.
- Remembers your last few unique declarations as **Quick Reuse** buttons (per-browser).
- Provides preset action **categories** (Move, Attack, Charge Up, Cast Spell, Skill Check) for quick tagging.
- GM-only buttons: **Advance Phase**, **Reveal Now**, **Next Rumble**, **Reset Combat**.

## How it works in OBR

- **Add a token to initiative** — right-click a Character-layer token and pick **Add to Rumble Initiative**. You'll be prompted for an initiative value. (Same right-click flow used by the official SDK initiative tutorial.)
- **Remove a token** — right-click an initiative token and pick **Remove from Rumble Initiative**, or use the popover's **Remove Token** button.
- **Declare an action** — open the extension popover, select your token in the scene, type your action (optionally pick a category), and click **Ready**.
- **Edit initiative** — select a token and change its number in the popover; the value lives on the token's metadata, so it survives reloads and is visible to everyone.
- **Reveal** — when all participants are Ready, the GM client auto-advances to Reveal. The GM can also force it with **Reveal Now**.
- **Next Rumble / Round** — **Next Rumble** clears declarations and ticks 1 → 2 → 3 → 1 (round +1 on rollover). **Reset Combat** wipes everything back to Round 1, Rumble 1.

## Storage model

- Per-token data (membership + initiative value) lives in **scene-item metadata** under `com.rumble.initiative/initiative`. This is the same pattern as the official Owlbear SDK initiative-tracker tutorial, and it means initiative travels with the token.
- Shared session state (round, rumble, phase, combat log) lives in **room metadata** under `com.rumble.initiative/core`.
- Each token's pending declaration lives in its own room-metadata key `com.rumble.initiative/decl/<tokenId>`. Splitting per-token keys avoids write contention with the core state and keeps every update inside Owlbear's 16 kB room-metadata cap.
- A local promise-chain queue serializes writes from the same client so concurrent edits don't clobber each other.
- The combat log is capped at 60 entries with each text field truncated to ~200 characters to stay safely under the size cap.

## Permissions

The extension requests one OBR permission:

- `clipboard-write` — used by the **Copy** button in the Combat Log panel.

## Install

This repo is a standard Vite + TypeScript extension. To self-host:

```bash
npm install
npm run build
# serve the contents of dist/ from any static host
```

Then in Owlbear Rodeo, add a custom extension pointing at the hosted `manifest.json`.

For local development:

```bash
npm run dev
```

…and load `http://localhost:5173/manifest.json` as a custom extension.

## Project layout

```
public/
  manifest.json   OBR extension manifest
  icon.svg
src/
  main.ts         UI, OBR bootstrap, context menu, render loop
  state.ts        Room-metadata helpers, mutation queue, sanitizers
  types.ts        Shared TypeScript types
  styles.css      Popover styling
index.html        Popover entry point
```

## Credit

The token-membership context menu and item-metadata initiative pattern follow the official [Owlbear Rodeo SDK initiative-tracker tutorial](https://github.com/owlbear-rodeo/sdk-tutorials/tree/main/initiative-tracker). The declare/reveal loop on top of it is specific to this extension.

## License

MIT.
