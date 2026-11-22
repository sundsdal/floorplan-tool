"use client";

import { useEffect, useRef, useState } from "react";

import type { CaptureNote } from "@/lib/gemini";

export default function LiveCapture({
	onCapture,
	disabled = false,
}: {
	onCapture: (file: File, notes: CaptureNote[]) => void;
	disabled?: boolean;
}) {
	const notesRef = useRef<CaptureNote[]>([]);
	const guideTurnRef = useRef("");
	const startedRef = useRef(0);
	const addNote = (speaker: CaptureNote["speaker"], text: string) => {
		if (!text.trim()) return;
		text = text.trim();
		notesRef.current = [
			...notesRef.current,
			{
				seconds: Math.min(
					86400,
					Math.max(0, (Date.now() - startedRef.current) / 1000),
				),
				speaker,
				text: text.slice(0, 500),
			},
		].slice(-100);
	};
	const flushGuideTurn = () => {
		addNote("guide", guideTurnRef.current);
		guideTurnRef.current = "";
	};
	const videoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const socketRef = useRef<WebSocket | null>(null);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const promptRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const audioRef = useRef<AudioContext | null>(null);
	const audioTimeRef = useRef(0);
	const audioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
	const sessionRef = useRef(0);
	const readyRef = useRef(false);
	const clearAudio = () => {
		for (const source of audioSourcesRef.current) {
			try {
				source.stop();
			} catch {}
		}
		audioSourcesRef.current.clear();
		audioTimeRef.current = 0;
	};
	const mountedRef = useRef(true);
	const [recording, setRecording] = useState(false);
	const [starting, setStarting] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [connected, setConnected] = useState(false);
	const [transcript, setTranscript] = useState("");
	const [question, setQuestion] = useState("");
	const [error, setError] = useState("");

	const cleanup = () => {
		sessionRef.current++;
		readyRef.current = false;
		clearAudio();
		if (timerRef.current) clearInterval(timerRef.current);
		if (promptRef.current) clearInterval(promptRef.current);
		socketRef.current?.close();
		socketRef.current = null;
		streamRef.current?.getTracks().forEach((track) => {
			track.stop();
		});
		streamRef.current = null;
		if (videoRef.current) videoRef.current.srcObject = null;
		void audioRef.current?.close();
		audioRef.current = null;
	};
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (recorderRef.current?.state !== "inactive")
				recorderRef.current?.stop();
			cleanup();
		};
	}, []);

	const sendText = (text: string) => {
		if (readyRef.current && socketRef.current?.readyState === WebSocket.OPEN)
			socketRef.current.send(JSON.stringify({ realtimeInput: { text } }));
	};
	const connect = async () => {
		const session = ++sessionRef.current;
		const active = () =>
			mountedRef.current &&
			session === sessionRef.current &&
			!!streamRef.current;
		readyRef.current = false;
		setConnected(false);
		setError("");
		if (timerRef.current) clearInterval(timerRef.current);
		if (promptRef.current) clearInterval(promptRef.current);
		socketRef.current?.close();
		socketRef.current = null;
		try {
			const response = await fetch("/api/capture-guide", { method: "POST" });
			if (!response.ok)
				throw new Error(
					"Live guidance is unavailable. You can continue recording.",
				);
			const { token, model } = await response.json();
			if (!active()) return;
			const socket = new WebSocket(
				`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
			);
			socketRef.current = socket;
			socket.binaryType = "arraybuffer";
			socket.onopen = () => {
				if (!active()) return;
				socket.send(
					JSON.stringify({
						setup: {
							model: `models/${model}`,
							generationConfig: { responseModalities: ["AUDIO"] },
							outputAudioTranscription: {},
							systemInstruction: {
								parts: [
									{
										text: "Guide a person recording a property walkthrough for a floor plan. Track rooms, doorways and coverage gaps through the session. Give brief, specific directions to show unseen corners, transitions or revisit gaps. Do not invent unseen features.",
									},
								],
							},
						},
					}),
				);
			};
			let messageQueue = Promise.resolve();
			socket.onmessage = (event) => {
				messageQueue = messageQueue
					.then(async () => {
						const raw =
							typeof event.data === "string"
								? event.data
								: event.data instanceof Blob
									? await event.data.text()
									: new TextDecoder().decode(event.data);
						if (!active()) return;
						const message = JSON.parse(raw);
						if (message.setupComplete) {
							readyRef.current = true;
							setConnected(true);
							sendText(
								"Guide me through filming this property. Give one specific next step based on what you can see.",
							);
							return;
						}
						const content = message.serverContent;
						if (content?.interrupted) clearAudio();
						if (content?.outputTranscription?.text) {
							const text = content.outputTranscription.text;
							setTranscript((old) => (old + text).slice(-3000));
							guideTurnRef.current = (guideTurnRef.current + text).slice(
								0,
								1000,
							);
						}
						if (content?.turnComplete || content?.interrupted) {
							flushGuideTurn();
							setTranscript((old) => old.trimEnd() + "\n\n");
						}
						for (const part of content?.modelTurn?.parts || []) {
							if (!part.inlineData?.data || !audioRef.current) continue;
							const raw = atob(part.inlineData.data);
							const samples = new Float32Array(Math.floor(raw.length / 2));
							for (let i = 0; i < samples.length; i++) {
								const value =
									raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
								samples[i] = (value >= 32768 ? value - 65536 : value) / 32768;
							}
							const context = audioRef.current;
							const buffer = context.createBuffer(1, samples.length, 24000);
							buffer.copyToChannel(samples, 0);
							const source = context.createBufferSource();
							source.buffer = buffer;
							source.connect(context.destination);
							audioSourcesRef.current.add(source);
							source.onended = () => audioSourcesRef.current.delete(source);
							audioTimeRef.current = Math.max(
								context.currentTime,
								audioTimeRef.current,
							);
							source.start(audioTimeRef.current);
							audioTimeRef.current += buffer.duration;
						}
					})
					.catch(() => {
						if (active())
							setError(
								"Live guidance sent an unreadable response. Recording continues.",
							);
					});
			};
			socket.onclose = () => {
				if (active()) {
					readyRef.current = false;
					setConnected(false);
					setError(
						"Live guidance disconnected. Recording continues; stop when you are finished.",
					);
				}
			};
			socket.onerror = () => {
				if (active())
					setError("Live guidance is unavailable. Recording continues.");
			};
			timerRef.current = setInterval(() => {
				const video = videoRef.current;
				if (
					!active() ||
					!readyRef.current ||
					!video?.videoWidth ||
					socket.readyState !== WebSocket.OPEN
				)
					return;
				const canvas = document.createElement("canvas");
				canvas.width = 480;
				canvas.height = Math.round(
					(480 * video.videoHeight) / video.videoWidth,
				);
				const context = canvas.getContext("2d");
				if (!context) return;
				context.drawImage(video, 0, 0, canvas.width, canvas.height);
				socket.send(
					JSON.stringify({
						realtimeInput: {
							video: {
								mimeType: "image/jpeg",
								data: canvas.toDataURL("image/jpeg", 0.65).split(",")[1],
							},
						},
					}),
				);
			}, 2000);
			promptRef.current = setInterval(
				() =>
					sendText(
						`At ${Math.floor((Date.now() - startedRef.current) / 1000)} seconds, based on the walkthrough so far, give one specific next filming direction or revisit an unresolved coverage gap.`,
					),
				20000,
			);
		} catch (err) {
			if (active())
				setError(
					err instanceof Error
						? err.message
						: "Live guidance is unavailable. Recording continues.",
				);
		}
	};
	const start = async () => {
		setStarting(true);
		setError("");
		setTranscript("");
		try {
			if (
				!navigator.mediaDevices?.getUserMedia ||
				typeof MediaRecorder === "undefined"
			)
				throw new Error("Camera recording is not supported in this browser.");
			const stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: "environment" } },
				audio: false,
			});
			if (!mountedRef.current) {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				return;
			}
			streamRef.current = stream;
			if (videoRef.current) {
				videoRef.current.srcObject = stream;
				await videoRef.current.play();
			}
			const mimeType = [
				"video/webm;codecs=vp8",
				"video/webm",
				"video/mp4",
			].find((type) => MediaRecorder.isTypeSupported(type));
			const recorder = new MediaRecorder(
				stream,
				mimeType ? { mimeType } : undefined,
			);
			recorderRef.current = recorder;
			const chunks: Blob[] = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			recorder.onerror = () => {
				if (mountedRef.current) {
					setError("Recording failed. Please try again.");
					setRecording(false);
				}
				cleanup();
			};
			recorder.onstop = () => {
				if (mountedRef.current) {
					setRecording(false);
					setStopping(false);
				}
				flushGuideTurn();
				const type = recorder.mimeType || "video/webm";
				if (mountedRef.current && chunks.length)
					onCapture(
						new File(
							chunks,
							`walkthrough-${Date.now()}.${type.includes("mp4") ? "mp4" : "webm"}`,
							{ type },
						),
						notesRef.current,
					);
				cleanup();
			};
			notesRef.current = [];
			guideTurnRef.current = "";
			startedRef.current = Date.now();
			audioTimeRef.current = 0;
			recorder.start(1000);
			setRecording(true);
			try {
				audioRef.current = new AudioContext({ sampleRate: 24000 });
				void audioRef.current.resume();
			} catch {
				setError(
					"Audio playback is unavailable; guidance text will still appear.",
				);
			}
			void connect();
		} catch (err) {
			cleanup();
			if (mountedRef.current)
				setError(
					err instanceof Error ? err.message : "Could not access the camera.",
				);
		} finally {
			if (mountedRef.current) setStarting(false);
		}
	};
	const stop = () => {
		sessionRef.current++;
		readyRef.current = false;
		setStopping(true);
		setConnected(false);
		if (recorderRef.current?.state === "recording") recorderRef.current.stop();
	};
	return (
		<section className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="font-semibold text-gray-900">Record a walkthrough</h2>
					<p className="text-sm text-gray-500">
						Keep recording when you revisit a room. Camera frames are sent to
						Gemini for live guidance.
					</p>
				</div>
				<button
					type="button"
					onClick={recording ? stop : start}
					disabled={starting || stopping || (!recording && disabled)}
					className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
				>
					{starting
						? "Opening camera…"
						: stopping
							? "Saving recording…"
							: recording
								? "Stop recording"
								: "Start camera"}
				</button>
			</div>
			<video
				ref={videoRef}
				muted
				playsInline
				className={
					recording
						? "w-full max-h-80 rounded-lg bg-black object-contain"
						: "hidden"
				}
			/>
			{recording && (
				<>
					<p
						aria-live="polite"
						className="whitespace-pre-wrap rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900"
					>
						{transcript ||
							(connected
								? "Live guide connected. Walk slowly through each room."
								: "Connecting live guide…")}
					</p>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (question.trim()) {
								sendText(question.trim());
								flushGuideTurn();
								addNote("user", question.trim());
								setQuestion("");
							}
						}}
						className="flex gap-2"
					>
						<input
							aria-label="Ask the live guide"
							value={question}
							onChange={(event) => setQuestion(event.target.value)}
							placeholder="Ask the live guide"
							className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
						/>
						<button
							type="submit"
							disabled={!connected || !question.trim()}
							className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-50"
						>
							Send
						</button>
					</form>
				</>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-700">
					{error}{" "}
					{recording && !connected && (
						<button
							type="button"
							onClick={() => void connect()}
							className="underline"
						>
							Retry live guide
						</button>
					)}
				</p>
			)}
		</section>
	);
}
