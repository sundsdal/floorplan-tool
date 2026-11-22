import { describe, expect, it } from "vitest";
import {
	evidenceSchema,
	type VideoEvidence,
	validateEvidenceGeometry,
} from "@/lib/evidence";
import type { FloorplanState } from "@/lib/types";

const evidence = (overrides: Partial<VideoEvidence> = {}): VideoEvidence => ({
	clips: [
		{
			start_s: 1,
			end_s: 4,
			room: "Kitchen",
			observation: "Window on north wall",
		},
	],
	gaps: ["Hallway connection is not visible"],
	room_bounds: [
		{
			room: "Kitchen",
			width_m: { min: 3, max: 4 },
			length_m: { min: 5, max: 6 },
		},
	],
	discrepancies: [],
	...overrides,
});

const floorplan = (
	room: Partial<FloorplanState["rooms"][number]> = {},
): FloorplanState => ({
	walls: [],
	doors: [],
	windows: [],
	dimensions: [],
	total_area_m2: 0,
	rooms: [
		{
			id: "room_1",
			name: "Kitchen",
			type: "kitchen",
			width_m: 3,
			length_m: 5,
			height_m: 2.7,
			polygon: [
				[0, 0],
				[3, 0],
				[3, 5],
				[0, 5],
			],
			walls: [],
			...room,
		},
	],
});

describe("video evidence", () => {
	it("parses valid timestamped observations and defaults optional result fields", () => {
		const parsed = evidenceSchema.parse({
			clips: [
				{
					start_s: 0,
					end_s: 2.5,
					room: "Entry",
					observation: "Doorway visible",
				},
			],
			gaps: [],
		});

		expect(parsed.room_bounds).toEqual([]);
		expect(parsed.discrepancies).toEqual([]);
	});

	it("rejects reversed timestamps and invalid measurement intervals", () => {
		expect(() =>
			evidenceSchema.parse({
				clips: [
					{ start_s: 3, end_s: 2, room: "Entry", observation: "Doorway" },
				],
				gaps: [],
			}),
		).toThrow();
		expect(() =>
			evidenceSchema.parse({
				clips: [],
				gaps: [],
				room_bounds: [
					{
						room: "Entry",
						width_m: { min: 4, max: 3 },
						length_m: { min: 2, max: 3 },
					},
				],
			}),
		).toThrow();
	});

	it("accepts case-insensitive room matching and swapped width/length orientation", () => {
		expect(
			validateEvidenceGeometry(
				evidence(),
				floorplan({
					name: "kitchen",
					polygon: [
						[0, 0],
						[5, 0],
						[5, 3],
						[0, 3],
					],
				}),
			),
		).toEqual([]);
	});

	it("accepts optional height ranges and scale references", () => {
		const parsed = evidenceSchema.parse({
			clips: [],
			gaps: [],
			room_bounds: [
				{
					room: "Kitchen",
					width_m: { min: 3, max: 4 },
					length_m: { min: 5, max: 6 },
					height_m: { min: 2.5, max: 3 },
					scale_reference: "standard door",
				},
			],
		});
		expect(parsed.room_bounds[0]).toMatchObject({
			height_m: { min: 2.5, max: 3 },
			scale_reference: "standard door",
		});
	});

	it("compares diagonal room polygons without inflating their extents and checks ceiling height", () => {
		const angle = Math.PI / 4;
		const rotate = (x: number, y: number): [number, number] => [
			x * Math.cos(angle) - y * Math.sin(angle),
			x * Math.sin(angle) + y * Math.cos(angle),
		];
		const polygon = [rotate(0, 0), rotate(3, 0), rotate(3, 5), rotate(0, 5)];
		expect(
			validateEvidenceGeometry(evidence(), floorplan({ polygon })),
		).toEqual([]);

		const withHeight = evidence({
			room_bounds: [
				{ ...evidence().room_bounds[0], height_m: { min: 3, max: 3.5 } },
			],
		});
		const warnings = validateEvidenceGeometry(
			withHeight,
			floorplan({ polygon, height_m: 2.7 }),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("ceiling height");
	});

	it("reports unmatched rooms, missing polygons, and dimensions outside the estimated ranges", () => {
		const unmatched = validateEvidenceGeometry(
			evidence(),
			floorplan({ name: "Dining room" }),
		);
		expect(unmatched[0]).toContain("No labeled room matches");

		const noPolygon = validateEvidenceGeometry(
			evidence(),
			floorplan({ polygon: [] }),
		);
		expect(noPolygon[0]).toContain("no room polygon");

		const outside = validateEvidenceGeometry(
			evidence(),
			floorplan({
				polygon: [
					[0, 0],
					[8, 0],
					[8, 9],
					[0, 9],
				],
			}),
		);
		expect(outside[0]).toContain("video estimates");
	});
});
