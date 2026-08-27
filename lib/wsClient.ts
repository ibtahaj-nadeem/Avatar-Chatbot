export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface TimedViseme {
  offset_ms: number;
  viseme_id: number;
  viseme: string;
}

export interface ChatResponse {
  type: "response";
  text: string;
  audio: string | null;
  visemes: TimedViseme[];
}

export interface ResponseStart {
  type: "response_start";
  response_id: string;
  sample_rate: number;
}

export interface ResponseDelta {
  type: "response_delta";
  response_id: string;
  text: string;
}

export interface ResponseAudio {
  type: "response_audio";
  response_id: string;
  audio: string;
  text?: string;
}

export interface ResponseViseme {
  type: "response_viseme";
  response_id: string;
  viseme: TimedViseme;
}

export interface ResponseEnd {
  type: "response_end";
  response_id: string;
  text: string;
  has_audio: boolean;
}

export type ServerMessage =
  | ChatResponse
  | ResponseStart
  | ResponseDelta
  | ResponseAudio
  | ResponseViseme
  | ResponseEnd
  | { type: "transcription"; text: string }
  | { type: "error"; message: string };

interface WebSocketClientOptions {
  onMessage: (message: ServerMessage) => void;
  onStateChange: (state: ConnectionState) => void;
}

/** A small reconnecting wrapper; it never knows anything about AI providers. */
export class ChatWebSocketClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;
  private attempts = 0;
  private pendingActions: Array<(socket: WebSocket) => void> = [];

  public constructor(
    private readonly url: string,
    private readonly options: WebSocketClientOptions,
  ) {}

  public connect(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.manuallyClosed = false;
    this.options.onStateChange(this.attempts ? "reconnecting" : "connecting");
    this.socket = new WebSocket(this.url);
    this.socket.onopen = () => {
      this.attempts = 0;
      this.options.onStateChange("connected");
      const actions = this.pendingActions.splice(0);
      for (const action of actions) action(this.socket as WebSocket);
    };
    this.socket.onmessage = (event: MessageEvent<string>) => {
      try {
        this.options.onMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        this.options.onMessage({ type: "error", message: "Received an invalid server response." });
      }
    };
    this.socket.onerror = () => this.options.onStateChange("disconnected");
    this.socket.onclose = () => {
      this.socket = null;
      if (this.manuallyClosed) {
        this.options.onStateChange("disconnected");
        return;
      }
      this.scheduleReconnect();
    };
  }

  public sendText(text: string): boolean {
    const action = (socket: WebSocket) => socket.send(JSON.stringify({ type: "text", text }));
    if (!this.isOpen()) {
      this.pendingActions.push(action);
      this.connect();
      return true;
    }
    action(this.socket as WebSocket);
    return true;
  }

  public sendAudio(audio: Blob): boolean {
    if (audio.size === 0) return false;
    const action = (socket: WebSocket) => {
      socket.send(JSON.stringify({ type: "audio_metadata", mime_type: audio.type || "audio/webm" }));
      socket.send(audio);
    };
    if (!this.isOpen()) {
      this.pendingActions.push(action);
      this.connect();
      return true;
    }
    action(this.socket as WebSocket);
    return true;
  }

  public cancelTurn(): void {
    if (!this.isOpen()) return;
    this.socket?.send(JSON.stringify({ type: "cancel" }));
  }

  public setSessionConfig(systemPrompt: string, workspaceId: string): void {
    const action = (socket: WebSocket) => socket.send(JSON.stringify({
      type: "session_config",
      system_prompt: systemPrompt,
      workspace_id: workspaceId,
    }));
    if (!this.isOpen()) {
      this.pendingActions.push(action);
      this.connect();
      return;
    }
    action(this.socket as WebSocket);
  }

  public close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pendingActions = [];
    this.socket?.close();
    this.socket = null;
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    this.options.onStateChange("reconnecting");
    const delay = Math.min(1_000 * 2 ** Math.min(this.attempts, 4), 15_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
