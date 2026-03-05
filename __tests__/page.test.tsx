import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, fireEvent, screen, waitFor, act } from "@testing-library/react";

// Mock next/dynamic to just render the component directly
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<any>) => {
    const Component = React.lazy(loader);
    return function DynamicWrapper(props: any) {
      return (
        <React.Suspense fallback={null}>
          <Component {...props} />
        </React.Suspense>
      );
    };
  },
}));

// Mock react-konva
vi.mock("react-konva", () => {
  const createMockComponent = (name: string) =>
    React.forwardRef(({ children, ...props }: any, ref: any) => (
      <div data-testid={`konva-${name.toLowerCase()}`} ref={ref}>{children}</div>
    ));
  return {
    Stage: createMockComponent("Stage"),
    Layer: createMockComponent("Layer"),
    Line: () => <div data-testid="konva-line" />,
    Arc: () => <div data-testid="konva-arc" />,
    Text: ({ text }: any) => <div data-testid="konva-text">{text}</div>,
    Group: ({ children }: any) => <div data-testid="konva-group">{children}</div>,
    Rect: () => <div data-testid="konva-rect" />,
  };
});

import Home from "@/app/page";

describe("Home page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the header with FloorPlan AI title", () => {
    render(<Home />);
    expect(screen.getByText("FloorPlan AI")).toBeInTheDocument();
  });

  it("renders upload zone with instruction text", () => {
    render(<Home />);
    expect(screen.getByText("Drop your walkthrough video here")).toBeInTheDocument();
    expect(screen.getByText(/or click to browse/)).toBeInTheDocument();
  });

  it("renders Generate button disabled when no video selected", () => {
    render(<Home />);
    const btn = screen.getByText("Generate Floorplan");
    expect(btn).toBeDisabled();
  });

  it("renders placeholder canvas area", () => {
    render(<Home />);
    expect(screen.getByText("Your floorplan will appear here")).toBeInTheDocument();
  });

  it("does not show export buttons when no floorplan", () => {
    render(<Home />);
    expect(screen.queryByText("Export PNG")).not.toBeInTheDocument();
    expect(screen.queryByText("Export SVG")).not.toBeInTheDocument();
  });
});

describe("File upload handling", () => {
  it("accepts valid video file via file input", async () => {
    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain(".mp4");
    expect(input.accept).toContain(".mov");
    expect(input.accept).toContain(".webm");

    const file = new File(["video content"], "walkthrough.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(screen.getByText("walkthrough.mp4")).toBeInTheDocument();
    expect(screen.getByText("Generate Floorplan")).not.toBeDisabled();
  });

  it("shows file info after selecting a video", async () => {
    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x".repeat(1024 * 1024 * 5)], "tour.mov", { type: "video/quicktime" });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(screen.getByText("tour.mov")).toBeInTheDocument();
    expect(screen.getByText("Click or drop to replace")).toBeInTheDocument();
  });

  it("rejects unsupported file types with alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["text"], "readme.txt", { type: "text/plain" });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported video format"));
    // Should NOT show the file as selected
    expect(screen.queryByText("readme.txt")).not.toBeInTheDocument();
    expect(screen.getByText("Generate Floorplan")).toBeDisabled();
  });

  it("handles drag-and-drop", async () => {
    render(<Home />);
    const dropZone = screen.getByText("Drop your walkthrough video here").closest("div")!;

    // Drag over should change styling
    await act(async () => {
      fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });
    });

    // Drop a valid file
    const file = new File(["video"], "room.webm", { type: "video/webm" });
    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    });

    expect(screen.getByText("room.webm")).toBeInTheDocument();
  });
});

describe("SSE event parsing (Generate flow)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createSSEResponse(events: string[]) {
    const encoded = new TextEncoder().encode(events.join("\n") + "\n");
    let read = false;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (!read) {
              read = true;
              return { done: false, value: encoded };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    };
  }

  it("shows status updates from SSE stream", async () => {
    const response = createSSEResponse([
      'data: {"type":"status","phase":"processing","message":"Uploading video to Gemini..."}',
      'data: {"type":"status","phase":"identifying_rooms","message":"Identifying rooms...","skill":"room_identification"}',
      'data: {"type":"status","phase":"complete","message":"Floorplan generated successfully"}',
    ]);
    fetchMock.mockResolvedValueOnce(response);

    render(<Home />);

    // Select a file first
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    // Click generate
    await act(async () => {
      fireEvent.click(screen.getByText("Generate Floorplan"));
    });

    await waitFor(() => {
      expect(screen.getAllByText("Floorplan generated successfully").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows error status when SSE sends error event", async () => {
    const response = createSSEResponse([
      'data: {"type":"error","message":"Video processing failed","timestamp":"2026-03-05T00:00:00Z","elapsed_ms":1000}',
    ]);
    fetchMock.mockResolvedValueOnce(response);

    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generate Floorplan"));
    });

    await waitFor(() => {
      expect(screen.getAllByText("Video processing failed").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("handles fetch failure gracefully", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generate Floorplan"));
    });

    await waitFor(() => {
      expect(screen.getAllByText("Network error").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("handles HTTP error response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generate Floorplan"));
    });

    await waitFor(() => {
      expect(screen.getAllByText("Internal Server Error").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("displays skill and tool events in debug panel", async () => {
    const response = createSSEResponse([
      'data: {"type":"skill","phase":"identifying_rooms","message":"Skill activated: room_identification","skill":"room_identification","timestamp":"2026-03-05T00:00:00Z","elapsed_ms":1000}',
      'data: {"type":"tool","phase":"processing","message":"Tool call: draw_wall","tool":"draw_wall","params":{"start":{"x":0,"y":0},"end":{"x":3,"y":0}},"timestamp":"2026-03-05T00:00:01Z","elapsed_ms":2000}',
    ]);
    fetchMock.mockResolvedValueOnce(response);

    render(<Home />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Generate Floorplan"));
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Skill activated: room_identification/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/draw_wall/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("sends correct form data to API", async () => {
    const response = createSSEResponse([
      'data: {"type":"status","phase":"complete","message":"Done"}',
    ]);
    fetchMock.mockResolvedValueOnce(response);

    render(<Home />);

    // Select file and generate
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Generate Floorplan"));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/floorplan",
      expect.objectContaining({ method: "POST" }),
    );
    const formData = fetchMock.mock.calls[0][1].body as FormData;
    expect(formData.get("video")).toBeTruthy();
  });
});
