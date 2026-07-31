export type Phase = "plan" | "resolve";

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
  timestamp: number;
}

export interface Declaration {
  text: string;
  ready: boolean;
  revealed: boolean;
  timestamp: number;
  ownerId?: string;
  queue?: QueuedAction[];
}

export interface CoreState {
  roundNumber: number;
  rumbleNumber: 1 | 2 | 3;
  phase: Phase;
}
