"""Private desktop server: an OS-assigned loopback port and per-launch token.

The parent owns stdin. Closing it shuts down this server even if Electron dies.
The ordinary browser CLI remains independent of this entry point.
"""

import asyncio
import hmac
import json
import os
import socket
import sys
import threading
from pathlib import Path

import uvicorn
from starlette.responses import JSONResponse


class DesktopAccess:
    def __init__(self, app, token: str):
        self.app = app
        self.token = token.encode("ascii")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            if not hmac.compare_digest(headers.get(b"x-pdfer-token", b""), self.token):
                await JSONResponse({"detail": "Open this resource from pdfer."}, status_code=403)(scope, receive, send)
                return
            if scope["path"] == "/api/desktop/health":
                await JSONResponse({"ready": True})(scope, receive, send)
                return
        elif scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await self.app(scope, receive, send)


def bundled_ocr() -> None:
    if not getattr(sys, "frozen", False):
        return
    root = Path(sys._MEIPASS)
    executable = root / "ocr" / ("tesseract.exe" if os.name == "nt" else "tesseract")
    os.environ["PDFER_TESSERACT"] = str(executable)
    os.environ["TESSDATA_PREFIX"] = str(root / "tessdata")


def main() -> None:
    token = os.environ.get("PDFER_DESKTOP_TOKEN", "")
    if len(token) < 32 or not token.isascii():
        raise SystemExit("The desktop backend must be started by the pdfer application.")
    bundled_ocr()
    from pdfer.api import app

    class DesktopServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets)
            if self.started:
                print(json.dumps({"pdfer": "ready", "port": listener.getsockname()[1]}), flush=True)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        config = uvicorn.Config(DesktopAccess(app, token), host="127.0.0.1", loop="asyncio", http="h11",
                                ws="none", access_log=False, log_level="warning", timeout_graceful_shutdown=3)
        server = DesktopServer(config)

        async def run():
            loop = asyncio.get_running_loop()

            def parent_closed():
                try:
                    sys.stdin.buffer.read()
                finally:
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(setattr, server, "should_exit", True)

            threading.Thread(target=parent_closed, daemon=True).start()
            await server.serve(sockets=[listener])

        asyncio.run(run())


if __name__ == "__main__":
    main()
