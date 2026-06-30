import OBR, { type Item } from "@owlbear-rodeo/sdk";
import "./styles.css";
import {
  CORE_KEY,
  ITEM_META_KEY,
  clearAllDeclarations,
  getDefaultCore,
  getQuickHistory,
  mutateCoreState,
  onMetadataChange,
  pushQuickHistory,
  readDeclarations,
  sanitizeCore,
  setDeclaration
} from "./state";
import type { CoreState, Declaration, Participant, Phase } from "./types";

const CATEGORY_OPTIONS = ["Move", "Attack", "Charge Up", "Cast Spell", "Skill Check"];

interface ItemInitiativeMeta {
  initiative: number;
  ownerId?: string;
}

let localPlayerRole: "GM" | "PLAYER" = "PLAYER";
let localPlayerId: string = "";
let localSelection: string[] = [];
let localDraftAction = "";
let localDraftCategory = "";
let quickHistory = getQuickHistory();

let coreState: CoreState = getDefaultCore();
let declarations: Record<string, Declaration> = {};
let participants: Participant[] = [];
let sceneReady = false;

const appNode = document.querySelector<HTMLDivElement>("#app");
if (!appNode) throw new Error("Missing app mount node.");
const app = appNode;

function readItemInitiative(item: Item): ItemInitiativeMeta | null {
  const raw = (item.metadata as Record<string, unknown>)[ITEM_META_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ItemInitiativeMeta>;
  return {
    initiative: Number.isFinite(value.initiative) ? Number(value.initiative) : 0,
    ownerId: typeof value.ownerId === "string" ? value.ownerId : item.createdUserId
  };
}

function sortParticipants(list: Participant[]): Participant[] {
  return [...list].sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return a.name.localeCompare(b.name);
  });
}

function deriveParticipants(items: Item[]): Participant[] {
  const out: Participant[] = [];
  for (const item of items) {
    const meta = readItemInitiative(item);
    if (!meta) continue;
    out.push({
      tokenId: item.id,
      name: typeof item.name === "string" && item.name ? item.name : "Token",
      initiative: meta.initiative,
      ownerId: meta.ownerId
    });
  }
  return sortParticipants(out);
}

function selectedParticipant(): Participant | null {
  if (localSelection.length === 0) return null;
  return participants.find((p) => p.tokenId === localSelection[0]) ?? null;
}

function selectedItemIsCandidate(): boolean {
  return localSelection.length === 1 && !participants.some((p) => p.tokenId === localSelection[0]);
}

function isReady(p: Participant): boolean {
  return Boolean(declarations[p.tokenId]?.ready);
}

function readyCount(): number {
  return participants.filter(isReady).length;
}

function allReady(): boolean {
  return participants.length > 0 && participants.every(isReady);
}

function actionDisplay(p: Participant): string {
  const decl = declarations[p.tokenId];
  if (!decl) return "";
  
  // During plan phase, only show ready status, never reveal actions
  if (coreState.phase === "plan") {
    return decl.ready ? "Ready" : "Waiting";
  }
  
  // After plan phase, show full action details
  const prefix = decl.category ? `[${decl.category}] ` : "";
  return `${prefix}${decl.text}`.trim();
}

function canEditToken(p: Participant): boolean {
  // GM can edit all tokens
  if (localPlayerRole === "GM") return true;
  // Players can only edit their own tokens
  return p.ownerId === localPlayerId;
}

function formatPhase(phase: Phase): string {
  if (phase === "plan") return "Declare";
  if (phase === "reveal") return "Reveal";
  return "Resolve";
}

function rumbleEffectCue(rumbleNumber: 1 | 2 | 3): string {
  if (rumbleNumber === 1) return "Beginning-of-turn effects window";
  if (rumbleNumber === 3) return "End-of-turn effects window";
  return "Mid-rumble action window";
}

