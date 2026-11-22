import { z } from "zod";
import type { FloorplanState } from "./types";

export { renderSVG } from "./svg";
export * from "./types";

const finite = z.number().finite();
const positive = finite.positive();
const id = z.string().trim().min(1).max(200);
const point = z.object({ x: finite, y: finite }).strict();
const pair = z.tuple([finite, finite]);
export const planSchema = z
	.object({
		walls: z
			.array(
				z
					.object({
						id,
						start: point,
						end: point,
						thickness_m: positive,
						height_m: positive,
						length_m: positive,
					})
					.strict(),
			)
			.max(1000),
		doors: z
			.array(
				z
					.object({
						id,
						wall_id: id,
						position_along_m: finite.nonnegative(),
						width_m: positive,
						type: z.enum(["standard", "sliding", "opening"]),
					})
					.strict(),
			)
			.max(1000),
		windows: z
			.array(
				z
					.object({
						id,
						wall_id: id,
						position_along_m: finite.nonnegative(),
						width_m: positive,
						sill_height_m: finite.nonnegative(),
					})
					.strict(),
			)
			.max(1000),
		rooms: z
			.array(
				z
					.object({
						id,
						name: id,
						type: z.enum([
							"bedroom",
							"kitchen",
							"bathroom",
							"living_room",
							"dining_room",
							"hallway",
							"closet",
							"balcony",
							"office",
							"laundry",
							"garage",
							"basement",
							"stairs",
							"attic",
							"other",
						]),
						width_m: positive,
						length_m: positive,
						height_m: positive,
						polygon: z.array(pair).min(3).max(1000),
						walls: z.array(id),
						label_point: pair.optional(),
					})
					.strict(),
			)
			.max(500),
		dimensions: z
			.array(z.object({ id, start: point, end: point, label: id }).strict())
			.max(1000),
		total_area_m2: finite.nonnegative(),
	})
	.strict();

const documentSchema = z
	.object({
		version: z.literal(1),
		source: z.enum(["video", "roomplan"]),
		floorplan: planSchema,
		warnings: z.array(z.string().max(2000)).max(1000),
	})
	.strict();
export type FloorplanDocument = z.infer<typeof documentSchema>;
export function parseDocument(value: unknown): FloorplanDocument {
	const doc = documentSchema.parse(value);
	const { walls, doors, windows, rooms } = doc.floorplan;
	const ids = new Set(walls.map((wall) => wall.id));
	if (
		ids.size !== walls.length ||
		[...doors, ...windows].some((item) => !ids.has(item.wall_id)) ||
		rooms.some((room) => room.walls.some((id) => !ids.has(id)))
	)
		throw new Error("Invalid wall reference in floorplan");
	return doc;
}
export function createDocument(
	floorplan: FloorplanState,
	source: FloorplanDocument["source"],
): FloorplanDocument {
	return parseDocument({ version: 1, source, floorplan, warnings: [] });
}
