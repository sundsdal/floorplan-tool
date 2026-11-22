// @vitest-environment node
import { AnyNode } from "@pascal-app/core/schema";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ draft: vi.fn(), final: vi.fn() }));
vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		async getRequestHeaders() {
			return new Headers();
		}
	},
}));
vi.mock("@/lib/livekit-session", () => ({
	recordingPlaylist: () => ({
		bucket: "test",
		object: "captures/id/recording.m3u8",
	}),
	authorizeSession: () => true,
	authorizeReview: () => true,
	bearer: () => "token",
	stopRecording: async () => {},
	closeSession: async () => {},
}));
vi.mock("@/lib/livekit-media", () => ({
	draftRecording: mocks.draft,
	finalizeRecording: mocks.final,
	waitForFinalRecording: async () => {},
	RecordingNotReady: class extends Error {},
}));

import { POST as finalize } from "@/app/api/livekit/session/[sessionId]/finalize/route";
import { POST as decide } from "@/app/api/livekit/session/[sessionId]/scene/proposals/[proposalId]/route";
import { POST as submit } from "@/app/api/livekit/session/[sessionId]/scene/proposals/route";
import { POST as review } from "@/app/api/livekit/session/[sessionId]/scene/review/route";
import { GET } from "@/app/api/livekit/session/[sessionId]/scene/route";
import type { FloorplanState } from "@/lib/types";

const wall = (id: string, x: number) => ({
	id,
	start: { x, y: 0 },
	end: { x, y: 4 },
	length_m: 4,
	thickness_m: 0.1,
	height_m: 2.4,
});
const initial: FloorplanState = {
	walls: [wall("wall A", 0), wall("wall B", 4)],
	doors: [
		{
			id: "entry door",
			wall_id: "wall A",
			position_along_m: 2,
			width_m: 1,
			type: "standard",
		},
	],
	windows: [],
	rooms: [],
	dimensions: [],
	total_area_m2: 0,
};
const corrected: FloorplanState = {
	...initial,
	doors: [{ ...initial.doors[0], wall_id: "wall B" }],
};
let stored: string | undefined;
let generation: number;
const context = { params: Promise.resolve({ sessionId: "route-integration" }) };
function req(body: unknown) {
	return new Request("http://localhost/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
beforeEach(() => {
	stored = undefined;
	generation = 0;
	mocks.draft.mockReset();
	mocks.final.mockReset();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			if (options?.method === "POST") {
				if (
					new URL(url).searchParams.get("ifGenerationMatch") !==
					String(generation)
				)
					return new Response("", { status: 412 });
				stored = String(options.body);
				return Response.json({ generation: String(++generation) });
			}
			if (!stored) return new Response("", { status: 404 });
			if (url.includes("alt=media")) return new Response(stored);
			return Response.json({ generation: String(generation) });
		}),
	);
});
it("corrects a door, preserves unrelated walls and survives finalization and late writes", async () => {
	let response = await submit(
		req({ baseRevision: 0, requestId: "initial", floorplan: initial }),
		context,
	);
	expect(response.status).toBe(200);
	mocks.draft.mockResolvedValueOnce({
		floorplan: initial,
		unresolved: true,
		finding: "Door not visible",
		nextView: "Step back and show the doorway",
	});
	response = await review(
		req({
			baseRevision: 1,
			requestId: "blank",
			targetId: "entry door",
			startSeconds: 0,
			endSeconds: 2,
		}),
		context,
	);
	let { scene } = await response.json();
	expect(response.status).toBe(200);
	expect(scene.proposals).toHaveLength(1);
	expect(scene.finding).toBe("Door not visible");
	expect(scene.nextView).toBe("Step back and show the doorway");
	expect(scene.floorplan).toEqual(initial);
	mocks.draft.mockResolvedValueOnce({
		floorplan: {
			...corrected,
			walls: [...corrected.walls, wall("unrelated hallucination", 12)],
		},
		unresolved: false,
	});
	response = await review(
		req({
			baseRevision: 2,
			requestId: "reshoot",
			targetId: "entry door",
			startSeconds: 2,
			endSeconds: 4,
		}),
		context,
	);
	({ scene } = await response.json());
	expect(response.status).toBe(200);
	expect(scene.proposals[1].floorplan.walls).toEqual(initial.walls);
	expect(scene.finding).toBeUndefined();
	expect(scene.nextView).toBeUndefined();
	response = await submit(
		req({
			baseRevision: 3,
			requestId: "other",
			floorplan: {
				...initial,
				doors: [{ ...initial.doors[0], position_along_m: 1 }],
			},
		}),
		context,
	);
	expect(response.status).toBe(200);
	response = await decide(
		req({ baseRevision: 4, requestId: "accept", decision: "accept" }),
		{
			params: Promise.resolve({
				sessionId: "route-integration",
				proposalId: "reshoot",
			}),
		},
	);
	({ scene } = await response.json());
	expect(response.status).toBe(200);
	expect(scene.floorplan).toEqual(corrected);
	response = await decide(
		req({ baseRevision: 5, requestId: "dismiss", decision: "reject" }),
		{
			params: Promise.resolve({
				sessionId: "route-integration",
				proposalId: "other",
			}),
		},
	);
	expect(response.status).toBe(200);
	mocks.final.mockResolvedValue(initial);
	response = await finalize(req({}), context);
	expect(response.status).toBe(200);
	expect((await response.json()).floorplan).toEqual(corrected);
	response = await review(
		req({
			baseRevision: 7,
			requestId: "after-finish",
			startSeconds: 0,
			endSeconds: 10,
		}),
		context,
	);
	expect(response.status).toBe(409);
	response = await decide(
		req({ baseRevision: 7, requestId: "accept-final", decision: "accept" }),
		{
			params: Promise.resolve({
				sessionId: "route-integration",
				proposalId: "final-recording",
			}),
		},
	);
	expect(response.status).toBe(200);
	response = await submit(
		req({ baseRevision: 2, requestId: "late", floorplan: initial }),
		context,
	);
	expect(response.status).toBe(409);
	response = await GET(new Request("http://localhost/"), context);
	({ scene } = await response.json());
	expect(scene.floorplan).toEqual(initial);
	const nodes = Object.values(scene.nodes).map((node) => AnyNode.parse(node));
	const site = nodes.find((node) => node.type === "site");
	const building = nodes.find((node) => node.type === "building");
	const level = nodes.find((node) => node.type === "level");
	const door = nodes.find((node) => node.type === "door");
	expect(site?.children).toContain(building?.id);
	expect(building?.children).toContain(level?.id);
	const host = nodes.find(
		(node) => node.type === "wall" && node.metadata.sourceId === "wall A",
	);
	expect(door?.parentId).toBe(host?.id);
	expect(host && "children" in host ? host.children : undefined).toContain(
		door?.id,
	);
});

