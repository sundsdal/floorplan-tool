import { createCanvas, Canvas, SKRSContext2D } from "@napi-rs/canvas";
import {
  Point,
  Wall,
  Door,
  Window,
  Room,
  DimensionAnnotation,
  FloorplanState,
  RoomType,
  ROOM_COLORS,
} from "./types";

const PIXELS_PER_METER = 50;
const PADDING = 50; // px padding around content
const MIN_CANVAS_SIZE = 400; // px

type FloorplanElement =
  | { kind: "wall"; data: Wall }
  | { kind: "door"; data: Door }
  | { kind: "window"; data: Window }
  | { kind: "room"; data: Room }
  | { kind: "dimension"; data: DimensionAnnotation };

interface LabelRoomOptions {
  polygon?: Point[];
  wallIds?: string[];
}

export class FloorplanCanvas {
  private elements: Map<string, FloorplanElement> = new Map();
  private nextId = 1;
  private canvas: Canvas;
  private ctx: SKRSContext2D;
  private onUpdate?: (state: FloorplanState) => void;

  setOnUpdate(cb: (state: FloorplanState) => void): void {
    this.onUpdate = cb;
  }

  private notifyUpdate(): void {
    if (this.onUpdate) {
      this.onUpdate(this.getJsonState());
    }
  }

  getJsonState(): FloorplanState {
    const walls: Wall[] = [];
    const doors: Door[] = [];
    const windows: Window[] = [];
    const rooms: Room[] = [];
    const dimensions: DimensionAnnotation[] = [];

    for (const [, el] of this.elements) {
      switch (el.kind) {
        case "wall": walls.push(el.data); break;
        case "door": doors.push(el.data); break;
        case "window": windows.push(el.data); break;
        case "room": rooms.push(el.data); break;
        case "dimension": dimensions.push(el.data); break;
      }
    }

    let total_area_m2 = 0;
    for (const room of rooms) {
      total_area_m2 += room.width_m * room.length_m;
    }

    return {
      walls, doors, windows, rooms, dimensions,
      total_area_m2: Math.round(total_area_m2 * 100) / 100,
    };
  }

  constructor() {
    this.canvas = createCanvas(MIN_CANVAS_SIZE, MIN_CANVAS_SIZE);
    this.ctx = this.canvas.getContext("2d");
  }

  private generateId(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  private metersToPixels(m: number): number {
    return m * PIXELS_PER_METER;
  }

  private pointToPixels(p: Point): { x: number; y: number } {
    return {
      x: p.x * PIXELS_PER_METER + PADDING,
      y: p.y * PIXELS_PER_METER + PADDING,
    };
  }

  private getWallById(wallId: string): Wall | undefined {
    const el = this.elements.get(wallId);
    if (el && el.kind === "wall") return el.data;
    return undefined;
  }

  private computeBounds(): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const [, el] of this.elements) {
      if (el.kind === "wall") {
        const w = el.data;
        for (const p of [w.start, w.end]) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      } else if (el.kind === "room") {
        const r = el.data;
        minX = Math.min(minX, r.polygon[0]?.[0] ?? 0, ...r.polygon.map((p) => p[0]));
        minY = Math.min(minY, r.polygon[0]?.[1] ?? 0, ...r.polygon.map((p) => p[1]));
        maxX = Math.max(maxX, ...r.polygon.map((p) => p[0]));
        maxY = Math.max(maxY, ...r.polygon.map((p) => p[1]));
      } else if (el.kind === "dimension") {
        const d = el.data;
        for (const p of [d.start, d.end]) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }

    if (minX === Infinity) {
      return { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    }
    return { minX, minY, maxX, maxY };
  }

  private resizeCanvasIfNeeded(): void {
    const bounds = this.computeBounds();
    const requiredW = this.metersToPixels(bounds.maxX - bounds.minX) + PADDING * 2;
    const requiredH = this.metersToPixels(bounds.maxY - bounds.minY) + PADDING * 2;
    const w = Math.max(MIN_CANVAS_SIZE, Math.ceil(requiredW));
    const h = Math.max(MIN_CANVAS_SIZE, Math.ceil(requiredH));

    if (w > this.canvas.width || h > this.canvas.height) {
      this.canvas = createCanvas(
        Math.max(w, this.canvas.width),
        Math.max(h, this.canvas.height)
      );
      this.ctx = this.canvas.getContext("2d");
    }
  }

  private render(): void {
    this.resizeCanvasIfNeeded();
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Clear
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);

    // Draw grid
    ctx.strokeStyle = "#F0F0F0";
    ctx.lineWidth = 0.5;
    for (let x = PADDING; x < w; x += PIXELS_PER_METER) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = PADDING; y < h; y += PIXELS_PER_METER) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Draw rooms (filled areas) first
    for (const [, el] of this.elements) {
      if (el.kind === "room") this.drawRoom(ctx, el.data);
    }

