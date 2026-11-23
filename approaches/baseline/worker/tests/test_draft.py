import asyncio
import json
import time

import httpx
import pytest

from worker.draft import DraftCoordinator


@pytest.mark.asyncio
async def test_review_retries_pending_and_publishes_authoritative_scene_once():
    requests, packets = [], []
    async def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"scene": {"revision": 4 if len(requests) >= 2 else 3}})
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            return httpx.Response(425)
        return httpx.Response(200, json={"scene": {"revision": 4, "floorplan": {}}})
    async def publish(packet):
        packets.append(packet)
    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, transport=httpx.MockTransport(handler), retry_delay=0)
    draft.started_at = time.time() - 40
    assert await draft.review(0, 30)
    assert requests[0] == requests[1]
    assert requests[0]["baseRevision"] == 3
    assert packets == [{"type": "scene", "revision": 4}]
    assert not await draft.review(0, 30)
    await draft.close()


@pytest.mark.asyncio
async def test_periodic_and_milestone_deduplicate_pending():
    entered, release = asyncio.Event(), asyncio.Event()
    requests = []
    async def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"scene": {"revision": 1 if release.is_set() else 0}})
        requests.append(json.loads(request.content))
        entered.set()
        await release.wait()
        return httpx.Response(200, json={"scene": {"revision": 1}})
    async def publish(_packet):
        pass
    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, transport=httpx.MockTransport(handler), retry_delay=0)
    draft.start(time.time() - 31)
    await entered.wait()
    assert not draft.milestone()
    release.set()
    await draft.automatic_task
    assert len(requests) == 1
    assert requests[0]["startSeconds"] == 0
    await draft.close()


@pytest.mark.asyncio
async def test_periodic_draft_retries_failure_and_processes_later_footage(monkeypatch):
    monkeypatch.setattr("worker.draft.DRAFT_INTERVAL_SECONDS", 0.01)
    revision, requests, packets = [0], [], []
    published = asyncio.Event()

    async def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"scene": {"revision": revision[0]}})
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return httpx.Response(503)
        revision[0] += 1
        return httpx.Response(200, json={"scene": {"revision": revision[0]}})

    async def publish(packet):
        packets.append(packet)
        published.set()

    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, transport=httpx.MockTransport(handler), retry_delay=0)
    draft.start(time.time() - 31)
    await asyncio.wait_for(published.wait(), timeout=1)
    assert len(requests) == 2
    assert requests[0]["startSeconds"] == requests[1]["startSeconds"] == 0
    assert packets == [{"type": "scene", "revision": 1}]

    # Advance the capture clock without waiting for a real walkthrough.
    draft.started_at -= 15
    published.clear()
    await asyncio.wait_for(published.wait(), timeout=1)
    assert requests[-1]["startSeconds"] > 0
    assert requests[-1]["endSeconds"] > requests[1]["endSeconds"]
    assert packets[-1] == {"type": "scene", "revision": 2}
    await draft.close()


@pytest.mark.asyncio
async def test_target_and_long_intervals_are_forwarded_with_overlap_and_deduplicated():
    requests, packets = [], []
    async def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"scene": {"revision": len(requests)}})
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"scene": {"revision": len(requests), "floorplan": {"huge": "x" * 10000}}})
    async def publish(packet):
        packets.append(packet)
    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, transport=httpx.MockTransport(handler))
    draft.started_at = time.time() - 150
    assert await draft.review(0, 120, "wall-1")
    assert [(r["startSeconds"], r["endSeconds"]) for r in requests] == [(0, 60), (58, 118), (116, 120)]
    assert all(r["targetId"] == "wall-1" for r in requests)
    assert packets[-1] == {"type": "scene", "revision": 3}
    assert not await draft.review(0, 120, "wall-1")
    assert await draft.review(0, 120, "wall-2")
    await draft.close()


@pytest.mark.asyncio
async def test_target_context_includes_only_element_wall_and_related_room():
    async def handler(_request):
        return httpx.Response(200, json={"scene": {"floorplan": {
            "walls": [{"id": "w1"}, {"id": "w2"}],
            "doors": [{"id": "d1", "wall_id": "w1"}], "windows": [],
            "rooms": [{"id": "r1", "name": "Kitchen", "walls": ["w1"]},
                      {"id": "r2", "name": "Hall", "walls": ["w2"]}]},
            "questions": [{"targetId": "d1", "instruction": "Show the hinge"}],
            "nodes": {}}})
    async def publish(_packet):
        pass
    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, transport=httpx.MockTransport(handler))
    context = await draft.target_context("d1")
    assert context["element"]["id"] == "d1"
    assert context["wall"]["id"] == "w1"
    assert [room["name"] for room in context["rooms"]] == ["Kitchen"]
    assert context["findings"][0]["instruction"] == "Show the hinge"
    assert await draft.target_context("missing") is None


@pytest.mark.asyncio
async def test_findings_are_published_once_and_stale_results_are_ignored():
    revision, packets, findings = [0], [], []
    async def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"scene": {"revision": revision[0]}})
        revision[0] += 1
        return httpx.Response(200, json={"scene": {"revision": revision[0],
            "finding": "Door obscured", "nextView": "Show the hinge"}})
    async def publish(packet):
        packets.append(packet)
    async def finding(packet):
        findings.append(packet)
    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, publish_finding=finding, transport=httpx.MockTransport(handler))
    draft.started_at = time.time() - 60
    assert await draft.review(0, 10)
    assert await draft.review(10, 20)
    assert findings == [{"finding": "Door obscured", "nextView": "Show the hinge"}]
    await draft.close()


@pytest.mark.asyncio
async def test_stale_review_does_not_publish_finding():
    calls, published = [0], []
    async def handler(request):
        if request.method == "GET":
            calls[0] += 1
            return httpx.Response(200, json={"scene": {"revision": 0 if calls[0] == 1 else 2}})
        return httpx.Response(200, json={"scene": {"revision": 1, "finding": "Old", "nextView": "Old"}})
    async def publish(packet):
        published.append(packet)
    draft = DraftCoordinator(base_url="https://server", token="token", session_id="session",
        publish=publish, publish_finding=publish, transport=httpx.MockTransport(handler))
    draft.started_at = time.time() - 20
    assert not await draft.review(0, 10)
    assert not published
    await draft.close()
