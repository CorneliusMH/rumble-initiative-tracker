---
title: Rumble Initiative Tracker
description: Initiative tracker for Rumble Combat — 3 rumbles per round, with a hidden Plan phase and a simultaneous Resolve phase.
author: Cornelius
tags:
  - combat
manifest: https://rumble-initiative-tracker-beta.onrender.com/manifest.json
learn-more: https://github.com/CorneliusMH/rumble-initiative-tracker
---

# Rumble Initiative Tracker

An initiative tracker for **Rumble Combat**: 3 rumbles per round, each rumble alternating between a private **Plan** phase and a simultaneous **Resolve** phase.

## How a round works

Each round has 3 rumbles. Each rumble has 2 phases:

1. **Plan** — every participant privately types what they're doing and clicks **Ready**.
2. **Resolve** — once everyone is Ready (or the GM presses ▶ Resolve), all declarations flip face-up at the same time to be resolved in initiative order.

The header always shows `Rumble X.Y | phase | Ready: n/total`. Rumble .1 and .3 are flagged as round-start / round-end.

## Non-GM Player Usage

- Players are automatically added to the initiative list. 
- Players set their own initiative.
- In the **Plan** phase, players input their action and click **Ready**.
- Players can click on history tile to repeat a previously declared action.
- Players can queue up to 3 more actions once they have declared their action for the current Rumble.
- Queued actions can be re-arranged, edited, or removed.
- The next queued action is auto-readied when the resolve plan is complete.

## Participants

- **Players are auto-added.** Every non-GM in the room appears as a row automatically.
- **Players set their own initiative** by clicking the number on their own row. GMs can edit any row.
- **GM adds a token to initiative** by right-clicking it on the map and picking **Add to Rumble Initiative**. Use **Remove from Rumble Initiative** (or the ✕ on the row) to take it out.
- **Hidden scene tokens** disappear from every non-GM player's list. The GM still sees them, dimmed.

## Declaring actions

- Type your action, optionally set a **Delay** (positive delay lowers your initiative), then click **Ready**.
- Click a **history chip** to fill the input from your last 10 unique actions.
- Click **Queue Next Rumble** to line up to 3 future actions. Queued entries can be edited inline, reordered with ▲ / ▼, or removed with ✕. When the GM advances to the next rumble, the top queued entry is promoted to your active declaration and auto-Readied.

## GM controls

- **▶ Resolve** — flip the current rumble from Plan to Resolve.
- **⏩ Next Rumble** — end the current rumble, promote queued actions, and tick the counter (1 → 2 → 3 → 1, round +1 on rollover).
- **🔄 Reset** — reset the shared counters back to Rumble 1.1 / Plan. Declarations and per-player initiatives are preserved.
- **💾 Export Log** — download a timestamped `.txt` combat log of every phase change, declaration, and queue activation the GM client has seen since opening the popover.

### Bulk declare (GM)

A **Declare Actions (GM)** panel below the initiative list lets the GM declare for multiple tokens at once, grouped into not-ready GM, not-ready player, ready GM, ready player. Type an action, tick the tokens, and press **Apply to N Tokens**.

## Storage

All shared state is scoped to the current scene under the namespace `com.rumble.initiative`. Switching scenes shows a fresh order; returning to a scene restores its round, rumble, phase, declarations, and per-player initiatives. History chips are stored in local storage (per-browser, not synced).

## Permissions

The extension requests no OBR permissions.

## Support

Source and issues: <https://github.com/CorneliusMH/rumble-initiative-tracker>
