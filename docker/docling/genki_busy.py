"""One conversion a replica: genki's middleware in front of docling-serve (ADR 0042, issue 922).

docling-serve's local engine runs one task at a time but accepts more and queues them in memory, and the Container
Apps TCP ingress spreads connections, not work: on 2026-11-21 three conversions sat on one replica until it ran out
of memory (exit 137) while four others idled. So a replica that holds a task answers a new submit with 503 and
`Retry-After`, and the worker submits it again on a new connection, which the ingress may send to another replica.
Only a submit with the server's key is judged here; any other request goes on to docling-serve, which checks it.

A replica also keeps memory after a conversion (locally 0.8 GiB at start, 4.7 after a 452-page file, 5.5 after a
331-page one), so one task at a time still climbs. When it holds no task and no result waits, and its memory is
above a limit, it ends its own process; Azure starts the container again. A fetched result is removed after
`DOCLING_SERVE_RESULT_REMOVAL_DELAY` (1 s in the template), so the restart follows the last fetch within seconds.

It logs, at WARNING so the server's log level keeps them, each task it accepts and ends with its replica and the
replica's running and queued tasks, each busy answer, and each restart. No file name or text.

Run as `python -m genki_busy`: docling-serve's own `run`, with its app wrapped.
"""

import asyncio
import hmac
import json
import logging
import os
import signal
import socket
import sys
import time

GIB = 1024**3
SUBMIT = "/v1/convert/file/async"
# A result never fetched (its client went away) stops counting as waiting after this long.
ABANDONED_SECONDS = 600
HOLDING = {"pending", "started"}
ENDED = {"success", "failure"}


def _status(task):
    status = getattr(task, "task_status", None)
    return str(getattr(status, "value", status))


class OneTaskAtATime:
    """ASGI middleware: refuses a submit while the replica holds a task, and restarts it when idle and large."""

    def __init__(
        self,
        app,
        *,
        orchestrator,
        replica,
        memory,
        restart,
        idle_limit,
        log,
        key=None,
        clock=time.monotonic,
        watch_every=None,
    ):
        self.app = app
        self.orchestrator = orchestrator
        self.replica = replica
        self.memory = memory
        self.restart = restart
        self.idle_limit = idle_limit
        self.log = log
        self.clock = clock
        self.key = key
        self.watch_every = watch_every
        self.admitting = 0
        self.restarting = False
        self.accepted = []
        self.results_seen = {}
        self.watching = False
        self.memory_unread = False

    def counts(self):
        statuses = [_status(t) for t in list(self.orchestrator().tasks.values())]
        return {"running": statuses.count("started"), "queued": statuses.count("pending")}

    def busy(self):
        return self.restarting or self.admitting > 0 or any(
            _status(t) in HOLDING for t in list(self.orchestrator().tasks.values())
        )

    def waiting_results(self):
        now = self.clock()
        keys = set(getattr(self.orchestrator(), "_task_results", {}))
        for key in keys - set(self.results_seen):
            self.results_seen[key] = now
        for key in set(self.results_seen) - keys:
            del self.results_seen[key]
        return [k for k, seen in self.results_seen.items() if now - seen < ABANDONED_SECONDS]

    def check(self):
        """Logs the tasks that ended, and restarts the replica when it is idle above its limit."""
        tasks = self.orchestrator().tasks
        for task_id in list(self.accepted):
            task = tasks.get(task_id)
            status = _status(task) if task is not None else "gone"
            if status in HOLDING:
                continue
            self.accepted.remove(task_id)
            self.log({"msg": "task ended", "task": task_id, "status": status, "replica": self.replica, **self.counts()})
        if self.restarting or self.busy() or self.waiting_results():
            return
        used = self.memory()
        if used is None:
            # Without its memory the replica cannot restart itself: said once, so it is seen.
            if not self.memory_unread:
                self.memory_unread = True
                self.log({"msg": "memory unreadable", "replica": self.replica})
            return
        if used <= self.idle_limit:
            return
        self.restarting = True
        self.log({"msg": "restarting", "replica": self.replica, "memoryBytes": used, "limitBytes": self.idle_limit})
        self.restart()

    async def _watch(self):
        while True:
            await asyncio.sleep(self.watch_every)
            try:
                self.check()
            except Exception as error:  # the watch must outlive one bad read
                self.log({"msg": "check failed", "replica": self.replica, "error": type(error).__name__})

    def keyed(self, scope):
        """Whether a request carries the server's key (`X-Api-Key`), compared in constant time."""
        if self.key is None:
            return True
        sent = dict(scope.get("headers", [])).get(b"x-api-key", b"")
        return hmac.compare_digest(sent, self.key.encode())

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if self.watch_every and not self.watching:
            self.watching = True
            asyncio.get_running_loop().create_task(self._watch())
        if not (scope["method"] == "POST" and scope["path"] == SUBMIT) or not self.keyed(scope):
            # Everything but a submit with the right key goes to docling-serve, which checks the key itself.
            return await self.app(scope, receive, send)
        name = [(b"x-docling-replica", self.replica.encode())]
        if self.busy():
            self.log({"msg": "busy", "replica": self.replica, "restarting": self.restarting, **self.counts()})
            body = json.dumps({"detail": "This replica is converting a file; submit it again on a new connection."})
            await send(
                {
                    "type": "http.response.start",
                    "status": 503,
                    "headers": [(b"content-type", b"application/json"), (b"retry-after", b"15"), *name],
                }
            )
            await send({"type": "http.response.body", "body": body.encode()})
            return
        self.admitting += 1
        answer = {"status": 0, "body": b""}

        async def named(message):
            if message["type"] == "http.response.start":
                answer["status"] = message["status"]
                message = {**message, "headers": [*message.get("headers", []), *name]}
            elif message["type"] == "http.response.body":
                answer["body"] += message.get("body", b"")
            await send(message)

        try:
            await self.app(scope, receive, named)
        finally:
            self.admitting -= 1
        if answer["status"] == 200:
            try:
                task_id = json.loads(answer["body"])["task_id"]
            except (ValueError, KeyError, TypeError):
                return
            self.accepted.append(task_id)
            self.log({"msg": "task accepted", "task": task_id, "replica": self.replica, **self.counts()})


