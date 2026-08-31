// 근거에 부정문이 들어 있는지 찾는다.
//
// 왜 필요한가.
// G 실험 4 에서 잰 것 — 답이 원문의 "~하지 않는다" 를 "~한다" 로 뒤집는 일이
// 12번 중 3번 일어났다. 프롬프트로 "원문을 그대로 옮겨 적으라" 고 요구해 봤지만
// 뒤집힘은 3/12 에서 하나도 줄지 않았다. 원문을 57자나 정확히 인용해 놓고
// 바로 앞에서 반대로 결론 낸 답도 있었다.
//
// 즉 **프롬프트로는 못 고친다.** 문제는 옮겨 적기가 아니라 읽기다.
// 그래서 고치는 대신 **그 자리를 사용자에게 알린다.** 게이트와 같은 접근이다 —
// 모델에게 부탁하지 않고 프로그램이 한다.
//
// 이 검사는 근거 조각의 원문만 본다. 답변을 검사하지 않는다 —
// 답이 뒤집혔는지 판단하려면 뜻을 읽어야 하고, 그것이 바로 안 되는 일이다.

/** 뜻을 뒤집는 표현. 답에서 이 부정이 사라지면 정반대가 된다. */
const NEGATION = /하지 않는다|하지 않습니다|않는다|않습니다|안 된다|안 됩니다|못한다|없다|없습니다|말아야|금지/g;

export type NegationHit = {
  /** 부정이 든 문장 (원문 그대로) */
  sentence: string;
  /** 그 문장에서 걸린 표현들 */
  marks: string[];
};

/**
 * 원문에서 부정이 든 문장을 뽑는다.
 * 문장 단위로 자르는 이유는, 화면에 보여 줄 때 어디를 대조해야 하는지
 * 가리키기 위해서다.
 */
export function findNegations(text: string): NegationHit[] {
  const out: NegationHit[] = [];
  // 마침표·줄바꿈·불릿으로 자른다. 한국어 문서라 마침표가 드물어 줄바꿈도 쓴다.
  for (const raw of text.split(/(?<=다\.)|\n/)) {
    const s = raw.trim().replace(/^-\s*/, "");
    if (!s) continue;
    const marks = [...new Set(s.match(NEGATION) ?? [])];
    if (marks.length) out.push({ sentence: s, marks });
  }
  return out;
}

/** 조각 하나라도 부정문을 담고 있는가 */
export function hasNegation(text: string): boolean {
  NEGATION.lastIndex = 0;
  return NEGATION.test(text);
}
