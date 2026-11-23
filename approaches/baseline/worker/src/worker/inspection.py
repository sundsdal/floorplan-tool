"""Coordinate evidence requests and background inspection review."""

import asyncio
import json
import logging
import math
import time
import uuid
from collections.abc import Awaitable, Callable

import httpx

logger = logging.getLogger(__name__)
TARGETS = {
    "under_sink": "Kan du filme eller ta et bilde under vasken, hvis den er lett tilgjengelig?",
    "shaft_access": "Kan du ta et bilde inn i sjakta fra åpningen som allerede er tilgjengelig?",
    "ventilation": "Kan du filme den synlige ventilasjonsåpningen på nært hold?",
    "surface_detail": "Kan du ta et nærbilde av flaten som skal behandles?",
}


def room_id(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return None
    return str(parsed)


class InspectionCoordinator:
    def __init__(self, *, base_url: str, token: str, session_id: str, work: str,
                 participant_identity: str, publish: Callable[[dict], Awaitable[None]],
                 speak: Callable[[dict], None], transport=None, lag_seconds=6):
        if work not in ("male", "slipe"):
            raise ValueError("Invalid inspection work")
        self.url = f"{base_url.rstrip('/')}/api/livekit/session/{session_id}/inspection/review"
        self.headers = {"Authorization": f"Bearer {token}"}
        self.work = work
        self.participant_identity = participant_identity
        self.publish = publish
        self.speak = speak
        self.transport = transport
        self.lag_seconds = lag_seconds
        self.started_at = None
        self.rooms = {}
        self.current_room = None
        self.requests = {}
        self.evidence = []
        self.review_task = None
        self.pending_review = False
        self.closed = False

    def recording_started(self, started_at):
        if self.closed or self.started_at is not None:
            return
        self.started_at = started_at
        if self.pending_review:
            self.schedule_review()

    def room_packet(self, data: bytes, identity: str | None):
        if self.closed or identity != self.participant_identity:
            return
        try:
            item = json.loads(data)
            ident = room_id(item["roomId"])
            name, seconds, phase = item["name"], item["seconds"], item.get("phase")
            if (not ident or not isinstance(name, str) or not name.strip() or len(name) > 80
                    or isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                    or not math.isfinite(seconds) or not 0 <= seconds <= 86400
                    or phase not in ("start", "finish")):
                return
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            return
        existing = self.rooms.get(ident)
        if existing is None:
            self.rooms[ident] = {"roomId": ident, "name": name.strip(), "seconds": seconds}
        else:
            existing["name"] = name.strip()
            # A room belongs to the instant it started, not its finish event.
            if phase == "start":
                existing["seconds"] = seconds
        self.current_room = ident
        if phase == "finish":
            self.schedule_review()

    def evidence_packet(self, data: bytes, identity: str | None):
        if self.closed or identity != self.participant_identity:
            return
        try:
            item = json.loads(data)
            ident = room_id(item["roomId"])
            request_id = str(uuid.UUID(item["requestId"]))
        except (ValueError, KeyError, TypeError, UnicodeDecodeError, AttributeError):
            return
        request = self.requests.get(request_id)
        if not request or request["roomId"] != ident:
            return
        evidence = {"requestId": request_id, "roomId": ident, "target": request["target"]}
        if evidence not in self.evidence:
            self.evidence.append(evidence)
            self.schedule_review()

    async def request_evidence(self, ident: str, target: str, prompt: str):
        ident = room_id(ident)
        if (self.closed or ident not in self.rooms or target not in TARGETS
                or not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 300):
            return False
        if any(not any(e["requestId"] == key for e in self.evidence)
               for key in self.requests):
            return False
        if any(item["roomId"] == ident and item["target"] == target for item in self.evidence):
            return False
        request = {"requestId": str(uuid.uuid4()), "roomId": ident,
                   "roomName": self.rooms[ident]["name"],
                   "target": target, "prompt": TARGETS[target]}
        self.requests[request["requestId"]] = request
        try:
            await self.publish(request)
        except Exception:
            self.requests.pop(request["requestId"], None)
            logger.warning("Failed to publish inspection request")
            return False
        return request

    def schedule_review(self):
        if self.closed:
            return
        self.pending_review = True
        if self.started_at is None or not self.rooms:
            return
        if self.review_task is None or self.review_task.done():
            self.review_task = asyncio.create_task(self._run_reviews())

    async def _run_reviews(self):
        while not self.closed and self.pending_review:
            self.pending_review = False
            await asyncio.sleep(self.lag_seconds)
            if self.closed:
                break
            end = min(86400, max(0, time.time() - self.started_at - self.lag_seconds))
            if end <= 0:
                continue
            payload = {"work": self.work, "endSeconds": end,
                       "rooms": list(self.rooms.values()), "evidence": list(self.evidence)}
            try:
                async with httpx.AsyncClient(transport=self.transport, timeout=300) as client:
                    for attempt in range(4):
                        response = await client.post(self.url, headers=self.headers, json=payload)
                        if response.status_code != 425 or attempt == 3:
                            break
                        await asyncio.sleep(3)
                    response.raise_for_status()
                    result = response.json()
                if not isinstance(result, dict) or not isinstance(result.get("requests"), list):
                    raise ValueError("Invalid review response")
                for item in result["requests"][:5]:
                    if not isinstance(item, dict):
                        continue
                    request = await self.request_evidence(item.get("roomId"), item.get("target"), item.get("prompt"))
                    if request:
                        self.speak(request)
                        break
            except asyncio.CancelledError:
                raise
            except (httpx.HTTPError, ValueError, TypeError):
                logger.warning("Inspection review failed")

    async def close(self):
        self.closed = True
        if self.review_task:
            self.review_task.cancel()
            await asyncio.gather(self.review_task, return_exceptions=True)
