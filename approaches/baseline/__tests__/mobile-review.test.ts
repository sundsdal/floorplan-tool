import { parseDocument } from "@floorplan/core";
import { describe, expect, it } from "vitest";
import fixture from "../../../packages/floorplan/fixtures/rotated-l.json";
import { exportReview, finalScene, reviewDocument } from "../mobile/src/review";
import type { Scene } from "../mobile/src/scene";

describe("mobile final review", () => {
	it("uses the accepted scene for review and both exports, preserving final warnings", () => {
		const floorplan = parseDocument(fixture).floorplan;
		const initial: Scene = {
			revision: 1,
			floorplan,
			nodes: {},
			proposals: [],
			evidence: [],
		};
		const fallback = finalScene(initial, floorplan, 1);
		const accepted = structuredClone(fallback);
		accepted.revision = 2;
		accepted.floorplan.rooms[0].name = "Accepted room";
		const result = reviewDocument(accepted, ["Final warning"]);
		if (!result) throw new Error("Missing final review");
		expect(result.floorplan.rooms[0].name).toBe("Accepted room");
		expect(result.warnings).toEqual(["Final warning"]);
		expect(exportReview(result, "svg")).toContain("Accepted room");
		expect(
			JSON.parse(exportReview(result, "json")).floorplan.rooms[0].name,
		).toBe("Accepted room");
		expect(finalScene(accepted, floorplan, 1)).toBe(accepted);
	});
});
