import { createGoogle } from "@ai-sdk/google";
import { streamText, type ModelMessage } from "ai";
import * as speechSdk from "microsoft-cognitiveservices-speech-sdk";
import type { WebSocket } from "ws";
import { toOculusViseme } from "@/lib/server/visemes";
import { retrieveContext } from "@/lib/server/rag";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful conversational avatar assistant. Answer clearly, warmly, "
  + "and concisely. Your answers will be spoken aloud, so avoid long paragraphs, "
  + "dense lists, markdown, and unnecessary preambles.";

const MAX_HISTORY_MESSAGES = 12;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 4_000;

export type ChatHistory = Array<{ role: "user" | "assistant"; content: string }>;

export interface TurnOptions {
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  workspaceId?: string;
}

type ServerEvent = Record<string, unknown> & { type: string };

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(event));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function toModelMessages(history: ChatHistory): ModelMessage[] {
  return history.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export interface SpeechSession {
  synthesizer: speechSdk.SpeechSynthesizer;
  connection: speechSdk.Connection;
}

export function createSpeechSession(): SpeechSession {
  const region = requiredEnvironment("AZURE_SPEECH_REGION");
  // Use the SDK's subscription configuration so it negotiates the correct
  // regional websocket endpoint and keeps streaming synthesis reliable on
  // serverless runtimes.
  const speechConfig = speechSdk.SpeechConfig.fromSubscription(
    requiredEnvironment("AZURE_SPEECH_KEY"),
    region,
  );
  speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
  speechConfig.speechSynthesisOutputFormat =
    speechSdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechSynthesis_FrameTimeoutInterval,
    "100000000",
  );
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechSynthesis_RtfTimeoutThreshold,
    "10",
  );

  const synthesizer = new speechSdk.SpeechSynthesizer(speechConfig, null);
  const connection = speechSdk.Connection.fromSynthesizer(synthesizer);
  // Do not synchronously open the Azure socket here. On hosted runtimes this
  // can block the WebSocket connection handler before client message listeners
  // are registered. The SDK opens it lazily on the first speak request.
  return { synthesizer, connection };
}

export function closeSpeechSession(session: SpeechSession | null): void {
  if (!session) return;
  session.connection.closeConnection();
  session.connection.close();
  session.synthesizer.close();
}

function beginSynthesis(
  ws: WebSocket,
  session: SpeechSession | null,
  responseId: string,
  abortSignal?: AbortSignal,
): {
  request: speechSdk.SpeechSynthesisRequest;
  completion: Promise<speechSdk.SpeechSynthesisResult>;
  hasAudio: () => boolean;
  markAudio: () => void;
  visemeSummary: () => { count: number; lastOffsetMs: number };
} {
  let audioReceived = false;
  let visemeCount = 0;
  let lastOffsetMs = 0;

  if (!session) {
    let closed = false;
    const inputStream = {
      write: (_text: string) => undefined,
      close: () => { closed = true; },
      get isClosed() { return closed; },
    };
    return {
      request: { inputStream } as speechSdk.SpeechSynthesisRequest,
      completion: Promise.resolve({} as speechSdk.SpeechSynthesisResult),
      hasAudio: () => audioReceived,
      markAudio: () => { audioReceived = true; },
      visemeSummary: () => ({ count: 0, lastOffsetMs: 0 }),
    };
  }

  session.synthesizer.synthesizing = (_sender, event) => {
    if (abortSignal?.aborted) return;
    const audio = Buffer.from(event.result.audioData);
    if (!audio.length) return;
    audioReceived = true;
    send(ws, {
      type: "response_audio",
      response_id: responseId,
      audio: audio.toString("base64"),
    });
  };
  session.synthesizer.visemeReceived = (_sender, event) => {
    if (abortSignal?.aborted) return;
    const offsetMs = event.audioOffset / 10_000;
    visemeCount += 1;
    lastOffsetMs = offsetMs;
    send(ws, {
      type: "response_viseme",
      response_id: responseId,
      viseme: {
        offset_ms: offsetMs,
        viseme_id: event.visemeId,
        viseme: toOculusViseme(event.visemeId),
      },
    });
  };

  const request = new speechSdk.SpeechSynthesisRequest(
    speechSdk.SpeechSynthesisRequestInputType.TextStream,
  );
  const completion = new Promise<speechSdk.SpeechSynthesisResult>((resolve, reject) => {
    session.synthesizer.speakAsync(request, resolve, reject);
  });
  return {
    request,
    completion,
    hasAudio: () => audioReceived,
    markAudio: () => { audioReceived = true; },
    visemeSummary: () => ({ count: visemeCount, lastOffsetMs }),
  };
}

async function synthesizeFallback(ws: WebSocket, responseId: string, text: string): Promise<boolean> {
  const region = requiredEnvironment("AZURE_SPEECH_REGION");
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": requiredEnvironment("AZURE_SPEECH_KEY"),
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
    },
    body: `<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</voice></speak>`,
  });
  if (!response.ok) return false;
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) return false;
  send(ws, {
    type: "response_audio",
    response_id: responseId,
    audio: audio.toString("base64"),
    text,
  });
  return true;
}

