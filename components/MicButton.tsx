"use client";

import { useEffect, useRef, useState } from "react";

interface MicButtonProps {
  disabled: boolean;
  onInteract: () => void;
  onAudioReady: (audio: Blob) => void;
  onRecordingChange: (recording: boolean) => void;
  onSpeechDetected: () => void;
  onError: (message: string) => void;
}

const VOICE_THRESHOLD = 0.018;
const END_OF_SPEECH_MS = 850;
const MAX_WAIT_FOR_SPEECH_MS = 12_000;
const NOISE_CALIBRATION_MS = 450;

export function MicButton({
  disabled,
  onInteract,
  onAudioReady,
  onRecordingChange,
  onSpeechDetected,
  onError,
}: MicButtonProps) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingRef = useRef(false);
  const heardSpeechRef = useRef(false);
  const startedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const noiseFloorRef = useRef(0);
  const [recording, setRecording] = useState(false);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const stopMonitoring = () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") void audioContext.close();
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  };

  useEffect(() => () => {
    stopMonitoring();
    stopTracks();
    stopRecording();
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const recorder = new MediaRecorder(stream);
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2_048;
      analyser.smoothingTimeConstant = 0.15;
      audioContext.createMediaStreamSource(stream).connect(analyser);

      streamRef.current = stream;
      recorderRef.current = recorder;
      audioContextRef.current = audioContext;
      chunksRef.current = [];
      heardSpeechRef.current = false;
      startedAtRef.current = performance.now();
      lastVoiceAtRef.current = startedAtRef.current;
      noiseFloorRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const heardSpeech = heardSpeechRef.current;
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stopMonitoring();
        stopTracks();
        recorderRef.current = null;
        recordingRef.current = false;
        setRecording(false);
        onRecordingChange(false);
        if (heardSpeech && audio.size > 0) onAudioReady(audio);
      };

      const samples = new Uint8Array(analyser.fftSize);
      const monitorSpeech = () => {
        if (!recordingRef.current) return;
        analyser.getByteTimeDomainData(samples);
        let squaredSum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          squaredSum += normalized * normalized;
        }
        const volume = Math.sqrt(squaredSum / samples.length);
        const now = performance.now();
        if (now - startedAtRef.current < NOISE_CALIBRATION_MS) {
          noiseFloorRef.current = noiseFloorRef.current === 0
            ? volume
            : noiseFloorRef.current * 0.9 + volume * 0.1;
        }
        const adaptiveThreshold = Math.max(VOICE_THRESHOLD, noiseFloorRef.current * 2.8);

        if (volume >= adaptiveThreshold) {
          lastVoiceAtRef.current = now;
          if (!heardSpeechRef.current) {
            heardSpeechRef.current = true;
            onSpeechDetected();
          }
        }

        if (
          (heardSpeechRef.current && now - lastVoiceAtRef.current >= END_OF_SPEECH_MS)
          || (!heardSpeechRef.current && now - startedAtRef.current >= MAX_WAIT_FOR_SPEECH_MS)
        ) {
          stopRecording();
          return;
        }
        animationFrameRef.current = requestAnimationFrame(monitorSpeech);
      };

      recorder.start();
      recordingRef.current = true;
      setRecording(true);
      onRecordingChange(true);
      animationFrameRef.current = requestAnimationFrame(monitorSpeech);
    } catch {
      stopMonitoring();
      stopTracks();
      recordingRef.current = false;
      setRecording(false);
      onRecordingChange(false);
      onError("Microphone access was unavailable. Check browser permission and try again.");
    }
  };

  const handleClick = () => {
    onInteract();
    if (recording) stopRecording();
    else void startRecording();
  };

  return (
    <button
      aria-label={recording ? "Listening. Click to stop" : "Start voice question"}
      className={`grid h-12 w-12 shrink-0 place-items-center rounded-full transition ${
        recording ? "animate-pulse bg-rose-500 text-white" : "bg-slate-700 text-cyan-300 hover:bg-slate-600"
      } disabled:cursor-not-allowed disabled:opacity-40`}
      disabled={disabled}
      onClick={handleClick}
      type="button"
    >
      <svg aria-hidden="true" fill="none" height="22" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="22">
        <rect height="11" rx="5.5" width="8" x="8" y="2" />
        <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
      </svg>
    </button>
  );
}
