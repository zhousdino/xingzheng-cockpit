#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lib_import.py —— 将本地 CSV 批量追加写入资料库（database）云表。

与 library 自带的 import_csv.py（覆盖式，会清空整表）不同，本脚本使用
batch_add_database_records（追加式），仅新增记录、不动已有数据，适合
"一次性批量导入"场景。

用法：
    echo -n "<token>" | python3 lib_import.py --token-stdin \
        --database-id "<id>" --csv "<path-to.csv>" [--required 车牌,所有情况,状态] [--dry-run]

    # 或把 token 放进环境变量 LIB_TOKEN（无需 --token-stdin）
    LIB_TOKEN=xxx python3 lib_import.py --database-id "<id>" --csv "<file.csv>"

约定：
    - CSV 首行为表头，列名须与资料库字段名【完全一致】（我们提供的模板即一致）。
    - 列可少于表字段（缺列按空白处理）；多余列会被忽略并提示。
    - 日期列接受 YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年MM月DD日，统一规整为 YYYY-MM-DD。
    - 单选(select)列的取值必须是该字段已有的选项文本之一，否则该行整体跳过并报告。
    - 数字列必须为数字（千分位逗号会自动去除）。
    - 每批最多 100 条；输出结构化 JSON 结果到 stdout（含 created_ids，便于核对/回滚）。
    - 失败不抛出、不中断其余行；汇总失败明细。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# 资料库 skill 的 database 模块（复用其鉴权 / HTTP，避免重复实现）
_SKILL_DB = r"C:/Users/周舟/.workbuddy/plugins/cache/workbuddy-builtin/skill-library/0.5.9/database"
_PY = r"C:/Users/周舟/.workbuddy/binaries/python/versions/3.13.12/python.exe"


def _run_skill(script: str, token: str, payload: str | None = None, extra: list | None = None) -> str:
    """调用 database 下的技能脚本，token 走 stdin 首行。返回 stdout 文本。"""
    cmd = [_PY, os.path.join(_SKILL_DB, script), "--token-stdin"]
    if payload is not None:
        cmd.append("--stdin")
    if extra:
        cmd.extend(extra)
    stdin_data = token + "\n"
    if payload is not None:
        stdin_data += payload
    try:
        proc = subprocess.run(
            cmd, input=stdin_data.encode("utf-8"),
            capture_output=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"调用 {script} 失败: {e}")
    out = (proc.stdout or b"").decode("utf-8", "replace").strip()
    err = (proc.stderr or b"").decode("utf-8", "replace").strip()
    if proc.returncode != 0 and not out:
        raise RuntimeError(f"{script} 退出码 {proc.returncode}: {err}")
    return out


def fetch_schema(token: str, database_id: str) -> dict:
    raw = _run_skill("get_database_schema.py", token, None, extra=["--database-id", database_id])
    # 取最后一行 JSON（脚本只输出一行 JSON）
    raw = raw.splitlines()[-1] if raw.splitlines() else raw
    data = json.loads(raw)
    if "error" in data:
        raise RuntimeError(f"获取 schema 失败: {data['error']}")
    props = {}
    for p in data.get("properties", []):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        ptype = (p.get("type") or "text").strip()
        options = set()
        if ptype == "select":
            for o in (p.get("config", {}) or {}).get("options", []) or []:
                if isinstance(o, dict):
                    txt = o.get("text") or o.get("name") or ""
                else:
                    txt = str(o)
                if txt:
                    options.add(txt.strip())
        props[name] = {"type": ptype, "options": options}
    return {"id": data.get("id"), "title": data.get("title"), "fields": props}


