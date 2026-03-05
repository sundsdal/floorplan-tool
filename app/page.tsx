"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import type Konva from "konva";
import type { FloorplanState, GenerationStatus, DebugLogEntry } from "@/lib/types";
import { exportPNG, exportSVG } from "@/lib/export";

const FloorplanCanvas = dynamic(() => import("@/components/canvas"), { ssr: false });

const ACCEPTED_FORMATS = ".mp4,.mov,.avi,.webm,.mpeg,.wmv,.3gpp,.3gp";
const ACCEPTED_MIME = [
  "video/mp4", "video/quicktime", "video/x-msvideo", "video/webm",
  "video/mpeg", "video/x-ms-wmv", "video/3gpp",
];

const EMPTY_FLOORPLAN: FloorplanState = {
  walls: [], doors: [], windows: [], rooms: [], dimensions: [],
  total_area_m2: 0,
};

const CATEGORY_STYLES: Record<DebugLogEntry["category"], { icon: string; color: string; bg: string }> = {
  system:   { icon: "SYS",  color: "text-gray-500",  bg: "bg-gray-100" },
  skill:    { icon: "SKILL", color: "text-purple-600", bg: "bg-purple-100" },
  tool:     { icon: "TOOL", color: "text-blue-600",   bg: "bg-blue-100" },
  snapshot: { icon: "SNAP", color: "text-amber-600",  bg: "bg-amber-100" },
  result:   { icon: "DONE", color: "text-green-600",  bg: "bg-green-100" },
  error:    { icon: "ERR",  color: "text-red-600",    bg: "bg-red-100" },
};

