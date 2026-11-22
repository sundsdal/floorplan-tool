import type { FloorplanDocument } from "./index";
import { type Door, ROOM_COLORS, type Wall, type Window } from "./types";

function escapeText(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
function getWallById(walls: Wall[], id: string): Wall | undefined {
	return walls.find((w) => w.id === id);
}

function getOpeningPosition(
	opening: Door | Window,
	wall: Wall,
): { x: number; y: number; angle: number } {
	const dx = wall.end.x - wall.start.x;
	const dy = wall.end.y - wall.start.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	const ratio = opening.position_along_m / (len || 1);
	const x = wall.start.x + dx * ratio;
	const y = wall.start.y + dy * ratio;
	const angle = Math.atan2(dy, dx) * (180 / Math.PI);
	return { x, y, angle };
}

export function renderSVG(document: FloorplanDocument, scale = 50) {
	const { floorplan } = document;
	const padding = 40;

	// Calculate bounds
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	function includePoint(x: number, y: number) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	for (const segment of [...floorplan.walls, ...floorplan.dimensions]) {
		includePoint(segment.start.x, segment.start.y);
		includePoint(segment.end.x, segment.end.y);
	}
	for (const room of floorplan.rooms) {
		for (const [x, y] of room.polygon) includePoint(x, y);
	}
	if (!Number.isFinite(minX)) {
		minX = 0;
		minY = 0;
		maxX = 10;
		maxY = 10;
	}

	const width = Math.max(230, (maxX - minX) * scale + padding * 2);
	const height = (maxY - minY) * scale + padding * 2 + 24;

	const tx = (x: number) => (x - minX) * scale + padding;
	const ty = (y: number) => (y - minY) * scale + padding;

	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
	);
	parts.push(`<rect width="${width}" height="${height}" fill="white"/>`);

	// Room fills
	for (const room of floorplan.rooms) {
		if (room.polygon.length < 3) continue;
		const points = room.polygon
			.map(([px, py]) => `${tx(px)},${ty(py)}`)
			.join(" ");
		const color = ROOM_COLORS[room.type] || ROOM_COLORS.other;
		parts.push(
			`<polygon points="${points}" fill="${color}" fill-opacity="0.4" stroke="none"/>`,
		);

		// Room label
		const cx =
			room.label_point?.[0] ??
			room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
		const cy =
			room.label_point?.[1] ??
			room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;
		parts.push(
			`<text x="${tx(cx)}" y="${ty(cy)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="12" font-weight="600" fill="#1F2937">${escapeText(room.name)}</text>`,
		);
		parts.push(
			`<text x="${tx(cx)}" y="${ty(cy) + 14}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="9" fill="#6B7280">${room.width_m.toFixed(1)} x ${room.length_m.toFixed(1)} m</text>`,
		);
	}

	// Walls
	for (const wall of floorplan.walls) {
		const thickness = Math.max(wall.thickness_m * scale, 2);
		parts.push(
			`<line x1="${tx(wall.start.x)}" y1="${ty(wall.start.y)}" x2="${tx(wall.end.x)}" y2="${ty(wall.end.y)}" stroke="#1F2937" stroke-width="${thickness}" stroke-linecap="round"/>`,
		);
	}

	// Doors
	for (const door of floorplan.doors) {
		const wall = getWallById(floorplan.walls, door.wall_id);
		if (!wall) continue;
		const pos = getOpeningPosition(door, wall);
		const r = door.width_m * scale;
		parts.push(
			`<g transform="translate(${tx(pos.x)},${ty(pos.y)}) rotate(${pos.angle}) translate(${-r / 2},0)">`,
		);
		parts.push(
			`<path d="M 0 0 A ${r} ${r} 0 0 1 ${r} ${-r}" fill="none" stroke="#3B82F6" stroke-width="1.5"/>`,
		);
		parts.push(
			`<line x1="0" y1="0" x2="${r}" y2="0" stroke="#3B82F6" stroke-width="1.5"/>`,
		);
		parts.push(`</g>`);
	}

	// Windows
	for (const win of floorplan.windows) {
		const wall = getWallById(floorplan.walls, win.wall_id);
		if (!wall) continue;
		const pos = getOpeningPosition(win, wall);
		const halfW = (win.width_m * scale) / 2;
		parts.push(
			`<g transform="translate(${tx(pos.x)},${ty(pos.y)}) rotate(${pos.angle})">`,
		);
		parts.push(
			`<line x1="${-halfW}" y1="-3" x2="${halfW}" y2="-3" stroke="#60A5FA" stroke-width="2"/>`,
		);
		parts.push(
			`<line x1="${-halfW}" y1="3" x2="${halfW}" y2="3" stroke="#60A5FA" stroke-width="2"/>`,
		);
		parts.push(`</g>`);
	}

	// Dimension annotations
	for (const dim of floorplan.dimensions) {
		const x1 = tx(dim.start.x),
			y1 = ty(dim.start.y);
		const x2 = tx(dim.end.x),
			y2 = ty(dim.end.y);
		const mx = (x1 + x2) / 2,
			my = (y1 + y2) / 2;
		parts.push(
			`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="4 2"/>`,
		);
		parts.push(
			`<text x="${mx}" y="${my - 4}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6B7280">${escapeText(dim.label)}</text>`,
		);
	}

	parts.push(
		`<text x="12" y="${height - 10}" font-size="12" fill="#333">${document.source === "video" ? "Video estimates" : "LiDAR-derived dimensions"} · metres</text></svg>`,
	);

	return parts.join("\n");
}
