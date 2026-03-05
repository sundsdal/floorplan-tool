import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures these are available during vi.mock hoisting
const mockUpload = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: class {
      files = {
        upload: mockUpload,
        get: mockGet,
      };
    },
  };
});

import { uploadVideo } from "@/lib/gemini";

describe("uploadVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should upload a video and return uri + mimeType when immediately ACTIVE", async () => {
    mockUpload.mockResolvedValue({
      uri: "https://gemini.example.com/files/abc123",
      name: "files/abc123",
      state: "ACTIVE",
      mimeType: "video/mp4",
    });

    const result = await uploadVideo("/tmp/test.mp4");
    expect(result).toEqual({
      uri: "https://gemini.example.com/files/abc123",
      mimeType: "video/mp4",
    });
    expect(mockUpload).toHaveBeenCalledWith({
      file: "/tmp/test.mp4",
      config: { mimeType: "video/mp4" },
    });
  });

  it("should poll until file is ACTIVE", async () => {
    mockUpload.mockResolvedValue({
      uri: "https://gemini.example.com/files/poll1",
      name: "files/poll1",
      state: "PROCESSING",
    });

    mockGet
      .mockResolvedValueOnce({ state: "PROCESSING", name: "files/poll1" })
      .mockResolvedValueOnce({
        state: "ACTIVE",
        uri: "https://gemini.example.com/files/poll1",
        name: "files/poll1",
      });

    const result = await uploadVideo("/tmp/test.mp4");
    expect(result.uri).toBe("https://gemini.example.com/files/poll1");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("should throw when upload returns no URI", async () => {
    mockUpload.mockResolvedValue({
      name: "files/noUri",
      state: "ACTIVE",
    });

    await expect(uploadVideo("/tmp/test.mp4")).rejects.toThrow(
      "Upload failed: no file URI returned"
    );
  });

  it("should throw when file processing fails", async () => {
    mockUpload.mockResolvedValue({
      uri: "https://gemini.example.com/files/fail1",
      name: "files/fail1",
      state: "PROCESSING",
    });

    mockGet.mockResolvedValueOnce({
      state: "FAILED",
      name: "files/fail1",
    });

    await expect(uploadVideo("/tmp/test.mp4")).rejects.toThrow(
      "Video processing failed"
    );
  });

  it("should detect correct MIME types from file extensions", async () => {
    const testCases = [
      { file: "/tmp/video.mov", expected: "video/quicktime" },
      { file: "/tmp/video.webm", expected: "video/webm" },
      { file: "/tmp/video.avi", expected: "video/x-msvideo" },
      { file: "/tmp/video.3gp", expected: "video/3gpp" },
      { file: "/tmp/video.unknown", expected: "video/mp4" }, // default
    ];

    for (const { file, expected } of testCases) {
      mockUpload.mockResolvedValue({
        uri: "https://gemini.example.com/files/test",
        name: "files/test",
        state: "ACTIVE",
      });

      await uploadVideo(file);
      expect(mockUpload).toHaveBeenLastCalledWith({
        file,
        config: { mimeType: expected },
      });
    }
  });
});
