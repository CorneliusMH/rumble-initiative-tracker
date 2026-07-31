import React, { useEffect, useState } from "react";
import OBR, { Item, Player } from "@owlbear-rodeo/sdk";
import {
  CORE_KEY,
  ITEM_META_KEY,
  PLAYER_PARTICIPANT_PREFIX,
  advanceDeclarationsToNextRumble,
  getDefaultCore,
  getQuickHistory,
  mutateCoreState,
  onMetadataChange,
  pushQuickHistory,
  readDeclarations,
  readPlayerInits,
  sanitizeCore,
  setDeclaration,
  setPlayerInit,
} from "./state";
import type { CoreState, Declaration, Participant, QueuedAction } from "./types";
import type { PlayerInitiativeData, QuickHistoryEntry } from "./state";

interface ItemInitiativeMeta {
  initiative: number;
  ownerId?: string;
  delay?: number;
  excluded?: boolean;
}

interface LogEntry {
  timestamp: number;
  text: string;
}

export function App() {
  const [sceneReady, setSceneReady] = useState(false);
  const [coreState, setCoreState] = useState<CoreState>(getDefaultCore());
  const [declarations, setDeclarations] = useState<Record<string, Declaration>>({});
  const [tokenParticipants, setTokenParticipants] = useState<Participant[]>([]);
  const [playerInits, setPlayerInits] = useState<Record<string, PlayerInitiativeData>>({});
  const [role, setRole] = useState<"GM" | "PLAYER">("PLAYER");
  const [playerId, setPlayerId] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [manualSelectionId, setManualSelectionId] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [draftAction, setDraftAction] = useState("");
  const [bulkActionText, setBulkActionText] = useState("");
  const [bulkSelection, setBulkSelection] = useState<string[]>([]);
  const [history, setHistory] = useState<QuickHistoryEntry[]>([]);
  const [obrReady, setObrReady] = useState(false);
  const [editingInitiativeId, setEditingInitiativeId] = useState<string | null>(null);
  const [editingInitiativeValue, setEditingInitiativeValue] = useState("");
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [editingQueueValue, setEditingQueueValue] = useState("");
  const roleRef = React.useRef<"GM" | "PLAYER">("PLAYER");
  const initializingRef = React.useRef(true);

  // GM-only combat log (kept locally on this client; exported as a .txt file).
  const logRef = React.useRef<LogEntry[]>([]);
  const coreSnapshotRef = React.useRef<CoreState | null>(null);
  const declSnapshotRef = React.useRef<Record<string, Declaration> | null>(null);
  const participantsRef = React.useRef<Participant[]>([]);
  const playersRef = React.useRef<Player[]>([]);

  // Initialize theme - REMOVED, will be done inside OBR.onReady
  // useEffect(() => { ... })

  const applyThemeToDOM = (t: any) => {
    const root = document.documentElement;
    const mode = t?.mode === "LIGHT" ? "light" : "dark";
    const bgColor = t?.background?.default || (mode === "light" ? "#ffffff" : "#2a2a2a");
    const textColor = t?.text?.primary || (mode === "light" ? "#000000" : "#ffffff");
    const primaryColor = t?.primary?.main || (mode === "light" ? "#1976d2" : "#0d47a1");
    
    root.style.setProperty("--theme-mode", mode);
    root.style.setProperty("--bg-primary", bgColor);
    root.style.setProperty("--bg-secondary", mode === "light" ? "#f5f5f5" : "#333333");
    root.style.setProperty("--text-primary", textColor);
    root.style.setProperty("--text-secondary", mode === "light" ? "#666666" : "#aaaaaa");
    root.style.setProperty("--color-primary", primaryColor);
    root.style.setProperty("--color-action", mode === "light" ? "#1976d2" : "#89b4fa");
  };

  // Initialize OBR and subscribe to events
  useEffect(() => {
    const setup = async () => {
      try {
        await OBR.onReady(async () => {
          try {
            // 0. Initialize theme first
            try {
              const t = await OBR.theme.getTheme();
              applyThemeToDOM(t as any);

              OBR.theme.onChange((newTheme) => {
                applyThemeToDOM(newTheme as any);
              });
            } catch (e) {
              console.warn("Failed to initialize theme:", e);
            }

            // 1. Get initial player state
            const [r, pid, pname, sceneIsReady, sel] = await Promise.all([
              OBR.player.getRole(),
              OBR.player.getId(),
              OBR.player.getName(),
              OBR.scene.isReady(),
              OBR.player.getSelection(),
            ]);
            setRole(r);
            roleRef.current = r;
            setPlayerId(pid);
            setPlayerName(pname);
            setSceneReady(sceneIsReady);
            setSelection(sel ?? []);

            // 2. Register listeners BEFORE initial data fetches so we don't miss updates
            //    if one of the fetches fails or is slow (e.g. items on a not-yet-ready scene).
            const unsubscribers: Array<(() => void) | void> = [];

            try {
              unsubscribers.push(
                OBR.player.onChange((player) => {
                  try {
                    setRole(player.role);
                    roleRef.current = player.role;
                    const newSel = player.selection ?? [];
                    setSelection(newSel);
                    // A fresh scene selection overrides any prior popover-row click.
                    if (newSel.length > 0) setManualSelectionId(null);
                  } catch (e) {
                    console.warn("Error in player onChange:", e);
                  }
                })
              );
            } catch (e) {
              console.warn("Failed to register player onChange:", e);
            }

            try {
              unsubscribers.push(
                OBR.scene.onReadyChange(async (isReady) => {
                  try {
                    setSceneReady(isReady);
                    if (isReady) {
                      const items = await OBR.scene.items.getItems();
                      setTokenParticipants(
                        deriveTokenParticipants(items as Item[], roleRef.current)
                      );
                    } else {
                      setTokenParticipants([]);
                    }
                  } catch (e) {
                    console.warn("Error in onReadyChange:", e);
                  }
                })
              );
            } catch (e) {
              console.warn("Failed to register onReadyChange:", e);
            }

            try {
              unsubscribers.push(
                OBR.scene.items.onChange((items) => {
                  try {
                    const derived = deriveTokenParticipants(items as Item[], roleRef.current);
                    setTokenParticipants(derived);
                  } catch (e) {
                    console.warn("Error in items onChange:", e);
                  }
                })
              );
            } catch (e) {
              console.warn("Failed to register items onChange:", e);
            }

            try {
              unsubscribers.push(
                onMetadataChange((metadata) => {
                  try {
                    setCoreState(sanitizeCore(metadata[CORE_KEY]));
                    setDeclarations(readDeclarations(metadata));
                    setPlayerInits(readPlayerInits(metadata));
                  } catch (e) {
                    console.warn("Error in metadata onChange:", e);
                  }
                })
              );
            } catch (e) {
              console.warn("Failed to register metadata onChange:", e);
            }

            try {
              unsubscribers.push(
                OBR.party.onChange((updatedPlayers) => {
                  try {
                    setPlayers(updatedPlayers);
                  } catch (e) {
                    console.warn("Error in party onChange:", e);
                  }
                })
              );
            } catch (e) {
              console.warn("Failed to register party onChange:", e);
            }

            // 3. Fetch initial data independently — a failure in one must not skip the others.
            try {
              const meta = await OBR.room.getMetadata();
              setCoreState(sanitizeCore(meta[CORE_KEY]));
              setDeclarations(readDeclarations(meta));
              setPlayerInits(readPlayerInits(meta as Record<string, unknown>));
            } catch (e) {
              console.warn("Failed to load initial room metadata:", e);
            }

            try {
              const allPlayers = await OBR.party.getPlayers();
              setPlayers(allPlayers);
            } catch (e) {
              console.warn("Failed to load initial party:", e);
            }

            if (sceneIsReady) {
              try {
                const items = await OBR.scene.items.getItems();
                setTokenParticipants(deriveTokenParticipants(items as Item[], r));
              } catch (e) {
                console.warn("Failed to load initial scene items:", e);
              }
            }

            // 4. Set up context menu for adding/removing tokens to initiative (GM only)
            if (r === "GM") {
              try {
                OBR.contextMenu.create({
                  id: "com.rumble.initiative/toggle",
                  icons: [
                    {
                      icon: "",
                      label: "Add to Rumble Initiative",
                      filter: {
                        every: [
                          { key: "type", value: "IMAGE" },
                          { key: ["metadata", ITEM_META_KEY], value: undefined },
                        ],
                        permissions: ["UPDATE"],
                      },
                    },
                    {
                      icon: "",
                      label: "Remove from Rumble Initiative",
                      filter: {
                        every: [
                          { key: "type", value: "IMAGE" },
                        ],
                        permissions: ["UPDATE"],
                      },
                    },
                  ],
                  onClick: async (context) => {
                    // If every selected item is missing our metadata, add; otherwise remove.
                    const shouldAdd = context.items.every(
                      (item) => (item.metadata as Record<string, unknown>)[ITEM_META_KEY] === undefined
                    );
                    for (const item of context.items) {
                      if (shouldAdd) {
                        await addTokenToInitiative(item.id);
                      } else {
                        await removeTokenFromInitiative(item.id);
                      }
                    }
                  },
                });
              } catch (e) {
                console.warn("Failed to register context menu:", e);
              }
            }

            // Load recent-command history from localStorage.
            try {
              setHistory(getQuickHistory());
            } catch (e) {
              console.warn("Failed to load quick history:", e);
            }

            // Mark initialization as complete
            initializingRef.current = false;
            setObrReady(true);

            // Return cleanup function
            return () => {
              unsubscribers.forEach((unsub) => {
                try {
                  if (typeof unsub === "function") unsub();
                } catch (e) {
                  console.warn("Error during listener cleanup:", e);
                }
              });
            };
          } catch (innerError) {
            console.error("Error inside onReady callback:", innerError);
            initializingRef.current = false;
            setObrReady(true);
          }
        });
      } catch (e) {
        console.error("OBR initialization failed:", e);
        initializingRef.current = false;
        setObrReady(true);
      }
    };

    setup();
  }, []);

  const readItemInitiative = (item: Item): ItemInitiativeMeta | null => {
    const raw = (item.metadata as Record<string, unknown>)[ITEM_META_KEY];
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<ItemInitiativeMeta>;
    return {
      initiative: Number.isFinite(value.initiative) ? Number(value.initiative) : 0,
      ownerId: typeof value.ownerId === "string" ? value.ownerId : item.createdUserId,
      delay: Number.isFinite(value.delay) ? Number(value.delay) : 0,
      excluded: Boolean(value.excluded),
    };
  };

  // Prefer the token's overlay display text; fall back to the underlying item name.
  const getTokenDisplayName = (item: Item): string => {
    const text = (item as { text?: { plainText?: unknown } }).text;
    const plain = typeof text?.plainText === "string" ? text.plainText.trim() : "";
    if (plain) return plain;
    if (typeof item.name === "string" && item.name.trim()) return item.name;
    return "Token";
  };

  const sortParticipants = (list: Participant[]): Participant[] => {
    return [...list].sort((a, b) => {
      const aInit = a.initiative - (a.delay || 0);
      const bInit = b.initiative - (b.delay || 0);
      if (bInit !== aInit) return bInit - aInit;
      return a.name.localeCompare(b.name);
    });
  };

  const deriveTokenParticipants = (
    items: Item[],
    playerRole: "GM" | "PLAYER" = "PLAYER"
  ): Participant[] => {
    const out: Participant[] = [];
    for (const item of items) {
      if (playerRole !== "GM" && !item.visible) continue;
      const meta = readItemInitiative(item);
      if (!meta) continue; // opt-in only: GM must add via context menu
      if (meta.excluded) continue; // legacy safety
      out.push({
        tokenId: item.id,
        kind: "token",
        name: getTokenDisplayName(item),
        initiative: meta.initiative,
        ownerId: meta.ownerId,
        delay: meta.delay,
        visible: item.visible !== false,
      });
    }
    return out;
  };

  const derivePlayerParticipants = (
    partyPlayers: Player[],
    selfId: string,
    selfName: string,
    selfRole: "GM" | "PLAYER",
    inits: Record<string, PlayerInitiativeData>
  ): Participant[] => {
    const out: Participant[] = [];
    const seen = new Set<string>();
    // Include self if non-GM
    if (selfId && selfRole !== "GM") {
      const init = inits[selfId];
      out.push({
        tokenId: `${PLAYER_PARTICIPANT_PREFIX}${selfId}`,
        kind: "player",
        name: selfName || "You",
        initiative: init?.initiative ?? 0,
        ownerId: selfId,
        delay: init?.delay ?? 0,
      });
      seen.add(selfId);
    }
    for (const p of partyPlayers) {
      if (p.role === "GM") continue;
      if (seen.has(p.id)) continue;
      const init = inits[p.id];
      out.push({
        tokenId: `${PLAYER_PARTICIPANT_PREFIX}${p.id}`,
        kind: "player",
        name: p.name || "Player",
        initiative: init?.initiative ?? 0,
        ownerId: p.id,
        delay: init?.delay ?? 0,
      });
      seen.add(p.id);
    }
    return out;
  };

  const participants: Participant[] = React.useMemo(
    () =>
      sortParticipants([
        ...tokenParticipants,
        ...derivePlayerParticipants(players, playerId, playerName, role, playerInits),
      ]),
    [tokenParticipants, players, playerId, playerName, role, playerInits]
  );

  // Kept in refs so log-writing effects can resolve display names without
  // re-running on every unrelated render.
  participantsRef.current = participants;
  playersRef.current = players;

  const resolveParticipantName = React.useCallback((participantId: string): string => {
    const p = participantsRef.current.find((x) => x.tokenId === participantId);
    if (p) return p.name;
    if (participantId.startsWith(PLAYER_PARTICIPANT_PREFIX)) {
      const pid = participantId.slice(PLAYER_PARTICIPANT_PREFIX.length);
      const pl = playersRef.current.find((x) => x.id === pid);
      if (pl) return pl.name;
    }
    return "Unknown";
  }, []);

  const formatLogTimestamp = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const appendLog = React.useCallback((text: string) => {
    logRef.current.push({ timestamp: Date.now(), text });
  }, []);

  const downloadCombatLog = () => {
    const lines = logRef.current.length
      ? logRef.current.map((e) => `[${formatLogTimestamp(e.timestamp)}] ${e.text}`)
      : ["(no events recorded yet in this session)"];
    const body = lines.join("\n") + "\n";
    const stamp = formatLogTimestamp(Date.now()).replace(/[: ]/g, "-");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rumble-log-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const selectedParticipant = (): Participant | null => {
    // Non-GM players always act as themselves; scene selection is irrelevant.
    if (role !== "GM") {
      return (
        participants.find(
          (p) => p.kind === "player" && p.ownerId === playerId
        ) ?? null
      );
    }
    // GM: manual (popover) selection takes priority so a stale scene selection
    // can't steal focus after clicking a player row in the initiative list.
    if (manualSelectionId) {
      return participants.find((p) => p.tokenId === manualSelectionId) ?? null;
    }
    if (selection.length > 0) {
      return participants.find((p) => p.tokenId === selection[0]) ?? null;
    }
    return null;
  };

  const canEditToken = (p: Participant): boolean => {
    if (role === "GM") return true;
    return p.ownerId === playerId;
  };

  const actionDisplay = (p: Participant): string => {
    const decl = declarations[p.tokenId];
    if (!decl) return "";

    if (coreState.phase === "plan") {
      return decl.ready ? "Ready" : "Waiting";
    }

    return decl.text;
  };

  const updateTokenDelay = async (tokenId: string, delay: number) => {
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) {
        const meta = item.metadata as Record<string, unknown>;
        const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
        if (current) {
          meta[ITEM_META_KEY] = { ...current, delay: Math.max(0, delay) };
        }
      }
    });
  };

  const updateTokenInitiative = async (tokenId: string, initiative: number) => {
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) {
        const meta = item.metadata as Record<string, unknown>;
        const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
        if (current) {
          meta[ITEM_META_KEY] = { ...current, initiative: Math.max(0, initiative) };
        }
      }
    });
  };

  const removeTokenFromInitiative = async (tokenId: string) => {
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) {
        const meta = item.metadata as Record<string, unknown>;
        delete meta[ITEM_META_KEY];
      }
    });
  };

  const addTokenToInitiative = async (tokenId: string) => {
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) {
        const meta = item.metadata as Record<string, unknown>;
        const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
        if (!current) {
          meta[ITEM_META_KEY] = {
            initiative: 0,
            ownerId: item.createdUserId,
            delay: 0,
          };
        }
      }
    });
  };

  const updateParticipantInitiative = async (p: Participant, initiative: number) => {
    if (p.kind === "player" && p.ownerId) {
      const cur = playerInits[p.ownerId] ?? { initiative: 0, delay: 0 };
      await setPlayerInit(p.ownerId, { ...cur, initiative: Math.max(0, initiative) });
    } else {
      await updateTokenInitiative(p.tokenId, initiative);
    }
  };

  const updateParticipantDelay = async (p: Participant, delay: number) => {
    if (p.kind === "player" && p.ownerId) {
      const cur = playerInits[p.ownerId] ?? { initiative: 0, delay: 0 };
      await setPlayerInit(p.ownerId, { ...cur, delay: Math.max(0, delay) });
    } else {
      await updateTokenDelay(p.tokenId, delay);
    }
  };

  const setMyDeclaration = async (ready: boolean) => {
    const target = selectedParticipant();
    if (!target) return;

    if (role !== "GM" && target.ownerId !== playerId) {
      console.warn("Permission denied");
      return;
    }

    const text = draftAction.trim();
    if (ready && !text) return;

    const existing = declarations[target.tokenId];
    const next: Declaration = {
      text,
      ready,
      revealed: coreState.phase !== "plan",
      timestamp: Date.now(),
      ownerId: playerId,
      queue: existing?.queue,
    };
    await setDeclaration(target.tokenId, next);
    if (ready && text) {
      try {
        setHistory(pushQuickHistory(text));
      } catch (e) {
        console.warn("Failed to record command history:", e);
      }
    }
  };

  const queueActionForNextRumble = async (text: string) => {
    const target = selectedParticipant();
    if (!target) return;

    const existing = declarations[target.tokenId];
    const queue = existing?.queue ?? [];

    if (queue.length >= 3) return;

    queue.push({
      text: text.trim(),
      timestamp: Date.now(),
    });

    const next: Declaration = {
      text: existing?.text ?? "",
      ready: existing?.ready ?? false,
      revealed: existing?.revealed ?? coreState.phase !== "plan",
      timestamp: existing?.timestamp ?? Date.now(),
      ownerId: playerId,
      queue: queue.length > 0 ? queue : undefined,
    };
    await setDeclaration(target.tokenId, next);
    const queuedText = text.trim();
    if (queuedText) {
      try {
        setHistory(pushQuickHistory(queuedText));
      } catch (e) {
        console.warn("Failed to record command history:", e);
      }
    }
  };

  const writeQueue = async (
    tokenId: string,
    transform: (queue: QueuedAction[]) => QueuedAction[]
  ) => {
    const existing = declarations[tokenId];
    if (!existing?.queue) return;
    const nextQueue = transform([...existing.queue]);
    const next: Declaration = {
      ...existing,
      queue: nextQueue.length > 0 ? nextQueue : undefined,
    };
    await setDeclaration(tokenId, next);
  };

  const updateQueueEntry = async (tokenId: string, idx: number, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await writeQueue(tokenId, (q) =>
      q.map((entry, i) =>
        i === idx ? { ...entry, text: trimmed, timestamp: Date.now() } : entry
      )
    );
  };

  const moveQueueEntry = async (
    tokenId: string,
    idx: number,
    direction: -1 | 1
  ) => {
    await writeQueue(tokenId, (q) => {
      const target = idx + direction;
      if (target < 0 || target >= q.length) return q;
      const copy = [...q];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  };

  const removeQueueEntry = async (tokenId: string, idx: number) => {
    await writeQueue(tokenId, (q) => q.filter((_, i) => i !== idx));
  };

  const applyBulkAction = async (actionText: string) => {
    if (!bulkSelection.length || !actionText.trim()) return;

    const timestamp = Date.now();
    for (const tokenId of bulkSelection) {
      const existing = declarations[tokenId];
      const next: Declaration = {
        text: actionText.trim(),
        ready: true,
        revealed: coreState.phase !== "plan",
        timestamp,
        ownerId: playerId,
        queue: existing?.queue,
      };
      await setDeclaration(tokenId, next);
    }

    try {
      setHistory(pushQuickHistory(actionText));
    } catch (e) {
      console.warn("Failed to record command history:", e);
    }

    setBulkSelection([]);
    setBulkActionText("");
  };

  const advanceToResolve = async () => {
    await mutateCoreState((state) => {
      state.phase = "resolve";
      return state;
    });
    for (const [tokenId, decl] of Object.entries(declarations)) {
      if (!decl.revealed) await setDeclaration(tokenId, { ...decl, revealed: true });
    }
  };

  // Auto-advance to resolve when everyone is ready. GM-only to avoid race
  // conditions from multiple clients racing to flip the phase.
  const autoAdvancedRef = React.useRef(false);
  React.useEffect(() => {
    if (coreState.phase !== "plan") {
      autoAdvancedRef.current = false;
      return;
    }
    if (role !== "GM") return;
    if (participants.length === 0) return;
    const allReady = participants.every((p) => declarations[p.tokenId]?.ready);
    if (allReady && !autoAdvancedRef.current) {
      autoAdvancedRef.current = true;
      void advanceToResolve();
    }
  }, [participants, declarations, coreState.phase, role]);

  // Combat log: initialize snapshots once, then diff coreState and declarations
  // on every change and append entries. GM-only.
  React.useEffect(() => {
    if (role !== "GM" || !obrReady) return;
    if (coreSnapshotRef.current === null) {
      coreSnapshotRef.current = coreState;
      declSnapshotRef.current = declarations;
      appendLog(
        `Session opened at Rumble ${coreState.roundNumber}.${coreState.rumbleNumber} (phase: ${coreState.phase})`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obrReady, role]);

  React.useEffect(() => {
    if (role !== "GM" || !obrReady) return;
    const prev = coreSnapshotRef.current;
    if (!prev) return;
    const cur = coreState;
    if (
      prev.roundNumber === cur.roundNumber &&
      prev.rumbleNumber === cur.rumbleNumber &&
      prev.phase === cur.phase
    ) {
      return;
    }
    const bookend =
      cur.rumbleNumber === 1
        ? " — beginning of round"
        : cur.rumbleNumber === 3
          ? " — end of round"
          : "";
    if (prev.rumbleNumber !== cur.rumbleNumber || prev.roundNumber !== cur.roundNumber) {
      appendLog(
        `Rumble ${cur.roundNumber}.${cur.rumbleNumber} begins (phase: ${cur.phase})${bookend}`
      );
    } else if (prev.phase !== cur.phase) {
      appendLog(`Rumble ${cur.roundNumber}.${cur.rumbleNumber} → phase ${cur.phase}`);
    }
    coreSnapshotRef.current = cur;
  }, [coreState, obrReady, role, appendLog]);

  React.useEffect(() => {
    if (role !== "GM" || !obrReady) return;
    const prev = declSnapshotRef.current;
    if (!prev) return;
    const cur = declarations;
    const rumbleTag = `Rumble ${coreState.roundNumber}.${coreState.rumbleNumber}`;
    for (const [participantId, decl] of Object.entries(cur)) {
      if (!decl.ready) continue;
      const before = prev[participantId];
      const wasReady = !!before?.ready;
      const sameText = before?.text === decl.text;
      if (wasReady && sameText) continue;
      const promotedFromQueue = !!(
        before?.queue &&
        before.queue.length > 0 &&
        before.queue[0].text === decl.text
      );
      const name = resolveParticipantName(participantId);
      let action: string;
      if (promotedFromQueue) action = "queued action activates";
      else if (wasReady) action = "updates action";
      else action = "submits action";
      appendLog(`[${rumbleTag}] ${name} ${action}: "${decl.text}"`);
    }
    declSnapshotRef.current = cur;
  }, [
    declarations,
    obrReady,
    role,
    coreState.roundNumber,
    coreState.rumbleNumber,
    appendLog,
    resolveParticipantName,
  ]);

  if (!obrReady) {
    return (
      <main className="layout">
        <section className="header-section">
          <h1>Rumble Initiative Tracker</h1>
          <p className="muted">Initializing...</p>
        </section>
      </main>
    );
  }

  if (!sceneReady) {
    return (
      <main className="layout">
        <section className="header-section">
          <h1>Rumble Initiative Tracker</h1>
          <p className="muted">Open a scene to start tracking initiative.</p>
        </section>
      </main>
    );
  }

  const target = selectedParticipant();
  const ready = participants.filter((p) => declarations[p.tokenId]?.ready).length;
  const canQueueNextAction =
    target && declarations[target.tokenId]?.ready && coreState.phase === "plan";

  return (
    <main className="layout">
      <section className="header-section">
        <div className="header-top">
          <span className="status-text">
            Rumble {coreState.roundNumber}.{coreState.rumbleNumber}
            {coreState.rumbleNumber === 1 && (
              <span className="round-marker"> (round start)</span>
            )}
            {coreState.rumbleNumber === 3 && (
              <span className="round-marker"> (round end)</span>
            )}
            {" | "}{coreState.phase} | Ready: {ready}/{participants.length}
          </span>
          {role === "GM" && (
            <div className="header-controls">
              <button
                className="icon-button"
                onClick={() => advanceToResolve()}
                disabled={coreState.phase === "resolve"}
                title="Resolve — reveal all declarations and enter resolve phase"
                aria-label="Resolve"
              >
                <span aria-hidden="true">▶</span>
              </button>
              <button
                className="icon-button"
                onClick={() =>
                  mutateCoreState((s) => {
                    // Promote each declaration's first queued action; clear the rest.
                    void advanceDeclarationsToNextRumble();
                    return {
                      ...s,
                      phase: "plan",
                      rumbleNumber: (s.rumbleNumber === 3 ? 1 : s.rumbleNumber + 1) as 1 | 2 | 3,
                      roundNumber: s.rumbleNumber === 3 ? s.roundNumber + 1 : s.roundNumber,
                    };
                  })
                }
                title="Next Rumble"
                aria-label="Next Rumble"
              >
                <span aria-hidden="true">⏩</span>
              </button>
              <button
                className="icon-button"
                onClick={() => mutateCoreState(() => getDefaultCore())}
                title="Reset to Rumble 1.1"
                aria-label="Reset to Rumble 1.1"
              >
                <span aria-hidden="true">🔄</span>
              </button>
              <button
                className="icon-button"
                onClick={downloadCombatLog}
                title="Export combat log as .txt"
                aria-label="Export combat log"
              >
                <span aria-hidden="true">💾</span>
              </button>
            </div>
          )}
        </div>
      </section>

      {role !== "GM" && target && canEditToken(target) && (
        <section className="editor-section">
          <h2>Declare Action</h2>

          <div className="action-row">
            <label className="action-input">
              Action
              <input
                type="text"
                placeholder={`What does ${target.name} do?`}
                value={draftAction}
                onChange={(e) => setDraftAction(e.target.value)}
              />
            </label>
            {target.delay !== undefined && (
              <label className="delay-input">
                Delay
                <input
                  type="number"
                  min="0"
                  max={Math.max(0, target.initiative - 1)}
                  value={target.delay}
                  onChange={(e) => updateParticipantDelay(target, parseInt(e.target.value) || 0)}
                />
              </label>
            )}
          </div>

          {history.length > 0 && (
            <div className="history-list">
              <span className="history-label">Recent:</span>
              {history.slice(0, 10).map((entry, idx) => (
                <button
                  key={`${entry.text}::${idx}`}
                  type="button"
                  className="history-chip"
                  title={`Fill "${entry.text}" — does not ready`}
                  onClick={() => setDraftAction(entry.text)}
                >
                  <span className="history-text">{entry.text}</span>
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => setMyDeclaration(true)}
            className="primary"
            disabled={!draftAction.trim()}
          >
            {declarations[target.tokenId]?.ready ? "Update Ready" : "Ready"}
          </button>

          {canQueueNextAction && (
            <button
              onClick={() => queueActionForNextRumble(draftAction)}
              disabled={!draftAction.trim()}
            >
              Queue Next Rumble
            </button>
          )}

          {target && declarations[target.tokenId]?.queue && declarations[target.tokenId].queue!.length > 0 && (
            <div className="queue-display">
              <h3>Queued Actions ({declarations[target.tokenId].queue!.length}/3)</h3>
              <ul className="queue-list">
                {declarations[target.tokenId].queue!.map((qAction, idx, arr) => {
                  const isEditing = editingQueueIdx === idx;
                  const commitEdit = async () => {
                    await updateQueueEntry(target.tokenId, idx, editingQueueValue);
                    setEditingQueueIdx(null);
                    setEditingQueueValue("");
                  };
                  const cancelEdit = () => {
                    setEditingQueueIdx(null);
                    setEditingQueueValue("");
                  };
                  return (
                    <li key={idx} className="queue-item">
                      <div className="queue-action">
                        {isEditing ? (
                          <input
                            type="text"
                            className="queue-edit-input"
                            value={editingQueueValue}
                            autoFocus
                            onChange={(e) => setEditingQueueValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              else if (e.key === "Escape") cancelEdit();
                            }}
                          />
                        ) : (
                          <span
                            className="queue-text editable"
                            title="Click to edit"
                            onClick={() => {
                              setEditingQueueIdx(idx);
                              setEditingQueueValue(qAction.text);
                            }}
                          >
                            {qAction.text}
                          </span>
                        )}
                      </div>
                      <div className="queue-controls">
                        <button
                          className="queue-move"
                          disabled={idx === 0 || isEditing}
                          onClick={() => moveQueueEntry(target.tokenId, idx, -1)}
                          title="Move up"
                          aria-label="Move up"
                        >
                          ▲
                        </button>
                        <button
                          className="queue-move"
                          disabled={idx === arr.length - 1 || isEditing}
                          onClick={() => moveQueueEntry(target.tokenId, idx, 1)}
                          title="Move down"
                          aria-label="Move down"
                        >
                          ▼
                        </button>
                        <button
                          className="remove-queue"
                          disabled={isEditing}
                          onClick={() => removeQueueEntry(target.tokenId, idx)}
                          title="Remove this queued action"
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {role === "GM" && (
        <section className="bulk-actions-section">
          <h2>Declare Actions (GM)</h2>
          <div className="bulk-token-list">
            <label className="bulk-label">Select tokens:</label>
            {(() => {
              // Group order:
              //   1) Not-ready GM tokens  (kind === "token")
              //   2) Not-ready player tokens  (kind === "player")
              //   3) Ready GM tokens
              //   4) Ready player tokens
              // Within each group, keep initiative order (participants is already sorted).
              const groupRank = (p: Participant): number => {
                const isReady = !!declarations[p.tokenId]?.ready;
                const isPlayer = p.kind === "player";
                if (!isReady && !isPlayer) return 0;
                if (!isReady && isPlayer) return 1;
                if (isReady && !isPlayer) return 2;
                return 3;
              };
              const sorted = [...participants].sort(
                (a, b) => groupRank(a) - groupRank(b)
              );
              let lastRank = -1;
              return sorted.map((p) => {
                const rank = groupRank(p);
                const showDivider = rank !== lastRank && lastRank !== -1;
                lastRank = rank;
                const isReady = !!declarations[p.tokenId]?.ready;
                const isPlayer = p.kind === "player";
                const groupClass = isPlayer
                  ? isReady
                    ? "grp-ready-player"
                    : "grp-notready-player"
                  : isReady
                    ? "grp-ready-gm"
                    : "grp-notready-gm";
                return (
                  <React.Fragment key={p.tokenId}>
                    {showDivider && <span className="bulk-group-divider" />}
                    <label className={`bulk-checkbox-label ${groupClass}`}>
                      <input
                        type="checkbox"
                        checked={bulkSelection.includes(p.tokenId)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setBulkSelection([...bulkSelection, p.tokenId]);
                          } else {
                            setBulkSelection(
                              bulkSelection.filter((id) => id !== p.tokenId)
                            );
                          }
                        }}
                      />
                      <span className="bulk-name">{p.name}</span>
                      {isReady && (
                        <span className="bulk-status" aria-label="Ready">
                          ✓
                        </span>
                      )}
                    </label>
                  </React.Fragment>
                );
              });
            })()}
          </div>

          <label>
            Action
            <input
              type="text"
              placeholder="Apply to selected tokens"
              value={bulkActionText}
              onChange={(e) => setBulkActionText(e.target.value)}
            />
          </label>

          {history.length > 0 && (
            <div className="history-list">
              <span className="history-label">Recent:</span>
              {history.slice(0, 10).map((entry, idx) => (
                <button
                  key={`${entry.text}::${idx}`}
                  type="button"
                  className="history-chip"
                  title={`Fill "${entry.text}" — does not select tokens`}
                  onClick={() => setBulkActionText(entry.text)}
                >
                  <span className="history-text">{entry.text}</span>
                </button>
              ))}
            </div>
          )}

          <button
            className="primary apply-bulk"
            onClick={() => applyBulkAction(bulkActionText)}
            disabled={!bulkSelection.length || !bulkActionText.trim()}
          >
            Apply to {bulkSelection.length} Token{bulkSelection.length !== 1 ? "s" : ""}
          </button>
        </section>
      )}

      <section className="list-section">
        <h2>Initiative Order</h2>
        {participants.length === 0 ? (
          <p className="muted">No one in initiative yet. GM: right-click a token and pick <em>Add to Rumble Initiative</em>.</p>
        ) : (
          <ul className="initiative-list">
            {participants.map((p) => {
              const action = actionDisplay(p);
              const isSelected =
                p.tokenId === selection[0] || p.tokenId === manualSelectionId;
              const displayInitiative = p.delay ? `${p.initiative - p.delay}` : `${p.initiative}`;
              const isEditing = editingInitiativeId === p.tokenId;
              const editable = canEditToken(p);
              const isHidden = p.kind === "token" && p.visible === false;

              return (
                <li
                  key={p.tokenId}
                  className={`entry ${isSelected ? "mine" : ""} ${p.kind === "player" ? "player-row" : ""} ${isHidden ? "hidden-token" : ""} ${role !== "GM" ? "readonly" : ""}`}
                  onClick={() => {
                    // Non-GM players don't select rows — they always declare as themselves.
                    if (role !== "GM") return;
                    if (p.kind === "token") {
                      setManualSelectionId(null);
                      void OBR.player.select([p.tokenId]);
                    } else {
                      // Player rows aren't scene items; rely on manualSelectionId
                      // (which takes priority in selectedParticipant()).
                      setManualSelectionId(p.tokenId);
                    }
                  }}
                >
                  <span className="name">
                    {isHidden && (
                      <span className="hidden-icon" title="Hidden from players" aria-label="Hidden">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          width="14"
                          height="14"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
                        </svg>
                      </span>
                    )}
                    {p.name}
                  </span>
                  {isEditing ? (
                    <input
                      type="number"
                      className="init-input"
                      value={editingInitiativeValue}
                      onChange={(e) => setEditingInitiativeValue(e.target.value)}
                      onBlur={async () => {
                        const newInit = Math.max(0, parseInt(editingInitiativeValue) || 0);
                        await updateParticipantInitiative(p, newInit);
                        setEditingInitiativeId(null);
                        setEditingInitiativeValue("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      min="0"
                    />
                  ) : (
                    <span
                      className={`init ${editable ? "editable" : ""}`}
                      onClick={(e) => {
                        if (!editable) return;
                        e.stopPropagation();
                        setEditingInitiativeId(p.tokenId);
                        setEditingInitiativeValue(String(p.initiative));
                      }}
                      title={editable ? "Click to edit initiative" : "Only the owner or GM can edit"}
                    >
                      {displayInitiative}
                    </span>
                  )}
                  {action && <span className="action">{action}</span>}
                  {role === "GM" && p.kind === "token" && (
                    <button
                      className="remove-token"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeTokenFromInitiative(p.tokenId);
                      }}
                      title="Remove from initiative"
                    >
                      ✕
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
