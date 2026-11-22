import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportPNG, exportSVG } from "@/lib/export";
import type { FloorplanState } from "@/lib/types";

const sampleFloorplan: FloorplanState = {
  walls: [
    { id: "w1", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness_m: 0.15, height_m: 2.7, length_m: 4 },
    { id: "w2", start: { x: 4, y: 0 }, end: { x: 4, y: 3 }, thickness_m: 0.15, height_m: 2.7, length_m: 3 },
    { id: "w3", start: { x: 4, y: 3 }, end: { x: 0, y: 3 }, thickness_m: 0.15, height_m: 2.7, length_m: 4 },
    { id: "w4", start: { x: 0, y: 3 }, end: { x: 0, y: 0 }, thickness_m: 0.15, height_m: 2.7, length_m: 3 },
  ],
  doors: [
    { id: "d1", wall_id: "w1", position_along_m: 1.5, width_m: 0.9, type: "standard" },
  ],
  windows: [
    { id: "win1", wall_id: "w3", position_along_m: 2.0, width_m: 1.2, sill_height_m: 0.9 },
  ],
  rooms: [
    {
      id: "r1", name: "Bedroom", type: "bedroom",
      width_m: 4, length_m: 3, height_m: 2.7,
      polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
      walls: ["w1", "w2", "w3", "w4"],
    },
  ],
  dimensions: [
    { id: "dim1", start: { x: 0, y: -0.5 }, end: { x: 4, y: -0.5 }, label: "4.0 m" },
  ],
  total_area_m2: 12,
};

describe("exportSVG", () => {
  let createdBlob: Blob | null = null;

  beforeEach(() => {
    createdBlob = null;
    // Mock URL.createObjectURL and revokeObjectURL
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        createdBlob = blob;
        return "blob:mock-url";
      }),
      revokeObjectURL: vi.fn(),
    });
  });

  it("generates valid SVG with all elements", async () => {
    // Mock DOM methods for download
    const mockLink = { download: "", href: "", click: vi.fn() };
    const appendSpy = vi.fn();
    const removeSpy = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValue(mockLink as unknown as HTMLElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(appendSpy);
    vi.spyOn(document.body, "removeChild").mockImplementation(removeSpy);

    exportSVG(sampleFloorplan, 50, "test.svg");

    expect(mockLink.download).toBe("test.svg");
    expect(mockLink.click).toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();

    // Check SVG content
    expect(createdBlob).not.toBeNull();
    const svgText = await createdBlob!.text();

    expect(svgText).toContain("<svg");
    expect(svgText).toContain("</svg>");
    // Room polygon
    expect(svgText).toContain("<polygon");
    expect(svgText).toContain("Bedroom");
    // Walls
    expect(svgText).toContain('stroke="#1F2937"');
    // Door arc
    expect(svgText).toContain('stroke="#3B82F6"');
    // Window parallel lines
    expect(svgText).toContain('stroke="#60A5FA"');
    // Dimension label
    expect(svgText).toContain("4.0 m");
  });

  it("handles empty floorplan without crashing", async () => {
    const empty: FloorplanState = {
      walls: [], doors: [], windows: [], rooms: [], dimensions: [],
      total_area_m2: 0,
    };

    const mockLink = { download: "", href: "", click: vi.fn() };
    vi.spyOn(document, "createElement").mockReturnValue(mockLink as unknown as HTMLElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(vi.fn());
    vi.spyOn(document.body, "removeChild").mockImplementation(vi.fn());

    exportSVG(empty);

    expect(createdBlob).not.toBeNull();
    const svgText = await createdBlob!.text();
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("</svg>");
  });
});

describe("exportPNG", () => {
  it("calls stage.toDataURL with 2x pixel ratio and triggers download", () => {
    const mockStage = {
      toDataURL: vi.fn(() => "data:image/png;base64,AAAA"),
    };
    const mockLink = { download: "", href: "", click: vi.fn() };
    vi.spyOn(document, "createElement").mockReturnValue(mockLink as unknown as HTMLElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(vi.fn());
    vi.spyOn(document.body, "removeChild").mockImplementation(vi.fn());

    exportPNG(mockStage as any);

    expect(mockStage.toDataURL).toHaveBeenCalledWith({
      pixelRatio: 2,
      mimeType: "image/png",
    });
    expect(mockLink.download).toBe("floorplan.png");
    expect(mockLink.href).toBe("data:image/png;base64,AAAA");
    expect(mockLink.click).toHaveBeenCalled();
  });

  it("uses custom filename", () => {
    const mockStage = { toDataURL: vi.fn(() => "data:image/png;base64,AAAA") };
    const mockLink = { download: "", href: "", click: vi.fn() };
    vi.spyOn(document, "createElement").mockReturnValue(mockLink as unknown as HTMLElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(vi.fn());
    vi.spyOn(document.body, "removeChild").mockImplementation(vi.fn());

    exportPNG(mockStage as any, "custom.png");

    expect(mockLink.download).toBe("custom.png");
  });
});
