"use client";

import { useEffect, useRef, useState } from "react";
import type { VideoEvidence } from "@/lib/evidence";

export default function EvidencePanel({ file, evidence, warnings }: { file: File; evidence: VideoEvidence | null; warnings: string[] }) {
  const [url, setUrl] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const timestamp = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  const seek = (seconds: number) => { if (videoRef.current) { videoRef.current.currentTime = seconds; void videoRef.current.play().catch(() => {}); } };
  return <section className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
    <h2 className="font-semibold text-gray-900">Walkthrough evidence</h2>
    {url && <video ref={videoRef} src={url} controls className="w-full max-h-80 rounded-lg bg-black" />}
    {evidence && <>
      {evidence.clips.length > 0 && <div><h3 className="text-sm font-semibold">Observed clips</h3><ul className="mt-2 space-y-2">{evidence.clips.map((clip, index) => <li key={`${clip.start_s}-${index}`} className="text-sm text-gray-700"><button type="button" onClick={() => seek(clip.start_s)} className="font-medium text-indigo-700 underline">{timestamp(clip.start_s)}–{timestamp(clip.end_s)}</button> <strong>{clip.room}:</strong> {clip.observation}</li>)}</ul></div>}
      {evidence.gaps.length > 0 && <div><h3 className="text-sm font-semibold">Coverage gaps</h3><ul className="list-disc pl-5 text-sm text-gray-700">{evidence.gaps.map((gap, index) => <li key={`${gap}-${index}`}>{gap}</li>)}</ul></div>}
      {evidence.room_bounds?.length > 0 && <div><h3 className="text-sm font-semibold">Estimated room bounds</h3><ul className="list-disc pl-5 text-sm text-gray-700">{evidence.room_bounds.map((bound, index) => <li key={`${bound.room}-${index}`}>{bound.room}: {bound.width_m.min}–{bound.width_m.max} m × {bound.length_m.min}–{bound.length_m.max} m{bound.height_m && `; height ${bound.height_m.min}–${bound.height_m.max} m`}{bound.scale_reference && `; scale reference: ${bound.scale_reference}`}</li>)}</ul></div>}
      {evidence.discrepancies?.length > 0 && <div><h3 className="text-sm font-semibold">Plan discrepancies</h3><ul className="list-disc pl-5 text-sm text-amber-800">{evidence.discrepancies.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>}
    </>}
    {warnings.length > 0 && <div><h3 className="text-sm font-semibold">Warnings</h3><ul className="list-disc pl-5 text-sm text-amber-800">{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div>}
  </section>;
}
