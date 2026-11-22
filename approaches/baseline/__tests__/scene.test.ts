// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

import {
	propose,
	readScene,
	reconcileFinalScene,
	SceneConflict,
	updateScene,
	validatePlan,
} from "@/lib/scene";

const plan = {
	walls: [
		{
			id: "wall_1",
			start: { x: 0, y: 0 },
			end: { x: 3, y: 0 },
			length_m: 3,
			thickness_m: 0.1,
			height_m: 2.4,
		},
	],
	doors: [],
	windows: [],
	rooms: [],
	dimensions: [],
	total_area_m2: 0,
};
let stored: string | undefined;
let generation = 0;
beforeEach(() => {
	stored = undefined;
	generation = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			if (options?.method === "POST") {
				const match = new URL(url).searchParams.get("ifGenerationMatch");
				if (match !== String(generation))
					return new Response("", { status: 412 });
				stored = String(options.body);
				generation++;
				return Response.json({ generation: String(generation) });
			}
			if (!stored) return new Response("", { status: 404 });
			if (url.includes("alt=media")) return new Response(stored);
			return Response.json({ generation: String(generation) });
		}),
	);
});
describe("scene persistence", () => {
	it("persists Pascal wall nodes, rejects stale revisions, and deduplicates requests", async () => {
		const scene = await updateScene("id", 0, "first", (s) =>
			propose(s, "first", plan, []),
		);
		expect(
			Object.values(scene.nodes).find(
				(n) =>
					typeof n === "object" &&
					n !== null &&
					"type" in n &&
					n.type === "wall",
			),
		).toMatchObject({
			type: "wall",
			start: [0, 0],
			end: [3, 0],
		});
		expect((await readScene("id")).scene.floorplan).toEqual(plan);
		await expect(
			updateScene("id", 0, "other", () => {}),
		).rejects.toBeInstanceOf(SceneConflict);
		expect(
			(
				await updateScene("id", 0, "first", () => {
					throw new Error("duplicate applied");
				})
			).revision,
		).toBe(1);
	});
	it("keeps an accepted plan when a new proposal arrives", async () => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const changed = {
			...plan,
			walls: [{ ...plan.walls[0], end: { x: 4, y: 0 }, length_m: 4 }],
		};
		const scene = await updateScene("id", 1, "second", (s) =>
			propose(s, "second", changed, []),
		);
		expect(scene.floorplan).toEqual(plan);
		expect(scene.proposals[1].status).toBe("pending");
	});
	it("rejects openings outside their wall", () => {
		expect(() =>
			validatePlan({
				...plan,
				doors: [
					{
						id: "door_1",
						wall_id: "wall_1",
						position_along_m: 2.9,
						width_m: 1,
						type: "standard",
					},
				],
			}),
		).toThrow("Invalid opening");
	});
	it("automatically adds only walls anchored to an accepted endpoint", async () => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const anchored = {
			...plan.walls[0],
			id: "new",
			start: { x: 3, y: 0 },
			end: { x: 3, y: 2 },
			length_m: 2,
		};
		const unanchored = {
			...anchored,
			id: "unanchored",
			start: { x: 9, y: 0 },
			end: { x: 9, y: 2 },
		};
		const candidate = { ...plan, walls: [...plan.walls, anchored, unanchored] };
		const scene = await updateScene("id", 1, "second", (s) =>
			propose(s, "second", candidate, [{ startSeconds: 0, endSeconds: 1 }]),
		);
		expect(scene.floorplan.walls.map((w) => w.id)).toEqual(["wall_1", "new"]);
		expect(scene.elementEvidence.new).toHaveLength(1);
		expect(scene.proposals[1].status).toBe("pending");
	});
	it.each([
		["reversed", { start: { x: 3, y: 0 }, end: { x: 0, y: 0 } }],
		["extended", { end: { x: 4, y: 0 }, length_m: 4 }],
		["thicker", { thickness_m: 0.2 }],
		["taller", { height_m: 3 }],
	])("keeps openings on a %s host wall pending", async (_name, changes) => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const candidate = {
			...plan,
			walls: [{ ...plan.walls[0], ...changes }],
			doors: [
				{
					id: "door_1",
					wall_id: "wall_1",
					position_along_m: 1,
					width_m: 1,
					type: "standard",
				},
			],
			windows: [
				{
					id: "window_1",
					wall_id: "wall_1",
					position_along_m: 2,
					width_m: 1,
					sill_height_m: 1,
				},
			],
		};
		const scene = await updateScene("id", 1, "second", (s) =>
			propose(s, "second", candidate, [{ startSeconds: 0, endSeconds: 1 }]),
		);
		expect(scene.floorplan).toEqual(plan);
		expect(scene.proposals[1]).toMatchObject({
			status: "pending",
			floorplan: candidate,
		});
		expect(scene.elementEvidence.door_1).toBeUndefined();
		expect(scene.elementEvidence.window_1).toBeUndefined();
	});
	it("automatically adds openings when the accepted host geometry is unchanged", async () => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const candidate = {
			...plan,
			doors: [
				{
					id: "door_1",
					wall_id: "wall_1",
					position_along_m: 1,
					width_m: 1,
					type: "standard",
				},
			],
			windows: [
				{
					id: "window_1",
					wall_id: "wall_1",
					position_along_m: 2,
					width_m: 1,
					sill_height_m: 1,
				},
			],
		};
		const scene = await updateScene("id", 1, "second", (s) =>
			propose(s, "second", candidate, [{ startSeconds: 0, endSeconds: 1 }]),
		);
		expect(scene.floorplan).toEqual(candidate);
		expect(scene.elementEvidence.door_1).toHaveLength(1);
		expect(scene.elementEvidence.window_1).toHaveLength(1);
		expect(scene.proposals).toHaveLength(1);
	});
	it("rejects final analysis based on a superseded accepted plan", async () => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const changed = {
			...plan,
			walls: [{ ...plan.walls[0], end: { x: 4, y: 0 }, length_m: 4 }],
		};
		await updateScene("id", 1, "edit", (s) => {
			s.floorplan = changed;
		});
		await expect(reconcileFinalScene("id", plan, plan)).rejects.toBeInstanceOf(
			SceneConflict,
		);
		expect((await readScene("id")).scene.floorplan).toEqual(changed);
	});
	it("does not retain a proposal for anchored additions already applied", async () => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const wall = {
			...plan.walls[0],
			id: "added",
			start: { x: 3, y: 0 },
			end: { x: 3, y: 2 },
			length_m: 2,
		};
		const scene = await updateScene("id", 1, "added", (s) =>
			propose(s, "added", { ...plan, walls: [...plan.walls, wall] }, [
				{ startSeconds: 0, endSeconds: 2 },
			]),
		);
		expect(scene.floorplan.walls).toHaveLength(2);
		expect(scene.proposals).toHaveLength(1);
	});
	it("records finish without adding a proposal when final analysis is unchanged", async () => {
		await updateScene("id", 0, "first", (s) => propose(s, "first", plan, []));
		const source = (await readScene("id")).scene.floorplan;
		const scene = await reconcileFinalScene("id", plan, source);
		expect(scene.proposals).toHaveLength(1);
		expect(scene.requests).toContain("final-recording");
	});
});
