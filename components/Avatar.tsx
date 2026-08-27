"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Box3, MathUtils, Vector3, type Camera, type Group, type PerspectiveCamera } from "three";
import type { ChatResponse, TimedViseme } from "@/lib/wsClient";

// Some corporate/ISP DNS resolvers block models.readyplayer.me. This public
// TalkingHead reference model keeps the renderer usable until an RPM URL is reachable.
const FALLBACK_AVATAR_URL = "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb";
const CONFIGURED_AVATAR_URL = process.env.NEXT_PUBLIC_AVATAR_URL?.trim();

// Set NEXT_PUBLIC_AVATAR_URL to use an RPM export with Oculus viseme morph targets.
// Without an explicit URL, use the compatible reference avatar directly so a known
// blocked RPM hostname does not create a failed request on every page load.
export const READY_PLAYER_ME_AVATAR_URL = CONFIGURED_AVATAR_URL || FALLBACK_AVATAR_URL;

interface TalkingHeadLike {
  armature: Group;
  audioCtx: AudioContext;
  lipsync: Record<string, {
    preProcessText: (text: string) => string;
    wordsToVisemes: (word: string) => { visemes: string[]; times: number[]; durations: number[] };
  }>;
  showAvatar: (options: { url: string; body: "F" | "M"; avatarMood: string }) => Promise<void>;
  animate: (milliseconds: number) => void;
  speakAudio: (audio: {
    audio: AudioBuffer;
    words: string[];
    wtimes: number[];
    wdurations: number[];
    visemes: string[];
    vtimes: number[];
    vdurations: number[];
  }) => void;
  speakMarker: (callback: () => void) => void;
  streamStart: (
    options: {
      sampleRate: number;
      lipsyncType: "visemes" | "words";
      lipsyncLang?: string;
      waitForAudioChunks: boolean;
      mood: string;
    },
    onAudioStart: () => void,
    onAudioEnd: () => void,
  ) => Promise<void>;
  streamAudio: (payload: {
    audio?: ArrayBuffer;
    visemes?: string[];
    vtimes?: number[];
    vdurations?: number[];
    words?: string[];
    wtimes?: number[];
    wdurations?: number[];
  }) => void;
  streamNotifyEnd: () => void;
  streamInterrupt: () => void;
  setMood: (mood: string) => void;
  stop: () => void;
}

export interface AvatarHandle {
  speak: (response: ChatResponse) => Promise<boolean>;
  startStream: (sampleRate: number) => Promise<boolean>;
  pushStreamAudio: (audio: string, text?: string) => Promise<void>;
  pushStreamViseme: (viseme: TimedViseme) => Promise<void>;
  endStream: () => Promise<void>;
  cancelStream: () => void;
  unlockAudio: () => Promise<void>;
}

interface AvatarProps {
  onReady: (usingFallback: boolean) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onError: (message: string) => void;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function resamplePcm16(audio: ArrayBuffer, sourceRate: number, targetRate: number): ArrayBuffer {
  if (sourceRate === targetRate) return audio;
  const input = new Int16Array(audio);
  const output = new Int16Array(Math.max(1, Math.round(input.length * targetRate / sourceRate)));
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < output.length; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.min(Math.floor(sourceIndex), input.length - 1);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = sourceIndex - leftIndex;
    output[index] = Math.round(input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction);
  }
  return output.buffer;
}

const OCULUS_VISEMES = new Set([
  "sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U",
]);

// Azure sends visemes and PCM in independently sized batches. Keep a small
// look-ahead so the renderer has the next mouth cue before that PCM can reach
// the speakers. This prevents a cue received slightly late from being applied
// to a syllable that has already played.
const LIP_SYNC_LOOK_AHEAD_MS = 160;
const FINAL_VISEME_DURATION_MS = 120;

interface QueuedAudioChunk {
  audio: ArrayBuffer;
  durationMs: number;
  sampleRate: number;
  text?: string;
}

