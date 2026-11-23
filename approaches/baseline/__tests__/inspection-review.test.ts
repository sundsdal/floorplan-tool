import { describe, expect, it } from "vitest";
import {
	inspectionFinalizeInput,
	inspectionReviewInput,
	resolveInspectionReview,
} from "@/lib/inspection-review";

const firstRoom = "9c0b46d0-d753-42dd-bc30-4508204eb446";
const secondRoom = "a39dcc02-f43b-46e9-a996-d48d04f658dc";
const foreignRoom = "a39dcc02-f43b-46e9-a996-d48d04f658dd";
const requestId = "8d341738-7fd4-4bf3-a796-e89636bfc415";
const sample = {
	work: "male" as const,
	rooms: [
		{ roomId: firstRoom, name: "Kjøkken", seconds: 0 },
		{ roomId: secondRoom, name: "Gang", seconds: 80 },
	],
	evidence: [
		{ requestId, roomId: secondRoom, target: "surface_detail" as const },
	],
};
describe("inspection review", () => {
	it("keeps an older saved room with no known offset in the final review", () => {
		const rooms = [{ roomId: firstRoom, name: "Loftet" }, sample.rooms[1]];
		const result = inspectionFinalizeInput.parse({ ...sample, rooms });
		expect(result.rooms).toEqual(rooms);
		expect(
			inspectionReviewInput.safeParse({ ...result, endSeconds: 99 }).success,
		).toBe(false);
	});
	it("addresses a previous room and excludes completed or unrecognized requests", () => {
		const requests = [
			{ roomId: secondRoom, target: "surface_detail" },
			{ roomId: firstRoom.toUpperCase(), target: "under_sink" },
			{ roomId: foreignRoom, target: "shaft_access" },
			{ roomId: firstRoom, target: "under_sink" },
		];
		const result = resolveInspectionReview(
			{ summary: "Vis vasken.", requests },
			sample,
		);
		expect(result.requests).toEqual([
			{
				roomId: firstRoom,
				target: "under_sink",
				prompt: expect.stringContaining("under vasken"),
			},
		]);
	});

	it("rejects invented non-photo actions and malformed input timestamps", () => {
		expect(() =>
			resolveInspectionReview(
				{
					summary: "Materialet er ikke avklart.",
					requests: [{ roomId: firstRoom, target: "remove_panel" }],
				},
				sample,
			),
		).toThrow();
		expect(
			inspectionReviewInput.safeParse({ ...sample, endSeconds: -1 }).success,
		).toBe(false);
	});
});
