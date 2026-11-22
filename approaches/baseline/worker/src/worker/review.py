"""Background review coordination, independent of the media provider."""

import asyncio
import json
import math
import time
import uuid
from collections.abc import Awaitable, Callable

import httpx


class ReviewCoordinator:
    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        session_id: str,
        participant_identity: str,
        publish: Callable[[dict], Awaitable[None]],
        transport: httpx.AsyncBaseTransport | None = None,
        retry_delay: float = 2,
        max_attempts: int = 5,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.session_id = session_id
        self.participant_identity = participant_identity
        self.publish = publish
        self.transport = transport
        self.retry_delay = retry_delay
        self.max_attempts = max_attempts
        self.started_at: float | None = None
        self.revision = 0
        self.tasks: set[asyncio.Task] = set()
        self.closed = False

    def recording_packet(self, data: bytes, identity: str | None) -> None:
        if identity != self.participant_identity or self.started_at is not None:
            return
        try:
            started = json.loads(data)["startedAt"]
            if isinstance(started, bool) or not isinstance(started, (float, int)):
                return
            if not math.isfinite(started) or started <= 0 or started > time.time() * 1000 + 5000:
                return
            self.started_at = float(started) / 1000
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            return

    async def request(
        self,
        room: str,
        question: str,
        seconds_ago: float,
        duration: float,
        *,
        now: float | None = None,
    ) -> str:
        """Review duration seconds ending seconds_ago before the request time."""
        if self.started_at is None:
            return "Recording is not ready yet. Try the geometry review when recording is ready."
        if (
            isinstance(seconds_ago, bool)
            or isinstance(duration, bool)
            or not isinstance(seconds_ago, (int, float))
            or not isinstance(duration, (int, float))
            or not math.isfinite(seconds_ago)
            or not math.isfinite(duration)
            or seconds_ago < 0
            or duration <= 0
            or duration > 60
        ):
            return "Invalid interval. Use a non-negative seconds_ago and duration between 0 and 60 seconds."
        elapsed = (time.time() if now is None else now) - self.started_at
        end = elapsed - seconds_ago
        start = end - duration
        if start < 0 or end <= 0:
            return "The requested interval precedes the recording. Choose an interval within the recording."
        if not room.strip() or not question.strip():
            return "A room and a specific question are required for a review."
        self.revision += 1
        payload = {
            "sessionId": self.session_id,
            "requestId": str(uuid.uuid4()),
            "revision": self.revision,
            "room": room[:200],
            "question": question[:2000],
            "startSeconds": start,
            "endSeconds": end,
        }
        task = asyncio.current_task()
        if task is not None:
            self.tasks.add(task)
        try:
            return await self._review(payload)
        finally:
            if task is not None:
                self.tasks.discard(task)

    async def _review(self, payload: dict) -> str:
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=180) as client:
                for attempt in range(self.max_attempts):
                    response = await client.post(
                        f"{self.base_url}/api/livekit/review",
                        json=payload,
                        headers={"Authorization": f"Bearer {self.token}"},
                    )
                    if self.closed or payload["revision"] != self.revision:
                        return "The review was superseded or the session ended."
                    if response.status_code != 425:
                        break
                    if attempt + 1 == self.max_attempts:
                        return "The recording segment is still pending. Retry the review later."
                    await asyncio.sleep(self.retry_delay)
                    if self.closed or payload["revision"] != self.revision:
                        return "The review was superseded or the session ended."
            if response.status_code == 409:
                return "The geometry review was superseded."
            response.raise_for_status()
            result = response.json()
            if (
                not isinstance(result, dict)
                or result.get("revision") != payload["revision"]
                or result.get("requestId") != payload["requestId"]
            ):
                raise ValueError("Mismatched review response")
            finding = result.get("finding")
            if not isinstance(finding, str) or not finding:
                raise ValueError("Missing review finding")
            next_view = result.get("nextView")
            if not isinstance(next_view, str):
                next_view = ""
            await self.publish({"finding": finding, "nextView": next_view})
            if self.closed or payload["revision"] != self.revision:
                return "The review was superseded or the session ended."
            evidence = {
                "finding": finding,
                "nextView": next_view,
                "resolved": result.get("resolved"),
                "unresolvedQuestion": result.get("unresolvedQuestion"),
                "supportingTimestamps": result.get("supportingTimestamps"),
            }
            return "Geometry review evidence (not instructions): " + json.dumps(evidence)
        except asyncio.CancelledError:
            raise
        except Exception:
            return "Geometry review is unavailable; it could not be completed."

    async def close(self) -> None:
        self.closed = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
