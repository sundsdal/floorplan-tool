// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/lib/gemini", () => ({
  uploadVideo: vi.fn().mockResolvedValue({
    uri: "https://gemini.example.com/files/test",
    mimeType: "video/mp4",
  }),
}));

vi.mock("@/lib/agent", () => ({
  generateFloorplan: vi.fn().mockResolvedValue({
    walls: [],
    doors: [],
    windows: [],
    rooms: [],
    dimensions: [],
    total_area_m2: 0,
  }),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

import { POST } from "@/app/api/floorplan/route";

function createMultipartRequest(file?: File): NextRequest {
  const formData = new FormData();
  if (file) {
    formData.append("video", file);
  }
  return new NextRequest("http://localhost:3000/api/floorplan", {
    method: "POST",
    body: formData,
  });
}

function createJsonRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/floorplan", {
    method: "POST",
    body: JSON.stringify({ video: "test" }),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/floorplan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("input validation", () => {
    it("should return 400 for non-multipart request", async () => {
      const request = createJsonRequest();
      const response = await POST(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("multipart/form-data");
    });

    it("should return 400 when no video field is provided", async () => {
      const request = createMultipartRequest(); // no file
      const response = await POST(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("No video file");
    });

    it("should return 400 for unsupported video format", async () => {
      const file = new File(["data"], "test.txt", { type: "text/plain" });
      const request = createMultipartRequest(file);
      const response = await POST(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Unsupported video format");
    });

    it("should return 413 for file exceeding size limit", async () => {
      const bigFile = new File(["x"], "big.mp4", { type: "video/mp4" });
      Object.defineProperty(bigFile, "size", { value: 600 * 1024 * 1024, configurable: true });

      const request = new NextRequest("http://localhost:3000/api/floorplan", {
        method: "POST",
        body: new FormData(), // dummy body to set content-type
      });
      // Mock formData() to return a FormData-like object that preserves our size override
      const mockFd = { get: vi.fn().mockReturnValue(bigFile) } as unknown as FormData;
      vi.spyOn(request, "formData").mockResolvedValue(mockFd);

      const response = await POST(request);
      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.error).toContain("too large");
    });
  });

  describe("SSE response", () => {
    it("should return text/event-stream content type for valid request", async () => {
      const file = new File(["videodata"], "test.mp4", { type: "video/mp4" });
      const request = createMultipartRequest(file);
      const response = await POST(request);

      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    });

    it("should stream SSE events in correct format", async () => {
      const file = new File(["videodata"], "test.mp4", { type: "video/mp4" });
      const request = createMultipartRequest(file);
      const response = await POST(request);

      const text = await response.text();
      const events = text
        .split("\n\n")
        .filter((e) => e.startsWith("data: "))
        .map((e) => JSON.parse(e.replace("data: ", "")));

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe("system");
      expect(events[0].timestamp).toBeDefined();
      expect(events[0].elapsed_ms).toBeDefined();

      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe("result");
      expect(lastEvent.floorplan).toBeDefined();
    });
  });

  describe("supported formats", () => {
    const formats = [
      { ext: "mp4", mime: "video/mp4" },
      { ext: "mov", mime: "video/quicktime" },
      { ext: "webm", mime: "video/webm" },
      { ext: "avi", mime: "video/x-msvideo" },
      { ext: "3gp", mime: "video/3gpp" },
    ];

    for (const { ext, mime } of formats) {
      it(`should accept .${ext} files (${mime})`, async () => {
        const file = new File(["data"], `test.${ext}`, { type: mime });
        const request = createMultipartRequest(file);
        const response = await POST(request);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      });
    }
  });
});
