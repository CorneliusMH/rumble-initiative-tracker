export type Phase = "plan" | "reveal" | "resolve";

export type ParticipantKind = "token" | "player";

export interface Participant {
  // Unique key. For tokens: the scene item id. For players: `player:<playerId>`.
  tokenId: string;
  kind: ParticipantKind;
  name: string;
  initiative: number;
  ownerId?: string;
  delay?: number;
  visible?: boolean;
}

export interface QueuedAction {
  text: string;
  category?: string;
  timestamp: number;
}

export interface Declaration {
  text: string;
  ready: boolean;
  revealed: boolean;
  timestamp: number;
  category?: string;
  ownerId?: string;
  queue?: QueuedAction[];
}

export interface CombatLogEntry {
  timestamp: number;
  rumbleNumber: number;
  roundNumber: number;
  phase: Phase;
  tokenId: string;
  tokenName: string;
  text: string;
}

export interface CoreState {
  roundNumber: number;
  rumbleNumber: 1 | 2 | 3;
  phase: Phase;
  log: CombatLogEntry[];
}
