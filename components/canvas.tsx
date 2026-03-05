"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import { Stage, Layer, Line, Arc, Text, Group, Rect } from "react-konva";
import type Konva from "konva";
import type { FloorplanState, Wall, Door, Window as FloorplanWindow, Room, DimensionAnnotation } from "@/lib/types";
import { ROOM_COLORS } from "@/lib/types";

interface CanvasProps {
  floorplan: FloorplanState;
  stageRef?: React.RefObject<Konva.Stage | null>;
}

const SCALE = 50; // 1 meter = 50 pixels
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

function getWallById(walls: Wall[], id: string): Wall | undefined {
  return walls.find((w) => w.id === id);
}

function getCenter(polygon: [number, number][]): { x: number; y: number } {
  const cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  return { x: cx, y: cy };
}

function WallShape({ wall }: { wall: Wall }) {
  const thickness = Math.max(wall.thickness_m * SCALE, 3);
  return (
    <Line
      points={[wall.start.x * SCALE, wall.start.y * SCALE, wall.end.x * SCALE, wall.end.y * SCALE]}
      stroke="#1F2937"
      strokeWidth={thickness}
      lineCap="round"
    />
  );
}

function DoorShape({ door, walls }: { door: Door; walls: Wall[] }) {
  const wall = getWallById(walls, door.wall_id);
  if (!wall) return null;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ratio = door.position_along_m / (len || 1);
  const x = (wall.start.x + dx * ratio) * SCALE;
  const y = (wall.start.y + dy * ratio) * SCALE;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const radius = door.width_m * SCALE;

  return (
    <Group x={x} y={y} rotation={angle}>
      {/* Door gap (white background to "cut" the wall) */}
      <Line
        points={[0, 0, radius, 0]}
        stroke="white"
        strokeWidth={Math.max(wall.thickness_m * SCALE + 2, 6)}
      />
      {/* Door swing arc */}
      <Arc
        innerRadius={0}
        outerRadius={radius}
        angle={90}
        rotation={-90}
        fill="transparent"
        stroke="#3B82F6"
        strokeWidth={1.5}
      />
      {/* Door leaf line */}
      <Line
        points={[0, 0, radius, 0]}
        stroke="#3B82F6"
        strokeWidth={1.5}
      />
    </Group>
  );
}

function WindowShape({ win, walls }: { win: FloorplanWindow; walls: Wall[] }) {
  const wall = getWallById(walls, win.wall_id);
  if (!wall) return null;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ratio = win.position_along_m / (len || 1);
  const x = (wall.start.x + dx * ratio) * SCALE;
  const y = (wall.start.y + dy * ratio) * SCALE;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const halfW = (win.width_m * SCALE) / 2;

  return (
    <Group x={x} y={y} rotation={angle}>
      {/* Window gap (white background to "cut" the wall) */}
      <Line
        points={[-halfW, 0, halfW, 0]}
        stroke="white"
        strokeWidth={Math.max(wall.thickness_m * SCALE + 2, 6)}
      />
      {/* Parallel lines representing the window */}
      <Line points={[-halfW, -3, halfW, -3]} stroke="#60A5FA" strokeWidth={2} />
      <Line points={[-halfW, 3, halfW, 3]} stroke="#60A5FA" strokeWidth={2} />
    </Group>
  );
}

const ROOM_TYPE_LABELS: Record<string, string> = {
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  living_room: "Living Room",
  dining_room: "Dining Room",
  hallway: "Hallway",
  closet: "Closet",
  balcony: "Balcony",
  office: "Office",
  laundry: "Laundry",
  garage: "Garage",
  basement: "Basement",
  stairs: "Stairs",
  attic: "Attic",
  other: "Other",
};

function RoomFill({ room }: { room: Room }) {
  if (room.polygon.length < 3) return null;
  const color = ROOM_COLORS[room.type] || ROOM_COLORS.other;
  const points = room.polygon.flat().map((v) => v * SCALE);
  // Prefer the agent-placed label_point over polygon centroid
  const labelOrigin = room.label_point
    ? { x: room.label_point[0], y: room.label_point[1] }
    : getCenter(room.polygon);
  const typeLabel = ROOM_TYPE_LABELS[room.type] || room.type;

  return (
    <Group>
      <Line points={points} closed fill={color} opacity={0.35} stroke="transparent" />
      {/* Room name */}
      <Text
        x={labelOrigin.x * SCALE - 60}
        y={labelOrigin.y * SCALE - 20}
        width={120}
        align="center"
        text={room.name}
        fontSize={14}
        fontStyle="bold"
        fill="#111827"
      />
      {/* Room type badge */}
      <Rect
        x={labelOrigin.x * SCALE - 30}
        y={labelOrigin.y * SCALE - 1}
        width={60}
        height={16}
        fill={color}
        opacity={0.7}
        cornerRadius={3}
      />
      <Text
        x={labelOrigin.x * SCALE - 30}
        y={labelOrigin.y * SCALE + 1}
        width={60}
        align="center"
        text={typeLabel}
        fontSize={9}
        fontStyle="600"
        fill="#374151"
      />
      {/* Dimensions */}
      <Text
        x={labelOrigin.x * SCALE - 60}
        y={labelOrigin.y * SCALE + 18}
        width={120}
        align="center"
        text={`${room.width_m.toFixed(1)} x ${room.length_m.toFixed(1)} m`}
        fontSize={10}
        fill="#6B7280"
      />
    </Group>
  );
}