export async function processTextTurn(
  ws: WebSocket,
  history: ChatHistory,
  userText: string,
  session: SpeechSession | null,
  options: TurnOptions = {},
): Promise<void> {
  const text = userText.trim();
  if (options.abortSignal?.aborted) return;
  if (!text) throw new Error("Please type a message before sending.");
  if (text.length > MAX_TEXT_CHARACTERS) {
    throw new Error("Please keep messages under 4,000 characters.");
  }

  const responseId = crypto.randomUUID();
  const startedAt = performance.now();
  let firstTextAt: number | null = null;
  let firstAudioAt: number | null = null;
  let reply = "";
  send(ws, {
    type: "response_start",
    response_id: responseId,
    sample_rate: 24_000,
  });

  let systemPrompt = options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  if (options.workspaceId) {
    try {
      const context = await retrieveContext(options.workspaceId, text);
      if (context) {
        systemPrompt += "\n\nUse the following uploaded-document context when it is relevant. "
          + "Do not invent facts that are not supported by it. If it does not answer the question, say so clearly.\n"
          + context;
      }
    } catch (error) {
      console.warn("[avatar] RAG retrieval unavailable", error);
    }
  }
  const synthesis = beginSynthesis(ws, session, responseId, options.abortSignal);
  if (session) {
    const originalSynthesizing = session.synthesizer.synthesizing;
    session.synthesizer.synthesizing = (sender, event) => {
      if (firstAudioAt === null && event.result.audioData.byteLength > 0) {
        firstAudioAt = performance.now();
      }
      originalSynthesizing(sender, event);
    };
  }

  try {
    const google = createGoogle({ apiKey: requiredEnvironment("GEMINI_API_KEY") });
    const result = streamText({
      model: google(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"),
      system: systemPrompt
        + "\n\nAlways answer in English unless the user explicitly asks for another language. "
        + "Give a complete answer to the user's question. Do not stop mid-sentence. Keep it suitable for spoken delivery.",
      messages: toModelMessages([...history, { role: "user", content: text }]),
      abortSignal: options.abortSignal,
      temperature: 0.5,
      maxOutputTokens: 700,
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: "minimal" } },
      },
    });

    for await (const chunk of result.textStream) {
      if (options.abortSignal?.aborted) break;
      if (!chunk) continue;
      if (firstTextAt === null) firstTextAt = performance.now();
      reply += chunk;
      send(ws, {
        type: "response_delta",
        response_id: responseId,
        text: chunk,
      });
      synthesis.request.inputStream.write(chunk);
    }
    synthesis.request.inputStream.close();
    await synthesis.completion;
    if (!synthesis.hasAudio() && reply.trim()) {
      try {
        if (await synthesizeFallback(ws, responseId, reply.trim())) synthesis.markAudio();
      } catch (error) {
        console.warn("[avatar] fallback speech synthesis unavailable", error);
      }
    }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      if (!synthesis.request.inputStream.isClosed) synthesis.request.inputStream.close();
      await synthesis.completion.catch(() => undefined);
      return;
    }
    if (!synthesis.request.inputStream.isClosed) synthesis.request.inputStream.close();
    await synthesis.completion.catch(() => undefined);
    throw error;
  }

  if (options.abortSignal?.aborted) return;

  reply = reply.trim();
  if (!reply) throw new Error("I couldn't generate a response right now. Please try again.");

  history.push(
    { role: "user", content: text },
    { role: "assistant", content: reply },
  );
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }

  const visemes = synthesis.visemeSummary();
  console.info("[avatar] streaming turn", {
    firstTextMs: firstTextAt ? Math.round(firstTextAt - startedAt) : null,
    firstAudioMs: firstAudioAt ? Math.round(firstAudioAt - startedAt) : null,
    totalMs: Math.round(performance.now() - startedAt),
    visemes: visemes.count,
    lastVisemeOffsetMs: Math.round(visemes.lastOffsetMs),
  });
  send(ws, {
    type: "response_end",
    response_id: responseId,
    text: reply,
    has_audio: synthesis.hasAudio(),
  });
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
  if (!audio.length) throw new Error("The recording was empty. Please try again.");
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new Error("That recording is too large. Please keep it under 25 MB.");
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(audio)], { type: mimeType }),
    `recording.${extensionForMimeType(mimeType)}`,
  );
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${requiredEnvironment("GROQ_API_KEY")}` },
    body: form,
  });
  if (!response.ok) {
    console.error("[avatar] Groq transcription failed", response.status);
    throw new Error("I couldn't transcribe that recording. Please try again.");
  }
  const payload = await response.json() as { text?: string };
  const transcription = payload.text?.trim();
  if (!transcription) throw new Error("I couldn't hear any speech in that recording.");
  return transcription;
}

export function sendPipelineError(ws: WebSocket, error: unknown): void {
  console.error("[avatar] pipeline error", error);
  send(ws, {
    type: "error",
    message: error instanceof Error
      ? error.message
      : "Something went wrong. Please reconnect and try again.",
  });
}
