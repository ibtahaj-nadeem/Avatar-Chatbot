import {
  experimental_upgradeWebSocket,
  type WebSocketData,
} from "@vercel/functions";
import type { WebSocket } from "ws";
import {
  closeSpeechSession,
  createSpeechSession,
  processTextTurn,
  sendPipelineError,
  transcribeAudio,
  type ChatHistory,
  type SpeechSession,
} from "@/lib/server/avatarPipeline";

export const runtime = "nodejs";
export const maxDuration = 300;

interface TextEnvelope {
  type: "text";
  text: string;
}

interface AudioMetadataEnvelope {
  type: "audio_metadata";
  mime_type: string;
}

interface CancelEnvelope {
  type: "cancel";
}

interface SessionConfigEnvelope {
  type: "session_config";
  system_prompt: string;
  workspace_id: string;
}

function parseEnvelope(data: WebSocketData): TextEnvelope | AudioMetadataEnvelope | CancelEnvelope | SessionConfigEnvelope {
  const payload = JSON.parse(data.toString()) as Record<string, unknown>;
  if (payload.type === "text" && typeof payload.text === "string") {
    return { type: "text", text: payload.text };
  }
  if (
    payload.type === "audio_metadata"
    && typeof payload.mime_type === "string"
    && payload.mime_type.startsWith("audio/")
  ) {
    return { type: "audio_metadata", mime_type: payload.mime_type };
  }
  if (payload.type === "cancel") return { type: "cancel" };
  if (
    payload.type === "session_config"
    && typeof payload.system_prompt === "string"
    && typeof payload.workspace_id === "string"
  ) {
    if (payload.system_prompt.length > 4_000) throw new Error("System prompt must be under 4,000 characters.");
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(payload.workspace_id)) throw new Error("Invalid workspace.");
    return { type: "session_config", system_prompt: payload.system_prompt, workspace_id: payload.workspace_id };
  }
  throw new Error("Unsupported message format.");
}

export function GET(): Promise<Response> {
  return experimental_upgradeWebSocket((ws: WebSocket) => {
    const history: ChatHistory = [];
    let audioMimeType = "audio/webm";
    let speechSession: SpeechSession | null = null;
    let processing = Promise.resolve();
    let activeAbortController: AbortController | null = null;
    let systemPrompt = "";
    let workspaceId = "";

    try {
      speechSession = createSpeechSession();
    } catch (error) {
      sendPipelineError(ws, error);
    }

    ws.on("message", (data: WebSocketData, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const envelope = parseEnvelope(data);
          if (envelope.type === "cancel") {
            activeAbortController?.abort();
            return;
          }
          if (envelope.type === "session_config") {
            systemPrompt = envelope.system_prompt;
            workspaceId = envelope.workspace_id;
            return;
          }
          if (envelope.type === "audio_metadata") {
            audioMimeType = envelope.mime_type;
            return;
          }
          data = Buffer.from(JSON.stringify(envelope));
        } catch (error) {
          sendPipelineError(ws, error);
          return;
        }
      }

      const turnSystemPrompt = systemPrompt;
      processing = processing.catch(() => undefined).then(async () => {
        if (!speechSession) throw new Error("Speech synthesis is not configured.");
        const abortController = new AbortController();
        activeAbortController = abortController;
        if (isBinary) {
          const transcription = await transcribeAudio(Buffer.from(data as Buffer), audioMimeType);
          if (abortController.signal.aborted) return;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "transcription", text: transcription }));
          }
          await processTextTurn(ws, history, transcription, speechSession, {
            abortSignal: abortController.signal,
            systemPrompt: turnSystemPrompt,
            workspaceId,
          });
          return;
        }

        const envelope = parseEnvelope(data);
        if (envelope.type !== "text") return;
        await processTextTurn(ws, history, envelope.text, speechSession, {
          abortSignal: abortController.signal,
          systemPrompt: turnSystemPrompt,
          workspaceId,
        });
      }).catch((error) => sendPipelineError(ws, error)).finally(() => {
        activeAbortController = null;
      });
    });

    const close = () => {
      closeSpeechSession(speechSession);
      speechSession = null;
    };
    ws.on("close", close);
    ws.on("error", close);
  });
}
