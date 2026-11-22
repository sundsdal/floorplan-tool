import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LiveCapture from "@/components/live-capture";

class FakeMediaRecorder {
	static isTypeSupported = vi.fn(() => true);
	state = "inactive";
	mimeType = "video/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	start() {
		this.state = "recording";
	}
	stop() {
		this.ondataavailable?.({
			data: new Blob(["recorded video"], { type: this.mimeType }),
		});
		this.state = "inactive";
		this.onstop?.();
	}
}

class FakeWebSocket {
	static OPEN = 1;
	readyState = 0;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string | Blob }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(_url: string) {
		FakeWebSocket.instance = this;
	}
	static instance: FakeWebSocket;
	send(message: string) {
		this.sent.push(message);
	}
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	message(data: unknown) {
		this.onmessage?.({
			data:
				typeof data === "string" || data instanceof Blob
					? data
					: JSON.stringify(data),
		});
	}
}

describe("LiveCapture", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("keeps recording while Live guidance connects and returns the complete clip", async () => {
		const stopTrack = vi.fn();
		const stream = {
			getTracks: () => [{ stop: stopTrack }],
		} as unknown as MediaStream;
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ token: "short-lived", model: "gemini-live" }),
			}),
		);
		vi.stubGlobal("navigator", {
			...navigator,
			mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
		});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
		const onCapture = vi.fn();

		render(<LiveCapture onCapture={onCapture} />);
		fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Stop recording" }),
			).toBeInTheDocument(),
		);
		await waitFor(() => expect(FakeWebSocket.instance).toBeDefined());
		act(() => FakeWebSocket.instance.open());
		expect(JSON.parse(FakeWebSocket.instance.sent[0])).toMatchObject({
			setup: { model: "models/gemini-live" },
		});
		await act(async () => {
			FakeWebSocket.instance.message({ setupComplete: {} });
			FakeWebSocket.instance.message(
				new Blob([
					JSON.stringify({
						serverContent: {
							outputTranscription: { text: "Show the hallway doorway." },
						},
					}),
				]),
			);
			await Promise.resolve();
		});
		expect(
			await screen.findByText("Show the hallway doorway."),
		).toBeInTheDocument();

		fireEvent.change(
			screen.getByRole("textbox", { name: "Ask the live guide" }),
			{ target: { value: "What should I film?" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(
			FakeWebSocket.instance.sent.map((message) => JSON.parse(message)),
		).toContainEqual({ realtimeInput: { text: "What should I film?" } });

		act(() => FakeWebSocket.instance.close());
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Recording continues",
		);
		expect(
			screen.getByRole("button", { name: "Stop recording" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

		await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
		const clip = onCapture.mock.calls[0][0] as File;
		expect(clip).toBeInstanceOf(File);
		expect(clip.type).toBe("video/webm");
		expect(clip.name).toMatch(/^walkthrough-\d+\.webm$/);
		expect(onCapture.mock.calls[0][1]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					speaker: "guide",
					text: "Show the hallway doorway.",
				}),
				expect.objectContaining({
					speaker: "user",
					text: "What should I film?",
				}),
			]),
		);
		expect(stopTrack).toHaveBeenCalledOnce();
	});

	it("shows a clear error when camera access is denied", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		vi.stubGlobal("navigator", {
			...navigator,
			mediaDevices: {
				getUserMedia: vi.fn().mockRejectedValue(new Error("Permission denied")),
			},
		});

		render(<LiveCapture onCapture={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Permission denied",
		);
	});
});
