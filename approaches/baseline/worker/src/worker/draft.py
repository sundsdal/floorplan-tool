"""Schedule incremental scene reviews without blocking the live conversation."""

import asyncio
import logging
import math
import time
import uuid
from collections.abc import Awaitable, Callable

import httpx

INITIAL_DRAFT_DELAY_SECONDS = 20
DRAFT_INTERVAL_SECONDS = 20
EGRESS_LAG_SECONDS = 5
MIN_DRAFT_SECONDS = 10
logger = logging.getLogger(__name__)


class DraftCoordinator:
    def __init__(self, *, base_url: str, token: str, session_id: str,
                 publish: Callable[[dict], Awaitable[None]], publish_finding=None, transport=None,
                 retry_delay: float = 2, max_attempts: int = 5):
        self.url = f"{base_url.rstrip('/')}/api/livekit/session/{session_id}/scene"
        self.headers = {"Authorization": f"Bearer {token}"}
        self.publish = publish
        self.publish_finding = publish_finding
        self.reported_findings = set()
        self.transport = transport
        self.retry_delay = retry_delay
        self.max_attempts = max_attempts
        self.started_at = None
        self.last_end = 0.0
        self.revision = 0
        self.closed = False
        self.tasks = set()
        self.lock = asyncio.Lock()
        self.inflight = set()
        self.seen = set()
        self.automatic_task = None

    def start(self, started_at: float):
        if self.started_at is not None or self.closed:
            return
        self.started_at = started_at
        self._spawn(self._periodic())

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def _periodic(self):
        await asyncio.sleep(max(0, self.started_at + INITIAL_DRAFT_DELAY_SECONDS - time.time()))
        while not self.closed:
            self._schedule_automatic()
            await asyncio.sleep(DRAFT_INTERVAL_SECONDS)

    def milestone(self):
        return self._schedule_automatic()

    def _schedule_automatic(self):
        if self.started_at is None or self.closed:
            return False
        if self.automatic_task is not None and not self.automatic_task.done():
            return False
        # HLS segments trail the live camera. Only ask for footage that is likely
        # to have been committed, leaving a small overlap for the next review.
        end = max(0, time.time() - self.started_at - EGRESS_LAG_SECONDS)
        start = max(0, self.last_end - 2) if self.last_end else 0
        if end < MIN_DRAFT_SECONDS or end <= self.last_end + 1:
            return False
        self.automatic_task = self._spawn(self.review(start, end))
        return True

    async def review(self, start: float, end: float, target_id: str | None = None):
        if (self.closed or self.started_at is None or isinstance(start, bool) or
            isinstance(end, bool) or not isinstance(start, (int, float)) or
            not isinstance(end, (int, float)) or not math.isfinite(start) or
            not math.isfinite(end) or start < 0 or end <= start or
            end > time.time() - self.started_at + 1):
            return False
        if target_id is not None and (not isinstance(target_id, str) or not target_id or len(target_id) > 200):
            return False
        key = (start, end, target_id)
        if key in self.seen or key in self.inflight:
            return False
        self.inflight.add(key)
        try:
            async with self.lock:
                # Pending milestones may overlap while a previous review is running.
                if target_id is None:
                    if end <= self.last_end + 1:
                        return True
                    start = max(start, self.last_end - 2) if self.last_end else start
                while end - start > 60:
                    if not await self._review_segment(start, start + 60, target_id):
                        return False
                    start += 58
                if not await self._review_segment(start, end, target_id):
                    return False
                self.seen.add(key)
                return True
        finally:
            self.inflight.discard(key)

    async def _review_segment(self, start, end, target_id):
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=300) as client:
                request_id = str(uuid.uuid4())
                for attempt in range(self.max_attempts):
                    # Fetch the authoritative revision, including user edits.
                    current = await client.get(self.url, headers=self.headers)
                    current.raise_for_status()
                    scene = current.json()["scene"]
                    payload = {"baseRevision": scene["revision"], "requestId": request_id,
                               "startSeconds": start, "endSeconds": end}
                    if target_id is not None:
                        payload["targetId"] = target_id
                    response = await client.post(self.url + "/review", headers=self.headers, json=payload)
                    if response.status_code == 409:
                        # A new id is needed after a concurrent scene change.
                        request_id = str(uuid.uuid4())
                    elif response.status_code != 425:
                        break
                    if attempt + 1 < self.max_attempts:
                        await asyncio.sleep(self.retry_delay)
                response.raise_for_status()
                scene = response.json()["scene"]
                if self.closed or not isinstance(scene.get("revision"), int):
                    return False
                current = await client.get(self.url, headers=self.headers)
                current.raise_for_status()
                if current.json()["scene"]["revision"] != scene["revision"]:
                    return False
                self.revision = max(self.revision, scene["revision"])
                if target_id is None:
                    self.last_end = max(self.last_end, end)
                await self.publish({"type": "scene", "revision": scene["revision"]})
                finding, next_view = scene.get("finding"), scene.get("nextView") or ""
                if (not self.closed and self.publish_finding and isinstance(finding, str)
                    and finding and isinstance(next_view, str) and (finding, next_view) not in self.reported_findings):
                    self.reported_findings.add((finding, next_view))
                    await self.publish_finding({"finding": finding, "nextView": next_view})
                return True
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            if isinstance(error, httpx.HTTPStatusError):
                logger.warning("Scene review failed with HTTP status %s", error.response.status_code)
            else:
                logger.warning("Scene review failed (%s)", type(error).__name__)
            return False

    async def target_context(self, target_id: str):
        """Return only scene data related to a selected element."""
        if not isinstance(target_id, str) or not target_id or len(target_id) > 200:
            return None
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=15) as client:
                response = await client.get(self.url, headers=self.headers)
                response.raise_for_status()
                scene = response.json()["scene"]
            plan = scene["floorplan"]
            nodes = scene.get("nodes", {})
            node = nodes.get(target_id, {})
            source_id = node.get("metadata", {}).get("sourceId", target_id)
            element = None
            kind = None
            for collection in ("walls", "doors", "windows", "rooms"):
                element = next((item for item in plan.get(collection, []) if item.get("id") == source_id), None)
                if element is not None:
                    kind = collection
                    break
            if element is None:
                return None
            wall_id = element.get("wall_id") if kind in ("doors", "windows") else source_id if kind == "walls" else None
            wall = next((item for item in plan.get("walls", []) if item.get("id") == wall_id), None)
            rooms = [room for room in plan.get("rooms", []) if wall_id in room.get("walls", [])] if wall_id else []
            findings = [item for item in scene.get("questions", []) if item.get("targetId") in (target_id, source_id)]
            return {"kind": kind, "element": element, "wall": wall, "rooms": rooms, "findings": findings}
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            return None

    async def close(self):
        self.closed = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
