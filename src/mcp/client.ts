import type {
  JoinRoomResult,
  ReadResult,
  RoomSummary,
  SendResult,
} from "../shared/types.js";

export class BrokerClient {
  constructor(private readonly baseUrl: string) {}

  async listRooms(): Promise<RoomSummary[]> {
    return this.request<RoomSummary[]>("GET", "/rooms");
  }

  async joinRoom(room: string, preferred: string): Promise<JoinRoomResult> {
    return this.request<JoinRoomResult>(
      "POST",
      `/rooms/${encodeURIComponent(room)}/join`,
      { as: preferred },
    );
  }

  async leaveRoom(room: string, peer: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(
      "POST",
      `/rooms/${encodeURIComponent(room)}/leave`,
      { peer },
    );
  }

  async sendMessage(room: string, peer: string, text: string): Promise<SendResult> {
    return this.request<SendResult>(
      "POST",
      `/rooms/${encodeURIComponent(room)}/messages`,
      { peer, text },
    );
  }

  async waitForMessage(
    room: string,
    peer: string,
    timeoutS: number,
  ): Promise<ReadResult> {
    const q = new URLSearchParams({ peer, timeout_s: String(timeoutS) });
    return this.request<ReadResult>(
      "GET",
      `/rooms/${encodeURIComponent(room)}/messages/wait?${q}`,
    );
  }

  async getLastMessages(room: string, peer: string, count: number): Promise<ReadResult> {
    const q = new URLSearchParams({ peer, count: String(count) });
    return this.request<ReadResult>(
      "GET",
      `/rooms/${encodeURIComponent(room)}/messages/last?${q}`,
    );
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = `broker ${method} ${path} failed: ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        if (text) message = text;
      }
      throw new BrokerError(message, res.status);
    }
    return (await res.json()) as T;
  }
}

export class BrokerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}
