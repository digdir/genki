"""Tests of genki's busy middleware for docling-serve (issue 922). Run in the image build."""

import asyncio
import logging
import threading
import unittest
from types import SimpleNamespace

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

import importlib.util

from genki_busy import OneTaskAtATime, wrap

GIB = 1024**3
KEY = "docling-key"


class FakeOrchestrator:
    """docling-serve's local orchestrator as the middleware reads it: tasks by id and results kept."""

    def __init__(self):
        self.tasks = {}
        self._task_results = {}
        self.queue = []

    def add(self, task_id, status):
        self.tasks[task_id] = SimpleNamespace(task_id=task_id, task_status=status)
        if status == "pending":
            self.queue.append(task_id)

    def finish(self, task_id, status="success"):
        self.tasks[task_id].task_status = status
        if task_id in self.queue:
            self.queue.remove(task_id)
        if status == "success":
            self._task_results[task_id] = object()

    def fetch(self, task_id):
        self._task_results.pop(task_id, None)
        self.tasks.pop(task_id, None)


def docling_app(orchestrator, gate=None):
    """The routes the worker calls, answering as docling-serve does: the key is checked after the upload."""
    count = {"n": 0}

    async def submit(request):
        await request.form()
        if request.headers.get("x-api-key") != KEY:
            return JSONResponse({"detail": "Invalid API key"}, status_code=401)
        if gate is not None:
            await asyncio.to_thread(gate.wait, 5)
        count["n"] += 1
        task_id = f"00000000-0000-0000-0000-{count['n']:012d}"
        orchestrator.add(task_id, "pending")
        return JSONResponse({"task_id": task_id, "task_status": "pending"})

    async def poll(request):
        task = orchestrator.tasks.get(request.path_params["task_id"])
        if not task:
            return JSONResponse({"detail": "Task not found."}, status_code=404)
        return JSONResponse({"task_id": task.task_id, "task_status": task.task_status})

    async def result(request):
        task_id = request.path_params["task_id"]
        if task_id not in orchestrator._task_results:
            return JSONResponse({"detail": "Task result not found."}, status_code=404)
        return JSONResponse({"status": "success"})

    async def health(request):
        return JSONResponse({"status": "ok"})

    return Starlette(
        routes=[
            Route("/v1/convert/file/async", submit, methods=["POST"]),
            Route("/v1/status/poll/{task_id}", poll),
            Route("/v1/result/{task_id}", result),
            Route("/health", health),
            Route("/ready", health),
        ]
    )


class Replica:
    """A replica with the middleware in front, its memory set by the test."""

    def __init__(self, memory=1 * GIB, gate=None):
        self.orchestrator = FakeOrchestrator()
        self.memory = memory
        self.restarts = 0
        self.lines = []
        self.now = 1000.0
        self.middleware = OneTaskAtATime(
            docling_app(self.orchestrator, gate),
            orchestrator=lambda: self.orchestrator,
            replica="genai-test-docling--0000020-697dfcff7c-6948n",
            memory=lambda: self.memory,
            restart=self._restart,
            idle_limit=4 * GIB,
            log=self.lines.append,
            key=KEY,
            clock=lambda: self.now,
        )
        self.client = TestClient(self.middleware)

    def _restart(self):
        self.restarts += 1

    def submit(self, key=KEY, client=None):
        headers = {"x-api-key": key} if key else {}
        return (client or self.client).post(
            "/v1/convert/file/async", files={"files": ("document.pdf", b"%PDF-1.7")}, headers=headers
        )

    def logged(self, msg):
        return [line for line in self.lines if line["msg"] == msg]


