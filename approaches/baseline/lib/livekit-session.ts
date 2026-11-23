import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
	AccessToken,
	AgentDispatchClient,
	EgressClient,
	type EgressInfo,
	EgressStatus,
	GCPUpload,
	RoomServiceClient,
	SegmentedFileOutput,
	SegmentedFileProtocol,
} from "livekit-server-sdk";

const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ttlSeconds = 24 * 60 * 60;
function config() {
	const {
		LIVEKIT_URL,
		LIVEKIT_API_KEY,
		LIVEKIT_API_SECRET,
		LIVEKIT_AGENT_NAME,
		LIVEKIT_GCS_BUCKET,
		LIVEKIT_GCS_CREDENTIALS,
		LIVEKIT_SESSION_SECRET,
	} = process.env;
	if (
		!LIVEKIT_URL ||
		!LIVEKIT_API_KEY ||
		!LIVEKIT_API_SECRET ||
		!LIVEKIT_AGENT_NAME ||
		!LIVEKIT_GCS_BUCKET ||
		!LIVEKIT_GCS_CREDENTIALS ||
		!LIVEKIT_SESSION_SECRET ||
		LIVEKIT_SESSION_SECRET.length < 32
	)
		throw new Error("LiveKit is not configured");
	return {
		url: LIVEKIT_URL,
		key: LIVEKIT_API_KEY,
		secret: LIVEKIT_API_SECRET,
		agent: LIVEKIT_AGENT_NAME,
		bucket: LIVEKIT_GCS_BUCKET,
		credentials: LIVEKIT_GCS_CREDENTIALS,
		sessionSecret: LIVEKIT_SESSION_SECRET,
	};
}
export function roomName(sessionId: string) {
	return `capture-${sessionId}`;
}
export function participantIdentity(sessionId: string) {
	return `capture-user-${sessionId}`;
}
export function recordingPlaylist(sessionId: string) {
	if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session");
	return {
		bucket: config().bucket,
		object: `captures/${sessionId}/recording.m3u8`,
	};
}
function capability(sessionId: string, scope: "session" | "review") {
	const payload = Buffer.from(
		JSON.stringify({
			sessionId,
			scope,
			exp: Math.floor(Date.now() / 1000) + ttlSeconds,
		}),
	).toString("base64url");
	const signature = createHmac("sha256", config().sessionSecret)
		.update(payload)
		.digest("base64url");
	return `${payload}.${signature}`;
}
function authorize(
	sessionId: string,
	token: string,
	scope: "session" | "review",
) {
	try {
		if (!SESSION_ID.test(sessionId) || token.length > 2048) return false;
		const parts = token.split(".");
		if (parts.length !== 2) return false;
		const expected = createHmac("sha256", config().sessionSecret)
			.update(parts[0])
			.digest();
		const actual = Buffer.from(parts[1], "base64url");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			return false;
		const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
		return (
			payload.sessionId === sessionId &&
			payload.scope === scope &&
			Number.isInteger(payload.exp) &&
			payload.exp > Date.now() / 1000
		);
	} catch {
		return false;
	}
}
export function authorizeReview(sessionId: string, token: string) {
	return authorize(sessionId, token, "review");
}
export function authorizeSession(sessionId: string, token: string) {
	return authorize(sessionId, token, "session");
}
export function bearer(request: Request) {
	return (
		/^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ??
		""
	);
}
function clients() {
	const c = config();
	return {
		c,
		room: new RoomServiceClient(c.url, c.key, c.secret),
		dispatch: new AgentDispatchClient(c.url, c.key, c.secret),
		egress: new EgressClient(c.url, c.key, c.secret),
	};
}
export type CaptureMode =
	| { mode: "inspection"; work: "male" | "slipe" }
	| { mode?: "floorplan" };

export async function createSession(options: CaptureMode = {}) {
	const { c, room, dispatch } = clients();
	const sessionId = randomUUID();
	const roomId = roomName(sessionId);
	const identity = participantIdentity(sessionId);
	await room.createRoom({
		name: roomId,
		emptyTimeout: 600,
		maxParticipants: 3,
	});
	try {
		await dispatch.createDispatch(roomId, c.agent, {
			metadata: JSON.stringify({
				sessionId,
				participantIdentity: identity,
				reviewToken: capability(sessionId, "review"),
				...(options.mode === "inspection" ? options : {}),
			}),
		});
		const access = new AccessToken(c.key, c.secret, {
			identity,
			ttl: ttlSeconds,
		});
		access.addGrant({
			room: roomId,
			roomJoin: true,
			canPublish: true,
			canSubscribe: true,
			canPublishData: true,
		});
		return {
			sessionId,
			roomName: roomId,
			participantIdentity: identity,
			serverUrl: c.url,
			token: await access.toJwt(),
			sessionToken: capability(sessionId, "session"),
			...(process.env.LIVEKIT_KEEPALIVE === "true" ? { keepalive: true } : {}),
		};
	} catch (error) {
		await room.deleteRoom(roomId).catch(() => {});
		throw error;
	}
}
const starts = new Map<
	string,
	Promise<{ egressId: string; startedAt: number | null }>
>();
function mediaStart(item: EgressInfo) {
	const start =
		item.segmentResults?.[0]?.startedAt ??
		(item.result?.case === "segments"
			? item.result.value.startedAt
			: BigInt(0));
	return Number(start / BigInt(1000000)) || null;
}
export async function startRecording(sessionId: string) {
	const existing = starts.get(sessionId);
	if (existing) return existing;
	const promise = startRecordingOnce(sessionId);
	starts.set(sessionId, promise);
	try {
		return await promise;
	} finally {
		starts.delete(sessionId);
	}
}
async function startRecordingOnce(sessionId: string) {
	const { c, egress } = clients();
	const existing = await egress.listEgress({ roomName: roomName(sessionId) });
	const active = existing.find((item) =>
		[EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE].includes(
			item.status,
		),
	);
	if (active)
		return {
			egressId: active.egressId,
			startedAt: mediaStart(active),
		};
	if (existing.length) throw new Error("Recording already ended");
	const prefix = `captures/${sessionId}`;
	const segments = new SegmentedFileOutput({
		protocol: SegmentedFileProtocol.HLS_PROTOCOL,
		filenamePrefix: `${prefix}/segment`,
		playlistName: `${prefix}/recording.m3u8`,
		livePlaylistName: `${prefix}/live.m3u8`,
		segmentDuration: 2,
		output: {
			case: "gcp",
			value: new GCPUpload({ bucket: c.bucket, credentials: c.credentials }),
		},
	});
	const item = await egress.startParticipantEgress(
		roomName(sessionId),
		participantIdentity(sessionId),
		{ segments },
	);
	return {
		egressId: item.egressId,
		startedAt: mediaStart(item),
	};
}
export async function stopRecording(sessionId: string) {
	const { egress } = clients();
	const items = await egress.listEgress({ roomName: roomName(sessionId) });
	if (!items.length) throw new Error("Recording not started");
	for (const item of items) {
		if (
			[EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE].includes(
				item.status,
			)
		)
			await egress.stopEgress(item.egressId);
		else if (
			item.status === EgressStatus.EGRESS_FAILED ||
			item.status === EgressStatus.EGRESS_ABORTED
		)
			throw new Error("Recording failed");
	}
}

export async function closeSession(sessionId: string) {
	const { room } = clients();
	await room.deleteRoom(roomName(sessionId));
}