function buildAudioAwareWordTiming(text: string, audio: ArrayBuffer, sampleRate: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { words, wtimes: [], wdurations: [] };

  const samples = new Int16Array(audio);
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const levels: number[] = [];
  for (let start = 0; start < samples.length; start += frameSamples) {
    let sum = 0;
    const end = Math.min(samples.length, start + frameSamples);
    for (let index = start; index < end; index += 1) {
      const value = samples[index] / 32_768;
      sum += value * value;
    }
    levels.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const peak = Math.max(...levels, 0);
  const threshold = Math.max(0.006, peak * 0.1);
  const voiced = levels.map((level) => level >= threshold);
  // Preserve consonant edges while ensuring actual quiet gaps remain closed.
  const originalVoiced = [...voiced];
  originalVoiced.forEach((active, index) => {
    if (!active) return;
    if (index > 0) voiced[index - 1] = true;
    if (index + 1 < voiced.length) voiced[index + 1] = true;
  });

  const intervals: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < voiced.length;) {
    if (!voiced[index]) { index += 1; continue; }
    const first = index;
    while (index < voiced.length && voiced[index]) index += 1;
    intervals.push({ start: first * 20, end: Math.min(index * 20, samples.length / sampleRate * 1_000) });
  }
  const durationMs = samples.length / sampleRate * 1_000;
  if (!intervals.length) intervals.push({ start: 0, end: durationMs });
  const voicedDuration = intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
  const weights = words.map((word) => Math.max(1, word.replace(/[^a-z0-9]/gi, "").length));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);

  const mapVoicedOffset = (offset: number) => {
    let remaining = Math.min(offset, voicedDuration);
    for (const interval of intervals) {
      const length = interval.end - interval.start;
      if (remaining <= length) return { time: interval.start + remaining, intervalEnd: interval.end };
      remaining -= length;
    }
    const last = intervals.at(-1) as { start: number; end: number };
    return { time: last.end, intervalEnd: last.end };
  };

  let consumedWeight = 0;
  const wtimes: number[] = [];
  const wdurations: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const start = mapVoicedOffset(voicedDuration * consumedWeight / totalWeight);
    consumedWeight += weights[index];
    const end = mapVoicedOffset(voicedDuration * consumedWeight / totalWeight);
    wtimes.push(start.time);
    wdurations.push(Math.max(40, Math.min(end.time - start.time, start.intervalEnd - start.time)));
  }
  return { words, wtimes, wdurations };
}

interface LipSyncPayload {
  visemes: string[];
  vtimes: number[];
  vdurations: number[];
}

function takeReadyVisemes(queue: TimedViseme[], includeFinalViseme: boolean): LipSyncPayload | null {
  const count = includeFinalViseme ? queue.length : Math.max(0, queue.length - 1);
  if (!count) return null;

  const batch = queue.splice(0, count);
  return {
    visemes: batch.map((viseme) => viseme.viseme),
    vtimes: batch.map((viseme) => viseme.offset_ms),
    vdurations: batch.map((viseme, index) => {
      const next = batch[index + 1] ?? queue[0];
      return Math.max(
        40,
        next ? next.offset_ms - viseme.offset_ms : FINAL_VISEME_DURATION_MS,
      );
    }),
  };
}

function buildLipSync(response: ChatResponse, audioDurationMs: number) {
  const visemes = response.visemes.filter(
    (viseme) => Number.isFinite(viseme.offset_ms) && viseme.offset_ms >= 0 && OCULUS_VISEMES.has(viseme.viseme),
  );
  visemes.sort((left, right) => left.offset_ms - right.offset_ms);
  const timings = visemes.map((viseme) => Math.min(viseme.offset_ms, audioDurationMs));
  const durations = timings.map((offset, index) => {
    const nextOffset = timings[index + 1] ?? audioDurationMs;
    return Math.max(40, nextOffset - offset);
  });

  return {
    names: visemes.map((viseme) => viseme.viseme),
    timings,
    durations,
  };
}