def working_set():
    """The container's memory as Azure's WorkingSetBytes counts it: cgroup usage less inactive file pages."""
    try:
        with open("/sys/fs/cgroup/memory.current") as f:
            current = int(f.read())
        with open("/sys/fs/cgroup/memory.stat") as f:
            stat = dict(line.split() for line in f)
        return current - int(stat.get("inactive_file", 0))
    except (OSError, ValueError):
        return None


def _log_line(line):
    logging.getLogger("genki.docling").warning(json.dumps(line))


def _terminate():
    # uvicorn stops on SIGTERM and the process ends with code 0; Azure starts the container again.
    os.kill(os.getpid(), signal.SIGTERM)


def wrap(create_app):
    """docling-serve's app factory, wrapped in the middleware."""
    from docling_serve.orchestrator_factory import get_async_orchestrator

    def create():
        app = create_app()
        orchestrator = get_async_orchestrator()
        # The internals the middleware reads; a docling-serve upgrade that moves them stops the replica here.
        if not isinstance(getattr(orchestrator, "tasks", None), dict) or not isinstance(
            getattr(orchestrator, "_task_results", None), dict
        ):
            raise RuntimeError("docling-serve's orchestrator no longer keeps tasks and _task_results")
        return OneTaskAtATime(
            app,
            orchestrator=get_async_orchestrator,
            replica=os.environ.get("CONTAINER_APP_REPLICA_NAME") or socket.gethostname(),
            memory=working_set,
            restart=_terminate,
            idle_limit=int(float(os.environ.get("GENKI_DOCLING_RESTART_IDLE_GIB", "4")) * GIB),
            log=_log_line,
            key=os.environ.get("DOCLING_SERVE_API_KEY") or None,
            watch_every=2.0,
        )

    return create


def main():
    import docling_serve.app
    from docling_serve.__main__ import main as docling_serve_main

    # `docling-serve run` starts uvicorn with "docling_serve.app:create_app" as its factory, read from the module.
    docling_serve.app.create_app = wrap(docling_serve.app.create_app)
    sys.argv = ["docling-serve", "run", *sys.argv[1:]]
    docling_serve_main()


if __name__ == "__main__":
    main()