function DebugPanel({
  logs,
  isOpen,
  onToggle,
}: {
  logs: DebugLogEntry[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className={`flex flex-col border-l border-gray-200 bg-gray-900 text-gray-100 transition-all duration-300 ${isOpen ? "w-[420px]" : "w-10"}`}>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="flex items-center justify-center h-10 border-b border-gray-700 hover:bg-gray-800 transition-colors cursor-pointer shrink-0"
        title={isOpen ? "Collapse debug panel" : "Expand debug panel"}
      >
        {isOpen ? (
          <span className="text-xs font-mono text-gray-400 flex items-center gap-2">
            DEBUG LOG ({logs.length})
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        ) : (
          <span className="text-xs font-mono text-gray-400 [writing-mode:vertical-lr] rotate-180 py-2">
            DEBUG ({logs.length})
          </span>
        )}
      </button>

      {isOpen && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-xs">
          {logs.length === 0 && (
            <div className="p-4 text-gray-500 text-center">No events yet. Upload a video and click Generate.</div>
          )}
          {logs.map((entry) => {
            const style = CATEGORY_STYLES[entry.category];
            const isExpanded = expandedIds.has(entry.id);
            return (
              <div
                key={entry.id}
                className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors"
              >
                <div
                  className="flex items-start gap-2 px-3 py-2 cursor-pointer"
                  onClick={() => entry.detail && toggleExpand(entry.id)}
                >
                  {/* Timestamp */}
                  <span className="text-gray-500 shrink-0 tabular-nums w-16 text-right">
                    {(entry.elapsed_ms / 1000).toFixed(1)}s
                  </span>
                  {/* Category badge */}
                  <span className={`${style.bg} ${style.color} px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 w-12 text-center`}>
                    {style.icon}
                  </span>
                  {/* Message */}
                  <span className="text-gray-200 break-words min-w-0">
                    {entry.label}
                    {entry.detail && (
                      <span className="text-gray-500 ml-1">{isExpanded ? "▼" : "▶"}</span>
                    )}
                  </span>
                </div>
                {/* Expanded detail */}
                {isExpanded && entry.detail && (
                  <pre className="px-3 pb-2 ml-[7.5rem] text-[10px] text-gray-400 whitespace-pre-wrap break-all">{entry.detail}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: GenerationStatus }) {
  const colorMap: Record<GenerationStatus["phase"], string> = {
    uploading: "bg-yellow-100 text-yellow-800",
    processing: "bg-blue-100 text-blue-800",
    spatial_mapping: "bg-indigo-100 text-indigo-800",
    validating: "bg-orange-100 text-orange-800",
    room_labeling: "bg-purple-100 text-purple-800",
    complete: "bg-green-100 text-green-800",
    error: "bg-red-100 text-red-800",
  };
  const colors = colorMap[status.phase] || "bg-gray-100 text-gray-800";

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${colors}`}>
      {status.phase !== "complete" && status.phase !== "error" && (
        <span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
      )}
      <span>{status.message}</span>
    </div>
  );
}

export default function Home() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [floorplan, setFloorplan] = useState<FloorplanState>(EMPTY_FLOORPLAN);
  const [status, setStatus] = useState<GenerationStatus | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(true);

  const stageRef = useRef<Konva.Stage>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logIdRef = useRef(0);

  const hasFloorplan = floorplan.walls.length > 0;
  const isGenerating = status !== null && status.phase !== "complete" && status.phase !== "error";

  const formatParams = (params?: Record<string, unknown>) => {
    if (!params || Object.keys(params).length === 0) return "";
    return Object.entries(params)
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null) return `${k}: {${Object.entries(v as Record<string, unknown>).map(([sk, sv]) => `${sk}:${sv}`).join(", ")}}`;
        return `${k}: ${v}`;
      })
      .join(", ");
  };

  const handleFile = useCallback((file: File) => {
    if (!ACCEPTED_MIME.includes(file.type) && !file.name.match(/\.(mp4|mov|avi|webm|mpeg|wmv|3gpp|3gp)$/i)) {
      alert("Unsupported video format. Please use MP4, MOV, AVI, WebM, MPEG, WMV, or 3GPP.");
      return;
    }
    setVideoFile(file);
    setStatus(null);
    setFloorplan(EMPTY_FLOORPLAN);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!videoFile) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus({ phase: "uploading", message: "Uploading video..." });
    setFloorplan(EMPTY_FLOORPLAN);
    setDebugLogs([]);
    logIdRef.current = 0;

    const addLog = (category: DebugLogEntry["category"], label: string, detail?: string, elapsed_ms?: number) => {
      setDebugLogs((prev) => [...prev, {
        id: ++logIdRef.current,
        timestamp: new Date().toISOString(),
        elapsed_ms: elapsed_ms ?? 0,
        category,
        label,
        detail,
      }]);
    };

    addLog("system", `Starting generation for ${videoFile.name} (${(videoFile.size / (1024 * 1024)).toFixed(1)}MB)`);

    try {
      const formData = new FormData();
      formData.append("video", videoFile);

      const response = await fetch("/api/floorplan", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Server error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);
            const elapsed = event.elapsed_ms ?? 0;

            if (event.type === "system") {
              setStatus({ phase: event.phase || "processing", message: event.message });
              addLog("system", event.message, undefined, elapsed);
            } else if (event.type === "skill") {
              setStatus({
                phase: event.phase,
                message: event.message,
                skill: event.skill,
              });
              addLog("skill", event.message, undefined, elapsed);
            } else if (event.type === "tool") {
              setStatus({
                phase: event.phase || "processing",
                message: event.message,
                tool: event.tool,
              });
              addLog("tool", `${event.tool}(${formatParams(event.params)})`, event.params ? JSON.stringify(event.params, null, 2) : undefined, elapsed);
            } else if (event.type === "snapshot") {
              setStatus({
                phase: "processing",
                message: event.message,
                tool: "get_canvas_state",
              });
              addLog("snapshot", "Canvas snapshot captured for visual inspection", undefined, elapsed);
            } else if (event.type === "partial_update") {
              setFloorplan(event.floorplan);
            } else if (event.type === "result") {
              setFloorplan(event.floorplan);
              setStatus({ phase: "complete", message: "Floorplan generated successfully" });
              const summary = `${event.floorplan.rooms?.length ?? 0} rooms, ${event.floorplan.walls?.length ?? 0} walls, ${event.floorplan.doors?.length ?? 0} doors, ${event.floorplan.windows?.length ?? 0} windows, ${event.floorplan.total_area_m2?.toFixed(1) ?? 0}m²`;
              addLog("result", `Generation complete: ${summary}`, JSON.stringify(event.floorplan, null, 2), elapsed);
            } else if (event.type === "error") {
              setStatus({ phase: "error", message: event.message || "Generation failed" });
              addLog("error", event.message || "Unknown error", undefined, elapsed);
            } else if (event.type === "status") {
              // Legacy status events
              setStatus({ phase: event.phase, message: event.message, skill: event.skill, tool: event.tool });
              addLog("system", event.message, undefined, elapsed);
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const errMsg = err instanceof Error ? err.message : "An unexpected error occurred";
      setStatus({ phase: "error", message: errMsg });
      addLog("error", errMsg);
    }
  }, [videoFile]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shrink-0">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900">FloorPlan AI</h1>
          </div>
        </div>
      </header>

      {/* Main content + Debug panel side by side */}
      <div className="flex flex-1 min-h-0">
      <main className="flex-1 overflow-y-auto px-6 py-8 space-y-6">
        {/* Upload Zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
          className={`
            relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all
            ${isDragging
              ? "border-indigo-500 bg-indigo-50"
              : videoFile
                ? "border-green-300 bg-green-50"
                : "border-gray-300 bg-white hover:border-indigo-400 hover:bg-indigo-50/30"
            }
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FORMATS}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            className="hidden"
          />

          {videoFile ? (
            <div className="space-y-2">
              <div className="w-12 h-12 mx-auto bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">{videoFile.name}</p>
              <p className="text-xs text-gray-500">{(videoFile.size / (1024 * 1024)).toFixed(1)} MB</p>
              <p className="text-xs text-indigo-600">Click or drop to replace</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="w-12 h-12 mx-auto bg-gray-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-700">Drop your walkthrough video here</p>
              <p className="text-xs text-gray-400">or click to browse -- MP4, MOV, AVI, WebM, MPEG, WMV, 3GPP</p>
            </div>
          )}
        </div>

        {/* Generate Button + Status */}
        <div className="flex items-center gap-4">
          <button
            onClick={handleGenerate}
            disabled={!videoFile || isGenerating}
            className={`
              px-6 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer
              ${!videoFile || isGenerating
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm hover:shadow"
              }
            `}
          >
            {isGenerating ? "Generating..." : "Generate Floorplan"}
          </button>

          {status && <StatusBadge status={status} />}
        </div>

        {/* Canvas Area */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" style={{ height: "540px" }}>
          {hasFloorplan ? (
            <FloorplanCanvas floorplan={floorplan} stageRef={stageRef} />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-400">
              <div className="text-center space-y-2">
                <svg className="w-16 h-16 mx-auto text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                </svg>
                <p className="text-sm">Your floorplan will appear here</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer bar: summary + export */}
        {hasFloorplan && (
          <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-4">
            <div className="flex items-center gap-6 text-sm text-gray-600">
              <span>
                <span className="font-semibold text-gray-900">{floorplan.rooms.length}</span> rooms
              </span>
              <span>
                <span className="font-semibold text-gray-900">{floorplan.total_area_m2.toFixed(1)}</span> m&sup2; total
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { if (stageRef.current) exportPNG(stageRef.current); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors cursor-pointer"
              >
                Export PNG
              </button>
              <button
                onClick={() => exportSVG(floorplan)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors cursor-pointer"
              >
                Export SVG
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Debug Panel (right side) */}
      <DebugPanel
        logs={debugLogs}
        isOpen={debugOpen}
        onToggle={() => setDebugOpen((prev) => !prev)}
      />
      </div>

    </div>
  );
}
