#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lib_sync.py —— 行政部驾驶舱数据同步（资料库云表 → 本地 drop CSV）

把「资料库」里的三张云表（任务总表 / 车辆信息 / 签证情况）导出为 CSV，
写入 bridge/drop 对应目录；build.js 复用 bridge/parse.js 解析这些 CSV，
组装成驾驶舱内嵌数据后重新部署。腾讯会议室表仍由连接器单独同步（drop/tencent）。

运行模式：
- 沙箱模式（CloudStudio）：脚本自动经 auth-proxy 鉴权，无需 token。
- 客户端模式：token 从 stdin 首行读取（与资料库脚本一致），或取自环境变量 LIB_TOKEN。

用法：
    printf '%s' "<token>" | python3 lib_sync.py            # 客户端模式
    python3 lib_sync.py                                    # 沙箱模式 / 环境变量 LIB_TOKEN
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PY = r"C:/Users/周舟/.workbuddy/binaries/python/versions/3.13.12/python.exe"
GET_CONTENT = r"C:/Users/周舟/.workbuddy/plugins/cache/workbuddy-builtin/skill-library/0.5.9/database/get_database_content.py"

# (资料库 database_id, drop 子目录, 输出文件名)
TABLES = [
    ("E810IQGqpV9dHEwsnuIsb7", "wps",     "lib_task.csv"),
    ("IlIuElUzWtxAKPBMcGXpBg", "vehicle", "lib_vehicle.csv"),
    ("61g9FSYbQZreyiC1Praqai", "visa",    "lib_visa.csv"),
]

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def normalize_dates(content: str) -> str:
    """资料库日期可能导出为 ISO 时间（含 T...），统一截成 yyyy-mm-dd。"""
    reader = csv.reader(io.StringIO(content))
    rows = []
    for row in reader:
        new_row = []
        for cell in row:
            c = (cell or "").strip()
            if _DATE_RE.match(c):
                c = c[:10]
            new_row.append(c)
        rows.append(new_row)
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue()


def read_token() -> str:
    tok = os.environ.get("LIB_TOKEN", "").strip()
    if tok:
        return tok
    try:
        if not sys.stdin.isatty():
            line = sys.stdin.readline()
            tok = (line or "").strip()
    except Exception:
        pass
    return tok


def pull_one(token: str, db_id: str, subdir: str, out_name: str) -> int:
    drop_dir = os.path.join(ROOT, "bridge", "drop", subdir)
    os.makedirs(drop_dir, exist_ok=True)
    try:
        proc = subprocess.run(
            [PY, GET_CONTENT, "--token-stdin", "--database-id", db_id],
            input=(token + "\n"), capture_output=True, text=True, timeout=30,
        )
    except Exception as e:  # noqa: BLE001
        print(f"  [FAIL] {subdir}: 调用失败 {e}")
        return -1
    out = (proc.stdout or "").strip()
    try:
        payload = json.loads(out)
    except Exception:
        print(f"  [FAIL] {subdir}: 非 JSON 输出 -> {out[:200]}")
        return -1
    if "error" in payload:
        print(f"  [FAIL] {subdir}: {payload['error']}")
        return -1
    content = payload.get("content", "") or ""
    content = normalize_dates(content)
    out_path = os.path.join(drop_dir, out_name)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)
    n = max(0, content.count("\n") - (1 if content.strip() else 0))
    print(f"  [OK] {subdir}: 写入 {out_path} (数据行≈{n})")
    return n


def main() -> None:
    token = read_token()
    print("== 资料库 → drop 同步 ==")
    total = 0
    for db_id, subdir, out_name in TABLES:
        total += max(0, pull_one(token, db_id, subdir, out_name))
    print(f"== 完成，合计约 {total} 行 ==")


if __name__ == "__main__":
    main()
