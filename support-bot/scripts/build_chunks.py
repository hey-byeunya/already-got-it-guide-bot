# -*- coding: utf-8 -*-
"""고객용 도움말에서 절 단위로 청크를 만든다.

dev-bot 은 남의 문서(PRD·SQL·rules)에서 시작·끝 표지로 구간을 오려냈다.
여기는 우리가 쓴 도움말이라 **절(##) 하나가 곧 청크 하나**다. 규칙이 단순해지는
대신, 절 제목이 바뀌면 링크의 앵커와 ID 짝이 함께 깨진다. 그래서 기대하는
제목 목록을 아래 MANIFEST 에 박아 두고, 하나라도 없으면 멈춘다.

  python3 scripts/build_chunks.py                      # main 에서 받아 만든다
  python3 scripts/build_chunks.py --ref docs/help-center  # 아직 머지 전인 브랜치로 시험
  python3 scripts/build_chunks.py --cached             # 이미 받아 둔 것을 쓴다
  python3 scripts/build_chunks.py --no-anchor-check    # 앵커 확인을 건너뛴다

--ref 로 main 이 아닌 곳에서 받으면 출처 URL(항상 main 을 가리킨다)이 아직
살아 있지 않다. 그때는 결과에 pendingRef 표시를 남기고, 임베딩 단계가
그 표시를 보고 벡터스토어 만들기를 거부한다.
"""
import json, pathlib, re, sys, urllib.request

REPO = "hey-byeunya/already-got-it"
RAW  = f"https://raw.githubusercontent.com/{REPO}"
BLOB = f"https://github.com/{REPO}/blob/main"

FILES = {
    "GET":  ("docs/help/getting-started.md",  "시작하기"),
    "ITEM": ("docs/help/register-item.md",    "있템 등록"),
    "WISH": ("docs/help/wishlist.md",         "위시리스트"),
    "USED": ("docs/help/used-items.md",       "쓴템"),
    "FIND": ("docs/help/search-and-dday.md",  "찾기와 D-day"),
    "ACCT": ("docs/help/account-and-data.md", "계정과 내 데이터"),
    "FAQ":  ("docs/help/faq.md",              "자주 묻는 질문"),
}

# 주제코드 → 그 문서에서 청크로 만들 절 제목(원문 그대로, 순서대로)
MANIFEST = {
    "GET": [
        "회원가입하기",
        "로그인하기",
        "비밀번호를 잊으셨을 때",
        "로그아웃하면 무엇이 지워지나요",
    ],
    "ITEM": [
        "등록하는 순서",
        "무엇이 필수이고 무엇이 선택인가요",
        "카테고리는 왜 꼭 넣어야 하나요",
        "수량과 상태에 어떤 규칙이 있나요",
    ],
    "WISH": [
        "위시에 담기",
        "샀을 때 있템으로 옮기기",
        "옮길 때 값이 어떻게 넘어가나요",
    ],
    "USED": [
        "다 쓴 물건은 어디로 가나요",
        "다시 되돌리기",
        "있템 목록에서 함께 보기",
    ],
    "FIND": [
        "이름이나 카테고리로 찾기",
        "D-day 배지 네 가지",
        "어제 본 숫자와 오늘 숫자가 다른 이유",
    ],
    "ACCT": [
        "어떤 정보가 저장되나요",
        "로그인 없이 둘러보기",
        "다른 계정으로 바꿔서 쓸 때",
    ],
    "FAQ": [
        "사용기한이 다가오면 알림이 오나요",
        "바코드를 찍어서 등록할 수 있나요",
        "카테고리를 자동으로 정해 주나요",
        "얼마나 썼는지 통계를 볼 수 있나요",
        "닉네임을 바꾸거나 탈퇴할 수 있나요",
        "이 앱은 무료인가요",
    ],
}

MIN_CHARS = 120


def github_anchor(heading: str) -> str:
    """GitHub 가 제목에서 만드는 앵커와 같은 규칙 — 소문자화, 기호 제거, 공백은 하이픈."""
    s = heading.strip().lower()
    s = re.sub(r"[^\w\s\-]", "", s, flags=re.UNICODE)
    return s.replace(" ", "-")


def fetch(path: str, ref: str, use_cache: bool) -> str:
    cache = pathlib.Path(".sources")
    cache.mkdir(exist_ok=True)
    f = cache / f"{ref.replace('/', '_')}__{path.replace('/', '_')}"
    if use_cache and f.exists():
        return f.read_text()
    # 로컬 작업본이 아니라 **공개된 것**을 근거로 삼는다. 매번 새로 받는다.
    f.write_bytes(urllib.request.urlopen(f"{RAW}/{ref}/{path}", timeout=30).read())
    print(f"  받음: {path}")
    return f.read_text()


