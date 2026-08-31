# -*- coding: utf-8 -*-
"""검색 스팟체크 — 예상 질문의 top-1·top-3 을 기록한다.

임베딩은 만들지 않는다. 문서 벡터와 질문 벡터를 모두
embed-docs-browser-path.mjs 가 만든 것만 읽는다 — 여기서 다른 방법으로
질문을 임베딩하면 두 벡터가 다른 공간에 놓여 점수가 뜻을 잃는다.

준비:
  node scripts/embed-docs-browser-path.mjs
  node scripts/embed-docs-browser-path.mjs --queries data/spotcheck-queries.json
실행:
  python3 scripts/check_retrieval.py
"""
import json, pathlib, sys

DOCS    = pathlib.Path("app/public/already-got-it-docs.json")
QVECS   = pathlib.Path(".sources/query-vectors.json")
QUERIES = pathlib.Path("data/spotcheck-queries.json")

for f in (DOCS, QVECS, QUERIES):
    if not f.exists():
        sys.exit(f"없음: {f}\n먼저 embed-docs-browser-path.mjs 를 돌린다 (파일 첫머리 참고)")

docs    = json.loads(DOCS.read_text())
qvecs   = {r["query"]: r["vector"] for r in json.loads(QVECS.read_text())}
queries = json.loads(QUERIES.read_text())

# 문서 벡터가 모두 768차원인지 여기서도 확인한다 (과거 384차원 산출물이 섞이지 않았는지)
dims = {len(d["vector"]) for d in docs}
if dims != {768}:
    sys.exit(f"문서 벡터 차원이 섞여 있다: {sorted(dims)}")

def cos(a, b):
    # 둘 다 L2 정규화되어 있으므로 내적이 곧 코사인 유사도다
    return sum(x * y for x, y in zip(a, b))

print(f"문서 {len(docs)}개 · 질문 {len(queries)}개 · 모든 벡터 768차원\n")
print(f"{'질문':44} {'top-1':9} {'점수':>6}  {'기대와':6} top-3")
print("-" * 118)

hit = miss = 0
weak_ok = weak_bad = 0
rows = []
for item in queries:
    q, expect, kind = item["q"], item["expect"], item["kind"]
    if q not in qvecs:
        sys.exit(f"질문 벡터 없음: {q} — --queries 로 다시 만든다")
    scored = sorted(((cos(qvecs[q], d["vector"]), d["id"]) for d in docs), reverse=True)
    top3 = scored[:3]
    top1_score, top1_id = top3[0]

    in3 = any(i in expect for _, i in top3)
    if expect:
        ok = top1_id in expect
        mark = "일치" if ok else ("top3" if in3 else "놓침")
        hit, miss = hit + ok, miss + (not ok)
    else:
        # 범위 밖 질문은 top-1 이 무엇이든 상관없다. 점수가 0.55 미만으로
        # 내려가 약한 근거로 잡히는지가 관찰 대상이다.
        ok = top1_score < 0.55
        mark = "약함" if ok else "⚠️강함"
        weak_ok, weak_bad = weak_ok + ok, weak_bad + (not ok)

    t3 = "  ".join(f"{i}({s:.3f})" for s, i in top3)
    print(f"{q:44} {top1_id:9} {top1_score:6.3f}  {mark:6} {t3}")
    rows.append({"q": q, "kind": kind, "top1": top1_id, "score": round(top1_score, 4),
                 "top3": [{"id": i, "score": round(s, 4)} for s, i in top3],
                 "expect": expect, "top1_ok": bool(expect and top1_id in expect),
                 "top3_ok": bool(expect and in3), "weak": bool(top1_score < 0.55)})

print("-" * 118)
n3 = sum(1 for r in rows if r["expect"] and r["top3_ok"])
print(f"근거 있는 질문 top-1 일치 : {hit}/{hit + miss}")
print(f"근거 있는 질문 top-3 포함 : {n3}/{hit + miss}")
print(f"범위 밖 질문 0.55 미만    : {weak_ok}/{weak_ok + weak_bad}")

inb = [r["score"] for r in rows if r["expect"]]
oob = [r["score"] for r in rows if not r["expect"]]
print(f"\n점수 분포")
print(f"  근거 있는 질문 : {min(inb):.3f} ~ {max(inb):.3f}")
print(f"  범위 밖 질문   : {min(oob):.3f} ~ {max(oob):.3f}")
print(f"  두 무리 사이 틈 : {min(inb) - max(oob):+.3f}  (양수여야 0.55 같은 하나의 선으로 가를 수 있다)")

pathlib.Path("data/spotcheck-result.json").write_text(
    json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
print("\n기록: data/spotcheck-result.json")
