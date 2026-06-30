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
  app.querySelector("#initiative-input")?.addEventListener("change", (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    const target = selectedParticipant();
    if (!target) return;
    if (Number.isFinite(value)) void setItemInitiative(target.tokenId, value);
  });

  app.querySelector("#add-initiative")?.addEventListener("click", () => {
    void addSelectedToInitiative();
  });

  app.querySelector("#remove-initiative")?.addEventListener("click", () => {
    void removeSelectedFromInitiative();
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

  app.querySelector("#update-btn")?.addEventListener("click", () => {
    void setMyDeclaration(false);
  });

  app.querySelector("#queue-btn")?.addEventListener("click", () => {
    const text = localDraftAction.trim();
    if (text) {
      void queueAction(text, localDraftCategory || undefined);
      localDraftAction = "";
      localDraftCategory = "";
      render();
    }
  });

  for (const btn of app.querySelectorAll<HTMLButtonElement>("[data-queue-remove]")) {
    btn.addEventListener("click", async (e) => {
      const idx = Number((e.target as HTMLButtonElement).dataset.queueRemove);
      const target = selectedParticipant();
      if (!target) return;
      const existing = declarations[target.tokenId];
      if (existing?.queue && Number.isFinite(idx)) {
        const newQueue = existing.queue.filter((_, i) => i !== idx);
        const next: Declaration = {
          ...existing,
          queue: newQueue.length > 0 ? newQueue : undefined
        };
        await setDeclaration(target.tokenId, next);
      }
    });
  }

  app.querySelector("#copy-log")?.addEventListener("click", () => {
    void copyLog();
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

  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-history]")) {
    button.addEventListener("click", () => {
      localDraftAction = button.dataset.history ?? "";
      render();
    });
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-template]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.template ?? "";
      const prefix = localDraftAction.trim() ? `${localDraftAction.trim()} | ` : "";
      localDraftAction = `${prefix}${value}`;
      render();
    });
  }

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
  const logPreview = [...coreState.log].reverse().slice(0, 8);
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
      <section class="panel">
        <div class="banner">
          <h1>Rumble Initiative Tracker</h1>
          <p>Round ${coreState.roundNumber} | Rumble ${coreState.rumbleNumber}/3 | Phase: ${formatPhase(coreState.phase)}</p>
          <p class="muted cue">${rumbleEffectCue(coreState.rumbleNumber)}</p>
        </div>
        <div class="stats-row">
          <span class="pill">Ready ${ready}/${participants.length}</span>
          <span class="pill">${coreState.phase === "plan" && allReady() ? "All ready" : "Waiting"}</span>
        </div>
      </section>

      <section class="panel controls">
        <h2>Selected Token</h2>
        ${target
          ? `
            <p class="muted">Editing <strong>${escapeHtml(target.name)}</strong></p>
            ${target.ownerId && target.ownerId !== localPlayerId && localPlayerRole !== "GM" 
              ? `<p class="error" style="color: #d32f2f; margin: 8px 0;">⚠️ You are not the owner of this token (owner only).</p>`
              : ""}
            <label>
              Initiative
              <input id="initiative-input" type="number" value="${target.initiative}" ${!canEditToken(target) ? "disabled" : ""} />
            </label>
            <label>
              Action
              <input id="declaration-input" type="text" placeholder="Declare action for ${escapeHtml(target.name)}" value="${escapeHtml(draftTextValue)}" ${!canEditToken(target) ? "disabled" : ""} />
            </label>
            <label>
              Category
              <select id="category-select" ${!canEditToken(target) ? "disabled" : ""}>
                <option value="">None</option>
                ${CATEGORY_OPTIONS.map((option) => `<option value="${option}" ${draftCategoryValue === option ? "selected" : ""}>${option}</option>`).join("")}
              </select>
            </label>
            <div class="button-row">
              <button id="ready-btn" type="button" class="primary" ${!canEditToken(target) ? "disabled" : ""}>${decl?.ready ? "Mark Ready" : "Ready"}</button>
              <button id="remove-initiative" type="button" ${!canEditToken(target) ? "disabled" : ""}>Remove</button>
            </div>
            ${
              quickHistory.length > 0
                ? `
                  <div class="quick-history">
                    ${quickHistory.slice(0, 3).map((entry) => `<button data-history="${escapeHtml(entry)}" type="button" class="history-btn">${escapeHtml(entry.slice(0, 30))}</button>`).join("")}
                  </div>
                `
                : ""
            }
          `
          : candidate
            ? `
              <p class="muted">Selected token is not yet in initiative.</p>
              <div class="button-row">
                <button id="add-initiative" type="button" class="primary">Add Selected Token</button>
              </div>
            `
            : `
              <p class="muted">Select a token in the scene to edit initiative or declare an action.</p>
            `
        }
      </section>

      <section class="panel">
        <h2>Initiative Order</h2>
        ${
          participants.length === 0
            ? '<p class="muted">No tokens in initiative yet. Use the context menu on a token to add it.</p>'
            : `
              <ul class="initiative-list">
                ${participants
                  .map((p) => {
                    const action = actionDisplay(p);
                    const mineClass = p.tokenId === localSelection[0] ? "mine" : "";
                    const readyMark = isReady(p) ? '<span class="pill">Ready</span>' : "";
                    return `<li class="entry ${mineClass}" data-token="${escapeHtml(p.tokenId)}">
                      <div>
                        <strong>${escapeHtml(p.name)}</strong>
                        <div class="muted">Init ${p.initiative}</div>
                      </div>
                      <div class="action">${escapeHtml(action || "-")} ${readyMark}</div>
                    </li>`;
                  })
                  .join("")}
              </ul>
            `
        }
      </section>

      <section class="panel">
        <h2>Rumble Controls ${isGm ? "" : "(GM only)"}</h2>
        <div class="button-row wrap">
          <button id="phase-next" type="button" ${isGm ? "" : "disabled"}>Advance Phase</button>
          <button id="reveal-now" type="button" ${isGm ? "" : "disabled"}>Reveal Now</button>
          <button id="new-rumble" type="button" ${isGm ? "" : "disabled"}>Next Rumble</button>
          <button id="reset-combat" type="button" ${isGm ? "" : "disabled"}>Reset Combat</button>
        </div>
      </section>

      <section class="panel">
        <div class="row-between">
          <h2>Combat Log</h2>
          <button id="copy-log" type="button">Copy</button>
        </div>
        <div class="log">
          ${
            logPreview.length
              ? logPreview
                  .map((entry) => `<p><span class="muted">${new Date(entry.timestamp).toLocaleTimeString()}</span> ${escapeHtml(entry.tokenName)}: ${escapeHtml(entry.text)}</p>`)
                  .join("")
              : '<p class="muted">No log entries yet.</p>'
          }
        </div>
      </section>
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
