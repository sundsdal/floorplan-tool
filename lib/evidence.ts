import { z } from "zod";
import type { FloorplanState } from "./types";

const rangeSchema = z
	.object({ min: z.number().positive(), max: z.number().positive() })
	.refine((range) => range.min <= range.max);

export const evidenceSchema = z.object({
	clips: z.array(
		z
			.object({
				start_s: z.number().nonnegative(),
				end_s: z.number().nonnegative(),
				room: z.string().min(1),
				observation: z.string().min(1),
			})
			.refine((clip) => clip.start_s <= clip.end_s),
	),
	gaps: z.array(z.string()),
	room_bounds: z
		.array(
			z.object({
				room: z.string().min(1),
				width_m: rangeSchema,
				length_m: rangeSchema,
				height_m: rangeSchema.optional(),
				scale_reference: z.string().optional(),
			}),
		)
		.default([]),
	discrepancies: z.array(z.string()).default([]),
});

export type VideoEvidence = z.infer<typeof evidenceSchema>;

/** Compare approximate, orientation-independent room extents against video estimates. */
export function validateEvidenceGeometry(
	evidence: VideoEvidence,
	floorplan: FloorplanState,
): string[] {
	const discrepancies: string[] = [];
	for (const bound of evidence.room_bounds) {
		const room = floorplan.rooms.find(
			(candidate) =>
				candidate.name.trim().toLowerCase() === bound.room.trim().toLowerCase(),
		);
		if (!room) {
			discrepancies.push(
				`No labeled room matches the video estimate for ${bound.room}.`,
			);
			continue;
		}
		if (
			bound.height_m &&
			(room.height_m < bound.height_m.min || room.height_m > bound.height_m.max)
		) {
			discrepancies.push(
				`${room.name} ceiling height is ${room.height_m.toFixed(1)} m in the plan; the video estimate is ${bound.height_m.min}–${bound.height_m.max} m.`,
			);
		}
		if (room.polygon.length < 3) {
			discrepancies.push(
				`${room.name} has no room polygon to compare with the video estimate.`,
			);
			continue;
		}
		// A minimum-area bounding rectangle avoids inflating diagonal rooms.
		let bestArea = Number.POSITIVE_INFINITY;
		let actual = [0, 0];
		for (let i = 0; i < room.polygon.length; i++) {
			const [x1, y1] = room.polygon[i];
			const [x2, y2] = room.polygon[(i + 1) % room.polygon.length];
			const angle = Math.atan2(y2 - y1, x2 - x1);
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			const xs = room.polygon.map(([x, y]) => x * cos + y * sin);
			const ys = room.polygon.map(([x, y]) => -x * sin + y * cos);
			const dimensions = [
				Math.max(...xs) - Math.min(...xs),
				Math.max(...ys) - Math.min(...ys),
			].sort((a, b) => a - b);
			const area = dimensions[0] * dimensions[1];
			if (area < bestArea) {
				bestArea = area;
				actual = dimensions;
			}
		}
		const ranges = [bound.width_m, bound.length_m];
		const fits = (
			first: (typeof ranges)[number],
			second: (typeof ranges)[number],
		) =>
			actual[0] >= first.min &&
			actual[0] <= first.max &&
			actual[1] >= second.min &&
			actual[1] <= second.max;
		if (!fits(ranges[0], ranges[1]) && !fits(ranges[1], ranges[0])) {
			discrepancies.push(
				`${room.name} measures approximately ${actual[0].toFixed(1)} × ${actual[1].toFixed(1)} m in the plan; video estimates are ${bound.width_m.min}–${bound.width_m.max} m and ${bound.length_m.min}–${bound.length_m.max} m.`,
			);
		}
	}
	return discrepancies;
}
