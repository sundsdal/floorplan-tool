import { afterEach, describe, expect, it, vi } from "vitest";

const mockSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/inspection-spatial", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/inspection-spatial")>();
	return { ...original, readSpatialSnapshot: mockSnapshot };
});

import { runInspectionModel } from "@/lib/inspection-review";

const room = "9c0b46d0-d753-42dd-bc30-4508204eb446";
const context = {
	work: "male" as const,
	rooms: [{ roomId: room, name: "Bad", seconds: 0 }],
	evidence: [],
};
const snapshot = {
	capturedAt: 1_790_000_000_000,
	seconds: 10,
	location: {
		capturedAt: 1_790_000_000_000,
		tracking: "tracked",
		roomId: room,
	},
	walls: [],
	doors: [],
	windows: [],
	rooms: [],
	image: "/9j/2Q==",
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	mockSnapshot.mockReset();
});

describe("Hydrogen spatial tools", () => {
	it("returns the map image as a tool response, preserves signatures and queues an authorized command", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
		mockSnapshot.mockResolvedValue(snapshot);
		const requests: {
			contents: {
				parts: { thoughtSignature?: string; functionResponse?: unknown }[];
			}[];
		}[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				requests.push(JSON.parse(init.body));
				if (requests.length === 1)
					return Response.json({
						candidates: [
							{
								content: {
									parts: [
										{
											thoughtSignature: "signature",
											functionCall: {
												id: "map",
												name: "read_roomplan",
												args: {},
											},
										},
										{
											functionCall: {
												id: "cmd",
												name: "send_live_command",
												args: {
													roomId: room.toUpperCase(),
													target: "under_sink",
												},
											},
										},
									],
								},
							},
						],
					});
				return Response.json({
					candidates: [
						{
							content: { parts: [{ text: '{"summary":"Se under vasken."}' }] },
						},
					],
				});
			}),
		);
		const result = await runInspectionModel("session", context, new Headers(), {
			question: "Hvilken vask?",
		});
		expect(result.requests).toEqual([
			{
				roomId: room,
				target: "under_sink",
				prompt: expect.stringContaining("under vasken"),
			},
		]);
		expect(mockSnapshot).toHaveBeenCalledWith("session");
		const replay = requests[1].contents;
		expect(replay[1].parts[0].thoughtSignature).toBe("signature");
		expect(replay[2].parts[0].functionResponse).toMatchObject({
			id: "map",
			name: "read_roomplan",
			response: { output: { location: { roomId: room } } },
			parts: [{ inlineData: { mimeType: "image/jpeg", data: snapshot.image } }],
		});
		expect(replay[2].parts[1].functionResponse).toMatchObject({
			id: "cmd",
			name: "send_live_command",
		});
	});

	it("rejects unrecognized rooms and avoids commands for completed evidence", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						candidates: [
							{
								content: {
									parts: [
										{
											functionCall: {
												name: "send_live_command",
												args: { roomId: room, target: "under_sink" },
											},
										},
										{
											functionCall: {
												name: "send_live_command",
												args: {
													roomId: "9c0b46d0-d753-42dd-bc30-4508204eb447",
													target: "ventilation",
												},
											},
										},
									],
								},
							},
						],
					}),
				)
				.mockResolvedValueOnce(
					Response.json({
						candidates: [
							{ content: { parts: [{ text: '{"summary":"Avklart."}' }] } },
						],
					}),
				),
		);
		const result = await runInspectionModel(
			"session",
			{
				...context,
				evidence: [
					{
						requestId: "8d341738-7fd4-4bf3-a796-e89636bfc415",
						roomId: room,
						target: "under_sink",
					},
				],
			},
			new Headers(),
			{},
		);
		expect(result.requests).toEqual([]);
	});
});