function frameUpperBody(camera: Camera, armature: Group) {
  const perspectiveCamera = camera as PerspectiveCamera;
  if (!perspectiveCamera.isPerspectiveCamera) return;

  armature.updateWorldMatrix(true, true);
  const bounds = new Box3().setFromObject(armature);
  if (bounds.isEmpty()) return;

  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const hips = armature.getObjectByName("Hips");
  const hipsPosition = hips?.getWorldPosition(new Vector3());
  const waistY = hipsPosition?.y ?? bounds.min.y + size.y * 0.48;
  const upperHeight = Math.max(bounds.max.y - waistY, size.y * 0.42);
  const target = new Vector3(center.x, waistY + upperHeight * 0.56, center.z);
  const verticalSpan = upperHeight * 1.18;
  const horizontalSpan = size.x * 1.12;
  const halfVerticalFov = MathUtils.degToRad(perspectiveCamera.fov) / 2;
  const distanceForHeight = verticalSpan / (2 * Math.tan(halfVerticalFov));
  const distanceForWidth = horizontalSpan / (2 * Math.tan(halfVerticalFov) * perspectiveCamera.aspect);
  const distance = Math.max(distanceForHeight, distanceForWidth, 0.5);

  perspectiveCamera.position.set(target.x, target.y, target.z + distance);
  perspectiveCamera.near = Math.max(0.01, distance / 100);
  perspectiveCamera.far = Math.max(100, distance * 20);
  perspectiveCamera.lookAt(target);
  perspectiveCamera.updateProjectionMatrix();
}

function AvatarScene({ onHeadReady, onError }: { onHeadReady: (head: TalkingHeadLike, usingFallback: boolean) => void; onError: (message: string) => void }) {
  const { camera, scene } = useThree();
  const headRef = useRef<TalkingHeadLike | null>(null);
  const onHeadReadyRef = useRef(onHeadReady);
  const onErrorRef = useRef(onError);

  useEffect(() => { onHeadReadyRef.current = onHeadReady; }, [onHeadReady]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let head: TalkingHeadLike | null = null;
    const loadAvatar = async () => {
      try {
        const talkingHeadModule = (await import("@met4citizen/talkinghead")) as unknown as { TalkingHead: new (node: HTMLElement, options: object) => TalkingHeadLike };
        head = new talkingHeadModule.TalkingHead(document.createElement("div"), {
          avatarOnly: true,
          avatarOnlyCamera: camera,
          lipsyncModules: [],
          modelPixelRatio: Math.min(window.devicePixelRatio, 2),
        });
        const { LipsyncEn } = await import("@met4citizen/talkinghead/modules/lipsync-en.mjs");
        head.lipsync.en = new LipsyncEn();
        const avatarUrls = CONFIGURED_AVATAR_URL
          ? [CONFIGURED_AVATAR_URL, FALLBACK_AVATAR_URL]
          : [FALLBACK_AVATAR_URL];
        let loadedUrl: string | null = null;
        for (const avatarUrl of avatarUrls) {
          try {
            await head.showAvatar({ url: avatarUrl, body: "F", avatarMood: "neutral" });
            loadedUrl = avatarUrl;
            break;
          } catch {
            // Try the fallback only after the configured Ready Player Me URL fails.
          }
        }
        if (!loadedUrl) throw new Error("No avatar model could be loaded");
        if (cancelled) return;
        scene.add(head.armature);
        frameUpperBody(camera, head.armature);
        headRef.current = head;
        onHeadReadyRef.current(head, Boolean(CONFIGURED_AVATAR_URL && loadedUrl === FALLBACK_AVATAR_URL));
      } catch {
        onErrorRef.current("The 3D avatar could not be loaded. Check the Ready Player Me URL and connection.");
      }
    };
    void loadAvatar();
    return () => {
      cancelled = true;
      if (head?.armature) scene.remove(head.armature);
      head?.stop();
    };
  }, [camera, scene]);

  useFrame((_, delta) => headRef.current?.animate(delta * 1_000));
  return <ambientLight intensity={1.5} />;
}