it("rejects oversized review windows and returns 425 for uncommitted recording", async () => {
	await submit(
		req({ baseRevision: 0, requestId: "initial", floorplan: initial }),
		context,
	);
	let response = await review(
		req({
			baseRevision: 1,
			requestId: "long",
			startSeconds: 0,
			endSeconds: 61,
		}),
		context,
	);
	expect(response.status).toBe(400);
	const { RecordingNotReady } = await import("@/lib/livekit-media");
	mocks.draft.mockRejectedValueOnce(new RecordingNotReady());
	response = await review(
		req({
			baseRevision: 1,
			requestId: "pending",
			startSeconds: 0,
			endSeconds: 30,
		}),
		context,
	);
	expect(response.status).toBe(425);
});

it("persists a gap and next view when the first draft has no geometry", async () => {
	const empty: FloorplanState = {
		walls: [],
		doors: [],
		windows: [],
		rooms: [],
		dimensions: [],
		total_area_m2: 0,
	};
	mocks.draft.mockResolvedValueOnce({
		floorplan: empty,
		unresolved: true,
		finding: "The doorway is outside the view.",
		nextView: "Pan right to the doorway.",
	});
	const response = await review(
		req({
			baseRevision: 0,
			requestId: "first",
			startSeconds: 0,
			endSeconds: 10,
		}),
		context,
	);
	expect(response.status).toBe(200);
	const { scene } = await response.json();
	expect(scene.revision).toBe(1);
	expect(scene.proposals).toHaveLength(0);
	expect(scene.finding).toBe("The doorway is outside the view.");
	expect(scene.nextView).toBe("Pan right to the doorway.");
	const saved = await GET(new Request("http://localhost/"), context);
	expect((await saved.json()).scene.nextView).toBe("Pan right to the doorway.");
	mocks.draft.mockResolvedValueOnce({ floorplan: initial, unresolved: false });
	const retry = await review(
		req({
			baseRevision: 1,
			requestId: "retry",
			startSeconds: 10,
			endSeconds: 20,
		}),
		context,
	);
	const retried = (await retry.json()).scene;
	expect(retried.floorplan).toEqual(initial);
	expect(retried.finding).toBeUndefined();
});
