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
	private closing?: Promise<void>;
	private recordingRequest?: Promise<number | null>;
	private cancelRetry?: () => void;
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
				if (this.closed) return;
				if (participant.kind === ParticipantKind.AGENT)
					this.handlers.status(true);
				void this.sendRecordingStart();
			});
			this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
				if (this.closed) return;
				if (participant.kind === ParticipantKind.AGENT)
					this.handlers.status(false);
			});
			this.room.on(RoomEvent.Reconnected, () => {
				void this.sendRecordingStart();
			});
			this.room.on(
				RoomEvent.DataReceived,
				(payload, _participant, _kind, topic) => {
					if (this.closed || topic !== "floorplan.finding") return;
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
	private startRecording(): Promise<number | null> {
		if (this.closed) return Promise.resolve(null);
		const request = this.requestRecording();
		this.recordingRequest = request;
		void request
			.finally(() => {
				if (this.recordingRequest === request)
					this.recordingRequest = undefined;
			})
			.catch(() => {});
		return request;
	}
	private async requestRecording(): Promise<number | null> {
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
			if (this.closed) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.cancelRetry = undefined;
					resolve();
				}, 2000);
				this.cancelRetry = () => {
					clearTimeout(timer);
					this.cancelRetry = undefined;
					resolve();
				};
			});
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
		await this.close().catch(() => {});
		// A recording start already sent to the server must finish before the
		// finalization request, or it could create an egress after finalization.
		await this.recordingRequest?.catch(() => {});
		const response = await this.request(
			`/api/livekit/session/${encodeURIComponent(this.session.sessionId)}/finalize`,
			this.session.sessionToken,
		);
		return response.text();
	}
	close() {
		if (this.closing) return this.closing;
		this.closed = true;
		this.cancelRetry?.();
		this.handlers.preview(undefined);
		this.handlers.status(false);
		for (const publication of this.room.localParticipant.trackPublications.values()) {
			publication.track?.stop();
		}
		this.closing = (async () => {
			try {
				await this.room.disconnect();
			} finally {
				await AudioSession.stopAudioSession();
			}
		})();
		return this.closing;
	}
}
