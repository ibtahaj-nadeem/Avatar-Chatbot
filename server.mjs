import http from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
const pipelineModule = await import("./lib/server/avatarPipeline.ts");
const pipeline = pipelineModule.default ?? pipelineModule;
const { createSpeechSession, closeSpeechSession, processTextTurn, transcribeAudio, sendPipelineError } = pipeline;
if (![createSpeechSession, closeSpeechSession, processTextTurn, transcribeAudio, sendPipelineError].every((item) => typeof item === "function")) {
  throw new Error(`Avatar pipeline exports unavailable: ${Object.keys(pipeline).join(", ")}`);
}

const port = Number(process.env.PORT || 3000);
const app = next({ dev: false, hostname: "0.0.0.0", port });
const handle = app.getRequestHandler();
await app.prepare();
const runtimeStats = {
  version: "voice-health-v2",
  connections: 0,
  messages: 0,
  lastStage: "startup",
  lastError: null,
};
const reportError = (ws, error) => {
  runtimeStats.lastStage = "error";
  runtimeStats.lastError = error instanceof Error ? error.message : String(error);
  sendPipelineError(ws, error);
};
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(runtimeStats));
    return;
  }
  handle(req, res);
});
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  runtimeStats.connections += 1;
  runtimeStats.lastStage = "connected";
  const history = [];
  let speech = null;
  let mime = "audio/webm";
  let queue = Promise.resolve();
  let systemPrompt = "";
  let workspaceId = "";
  let active = null;

  ws.on("message", (data, isBinary) => {
    runtimeStats.messages += 1;
    runtimeStats.lastStage = isBinary ? "audio-received" : "json-received";
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (error) { reportError(ws, error); return; }
      if (msg.type === "cancel") { active?.abort(); return; }
      if (msg.type === "session_config") { systemPrompt = String(msg.system_prompt || ""); workspaceId = String(msg.workspace_id || ""); return; }
      if (msg.type === "audio_metadata") { mime = String(msg.mime_type || "audio/webm"); return; }
      if (msg.type !== "text") return;
      queue = queue.catch(() => undefined).then(async () => {
        active = new AbortController();
        runtimeStats.lastStage = "text-processing";
        console.log("[avatar] text turn received");
        await processTextTurn(ws, history, String(msg.text || ""), null, { abortSignal: active.signal, systemPrompt, workspaceId });
        runtimeStats.lastStage = "text-complete";
        active = null;
      }).catch((error) => reportError(ws, error));
      return;
    }
    queue = queue.catch(() => undefined).then(async () => {
      active = new AbortController();
      runtimeStats.lastStage = "transcribing";
      console.log("[avatar] audio turn received", { bytes: data.length, mime });
      const text = await transcribeAudio(Buffer.from(data), mime);
      runtimeStats.lastStage = "transcribed";
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "transcription", text }));
      await processTextTurn(ws, history, text, null, { abortSignal: active.signal, systemPrompt, workspaceId });
      runtimeStats.lastStage = "audio-complete";
      active = null;
    }).catch((error) => reportError(ws, error));
  });
  ws.on("close", () => { active?.abort(); closeSpeechSession(speech); speech = null; });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/api/ws")) wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});
server.listen(port, "0.0.0.0", () => console.log(`Avatar server listening on ${port}`));
