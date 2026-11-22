import asyncio
import json
import time

import httpx
import pytest

from worker.review import ReviewCoordinator


def coordinator(handler, packets, updates, **options):
    async def publish(packet):
        packets.append(packet)

    return ReviewCoordinator(
        base_url="https://server",
        token="scoped-token",
        session_id="session",
        participant_identity="user",
        publish=publish,
        transport=httpx.MockTransport(handler),
        retry_delay=0,
        **options,
    )


def set_anchor(review):
    review.recording_packet(b'{"startedAt":100000}', "user")


@pytest.mark.asyncio
async def test_review_is_background_and_retries_pending_with_same_interval_and_id():
    entered = asyncio.Event()
    release = asyncio.Event()
    packets, updates, requests = [], [], []

    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        assert request.headers["authorization"] == "Bearer scoped-token"
        if len(requests) == 1:
            entered.set()
            await release.wait()
            return httpx.Response(425)
        return httpx.Response(200, json={
            "finding": "Two corners visible", "nextView": "Show the door",
            "revision": body["revision"], "requestId": body["requestId"],
        })

    review = coordinator(handler, packets, updates)
    set_anchor(review)
    task = asyncio.create_task(review.request("Kitchen", "Where is the door?", 0, 5, now=200))
    await entered.wait()
    assert not packets
    release.set()
    result = await task
    assert requests[0] == requests[1]
    assert (requests[0]["startSeconds"], requests[0]["endSeconds"]) == (95, 100)
    assert packets == [{"finding": "Two corners visible", "nextView": "Show the door"}]
    assert "Two corners visible" in result


@pytest.mark.asyncio
async def test_old_interval_and_validation():
    requests = []
    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json={
            "finding": "Seen", "revision": body["revision"], "requestId": body["requestId"],
        })

    review = coordinator(handler, [], [])
    review.recording_packet(b'{"startedAt":100000}', "other")
    assert "not ready" in await review.request("Room", "Question", 0, 5, now=800)
    set_anchor(review)
    assert "Invalid" in await review.request("Room", "Question", 0, 61, now=800)
    assert "Invalid" in await review.request("Room", "Question", float("nan"), 5, now=800)
    assert "precedes" in await review.request("Room", "Question", 699, 5, now=800)
    await review.request("Room", "Question", 600, 5, now=800)
    assert (requests[0]["startSeconds"], requests[0]["endSeconds"]) == (95, 100)


@pytest.mark.asyncio
async def test_pending_is_bounded_and_superseded_result_is_not_published():
    gate = asyncio.Event()
    packets, updates = [], []
    async def handler(request):
        body = json.loads(request.content)
        if body["revision"] == 1:
            await gate.wait()
            return httpx.Response(200, json={
                "finding": "old", "revision": 1, "requestId": body["requestId"],
            })
        return httpx.Response(425)

    review = coordinator(handler, packets, updates, max_attempts=2)
    review.recording_packet(json.dumps({"startedAt": (time.time() - 30) * 1000}).encode(), "user")
    first = asyncio.create_task(review.request("Room", "First", 0, 5))
    await asyncio.sleep(0)
    second = asyncio.create_task(review.request("Room", "Second", 0, 5))
    result = await second
    gate.set()
    first_result = await first
    assert not packets
    assert "pending" in result
    assert "superseded" in first_result
