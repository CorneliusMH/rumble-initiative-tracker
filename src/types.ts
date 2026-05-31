export type Phase = "plan" | "reveal" | "resolve";

export interface Participant {
  tokenId: string;
  name: string;
  initiative: number;
}

export interface Declaration {
  text: string;
  ready: boolean;
  revealed: boolean;
  timestamp: number;
  category?: string;
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
