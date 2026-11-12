"""Marker's own Azure OpenAI service, counting what each call costs. Used by convert_marker.py --use-llm.

Marker records only total tokens per block, and on an error it logs and carries on with an empty answer. This
subclass changes nothing Marker sends; it wraps the client's parse call to count requests, errors, input
(prompt) and output (completion) tokens, so a run can report a cost per page. USAGE is reset per document.
"""
import threading

from marker.services.azure_openai import AzureOpenAIService

USAGE = {"requests": 0, "errors": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
_LOCK = threading.Lock()


def reset():
    with _LOCK:
        for key in USAGE:
            USAGE[key] = 0


def snapshot():
    with _LOCK:
        return dict(USAGE)


class CountingAzureOpenAIService(AzureOpenAIService):
    def get_client(self):
        client = super().get_client()
        parse = client.beta.chat.completions.parse

        def counted(*args, **kwargs):
            try:
                response = parse(*args, **kwargs)
            except Exception:
                with _LOCK:
                    USAGE["requests"] += 1
                    USAGE["errors"] += 1
                raise
            usage = getattr(response, "usage", None)
            with _LOCK:
                USAGE["requests"] += 1
                if usage is not None:
                    USAGE["prompt_tokens"] += usage.prompt_tokens or 0
                    USAGE["completion_tokens"] += usage.completion_tokens or 0
                    USAGE["total_tokens"] += usage.total_tokens or 0
            return response

        client.beta.chat.completions.parse = counted
        return client
