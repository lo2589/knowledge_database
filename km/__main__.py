"""python -m km [--db data/km.db] [--port 8790] [--open]"""

from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

from .server import serve


def main() -> None:
    parser = argparse.ArgumentParser(prog="km", description="知识整理：拆分 → 筛选 → 入库 → 链接")
    home = Path(__file__).resolve().parent.parent / "data" / "repos"
    parser.add_argument("--repos", default=str(home), help="新仓库放在哪个文件夹（默认 data/repos）")
    parser.add_argument("--db", help="直接打开这个仓库文件；不给就打开上次用的")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--open", action="store_true", help="启动后用浏览器打开")
    args = parser.parse_args()
    server = serve(args.repos, args.db, args.port)
    url = f"http://127.0.0.1:{args.port}/"
    repo = server.RequestHandlerClass.api.repos.path
    print(f"known_manage 已启动：{url}（仓库 {repo}）  Ctrl+C 停止", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
