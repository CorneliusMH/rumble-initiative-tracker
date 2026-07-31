# Rumble Initiative Tracker

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension for running **Rumble Combat** — a three-rumbles-per-round initiative system with a hidden **Plan** → simultaneous **Resolve** loop and per-rumble action queueing.

Initiative includes **every connected non-GM player automatically**, plus any **scene tokens** the GM chooses to add (NPCs, summons, mounts, absent characters).

![icon](public/icon.svg)

## What it does

Each round of Rumble Combat has 3 rumbles, and each rumble has 2 phases:

1. **Plan** — everyone privately writes what their token is doing and marks Ready.
2. **Resolve** — once everyone is Ready (or the GM presses Resolve), all declarations flip face-up at the same instant. Actions resolve in initiative order.

The extension automates that loop:

- Tracks **round number, current rumble (1/2/3), and phase** for the whole table (header format `Rumble X.Y | phase | Ready: n/total`). Rumble 1 and Rumble 3 are flagged as **round start** / **round end** in the header.
- **Auto-advances to Resolve** the moment every participant is marked Ready during Plan (the GM client fires it once; a ref guard prevents duplicate flips).
- **Auto-enrolls every non-GM player** in the initiative order — each player sets their own initiative and delay.
- Lets the **GM add scene tokens** via right-click, matching the official Owlbear initiative-tracker flow.
- Lets each participant's controller declare an action privately. Declarations become visible once the phase flips to Resolve.
- Shows a live **initiative order** sorted by each participant's initiative value (minus any declared delay).
- Lets non-GM players **queue up to 3 future actions** to auto-fill the next rumble(s).
- Remembers your last few unique declarations as **history chips** for quick fill (per-browser, up to 10 unique).
- **Hides scene tokens from non-GM players** whenever the GM has toggled the token's visibility off; the GM sees the entry dimmed with a visibility-off icon.
- Lets the GM **export a timestamped combat log** (`.txt` download) capturing every declaration submission/update, queued-action activation, and phase / rumble / round change with display names.
- GM-only header controls: **▶ Resolve**, **⏩ Next Rumble**, **🔄 Reset**, **💾 Export Log**.

## How it works in OBR

### Participants

- **Players are auto-added** — as soon as a non-GM joins the room, they appear as a row in the initiative order. There is no setup; their own name is their entry.
- **Set your own initiative** — a player clicks the number on their own row to edit it. The GM can edit any row.
- **GM adds a token** — right-click any image on the map and pick **Add to Rumble Initiative**. The token appears in the order with an initiative of `0`. Only the GM sees this context menu.
- **GM removes a token** — right-click a token already in initiative and pick **Remove from Rumble Initiative**, or click the **✕** button next to the row in the popover.
- **Hidden tokens** — when the GM hides a token in the scene, it disappears from every non-GM player's initiative list (and their declaration UI). The GM still sees it, dimmed, with a visibility-off icon.

### Declaring actions

- **Non-GM players** always see their own **Declare Action** panel open on their own row (initiative rows are read-only for non-GMs; they can still click their own initiative number to edit it).
- Type an action, optionally set a **Delay** (positive delay lowers your effective initiative for this rumble without changing your base value), then click **Ready** (or **Update Ready** to change an already-ready action).
- Click a **history chip** to fill the input with a recent action. Chips never auto-ready or auto-select — they just populate the field.
- Click **Queue Next Rumble** to append the current input to your queue (up to 3 entries). Queued entries are shown below the input and can be:
  - **Edited inline** — click the text, type, then press Enter or blur to commit (Escape cancels).
  - **Reordered** with ▲ / ▼.
  - **Removed** with ✕.

### GM controls

- **▶ Resolve** — flip the current rumble from Plan to Resolve, revealing all declarations at once. Disabled while already in Resolve.
- **⏩ Next Rumble** — end the current rumble. For every participant with a queued action, the first queue entry is promoted to their active declaration (auto-Ready) and the rest of the queue shifts up. Participants with no queued action have their declaration cleared. The rumble counter ticks 1 → 2 → 3 → 1 (round +1 on rollover). Phase resets to Plan.
- **🔄 Reset** — reset the shared counters to **Rumble 1.1 / Plan**. Declarations, queued actions, and per-player initiatives are preserved.
- **💾 Export Log** — download a `.txt` combat log with a timestamped line for every event the GM client has observed since opening the popover: session start, phase / rumble / round changes (annotated with round-start / round-end for Rumble .1 and .3), declaration submissions and updates by display name, and queued-action activations. The log lives on the GM client only — it doesn't sync between clients — so keep the popover open during the fight if you want a complete record.

### GM "Declare Actions (GM)" panel

A bulk-action panel below the initiative list lets the GM declare for multiple tokens at once. Tokens are grouped and sorted into four buckets with dividers:

1. Not-ready GM-owned tokens
2. Not-ready player-owned tokens
3. Ready GM-owned tokens
4. Ready player-owned tokens

Ready tokens show a ✓ marker. Type an action (or click a history chip to fill), tick the tokens to affect, and press the full-width **Apply to N Tokens** button. Applied actions are marked Ready immediately and pushed to the history chips.

## Storage model

All shared state lives under the namespace `com.rumble.initiative`.

- **Scene token membership + initiative** — scene-item metadata under `com.rumble.initiative/initiative`. A token is "in initiative" iff this key is present. Removing the key removes the token from the tracker.
- **Per-player initiative** — room metadata under `com.rumble.initiative/player/<playerId>`. Room-level storage means the value is visible to every client and survives reloads; the UI restricts writes to that player or the GM.
- **Shared session state** (round, rumble, phase) — room metadata under `com.rumble.initiative/core`.
- **Per-participant declarations and queue** — room metadata under `com.rumble.initiative/decl/<participantId>`. `<participantId>` is a scene item id for tokens, or `player:<playerId>` for auto-enrolled player rows. Splitting per-participant keys avoids write contention with the core state and keeps every update inside Owlbear's 16 kB room-metadata cap.
- **History chips** — local storage under `com.rumble.initiative/quick-history` (per-browser, not synced).
- A local promise-chain queue serializes writes from the same client so concurrent edits don't clobber each other.

**Reset** only rewrites the `core` key. Declarations and per-player initiatives are left in place.

## Permissions

The extension requests no OBR permissions.

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

The token-membership context menu, item-metadata initiative pattern, and hidden-token visibility handling follow the official [Owlbear Rodeo SDK initiative-tracker tutorial](https://github.com/owlbear-rodeo/sdk-tutorials/tree/main/initiative-tracker). The Plan/Resolve loop, per-player auto-enrollment, per-rumble queueing, and rumble/round tracking on top of it are specific to this extension.

## License

MIT.
