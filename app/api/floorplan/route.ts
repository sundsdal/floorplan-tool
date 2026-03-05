import { NextRequest } from "next/server";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { uploadVideo } from "@/lib/gemini";
import { generateFloorplan, ProgressCallback } from "@/lib/agent";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/webm",
  "video/mpeg",
  "video/x-ms-wmv",
  "video/3gpp",
]);

export async function POST(request: NextRequest) {
  let tempPath: string | null = null;

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return new Response(
        JSON.stringify({ error: "Expected multipart/form-data" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const formData = await request.formData();
    const file = formData.get("video");

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: "No video file provided. Send a 'video' field." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
        }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return new Response(
        JSON.stringify({
          error: `Unsupported video format: ${file.type}. Supported: MP4, MOV, AVI, WebM, MPEG, WMV, 3GPP.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Save to temp file
    const tempDir = join(tmpdir(), "floorplan-tool");
    await mkdir(tempDir, { recursive: true });
    const ext = file.name.split(".").pop() || "mp4";
    tempPath = join(tempDir, `upload_${Date.now()}.${ext}`);
    const bytes = await file.arrayBuffer();
    await writeFile(tempPath, Buffer.from(bytes));

    // SSE stream
    const encoder = new TextEncoder();
    const startTime = Date.now();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              ...data,
              timestamp: new Date().toISOString(),
              elapsed_ms: Date.now() - startTime,
            })}\n\n`)
          );
        };

        try {
          // Upload to Gemini
          send({ type: "system", message: `Saving video to temp file (${(file.size / (1024 * 1024)).toFixed(1)}MB)...`, phase: "uploading" });
          send({ type: "system", message: `Uploading to Gemini File API...`, phase: "uploading" });
          const uploaded = await uploadVideo(tempPath!);
          send({ type: "system", message: `Finished uploading video to Gemini`, phase: "uploading" });
          send({ type: "system", message: `File URI: ${uploaded.uri}`, phase: "uploading" });
          send({ type: "system", message: "Initializing ADK agent (gemini-3.1-pro-preview)...", phase: "processing" });
          send({ type: "system", message: "Starting agentic floorplan extraction loop...", phase: "processing" });

          // Run agent with progress callbacks mapped to SSE status events
          const onProgress: ProgressCallback = (event) => {
            if (event.type === "skill") {
              const phaseMap: Record<string, string> = {
                spatial_mapping: "spatial_mapping",
                geometry_validation: "validating",
                room_labeling: "room_labeling",
              };
              send({
                type: "skill",
                phase: phaseMap[event.name] || "processing",
                message: `Skill activated: ${event.name}`,
                skill: event.name,
              });
            } else if (event.type === "tool") {
              const isSnapshot = event.name === "get_canvas_state";
              send({
                type: isSnapshot ? "snapshot" : "tool",
                phase: "processing",
                message: isSnapshot
                  ? "Taking canvas snapshot for visual inspection"
                  : `Tool call: ${event.name}`,
                tool: event.name,
                params: event.params,
              });
            } else if (event.type === "canvas_update") {
              send({
                type: "partial_update",
                floorplan: event.state,
                phase: "processing",
                message: "Building floorplan...",
              });
            }
          };

          const floorplan = await generateFloorplan(uploaded.uri, uploaded.mimeType, onProgress);

          send({ type: "result", floorplan, message: "Floorplan generation complete" });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error occurred";
          send({ type: "error", message });
        } finally {
          controller.close();
          // Clean up temp file
          if (tempPath) {
            unlink(tempPath).catch(() => {});
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    // Clean up temp file on unexpected errors
    if (tempPath) {
      unlink(tempPath).catch(() => {});
    }

    const message =
      err instanceof Error ? err.message : "Internal server error";
    const isGeminiError =
      err instanceof Error &&
      (err.message.includes("Gemini") || err.message.includes("GOOGLE"));

    return new Response(
      JSON.stringify({ error: message }),
      {
        status: isGeminiError ? 500 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