def split_sections(text: str) -> dict[str, str]:
    """'## 제목' 부터 다음 '## ' 직전까지를 한 절로 자른다. 제목 줄을 포함한다."""
    out, cur, buf = {}, None, []
    for line in text.split("\n"):
        if line.startswith("## "):
            if cur is not None:
                out[cur] = "\n".join(buf).rstrip()
            cur, buf = line[3:].strip(), [line]
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        out[cur] = "\n".join(buf).rstrip()
    return out


def check_anchors(chunks: list, ref: str) -> list[str]:
    """출처 주소의 앵커가 실제로 그 자리로 가는가.

    링크가 열리는 것과 그 자리로 가는 것은 다르다. 제목을 고치면 문서는 그대로
    열리는데 앵커만 죽는다 — 눈으로는 보이지 않는 실패다. 그래서 GitHub 이
    제목마다 붙이는 href="#앵커" 를 직접 찾아본다.
    """
    pages, problems = {}, []
    for c in chunks:
        path, anchor = c["url"].split("/blob/main/")[1].split("#")
        if path not in pages:
            url = f"https://github.com/{REPO}/blob/{ref}/{path}"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                pages[path] = urllib.request.urlopen(req, timeout=30).read().decode()
            except Exception as e:
                problems.append(f"{path}: 문서 페이지를 열지 못함 — {e}")
                pages[path] = ""
        if pages[path] and f'href="#{anchor}"' not in pages[path]:
            problems.append(f"{c['id']}: 앵커가 그 자리로 가지 않는다 → #{anchor} ({path})")
    return problems


def main() -> int:
    argv = sys.argv[1:]
    ref = argv[argv.index("--ref") + 1] if "--ref" in argv else "main"
    use_cache = "--cached" in argv

    print(f"원문 받는 중 (ref: {ref})")
    chunks, problems = [], []

    for code, (path, doc) in FILES.items():
        try:
            sections = split_sections(fetch(path, ref, use_cache))
        except Exception as e:
            problems.append(f"{path}: 받지 못함 — {e}")
            continue

        for n, heading in enumerate(MANIFEST[code], start=1):
            cid = f"HELP-{code}-{n:02d}"
            if heading not in sections:
                problems.append(f"{cid}: 절 제목을 찾지 못함 → '{heading}' ({path})")
                continue
            text = sections[heading]
            if len(text) < MIN_CHARS:
                problems.append(f"{cid}: {len(text)}자 — {MIN_CHARS}자 미만 ({heading})")
            chunks.append({
                "id": cid,
                "url": f"{BLOB}/{path}#{github_anchor(heading)}",
                "doc": doc,
                "section": heading,
                "text": text,
            })

    # 앵커가 겹치면 두 청크가 같은 자리를 가리킨다
    seen = {}
    for c in chunks:
        if c["url"] in seen:
            problems.append(f"{c['id']}: 출처 주소가 {seen[c['url']]} 와 같다")
        seen[c["url"]] = c["id"]

    if not problems and "--no-anchor-check" not in argv:
        print("앵커 확인 중 (문서 페이지에서 그 자리로 가는지)")
        problems += check_anchors(chunks, ref)

    if problems:
        print("\n멈춤 — 아래를 고치기 전에는 쓰지 않는다:")
        for p in problems:
            print(f"  - {p}")
        return 1

    out = pathlib.Path("data/chunks.json")
    out.parent.mkdir(exist_ok=True)
    payload = chunks
    if ref != "main":
        # 출처 URL 은 main 을 가리키는데 아직 main 에 없다. 임베딩 단계가 이 표시를 보고 멈춘다.
        payload = {"pendingRef": ref, "chunks": chunks}
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2))

    lens = [len(c["text"]) for c in chunks]
    print(f"\n청크 {len(chunks)}개 → {out}")
    print(f"  글자수   : 최소 {min(lens)} · 최대 {max(lens)} · 합계 {sum(lens)}")
    print(f"  {MIN_CHARS}자 이상 : {len(chunks)}/{len(chunks)} 통과")
    print(f"  앵커 중복 : 없음")
    if "--no-anchor-check" not in argv:
        print(f"  앵커 도달 : {len(chunks)}/{len(chunks)} 통과")
    for code, (_, doc) in FILES.items():
        print(f"  {doc:<12} {sum(1 for c in chunks if c['id'].startswith(f'HELP-{code}-'))}개")
    if ref != "main":
        print(f"\n⚠️  ref 가 main 이 아니다({ref}). 출처 URL 은 아직 열리지 않는다.")
        print(f"    pendingRef 표시를 남겼다 — 임베딩 단계가 이 표시를 보고 멈춘다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
