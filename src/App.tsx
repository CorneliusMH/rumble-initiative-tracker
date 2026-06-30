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

  // Initialize and subscribe to events
  useEffect(() => {
    const setup = async () => {
      await OBR.onReady(async () => {
        const [r, pid, pname, sceneIsReady, sel] = await Promise.all([
          OBR.player.getRole(),
          OBR.player.getId(),
          OBR.player.getName(),
          OBR.scene.isReady(),
          OBR.player.getSelection(),
        ]);
        setRole(r);
        setPlayerId(pid);
        setPlayerName(pname);
        setSceneReady(sceneIsReady);
        setSelection(sel ?? []);

        // Subscribe to changes
        OBR.player.onChange((player) => {
          setRole(player.role);
          setSelection(player.selection ?? []);
        });

        OBR.scene.onReadyChange(setSceneReady);

        OBR.scene.items.onChange((items) => {
          const derived = deriveParticipants(items as Item[]);
          setParticipants(derived);
        });

        onMetadataChange((metadata) => {
          setCoreState(sanitizeCore(metadata[CORE_KEY]));
          setDeclarations(readDeclarations(metadata));
        });

        // Load initial data
        const [initialMetadata, initialItems, allPlayers] = await Promise.all([
          OBR.room.getMetadata(),
          OBR.scene.items.getItems(),
          (async () => {
            try {
              // Try to get players from the scene or room
              const items = await OBR.scene.items.getItems();
              const playerMap = new Map<string, Player>();
              for (const item of items) {
                if (item.createdUserId && !playerMap.has(item.createdUserId)) {
                  // Try to get player info - this may not work, so we'll handle it
                  playerMap.set(item.createdUserId, {
                    id: item.createdUserId,
                    name: "Player",
                    role: "PLAYER",
                    color: "#000000",
                  } as Player);
                }
              }
              return Array.from(playerMap.values());
            } catch {
              return [];
            }
          })(),
        ]);

        setCoreState(sanitizeCore(initialMetadata[CORE_KEY]));
        setDeclarations(readDeclarations(initialMetadata));
        setParticipants(deriveParticipants(initialItems as Item[]));
        setPlayers(allPlayers);

        if (sceneIsReady) {
          await OBR.scene.items.getItems().then((items) => {
            setParticipants(deriveParticipants(items as Item[]));
          });
        }
      });
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
    };
  };

  const sortParticipants = (list: Participant[]): Participant[] => {
    return [...list].sort((a, b) => {
      const aInit = a.initiative - (a.delay || 0);
      const bInit = b.initiative - (b.delay || 0);
      if (bInit !== aInit) return bInit - aInit;
      return a.name.localeCompare(b.name);
    });
  };

  const deriveParticipants = (items: Item[]): Participant[] => {
    const out: Participant[] = [];
    for (const item of items) {
      const meta = readItemInitiative(item);
      if (!meta) continue;
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
        <h1>Rumble Initiative Tracker</h1>
        <div className="header-info">
          <span>
            Round {coreState.roundNumber} | Rumble {coreState.rumbleNumber}/3 | {coreState.phase}
          </span>
          <div className="stats">
            <span className="stat-item">
              Ready: {ready}/{participants.length}
            </span>
          </div>
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

          {role === "GM" && target.delay !== undefined && (
            <div className="delay-info">
              <label>
                Delay (max {target.initiative - 1})
                <input
                  type="number"
                  min="0"
                  max={Math.max(0, target.initiative - 1)}
                  value={target.delay}
                  onChange={(e) => updateTokenDelay(target.tokenId, parseInt(e.target.value) || 0)}
                />
              </label>
            </div>
          )}

          <label>
            Action
            <input
              type="text"
              placeholder={`What does ${target.name} do?`}
              value={draftAction}
              onChange={(e) => setDraftAction(e.target.value)}
            />
          </label>

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
          <div style={{ marginBottom: "8px" }}>
            <label>Select tokens to apply action to:</label>
            <div style={{ display: "grid", gap: "4px", maxHeight: "120px", overflow: "auto" }}>
              {participants.map((p) => (
                <label key={p.tokenId} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
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
                  {p.name}
                </label>
              ))}
            </div>
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
              return (
                <li
                  key={p.tokenId}
                  className={`entry ${isSelected ? "mine" : ""}`}
                  onClick={() => OBR.player.select([p.tokenId])}
                >
                  <span className="name">{p.name}</span>
                  <span className="init">{displayInitiative}</span>
                  {action && <span className="action">{action}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {role === "GM" && (
        <section className="controls-section">
          <button onClick={() => revealNow()}>Reveal Now</button>
          <button onClick={() => mutateCoreState((s) => ({ ...s, phase: "resolve" }))}>
            Next Phase
          </button>
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
          >
            Next Rumble
          </button>
          <button onClick={() => mutateCoreState(() => getDefaultCore())}>Reset</button>
        </section>
      )}
    </main>
  );
}
