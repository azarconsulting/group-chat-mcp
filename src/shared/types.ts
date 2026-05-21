export interface Message {
  id: number;
  room: string;
  from: string;
  at: string;
  text: string;
}

export interface PeerInfo {
  name: string;
  joined_at: string;
  cursor: number;
}

export interface RoomSummary {
  name: string;
  peers: string[];
  message_count: number;
  idle_s: number;
}

export interface JoinRoomResult {
  assigned_peer: string;
  peers: string[];
  room: string;
}

export interface ReadResult {
  messages: Message[];
  cursor: number;
  timed_out: boolean;
}

export interface SendResult {
  id: number;
  at: string;
}
