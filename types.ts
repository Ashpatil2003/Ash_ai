
export enum VoiceName {
  ZEPHYR = 'Zephyr',
  PUCK = 'Puck',
  CHARON = 'Charon',
  KORE = 'Kore',
  FENRIR = 'Fenrir'
}

export interface TranscriptionEntry {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface SessionConfig {
  voiceName: VoiceName;
  systemInstruction: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface AIState {
  suggestions: string[];
  isGenerating: boolean;
  contextReplies: string[];
}
