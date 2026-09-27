"""
Parish Music Player - desktop launcher.

The player itself is a web application: the audio engine, the MIDI parser and
the soundfont synthesiser all run in the browser's Web Audio engine. This
module's whole job is to put that page in front of a volunteer in one
double-click, with no browser window, no address bar and no terminal.

It does two things.

  1. Serves the bundled ``src`` directory over HTTP on the loopback interface.
     A local server is required because the page uses ES modules and fetches its
     instrument manifest, both of which browsers refuse to do from ``file://``.

  2. Opens that address in an embedded WebView2 window (the Edge engine that
     ships with Windows 10 and 11), falling back to the default browser if the
     embedded view is unavailable.

Two details matter for an unattended machine in a church.

  * The server binds to 127.0.0.1 on an operating-system-assigned port. The
    original shipped ``python -m http.server 8765`` with no ``--bind``, which
    published the whole player folder to every device on the parish network and
    failed on the second launch because the fixed port was already taken.

  * The server thread is a daemon tied to the window. Closing the window ends
    the process. The original left an orphaned Python server running until the
    machine was rebooted, one per launch.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import logging
import os
import socket
import socketserver
import sys
import threading
import time
import webbrowser
from pathlib import Path

APP_NAME = "Parish Music Player"
LOOPBACK = "127.0.0.1"

log = logging.getLogger("parish")


def resource_dir() -> Path:
    """Directory holding index.html, whether running frozen or from source."""
    if getattr(sys, "frozen", False):
        # PyInstaller unpacks bundled data under sys._MEIPASS in one-file mode
        # and beside the executable in one-folder mode.
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    else:
        base = Path(__file__).resolve().parent
    return base / "src"


def user_data_dir() -> Path:
    """Writable directory for the WebView profile and the log."""
    root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
    path = root / "ParishMusicPlayer"
    path.mkdir(parents=True, exist_ok=True)
    return path


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Static file handler: no request logging, correct types, no caching.

    Also keeps the settings, as a JSON file in the user's data directory.

    They used to live only in the WebView's localStorage, which never survived
    a restart: localStorage belongs to an origin, the origin includes the port,
    and the port is chosen afresh on every launch. Each start was a new site
    with empty storage, so the player always came up on its defaults. A file
    does not care which port served the page.
    """

    settings_path: Path | None = None
    SETTINGS_URL = "/settings"
    # Room for the per-hymn memory of a parish's whole repertoire, many times over.
    SETTINGS_MAX_BYTES = 1024 * 1024

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".mid": "audio/midi",
        ".midi": "audio/midi",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }

    def log_message(self, fmt, *args):  # noqa: A003 - base class name
        log.debug("%s - %s", self.address_string(), fmt % args)

    def do_GET(self):  # noqa: N802 - base class name
        if self.path.split("?")[0] == self.SETTINGS_URL:
            self._send_settings()
        else:
            super().do_GET()

    def do_PUT(self):  # noqa: N802 - base class name
        if self.path.split("?")[0] != self.SETTINGS_URL or self.settings_path is None:
            self.send_error(404)
            return
        # A custom header cannot be sent cross-origin without a preflight, which
        # this server never grants, so another web page open on the machine
        # cannot quietly rewrite the settings.
        if self.headers.get("X-Parish-Player") != "1":
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= self.SETTINGS_MAX_BYTES:
            self.send_error(413)
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("settings must be an object")
            # Written beside the target and swapped in, so a power cut in the
            # middle of a save cannot leave a half-written file.
            tmp = self.settings_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
            os.replace(tmp, self.settings_path)
        except (ValueError, OSError) as exc:
            log.warning("Could not save settings: %s", exc)
            self.send_error(400)
            return
        self.send_response(204)
        self.end_headers()

    def _send_settings(self):
        body = b"{}"
        if self.settings_path is not None and self.settings_path.is_file():
            try:
                raw = self.settings_path.read_bytes()
                if isinstance(json.loads(raw.decode("utf-8")), dict):
                    body = raw
            except (ValueError, OSError) as exc:
                log.warning("Ignoring unreadable settings file: %s", exc)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # A volunteer who updates the player folder should see the new version
        # immediately rather than a cached copy of the old one.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


class LocalServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    # Deliberately off. On Windows SO_REUSEADDR lets a second process bind a
    # port another process is already listening on, and requests then land on
    # whichever server the kernel happens to pick. We want a clear failure
    # instead, and since the default port is 0 there is nothing to reuse.
    allow_reuse_address = False


def start_server(directory: Path, port: int = 0,
                 settings_path: Path | None = None) -> tuple[LocalServer, int]:
    """Serve *directory* on the loopback interface. Returns (server, port).

    Port 0 asks the operating system for any free port, so a second launch can
    never collide with a server left running by the first.

    The handler is bound with functools.partial because SimpleHTTPRequestHandler
    assigns self.directory in its own __init__; a class attribute is silently
    overwritten with the process working directory.
    """
    QuietHandler.settings_path = settings_path
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = LocalServer((LOOPBACK, port), handler)
    bound = server.server_address[1]
    threading.Thread(target=server.serve_forever, name="http", daemon=True).start()
    log.info("Serving %s at http://%s:%s", directory, LOOPBACK, bound)
    return server, bound


def wait_for_server(port: int, timeout: float = 5.0) -> bool:
    """Poll the port instead of sleeping a fixed 1.5 seconds and hoping."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with socket.create_connection((LOOPBACK, port), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def run_webview(url: str) -> bool:
    """Open the embedded window. Returns False if pywebview is unavailable."""
    try:
        import webview
    except ImportError:
        log.warning("pywebview not installed; falling back to the default browser")
        return False

    try:
        webview.create_window(
            APP_NAME,
            url,
            width=760,
            height=1000,
            min_size=(520, 640),
            background_color="#0d1220",
            text_select=False,
        )
        # private_mode=False keeps the WebView profile (and therefore the saved
        # settings in localStorage) between services.
        webview.start(private_mode=False, storage_path=str(user_data_dir() / "webview"))
        return True
    except Exception:
        log.exception("Embedded window failed to start")
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--browser", action="store_true",
                        help="open in the default web browser instead of the app window")
    parser.add_argument("--port", type=int, default=0,
                        help="serve on a specific port (default: any free port)")
    parser.add_argument("--debug", action="store_true", help="verbose logging to a file")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        filename=str(user_data_dir() / "player.log"),
        filemode="w",
    )

    root = resource_dir()
    if not (root / "index.html").is_file():
        message = f"Could not find the player files.\n\nExpected: {root / 'index.html'}"
        log.error(message)
        _alert(message)
        return 1

    # Keep the instrument list in step with whatever is in soundfonts/.
    try:
        from generate_manifest import write_manifest
        write_manifest(root / "soundfonts")
    except Exception:
        log.exception("Could not refresh the soundfont manifest; using the existing one")

    try:
        server, port = start_server(root, args.port, settings_path=user_data_dir() / "settings.json")
    except OSError as exc:
        _alert("Could not start the player's local server.\n\n" + str(exc))
        return 1

    url = f"http://{LOOPBACK}:{port}/index.html"
    if not wait_for_server(port):
        _alert("The player could not start its local server.")
        return 1

    try:
        if args.browser or not run_webview(url):
            webbrowser.open(url)
            print(f"{APP_NAME} is running at {url}")
            print("Close this window to stop the player.")
            threading.Event().wait()          # hold the server open
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
    return 0


def _alert(message: str) -> None:
    """Show a dialog if we can; otherwise print. Volunteers do not read consoles."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    except Exception:
        print(message, file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
