import { AudioSession } from "@livekit/react-native";
import {
	type LocalVideoTrack,
	ParticipantKind,
	Room,
	RoomEvent,
} from "livekit-client";

type Session = {
	sessionId: string;
	serverUrl: string;
	token: string;
	sessionToken: string;
};
type Handlers = {
	status: (connected: boolean, error?: string) => void;
	preview: (track: LocalVideoTrack | undefined) => void;
	transcript: (text: string) => void;
	finding: (text: string) => void;
};

export class LiveGuide {
	private room = new Room();
	private session?: Session;
	private closed = false;
	private recordingStartedAt?: number;
	constructor(
		private base: string,
		private handlers: Handlers,
	) {}
	private async request(path: string, sessionToken?: string) {
		const response = await fetch(`${this.base}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
			},
			body: "{}",
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(detail || `Request failed (${response.status}).`);
		}
		return response;
	}
	async connect() {
		try {
			this.session = (await (
				await this.request("/api/livekit/session")
			).json()) as Session;
			if (this.closed) return;
			this.room.on(RoomEvent.Disconnected, () => {
				if (!this.closed)
					this.handlers.status(
						false,
						"The walkthrough disconnected. Please finish or start again.",
					);
			});
			this.room.on(RoomEvent.ParticipantConnected, (participant) => {
				if (participant.kind === ParticipantKind.AGENT)
					this.handlers.status(true);
				void this.sendRecordingStart();
			});
			this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
				if (participant.kind === ParticipantKind.AGENT)
					this.handlers.status(false);
			});
			this.room.on(RoomEvent.Reconnected, () => {
				void this.sendRecordingStart();
			});
			this.room.on(
				RoomEvent.DataReceived,
				(payload, _participant, _kind, topic) => {
					if (topic !== "floorplan.finding") return;
					try {
						const value = JSON.parse(new TextDecoder().decode(payload));
						this.handlers.finding(
							[value.finding, value.nextView].filter(Boolean).join("\n"),
						);
					} catch {
						/* Ignore malformed optional findings. */
					}
				},
			);
			this.room.registerTextStreamHandler(
				"lk.transcription",
				(reader, participant) => {
					if (participant.identity === this.room.localParticipant.identity)
						return;
					void reader
						.readAll()
						.then((text) => {
							if (
								!this.closed &&
								reader.info.attributes?.["lk.transcription_final"] !== "false"
							)
								this.handlers.transcript(text);
						})
						.catch(() => {});
				},
			);
			await AudioSession.startAudioSession();
			if (this.closed) {
				await AudioSession.stopAudioSession();
				return;
			}
			await this.room.connect(this.session.serverUrl, this.session.token);
			if (this.closed) {
				await this.room.disconnect();
				return;
			}
			const camera = await this.room.localParticipant.setCameraEnabled(true, {
				facingMode: "environment",
			});
			await this.room.localParticipant.setMicrophoneEnabled(true);
			if (this.closed) {
				await this.room.disconnect();
				return;
			}
			this.handlers.preview(camera?.track as LocalVideoTrack | undefined);
			await this.startRecording();
			void this.publishRecordingStart();
			if (!this.closed)
				this.handlers.status(
					Array.from(this.room.remoteParticipants.values()).some(
						(participant) => participant.kind === ParticipantKind.AGENT,
					),
				);
		} catch (error) {
			await this.close();
			throw error;
		}
	}
	private async startRecording(): Promise<number | null> {
		if (!this.session) return null;
		const response = await this.request(
			`/api/livekit/session/${encodeURIComponent(this.session.sessionId)}/recording`,
			this.session.sessionToken,
		);
		const recording = (await response.json()) as { startedAt: number | null };
		return recording.startedAt || null;
	}
	private async publishRecordingStart() {
		for (let attempt = 0; attempt < 20 && !this.closed; attempt++) {
			try {
				const startedAt = await this.startRecording();
				if (startedAt && !this.closed) {
					this.recordingStartedAt = startedAt;
					await this.sendRecordingStart();
					return;
				}
			} catch {
				/* Retry while the recording starts. */
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		if (!this.closed)
			this.handlers.finding(
				"Timestamped geometry review is unavailable for this recording.",
			);
	}

	private async sendRecordingStart() {
		if (!this.recordingStartedAt || this.closed) return;
		try {
			await this.room.localParticipant.publishData(
				new TextEncoder().encode(
					JSON.stringify({ startedAt: this.recordingStartedAt }),
				),
				{ reliable: true, topic: "floorplan.recording" },
			);
		} catch {
			/* Reconnection will retry. */
		}
	}

	async sendText(text: string) {
		await this.room.localParticipant.sendText(text, { topic: "lk.chat" });
	}
	async finalize() {
		if (!this.session)
			throw new Error("The walkthrough session has not started.");
		const response = await this.request(
			`/api/livekit/session/${encodeURIComponent(this.session.sessionId)}/finalize`,
			this.session.sessionToken,
		);
		return response.text();
	}
	async close() {
		this.closed = true;
		this.handlers.preview(undefined);
		this.handlers.status(false);
		await this.room.disconnect();
		await AudioSession.stopAudioSession();
	}
}