function makeLogText(): string {
  return coreState.log
    .map((entry) => {
      const date = new Date(entry.timestamp).toLocaleTimeString();
      return `${date} | Round ${entry.roundNumber} Rumble ${entry.rumbleNumber} ${entry.phase.toUpperCase()} | ${entry.tokenName}: ${entry.text}`;
    })
    .join("\n");
}

async function copyLog(): Promise<void> {
  try {
    await navigator.clipboard.writeText(makeLogText() || "No combat log entries yet.");
  } catch (err) {
    console.warn("Clipboard write failed", err);
  }
}

async function setItemInitiative(tokenId: string, initiative: number): Promise<void> {
  await OBR.scene.items.updateItems([tokenId], (items) => {
    for (const item of items) {
      const meta = item.metadata as Record<string, unknown>;
      const current = meta[ITEM_META_KEY] as Partial<ItemInitiativeMeta> | undefined;
      meta[ITEM_META_KEY] = { ...(current ?? {}), initiative };
    }
  });
}

async function addSelectedToInitiative(): Promise<void> {
  if (localSelection.length === 0) return;
  await OBR.scene.items.updateItems(localSelection, (items) => {
    for (const item of items) {
      const meta = item.metadata as Record<string, unknown>;
      if (!meta[ITEM_META_KEY]) {
        meta[ITEM_META_KEY] = { 
          initiative: 0,
          ownerId: localPlayerRole === "GM" ? localPlayerId : localPlayerId
        };
      }
    }
  });
}

async function updateTokenOwner(tokenId: string, newOwnerId: string): Promise<void> {
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
}

async function removeSelectedFromInitiative(): Promise<void> {
  if (localSelection.length === 0) return;
  const removed = [...localSelection];
  await OBR.scene.items.updateItems(removed, (items) => {
    for (const item of items) {
      const meta = item.metadata as Record<string, unknown>;
      delete meta[ITEM_META_KEY];
    }
  });
  for (const id of removed) void setDeclaration(id, null);
}

async function setMyDeclaration(ready: boolean): Promise<void> {
  const target = selectedParticipant();
  if (!target) return;
  
  // Check permissions: only owner or GM can set declaration
  if (localPlayerRole !== "GM" && target.ownerId !== localPlayerId) {
    console.warn("Permission denied: cannot edit this token");
    return;
  }
  
  const text = localDraftAction.trim();
  if (ready && !text) return;

  const existing = declarations[target.tokenId];
  const next: Declaration = {
    text,
    ready,
    revealed: coreState.phase !== "plan",
    timestamp: Date.now(),
    category: localDraftCategory || existing?.category,
    ownerId: localPlayerId,
    queue: existing?.queue
  };
  await setDeclaration(target.tokenId, next);

  if (ready && text) {
    quickHistory = pushQuickHistory(text);
    void mutateCoreState((state) => {
      state.log.push({
        timestamp: Date.now(),
        rumbleNumber: state.rumbleNumber,
        roundNumber: state.roundNumber,
        phase: "plan",
        tokenId: target.tokenId,
        tokenName: target.name,
        text
      });
      return state;
    });
  }
}

async function queueAction(text: string, category?: string): Promise<void> {
  const target = selectedParticipant();
  if (!target) return;
  
  // Check permissions: only owner or GM can queue actions
  if (localPlayerRole !== "GM" && target.ownerId !== localPlayerId) {
    console.warn("Permission denied: cannot queue action for this token");
    return;
  }

  const existing = declarations[target.tokenId];
  const queue = existing?.queue ?? [];
  
  if (queue.length >= 3) {
    console.warn("Maximum 3 queued actions allowed");
    return;
  }

  queue.push({
    text: text.trim(),
    category,
    timestamp: Date.now()
  });

  const next: Declaration = {
    text: existing?.text ?? "",
    ready: existing?.ready ?? false,
    revealed: existing?.revealed ?? coreState.phase !== "plan",
    timestamp: existing?.timestamp ?? Date.now(),
    category: existing?.category,
    ownerId: localPlayerId,
    queue: queue.length > 0 ? queue : undefined
  };
  await setDeclaration(target.tokenId, next);
}

