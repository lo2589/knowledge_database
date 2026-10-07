"""python -m km [--repos data/repos] [--port 8790] [--db 某个库.db] [--open]

`--db` serves exactly that file and nothing else. Without it the server serves
one library per dsh session, which is how the graph beside a conversation works.
There is no default library either way.
"""

from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

from .server import serve


def main() -> None:
    parser = argparse.ArgumentParser(prog="km", description="知识整理：拆分 → 筛选 → 入库 → 链接")
    home = Path(__file__).resolve().parent.parent / "data" / "repos"
    parser.add_argument("--repos", default=str(home), help="会话各自的库放在哪个文件夹（默认 data/repos）")
    parser.add_argument("--db", help="只服务这一个库文件；不给就按会话分库（没有默认库）")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--open", action="store_true", help="启动后用浏览器打开")
    args = parser.parse_args()
    server = serve(args.repos, args.db, args.port)
    where = f"库 {args.db}" if args.db else f"会话各自的库在 {Path(args.repos).expanduser()}"
    url = f"http://127.0.0.1:{args.port}/"
    print(f"known_manage 已启动：{url}（{where}）  Ctrl+C 停止", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
