# -*- coding: utf-8 -*-
"""임베딩 방식 두 가지를 나란히 놓고, 두 무리가 갈리는지 본다.

수용 기준 5번은 "최고 유사도가 0.55 미만인 질문"을 요구하는데, C 에서 재 보니
그런 질문이 하나도 없었다. 근거 있는 질문 0.633~0.792, 범위 밖 0.584~0.648 로
두 무리가 겹쳐서(틈 -0.015) 어떤 값을 잡아도 가를 수 없었다.

여기서 재는 것은 점수의 높낮이가 아니라 **두 무리 사이의 틈**이다.
틈이 양수여야 하나의 선으로 가를 수 있고, 그래야 임계값에 뜻이 생긴다.

    python3 scripts/compare_embedding.py
"""
import json, pathlib, sys

SETS = {
    "맨 문장 (기준)": ("app/public/already-got-it-docs.json", ".sources/query-vectors.json"),
    "접두어 붙임":     (".sources/docs-prefixed.json",         ".sources/qvec-prefixed.json"),
    "sentence_embedding": (".sources/docs-se.json",           ".sources/qvec-se.json"),
}
QUERIES = json.loads(pathlib.Path("data/spotcheck-queries.json").read_text())

# 호출 전 검사가 막는 질문은 검색에 도달하지 않는다. 임계값이 처리할 대상이 아니므로
# 측정에서 뺀다 — 게이트가 걷어낸 것을 임계값 탓으로 돌리면 안 된다.
GATED = json.loads(pathlib.Path("data/gate-result.json").read_text())
GATED_QS = {r["q"] for r in GATED if r["actual"]}
skipped = [q["q"] for q in QUERIES if q["q"] in GATED_QS]
QUERIES = [q for q in QUERIES if q["q"] not in GATED_QS]
if skipped:
    print(f"호출 전 검사가 막아 측정에서 뺀 질문 {len(skipped)}개:")
    for q in skipped:
        print(f"  · {q}")
    print()

def cos(a, b):
    return sum(x * y for x, y in zip(a, b))

report = {}
for name, (dpath, qpath) in SETS.items():
    for f in (dpath, qpath):
        if not pathlib.Path(f).exists():
            sys.exit(f"없음: {f}")
    docs = json.loads(pathlib.Path(dpath).read_text())
    qv = {r["query"]: r["vector"] for r in json.loads(pathlib.Path(qpath).read_text())}

    rows = []
    for item in QUERIES:
        q, expect = item["q"], item["expect"]
        if q not in qv:
            sys.exit(f"질문 벡터 없음: {q}")
        scored = sorted(((cos(qv[q], d["vector"]), d["id"]) for d in docs), reverse=True)
        top1, top1_id = scored[0]
        in3 = any(i in expect for _, i in scored[:3])
        rows.append({"q": q, "expect": expect, "top1": top1, "top1_id": top1_id,
                     "top1_ok": bool(expect) and top1_id in expect, "top3_ok": bool(expect) and in3})

    inb = [r["top1"] for r in rows if r["expect"]]
    oob = [r["top1"] for r in rows if not r["expect"]]
    report[name] = {
        "rows": rows,
        "in_min": min(inb), "in_max": max(inb),
        "oob_min": min(oob), "oob_max": max(oob),
        "gap": min(inb) - max(oob),
        "top1": sum(r["top1_ok"] for r in rows if r["expect"]),
        "top3": sum(r["top3_ok"] for r in rows if r["expect"]),
        "n_in": len(inb),
    }

print(f"{'':18} {'근거 있는 질문':>20} {'범위 밖 질문':>20} {'두 무리 사이 틈':>16} {'top-1':>8} {'top-3':>8}")
print("-" * 96)
for name, r in report.items():
    print(f"{name:18} {r['in_min']:.3f} ~ {r['in_max']:.3f}{'':>7} "
          f"{r['oob_min']:.3f} ~ {r['oob_max']:.3f}{'':>7} "
          f"{r['gap']:+.3f}{'':>10} {r['top1']}/{r['n_in']:<6} {r['top3']}/{r['n_in']}")
print("-" * 96)

for name, r in report.items():
    ok = r["gap"] > 0
    print(f"\n{name}")
    print(f"  틈 {r['gap']:+.3f} — {'양수. 하나의 선으로 가를 수 있다' if ok else '음수. 두 무리가 겹쳐 어떤 값으로도 가를 수 없다'}")
    if ok:
        # 두 무리 사이 아무 값이나 되지만, 가운데를 잡으면 양쪽에서 가장 멀다
        mid = (r["oob_max"] + r["in_min"]) / 2
        print(f"  가를 수 있는 값의 범위 : {r['oob_max']:.3f} 초과 ~ {r['in_min']:.3f} 미만")
        print(f"  가운데 값             : {mid:.3f}")
        under = [x["q"] for x in r["rows"] if not x["expect"] and x["top1"] < mid]
        print(f"  이 값 미만이 되는 범위 밖 질문 : {len(under)}/{len([x for x in r['rows'] if not x['expect']])}")
        for q in under:
            print(f"      · {q}")

pathlib.Path("data/embedding-compare.json").write_text(
    json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "rows"} | {"rows": v["rows"]}
                for k, v in report.items()}, ensure_ascii=False, indent=2) + "\n")
print("\n기록: data/embedding-compare.json")