function DimensionLine({ dim }: { dim: DimensionAnnotation }) {
  const x1 = dim.start.x * SCALE;
  const y1 = dim.start.y * SCALE;
  const x2 = dim.end.x * SCALE;
  const y2 = dim.end.y * SCALE;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  return (
    <Group>
      <Line
        points={[x1, y1, x2, y2]}
        stroke="#9CA3AF"
        strokeWidth={1}
        dash={[4, 2]}
      />
      {/* End ticks */}
      <Line points={[x1, y1 - 4, x1, y1 + 4]} stroke="#9CA3AF" strokeWidth={1} />
      <Line points={[x2, y2 - 4, x2, y2 + 4]} stroke="#9CA3AF" strokeWidth={1} />
      <Text
        x={mx - 30}
        y={my - 14}
        width={60}
        align="center"
        text={dim.label}
        fontSize={10}
        fill="#6B7280"
      />
    </Group>
  );
}

export default function FloorplanCanvas({ floorplan, stageRef }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalStageRef = useRef<Konva.Stage>(null);
  const activeRef = stageRef || internalStageRef;

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [stageScale, setStageScale] = useState(1);

  // Responsive sizing
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: Math.max(containerRef.current.offsetHeight, 400),
        });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Center the floorplan on mount or data change
  useEffect(() => {
    if (floorplan.walls.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const wall of floorplan.walls) {
      minX = Math.min(minX, wall.start.x, wall.end.x);
      minY = Math.min(minY, wall.start.y, wall.end.y);
      maxX = Math.max(maxX, wall.start.x, wall.end.x);
      maxY = Math.max(maxY, wall.start.y, wall.end.y);
    }
    const contentW = (maxX - minX) * SCALE;
    const contentH = (maxY - minY) * SCALE;
    const fitScale = Math.min(
      (dimensions.width - 80) / contentW,
      (dimensions.height - 80) / contentH,
      2
    );
    setStageScale(fitScale);
    setStagePos({
      x: (dimensions.width - contentW * fitScale) / 2 - minX * SCALE * fitScale,
      y: (dimensions.height - contentH * fitScale) / 2 - minY * SCALE * fitScale,
    });
  }, [floorplan, dimensions]);

  // Zoom with scroll wheel
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = activeRef.current;
    if (!stage) return;

    const oldScale = stageScale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const factor = 1.08;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, direction > 0 ? oldScale * factor : oldScale / factor));

    const mousePointTo = {
      x: (pointer.x - stagePos.x) / oldScale,
      y: (pointer.y - stagePos.y) / oldScale,
    };

    setStageScale(newScale);
    setStagePos({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }, [stageScale, stagePos, activeRef]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[400px] bg-white rounded-lg border border-gray-200 overflow-hidden">
      <Stage
        ref={activeRef}
        width={dimensions.width}
        height={dimensions.height}
        x={stagePos.x}
        y={stagePos.y}
        scaleX={stageScale}
        scaleY={stageScale}
        draggable
        onDragEnd={(e) => setStagePos({ x: e.target.x(), y: e.target.y() })}
        onWheel={handleWheel}
      >
        <Layer>
          {/* Grid background */}
          <Rect
            x={-2000}
            y={-2000}
            width={4000}
            height={4000}
            fill="#FAFAFA"
          />

          {/* Room fills (render first, behind walls) */}
          {floorplan.rooms.map((room) => (
            <RoomFill key={room.id} room={room} />
          ))}

          {/* Walls */}
          {floorplan.walls.map((wall) => (
            <WallShape key={wall.id} wall={wall} />
          ))}

          {/* Doors */}
          {floorplan.doors.map((door) => (
            <DoorShape key={door.id} door={door} walls={floorplan.walls} />
          ))}

          {/* Windows */}
          {floorplan.windows.map((win) => (
            <WindowShape key={win.id} win={win} walls={floorplan.walls} />
          ))}

          {/* Dimension annotations */}
          {floorplan.dimensions.map((dim) => (
            <DimensionLine key={dim.id} dim={dim} />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}
