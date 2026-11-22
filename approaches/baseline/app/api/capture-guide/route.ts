import { Behavior, GoogleGenAI, Modality, Type } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request?: Request) {
	let mobile = false;
	if (request?.headers.get("content-type")?.includes("application/json")) {
		try {
			mobile = (await request.json()).mobile === true;
		} catch {
			return NextResponse.json({ error: "Invalid request." }, { status: 400 });
		}
	}
	if (!process.env.GEMINI_API_KEY)
		return NextResponse.json(
			{ error: "GEMINI_API_KEY is not configured." },
			{ status: 503 },
		);
	try {
		const model = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
		const ai = new GoogleGenAI({
			apiKey: process.env.GEMINI_API_KEY,
			httpOptions: { apiVersion: "v1beta" },
		});
		const token = await ai.authTokens.create({
			config: {
				uses: 1,
				expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
				newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
				liveConnectConstraints: {
					model,
					config: {
						responseModalities: [Modality.AUDIO],
						...(mobile
							? {
									tools: [
										{
											functionDeclarations: [
												{
													name: "review_geometry",
													description:
														"Review a recorded segment for an uncertain room, doorway, or geometry while filming continues.",
													behavior: Behavior.NON_BLOCKING,
													parameters: {
														type: Type.OBJECT,
														properties: {
															room: { type: Type.STRING },
															question: { type: Type.STRING },
															startSeconds: { type: Type.NUMBER },
															endSeconds: { type: Type.NUMBER },
														},
														required: [
															"room",
															"question",
															"startSeconds",
															"endSeconds",
														],
													},
												},
											],
										},
									],
								}
							: {}),
					},
				},
			},
		});
		if (!token.name) throw new Error("No token returned");
		return NextResponse.json({ token: token.name, model });
	} catch (error) {
		console.error("Live token creation failed", error);
		return NextResponse.json(
			{ error: "Live guidance is unavailable. You can continue recording." },
			{ status: 502 },
		);
	}
}
