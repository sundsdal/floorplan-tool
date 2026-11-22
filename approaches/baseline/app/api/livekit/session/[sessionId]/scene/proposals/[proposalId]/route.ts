import { z } from "zod";
import { SceneConflict, updateScene } from "@/lib/scene";
import { authorized, failure, mutationSchema } from "@/lib/scene-route";
export const runtime = "nodejs";
export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string; proposalId: string }> },
) {
	const { sessionId, proposalId } = await context.params;
	if (!authorized(request, sessionId))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		const input = mutationSchema
			.extend({ decision: z.enum(["accept", "reject"]) })
			.parse(await request.json());
		const scene = await updateScene(
			sessionId,
			input.baseRevision,
			input.requestId,
			(s) => {
				const proposal = s.proposals.find((p) => p.id === proposalId);
				if (!proposal || proposal.status !== "pending")
					throw new Error("Invalid proposal");
				if (
					input.decision === "accept" &&
					proposal.sourcePlan !== JSON.stringify(s.floorplan)
				)
					throw new SceneConflict("Proposal is stale");
				proposal.status = input.decision === "accept" ? "accepted" : "rejected";
				if (input.decision === "accept") {
					s.floorplan = proposal.floorplan;
					s.evidence.push(...proposal.evidence);
					const targets = proposal.targetId
						? [proposal.targetId]
						: [
								...s.floorplan.walls,
								...s.floorplan.doors,
								...s.floorplan.windows,
								...s.floorplan.rooms,
								...s.floorplan.dimensions,
							].map((x) => x.id);
					for (const id of targets) s.elementEvidence[id] = proposal.evidence;
				}
			},
		);
		return Response.json({ scene });
	} catch (e) {
		return failure(e);
	}
}
