import { useCallback, useEffect, useRef, useState } from "react";
import { buildBm25Index, cosine, hybridSearch, type Bm25Index, type Chunk, type Hit } from "./lib/search.ts";
import { embed, type Progress } from "./lib/embed.ts";
import { buildPrompt } from "./lib/prompt.ts";
import { checkConnection, MODEL, streamChat, type Connection } from "./lib/ollama.ts";
import { judge, type JudgeOutcome } from "./lib/judge.ts";
import { USAGE_STEPS } from "./lib/usage-steps.ts";

/**
 * 사용 조건 문장의 `백틱`을 코드로 보인다.
 * 문자열 자체는 README 와 글자 그대로 같게 두고(대조 스크립트가 그 문자열을 본다),
 * 화면에서만 README 의 마크다운과 같은 모습이 되게 한다.
 */
function renderTicks(s: string) {
  return s.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`")
      ? <code key={i}>{part.slice(1, -1)}</code>
      : <span key={i}>{part}</span>,
  );
}

/**
 * 사람의 좋아요·싫어요.
 *
 * 자동 판정과 **같은 방향이면** 기준과 사용 경험이 맞물린 사례로 읽고,
 * **어긋나면** 판정이 놓친 유용성이거나 사용자가 놓친 근거다. 어느 쪽이든
 * 다시 읽어야 할 자리라서, 어긋났을 때 그 사실을 화면에 드러낸다.
 *
 * G 에서 판정의 cited 일치율이 0.74 로 나왔다. 자동 판정만으로는 답을 읽을 수 없다.
 */
function Feedback({ turn, onPick }: { turn: Turn; onPick: (f: "up" | "down") => void }) {
  const v = turn.verdict?.ok ? turn.verdict.verdict : null;
  // 판정이 좋게 본 답(근거에 닿고 지어내지 않음)인지
  const judgeLikes = v ? v.grounded && v.noHalluc : null;
  const disagree =
    turn.feedback && judgeLikes !== null && (turn.feedback === "up") !== judgeLikes;

  return (
    <div className="feedback">
      <span className="note">이 답이 도움이 됐나요?</span>
      <button className={turn.feedback === "up" ? "picked" : "ghost"} onClick={() => onPick("up")}>도움됨</button>
      <button className={turn.feedback === "down" ? "picked" : "ghost"} onClick={() => onPick("down")}>아니요</button>
      {turn.feedback && (
        <span className="note">
          {disagree
            ? "⚠️ 자동 판정과 방향이 다릅니다 — 판정이 놓친 것이 있거나, 근거를 다시 볼 자리입니다."
            : "자동 판정과 같은 방향입니다."}
        </span>
      )}
    </div>
  );
}

/** 판정 배지 하나. neutral 은 참/거짓이 곧 좋고 나쁨이 아닌 항목(refusal)에 쓴다. */
function Badge({ on, label, off, neutral }: { on: boolean; label: string; off: string; neutral?: boolean }) {
  const tone = neutral ? "neutral" : on ? "yes" : "no";
  return <li className={tone}>{on ? label : off}</li>;
}

type Turn = {
  question: string;
  answer: string;
  hits: Hit[];
  weakEvidence: boolean;
  topScore: number;
  error?: string;
  verdict?: JudgeOutcome;
  /** 사람의 판단. 자동 판정과 어긋나는지 보려고 따로 둔다 */
  feedback?: "up" | "down";
};

export default function App() {
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [index, setIndex] = useState<Bm25Index | null>(null);
  const [conn, setConn] = useState<Connection>({ state: "확인 중" });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [turn, setTurn] = useState<Turn | null>(null);
  const [parity, setParity] = useState<number | null>(null);
  /** 근거 모달에 띄울 조각. 화면을 떠나지 않고 원문을 읽게 한다 */
  const [openHit, setOpenHit] = useState<Hit | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("./already-got-it-docs.json")
      .then((r) => r.json())
      .then((cs: Chunk[]) => {
        setChunks(cs);
        setIndex(buildBm25Index(cs));
      });
  }, []);

  const recheck = useCallback(() => {
    setConn({ state: "확인 중" });
    checkConnection().then(setConn);
  }, []);
  useEffect(recheck, [recheck]);

  /** 브라우저 임베딩이 Node 가 만든 문서 벡터와 같은 공간에 있는지 확인한다. */
  const runParityCheck = useCallback(async () => {
    const anchor = await (await fetch("./parity-anchor.json")).json();
    const mine = await embed(anchor.text, setProgress);
    setParity(cosine(mine, anchor.vector));
  }, []);

  async function ask() {
    const q = question.trim();
    if (!q || !chunks || !index) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;

    setTurn({ question: q, answer: "", hits: [], weakEvidence: false, topScore: 0 });
    try {
      setStage("질문을 벡터로 바꾸는 중");
      const qv = await embed(q, setProgress);

      setStage("근거를 찾는 중");
      const res = hybridSearch(chunks, index, qv, q);
      setTurn((t) => t && { ...t, hits: res.hits, weakEvidence: res.weakEvidence, topScore: res.topScore });

      setStage("답을 만드는 중");
      const prompt = buildPrompt(res.hits, q, res.weakEvidence);
      let answer = "";
      for await (const piece of streamChat(prompt, ctrl.signal)) {
        answer += piece;
        setTurn((t) => t && { ...t, answer });
      }

      // 답이 다 나온 뒤에 판정한다. 판정이 실패해도 위 답변과 출처는 그대로 남는다.
      setStage("답을 판정하는 중");
      const verdict = await judge(q, res.hits, answer, ctrl.signal);
      setTurn((t) => t && { ...t, verdict });
      setStage(null);
    } catch (e) {
      // 스트리밍이 끊겨도 이미 받은 답과 출처는 지우지 않는다.
      const aborted = e instanceof DOMException && e.name === "AbortError";
      setTurn((t) => t && { ...t, error: aborted ? "생성을 중지했습니다." : String(e) });
      setStage(null);
    }
  }

  const busy = stage !== null;

  return (
    <main>
      <header>
        <h1>이미 있어 이용 안내 챗봇</h1>
        <p className="lede">
          <a href="https://already-got-it.vercel.app" target="_blank" rel="noreferrer">이미 있어</a>의
          공개 문서에 근거해 이용 방법을 안내합니다. 답할 때마다 <strong>어느 문서의 어느 대목을 근거로 삼았는지</strong> 함께 보여 줍니다.
        </p>
        <p className="lede">
          서버가 답을 만들지 않습니다. 이 페이지를 연 <strong>당신 컴퓨터의 Ollama</strong>가 직접 답을 만듭니다.
          그래서 아래 사용 조건이 필요합니다.
        </p>
      </header>

      {/* 소개 — README 와 같은 문장을 쓴다. 두 곳이 어긋나면 어느 쪽을 따를지 알 수 없다 */}
      <section className="intro">
        <h2>쓰기 전에 확인할 것</h2>
        <ol>{USAGE_STEPS.map((s, i) => <li key={i}>{renderTicks(s)}</li>)}</ol>
        <pre><code>launchctl setenv OLLAMA_ORIGINS "https://hey-byeunya.github.io"{"\n"}# 설정 뒤 Ollama를 재시작합니다</code></pre>
        <p className="note">Chrome과 Edge를 권장합니다. Safari에서는 Ollama 연결과 임베딩이 불안정할 수 있습니다.</p>

        <h2>물을 수 있는 것과 없는 것</h2>
        <div className="two">
          <div><h3>물을 수 있다</h3><ul>
            <li>위시를 있템으로 옮기는 방법</li>
            <li>카테고리·수량·상태 입력 규칙</li>
            <li>쓴템 탭의 뜻과 되돌리는 방법</li>
            <li>D-day 배지 네 단계의 의미</li>
          </ul></div>
          <div><h3>물을 수 없다</h3><ul>
            <li>내 있템이 몇 개인지</li>
            <li>내 계정·비밀번호 관련 조작</li>
            <li>이 앱에 없는 기능</li>
            <li>오늘 날씨 같은 앱 밖 이야기</li>
          </ul></div>
        </div>
        <p className="note">
          자료에 없는 질문에는 <strong>답을 지어내지 않고 자료 범위 밖이라고 알립니다.</strong> 이건 거절을 줄이려는 게 아니라,
          어디까지 믿어도 되는지 알려 드리기 위한 약속입니다.
        </p>
      </section>

      {/* 연결 상태 — "오류" 가 아니라 "당신 컴퓨터에서 Ollama 를 켜야 합니다" 로 읽히게 */}
      {conn.state === "연결 안 됨" && (
        <div className="banner warn" role="status">
          <div>
            <strong>당신 컴퓨터에서 Ollama를 켜야 합니다.</strong>
            <p>{conn.reason}</p>
            <p className="note">이 페이지가 고장 난 것이 아닙니다. 위 「쓰기 전에 확인할 것」 2번과 4번을 따라 주세요.</p>
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
      {conn.state === "연결됨" && conn.hasModel && (
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
          <button onClick={ask} disabled={busy || !chunks}>묻기</button>
          <button onClick={() => abort.current?.abort()} disabled={!busy}>생성 중지</button>
          <button className="ghost" onClick={runParityCheck} disabled={busy}>임베딩 대조</button>
          {stage && <span className="stage">{stage}…</span>}
        </div>

        {/* 첫 방문에는 195MB 를 받는다. 몇 %인지 안 보이면 멈춘 것처럼 보인다 */}
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
        {parity !== null && (
          <p className={parity > 0.999 ? "parity ok" : "parity bad"}>
            브라우저와 문서 벡터의 코사인: <strong>{parity.toFixed(6)}</strong>{" "}
            {parity > 0.999 ? "— 같은 공간입니다" : "— 어긋납니다. 이 화면의 점수는 뜻을 잃습니다"}
          </p>
        )}
      </section>

      {turn && (
        <section className="answer">
          <h2>{turn.question}</h2>
          {turn.weakEvidence && (
            <div className="banner warn">
              <div>
                <strong>근거가 약합니다.</strong>
                <p className="note">가장 가까운 조각의 유사도가 {turn.topScore.toFixed(3)} 로 0.55 미만입니다. 아래 답을 평소만큼 믿지 마세요.</p>
              </div>
            </div>
          )}
          <div className="text">{turn.answer || (busy ? "…" : "")}</div>
          {turn.error && <p className="note err">{turn.error}</p>}

          {turn.verdict && (
            turn.verdict.ok ? (
              <div className="verdict">
                <ul className="badges">
                  <Badge on={turn.verdict.verdict.grounded} label="근거에서 나옴" off="근거 밖 진술" />
                  <Badge on={turn.verdict.verdict.noHalluc} label="지어낸 사실 없음" off="지어냈을 수 있음" />
                  <Badge on={turn.verdict.verdict.cited} label="[ID] 인용 있음" off="인용 없음" />
                  <Badge on={turn.verdict.verdict.refusal} label="정당한 거부" off="거부 아님" neutral />
                  <li className="score">{turn.verdict.verdict.score}점</li>
                </ul>
                {turn.verdict.verdict.comment && <p className="note">{turn.verdict.verdict.comment}</p>}
                {turn.verdict.verdict.rawScore !== undefined && (
                  <p className="note">
                    모델이 5점 만점으로 답해 환산했습니다: {turn.verdict.verdict.rawScore} → {turn.verdict.verdict.score}
                  </p>
                )}
                <p className="note">
                  판정은 답을 만든 것과 <strong>같은 {MODEL}</strong>이 합니다. 독립 심사가 아니라,
                  답을 한 번 더 읽게 하는 장치입니다.
                </p>
                <Feedback turn={turn} onPick={(f) => setTurn((t) => t && { ...t, feedback: f })} />
              </div>
            ) : (
              <div className="verdict">
                <ul className="badges"><li className="err-badge">judgeError</li></ul>
                <p className="note">판정을 받지 못했습니다 — {turn.verdict.reason}. 위 답변과 출처는 그대로입니다.</p>
              </div>
            )
          )}

          {turn.hits.length > 0 && (
            <>
              <h3>근거 {turn.hits.length}개</h3>
              <p className="note">
                <code>vector</code> 는 뜻이 가까운 정도, <code>bm25</code> 는 낱말이 겹치는 정도입니다.
                <strong> 서로 다른 자로 잰 값이라 숫자를 나란히 비교하면 안 됩니다.</strong>
              </p>
              <p className="note">칩을 누르면 그 조각의 원문을 이 화면에서 바로 볼 수 있습니다.</p>
              <ul className="chips">
                {turn.hits.map((h) => (
                  <li key={h.chunk.id} className={h.method}>
                    <button className="chip-open" onClick={() => setOpenHit(h)} title="근거 원문 보기">
                      {h.chunk.id}
                    </button>
                    <span className="sec">{h.chunk.section}</span>
                    <span className="method">{h.method}</span>
                    <span className="score">{h.score.toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {/* 근거 모달 — 화면을 떠나지 않고 조각 원문을 읽는다 */}
      {openHit && (
        <div className="backdrop" onClick={() => setOpenHit(null)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={`근거 ${openHit.chunk.id}`}
               onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <strong>{openHit.chunk.id}</strong>
                <span className="sec"> · {openHit.chunk.section}</span>
              </div>
              <button className="ghost" onClick={() => setOpenHit(null)}>닫기</button>
            </div>
            <p className="note">
              검색 방법 <code>{openHit.method}</code> · 점수 {openHit.score.toFixed(3)}
              {openHit.method === "bm25" && " — 낱말이 겹치는 정도입니다. 1.00은 «관련 있다»가 아니라 «이 검색 안에서 1등»이라는 뜻입니다."}
            </p>
            <pre className="chunk-text">{openHit.chunk.text}</pre>
            <p className="note">
              이 글이 원문에 그대로 있는지 확인하려면{" "}
              <a href={openHit.chunk.url} target="_blank" rel="noreferrer">원문 문서</a>를 여세요.
            </p>
          </div>
        </div>
      )}

      <footer>
        <p className="note">
          자료: <a href="https://github.com/hey-byeunya/already-got-it" target="_blank" rel="noreferrer">already-got-it</a> 의 공개 문서 ·
          설계: <a href="https://github.com/hey-byeunya/already-got-it-guide-bot" target="_blank" rel="noreferrer">이 저장소</a>
        </p>
      </footer>
    </main>
  );
}
