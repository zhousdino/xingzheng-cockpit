# -*- coding: utf-8 -*-
"""
wps_flatten.py —— 把 kdocs 连接器返回的 rangeData 拍平成 CSV。
用法：
  python wps_flatten.py input.json > out.csv
  # 或从 stdin： cat input.json | python wps_flatten.py
输入可以是：
  - 完整的 MCP 工具返回 JSON（含 code/message/data/detail/rangeData）
  - 或直接是 rangeData 数组
输出：标准 CSV（UTF-8，逗号分隔，引号转义），第一行是表头行。
"""
import sys, json, csv, io


def extract_range_data(obj):
    """从各种可能的结构里取出 rangeData 列表。"""
    if isinstance(obj, list):
        return obj
    if not isinstance(obj, dict):
        return []
    # data.detail.rangeData
    d = obj.get('data')
    if isinstance(d, dict):
        det = d.get('detail')
        if isinstance(det, dict) and isinstance(det.get('rangeData'), list):
            return det['rangeData']
        if isinstance(d.get('rangeData'), list):
            return d['rangeData']
    det = obj.get('detail')
    if isinstance(det, dict) and isinstance(det.get('rangeData'), list):
        return det['rangeData']
    if isinstance(obj.get('rangeData'), list):
        return obj['rangeData']
    return []


def flatten(rd):
    grid = {}
    maxr = 0
    maxc = 0
    for cell in rd:
        if not isinstance(cell, dict):
            continue
        r = cell.get('rowFrom', 0)
        c = cell.get('colFrom', 0)
        val = cell.get('originalCellValue', None)
        if val is None:
            val = cell.get('cellText', '')
        if val is None:
            val = ''
        grid[(r, c)] = '' if val is None else str(val)
        if r > maxr:
            maxr = r
        if c > maxc:
            maxc = c
    out = io.StringIO()
    w = csv.writer(out)
    for r in range(maxr + 1):
        row = [grid.get((r, c), '') for c in range(maxc + 1)]
        w.writerow(row)
    return out.getvalue()


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r', encoding='utf-8') as f:
            raw = f.read()
    else:
        raw = sys.stdin.read()
    try:
        obj = json.loads(raw)
    except Exception as e:
        sys.stderr.write('JSON 解析失败: %s\n' % e)
        sys.exit(1)
    rd = extract_range_data(obj)
    sys.stdout.write(flatten(rd))


if __name__ == '__main__':
    main()
