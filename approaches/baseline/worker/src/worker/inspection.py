"""Coordinate evidence requests and background inspection review."""

import asyncio
import base64
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
                 speak: Callable[[dict], None], transport=None, lag_seconds=6,
                 update_context: Callable[[dict, str | None], Awaitable[None]] | None = None,
                 answer: Callable[[str], None] | None = None):
        if work not in ("male", "slipe"):
            raise ValueError("Invalid inspection work")
        self.base_url = f"{base_url.rstrip('/')}/api/livekit/session/{session_id}/inspection"
        self.url = self.base_url + "/review"
        self.headers = {"Authorization": f"Bearer {token}"}
        self.work = work
        self.participant_identity = participant_identity
        self.publish = publish
        self.speak = speak
        self.transport = transport
        self.update_context = update_context
        self.answer = answer
        self.location = None
        self.location_received = 0.0
        self.location_timestamp = 0.0
        self.map_timestamp = 0.0
        self.map_generation = 0
        self.latest_spatial_image = None
        self.context_tasks = set()
        self.question_task = None
        self.lag_seconds = lag_seconds
        self.started_at = None
        self.rooms = {}
        self.room_starts = set()
        self.current_room = None
        self.requests = {}
        self.evidence = []
        self.review_task = None
        self.pending_review = False
        self.closed = False
        self.event_cursor = 0
        self.event_task = None
        self.event_queue = asyncio.Queue()
        self.events_loaded = False
        self.named_rooms = set()
        self.registered_rooms = set()
        self.events_supported = None
        self.event_wakeup = asyncio.Event()
        self.recovery_marks = {}
        self.event_inflight = None

    def start_events(self):
        if self.event_task is None:
            self.event_task = asyncio.create_task(self._event_loop())

    def emit_event(self, event_type, data, ident=None, captured_at=None):
        event = {"id": str(uuid.uuid4()), "type": event_type, "data": data,
                 "capturedAt": int(captured_at if captured_at is not None else time.time() * 1000)}
        if ident:
            event["roomId"] = ident
        self.event_queue.put_nowait(event)
        self.event_wakeup.set()

    async def _sync_events(self, client):
        # Rebuild all state before treating acknowledgements as live; pages are capped at 100.
        while True:
            response = await client.get(self.base_url + "/events", headers=self.headers,
                                        params={"after": self.event_cursor})
            if response.status_code == 404:
                self.events_supported = False
                return
            response.raise_for_status()
            self.events_supported = True
            page = response.json()
            events, cursor = page.get("events"), page.get("cursor")
            if (not isinstance(events, list) or not isinstance(cursor, int)
                    or cursor != self.event_cursor + len(events)):
                raise ValueError("Invalid event page")
            for event in events:
                self._apply_event(event)
            self.event_cursor = cursor
            if len(events) < 100:
                if not self.events_loaded:
                    queued_ids = {event["id"] for event in self.event_queue._queue}
                    for event in self.recovery_marks.values():
                        if event["id"] not in queued_ids:
                            self.event_queue.put_nowait(event)
                    self.recovery_marks.clear()
                self.events_loaded = True
                return

    async def _send_events(self, client):
        # Marked intervals must not wait behind an indefinitely failing transcript.
        priority = {"evidence.requested": 0, "evidence.marked": 1, "room.named": 2}
        self.event_queue._queue = type(self.event_queue._queue)(sorted(
            self.event_queue._queue, key=lambda event: priority.get(event["type"], 3)))
        count = self.event_queue.qsize()
        for _ in range(count):
            event = self.event_queue.get_nowait()
            if (event["type"] == "evidence.marked" and any(
                    e["requestId"] == event["data"]["requestId"] for e in self.evidence)):
                continue
            self.event_inflight = event
            try:
                response = await client.post(self.base_url + "/events", headers=self.headers, json=event)
                if response.status_code == 409:
                    self.event_queue.put_nowait(event)
                    continue
                if response.status_code != 404:
                    response.raise_for_status()
            except (httpx.HTTPError, asyncio.CancelledError):
                self.event_queue.put_nowait(event)
                raise
            finally:
                self.event_inflight = None

    async def _event_loop(self):
        # Every retry keeps its UUID, including after a lost POST response.
        async with httpx.AsyncClient(transport=self.transport, timeout=15) as client:
            while not self.closed:
                try:
                    await self._sync_events(client)
                    await self._send_events(client)
                except asyncio.CancelledError:
                    raise
                except (httpx.HTTPError, ValueError, TypeError, KeyError):
                    logger.warning("Inspection event sync failed; retrying")
                self.event_wakeup.clear()
                try:
                    await asyncio.wait_for(self.event_wakeup.wait(), timeout=2)
                except TimeoutError:
                    pass

    def _apply_event(self, event):
        if not isinstance(event, dict) or not isinstance(event.get("data"), dict):
            return
        kind, data = event.get("type"), event["data"]
        ident = room_id(event.get("roomId"))
        if kind in ("room.upsert", "room.named") and ident:
            name = data.get("name")
            if isinstance(name, str) and name.strip() and len(name) <= 80:
                self.rooms.setdefault(ident, {"roomId": ident, "seconds": 0})["name"] = name.strip()
                if kind == "room.upsert":
                    self.registered_rooms.add(ident)
                if kind == "room.named":
                    self.named_rooms.add(ident)
                if self.location is None:
                    self.current_room = ident
        elif kind == "evidence.requested" and ident:
            request_id, target = data.get("requestId"), data.get("target")
            if room_id(request_id) and target in TARGETS:
                self.requests.setdefault(request_id, {"requestId": request_id, "roomId": ident,
                    "roomName": self.rooms.get(ident, {}).get("name", ""), "target": target,
                    "prompt": TARGETS[target]})
        elif kind == "evidence.marked" and not self.events_loaded:
            if isinstance(event.get("id"), str) and ident and room_id(data.get("requestId")):
                self.recovery_marks[event["id"]] = event
        elif kind in ("evidence.saved", "evidence.retry"):
            for key, mark in list(self.recovery_marks.items()):
                if mark["data"].get("requestId") == data.get("requestId"):
                    del self.recovery_marks[key]
            request_id = data.get("requestId")
            request = self.requests.get(request_id)
            if request and kind == "evidence.saved":
                evidence = {"requestId": request_id, "roomId": request["roomId"], "target": request["target"]}
                if evidence not in self.evidence:
                    self.evidence.append(evidence)
                    if self.events_loaded and self.answer:
                        self.answer("Dokumentasjonen er lagret.")
                    self.schedule_review()
            elif request and kind == "evidence.retry":
                self.evidence = [e for e in self.evidence if e["requestId"] != request_id]
                if self.events_loaded and self.answer:
                    self.answer("Dokumentasjonen kunne ikke lagres. Prøv å filme på nytt.")

    def set_room_name(self, ident, name, source="user"):
        ident = room_id(ident)
        if (source not in ("live", "user") or ident not in self.rooms
                or not isinstance(name, str) or not name.strip() or len(name) > 80):
            return False
        name = name.strip()
        self.rooms[ident]["name"] = name
        self.named_rooms.add(ident)
        self.emit_event("room.named", {"name": name, "source": source}, ident)
        return True

    def mark_evidence(self, request_id, start_seconds, end_seconds):
        request = self.requests.get(request_id)
        if (not request or self.started_at is None or any(isinstance(v, bool) or not isinstance(v, (int, float))
                or not math.isfinite(v) for v in (start_seconds, end_seconds))
                or end_seconds - start_seconds > 15
                or not 0 <= start_seconds < end_seconds <= min(86400, time.time() - self.started_at + 1)):
            return False
        self.emit_event("evidence.marked", {"requestId": request_id, "target": request["target"],
                        "startSeconds": start_seconds, "endSeconds": end_seconds}, request["roomId"])
        return True

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
            if ident not in self.named_rooms:
                existing["name"] = name.strip()
            # A finish can arrive first, but repeated starts must not move the offset.
            if phase == "start" and ident not in self.room_starts:
                existing["seconds"] = seconds
        if phase == "start":
            self.room_starts.add(ident)
        if self.location is None:
            self.current_room = ident
        if phase == "finish":
            self.schedule_review()


    def _spawn_context(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.context_tasks.add(task)
        task.add_done_callback(self.context_tasks.discard)
        return task

    @staticmethod
    def _timestamp(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not math.isfinite(value) or value < 1_000_000_000_000 or value > min(4_200_000_000_000, time.time() * 1000 + 5000):
            return None
        return float(value)

    def location_packet(self, data: bytes, identity: str | None):
        if self.closed or identity != self.participant_identity:
            return
        try:
            item = json.loads(data)
            captured_at = self._timestamp(item["capturedAt"])
            tracking = item["tracking"]
            if captured_at is None or captured_at <= self.location_timestamp or tracking not in ("tracked", "uncertain", "unavailable"):
                return
            ident = room_id(item.get("roomId"))
            name = item.get("roomName")
            if tracking == "tracked" and ident:
                if ident not in self.rooms or not isinstance(name, str) or not name.strip() or len(name) > 80:
                    return
                location = {"capturedAt": int(captured_at), "tracking": tracking, "roomId": ident,
                            "roomName": name.strip()}
            else:
                location = {"capturedAt": captured_at, "tracking": tracking}
            for field in (("position", "forward") if tracking == "tracked" and ident else ()):
                point = item.get(field)
                if point is not None:
                    if not isinstance(point, dict) or set(point) != {"x", "y"}:
                        return
                    if any(isinstance(point[k], bool) or not isinstance(point[k], (int, float))
                           or not math.isfinite(point[k]) or abs(point[k]) > (1.01 if field == "forward" else 10000)
                           for k in ("x", "y")):
                        return
                    location[field] = point
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            return
        self.location = location
        self.location_timestamp = captured_at
        self.location_received = time.time()
        self.current_room = location.get("roomId")
        if self.update_context and self._room_changed(location):
            self._spawn_context(self._update_location_context(location))

    def _room_changed(self, location):
        state = (location.get("tracking"), location.get("roomId"))
        if getattr(self, "_last_context_room", None) == state:
            return False
        self._last_context_room = state
        return True

    async def _update_location_context(self, location):
        try:
            await self.update_context(location, None)
        except Exception:
            logger.warning("Unable to update live room context")

    def current_location(self):
        now = int(time.time() * 1000)
        if self.location is None:
            return {"capturedAt": now, "tracking": "unavailable", "message": "Romposisjon er ikke mottatt ennå."}
        if now - self.location_received * 1000 > 20000 or now - self.location_timestamp > 20000:
            return {"capturedAt": now, "tracking": "unavailable", "message": "Romposisjonen er ikke oppdatert, spør personen hvor de er."}
        if self.location["tracking"] != "tracked" or not self.location.get("roomId"):
            tracking = self.location["tracking"] if self.location["tracking"] != "tracked" else "uncertain"
            return {"capturedAt": int(self.location_timestamp), "tracking": tracking,
                    "message": "Rommet er usikkert. Spør personen hvor de er."}
        return self.location

    def spatial_packet(self, data: bytes, identity: str | None):
        if self.closed or identity != self.participant_identity:
            return
        try:
            timestamp = self._timestamp(json.loads(data)["capturedAt"])
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            return
        if timestamp is None or timestamp <= self.map_timestamp:
            return
        self.map_generation += 1
        self._spawn_context(self._fetch_spatial(timestamp, self.map_generation))

    async def _fetch_spatial(self, requested_at, generation):
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=15) as client:
                response = await client.get(self.base_url + "/spatial", headers=self.headers)
                response.raise_for_status()
                snapshot = response.json()
            timestamp = self._timestamp(snapshot["capturedAt"])
            encoded = snapshot["image"]
            if (timestamp is None or timestamp < requested_at or timestamp <= self.map_timestamp
                    or not isinstance(encoded, str) or len(encoded) > 420000):
                return
            raw = base64.b64decode(encoded, validate=True)
            if not (4 <= len(raw) <= 315000 and raw[:2] == b"\xff\xd8" and raw[-2:] == b"\xff\xd9"):
                return
            if self.closed or generation != self.map_generation:
                return
            self.map_timestamp = timestamp
            self.latest_spatial_image = encoded
            if self.update_context:
                # The newest device location may be more recent than the map.
                await self.update_context(self.current_location(), encoded)
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            logger.warning("Could not retrieve the latest spatial map")
        except Exception:
            logger.warning("Unable to update live map context")

    def ask_hydrogen(self, question: str):
        if self.closed or not isinstance(question, str) or not question.strip() or len(question) > 500:
            return False
        if self.question_task and not self.question_task.done():
            return False
        if not self.rooms:
            return False
        self.question_task = asyncio.create_task(self._ask_hydrogen(question.strip()))
        return True

    async def _ask_hydrogen(self, question: str):
        payload = {"work": self.work, "rooms": list(self.rooms.values()),
                   "evidence": list(self.evidence), "question": question}
        location = self.current_location()
        payload["currentLocation"] = {key: value for key, value in location.items() if key != "message"}
        if location.get("roomId"):
            payload["currentRoomId"] = location["roomId"]
        if self.started_at is not None:
            end = min(86400, max(0, time.time() - self.started_at - self.lag_seconds))
            if end > 0:
                payload["endSeconds"] = end
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=300) as client:
                response = await client.post(self.base_url + "/question", headers=self.headers, json=payload)
                response.raise_for_status()
                result = response.json()
            if not isinstance(result, dict) or not isinstance(result.get("summary"), str) or not isinstance(result.get("requests"), list):
                raise ValueError("Invalid answer")
            for item in result["requests"][:5]:
                if not isinstance(item, dict):
                    continue
                request = await self.request_evidence(item.get("roomId"), item.get("target"), item.get("prompt"))
                if request:
                    self.speak(request)
                    break
            if self.answer and not self.closed:
                self.answer(result["summary"][:2500])
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, TypeError):
            if self.answer and not self.closed:
                self.answer("Hydrogen kunne ikke besvare spørsmålet nå. Prøv igjen.")

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
        if (self.closed or ident not in self.rooms
                or (self.event_task and self.events_supported is not False and ident not in self.registered_rooms)
                or target not in TARGETS
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
        self.emit_event("evidence.requested", {"requestId": request["requestId"], "target": target}, ident)
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
        if self.event_task and (not self.event_queue.empty() or self.event_inflight):
            self.event_wakeup.set()
            try:
                async with asyncio.timeout(3):
                    while not self.event_queue.empty() or self.event_inflight:
                        await asyncio.sleep(0.05)
            except TimeoutError:
                logger.warning("Inspection events remain unsent at shutdown")
        self.closed = True
        tasks = list(self.context_tasks)
        if self.review_task:
            tasks.append(self.review_task)
        if self.question_task:
            tasks.append(self.question_task)
        if self.event_task:
            tasks.append(self.event_task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
