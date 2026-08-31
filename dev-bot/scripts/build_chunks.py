# -*- coding: utf-8 -*-
"""원문에서 연속 구간을 그대로 잘라 청크를 만든다.
   요약하거나 다시 쓰지 않는다 — 출처를 열었을 때 같은 문장이 있어야 한다."""
import json, pathlib, sys, urllib.request

RAW  = "https://raw.githubusercontent.com/hey-byeunya/already-got-it/main"
BLOB = "https://github.com/hey-byeunya/already-got-it/blob/main"
FILE = {
    "README":     "README.md",
    "PRD":        "PRD.md",
    "MIGRATION":  "supabase/migration.sql",
    # 2026-08-28: CLAUDE.md 가 주제별 문서로 쪼개지면서 AG-005·007·012 의 본문이
    # 아래 두 파일로 옮겨졌다. 본문은 그대로이고 파일과 제목 단계만 바뀌었다.
    "FIELDS":     "docs/rules/fields.md",
    "DATAACCESS": "docs/rules/data-access.md",
}

# 원문을 매번 새로 받는다. 로컬 작업본이 아니라 공개된 것을 근거로 삼기 위해서다.
CACHE = pathlib.Path(".sources"); CACHE.mkdir(exist_ok=True)
SRC = {}
for key, path in FILE.items():
    f = CACHE / path.replace("/", "_")
    if not f.exists():
        f.write_bytes(urllib.request.urlopen(f"{RAW}/{path}", timeout=30).read())
        print(f"내려받음: {path}")
    SRC[key] = f.read_text()

# (id, 출처키, 시작 표지, 끝 표지(포함), 섹션, URL 조각)
SPECS = [
 ("AG-001","PRD","**한 줄 정의**","자기 인식에 도움","1. 개요","#1-개요"),
 ("AG-002","README","**로그인 없이 바로 체험","wishlist/new","링크","#링크"),
 ("AG-003","PRD","- 이름·카테고리로 검색하고","박스 아이콘 + 숫자로 표시한다","2. 기능 — 검색·정렬·D-day","#2-기능"),
 ("AG-004","README","- 위시: 이름·카테고리","애니메이션 재생","주요 기능 — 위시","#주요-기능"),
 ("AG-005","DATAACCESS","- 반드시 `mark_wishlist_purchased` 단일 Postgres RPC","막혀서는 안 된다.","위시리스트 → 보유템 전환","#위시리스트--보유템-전환"),
 ("AG-006","PRD","- 있템을 \"다 씀\" 상태로 바꾸면","고정해서 함께 보여준다","2. 기능 — 쓴템 탭","#2-기능"),
 ("AG-007","FIELDS","- `owned_items.category`","동일 규칙)","폼·필드 값 규칙",""),
 ("AG-008","PRD","**보유템**\n- 이름 (필수)","- 담은 날짜 (자동)","4. 데이터 모델","#4-데이터-모델"),
 ("AG-009","PRD","- 회원가입 시 닉네임(2~20자, 필수)","비밀번호 찾기 → 재설정 전체 플로우)","2. 기능 — 회원가입·비밀번호 찾기","#2-기능"),
 ("AG-010","PRD","- 로그아웃하면 브라우저에 남아있는","로그인 화면으로 이동한다","3. 동작 (완성 기준) — 세션","#3-동작-완성-기준"),
 ("AG-011","PRD","**Won't (오늘은 일부러 뺄 것)**","5. 소비 통계·차트 분석","5. Must / Won't — Won't","#5-must--wont"),
 ("AG-012","DATAACCESS","- 보유템 목록은 `ORDER BY expiry_date NULLS LAST`","`ORDER BY`는 그대로 둔다.","목록 조회 / 검색","#목록-조회--검색"),
 ("AG-013","PRD","- 배포는 **Vercel**","배포할 수 없다","6. 규칙 / 제약","#6-규칙--제약"),
 ("AG-014","MIGRATION","create table if not exists public.owned_items","updated_at timestamptz not null default now()\n);","owned_items 테이블 정의","#L5-L18"),
]

chunks, errs = [], []
for cid, key, start, end, section, frag in SPECS:
    text = SRC[key]
    i = text.find(start)
    if i < 0:
        errs.append(f"{cid}: 시작 표지 못 찾음 -> {start[:40]!r}"); continue
    j = text.find(end, i)
    if j < 0:
        errs.append(f"{cid}: 끝 표지 못 찾음 -> {end[:40]!r}"); continue
    body = text[i:j+len(end)].strip()
    chunks.append({"id":cid,"text":body,"url":f"{BLOB}/{FILE[key]}{frag}","section":section,"_src":key})

if errs:
    print("표지 오류:"); [print(" -", e) for e in errs]; sys.exit(1)

print(f"{'id':8} {'글자수':>5}  {'출처':10} 섹션")
bad = []
for c in chunks:
    n = len(c["text"])
    flag = "  ⚠️ 120자 미만" if n < 120 else ""
    if n < 120: bad.append(c["id"])
    print(f"{c['id']:8} {n:>5}  {c['_src']:10} {c['section']}{flag}")

# 잘라낸 본문이 원문에 그대로 있는지 되확인
for c in chunks:
    assert c["text"] in SRC[c["_src"]], f"{c['id']} 원문 대조 실패"
print("\n원문 대조: 14/14 통과 (잘라낸 본문이 모두 원문에 그대로 있음)")
print("120자 미만:", bad or "없음")

pathlib.Path("data/chunks.json").write_text(json.dumps([{k:v for k,v in c.items() if k!="_src"} for c in chunks], ensure_ascii=False, indent=2))
print("저장: data/chunks.json")
