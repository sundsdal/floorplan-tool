import { createDocument, renderSVG } from "@floorplan/core";
import type { Scene } from "./scene";

export function finalScene(
	old: Scene | undefined,
	floorplan: Scene["floorplan"],
	revision: number,
): Scene {
	if (old && old.revision > revision) return old;
	return {
		revision: old?.revision ?? 0,
		floorplan,
		nodes: old?.nodes ?? {},
		proposals: old?.proposals ?? [],
		evidence: old?.evidence ?? [],
	};
}

export function reviewDocument(
	scene: Scene | undefined,
	warnings: string[] | null,
) {
	if (!scene || warnings === null) return null;
	const document = createDocument(scene.floorplan, "video");
	return { ...document, warnings };
}

export function exportReview(
	document: NonNullable<ReturnType<typeof reviewDocument>>,
	format: "svg" | "json",
) {
	return format === "svg"
		? renderSVG(document)
		: JSON.stringify(document, null, 2);
}
