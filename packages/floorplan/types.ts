export interface Point {
	x: number;
	y: number;
}

export interface Wall {
	id: string;
	start: Point;
	end: Point;
	thickness_m: number;
	height_m: number;
	length_m: number;
}

export interface Door {
	id: string;
	wall_id: string;
	position_along_m: number;
	width_m: number;
	type: "standard" | "sliding" | "opening";
}

export interface Window {
	id: string;
	wall_id: string;
	position_along_m: number;
	width_m: number;
	sill_height_m: number;
}

export interface Room {
	id: string;
	name: string;
	type: RoomType;
	width_m: number;
	length_m: number;
	height_m: number;
	polygon: [number, number][];
	walls: string[]; // wall IDs
	label_point?: [number, number]; // original point passed to label_room
}

export type RoomType =
	| "bedroom"
	| "kitchen"
	| "bathroom"
	| "living_room"
	| "dining_room"
	| "hallway"
	| "closet"
	| "balcony"
	| "office"
	| "laundry"
	| "garage"
	| "basement"
	| "stairs"
	| "attic"
	| "other";

export interface DimensionAnnotation {
	id: string;
	start: Point;
	end: Point;
	label: string;
}

export interface FloorplanState {
	walls: Wall[];
	doors: Door[];
	windows: Window[];
	rooms: Room[];
	dimensions: DimensionAnnotation[];
	total_area_m2: number;
}

export const ROOM_COLORS: Record<RoomType, string> = {
	bedroom: "#93C5FD",
	kitchen: "#FCD34D",
	bathroom: "#6EE7B7",
	living_room: "#C4B5FD",
	dining_room: "#FCA5A5",
	hallway: "#D1D5DB",
	closet: "#FDBA74",
	balcony: "#A7F3D0",
	office: "#A5B4FC",
	laundry: "#67E8F9",
	garage: "#9CA3AF",
	basement: "#78716C",
	stairs: "#D6D3D1",
	attic: "#FDE68A",
	other: "#E5E7EB",
};
