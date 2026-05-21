import { EventEmitter } from "node:events";
import type {
  JoinRoomResult,
  Message,
  PeerInfo,
  ReadResult,
  RoomSummary,
  SendResult,
} from "../shared/types.js";

interface Room {
  name: string;
  createdAt: number;
  lastActivityAt: number;
  peers: Map<string, PeerInfo>;
  messages: Message[];
  nextId: number;
  waiters: Set<() => void>;
}

export class RoomNotFoundError extends Error {
  constructor(room: string) {
    super(`room not found: ${room}`);
  }
}

export class PeerNotInRoomError extends Error {
  constructor(room: string, peer: string) {
    super(`peer "${peer}" is not in room "${room}"`);
  }
}

export interface StoreEvents {
  message: (msg: Message) => void;
  "rooms-changed": () => void;
  "peers-changed": (room: string, peers: string[]) => void;
  "room-deleted": (room: string) => void;
}

export class Store extends EventEmitter {
  private rooms = new Map<string, Room>();
  private onRoomEmpty?: () => void;

  constructor(opts: { onRoomEmpty?: () => void } = {}) {
    super();
    this.onRoomEmpty = opts.onRoomEmpty;
  }

  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof StoreEvents>(event: K, ...args: Parameters<StoreEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  getAllMessages(roomName: string): Message[] {
    const room = this.rooms.get(roomName);
    if (!room) throw new RoomNotFoundError(roomName);
    return [...room.messages];
  }

  getPeers(roomName: string): string[] {
    const room = this.rooms.get(roomName);
    return room ? [...room.peers.keys()] : [];
  }

  listRooms(): RoomSummary[] {
    const now = Date.now();
    return [...this.rooms.values()].map((r) => ({
      name: r.name,
      peers: [...r.peers.keys()],
      message_count: r.messages.length,
      idle_s: Math.floor((now - r.lastActivityAt) / 1000),
    }));
  }

  joinRoom(roomName: string, preferred: string): JoinRoomResult {
    let room = this.rooms.get(roomName);
    if (!room) {
      room = {
        name: roomName,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        peers: new Map(),
        messages: [],
        nextId: 1,
        waiters: new Set(),
      };
      this.rooms.set(roomName, room);
    }

    const assigned = this.assignName(room, preferred);
    room.peers.set(assigned, {
      name: assigned,
      joined_at: new Date().toISOString(),
      cursor: room.messages.length > 0 ? room.messages[room.messages.length - 1].id : 0,
    });
    room.lastActivityAt = Date.now();

    this.emit("peers-changed", room.name, [...room.peers.keys()]);
    this.emit("rooms-changed");

    return {
      assigned_peer: assigned,
      peers: [...room.peers.keys()],
      room: room.name,
    };
  }

  deleteRoom(roomName: string): { ok: true } {
    const room = this.rooms.get(roomName);
    if (!room) throw new RoomNotFoundError(roomName);

    for (const w of room.waiters) w();
    room.waiters.clear();
    this.rooms.delete(roomName);

    this.emit("room-deleted", roomName);
    this.emit("rooms-changed");
    this.onRoomEmpty?.();
    return { ok: true };
  }

  leaveRoom(roomName: string, peer: string): { ok: true } {
    const room = this.rooms.get(roomName);
    if (!room) throw new RoomNotFoundError(roomName);
    if (!room.peers.delete(peer)) throw new PeerNotInRoomError(roomName, peer);
    room.lastActivityAt = Date.now();

    if (room.peers.size === 0) {
      for (const w of room.waiters) w();
      room.waiters.clear();
      this.rooms.delete(roomName);
      this.emit("rooms-changed");
      this.onRoomEmpty?.();
    } else {
      this.emit("peers-changed", room.name, [...room.peers.keys()]);
      this.emit("rooms-changed");
    }
    return { ok: true };
  }

  sendMessage(roomName: string, peer: string, text: string): SendResult {
    const room = this.requirePeer(roomName, peer);
    const msg: Message = {
      id: room.nextId++,
      room: room.name,
      from: peer,
      at: new Date().toISOString(),
      text,
    };
    room.messages.push(msg);
    room.lastActivityAt = Date.now();

    for (const w of room.waiters) w();
    room.waiters.clear();

    this.emit("message", msg);
    this.emit("rooms-changed");

    return { id: msg.id, at: msg.at };
  }

  async waitForMessage(
    roomName: string,
    peer: string,
    timeoutMs: number,
  ): Promise<ReadResult> {
    const room = this.requirePeer(roomName, peer);

    const immediate = this.drainNew(room, peer);
    if (immediate.length > 0) {
      return { messages: immediate, cursor: room.peers.get(peer)!.cursor, timed_out: false };
    }

    return new Promise<ReadResult>((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        room.waiters.delete(notify);
      };
      const notify = () => {
        cleanup();
        const messages = this.drainNew(room, peer);
        resolve({
          messages,
          cursor: room.peers.get(peer)?.cursor ?? 0,
          timed_out: false,
        });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({
          messages: [],
          cursor: room.peers.get(peer)?.cursor ?? 0,
          timed_out: true,
        });
      }, timeoutMs);
      room.waiters.add(notify);
    });
  }

  getLastMessages(roomName: string, peer: string, count: number): ReadResult {
    const room = this.requirePeer(roomName, peer);
    const tail = room.messages.slice(-count);
    if (tail.length > 0) {
      const peerInfo = room.peers.get(peer)!;
      peerInfo.cursor = room.messages[room.messages.length - 1].id;
    }
    return {
      messages: tail,
      cursor: room.peers.get(peer)!.cursor,
      timed_out: false,
    };
  }

  private requirePeer(roomName: string, peer: string): Room {
    const room = this.rooms.get(roomName);
    if (!room) throw new RoomNotFoundError(roomName);
    if (!room.peers.has(peer)) throw new PeerNotInRoomError(roomName, peer);
    return room;
  }

  private drainNew(room: Room, peer: string): Message[] {
    const peerInfo = room.peers.get(peer)!;
    const fresh = room.messages.filter((m) => m.id > peerInfo.cursor && m.from !== peer);
    if (fresh.length > 0) {
      peerInfo.cursor = fresh[fresh.length - 1].id;
    }
    return fresh;
  }

  private assignName(room: Room, preferred: string): string {
    if (!room.peers.has(preferred)) return preferred;
    let i = 2;
    while (room.peers.has(`${preferred}-${i}`)) i++;
    return `${preferred}-${i}`;
  }
}
