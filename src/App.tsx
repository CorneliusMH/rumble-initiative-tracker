import React, { useEffect, useState } from "react";
import OBR, { Item, Player } from "@owlbear-rodeo/sdk";
import {
  CORE_KEY,
  ITEM_META_KEY,
  clearAllDeclarations,
  getDefaultCore,
  mutateCoreState,
  onMetadataChange,
  readDeclarations,
  sanitizeCore,
  setDeclaration,
} from "./state";
import type { CoreState, Declaration, Participant, Phase } from "./types";

const CATEGORY_OPTIONS = ["Move", "Attack", "Charge Up", "Cast Spell", "Skill Check"];

interface ItemInitiativeMeta {
  initiative: number;
  ownerId?: string;
  delay?: number;
  excluded?: boolean;
}

export function App() {
  const [sceneReady, setSceneReady] = useState(false);
  const [coreState, setCoreState] = useState<CoreState>(getDefaultCore());
  const [declarations, setDeclarations] = useState<Record<string, Declaration>>({});
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [role, setRole] = useState<"GM" | "PLAYER">("PLAYER");
  const [playerId, setPlayerId] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [draftAction, setDraftAction] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [bulkActionText, setBulkActionText] = useState("");
  const [bulkActionCategory, setBulkActionCategory] = useState("");
  const [bulkSelection, setBulkSelection] = useState<string[]>([]);
  const [theme, setTheme] = useState<{ mode: string; text: { primary: string }; background: { default: string }; primary: { main: string } } | null>(null);
  const [obrReady, setObrReady] = useState(false);
  const [editingInitiativeId, setEditingInitiativeId] = useState<string | null>(null);
  const [editingInitiativeValue, setEditingInitiativeValue] = useState("");
  const roleRef = React.useRef<"GM" | "PLAYER">("PLAYER");
  const initializingRef = React.useRef(true);

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
              setTheme(t as any);
              applyThemeToDOM(t as any);
              
              OBR.theme.onChange((newTheme) => {
                setTheme(newTheme as any);
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

            // 2. Load all initial data
            const [initialMetadata, initialItems, allPlayers] = await Promise.all([
              OBR.room.getMetadata(),
              OBR.scene.items.getItems(),
              OBR.party.getPlayers(),
            ]);

            setCoreState(sanitizeCore(initialMetadata[CORE_KEY]));
            setDeclarations(readDeclarations(initialMetadata));
            setParticipants(deriveParticipants(initialItems as Item[], r));
            setPlayers(allPlayers);

            if (sceneIsReady) {
              const items = await OBR.scene.items.getItems();
              setParticipants(deriveParticipants(items as Item[], r));
            }

            // Wait for OBR to be fully ready for listener callbacks
            await new Promise((resolve) => setTimeout(resolve, 250));

            // 3. AFTER all initial state is set and a small delay, set up the listeners
            const unsubscribers: Array<(() => void) | void> = [];

            try {
              unsubscribers.push(
                OBR.player.onChange((player) => {
                  try {
                    setRole(player.role);
                    roleRef.current = player.role;
                    setSelection(player.selection ?? []);
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
                OBR.scene.onReadyChange((isReady) => {
                  try {
                    setSceneReady(isReady);
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
                    const derived = deriveParticipants(items as Item[], roleRef.current);
                    setParticipants(derived);
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

            // 4. Set up context menu for adding tokens to initiative
            try {
              OBR.contextMenu.create({
                id: "com.rumble.initiative/add-to-initiative",
                icons: [
                  {
                    icon: "",
                    label: "Add to Rumble Initiative",
                    filter: {
                      every: [
                        { key: "type", value: "IMAGE" },
                        {
                          key: [ITEM_META_KEY, "excluded"],
                          value: true,
                        },
                      ],
                      permissions: ["UPDATE"],
                    },
                  },
                ],
                onClick: async (context) => {
                  for (const item of context.items) {
                    await addTokenToInitiative(item.id);
                  }
                },
              });
            } catch (e) {
              console.warn("Failed to register context menu:", e);
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

  const initializeItemInitiative = async (item: Item) => {
    const meta = readItemInitiative(item);
    if (!meta) {
      // Token doesn't have initiative metadata, set it to 0
      await OBR.scene.items.updateItems([item.id], (items) => {
        if (items.length > 0) {
          const itemMeta = items[0].metadata as Record<string, unknown>;
          itemMeta[ITEM_META_KEY] = {
            initiative: 0,
            ownerId: item.createdUserId,
            delay: 0,
          };
        }
      });
    }
  };

  const sortParticipants = (list: Participant[]): Participant[] => {
    return [...list].sort((a, b) => {
      const aInit = a.initiative - (a.delay || 0);
      const bInit = b.initiative - (b.delay || 0);
      if (bInit !== aInit) return bInit - aInit;
      return a.name.localeCompare(b.name);
    });
  };

  const deriveParticipants = (items: Item[], playerRole: "GM" | "PLAYER" = "PLAYER"): Participant[] => {
    const out: Participant[] = [];
    for (const item of items) {
      // Hide items from non-GM players if they're hidden in the scene
      if (playerRole !== "GM" && !item.visible) {
        continue;
      }

      let meta = readItemInitiative(item);
      if (!meta) {
        // Auto-initialize items without metadata
        meta = {
          initiative: 0,
          ownerId: item.createdUserId,
          delay: 0,
        };
        // Trigger the initialization in the background
        void initializeItemInitiative(item);
      }

      // Skip if explicitly excluded by GM
      if (meta.excluded) {
        continue;
      }

      out.push({
        tokenId: item.id,
        name: typeof item.name === "string" && item.name ? item.name : "Token",
        initiative: meta.initiative,
        ownerId: meta.ownerId,
        delay: meta.delay,
      });
    }
    return sortParticipants(out);
  };

  const selectedParticipant = (): Participant | null => {
    if (selection.length === 0) return null;
    return participants.find((p) => p.tokenId === selection[0]) ?? null;
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

    const prefix = decl.category ? `[${decl.category}] ` : "";
    return `${prefix}${decl.text}`.trim();
  };

  const updateTokenOwner = async (tokenId: string, newOwnerId: string) => {
    if (!newOwnerId.trim()) return;
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) {
        const meta = item.metadata as Record<string, unknown>;
        const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
        if (current) {
          meta[ITEM_META_KEY] = { ...current, ownerId: newOwnerId.trim() };
        }
      }
    });
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
        const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
        if (current) {
          meta[ITEM_META_KEY] = { ...current, excluded: true };
        }
      }
    });
  };

  const addTokenToInitiative = async (tokenId: string) => {
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) {
        const meta = item.metadata as Record<string, unknown>;
        const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
        if (current) {
          meta[ITEM_META_KEY] = { ...current, excluded: false };
        } else {
          meta[ITEM_META_KEY] = {
            initiative: 0,
            ownerId: item.createdUserId,
            delay: 0,
            excluded: false,
          };
        }
      }
    });
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
      category: draftCategory || existing?.category,
      ownerId: playerId,
      queue: existing?.queue,
    };
    await setDeclaration(target.tokenId, next);
  };

  const queueActionForNextRumble = async (text: string, category?: string) => {
    const target = selectedParticipant();
    if (!target) return;

    const existing = declarations[target.tokenId];
    const queue = existing?.queue ?? [];

    if (queue.length >= 3) return;

    queue.push({
      text: text.trim(),
      category,
      timestamp: Date.now(),
    });

    const next: Declaration = {
      text: existing?.text ?? "",
      ready: existing?.ready ?? false,
      revealed: existing?.revealed ?? coreState.phase !== "plan",
      timestamp: existing?.timestamp ?? Date.now(),
      category: existing?.category,
      ownerId: playerId,
      queue: queue.length > 0 ? queue : undefined,
    };
    await setDeclaration(target.tokenId, next);
  };

  const applyBulkAction = async (actionText: string, actionCategory?: string) => {
    if (!bulkSelection.length || !actionText.trim()) return;

    const timestamp = Date.now();
    for (const tokenId of bulkSelection) {
      const existing = declarations[tokenId];
      const next: Declaration = {
        text: actionText.trim(),
        ready: true,
        revealed: coreState.phase !== "plan",
        timestamp,
        category: actionCategory,
        ownerId: playerId,
        queue: existing?.queue,
      };
      await setDeclaration(tokenId, next);
    }

    setBulkSelection([]);
    setBulkActionText("");
    setBulkActionCategory("");
  };

  const revealNow = async () => {
    await mutateCoreState((state) => {
      state.phase = "reveal";
      return state;
    });
    for (const [tokenId, decl] of Object.entries(declarations)) {
      if (!decl.revealed) await setDeclaration(tokenId, { ...decl, revealed: true });
    }
  };

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
          <div className="header-status">
            <span className="status-text">
              Round {coreState.roundNumber} | Rumble {coreState.rumbleNumber}/3 | {coreState.phase} | Ready: {ready}/{participants.length}
            </span>
          </div>
          {role === "GM" && (
            <div className="header-controls">
              <button onClick={() => revealNow()} title="Reveal all declarations">Reveal</button>
              <button onClick={() => mutateCoreState((s) => ({ ...s, phase: "resolve" }))} title="Move to next phase">Next Phase</button>
              <button
                onClick={() =>
                  mutateCoreState((s) => {
                    clearAllDeclarations();
                    return {
                      ...s,
                      phase: "plan",
                      rumbleNumber: (s.rumbleNumber === 3 ? 1 : s.rumbleNumber + 1) as 1 | 2 | 3,
                      roundNumber: s.rumbleNumber === 3 ? s.roundNumber + 1 : s.roundNumber,
                    };
                  })
                }
                title="Move to next rumble"
              >
                Next Rumble
              </button>
              <button onClick={() => mutateCoreState(() => getDefaultCore())} title="Reset all">Reset</button>
            </div>
          )}
        </div>
      </section>

      {target && canEditToken(target) && (
        <section className="editor-section">
          <h2>Declare Action</h2>

          {role === "GM" && (
            <div className="owner-info">
              <label>
                Owner (Player)
                <select
                  value={target.ownerId || ""}
                  onChange={(e) => updateTokenOwner(target.tokenId, e.target.value)}
                >
                  <option value="">Select player...</option>
                  {players.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

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
                Delay (max {target.initiative - 1})
                <input
                  type="number"
                  min="0"
                  max={Math.max(0, target.initiative - 1)}
                  value={target.delay}
                  onChange={(e) => updateTokenDelay(target.tokenId, parseInt(e.target.value) || 0)}
                />
              </label>
            )}
          </div>

          <label>
            Category
            <select value={draftCategory} onChange={(e) => setDraftCategory(e.target.value)}>
              <option value="">None</option>
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => setMyDeclaration(true)}
            className="primary"
            disabled={!draftAction.trim()}
          >
            {declarations[target.tokenId]?.ready ? "Update Ready" : "Ready"}
          </button>

          {canQueueNextAction && (
            <button
              onClick={() => queueActionForNextRumble(draftAction, draftCategory)}
              disabled={!draftAction.trim()}
            >
              Queue Next Rumble
            </button>
          )}

          {target && declarations[target.tokenId]?.queue && declarations[target.tokenId].queue!.length > 0 && (
            <div className="queue-display">
              <h3>Queued Actions ({declarations[target.tokenId].queue!.length}/3)</h3>
              <ul className="queue-list">
                {declarations[target.tokenId].queue!.map((qAction, idx) => (
                  <li key={idx} className="queue-item">
                    <div className="queue-action">
                      {qAction.category && <span className="queue-category">[{qAction.category}]</span>}
                      <span className="queue-text">{qAction.text}</span>
                    </div>
                    <button
                      className="remove-queue"
                      onClick={async () => {
                        const existing = declarations[target.tokenId];
                        if (existing?.queue) {
                          const newQueue = existing.queue.filter((_, i) => i !== idx);
                          const next: Declaration = {
                            ...existing,
                            queue: newQueue.length > 0 ? newQueue : undefined,
                          };
                          await setDeclaration(target.tokenId, next);
                        }
                      }}
                      title="Remove this queued action"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {target && !canEditToken(target) && (
        <section className="editor-section">
          <p className="muted">
            You are not the owner of this token. Owner: <strong>{target.ownerId || "Unknown"}</strong>
          </p>
        </section>
      )}

      {role === "GM" && (
        <section className="bulk-actions-section">
          <h2>Bulk Action (GM)</h2>
          <div className="bulk-token-list">
            <label className="bulk-label">Select tokens:</label>
            {participants.map((p) => (
              <label key={p.tokenId} className="bulk-checkbox-label">
                <input
                  type="checkbox"
                  checked={bulkSelection.includes(p.tokenId)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setBulkSelection([...bulkSelection, p.tokenId]);
                    } else {
                      setBulkSelection(bulkSelection.filter((id) => id !== p.tokenId));
                    }
                  }}
                />
                <span>{p.name}</span>
              </label>
            ))}
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

          <label>
            Category
            <select value={bulkActionCategory} onChange={(e) => setBulkActionCategory(e.target.value)}>
              <option value="">None</option>
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => applyBulkAction(bulkActionText, bulkActionCategory)}
            disabled={!bulkSelection.length || !bulkActionText.trim()}
          >
            Apply to {bulkSelection.length} Token{bulkSelection.length !== 1 ? "s" : ""}
          </button>
        </section>
      )}

      <section className="list-section">
        <h2>Initiative Order</h2>
        {participants.length === 0 ? (
          <p className="muted">No tokens in initiative yet.</p>
        ) : (
          <ul className="initiative-list">
            {participants.map((p) => {
              const action = actionDisplay(p);
              const isSelected = p.tokenId === selection[0];
              const displayInitiative = p.delay ? `${p.initiative - p.delay}` : `${p.initiative}`;
              const isEditing = editingInitiativeId === p.tokenId;

              return (
                <li
                  key={p.tokenId}
                  className={`entry ${isSelected ? "mine" : ""}`}
                  onClick={() => OBR.player.select([p.tokenId])}
                >
                  <span className="name">{p.name}</span>
                  {isEditing ? (
                    <input
                      type="number"
                      className="init-input"
                      value={editingInitiativeValue}
                      onChange={(e) => setEditingInitiativeValue(e.target.value)}
                      onBlur={async () => {
                        const newInit = Math.max(0, parseInt(editingInitiativeValue) || 0);
                        await updateTokenInitiative(p.tokenId, newInit);
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
                      className="init"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingInitiativeId(p.tokenId);
                        setEditingInitiativeValue(String(p.initiative));
                      }}
                      title="Click to edit initiative"
                    >
                      {displayInitiative}
                    </span>
                  )}
                  {action && <span className="action">{action}</span>}
                  {role === "GM" && (
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
