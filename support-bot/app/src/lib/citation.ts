// 답변이 근거를 실제로 가리켰는가 — **프로그램이 센다.**
//
// dev-bot 은 이것을 판정 모델에게 물었다. 그리고 자주 틀렸다 —
// 측정한 실패 108건 중 42건이 이 판정의 실패다. 두 번 고쳐 보고 두 번 다
// 되돌렸다: 생성 온도를 0으로(정확도 0.74 → 0.48), 표기를 [AG-004] 로 통일
// (표기는 100% 맞았는데 0.74 → 0.59). 어느 쪽으로 건드려도 나빠졌다.
//
// 남는 결론은 하나다 — 문제는 문구가 아니라, 답을 만든 것과 같은 작은 모델에게
// 판정을 맡긴 구조 자체다. 글자를 찾으면 끝나는 일을 모델에게 물을 이유가 없다.
//
// 여기서 세는 것은 전부 **뜻을 읽지 않고** 셀 수 있는 것뿐이다.
// 뜻을 읽어야 하는 것(근거성·환각·정당한 거절)은 judge.ts 에 남긴다.

/** 답변 본문의 인용 번호. `[1]`, `[1][2]`, `[1, 2]` 를 모두 잡는다. */
const CITE = /\[(\d+(?:\s*[,·]\s*\d+)*)\]/g;

/** 고객에게 보이면 안 되는 내부 문서 ID */
const INTERNAL_ID = /HELP-[A-Z]+-\d+/g;

/**
 * 번호 매긴 단계 — 「1. …」.
 *
 * 처음에는 줄 시작(`^`)만 봤는데, 모델이 「1. 위시 목록을 엽니다. 2. 카드에서
 * 누르세요.」처럼 **한 줄에 이어 쓰는** 일이 잦았다. 그러면 실제로는 두 단계를
 * 안내했는데 계수가 1로 나온다. 재려는 것은 「절차를 안내했는가」이지
 * 「줄바꿈을 넣었는가」가 아니므로, 문장 끝 뒤에 오는 번호도 센다.
 */
const NUMBERED = /(?:^|\n|[.!?]\s)\s*\d+[.)]\s+\S/g;

/**
 * 도움말에 나오는 화면·버튼 이름. 절차를 안내했다면 이 중 하나는 나온다.
 * 낱말 목록이라 완전하지 않다 — 그래서 이것만으로 절차형을 판정하지 않고
 * 번호 목록과 **함께** 있을 때만 절차형으로 센다.
 */
const SCREEN = /있템|위시|쓴템|로그인|회원가입|되돌리기|샀어요|다 쓴 것도 보기|비밀번호를 잊으셨나요|검색창|체크박스|카테고리 칩/;

export type CitationCheck = {
  /** 본문이 근거를 하나라도 가리켰는가 */
  cited: boolean;
  /** 본문에 나온 번호 (중복 제거, 오름차순) */
  numbers: number[];
  /** 근거 개수를 벗어난 번호 — 지어낸 인용이다 */
  outOfRange: number[];
  /** 본문에 새어 나온 내부 문서 ID */
  leakedIds: string[];
  /** 번호 목록으로 절차를 안내했는가 */
  procedural: boolean;
  /** 번호 목록 줄 수 */
  stepCount: number;
};

/**
 * @param answer   모델이 쓴 답변 본문 (프로그램이 붙이는 「참고한 도움말」은 빼고 넣는다)
 * @param hitCount 프롬프트에 넣은 근거 개수. 번호는 1..hitCount 안이어야 한다
 */
export function checkCitations(answer: string, hitCount: number): CitationCheck {
  const found = new Set<number>();
  for (const m of answer.matchAll(CITE)) {
    for (const part of m[1].split(/[,·]/)) {
      const n = Number(part.trim());
      if (Number.isInteger(n)) found.add(n);
    }
  }
  const numbers = [...found].sort((a, b) => a - b);
  const outOfRange = numbers.filter((n) => n < 1 || n > hitCount);
  const steps = answer.match(NUMBERED) ?? [];

  return {
    // 지어낸 번호만 있는 답을 「인용했다」로 세지 않는다
    cited: numbers.some((n) => n >= 1 && n <= hitCount),
    numbers,
    outOfRange,
    leakedIds: [...new Set(answer.match(INTERNAL_ID) ?? [])],
    procedural: steps.length >= 2 && SCREEN.test(answer),
    stepCount: steps.length,
  };
}

/**
 * 답변 아래 붙는 「참고한 도움말」 목록.
 *
 * **모델이 쓰지 않는다.** 번호와 도움말 이름을 잇는 일은 프로그램이 한다 —
 * 모델이 쓰면 지어낼 수 있고, 지어낸 출처는 없는 출처보다 나쁘다.
 */
export function usedSources<T extends { chunk: { doc: string; section: string; url: string; id: string } }>(
  hits: T[],
  check: CitationCheck,
): { n: number; hit: T }[] {
  return check.numbers
    .filter((n) => n >= 1 && n <= hits.length)
    .map((n) => ({ n, hit: hits[n - 1] }));
}