async function revealNow(): Promise<void> {
  await mutateCoreState((state) => {
    state.phase = "reveal";
    return state;
  });
  for (const [tokenId, decl] of Object.entries(declarations)) {
    if (!decl.revealed) void setDeclaration(tokenId, { ...decl, revealed: true });
  }
}

async function nextRumble(): Promise<void> {
  await clearAllDeclarations();
  await mutateCoreState((state) => {
    state.phase = "plan";
    const nr = state.rumbleNumber === 3 ? 1 : ((state.rumbleNumber + 1) as 1 | 2 | 3);
    state.rumbleNumber = nr;
    if (nr === 1) state.roundNumber += 1;
    return state;
  });
}

async function advancePhase(): Promise<void> {
  if (coreState.phase === "plan") {
    await revealNow();
    return;
  }
  if (coreState.phase === "reveal") {
    await mutateCoreState((state) => {
      state.phase = "resolve";
      return state;
    });
    return;
  }
  await nextRumble();
}

async function resetCombat(): Promise<void> {
  await clearAllDeclarations();
  await mutateCoreState(() => getDefaultCore());
}

function maybeAutoRevealAsGm(): void {
  if (localPlayerRole !== "GM") return;
  if (coreState.phase !== "plan") return;
  if (!allReady()) return;
  void revealNow();
}

