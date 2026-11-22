import { createHash } from "node:crypto";
import {
	BuildingNode,
	DoorNode,
	LevelNode,
	SiteNode,
	WallNode,
	WindowNode,
} from "@pascal-app/core/schema";
import { GoogleAuth } from "google-auth-library";
import { recordingPlaylist } from "./livekit-session";
import { planSchema } from "./managed-results";
import type { FloorplanState } from "./types";

export type Interval = {
	startSeconds: number;
	endSeconds: number;
	targetId?: string;
};
export type Proposal = {
	id: string;
	floorplan: FloorplanState;
	status: "pending" | "accepted" | "rejected";
	evidence: Interval[];
	baseRevision: number;
	sourcePlan: string;
	targetId?: string;
};
export type Scene = {
	revision: number;
	floorplan: FloorplanState;
	nodes: Record<string, unknown>;
	proposals: Proposal[];
	evidence: Interval[];
	requests: string[];
	elementEvidence: Record<string, Interval[]>;
	finding?: string;
	nextView?: string;
};
const emptyPlan: FloorplanState = {
	walls: [],
	doors: [],
	windows: [],
	rooms: [],
	dimensions: [],
	total_area_m2: 0,
};
export class SceneConflict extends Error {}
export function validatePlan(input: unknown): FloorplanState {
	const plan = planSchema.parse(input);
	const ids = [
		...plan.walls,
		...plan.doors,
		...plan.windows,
		...plan.rooms,
		...plan.dimensions,
	].map((x) => x.id);
	if (new Set(ids).size !== ids.length)
		throw new Error("Duplicate element IDs");
	const walls = new Map(plan.walls.map((w) => [w.id, w]));
	for (const wall of plan.walls)
		if (
			Math.abs(
				Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) -
					wall.length_m,
			) > 0.05
		)
			throw new Error("Invalid wall length");
	for (const opening of [...plan.doors, ...plan.windows]) {
		const wall = walls.get(opening.wall_id);
		if (
			!wall ||
			opening.position_along_m - opening.width_m / 2 < 0 ||
			opening.position_along_m + opening.width_m / 2 > wall.length_m
		)
			throw new Error("Invalid opening");
	}
	for (const room of plan.rooms)
		if (room.walls.some((id) => !walls.has(id)))
			throw new Error("Invalid room walls");
	return plan;
}
export function nodesFor(plan: FloorplanState): Record<string, unknown> {
	const idFor = (kind: string, id: string) =>
		`${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
	const siteId = "site_capture";
	const buildingId = "building_capture";
	const levelId = "level_capture";
	const nodes: Record<string, unknown> = {};
	const wallIds = plan.walls.map((w) => idFor("wall", w.id));
	nodes[siteId] = SiteNode.parse({ id: siteId, children: [buildingId] });
	nodes[buildingId] = BuildingNode.parse({
		id: buildingId,
		parentId: siteId,
		children: [levelId],
	});
	nodes[levelId] = LevelNode.parse({
		id: levelId,
		parentId: buildingId,
		children: wallIds,
	});
	for (const wall of plan.walls) {
		const id = idFor("wall", wall.id);
		const doors = plan.doors.filter((x) => x.wall_id === wall.id);
		const windows = plan.windows.filter((x) => x.wall_id === wall.id);
		nodes[id] = WallNode.parse({
			id,
			parentId: levelId,
			metadata: { sourceId: wall.id },
			children: [
				...doors.map((x) => idFor("door", x.id)),
				...windows.map((x) => idFor("window", x.id)),
			],
			start: [wall.start.x, wall.start.y],
			end: [wall.end.x, wall.end.y],
			thickness: wall.thickness_m,
			height: wall.height_m,
		});
		for (const door of doors) {
			const child = idFor("door", door.id);
			nodes[child] = DoorNode.parse({
				id: child,
				parentId: id,
				metadata: { sourceId: door.id },
				width: door.width_m,
				position: [door.position_along_m, 1.05, 0],
			});
		}
		for (const window of windows) {
			const child = idFor("window", window.id);
			nodes[child] = WindowNode.parse({
				id: child,
				parentId: id,
				metadata: { sourceId: window.id },
				width: window.width_m,
				position: [window.position_along_m, window.sill_height_m + 0.75, 0],
			});
		}
	}
	return nodes;
}
function initial(): Scene {
	return {
		revision: 0,
		floorplan: structuredClone(emptyPlan),
		nodes: {},
		proposals: [],
		evidence: [],
		requests: [],
		elementEvidence: {},
	};
}
const auth = new GoogleAuth({
	scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
});
function location(sessionId: string) {
	const { bucket, object } = recordingPlaylist(sessionId);
	return { bucket, object: object.replace(/recording\.m3u8$/, "scene.json") };
}
export async function readScene(
	sessionId: string,
): Promise<{ scene: Scene; generation: string }> {
	const { bucket, object } = location(sessionId);
	const headers = await auth.getRequestHeaders();
	const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;
	const meta = await fetch(base, { headers });
	if (meta.status === 404) return { scene: initial(), generation: "0" };
	if (!meta.ok) throw new Error("Scene read failed");
	const { generation } = await meta.json();
	const body = await fetch(
		`${base}?alt=media&generation=${encodeURIComponent(generation)}`,
		{ headers },
	);
	if (!body.ok) throw new Error("Scene read failed");
	return { scene: await body.json(), generation };
}
async function writeScene(sessionId: string, scene: Scene, generation: string) {
	const { bucket, object } = location(sessionId);
	const headers = new Headers(await auth.getRequestHeaders());
	headers.set("Content-Type", "application/json");
	const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=${encodeURIComponent(generation)}`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(scene),
	});
	if (response.status === 412) throw new SceneConflict("Scene changed");
	if (!response.ok) throw new Error("Scene write failed");
}
export async function updateScene(
	sessionId: string,
	baseRevision: number,
	requestId: string,
	apply: (scene: Scene) => void,
) {
	const { scene, generation } = await readScene(sessionId);
	if (scene.requests.includes(requestId)) return scene;
	if (scene.revision !== baseRevision) throw new SceneConflict("Scene changed");
	apply(scene);
	scene.nodes = nodesFor(scene.floorplan);
	scene.revision++;
	scene.requests.push(requestId);
	await writeScene(sessionId, scene, generation);
	return scene;
}
export function propose(
	scene: Scene,
	id: string,
	floorplan: FloorplanState,
	evidence: Interval[],
	targetId?: string,
) {
	const proposal: Proposal = {
		id,
		baseRevision: scene.revision + 1,
		sourcePlan: JSON.stringify(scene.floorplan),
		targetId,
		floorplan: validatePlan(floorplan),
		status: "pending",
		evidence,
	};
	if (
		scene.proposals.length === 0 &&
		!scene.floorplan.walls.length &&
		!scene.floorplan.doors.length &&
		!scene.floorplan.windows.length &&
		!scene.floorplan.rooms.length &&
		!scene.floorplan.dimensions.length
	) {
		scene.floorplan = proposal.floorplan;
		proposal.status = "accepted";
		scene.evidence.push(...evidence);
		for (const item of [
			...scene.floorplan.walls,
			...scene.floorplan.doors,
			...scene.floorplan.windows,
			...scene.floorplan.rooms,
			...scene.floorplan.dimensions,
		])
			scene.elementEvidence[item.id] = evidence;
	} else if (!targetId && evidence.length) {
		const accepted = structuredClone(scene.floorplan);
		const ids = new Set(
			[
				...accepted.walls,
				...accepted.doors,
				...accepted.windows,
				...accepted.rooms,
				...accepted.dimensions,
			].map((x) => x.id),
		);
		const same = (a: { x: number; y: number }, b: { x: number; y: number }) =>
			Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
		const anchors = accepted.walls.flatMap((w) => [w.start, w.end]);
		const added: string[] = [];
		for (const wall of proposal.floorplan.walls) {
			if (
				!ids.has(wall.id) &&
				anchors.some((p) => same(p, wall.start) || same(p, wall.end))
			) {
				accepted.walls.push(wall);
				ids.add(wall.id);
				added.push(wall.id);
			}
		}
		// Opening positions are measured from the wall's start, so its geometry
		// and direction must match the accepted host before applying them.
		const hosts = new Set(
			proposal.floorplan.walls
				.filter((wall) => {
					const host = scene.floorplan.walls.find((w) => w.id === wall.id);
					return (
						host &&
						host.start.x === wall.start.x &&
						host.start.y === wall.start.y &&
						host.end.x === wall.end.x &&
						host.end.y === wall.end.y &&
						host.length_m === wall.length_m &&
						host.thickness_m === wall.thickness_m &&
						host.height_m === wall.height_m
					);
				})
				.map((wall) => wall.id),
		);
		for (const door of proposal.floorplan.doors)
			if (!ids.has(door.id) && hosts.has(door.wall_id)) {
				accepted.doors.push(door);
				ids.add(door.id);
				added.push(door.id);
			}
		for (const window of proposal.floorplan.windows)
			if (!ids.has(window.id) && hosts.has(window.wall_id)) {
				accepted.windows.push(window);
				ids.add(window.id);
				added.push(window.id);
			}
		if (added.length) {
			scene.floorplan = validatePlan(accepted);
			for (const id of added) scene.elementEvidence[id] = evidence;
		}
		proposal.sourcePlan = JSON.stringify(scene.floorplan);
	}
	if (
		proposal.status === "pending" &&
		JSON.stringify(proposal.floorplan) === JSON.stringify(scene.floorplan)
	)
		return;
	scene.proposals.push(proposal);
}

