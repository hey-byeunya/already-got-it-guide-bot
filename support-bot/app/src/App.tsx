import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildBm25Index, cosine, hybridSearch, keywordOnlySearch,
  type Bm25Index, type Chunk, type Hit,
} from "./lib/search.ts";
import { embed, type Progress } from "./lib/embed.ts";
import { buildPrompt, kstNow } from "./lib/prompt.ts";
import { checkConnection, MODEL, streamChat, type Connection } from "./lib/ollama.ts";
import { judge, type JudgeOutcome } from "./lib/judge.ts";
import { checkBeforeCall, type GateRule } from "./lib/gate.ts";
import { checkCitations, usedSources, type CitationCheck } from "./lib/citation.ts";
import { findNegations, hasNegation } from "./lib/negation.ts";
import { FAQ_BUTTONS, HTTPS_NOTE, USAGE_STEPS } from "./lib/usage-steps.ts";

/** 사용 조건 문장의 `백틱`을 코드로 보인다. 문자열 자체는 README 와 같게 둔다. */
function renderTicks(s: string) {
  return s.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`")
      ? <code key={i}>{part.slice(1, -1)}</code>
      : <span key={i}>{part}</span>,
  );
}

/** 상담 답변 본문. 번호 목록과 굵은 글씨만 살린다 — 모델이 쓰는 것은 그 둘뿐이다. */
function AnswerBody({ text }: { text: string }) {
  return (
    <div className="text">
      {text.split("\n").map((line, i) => {
        const parts = line.split(/(\*\*[^*]+\*\*)/).map((p, j) =>
          p.startsWith("**") && p.endsWith("**")
            ? <strong key={j}>{p.slice(2, -2)}</strong>
            : <span key={j}>{p}</span>,
        );
        return <p key={i} className={/^\s*\d+[.)]\s/.test(line) ? "step" : undefined}>{parts}</p>;
      })}
    </div>
  );
}

/** 판정 배지 하나. neutral 은 참/거짓이 곧 좋고 나쁨이 아닌 항목(refusal)에 쓴다. */
function Badge({ on, label, off, neutral }: { on: boolean; label: string; off: string; neutral?: boolean }) {
  return <li className={neutral ? "neutral" : on ? "yes" : "no"}>{on ? label : off}</li>;
}

/**
 * Ollama 에 닿지 못했을 때 보여 줄 안내.
 * 브라우저는 "Failed to fetch" 밖에 주지 않는다. 그대로 보여 주면 고객은
 * 무엇을 해야 할지 알 수 없고, 페이지가 고장 난 줄 안다.
 */
function cannotReach(reason: string): string {
  const https = typeof location !== "undefined" && location.protocol === "https:";
  return [
    "이 컴퓨터의 Ollama 에 닿지 못해 상담 답변을 만들지 못했습니다.",
    reason,
    https
      ? `⚠️ 지금 이 페이지는 HTTPS 입니다. ${HTTPS_NOTE.replace(/`/g, "")}`
      : "Ollama 가 켜져 있는지, 이 페이지 주소가 OLLAMA_ORIGINS 에 허용돼 있는지 확인해 주세요.",
  ].filter(Boolean).join("\n\n");
}

/** 라이브러리 내부 문구를 그대로 보여 주지 않는다. 원문은 지우지 않고 아래 줄에 남긴다. */
function unexpected(e: unknown, what: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return [`${what} 잠시 뒤 다시 해 주세요.`, `내부에서 온 메시지: ${raw}`].join("\n\n");
}

type Turn = {
  id: string;
  question: string;
  answer: string;
  hits: Hit[];
  weakEvidence: boolean;
  topScore: number;
  /** "상담" = 답변까지 만든 것, "도움말만" = Ollama 없이 도움말만 찾은 것 */
  mode: "상담" | "도움말만" | "막힘";
  error?: string;
  verdict?: JudgeOutcome;
  /** 인용을 프로그램이 센 결과. 판정 모델에게 묻지 않는다 */
  citation?: CitationCheck;
  feedback?: "up" | "down";
  gate?: { rule: GateRule; matched: string };
};

/** 사람이 누른 한 줄. 서버로 보내지 않는다 — 이 앱에는 백엔드가 없다. */
type FeedbackRecord = {
  turnId: string;
  at: string;
  where: string;
  model: string;
  question: string;
  feedback: "up" | "down";
  agreesWithJudge: boolean | null;
  mode: Turn["mode"];
  hits: number;
  topScore: number;
  weakEvidence: boolean;
  sources: { id: string; doc: string; section: string; method: string; score: number }[];
  answer: string;
  answerLen: number;
  /** 프로그램이 센 것 — 판정 모델의 말이 아니다 */
  citation: CitationCheck | null;
  verdict: JudgeOutcome | null;
};

/** 파일 이름에 쓸 KST 도장. `2026-08-31_1432` */
function kstStamp(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" })
    .format(now).replace(" ", "_").replace(":", "");
}

/** 판정이 이 답을 좋게 봤는가 — 근거에 닿았고 지어내지 않았는가 */
function judgeLikesAnswer(v: JudgeOutcome | undefined): boolean | null {
  return v?.ok ? v.verdict.grounded && v.verdict.noHalluc : null;
}

export default function App() {
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [index, setIndex] = useState<Bm25Index | null>(null);
  const [conn, setConn] = useState<Connection>({ state: "확인 중" });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [turn, setTurn] = useState<Turn | null>(null);
  const [openHit, setOpenHit] = useState<Hit | null>(null);
  /** 검토 모드 — 유사도·검색 방법·판정 배지를 편다. 기본은 접혀 있다 */
  const [review, setReview] = useState(false);
  const [parity, setParity] = useState<number | null>(null);
  const [parityError, setParityError] = useState<string | null>(null);
  const [feedbackLog, setFeedbackLog] = useState<FeedbackRecord[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("./help-docs.json")
      .then((r) => r.json())
      .then((cs: Chunk[]) => { setChunks(cs); setIndex(buildBm25Index(cs)); })
      .catch(() => {});
    // 주소에 ?review 가 있으면 검토 모드로 연다 — 발표·검토용
    if (typeof location !== "undefined" && location.search.includes("review")) setReview(true);
  }, []);

  const recheck = useCallback(() => {
    setConn({ state: "확인 중" });
    checkConnection().then(setConn);
  }, []);
  useEffect(recheck, [recheck]);

  /** 브라우저 임베딩이 Node 가 만든 문서 벡터와 같은 공간에 있는지 확인한다. */
  const runParityCheck = useCallback(async () => {
    setStage("임베딩 대조 중");
    setParityError(null);
    try {
      const anchor = await (await fetch("./parity-anchor.json")).json();
      setParity(cosine(await embed(anchor.text, setProgress), anchor.vector));
    } catch (e) {
      setParity(null);
      setParityError(unexpected(e, "임베딩 대조를 마치지 못했습니다."));
    } finally {
      setStage(null);
    }
  }, []);

  const recordFeedback = useCallback((t: Turn, f: "up" | "down") => {
    const likes = judgeLikesAnswer(t.verdict);
    const rec: FeedbackRecord = {
      turnId: t.id, at: kstNow(), where: location.href, model: MODEL,
      question: t.question, feedback: f,
      agreesWithJudge: likes === null ? null : (f === "up") === likes,
      mode: t.mode, hits: t.hits.length, topScore: t.topScore, weakEvidence: t.weakEvidence,
      sources: t.hits.map((h) => ({
        id: h.chunk.id, doc: h.chunk.doc, section: h.chunk.section, method: h.method, score: h.score,
      })),
      answer: t.answer, answerLen: t.answer.length,
      citation: t.citation ?? null, verdict: t.verdict ?? null,
    };
    setFeedbackLog((prev) => [...prev.filter((r) => r.turnId !== rec.turnId), rec]);
  }, []);

  const downloadFeedback = useCallback(() => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(feedbackLog, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `feedback-${kstStamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [feedbackLog]);

  async function ask(preset?: string) {
    const q = (preset ?? question).trim();
    if (!q || !chunks || !index) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    if (preset) setQuestion(preset);

    const id = crypto.randomUUID();
    const base: Turn = { id, question: q, answer: "", hits: [], weakEvidence: false, topScore: 0, mode: "상담" };
    setTurn(base);

    // 1. 호출 전 검사 — 모델도, 검색도 부르지 않는다.
    //    지시문에 적어 두었을 때는 세 번 중 한 번 새어 나갔다.
    const gate = checkBeforeCall(q);
    if (gate.blocked) {
      setTurn({ ...base, mode: "막힘", answer: gate.answer, gate: { rule: gate.rule, matched: gate.matched } });
      return;
    }

    // 2. 연결 확인. 닿지 않아도 여기서 멈추지 않는다 —
    //    BM25 는 모델 없이 도니까, 답변 대신 도움말이라도 찾아 드린다.
    setStage("연결 확인 중");
    const c = await checkConnection();
    setConn(c);

    if (c.state !== "연결됨" || !c.hasModel) {
      const hits = keywordOnlySearch(chunks, index, q);
      setTurn({
        ...base, mode: "도움말만", hits,
        error: c.state === "연결 안 됨" ? cannotReach(c.reason) : `${MODEL} 모델이 없습니다. 터미널에서 ollama pull ${MODEL} 을 실행해 주세요.`,
      });
      setStage(null);
      return;
    }

    try {
      setStage("질문을 읽는 중");
      const qv = await embed(q, setProgress);

      setStage("도움말을 찾는 중");
      const res = hybridSearch(chunks, index, qv, q);
      setTurn((t) => t && { ...t, hits: res.hits, weakEvidence: res.weakEvidence, topScore: res.topScore });

      setStage("답변을 쓰는 중");
      const prompt = buildPrompt(res.hits, q, res.weakEvidence);
      let answer = "";
      for await (const piece of streamChat(prompt, ctrl.signal)) {
        answer += piece;
        setTurn((t) => t && { ...t, answer });
      }

      // 3. 인용을 **프로그램이** 센다. 판정 모델에게 묻지 않는다.
      const citation = checkCitations(answer, res.hits.length);
      setTurn((t) => t && { ...t, citation });

      // 4. 뜻을 읽어야 하는 것만 모델에게 맡긴다.
      setStage("답변을 확인하는 중");
      const verdict = await judge(q, res.hits, answer, ctrl.signal);
      setTurn((t) => t && { ...t, verdict });
      setStage(null);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      const unreachable = e instanceof TypeError;
      setTurn((t) => t && {
        ...t,
        error: aborted ? "답변을 멈췄습니다." : unreachable ? cannotReach("") : unexpected(e, "답변을 마치지 못했습니다."),
      });
      setStage(null);
    }
  }

  const busy = stage !== null;
  const cited = turn?.citation ? usedSources(turn.hits, turn.citation) : [];
  const shownHits = review ? (turn?.hits ?? []) : (turn?.hits ?? []).slice(0, 5);

  return (
    <main>
      <header>
        <div className="head-row">
          <h1>이미 있어 고객센터</h1>
          <button className="ghost small" onClick={() => setReview((v) => !v)} aria-pressed={review}>
            {review ? "고객 화면으로" : "자세히 보기"}
          </button>
        </div>
        <p className="lede">
          <a href="https://already-got-it.vercel.app" target="_blank" rel="noreferrer">이미 있어</a> 사용 중
          궁금한 점을 물어봐 주세요. <strong>공개 도움말을 근거로</strong> 안내해 드리고,
          답변마다 <strong>어느 도움말을 참고했는지</strong> 함께 보여 드립니다.
        </p>
        {review && (
          <p className="note review-on">
            검토 모드입니다 — 유사도, 검색 방법, 자동 판정, 인용 계수가 함께 보입니다.
            고객이 보는 화면은 「고객 화면으로」를 누르면 됩니다.
          </p>
        )}
      </header>

      {!turn && (
        <section className="intro">
          <h2>이런 것을 물어보실 수 있습니다</h2>
          <ul className="faq-buttons">
            {FAQ_BUTTONS.map((q) => (
              <li key={q}><button className="faq" onClick={() => ask(q)} disabled={busy || !chunks}>{q}</button></li>
            ))}
          </ul>

          <h2>쓰기 전에 확인할 것</h2>
          <ol>{USAGE_STEPS.map((s, i) => <li key={i}>{renderTicks(s)}</li>)}</ol>
          <p className="note warn-note">⚠️ {renderTicks(HTTPS_NOTE)}</p>

          <h2>도와드릴 수 없는 것</h2>
          <ul className="cannot">
            <li>고객님 계정 안의 정보 — 내 있템이 몇 개인지, 무엇이 들어 있는지</li>
            <li>계정·비밀번호를 대신 조작하기 — 재설정 메일 발송, 닉네임 변경</li>
            <li>데이터를 대신 바꾸기 — 위시를 있템으로 옮기거나 상태 바꾸기</li>
            <li>도움말에 없는 이야기 — 오늘 날씨 같은 앱 밖의 일</li>
          </ul>
          <p className="note">
            도움말에서 확인되지 않는 질문에는 <strong>답을 지어내지 않고 확인되지 않는다고 알려 드립니다.</strong>
            어디까지 믿으셔도 되는지 아셔야 하기 때문입니다.
          </p>
        </section>
      )}

      {/* 연결 상태 — "오류" 가 아니라 무엇을 하면 되는지로 읽히게 */}
      {conn.state === "연결 안 됨" && (
        <div className="banner warn" role="status">
          <div>
            <strong>지금은 상담 답변을 만들어 드릴 수 없습니다.</strong>
            <p className="note">
              답변은 <strong>고객님 컴퓨터의 Ollama</strong>가 만듭니다. 지금 닿지 않습니다 — {conn.reason}
            </p>
            <p className="note">
              <strong>그래도 질문해 주세요.</strong> 관련 도움말은 찾아 드립니다. 이 페이지가 고장 난 것이 아닙니다.
            </p>
            {location.protocol === "https:" && <p className="note">⚠️ {renderTicks(HTTPS_NOTE)}</p>}
          </div>
          <button onClick={recheck}>다시 확인</button>
        </div>
      )}
      {conn.state === "연결됨" && !conn.hasModel && (
        <div className="banner warn" role="status">
          <div>
            <strong>Ollama는 켜져 있는데 {MODEL} 모델이 없습니다.</strong>
            <p className="note">터미널에서 <code>ollama pull {MODEL}</code> 을 실행해 주세요.</p>
          </div>
          <button onClick={recheck}>다시 확인</button>
        </div>
      )}
      {review && conn.state === "연결됨" && conn.hasModel && (
        <div className="banner ok" role="status">Ollama 연결됨 · {MODEL} 준비됨</div>
      )}

      <section className="ask">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
          placeholder="예: 위시에 담아둔 걸 샀는데 어떻게 옮겨요?"
          rows={2}
        />
        <div className="row">
          <button onClick={() => ask()} disabled={busy || !chunks}>물어보기</button>
          <button onClick={() => abort.current?.abort()} disabled={!busy}>답변 멈추기</button>
          {review && <button className="ghost" onClick={runParityCheck} disabled={busy}>임베딩 대조</button>}
          <button className="ghost" onClick={downloadFeedback} disabled={feedbackLog.length === 0}>
            피드백 내려받기{feedbackLog.length > 0 && ` (${feedbackLog.length}건)`}
          </button>
          {stage && <span className="stage">{stage}…</span>}
        </div>

        {/* 답변을 처음 받을 때 195MB 를 받는다. 몇 %인지 안 보이면 멈춘 것처럼 보인다 */}
        {progress && progress.stage !== "준비 끝" && (
          <div className="progress">
            <div className="progress-line">
              <span>{progress.stage}</span>
              {progress.detail && <span className="note">{progress.detail}</span>}
            </div>
            {progress.ratio !== undefined && (
              <div className="bar"><div className="fill" style={{ width: `${Math.round(progress.ratio * 100)}%` }} /></div>
            )}
            {progress.cached && <p className="note">받아 둔 것을 쓰므로 이번에는 기다리지 않습니다.</p>}
          </div>
        )}
        {feedbackLog.length > 0 && (
          <p className="note">
            남기신 피드백 {feedbackLog.length}건이 <strong>이 화면에만</strong> 있습니다 — 서버로 보내지 않고
            브라우저에도 저장하지 않습니다. <strong>새로고침하면 사라집니다.</strong>
          </p>
        )}
        {parityError && <p className="parity bad wrap">{parityError}</p>}
        {parity !== null && (
          <p className={parity > 0.999 ? "parity ok" : "parity bad"}>
            브라우저와 문서 벡터의 코사인: <strong>{parity.toFixed(6)}</strong>{" "}
            {parity > 0.999 ? "— 같은 공간입니다" : "— 어긋납니다. 이 화면의 점수는 뜻을 잃습니다"}
          </p>
        )}
      </section>

      {turn && (
        <section className="answer">
          <p className="asked">{turn.question}</p>

          {turn.gate && (
            <>
              <AnswerBody text={turn.answer} />
              {review && (
                <p className="note gate-note">
                  호출 전 검사에서 멈췄습니다 — <strong>{turn.gate.rule}</strong> (걸린 규칙: {turn.gate.matched}).
                  <strong> 모델을 부르지 않았습니다.</strong> 이 경계는 프로그램이 지킵니다 —
                  지시문으로 부탁했을 때는 세 번 중 한 번 지켜지지 않았습니다.
                </p>
              )}
            </>
          )}

          {turn.mode === "도움말만" && (
            <div className="banner warn">
              <div>
                <strong>상담 답변은 만들어 드리지 못했지만, 관련 도움말은 찾았습니다.</strong>
                <p className="note wrap">{turn.error}</p>
                <p className="note">
                  아래 도움말을 열어 확인해 주세요. 낱말이 겹치는 정도로만 찾은 것이라,
                  표현이 다르면 놓칠 수 있습니다.
                </p>
              </div>
            </div>
          )}

          {turn.weakEvidence && !turn.gate && (
            <div className="banner warn">
              <div>
                <strong>이 질문에 딱 맞는 도움말을 찾지 못했습니다.</strong>
                <p className="note">
                  아래 답변은 참고만 해 주시고, 정확한 내용은 도움말 원문을 확인해 주세요.
                  {review && ` (최고 유사도 ${turn.topScore.toFixed(3)} — 기준 0.55 미만)`}
                </p>
              </div>
            </div>
          )}

          {/* 근거에 부정문이 있으면 알린다. 프롬프트로는 고쳐지지 않아 알리기만 한다 */}
          {turn.mode === "상담" && turn.hits.some((h) => hasNegation(h.chunk.text)) && (
            <div className="banner warn negation">
              <div>
                <strong>이 답변의 근거에 「~하지 않습니다」 같은 문장이 있습니다. 특히 조심해서 읽어 주세요.</strong>
                <p className="note">
                  이런 문장은 다시 쓰는 과정에서 뜻이 뒤집히기 쉽습니다 — 「하지 않는다」가 「한다」가 됩니다.
                  실제로 재 봤더니 <strong>12번 중 3번</strong> 일어났고, 원문을 그대로 옮겨 적게 시켜도 줄지 않았습니다.
                  <strong> 아래 문장을 도움말에서 직접 확인해 주세요.</strong>
                </p>
                <ul className="neg-list">
                  {turn.hits.flatMap((h) =>
                    findNegations(h.chunk.text).map((n, i) => (
                      <li key={`${h.chunk.id}-${i}`}>
                        <button className="chip-open" onClick={() => setOpenHit(h)}>{h.chunk.doc}</button>{" "}
                        <span>{n.sentence}</span>
                      </li>
                    )),
                  )}
                </ul>
              </div>
            </div>
          )}

          {!turn.gate && <AnswerBody text={turn.answer || (busy ? "…" : "")} />}
          {turn.error && turn.mode !== "도움말만" && <p className="note err wrap">{turn.error}</p>}

          {/*
            「참고한 도움말」은 모델이 쓰지 않고 프로그램이 붙인다.
            모델이 쓰면 지어낼 수 있고, 지어낸 출처는 없는 출처보다 나쁘다.
          */}
          {turn.mode === "상담" && turn.citation && (
            cited.length > 0 ? (
              <div className="sources">
                <h3>참고한 도움말</h3>
                <ul className="source-cards">
                  {cited.map(({ n, hit }) => (
                    <li key={hit.chunk.id}>
                      <span className="num">[{n}]</span>
                      <button className="chip-open" onClick={() => setOpenHit(hit)}>
                        {hit.chunk.doc} · {hit.chunk.section}
                      </button>
                      <a href={hit.chunk.url} target="_blank" rel="noreferrer">원문 열기</a>
                      {review && <span className="method">{hit.method} {hit.score.toFixed(3)}</span>}
                    </li>
                  ))}
                </ul>
                {turn.citation.outOfRange.length > 0 && (
                  <p className="note err">
                    ⚠️ 답변이 <strong>없는 번호 [{turn.citation.outOfRange.join("], [")}]</strong>를 가리켰습니다.
                    지어낸 인용입니다 — 그 부분은 믿지 마세요.
                  </p>
                )}
                {turn.citation.leakedIds.length > 0 && (
                  <p className="note err">
                    ⚠️ 답변에 내부 문서 번호({turn.citation.leakedIds.join(", ")})가 새어 나왔습니다.
                  </p>
                )}
              </div>
            ) : (
              <div className="sources none">
                <h3>참고한 도움말</h3>
                <p className="note err">
                  <strong>이 답변은 도움말을 가리키지 않았습니다.</strong> 아래는 이 질문으로 검색된 도움말이지,
                  답변이 근거로 밝힌 것이 아닙니다. <strong>매끄럽게 읽히는 것과 근거가 있는 것은 다릅니다.</strong>
                </p>
              </div>
            )
          )}

          {/* 검색된 도움말 — 답변이 가리킨 것과 구분해서 놓는다 */}
          {turn.hits.length > 0 && (
            <div className="found">
              <h3>{turn.mode === "도움말만" ? "관련 도움말" : "검색된 도움말"} {turn.hits.length}개
                {!review && turn.hits.length > shownHits.length && <span className="note"> (가까운 {shownHits.length}개만)</span>}
              </h3>
              <ul className="source-cards plain">
                {shownHits.map((h) => (
                  <li key={h.chunk.id} className={hasNegation(h.chunk.text) ? "has-neg" : undefined}>
                    <button className="chip-open" onClick={() => setOpenHit(h)}>
                      {h.chunk.doc} · {h.chunk.section}
                    </button>
                    <a href={h.chunk.url} target="_blank" rel="noreferrer">원문 열기</a>
                    {review && <span className="method">{h.chunk.id} · {h.method} · {h.score.toFixed(3)}</span>}
                  </li>
                ))}
              </ul>
              {review && (
                <p className="note">
                  <code>vector</code> 는 뜻이 가까운 정도, <code>bm25</code> 는 낱말이 겹치는 정도입니다.
                  <strong> 서로 다른 자로 잰 값이라 숫자를 나란히 비교하면 안 됩니다.</strong>
                </p>
              )}
            </div>
          )}

          {/* 판정 — 고객 모드는 한 줄, 검토 모드는 배지 */}
          {turn.mode === "상담" && turn.verdict && (
            turn.verdict.ok ? (
              <div className="verdict">
                {!review ? (
                  <p className={turn.verdict.verdict.grounded && turn.verdict.verdict.noHalluc && turn.citation?.cited ? "check ok" : "check warn"}>
                    {turn.verdict.verdict.grounded && turn.verdict.verdict.noHalluc && turn.citation?.cited
                      ? "이 답변은 도움말에서 나왔고, 근거를 밝혔습니다."
                      : "이 답변은 한 번 더 확인이 필요합니다. 위 도움말 원문과 견줘 보세요."}
                  </p>
                ) : (
                  <>
                    <ul className="badges">
                      <Badge on={turn.verdict.verdict.grounded} label="근거에서 나옴" off="근거 밖 진술" />
                      <Badge on={turn.verdict.verdict.noHalluc} label="지어낸 사실 없음" off="지어냈을 수 있음" />
                      <Badge on={turn.verdict.verdict.refusal} label="정당한 거절" off="거절 아님" neutral />
                      <li className="score">{turn.verdict.verdict.score}점</li>
                      <li className={turn.citation?.cited ? "yes prog" : "no prog"}>
                        {turn.citation?.cited ? `인용 [${turn.citation.numbers.join("][")}]` : "인용 없음"} · 프로그램
                      </li>
                      <li className={turn.citation?.procedural ? "yes prog" : "neutral prog"}>
                        {turn.citation?.procedural ? `절차형 ${turn.citation.stepCount}단계` : "절차형 아님"} · 프로그램
                      </li>
                    </ul>
                    {turn.verdict.verdict.comment && <p className="note">{turn.verdict.verdict.comment}</p>}
                    {turn.verdict.verdict.rawScore !== undefined && (
                      <p className="note">
                        모델이 5점 만점으로 답해 환산했습니다: {turn.verdict.verdict.rawScore} → {turn.verdict.verdict.score}
                      </p>
                    )}
                    <p className="note">
                      「인용」과 「절차형」은 <strong>프로그램이 셉니다.</strong> 판정 모델에게 묻지 않습니다 —
                      dev-bot 에서 그것을 모델에게 물었다가 실패 108건 중 42건이 그 판정의 실패였습니다.
                      나머지 배지는 답을 만든 것과 <strong>같은 {MODEL}</strong>이 판정한 것이라 독립 심사가 아닙니다.
                    </p>
                  </>
                )}
                <div className="feedback">
                  <span className="note">이 답변이 도움이 되셨나요?</span>
                  <button className={turn.feedback === "up" ? "picked" : "ghost"}
                          onClick={() => { setTurn((t) => t && { ...t, feedback: "up" }); recordFeedback(turn, "up"); }}>
                    도움됐어요
                  </button>
                  <button className={turn.feedback === "down" ? "picked" : "ghost"}
                          onClick={() => { setTurn((t) => t && { ...t, feedback: "down" }); recordFeedback(turn, "down"); }}>
                    아니에요
                  </button>
                  {turn.feedback && review && judgeLikesAnswer(turn.verdict) !== null && (
                    <span className="note verdict-match">
                      {(turn.feedback === "up") !== judgeLikesAnswer(turn.verdict)
                        ? "⚠️ 자동 판정과 방향이 다릅니다 — 판정이 놓친 것이 있거나, 근거를 다시 볼 자리입니다."
                        : "자동 판정과 같은 방향입니다."}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              review && (
                <div className="verdict">
                  <ul className="badges"><li className="err-badge">judgeError</li></ul>
                  <p className="note">판정을 받지 못했습니다 — {turn.verdict.reason}. 위 답변과 도움말은 그대로입니다.</p>
                </div>
              )
            )
          )}
        </section>
      )}

      {/* 도움말 원문 — 화면을 떠나지 않고 읽는다 */}
      {openHit && (
        <div className="backdrop" onClick={() => setOpenHit(null)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true"
               aria-label={`${openHit.chunk.doc} ${openHit.chunk.section}`}
               onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <strong>{openHit.chunk.doc}</strong>
                <span className="sec"> · {openHit.chunk.section}</span>
              </div>
              <button className="ghost" onClick={() => setOpenHit(null)}>닫기</button>
            </div>
            {review && (
              <p className="note">
                {openHit.chunk.id} · 검색 방법 <code>{openHit.method}</code> · 점수 {openHit.score.toFixed(3)}
                {openHit.method === "bm25" && " — 낱말이 겹치는 정도입니다. 1.00은 «관련 있다»가 아니라 «이 검색 안에서 1등»이라는 뜻입니다."}
              </p>
            )}
            <pre className="chunk-text">{openHit.chunk.text}</pre>
            {findNegations(openHit.chunk.text).length > 0 && (
              <div className="neg-in-modal">
                <strong>이 도움말의 부정문</strong>
                <p className="note">답변이 이 문장의 뜻을 뒤집지 않았는지 위 답변과 견줘 보세요.</p>
                <ul className="neg-list">
                  {findNegations(openHit.chunk.text).map((n, i) => (
                    <li key={i}><em>{n.marks.join(", ")}</em> — {n.sentence}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="note">
              이 글이 도움말에 그대로 있는지 확인하시려면{" "}
              <a href={openHit.chunk.url} target="_blank" rel="noreferrer">도움말 원문</a>을 여세요.
            </p>
          </div>
        </div>
      )}

      <footer>
        <p className="note">
          도움말: <a href="https://github.com/hey-byeunya/already-got-it/tree/main/docs/help" target="_blank" rel="noreferrer">already-got-it/docs/help</a> ·
          만든 방법: <a href="https://github.com/hey-byeunya/already-got-it-guide-bot" target="_blank" rel="noreferrer">이 저장소</a>
        </p>
      </footer>
    </main>
  );
}
