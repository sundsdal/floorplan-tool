"""LiveKit participant for guided floorplan capture."""

import json
import os

from livekit import rtc
from livekit.agents import (
    Agent, AgentServer, AgentSession, JobContext, cli, function_tool, room_io,
)
from livekit.plugins import google

from worker.review import ReviewCoordinator

INSTRUCTIONS = """You guide a person recording rooms for a floorplan. Speak briefly and clearly.
Use the live camera and conversation to guide a slow, complete sweep of walls, corners,
doors and windows. Ask for close views where geometry is unclear. Never invent measurements,
connections or observations. When more careful analysis of recorded geometry would help,
call review_geometry with the room, specific question, and requested time interval.
The interval ends seconds_ago before the tool call and lasts duration seconds.
For example, the preceding five seconds is seconds_ago=0, duration=5; five seconds
ending ten minutes ago is seconds_ago=600, duration=5. Continue helping while it runs.
Treat review findings as evidence, identify uncertainty, and suggest the next useful view.
Never claim that a pending or failed review succeeded."""


class Guide(Agent):
    def __init__(self, review: ReviewCoordinator):
        super().__init__(instructions=INSTRUCTIONS)
        self.review = review

    @function_tool()
    async def review_geometry(
        self, room: str, question: str, seconds_ago: float, duration: float
    ) -> str:
        """Start a background analysis of the recent recording for a specific geometry question.

        Args:
            room: Name or description of the room being reviewed.
            question: Specific question about the observed room geometry.
            seconds_ago: Seconds between now and the end of the desired interval.
            duration: Length of the desired interval in seconds, greater than zero and at most 60.
        """
        return await self.review.request(room, question, seconds_ago, duration)


def create_realtime_model():
    """Use Google Cloud credentials and the Enterprise Agent Platform Live API."""
    return google.realtime.RealtimeModel(
        model="gemini-3.8-live",
        vertexai=True,
        project=os.environ["GOOGLE_CLOUD_PROJECT"],
        location=os.environ.get("GOOGLE_CLOUD_LOCATION") or "us-central1",
    )


server = AgentServer()


@server.rtc_session(agent_name=os.environ.get("LIVEKIT_AGENT_NAME", "floorplan-guide"))
async def entrypoint(ctx: JobContext):
    metadata = json.loads(ctx.job.metadata)
    session_id = metadata["sessionId"]
    identity = metadata["participantIdentity"]
    token = metadata["reviewToken"]
    if not all(isinstance(value, str) and value for value in (session_id, identity, token)):
        raise ValueError("Invalid job metadata")
    if ctx.job.room.name != f"capture-{session_id}" or identity != f"capture-user-{session_id}":
        raise ValueError("Job metadata does not match the room")
    base_url = os.environ["FLOORPLAN_SERVER_URL"]
    session = AgentSession(llm=create_realtime_model())

    async def publish(value: dict):
        await ctx.room.local_participant.publish_data(
            json.dumps(value), reliable=True, destination_identities=[identity],
            topic="floorplan.finding",
        )

    review = ReviewCoordinator(
        base_url=base_url, token=token, session_id=session_id,
        participant_identity=identity, publish=publish,
    )

    @ctx.room.on("data_received")
    def on_data(packet: rtc.DataPacket):
        if packet.topic == "floorplan.recording":
            review.recording_packet(
                packet.data, packet.participant.identity if packet.participant else None
            )

    async def cleanup(_reason: str):
        await review.close()

    ctx.add_shutdown_callback(cleanup)
    await session.start(
        agent=Guide(review),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            participant_identity=identity, audio_input=True, video_input=True,
            text_input=True, audio_output=True, text_output=True,
        ),
    )
    session.generate_reply(
        instructions="Welcome the operator briefly and explain how to start a room walkthrough."
    )


def main():
    cli.run_app(server)


if __name__ == "__main__":
    main()
