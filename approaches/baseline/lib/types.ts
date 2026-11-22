export * from "@floorplan/core";
export interface GenerationStatus {
	phase:
		| "uploading"
		| "processing"
		| "spatial_mapping"
		| "validating"
		| "room_labeling"
		| "complete"
		| "error";
	message: string;
	skill?: string;
	tool?: string;
	progress?: number;
}

export interface DebugLogEntry {
	id: number;
	timestamp: string; // ISO string from server
	elapsed_ms: number; // ms since generation started
	category: "system" | "skill" | "tool" | "snapshot" | "result" | "error";
	label: string; // short display label
	detail?: string; // expanded detail (JSON params, etc.)
}
