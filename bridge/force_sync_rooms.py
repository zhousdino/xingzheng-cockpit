import json, subprocess, sys, urllib.request

SKILL_DIR = r"C:\Users\周舟\.workbuddy\plugins\cache\workbuddy-builtin\tencent-docs-plugin\1.0.0\skills\tencent-docs"
PY = r"C:\Users\周舟\.workbuddy\binaries\python\versions\3.13.12\python.exe"
OUT = r"D:\微云文件\知识库\落地的做法\行政部的驾驶舱\bridge\drop\tencent\tencent_room.csv"

params = {
    "file_url": "https://docs.qq.com/sheet/DUFNXTnBsV1pGYmZ4?tab=BB08J2",
    "sheet_id": "BB08J2",
    "start_row": 0, "start_col": 0, "end_row": 60, "end_col": 14,
    "return_csv": True,
}
p = subprocess.run([PY, "tencentdocs.py", "tdoc_call", "sheet-mcp", "get_cell_data", json.dumps(params)],
                   cwd=SKILL_DIR, capture_output=True, text=True, encoding="utf-8")
raw = (p.stdout or "") + (p.stderr or "")
outer = json.loads(raw)
inner_text = outer["result"]["content"][0]["text"]
inner = json.loads(inner_text)
csv = inner["csv_data"]
with open(OUT, "w", encoding="utf-8") as f:
    f.write(csv)
print("wrote", len(csv), "bytes ->", OUT)

try:
    req = urllib.request.Request("http://localhost:8787/api/upload",
        data=json.dumps({"type": "rooms", "text": csv}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    r = urllib.request.urlopen(req, timeout=5)
    print("pushed to bridge:", r.status)
except Exception as e:
    print("bridge push skipped:", e)
