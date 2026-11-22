import { describe, expect, it } from "vitest";
import fixture from "./fixtures/rotated-l.json";
import { createDocument, parseDocument, renderSVG } from "./index";

describe("floorplan exchange", () => {
	it("renders the rotated L fixture and preserves the source on round trip", () => {
		const doc = parseDocument(fixture);
		expect(doc.floorplan.total_area_m2).toBe(12);
		expect(renderSVG(doc)).toContain("LiDAR-derived dimensions");
		expect(parseDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
	});
	it("escapes user labels and distinguishes estimates", () => {
		const doc = createDocument(parseDocument(fixture).floorplan, "video");
		doc.floorplan.rooms[0].name = "<Study & office>";
		expect(renderSVG(doc)).toContain("&lt;Study &amp; office&gt;");
		expect(renderSVG(doc)).toContain("Video estimates");
	});
	it("rejects unsupported versions and dangling openings", () => {
		expect(() => parseDocument({ ...fixture, version: 2 })).toThrow();
		const doc = structuredClone(fixture);
		doc.floorplan.doors[0].wall_id = "missing";
		expect(() => parseDocument(doc)).toThrow();
	});
});
