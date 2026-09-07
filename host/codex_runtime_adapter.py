"""Small asynchronous stdio adapter for Codex app-server.

Unlike the SDK's synchronous approval callback, domain reads run outside the sole
protocol reader. No server request is accepted unless the active turn registered
the exact domain handler. This process is owned by an existing Bridge runtime slot.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any, Awaitable, Callable


class RuntimeErrorResponse(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def namespace(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{key: namespace(item) for key, item in value.items()})
    if isinstance(value, list):
        return [namespace(item) for item in value]
    return value


class CodexRuntimeAdapter:
    def __init__(self, config: Any):
        self.config = config
        self._client = self
        self.process: asyncio.subprocess.Process | None = None
        self.reader_task: asyncio.Task[Any] | None = None
        self.stderr_task: asyncio.Task[Any] | None = None
        self.request_tasks: set[asyncio.Task[Any]] = set()
        self.waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.handles: dict[str, RuntimeTurn] = {}
        self.early_events: dict[str, list[dict[str, Any]]] = {}
        self.sequence = 0
        self.write_lock = asyncio.Lock()
        self.tool_handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]] | None = None
        self.progress_handler: Callable[[str, str], None] | None = None
        self.allowed_thread_id: str | None = None
        self.allowed_turn_id: str | None = None
        self.fatal_error: BaseException | None = None

    async def __aenter__(self) -> "CodexRuntimeAdapter":
        arguments = [str(self.config.codex_bin), "app-server"]
        for override in self.config.config_overrides:
            arguments.extend(["-c", override])
        self.process = await asyncio.create_subprocess_exec(
            *arguments, cwd=self.config.cwd, env=self.config.env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        self.reader_task = asyncio.create_task(self._read_loop())
        self.stderr_task = asyncio.create_task(self._drain_stderr())
        await self.request("initialize", {
            "clientInfo": {"name": self.config.client_name, "title": self.config.client_title, "version": "review-context-1"},
            "capabilities": {"experimentalApi": True},
        })
        await self._write({"method": "initialized"})
        return self

    async def __aexit__(self, *_args: Any) -> None:
        await self.close()

    async def _drain_stderr(self) -> None:
        assert self.process and self.process.stderr
        # Do not persist runtime stderr: it may include user text or private paths.
        while await self.process.stderr.read(65_536):
            pass

    async def _write(self, value: dict[str, Any]) -> None:
        if not self.process or not self.process.stdin or self.process.returncode is not None:
            raise RuntimeErrorResponse("RUNTIME_CLOSED", "Codex运行时已关闭")
        async with self.write_lock:
            self.process.stdin.write((json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8"))
            await self.process.stdin.drain()

    async def request(self, method: str, params: dict[str, Any] | None = None, *, response_model: Any = None) -> Any:
        if self.fatal_error:
            raise self.fatal_error
        self.sequence += 1
        request_id = "review-rpc-" + str(self.sequence)
        future = asyncio.get_running_loop().create_future()
        self.waiters[request_id] = future
        try:
            await self._write({"id": request_id, "method": method, "params": params or {}})
            result = await future
        finally:
            self.waiters.pop(request_id, None)
        return response_model.model_validate(result) if response_model else result

    def _fail(self, error: BaseException) -> None:
        self.fatal_error = error
        for future in list(self.waiters.values()):
            if not future.done():
                future.set_exception(error)
        for handle in self.handles.values():
            if not handle.finished.done():
                handle.finished.set_exception(error)

    async def _read_loop(self) -> None:
        assert self.process and self.process.stdout
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    raise RuntimeErrorResponse("RUNTIME_CLOSED", "Codex协议连接已关闭")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise RuntimeErrorResponse("PROTOCOL_INVALID", "Codex协议消息不是对象")
                if "method" in message and "id" in message:
                    task = asyncio.create_task(self._server_request(message))
                    self.request_tasks.add(task)
                    task.add_done_callback(self._request_done)
                elif "method" in message:
                    self._notification(message)
                elif "id" in message:
                    waiter = self.waiters.get(str(message["id"]))
                    if waiter and not waiter.done():
                        if "error" in message:
                            error = message["error"]
                            code = str(error.get("code", "RPC_ERROR")) if isinstance(error, dict) else "RPC_ERROR"
                            waiter.set_exception(RuntimeErrorResponse(code, "Codex控制请求被拒绝；未回显内部协议正文"))
                        elif isinstance(message.get("result"), dict):
                            waiter.set_result(message["result"])
                        else:
                            waiter.set_exception(RuntimeErrorResponse("PROTOCOL_INVALID", "Codex控制响应无效"))
        except asyncio.CancelledError:
            return
        except BaseException as error:
            self._fail(error)

    def _request_done(self, task: asyncio.Task[Any]) -> None:
        self.request_tasks.discard(task)
        if not task.cancelled():
            error = task.exception()
            if error:
                self._fail(error)

    async def _server_request(self, message: dict[str, Any]) -> None:
        params = message.get("params")
        if message.get("method") != "item/tool/call" or self.tool_handler is None or not isinstance(params, dict):
            await self._write({"id": message["id"], "error": {"code": -32601, "message": "Server request is not permitted by the review assistant"}})
            raise RuntimeErrorResponse("TOOL_NOT_ALLOWED", "运行时请求了未开放能力，已中止本轮")
        # turn/start can emit the first request before its response is routed.
        if params.get("threadId") != self.allowed_thread_id or not isinstance(params.get("turnId"), str):
            raise RuntimeErrorResponse("TOOL_BINDING_INVALID", "领域工具与当前运行段不一致")
        if self.allowed_turn_id is not None and params["turnId"] != self.allowed_turn_id:
            raise RuntimeErrorResponse("TOOL_BINDING_INVALID", "领域工具与当前轮次不一致")
        if self.allowed_turn_id is None:
            self.allowed_turn_id = params["turnId"]
        response = await self.tool_handler(params)
        await self._write({"id": message["id"], "result": response})

    def _notification(self, message: dict[str, Any]) -> None:
        params = message.get("params")
        if not isinstance(params, dict):
            return
        turn = params.get("turn")
        turn_id = params.get("turnId") or (turn.get("id") if isinstance(turn, dict) else None)
        if not isinstance(turn_id, str):
            return
        handle = self.handles.get(turn_id)
        if handle:
            handle.receive(message)
        elif len(self.early_events) < 16:
            events = self.early_events.setdefault(turn_id, [])
            if len(events) >= 500:
                raise RuntimeErrorResponse("PROTOCOL_LIMIT", "Codex提前事件数量超限")
            events.append(message)

    async def account(self, *, refresh_token: bool = False) -> Any:
        return namespace(await self.request("account/read", {"refreshToken": refresh_token}))

    async def models(self, *, include_hidden: bool = True) -> Any:
        return namespace(await self.request("model/list", {"includeHidden": include_hidden}))

    async def thread_start(self, **kwargs: Any) -> "RuntimeThread":
        params = {"cwd": kwargs.get("cwd"), "model": kwargs.get("model"), "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": kwargs.get("ephemeral", False)}
        for source, target in (("developer_instructions", "developerInstructions"), ("service_name", "serviceName"), ("model_provider", "modelProvider"), ("dynamic_tools", "dynamicTools")):
            if source in kwargs:
                params[target] = kwargs[source]
        response = await self.request("thread/start", params)
        thread_id = response.get("thread", {}).get("id")
        if not isinstance(thread_id, str):
            raise RuntimeErrorResponse("PROTOCOL_INVALID", "Codex未返回线程身份")
        return RuntimeThread(self, thread_id)

    async def thread_resume(self, thread_id: str, **kwargs: Any) -> "RuntimeThread":
        await self.request("thread/resume", {"threadId": thread_id, "cwd": kwargs.get("cwd"), "model": kwargs.get("model"), "sandbox": "read-only", "approvalPolicy": "never", "developerInstructions": kwargs.get("developer_instructions")})
        return RuntimeThread(self, thread_id)

    async def close(self) -> None:
        self.tool_handler = None
        for task in list(self.request_tasks):
            task.cancel()
        if self.request_tasks:
            await asyncio.gather(*list(self.request_tasks), return_exceptions=True)
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 2)
            except asyncio.TimeoutError:
                self.process.kill()
                await asyncio.wait_for(self.process.wait(), 2)
        for task in (self.reader_task, self.stderr_task):
            if task:
                task.cancel()
        await asyncio.gather(*(task for task in (self.reader_task, self.stderr_task) if task), return_exceptions=True)
        self._fail(RuntimeErrorResponse("RUNTIME_CLOSED", "Codex运行时已关闭"))


class RuntimeThread:
    def __init__(self, runtime: CodexRuntimeAdapter, thread_id: str):
        self.runtime = runtime
        self.id = thread_id

    async def turn(self, prompt: Any, **kwargs: Any) -> "RuntimeTurn":
        self.runtime.allowed_thread_id = self.id
        self.runtime.allowed_turn_id = None
        inputs = [{"type": "text", "text": prompt}] if isinstance(prompt, str) else prompt
        result = await self.runtime.request("turn/start", {"threadId": self.id, "input": inputs, "model": kwargs.get("model"), "approvalPolicy": "never", "sandboxPolicy": {"type": "readOnly"}, "outputSchema": kwargs.get("output_schema")})
        turn_id = result.get("turn", {}).get("id")
        if not isinstance(turn_id, str):
            raise RuntimeErrorResponse("PROTOCOL_INVALID", "Codex未返回轮次身份")
        if self.runtime.allowed_turn_id not in (None, turn_id):
            raise RuntimeErrorResponse("TOOL_BINDING_INVALID", "领域工具轮次与控制响应不一致")
        self.runtime.allowed_turn_id = turn_id
        handle = RuntimeTurn(self.runtime, self.id, turn_id)
        self.runtime.handles[turn_id] = handle
        for message in self.runtime.early_events.pop(turn_id, []):
            handle.receive(message)
        return handle


class RuntimeTurn:
    def __init__(self, runtime: CodexRuntimeAdapter, thread_id: str, turn_id: str):
        self.runtime = runtime
        self.thread_id = thread_id
        self.id = turn_id
        self.finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.messages: dict[str, str] = {}
        self.deltas: dict[str, str] = {}

    def receive(self, message: dict[str, Any]) -> None:
        if self.finished.done():
            return
        params = message.get("params", {})
        if params.get("threadId") not in (None, self.thread_id):
            self.finished.set_exception(RuntimeErrorResponse("PROTOCOL_INVALID", "Codex事件线程绑定不一致"))
            return
        method = message.get("method")
        if method == "item/agentMessage/delta":
            key = str(params.get("itemId", "answer"))
            delta = params.get("delta")
            if isinstance(delta, str):
                self.deltas[key] = self.deltas.get(key, "") + delta
                if sum(map(len, self.deltas.values())) > 80_000:
                    self.finished.set_exception(RuntimeErrorResponse("OUTPUT_LIMIT", "Codex回答超出安全上限"))
                if self.runtime.progress_handler:
                    self.runtime.progress_handler("RESPONDING", "正在整理回答与可采用草稿")
        elif method == "item/completed":
            item = params.get("item", {})
            if item.get("type") == "agentMessage" and isinstance(item.get("text"), str):
                self.messages[str(item.get("id", "answer"))] = item["text"]
        elif method == "turn/completed":
            turn = params.get("turn", {})
            status = turn.get("status")
            if status not in {"completed", "interrupted"}:
                self.finished.set_exception(RuntimeErrorResponse("CODEX_TURN_FAILED", "Codex本轮未成功完成"))
            else:
                answer = next(reversed(self.messages.values()), "") or next(reversed(self.deltas.values()), "")
                self.finished.set_result(SimpleNamespace(final_response=answer, status=status))

    async def run(self) -> Any:
        return await asyncio.shield(self.finished)

    async def interrupt(self) -> Any:
        return await self.runtime.request("turn/interrupt", {"threadId": self.thread_id, "turnId": self.id})
