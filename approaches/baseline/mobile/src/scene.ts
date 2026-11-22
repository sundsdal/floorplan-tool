export type Scene = {
	revision: number;
	floorplan: import("../../lib/types").FloorplanState;
	nodes: Record<string, unknown>;
	proposals: { id: string; [key: string]: unknown }[];
	evidence: unknown[];
};