_DATE_RE1 = re.compile(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$")
_DATE_RE2 = re.compile(r"^(\d{4})年(\d{1,2})月(\d{1,2})日$")


def norm_date(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    m = _DATE_RE1.match(s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = _DATE_RE2.match(s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None  # 无法解析


def norm_number(s: str) -> float | None:
    s = (s or "").strip().replace(",", "").replace("，", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def extract_ids(resp: object) -> list:
    """从 batch_add 响应里尽量抽取新记录的 id。"""
    ids = []
    if isinstance(resp, dict):
        for k, v in resp.items():
            if k.lower() in ("id", "recordid", "record_id") and isinstance(v, str) and v:
                ids.append(v)
            elif isinstance(v, (dict, list)):
                ids.extend(extract_ids(v))
    elif isinstance(resp, list):
        for it in resp:
            ids.extend(extract_ids(it))
    return ids


def build_record(row: dict, schema_fields: dict, required: set, errors: list) -> dict | None:
    """把一行 CSV（列名->值）映射为 {字段名: PropertyValue}；非法则返回 None 并把错误写入 errors。"""
    rec = {}
    row_errors = []
    for col, val in row.items():
        col = (col or "").strip()
        if col not in schema_fields:
            continue  # 忽略未知列
        fdef = schema_fields[col]
        ftype = fdef["type"]
        v = (val or "").strip()
        if not v:
            continue
        if ftype == "number":
            n = norm_number(v)
            if n is None:
                row_errors.append(f"「{col}」不是有效数字: {val}")
                continue
            rec[col] = {"number": n}
        elif ftype == "date":
            d = norm_date(v)
            if d is None:
                row_errors.append(f"「{col}」日期无法识别: {val}")
                continue
            rec[col] = {"date": d}
        elif ftype == "select":
            if v not in fdef["options"]:
                row_errors.append(f"「{col}」取值「{val}」不在选项 {sorted(fdef['options'])} 内")
                continue
            rec[col] = {"select": v}
        else:  # text / 其它一律按文本
            rec[col] = {"text": v}
    # 必填校验
    for req in required:
        if req not in rec or not (rec[req].get("text") or rec[req].get("select") or rec[req].get("number") is not None or rec[req].get("date")):
            # 仅当该列在 schema 中且为空时视为缺必填
            if req in schema_fields and req not in rec:
                row_errors.append(f"缺少必填项「{req}」")
    if row_errors:
        errors.extend(row_errors)
        return None
    if not rec:
        errors.append("整行无有效字段")
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--database-id", dest="database_id", required=True)
    ap.add_argument("--csv", dest="csv", required=True)
    ap.add_argument("--required", dest="required", default="")
    ap.add_argument("--dry-run", dest="dry_run", action="store_true")
    ap.add_argument("--token-stdin", dest="token_stdin", action="store_true")
    args, _ = ap.parse_known_args()

    token = os.environ.get("LIB_TOKEN", "").strip()
    if args.token_stdin:
        token = (sys.stdin.readline() if not token else token)

    if not token:
        print(json.dumps({"error": "token 缺失（用 --token-stdin 注入或设置 LIB_TOKEN 环境变量）"}, ensure_ascii=False))
        return

    csv_path = args.csv.strip()
    if not os.path.isfile(csv_path):
        print(json.dumps({"error": f"CSV 文件不存在: {csv_path}"}, ensure_ascii=False))
        return

    required = {x.strip() for x in args.required.split(",") if x.strip()}

    # 读取 CSV
    rows = []
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        lines = list(reader)
    if not lines:
        print(json.dumps({"error": "CSV 为空"}, ensure_ascii=False))
        return
    header = [h.strip() for h in lines[0]]
    for raw in lines[1:]:
        if not any(c.strip() for c in raw):
            continue
        # 补齐/截断到 header 长度
        cells = (raw + [""] * len(header))[: len(header)]
        rows.append(dict(zip(header, cells)))

    # schema
    try:
        schema = fetch_schema(token, args.database_id)
    except Exception as e:
        print(json.dumps({"error": f"获取资料库结构失败: {e}"}, ensure_ascii=False))
        return

    fields = schema["fields"]
    # 列匹配提示
    matched = [h for h in header if h in fields]
    ignored = [h for h in header if h and h not in fields]

    records = []
    all_errors = []
    for i, row in enumerate(rows, start=2):  # 数据行从第 2 行起
        rec = build_record(row, fields, required, all_errors)
        if rec:
            records.append(rec)
        else:
            # 把行号附到该行的错误上
            pass
    # 给错误加行号（粗略：按顺序配对）
    # 简化：把错误按条记录收集更清晰，这里直接输出错误文本
    if args.dry_run:
        print(json.dumps({
            "database_id": args.database_id,
            "title": schema.get("title"),
            "total_rows": len(rows),
            "valid_records": len(records),
            "matched_columns": matched,
            "ignored_columns": ignored,
            "errors": all_errors,
            "dry_run": True,
        }, ensure_ascii=False, indent=2))
        return

    # 分批写入（每批 100）
    created_ids = []
    batch_errors = []
    BATCH = 100
    for start in range(0, len(records), BATCH):
        batch = records[start:start + BATCH]
        payload = json.dumps(
            {"database_id": args.database_id, "records": batch},
            ensure_ascii=False,
        )
        try:
            out = _run_skill("batch_add_database_records.py", token, payload)
            out_line = out.splitlines()[-1] if out.splitlines() else out
            resp = json.loads(out_line) if out_line else {}
            created_ids.extend(extract_ids(resp))
        except Exception as e:
            batch_errors.append(f"第 {start+1}-{start+len(batch)} 条写入失败: {e}")

    result = {
        "database_id": args.database_id,
        "title": schema.get("title"),
        "total_rows": len(rows),
        "imported": len(created_ids),
        "created_ids": created_ids,
        "validation_errors": all_errors,
        "batch_errors": batch_errors,
        "matched_columns": matched,
        "ignored_columns": ignored,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
