# Rumble Initiative Tracker

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension for running **Rumble Combat** — a three-rumbles-per-round initiative system with a hidden declare → simultaneous reveal → in-order resolve loop.

Initiative includes **every connected non-GM player automatically**, plus any **scene tokens** the GM chooses to add (NPCs, summons, mounts, absent characters).

![icon](public/icon.svg)

## What it does

Each round of Rumble Combat has 3 rumbles, and each rumble has 3 phases:

1. **Declare** — everyone secretly writes what their token is doing.
2. **Reveal** — once everyone is ready, all declarations flip face-up at the same instant.
3. **Resolve** — actions resolve in initiative order.

The extension automates that loop:

- Tracks **round number, current rumble (1/2/3), and phase** for the whole table.
- Surfaces **beginning-of-turn / mid / end-of-turn** cues automatically (rumble 1 / 2 / 3).
- **Auto-enrolls every non-GM player** in the initiative order — each player sets their own initiative and delay.
- Lets the **GM add scene tokens** (NPCs, mounts, etc.) via right-click, matching the official Owlbear initiative-tracker flow.
- Lets each participant's controller declare an action privately. Declarations only become visible once the GM advances to **Reveal** — or automatically when every participant is marked **Ready**.
- Shows a live **initiative order** sorted by each participant's initiative value (minus any declared delay).
- Keeps a **timestamped combat log** of declarations across the session, with one-click clipboard export.
- Remembers your last few unique declarations as **Quick Reuse** buttons (per-browser).
- Provides preset action **categories** (Move, Attack, Charge Up, Cast Spell, Skill Check) for quick tagging.
- **Hides scene tokens from non-GM players** whenever the GM has toggled the token's visibility off in the scene; the GM sees the entry dimmed with a visibility-off icon.
- GM-only buttons: **Reveal Now**, **Next Phase**, **Next Rumble**, **Reset**.

## How it works in OBR

- **Players are auto-added** — as soon as a non-GM joins the room, they appear as a row in the initiative order. There is no setup for a player to be tracked; their own name is their entry.
- **Set your own initiative** — a player clicks the number on their own row to edit it. The GM can edit any row.
- **GM adds a token** — right-click any image on the map and pick **Add to Rumble Initiative**. The token appears in the order with an initiative of `0`; the GM (or the token's assigned owner) can then edit that number.
- **GM removes a token** — right-click a token already in initiative and pick **Remove from Rumble Initiative**, or click the **✕** button next to the row in the popover.
- **Assign a token to a player** — as GM, select the token, then pick the player from the **Owner (Player)** dropdown. That player can then edit the token's initiative and declare its action.
- **Hidden tokens** — when the GM hides a token in the scene, it disappears from every non-GM player's initiative list (and their declaration UI). The GM still sees it, dimmed, with a visibility-off icon.
- **Declare an action** — click your row (or select a token you control) in the popover, type your action (optionally pick a category), and click **Ready**. Player rows can't be selected in the scene, so clicking the row in the popover is the way to target yourself.
- **Delay** — set a positive delay to lower your effective initiative for this rumble without changing your base value.
- **Reveal** — when all participants are **Ready**, the GM client auto-advances to Reveal. The GM can also force it with **Reveal Now**.
- **Next Rumble / Round** — **Next Rumble** clears declarations and ticks 1 → 2 → 3 → 1 (round +1 on rollover). **Reset** wipes core state back to Round 1, Rumble 1.

## Storage model

- **Scene token membership + initiative** live in **scene-item metadata** under `com.rumble.initiative/initiative`. A token is "in initiative" iff this key is present. Removing the key removes the token from the tracker. This matches the official Owlbear SDK initiative-tracker pattern, and means a token's initiative travels with it.
- **Per-player initiative** (for auto-enrolled non-GM players) lives in **room metadata** under `com.rumble.initiative/player/<playerId>`. Room-level storage means the value is visible to every client and survives reloads, and the UI restricts writes to that player or the GM.
- **Shared session state** (round, rumble, phase, combat log) lives in **room metadata** under `com.rumble.initiative/core`.
- **Per-participant declarations** live in **room metadata** under `com.rumble.initiative/decl/<participantId>`. `<participantId>` is a scene item id for tokens, or `player:<playerId>` for auto-enrolled player rows. Splitting per-participant keys avoids write contention with the core state and keeps every update inside Owlbear's 16 kB room-metadata cap.
- A local promise-chain queue serializes writes from the same client so concurrent edits don't clobber each other.
- The combat log is capped at 60 entries with each text field truncated to ~200 characters to stay safely under the size cap.

## Permissions

The extension requests one OBR permission:

- `clipboard-write` — used by the **Copy** button in the Combat Log panel.

## Install

This repo is a standard Vite + TypeScript + React extension. To self-host:

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
  main.tsx        React entry point
  App.tsx         UI, OBR bootstrap, context menu, initiative derivation
  state.ts        Room-metadata helpers, mutation queue, sanitizers
  types.ts        Shared TypeScript types
  styles.css      Popover styling
index.html        Popover entry point
```

## Credit

The token-membership context menu, item-metadata initiative pattern, and hidden-token visibility handling follow the official [Owlbear Rodeo SDK initiative-tracker tutorial](https://github.com/owlbear-rodeo/sdk-tutorials/tree/main/initiative-tracker). The declare/reveal loop, per-player auto-enrollment, and rumble/round tracking on top of it are specific to this extension.

## License

MIT.