export const Avatar = forwardRef<AvatarHandle, AvatarProps>(function Avatar({ onReady, onSpeechStart, onSpeechEnd, onError }, ref) {
  const [head, setHead] = useState<TalkingHeadLike | null>(null);
  const speechEndTimerRef = useRef<number | null>(null);
  const streamReadyRef = useRef<Promise<boolean> | null>(null);
  const streamSessionRef = useRef(0);
  const streamSourceRateRef = useRef(24_000);
  const queuedAudioRef = useRef<QueuedAudioChunk[]>([]);
  const queuedVisemesRef = useRef<TimedViseme[]>([]);
  const releasedAudioDurationMsRef = useRef(0);

  const resetStreamBuffers = () => {
    queuedAudioRef.current = [];
    queuedVisemesRef.current = [];
    releasedAudioDurationMsRef.current = 0;
  };

  const flushStreamBuffers = (activeHead: TalkingHeadLike, force = false) => {
    while (queuedAudioRef.current.length) {
      const nextAudio = queuedAudioRef.current[0];
      const latestViseme = queuedVisemesRef.current.at(-1);
      const requiredVisemeOffset = releasedAudioDurationMsRef.current
        + nextAudio.durationMs
        + LIP_SYNC_LOOK_AHEAD_MS;

      if (nextAudio.text) {
        queuedAudioRef.current.shift();
        const timing = buildAudioAwareWordTiming(nextAudio.text, nextAudio.audio, nextAudio.sampleRate);
        activeHead.streamAudio({
          audio: nextAudio.audio,
          words: timing.words,
          wtimes: timing.wtimes.map((time) => releasedAudioDurationMsRef.current + time),
          wdurations: timing.wdurations,
        });
        releasedAudioDurationMsRef.current += nextAudio.durationMs;
        continue;
      }

      if (!force && (!latestViseme || latestViseme.offset_ms < requiredVisemeOffset)) break;

      queuedAudioRef.current.shift();
      const lipSync = takeReadyVisemes(queuedVisemesRef.current, force);
      activeHead.streamAudio({
        audio: nextAudio.audio,
        ...(lipSync ?? {}),
      });
      releasedAudioDurationMsRef.current += nextAudio.durationMs;
    }
  };

  useEffect(() => () => {
    if (speechEndTimerRef.current) clearTimeout(speechEndTimerRef.current);
  }, []);

  useImperativeHandle(ref, () => ({
    unlockAudio: async () => {
      if (head?.audioCtx.state !== "running") await head?.audioCtx.resume();
    },
    speak: async (response) => {
      if (!head || !response.audio) return false;
      try {
        await head.audioCtx.resume();
        const audio = await head.audioCtx.decodeAudioData(base64ToArrayBuffer(response.audio));
        const lipSync = buildLipSync(response, audio.duration * 1_000);
        if (!lipSync.names.length) {
          onError("The voice reply had no usable lip-sync timing. Please try again.");
          return false;
        }
        head.setMood("neutral");
        head.speakAudio({
          audio,
          // TalkingHead 1.7 builds its supplied-viseme animation inside the
          // words branch. Empty word arrays activate that branch without asking
          // the browser to estimate phonemes from text.
          words: [],
          wtimes: [],
          wdurations: [],
          visemes: lipSync.names,
          vtimes: lipSync.timings,
          vdurations: lipSync.durations,
        });
        let completed = false;
        const completeSpeech = () => {
          if (completed) return;
          completed = true;
          if (speechEndTimerRef.current) clearTimeout(speechEndTimerRef.current);
          speechEndTimerRef.current = null;
          head.setMood("neutral");
          onSpeechEnd();
        };
        // The queue marker is exact when the browser plays audio normally. The
        // timer is a liveness fallback for browsers that suspend AudioContext
        // completion events despite an attempted user-gesture resume.
        speechEndTimerRef.current = window.setTimeout(completeSpeech, audio.duration * 1_000 + 1_500);
        head.speakMarker(completeSpeech);
        return true;
      } catch {
        onError("The reply arrived, but the browser could not play its audio.");
        return false;
      }
    },
    startStream: (sampleRate) => {
      if (!head) return Promise.resolve(false);
      streamSourceRateRef.current = sampleRate;
      if (streamReadyRef.current) return streamReadyRef.current;
      const session = streamSessionRef.current + 1;
      streamSessionRef.current = session;
      resetStreamBuffers();
      const ready = (async () => {
        try {
          const resumePromise = head.audioCtx.resume();
          const startPromise = head.streamStart(
            {
              // Keep the context created with the avatar. Replacing it after a
              // network response loses Chrome's click-based autoplay grant.
              sampleRate: head.audioCtx.sampleRate,
              lipsyncType: "words",
              lipsyncLang: "en",
              waitForAudioChunks: true,
              mood: "neutral",
            },
            () => {
              if (streamSessionRef.current === session) onSpeechStart();
            },
            () => {
              if (streamSessionRef.current === session) {
                streamReadyRef.current = null;
                resetStreamBuffers();
                head.setMood("neutral");
                onSpeechEnd();
              }
            },
          );
          // Chrome may leave resume() pending indefinitely when autoplay is
          // blocked. TalkingHead has its own bounded wait, so do not let the
          // raw resume promise block response completion and UI recovery.
          void resumePromise.catch(() => undefined);
          await startPromise;
          if (head.audioCtx.state !== "running") {
            streamReadyRef.current = null;
            return false;
          }
          return streamSessionRef.current === session;
        } catch {
          if (streamSessionRef.current === session) {
            onError("The reply arrived, but streaming audio could not be started.");
            onSpeechEnd();
          }
          return false;
        }
      })();
      streamReadyRef.current = ready;
      return ready;
    },
    pushStreamAudio: async (audio, text) => {
      if (!head || !(await streamReadyRef.current)) return;
      const sourceAudio = base64ToArrayBuffer(audio);
      queuedAudioRef.current.push({
        audio: resamplePcm16(
          sourceAudio,
          streamSourceRateRef.current,
          head.audioCtx.sampleRate,
        ),
        durationMs: sourceAudio.byteLength / 2 / streamSourceRateRef.current * 1_000,
        sampleRate: head.audioCtx.sampleRate,
        text,
      });
      if (text) {
        flushStreamBuffers(head);
        return;
      }
      // If Azure did not provide viseme events, keep the mouth animated with
      // deterministic fallback cues aligned to each PCM chunk.
      const queuedAudioBeforeThis = queuedAudioRef.current
        .slice(0, -1)
        .reduce((total, chunk) => total + chunk.durationMs, 0);
      const syntheticStart = releasedAudioDurationMsRef.current + queuedAudioBeforeThis;
      const hasSpeechCuesForChunk = queuedVisemesRef.current.some(
        (cue) => cue.offset_ms >= syntheticStart && cue.viseme !== "sil",
      );
      if (!hasSpeechCuesForChunk) {
        const chunkDuration = sourceAudio.byteLength / 2 / streamSourceRateRef.current * 1_000;
        const cueDuration = Math.max(45, chunkDuration / 6);
        ["aa", "E", "O", "PP", "I", "sil"].forEach((viseme, index) => queuedVisemesRef.current.push({
          offset_ms: syntheticStart + index * cueDuration,
          viseme_id: -1,
          viseme,
        }));
        // This look-ahead marker lets flushStreamBuffers release the PCM and
        // its mouth cues together instead of holding the audio until stream end.
        queuedVisemesRef.current.push({
          offset_ms: syntheticStart + chunkDuration + LIP_SYNC_LOOK_AHEAD_MS,
          viseme_id: -1,
          viseme: "sil",
        });
      }
      flushStreamBuffers(head);
    },
    pushStreamViseme: async (viseme) => {
      if (
        !head
        || !(await streamReadyRef.current)
        || !Number.isFinite(viseme.offset_ms)
        || viseme.offset_ms < 0
        || !OCULUS_VISEMES.has(viseme.viseme)
      ) return;

      const queue = queuedVisemesRef.current;
      const previous = queue.at(-1);
      if (previous && viseme.offset_ms < previous.offset_ms) {
        // WebSocket preserves ordering, but ignore an unexpectedly stale cue
        // rather than placing it into an already scheduled audio timeline.
        return;
      }
      queue.push(viseme);
      flushStreamBuffers(head);
    },
    endStream: async () => {
      if (!head || !(await streamReadyRef.current)) {
        onSpeechEnd();
        return;
      }
      const remainingLipSync = takeReadyVisemes(queuedVisemesRef.current, true);
      if (remainingLipSync) {
        head.streamAudio({
          ...remainingLipSync,
        });
      }
      flushStreamBuffers(head, true);
      head.streamNotifyEnd();
    },
    cancelStream: () => {
      streamSessionRef.current += 1;
      streamReadyRef.current = null;
      resetStreamBuffers();
      head?.streamInterrupt();
    },
  }), [head, onError, onSpeechEnd, onSpeechStart]);

  return (
    <div className="h-[340px] overflow-hidden rounded-3xl border border-cyan-400/20 bg-gradient-to-b from-slate-800 to-slate-950 shadow-2xl shadow-cyan-950/20 sm:h-[430px]">
      <Canvas camera={{ position: [0, 1.5, 2.5], fov: 28 }} dpr={[1, 2]}>
        <color attach="background" args={["#0b1728"]} />
        <directionalLight intensity={2.5} position={[2, 4, 3]} />
        <AvatarScene onError={onError} onHeadReady={(loadedHead, usingFallback) => { setHead(loadedHead); onReady(usingFallback); }} />
      </Canvas>
    </div>
  );
});