class OneTaskAtATimeTest(unittest.TestCase):
    def test_refuses_a_submit_with_503_and_retry_after_15_while_a_task_is_pending_or_started(self):
        for status in ("pending", "started"):
            replica = Replica()
            replica.orchestrator.add("held", status)

            answer = replica.submit()

            self.assertEqual(answer.status_code, 503)
            self.assertEqual(answer.headers["retry-after"], "15")
            self.assertEqual(list(replica.orchestrator.tasks), ["held"])
            self.assertEqual(len(replica.logged("busy")), 1)
        free = Replica()
        self.assertEqual(free.submit().status_code, 200)
        # A finished task whose result waits does not make the replica busy.
        free.orchestrator.finish(free.orchestrator.queue[0])
        self.assertEqual(free.submit().status_code, 200)

    def test_lets_status_result_and_health_requests_through_while_busy(self):
        replica = Replica()
        replica.orchestrator.add("held", "started")
        replica.orchestrator.add("done", "success")
        replica.orchestrator._task_results["done"] = object()

        self.assertEqual(replica.client.get("/v1/status/poll/held").json()["task_status"], "started")
        self.assertEqual(replica.client.get("/v1/result/done").status_code, 200)
        self.assertEqual(replica.client.get("/health").status_code, 200)
        self.assertEqual(replica.client.get("/ready").status_code, 200)

    def test_names_its_replica_in_the_submit_answer(self):
        replica = Replica()

        taken = replica.submit()
        refused = replica.submit()

        self.assertEqual(taken.status_code, 200)
        self.assertEqual(taken.headers["x-docling-replica"], "genai-test-docling--0000020-697dfcff7c-6948n")
        self.assertEqual(refused.status_code, 503)
        self.assertEqual(refused.headers["x-docling-replica"], "genai-test-docling--0000020-697dfcff7c-6948n")

    def test_logs_a_task_when_it_is_accepted_and_when_it_ends_with_the_replicas_running_and_queued_counts(self):
        replica = Replica()

        task_id = replica.submit().json()["task_id"]
        replica.orchestrator.tasks[task_id].task_status = "started"
        replica.orchestrator.queue.clear()
        replica.middleware.check()
        replica.orchestrator.finish(task_id)
        replica.middleware.check()
        replica.middleware.check()

        replica_name = "genai-test-docling--0000020-697dfcff7c-6948n"
        self.assertEqual(
            replica.logged("task accepted"),
            [{"msg": "task accepted", "task": task_id, "replica": replica_name, "running": 0, "queued": 1}],
        )
        self.assertEqual(
            replica.logged("task ended"),
            [
                {
                    "msg": "task ended",
                    "task": task_id,
                    "status": "success",
                    "replica": replica_name,
                    "running": 0,
                    "queued": 0,
                }
            ],
        )

    def test_restarts_the_replica_after_its_last_result_is_fetched_when_idle_memory_passes_the_limit(self):
        replica = Replica(memory=5 * GIB)
        task_id = replica.submit().json()["task_id"]
        replica.orchestrator.finish(task_id)
        replica.middleware.check()
        self.assertEqual(replica.restarts, 0)

        replica.client.get(f"/v1/result/{task_id}")
        replica.orchestrator.fetch(task_id)
        replica.middleware.check()

        self.assertEqual(replica.restarts, 1)
        self.assertEqual(replica.logged("restarting")[0]["memoryBytes"], 5 * GIB)
        # Restarting: it takes no new file meanwhile, and restarts once.
        self.assertEqual(replica.submit().status_code, 503)
        replica.middleware.check()
        self.assertEqual(replica.restarts, 1)
        # Under the limit, an idle replica keeps running.
        calm = Replica(memory=3 * GIB)
        calm.middleware.check()
        self.assertEqual(calm.restarts, 0)

    def test_does_not_restart_while_a_task_is_held_or_a_result_is_waiting(self):
        for status in ("pending", "started"):
            replica = Replica(memory=7 * GIB)
            replica.orchestrator.add("held", status)
            replica.middleware.check()
            self.assertEqual(replica.restarts, 0)
        waiting = Replica(memory=7 * GIB)
        waiting.orchestrator.add("done", "success")
        waiting.orchestrator._task_results["done"] = object()
        waiting.middleware.check()
        self.assertEqual(waiting.restarts, 0)

    def test_refuses_a_second_submit_while_the_first_is_still_uploading(self):
        gate = threading.Event()
        replica = Replica(gate=gate)
        answers = {}
        with TestClient(replica.middleware) as first:
            held = threading.Thread(target=lambda: answers.setdefault("first", replica.submit(client=first)))
            held.start()
            # The first submit is inside docling-serve, not yet a task.
            for _ in range(200):
                if replica.middleware.admitting:
                    break
                threading.Event().wait(0.01)
            answers["second"] = replica.submit()
            gate.set()
            held.join()

        self.assertEqual(answers["second"].status_code, 503)
        self.assertEqual(answers["first"].status_code, 200)

    def test_restarts_with_a_result_left_unfetched_for_10_minutes_but_not_before(self):
        replica = Replica(memory=5 * GIB)
        replica.orchestrator.add("done", "success")
        replica.orchestrator._task_results["done"] = object()
        replica.middleware.check()

        replica.now += 599
        replica.middleware.check()
        self.assertEqual(replica.restarts, 0)
        replica.now += 1
        replica.middleware.check()
        self.assertEqual(replica.restarts, 1)

    def test_logs_once_when_it_cannot_read_its_memory_and_does_not_restart(self):
        replica = Replica(memory=None)

        replica.middleware.check()
        replica.middleware.check()

        self.assertEqual(replica.restarts, 0)
        self.assertEqual(len(replica.logged("memory unreadable")), 1)

    def test_leaves_a_submit_without_the_key_to_docling_serve_even_while_busy(self):
        replica = Replica()
        replica.orchestrator.add("held", "started")

        for key in (None, "wrong-key"):
            answer = replica.submit(key=key)
            self.assertEqual(answer.status_code, 401)
            self.assertNotIn("x-docling-replica", answer.headers)
        self.assertEqual(replica.middleware.admitting, 0)
        self.assertEqual(replica.logged("busy"), [])

    def test_reads_the_whole_upload_before_it_answers_busy_so_the_connection_stays_open(self):
        replica = Replica()
        replica.orchestrator.add("held", "started")
        chunks = [b"x" * 65536 for _ in range(5)]
        events = []

        async def receive():
            body = chunks.pop(0)
            events.append("read")
            return {"type": "http.request", "body": body, "more_body": bool(chunks)}

        async def send(message):
            events.append(message["type"])

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/v1/convert/file/async",
            "headers": [(b"x-api-key", KEY.encode())],
        }
        asyncio.run(replica.middleware(scope, receive, send))

        self.assertEqual(chunks, [])
        self.assertEqual(events[:6], ["read"] * 5 + ["http.response.start"])


@unittest.skipUnless(importlib.util.find_spec("docling_serve"), "docling-serve is in the image, not the CI venv")
class WrapTest(unittest.TestCase):
    def test_wraps_docling_serves_app_and_finds_the_orchestrator_internals_it_reads(self):
        import docling_serve.app

        app = wrap(docling_serve.app.create_app)()

        self.assertIsInstance(app, OneTaskAtATime)
        orchestrator = app.orchestrator()
        self.assertIsInstance(orchestrator.tasks, dict)
        self.assertIsInstance(orchestrator._task_results, dict)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
