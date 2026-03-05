import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export interface UploadedVideo {
  uri: string;
  mimeType: string;
}

export async function uploadVideo(filePath: string): Promise<UploadedVideo> {
  const mimeType = getMimeType(filePath);
  const file = await ai.files.upload({
    file: filePath,
    config: { mimeType },
  });

  if (!file.uri) {
    throw new Error("Upload failed: no file URI returned");
  }

  // Poll until the file is ready for use
  let fileState = file;
  while (fileState.state === "PROCESSING") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await ai.files.get({ name: fileState.name! });
    fileState = status;
  }

  if (fileState.state === "FAILED") {
    throw new Error(`Video processing failed: ${fileState.name}`);
  }

  return { uri: fileState.uri!, mimeType };
}

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    webm: "video/webm",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    wmv: "video/x-ms-wmv",
    "3gp": "video/3gpp",
    "3gpp": "video/3gpp",
  };
  return mimeTypes[ext || ""] || "video/mp4";
}