function escapeHtml(input: string): string {
  return input
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

function bindEvents(): void {
  app.querySelector("#add-initiative")?.addEventListener("click", () => {
    void addSelectedToInitiative();
  });

  app.querySelector("#remove-initiative")?.addEventListener("click", () => {
    void removeSelectedFromInitiative();
  });

  app.querySelector("#update-owner-btn")?.addEventListener("click", () => {
    const target = selectedParticipant();
    if (!target) return;
    const ownerInput = app.querySelector<HTMLInputElement>("#owner-input");
    if (!ownerInput) return;
    const newOwnerId = ownerInput.value.trim();
    if (newOwnerId) {
      void updateTokenOwner(target.tokenId, newOwnerId);
    }
  });

  app.querySelector("#declaration-input")?.addEventListener("input", (event) => {
    localDraftAction = (event.target as HTMLInputElement).value;
  });

  app.querySelector("#category-select")?.addEventListener("change", (event) => {
    localDraftCategory = (event.target as HTMLSelectElement).value;
  });

  app.querySelector("#ready-btn")?.addEventListener("click", () => {
    void setMyDeclaration(true);
  });

  app.querySelector("#phase-next")?.addEventListener("click", () => {
    void advancePhase();
  });

  app.querySelector("#reveal-now")?.addEventListener("click", () => {
    void revealNow();
  });

  app.querySelector("#new-rumble")?.addEventListener("click", () => {
    void nextRumble();
  });

  app.querySelector("#reset-combat")?.addEventListener("click", () => {
    void resetCombat();
  });

  for (const row of app.querySelectorAll<HTMLLIElement>("[data-token]")) {
    row.addEventListener("click", () => {
      const id = row.dataset.token;
      if (id) void OBR.player.select([id]);
    });
  }
}

function render(): void {
  const target = selectedParticipant();
  const candidate = selectedItemIsCandidate();
  const decl = target ? declarations[target.tokenId] : undefined;
  const ready = readyCount();
  const logPreview = [...coreState.log].reverse().slice(0, 5);
  const isGm = localPlayerRole === "GM";

  if (!sceneReady) {
    app.innerHTML = `
      <main class="layout">
        <section class="panel">
          <h1>Rumble Initiative Tracker</h1>
          <p class="muted">Open a scene to start tracking initiative.</p>
        </section>
      </main>`;
    return;
  }

  const draftTextValue = localDraftAction !== "" ? localDraftAction : decl?.text ?? "";
  const draftCategoryValue = localDraftCategory !== "" ? localDraftCategory : decl?.category ?? "";

  app.innerHTML = `
    <main class="layout">
      <section class="header-section">
        <h1>Rumble Initiative Tracker</h1>
        <div class="header-info">
          <span>Round ${coreState.roundNumber} | Rumble ${coreState.rumbleNumber}/3 | ${formatPhase(coreState.phase)}</span>
          <div class="stats">
            <span class="stat-item">Ready: ${ready}/${participants.length}</span>
          </div>
        </div>
      </section>

      ${target && canEditToken(target)
        ? `
          <section class="editor-section">
            <h2>Declare Action</h2>
            ${isGm
              ? `
                <div class="owner-info">
                  <label>
                    Owner (Player ID)
                    <input id="owner-input" type="text" placeholder="Player ID" value="${escapeHtml(target.ownerId || "")}" />
                  </label>
                  <button id="update-owner-btn" type="button">Update Owner</button>
                </div>
              `
              : ""
            }
            <label>
              Action
              <input id="declaration-input" type="text" placeholder="What does ${escapeHtml(target.name)} do?" value="${escapeHtml(draftTextValue)}" />
            </label>
            <label>
              Category
              <select id="category-select">
                <option value="">None</option>
                ${CATEGORY_OPTIONS.map((option) => `<option value="${option}" ${draftCategoryValue === option ? "selected" : ""}>${option}</option>`).join("")}
              </select>
            </label>
            <button id="ready-btn" type="button" class="primary">${decl?.ready ? "Update Ready" : "Ready"}</button>
          </section>
        `
        : target
          ? `
            <section class="editor-section">
              <p class="muted">You are not the owner of this token. Owner: <strong>${escapeHtml(target.ownerId || "Unknown")}</strong></p>
            </section>
          `
          : candidate
            ? `
              <section class="editor-section">
              <button id="add-initiative" type="button" class="primary">Add to Initiative</button>
            </section>
          `
          : ""
      }

      <section class="list-section">
        <h2>Initiative Order</h2>
        ${
          participants.length === 0
            ? '<p class="muted">No tokens in initiative yet.</p>'
            : `
              <ul class="initiative-list">
                ${participants
                  .map((p) => {
                    const action = actionDisplay(p);
                    const mineClass = p.tokenId === localSelection[0] ? "mine" : "";
                    return `<li class="entry ${mineClass}" data-token="${escapeHtml(p.tokenId)}">
                      <span class="name">${escapeHtml(p.name)}</span>
                      <span class="init">${p.initiative}</span>
                      ${action ? `<span class="action">${escapeHtml(action)}</span>` : ""}
                    </li>`;
                  })
                  .join("")}
              </ul>
            `
        }
      </section>

      ${isGm 
        ? `
          <section class="controls-section">
            <button id="phase-next" type="button">Advance Phase</button>
            <button id="reveal-now" type="button">Reveal Now</button>
            <button id="new-rumble" type="button">Next Rumble</button>
            <button id="reset-combat" type="button">Reset</button>
          </section>
        `
        : ""
      }

      ${(isGm || coreState.phase !== "plan") && logPreview.length > 0
        ? `
          <section class="log-section">
            <h2>Recent Log</h2>
            <div class="log">
              ${logPreview
                .map((entry) => `<p><strong>${escapeHtml(entry.tokenName)}:</strong> ${escapeHtml(entry.text)}</p>`)
                .join("")}
            </div>
          </section>
        `
        : ""
      }
    </main>
  `;
  bindEvents();
}

async function registerContextMenu(): Promise<void> {
  // Mirrors the official SDK tutorial's setupContextMenu (sdk-tutorials/initiative-tracker/contextMenu.js):
  // two icons keyed by metadata presence, onClick toggles by passing context.items straight to updateItems.
  await OBR.contextMenu.create({
    id: `${ITEM_META_KEY}/menu/toggle`,
    icons: [
      {
        icon: "/icon.svg",
        label: "Add to Rumble Initiative",
        filter: {
          every: [
            { key: "layer", value: "CHARACTER" },
            { key: ["metadata", ITEM_META_KEY], value: undefined }
          ]
        }
      },
      {
        icon: "/icon.svg",
        label: "Remove from Rumble Initiative",
        filter: {
          every: [{ key: "layer", value: "CHARACTER" }]
        }
      }
    ],
    onClick(context) {
      const addToInitiative = context.items.every(
        (item) => (item.metadata as Record<string, unknown>)[ITEM_META_KEY] === undefined
      );
      if (addToInitiative) {
        const promptValue = window.prompt("Enter the initiative value", "0");
        const initiative = Number(promptValue);
        OBR.scene.items.updateItems(context.items, (items) => {
          for (const item of items) {
            const meta = item.metadata as Record<string, unknown>;
            meta[ITEM_META_KEY] = {
              initiative: Number.isFinite(initiative) ? initiative : 0,
              ownerId: item.createdUserId
            };
          }
        });
      } else {
        const removedIds = context.items.map((item) => item.id);
        OBR.scene.items
          .updateItems(context.items, (items) => {
            for (const item of items) {
              const meta = item.metadata as Record<string, unknown>;
              delete meta[ITEM_META_KEY];
            }
          })
          .then(() => {
            for (const id of removedIds) void setDeclaration(id, null);
          });
      }
    }
  });
}

async function refreshParticipantsFromScene(): Promise<void> {
  const items = (await OBR.scene.items.getItems()) as Item[];
  participants = deriveParticipants(items);
  render();
}

async function bootstrap(): Promise<void> {
  await OBR.onReady(async () => {
    const [role, playerId, sceneIsReady, initialSelection] = await Promise.all([
      OBR.player.getRole(),
      OBR.player.getId(),
      OBR.scene.isReady(),
      OBR.player.getSelection()
    ]);
    localPlayerRole = role;
    localPlayerId = playerId;
    sceneReady = sceneIsReady;
    localSelection = initialSelection ?? [];

    const unsubs: Array<() => void> = [];

    unsubs.push(
      OBR.player.onChange((player) => {
        const previousSelection = localSelection[0];
        localPlayerRole = player.role;
        localSelection = player.selection ?? [];
        if (localSelection[0] !== previousSelection) {
          const target = selectedParticipant();
          const decl = target ? declarations[target.tokenId] : undefined;
          localDraftAction = decl?.text ?? "";
          localDraftCategory = decl?.category ?? "";
        }
        render();
      })
    );

    unsubs.push(
      onMetadataChange((metadata) => {
        coreState = sanitizeCore(metadata[CORE_KEY]);
        declarations = readDeclarations(metadata);
        render();
        maybeAutoRevealAsGm();
      })
    );

    unsubs.push(
      OBR.scene.onReadyChange((ready) => {
        sceneReady = ready;
        if (ready) {
          void refreshParticipantsFromScene();
        } else {
          participants = [];
          render();
        }
      })
    );

    unsubs.push(
      OBR.scene.items.onChange((items) => {
        participants = deriveParticipants(items as Item[]);
        render();
      })
    );

    await registerContextMenu();

    const initialMetadata = (await OBR.room.getMetadata()) as Record<string, unknown>;
    coreState = sanitizeCore(initialMetadata[CORE_KEY]);
    declarations = readDeclarations(initialMetadata);
    quickHistory = getQuickHistory();
    if (sceneReady) {
      await refreshParticipantsFromScene();
    } else {
      render();
    }

    window.addEventListener("beforeunload", () => {
      for (const unsub of unsubs) unsub();
    });
  });
}

void bootstrap();
