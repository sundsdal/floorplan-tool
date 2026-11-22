import {
	createDocument,
	type FloorplanDocument,
	renderSVG,
} from "@floorplan/core";
import type Konva from "konva";
import type { FloorplanState } from "./types";

function download(uri: string, filename: string) {
	const link = document.createElement("a");
	link.download = filename;
	link.href = uri;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

export function exportPNG(
	stage: Konva.Stage,
	filename = "floorplan.png",
	source?: FloorplanDocument["source"],
) {
	if (!source) {
		download(
			stage.toDataURL({ pixelRatio: 2, mimeType: "image/png" }),
			filename,
		);
		return;
	}
	const plan = stage.toCanvas({ pixelRatio: 2 });
	const canvas = document.createElement("canvas");
	canvas.width = plan.width;
	canvas.height = plan.height + 60;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Could not create PNG export");
	context.fillStyle = "white";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(plan, 0, 0);
	context.fillStyle = "#333";
	context.font = "24px sans-serif";
	context.fillText(
		`${source === "video" ? "Video estimates" : "LiDAR-derived dimensions"} · metres`,
		24,
		plan.height + 38,
	);
	download(canvas.toDataURL("image/png"), filename);
}

export function exportSVG(
	floorplan: FloorplanState,
	scale = 50,
	filename = "floorplan.svg",
	source: FloorplanDocument["source"] = "video",
) {
	const blob = new Blob([renderSVG(createDocument(floorplan, source), scale)], {
		type: "image/svg+xml",
	});
	const url = URL.createObjectURL(blob);
	download(url, filename);
	URL.revokeObjectURL(url);
}
