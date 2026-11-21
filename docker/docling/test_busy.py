"""Tests of genki's busy middleware for docling-serve (issue 922). Run in the image build."""

import json
import logging
import unittest
from types import SimpleNamespace

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from genki_busy import OneTaskAtATime

GIB = 1024**3


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


def docling_app(orchestrator):
    """The routes the worker calls, answering as docling-serve does."""
    count = {"n": 0}

    async def submit(request):
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

    def __init__(self, memory=1 * GIB):
        self.orchestrator = FakeOrchestrator()
        self.memory = memory
        self.restarts = 0
        self.lines = []
        self.middleware = OneTaskAtATime(
            docling_app(self.orchestrator),
            orchestrator=lambda: self.orchestrator,
            replica="genai-test-docling--0000020-697dfcff7c-6948n",
            memory=lambda: self.memory,
            restart=self._restart,
            idle_limit=4 * GIB,
            log=self.lines.append,
        )
        self.client = TestClient(self.middleware)

    def _restart(self):
        self.restarts += 1

    def submit(self):
        return self.client.post("/v1/convert/file/async", files={"files": ("document.pdf", b"%PDF-1.7")})

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


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