/** Preserve the accepted plan and present a full-recording analysis for review. */
export async function reconcileFinalScene(
	sessionId: string,
	floorplan: FloorplanState,
	sourcePlan: FloorplanState,
) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const { scene } = await readScene(sessionId);
		if (scene.requests.includes("final-recording")) return scene;
		if (JSON.stringify(scene.floorplan) !== JSON.stringify(sourcePlan))
			throw new SceneConflict("Scene changed during final analysis");
		try {
			return await updateScene(
				sessionId,
				scene.revision,
				"final-recording",
				(s) => {
					if (JSON.stringify(s.floorplan) !== JSON.stringify(sourcePlan))
						throw new SceneConflict("Scene changed during final analysis");
					propose(s, "final-recording", floorplan, []);
				},
			);
		} catch (error) {
			if (!(error instanceof SceneConflict) || attempt === 2) throw error;
		}
	}
	throw new SceneConflict("Scene changed");
}

/** Limit a targeted revision to the selected element; unrelated geometry remains accepted. */
export function scopedPlan(
	existing: FloorplanState,
	candidate: FloorplanState,
	targetId?: string,
): FloorplanState {
	if (!targetId) return candidate;
	const result = structuredClone(existing);
	const kinds = ["walls", "doors", "windows", "rooms", "dimensions"] as const;
	for (const kind of kinds) {
		const index = result[kind].findIndex((item) => item.id === targetId);
		if (index < 0) continue;
		const replacement = candidate[kind].find((item) => item.id === targetId);
		if (!replacement) throw new Error("Invalid target proposal");
		(result[kind] as Array<typeof replacement>)[index] = replacement;
		return validatePlan(result);
	}
	throw new Error("Invalid target");
}