    // Draw walls
    for (const [, el] of this.elements) {
      if (el.kind === "wall") this.drawWall(ctx, el.data);
    }

    // Draw doors and windows on top
    for (const [, el] of this.elements) {
      if (el.kind === "door") this.drawDoor(ctx, el.data);
      if (el.kind === "window") this.drawWindow(ctx, el.data);
    }

    // Draw dimensions
    for (const [, el] of this.elements) {
      if (el.kind === "dimension") this.drawDimension(ctx, el.data);
    }

    // Draw room labels last (on top)
    for (const [, el] of this.elements) {
      if (el.kind === "room") this.drawRoomLabel(ctx, el.data);
    }
  }

  private drawWall(ctx: SKRSContext2D, wall: Wall): void {
    const start = this.pointToPixels(wall.start);
    const end = this.pointToPixels(wall.end);
    const thicknessPx = this.metersToPixels(wall.thickness_m);

    ctx.strokeStyle = "#1F2937";
    ctx.lineWidth = Math.max(thicknessPx, 2);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  private drawDoor(ctx: SKRSContext2D, door: Door): void {
    const wall = this.getWallById(door.wall_id);
    if (!wall) return;

    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const wallLen = Math.sqrt(dx * dx + dy * dy);
    if (wallLen === 0) return;

    const ux = dx / wallLen;
    const uy = dy / wallLen;
    const nx = -uy;
    const ny = ux;

    // Position along wall
    const posM = door.position_along_m;
    const doorCenter: Point = {
      x: wall.start.x + ux * posM,
      y: wall.start.y + uy * posM,
    };
    const center = this.pointToPixels(doorCenter);
    const widthPx = this.metersToPixels(door.width_m);

    // Clear wall segment where door is
    const halfW = door.width_m / 2;
    const doorStart = this.pointToPixels({
      x: doorCenter.x - ux * halfW,
      y: doorCenter.y - uy * halfW,
    });
    const doorEnd = this.pointToPixels({
      x: doorCenter.x + ux * halfW,
      y: doorCenter.y + uy * halfW,
    });

    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = this.metersToPixels(wall.thickness_m) + 2;
    ctx.beginPath();
    ctx.moveTo(doorStart.x, doorStart.y);
    ctx.lineTo(doorEnd.x, doorEnd.y);
    ctx.stroke();

    if (door.type === "standard") {
      // Draw arc symbol
      const arcRadius = widthPx;
      const wallAngle = Math.atan2(dy, dx);
      ctx.strokeStyle = "#3B82F6";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(
        doorStart.x,
        doorStart.y,
        arcRadius,
        wallAngle - Math.PI / 2,
        wallAngle,
        false
      );
      ctx.stroke();
      // Door line
      ctx.beginPath();
      ctx.moveTo(doorStart.x, doorStart.y);
      ctx.lineTo(
        doorStart.x + arcRadius * Math.cos(wallAngle),
        doorStart.y + arcRadius * Math.sin(wallAngle)
      );
      ctx.stroke();
    } else if (door.type === "sliding") {
      // Sliding door: dashed line along wall
      ctx.strokeStyle = "#3B82F6";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(doorStart.x, doorStart.y);
      ctx.lineTo(doorEnd.x, doorEnd.y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Opening: just the gap (already cleared)
      ctx.strokeStyle = "#3B82F6";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(doorStart.x, doorStart.y);
      ctx.lineTo(doorStart.x + nx * 5, doorStart.y + ny * 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(doorEnd.x, doorEnd.y);
      ctx.lineTo(doorEnd.x + nx * 5, doorEnd.y + ny * 5);
      ctx.stroke();
    }
  }

  private drawWindow(ctx: SKRSContext2D, win: Window): void {
    const wall = this.getWallById(win.wall_id);
    if (!wall) return;

    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const wallLen = Math.sqrt(dx * dx + dy * dy);
    if (wallLen === 0) return;

    const ux = dx / wallLen;
    const uy = dy / wallLen;
    const nx = -uy;
    const ny = ux;

    const posM = win.position_along_m;
    const winCenter: Point = {
      x: wall.start.x + ux * posM,
      y: wall.start.y + uy * posM,
    };
    const halfW = win.width_m / 2;
    const winStart = this.pointToPixels({
      x: winCenter.x - ux * halfW,
      y: winCenter.y - uy * halfW,
    });
    const winEnd = this.pointToPixels({
      x: winCenter.x + ux * halfW,
      y: winCenter.y + uy * halfW,
    });

    // Clear wall at window position
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = this.metersToPixels(wall.thickness_m) + 2;
    ctx.beginPath();
    ctx.moveTo(winStart.x, winStart.y);
    ctx.lineTo(winEnd.x, winEnd.y);
    ctx.stroke();

    // Draw parallel lines for window
    const offset = this.metersToPixels(wall.thickness_m / 2);
    ctx.strokeStyle = "#60A5FA";
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(winStart.x + nx * offset, winStart.y + ny * offset);
    ctx.lineTo(winEnd.x + nx * offset, winEnd.y + ny * offset);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(winStart.x - nx * offset, winStart.y - ny * offset);
    ctx.lineTo(winEnd.x - nx * offset, winEnd.y - ny * offset);
    ctx.stroke();

    // Cross lines connecting the parallels
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(winStart.x + nx * offset, winStart.y + ny * offset);
    ctx.lineTo(winStart.x - nx * offset, winStart.y - ny * offset);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(winEnd.x + nx * offset, winEnd.y + ny * offset);
    ctx.lineTo(winEnd.x - nx * offset, winEnd.y - ny * offset);
    ctx.stroke();
  }

  private drawRoom(ctx: SKRSContext2D, room: Room): void {
    if (room.polygon.length < 3) return;

    const color = ROOM_COLORS[room.type] || ROOM_COLORS.other;

    ctx.fillStyle = color + "40"; // semi-transparent
    ctx.beginPath();
    const first = this.pointToPixels({ x: room.polygon[0][0], y: room.polygon[0][1] });
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < room.polygon.length; i++) {
      const p = this.pointToPixels({ x: room.polygon[i][0], y: room.polygon[i][1] });
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawRoomLabel(ctx: SKRSContext2D, room: Room): void {
    // Compute centroid of polygon for label placement
    let cx = 0,
      cy = 0;
    for (const p of room.polygon) {
      cx += p[0];
      cy += p[1];
    }
    cx /= room.polygon.length;
    cy /= room.polygon.length;

    const center = this.pointToPixels({ x: cx, y: cy });

    ctx.fillStyle = "#1F2937";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(room.name, center.x, center.y - 8);

    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#6B7280";
    const area = room.width_m * room.length_m;
    ctx.fillText(`${area.toFixed(1)} m²`, center.x, center.y + 8);
  }

  private drawDimension(ctx: SKRSContext2D, dim: DimensionAnnotation): void {
    const start = this.pointToPixels(dim.start);
    const end = this.pointToPixels(dim.end);

    ctx.strokeStyle = "#EF4444";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow heads
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const arrowLen = 8;

    for (const [px, py, dir] of [
      [start.x, start.y, angle],
      [end.x, end.y, angle + Math.PI],
    ] as [number, number, number][]) {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(
        px + arrowLen * Math.cos(dir - 0.4),
        py + arrowLen * Math.sin(dir - 0.4)
      );
      ctx.moveTo(px, py);
      ctx.lineTo(
        px + arrowLen * Math.cos(dir + 0.4),
        py + arrowLen * Math.sin(dir + 0.4)
      );
      ctx.stroke();
    }

    // Label
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    ctx.fillStyle = "#EF4444";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    // Offset label perpendicular to the line
    const nx = -Math.sin(angle) * 12;
    const ny = Math.cos(angle) * 12;
    ctx.fillText(dim.label, midX + nx, midY + ny);
  }

  // --- Public API ---

  addWall(
    start: Point,
    end: Point,
    thickness_m: number,
    height_m: number
  ): { id: string; length_m: number } {
    const id = this.generateId("wall");
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length_m = Math.sqrt(dx * dx + dy * dy);

    const wall: Wall = { id, start, end, thickness_m, height_m, length_m };
    this.elements.set(id, { kind: "wall", data: wall });
    this.render();
    this.notifyUpdate();
    return { id, length_m: Math.round(length_m * 100) / 100 };
  }

  addDoor(
    wallId: string,
    position_along_m: number,
    width_m: number,
    type: "standard" | "sliding" | "opening"
  ): { id: string } {
    const wall = this.getWallById(wallId);
    if (!wall) throw new Error(`Wall ${wallId} not found`);

    const id = this.generateId("door");
    const door: Door = {
      id,
      wall_id: wallId,
      position_along_m,
      width_m,
      type,
    };
    this.elements.set(id, { kind: "door", data: door });
    this.render();
    this.notifyUpdate();
    return { id };
  }

  addWindow(
    wallId: string,
    position_along_m: number,
    width_m: number,
    sill_height_m: number
  ): { id: string } {
    const wall = this.getWallById(wallId);
    if (!wall) throw new Error(`Wall ${wallId} not found`);

    const id = this.generateId("window");
    const win: Window = {
      id,
      wall_id: wallId,
      position_along_m,
      width_m,
      sill_height_m,
    };
    this.elements.set(id, { kind: "window", data: win });
    this.render();
    this.notifyUpdate();
    return { id };
  }

  labelRoom(
    point: Point,
    name: string,
    type: RoomType,
    options?: LabelRoomOptions
  ): { id: string } {
    const id = this.generateId("room");

    let polygon: [number, number][] = [];
    let wallIds: string[] = [];

    if (options?.polygon && options.polygon.length > 0) {
      if (options.polygon.length < 3) {
        throw new Error("Room polygon must have at least 3 points");
      }

      polygon = options.polygon.map((p) => [p.x, p.y] as [number, number]);
      if (!this.isPointInPolygon(point, polygon)) {
        throw new Error("Room label point must be inside the provided polygon");
      }

      if (options.wallIds && options.wallIds.length > 0) {
        for (const wallId of options.wallIds) {
          if (!this.getWallById(wallId)) {
            throw new Error(`Wall ${wallId} not found`);
          }
        }
        wallIds = [...options.wallIds];
      } else {
        const inferredWallIds = this.resolveWallIdsForPolygon(polygon);
        if (inferredWallIds.length !== polygon.length) {
          throw new Error(
            "Could not resolve all wall IDs for the provided polygon. Provide wall_ids explicitly."
          );
        }
        wallIds = inferredWallIds;
      }
    } else {
      const inferred = this.inferRoomFromWalls(point);
      if (!inferred) {
        throw new Error(
          "Could not infer a closed room from existing walls. Provide polygon and wall_ids in label_room."
        );
      }
      polygon = inferred.polygon;
      wallIds = inferred.wallIds;
    }

    const bounds = this.polygonBounds(polygon);
    const room: Room = {
      id,
      name,
      type,
      width_m: bounds.width,
      length_m: bounds.height,
      height_m: 2.7,
      polygon,
      walls: wallIds,
      label_point: [point.x, point.y],
    };

    this.elements.set(id, { kind: "room", data: room });
    this.render();
    this.notifyUpdate();
    return { id };
  }

  private pointKey(point: Point): string {
    return `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
  }

  private pointFromKey(key: string): Point {
    const [x, y] = key.split(":").map(Number);
    return { x, y };
  }

  private pointsEqual(a: Point, b: Point, epsilon = 1e-6): boolean {
    return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
  }

  private isPointInPolygon(point: Point, polygon: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];

      const intersects =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;

      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  private polygonArea(poly: [number, number][]): number {
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      area += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
    }
    return Math.abs(area / 2);
  }

  private resolveWallIdsForPolygon(poly: [number, number][]): string[] {
    const wallIds: string[] = [];
    for (let i = 0; i < poly.length; i++) {
      const next = (i + 1) % poly.length;
      const start: Point = { x: poly[i][0], y: poly[i][1] };
      const end: Point = { x: poly[next][0], y: poly[next][1] };

      let match: string | null = null;
      for (const [, el] of this.elements) {
        if (el.kind !== "wall") continue;
        const sameDirection =
          this.pointsEqual(el.data.start, start) && this.pointsEqual(el.data.end, end);
        const oppositeDirection =
          this.pointsEqual(el.data.start, end) && this.pointsEqual(el.data.end, start);
        if (sameDirection || oppositeDirection) {
          match = el.data.id;
          break;
        }
      }

      if (!match) return [];
      wallIds.push(match);
    }
    return wallIds;
  }

  private inferRoomFromWalls(point: Point): { polygon: [number, number][]; wallIds: string[] } | null {
    const adjacency = new Map<string, { to: string; wallId: string }[]>();
    const pointByKey = new Map<string, Point>();

    for (const [, el] of this.elements) {
      if (el.kind === "wall") {
        const startKey = this.pointKey(el.data.start);
        const endKey = this.pointKey(el.data.end);

        pointByKey.set(startKey, el.data.start);
        pointByKey.set(endKey, el.data.end);

        if (!adjacency.has(startKey)) adjacency.set(startKey, []);
        if (!adjacency.has(endKey)) adjacency.set(endKey, []);
        adjacency.get(startKey)?.push({ to: endKey, wallId: el.data.id });
        adjacency.get(endKey)?.push({ to: startKey, wallId: el.data.id });
      }
    }

    if (adjacency.size < 3) return null;

    const maxCycleLen = 12;
    const seenCycleKeys = new Set<string>();
    const candidates: { polygon: [number, number][]; wallIds: string[]; area: number }[] = [];

    const dfs = (
      startKey: string,
      currentKey: string,
      nodePath: string[],
      wallPath: string[],
      usedWalls: Set<string>
    ): void => {
      const neighbors = adjacency.get(currentKey) ?? [];

      for (const edge of neighbors) {
        if (wallPath.length > 0 && edge.wallId === wallPath[wallPath.length - 1]) {
          continue;
        }

        if (edge.to === startKey) {
          if (wallPath.length < 2) continue;
          const cycleWalls = [...wallPath, edge.wallId];
          const uniqueWalls = new Set(cycleWalls);
          if (uniqueWalls.size < 3) continue;

          const cycleKey = [...uniqueWalls].sort().join("|");
          if (seenCycleKeys.has(cycleKey)) continue;
          seenCycleKeys.add(cycleKey);

          const polygon = nodePath.map((nodeKey) => {
            const p = pointByKey.get(nodeKey) ?? this.pointFromKey(nodeKey);
            return [p.x, p.y] as [number, number];
          });

          const area = this.polygonArea(polygon);
          if (area < 1e-4) continue;
          if (!this.isPointInPolygon(point, polygon)) continue;

          candidates.push({ polygon, wallIds: cycleWalls, area });
          continue;
        }

        if (usedWalls.has(edge.wallId)) continue;
        if (nodePath.includes(edge.to)) continue;
        if (wallPath.length + 1 >= maxCycleLen) continue;

        usedWalls.add(edge.wallId);
        dfs(startKey, edge.to, [...nodePath, edge.to], [...wallPath, edge.wallId], usedWalls);
        usedWalls.delete(edge.wallId);
      }
    };

    const startNodes = [...adjacency.keys()].sort((a, b) => a.localeCompare(b));
    for (const startKey of startNodes) {
      dfs(startKey, startKey, [startKey], [], new Set<string>());
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.area - b.area);
    return { polygon: candidates[0].polygon, wallIds: candidates[0].wallIds };
  }

  private polygonBounds(poly: [number, number][]): {
    width: number;
    height: number;
  } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return {
      width: Math.round((maxX - minX) * 100) / 100,
      height: Math.round((maxY - minY) * 100) / 100,
    };
  }

  annotateDimension(
    start: Point,
    end: Point,
    label: string
  ): { id: string } {
    const id = this.generateId("dim");
    const dim: DimensionAnnotation = { id, start, end, label };
    this.elements.set(id, { kind: "dimension", data: dim });
    this.render();
    this.notifyUpdate();
    return { id };
  }

  setCeilingHeight(roomLabel: string, height_m: number): void {
    for (const [, el] of this.elements) {
      if (el.kind === "room" && el.data.name === roomLabel) {
        el.data.height_m = height_m;
        this.render();
        this.notifyUpdate();
        return;
      }
    }
    throw new Error(`Room "${roomLabel}" not found`);
  }

  moveWall(wallId: string, newStart: Point, newEnd: Point): { length_m: number } {
    const el = this.elements.get(wallId);
    if (!el || el.kind !== "wall") throw new Error(`Wall ${wallId} not found`);
    const dx = newEnd.x - newStart.x;
    const dy = newEnd.y - newStart.y;
    const length_m = Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100;
    el.data.start = newStart;
    el.data.end = newEnd;
    el.data.length_m = length_m;
    this.render();
    this.notifyUpdate();
    return { length_m };
  }

  deleteElement(elementId: string): void {
    if (!this.elements.has(elementId)) {
      throw new Error(`Element ${elementId} not found`);
    }
    this.elements.delete(elementId);
    this.render();
    this.notifyUpdate();
  }

  async getState(): Promise<{ json: FloorplanState; png: Buffer }> {
    this.render();
    const json = this.getJsonState();
    const pngBuffer = await this.canvas.encode("png");
    return { json, png: Buffer.from(pngBuffer) };
  }
}
