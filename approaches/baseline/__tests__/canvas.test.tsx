import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import type { FloorplanState } from "@/lib/types";

// Mock react-konva since it requires actual canvas in DOM
vi.mock("react-konva", () => {
  const createMockComponent = (name: string) =>
    React.forwardRef(({ children, ...props }: any, ref: any) => (
      <div data-testid={`konva-${name.toLowerCase()}`} data-props={JSON.stringify(props)} ref={ref}>
        {children}
      </div>
    ));

  return {
    Stage: createMockComponent("Stage"),
    Layer: createMockComponent("Layer"),
    Line: ({ points, stroke, strokeWidth, ...rest }: any) => (
      <div data-testid="konva-line" data-points={JSON.stringify(points)} data-stroke={stroke} data-stroke-width={strokeWidth} />
    ),
    Arc: ({ outerRadius, angle, stroke, ...rest }: any) => (
      <div data-testid="konva-arc" data-outer-radius={outerRadius} data-angle={angle} data-stroke={stroke} />
    ),
    Text: ({ text, ...rest }: any) => (
      <div data-testid="konva-text" data-text={text} />
    ),
    Group: ({ children, ...props }: any) => (
      <div data-testid="konva-group" data-props={JSON.stringify(props)}>{children}</div>
    ),
    Rect: (props: any) => (
      <div data-testid="konva-rect" />
    ),
  };
});

// Import after mocking
import FloorplanCanvas from "@/components/canvas";

const sampleFloorplan: FloorplanState = {
  walls: [
    { id: "w1", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness_m: 0.15, height_m: 2.7, length_m: 4 },
    { id: "w2", start: { x: 4, y: 0 }, end: { x: 4, y: 3 }, thickness_m: 0.15, height_m: 2.7, length_m: 3 },
  ],
  doors: [
    { id: "d1", wall_id: "w1", position_along_m: 1.5, width_m: 0.9, type: "standard" },
  ],
  windows: [
    { id: "win1", wall_id: "w2", position_along_m: 1.0, width_m: 1.2, sill_height_m: 0.9 },
  ],
  rooms: [
    {
      id: "r1", name: "Living Room", type: "living_room",
      width_m: 4, length_m: 3, height_m: 2.7,
      polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
      walls: ["w1", "w2"],
    },
  ],
  dimensions: [
    { id: "dim1", start: { x: 0, y: -0.5 }, end: { x: 4, y: -0.5 }, label: "4.0 m" },
  ],
  total_area_m2: 12,
};

const emptyFloorplan: FloorplanState = {
  walls: [], doors: [], windows: [], rooms: [], dimensions: [],
  total_area_m2: 0,
};

describe("FloorplanCanvas", () => {
  beforeEach(() => {
    // Mock offsetWidth/offsetHeight for container sizing
    Object.defineProperty(HTMLDivElement.prototype, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(HTMLDivElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  });

  it("renders a Stage and Layer", () => {
    const { getAllByTestId } = render(<FloorplanCanvas floorplan={sampleFloorplan} />);
    expect(getAllByTestId("konva-stage").length).toBeGreaterThanOrEqual(1);
    expect(getAllByTestId("konva-layer").length).toBeGreaterThanOrEqual(1);
  });

  it("renders walls as Line elements", () => {
    const { getAllByTestId } = render(<FloorplanCanvas floorplan={sampleFloorplan} />);
    const lines = getAllByTestId("konva-line");
    // At least 2 wall lines + door gap line + door leaf + window gap + 2 window parallel lines + dimension lines + ticks
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("renders door arc symbols", () => {
    const { getAllByTestId } = render(<FloorplanCanvas floorplan={sampleFloorplan} />);
    const arcs = getAllByTestId("konva-arc");
    expect(arcs.length).toBe(1);
    expect(arcs[0].getAttribute("data-angle")).toBe("90");
    expect(arcs[0].getAttribute("data-stroke")).toBe("#3B82F6");
  });

  it("centers a door opening on its position along a rotated wall", () => {
    const floorplan: FloorplanState = {
      ...emptyFloorplan,
      walls: [{ id: "w1", start: { x: 1, y: 1 }, end: { x: 1, y: 5 }, thickness_m: 0.15, height_m: 2.7, length_m: 4 }],
      doors: [{ id: "d1", wall_id: "w1", position_along_m: 3.5, width_m: 1, type: "standard" }],
    };
    const { getByTestId } = render(<FloorplanCanvas floorplan={floorplan} />);
    const arc = getByTestId("konva-arc");
    const group = arc.parentElement!;
    expect(JSON.parse(group.getAttribute("data-props")!)).toMatchObject({ x: 50, y: 200, rotation: 90 });
    const gap = group.querySelector('[data-stroke="white"]')!;
    expect(JSON.parse(gap.getAttribute("data-points")!)).toEqual([0, 0, 50, 0]);
  });

  it("renders room labels", () => {
    const { getAllByTestId } = render(<FloorplanCanvas floorplan={sampleFloorplan} />);
    const texts = getAllByTestId("konva-text");
    const textValues = texts.map((t) => t.getAttribute("data-text"));
    expect(textValues).toContain("Living Room");
    expect(textValues.some((t) => t?.includes("4.0 x 3.0 m"))).toBe(true);
  });

  it("renders dimension annotations with labels", () => {
    const { getAllByTestId } = render(<FloorplanCanvas floorplan={sampleFloorplan} />);
    const texts = getAllByTestId("konva-text");
    const textValues = texts.map((t) => t.getAttribute("data-text"));
    expect(textValues).toContain("4.0 m");
  });

  it("renders empty floorplan without crashing", () => {
    const { getAllByTestId, queryAllByTestId } = render(<FloorplanCanvas floorplan={emptyFloorplan} />);
    expect(getAllByTestId("konva-stage").length).toBe(1);
    // Should have background rect but no walls/doors/etc
    const arcs = queryAllByTestId("konva-arc");
    expect(arcs.length).toBe(0);
  });

  it("does not render doors for invalid wall_id", () => {
    const floorplan: FloorplanState = {
      ...emptyFloorplan,
      walls: [{ id: "w1", start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness_m: 0.15, height_m: 2.7, length_m: 4 }],
      doors: [{ id: "d1", wall_id: "nonexistent", position_along_m: 1.0, width_m: 0.9, type: "standard" }],
    };
    const { queryAllByTestId } = render(<FloorplanCanvas floorplan={floorplan} />);
    // Door should not render since its wall_id doesn't exist
    const arcs = queryAllByTestId("konva-arc");
    expect(arcs.length).toBe(0);
  });
});
