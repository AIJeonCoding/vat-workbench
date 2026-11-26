import { useEffect, useRef, useState } from 'react';
import { sentences, useVoiceIO } from './voiceio';

/**
 * 면접 연습 — AI 면접관이 질문을 읽고, 말로 답하면 받아써서 꼬리질문 · 피드백을 준다.
 * 붙여 넣은 공고 · 이력서는 서버에 저장하지 않는다(연결이 끊기면 사라짐).
 */
type Role = 'general' | 'backend' | 'ai_agent' | 'fde';
interface Metrics {
  seconds: number;
  chars: number;
  perMin: number;
  fillers: number;
  hasNumber: boolean;
  hints: string[];
}
type Line = { who: 'q'; text: string; kind: string; no?: number; total?: number } | { who: 'a'; text: string; m?: Metrics } | { who: 'sys'; text: string };
interface Brief {
  company: string;
  role: string;
  duties: string;
  requirements: string;
  preferred: string;
  values: string;
  sources: string[];
  ai: boolean;
}
interface Feedback {
  overall: string | null;
  turns: { q: string; kind: string; a: string; m: Metrics }[];
}

const ROLES: { v: Role; label: string }[] = [
  { v: 'general', label: '일반(공통)' },
  { v: 'backend', label: '백엔드 개발자' },
  { v: 'ai_agent', label: 'AI 에이전트 엔지니어' },
  { v: 'fde', label: 'FDE · 솔루션 엔지니어' },
];
const SILENCE_MS = 4000;

export function InterviewCoach() {
  const [role, setRole] = useState<Role>('backend');
  const [company, setCompany] = useState('');
  const [postingUrl, setPostingUrl] = useState('');
  const [brief, setBrief] = useState<Brief | null>(null);
  const [jd, setJd] = useState('');
  const [resume, setResume] = useState('');
  const [n, setN] = useState(4);
  const [useMic, setUseMic] = useState(true);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'asking' | 'answering' | 'thinking' | 'done'>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [heard, setHeard] = useState('');
  const [typed, setTyped] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [aiQs, setAiQs] = useState<boolean | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const buf = useRef<string[]>([]);
  const firstAt = useRef(0);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines, feedback]);

  const submit = (textOverride?: string) => {
    if (timer.current) clearTimeout(timer.current);
    const text = (textOverride ?? buf.current.join(' ')).trim();
    if (!text) return;
    const dur = textOverride ? 0 : Math.max(0, lastAt.current - firstAt.current);
    buf.current = [];
    firstAt.current = 0;
    setHeard('');
    setLines((x) => [...x, { who: 'a', text }]);
    setPhase('thinking');
    ws.current?.send(JSON.stringify({ t: 'answer', text, durationMs: dur || Math.round(text.replace(/\s/g, '').length / 5.5) * 1000 }));
  };

  const touch = () => {
    const now = Date.now();
    if (!firstAt.current) firstAt.current = now;
    lastAt.current = now;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => phaseRef.current === 'answering' && buf.current.length && submit(), SILENCE_MS);
  };

  const voice = useVoiceIO({
    onInterim: (t) => {
      if (phaseRef.current === 'asking') setPhase('answering');
      if (phaseRef.current === 'answering' || phaseRef.current === 'asking') {
        setHeard(t);
        touch();
      }
    },
    onFinal: (t) => {
      if (phaseRef.current !== 'answering' && phaseRef.current !== 'asking') return;
      setPhase('answering');
      buf.current.push(t);
      setHeard('');
      touch();
    },
  });

  const start = async () => {
    setLines([]);
    setFeedback(null);
    setAiQs(null);
    setBrief(null);
    const ok = useMic ? await voice.start() : false;
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/interview`);
    sock.onopen = () => sock.send(JSON.stringify({ t: 'start', role, company, jd, resume, n, postingUrl: postingUrl.trim() || undefined }));
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m.t === 'thinking') {
        setPhase(m.text.includes('피드백') ? 'thinking' : 'preparing');
        setLines((x) => [...x, { who: 'sys', text: m.text }]);
        void voice.speak([m.text]);
      }
      if (m.t === 'ready') setAiQs(m.ai);
      if (m.t === 'step') setLines((x) => [...x, { who: 'sys', text: `🔎 ${m.text}` }]);
      if (m.t === 'brief') setBrief(m.brief);
      if (m.t === 'q') {
        setLines((x) => [...x, { who: 'q', text: m.text, kind: m.kind, no: m.no, total: m.total }]);
        setPhase('asking');
        void voice.speak(sentences(m.text)).then(() => phaseRef.current === 'asking' && setPhase('answering'));
      }
      if (m.t === 'metrics')
        setLines((x) => {
          const y = [...x];
          for (let i = y.length - 1; i >= 0; i--) if (y[i].who === 'a') return (y[i] = { ...(y[i] as { who: 'a'; text: string }), m: m.m }), y;
          return y;
        });
      if (m.t === 'feedback') {
        setFeedback(m);
        setPhase('done');
        void voice.speak(['면접이 끝났어요. 피드백을 화면에 정리했어요.']);
      }
      if (m.t === 'error') setLines((x) => [...x, { who: 'sys', text: m.text }]);
    };
    sock.onclose = () => setRunning(false);
    ws.current = sock;
    setRunning(true);
    setPhase('preparing');
    if (!ok) setLines((x) => [...x, { who: 'sys', text: useMic ? '마이크를 쓸 수 없어 글로 진행해요. 아래 입력창에 답을 써 주세요.' : '글로만 답하는 모드예요. 질문은 소리로 읽어 드려요.' }]);
  };

  const stopAll = () => {
    voice.stop();
    ws.current?.close();
    setRunning(false);
    setPhase('idle');
  };

  const state = { idle: '', preparing: '질문 준비 중', asking: '질문 읽는 중 · 바로 답해도 돼요', answering: '듣는 중 · 4초 멈추면 답변 완료', thinking: '생각 중', done: '끝' }[phase];

  return (
    <div className="wb-iv">
      {!running && phase !== 'done' && (
        <div className="wb-iv-setup">
          <h2>면접 연습</h2>
          <p className="wb-sub">AI 면접관이 질문을 소리로 읽고, 말로 답하면 꼬리질문과 피드백을 줘요. 붙여 넣은 공고 · 이력서는 저장하지 않아요.</p>
          <label>
            직무
            <select className="wb-select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            회사 이름(선택)
            <input className="wb-input" value={company} maxLength={60} onChange={(e) => setCompany(e.target.value)} placeholder="예: ○○회사" />
          </label>
          <label>
            채용 공고 링크(선택 · AI가 공고와 인재상을 찾아 질문에 반영)
            <input className="wb-input" value={postingUrl} maxLength={500} onChange={(e) => setPostingUrl(e.target.value)} placeholder="예: https://toss.im/career/job-detail?job_id=..." />
          </label>
          <label>
            공고 내용(선택 · 링크가 안 읽히는 사이트면 붙여 넣기)
            <textarea className="wb-input" rows={5} maxLength={4000} value={jd} onChange={(e) => setJd(e.target.value)} placeholder="담당 업무 · 자격 요건 · 우대 사항" />
          </label>
          <label>
            내 이력서 요약(선택 · 붙여 넣으면 내 경험을 파고드는 질문)
            <textarea className="wb-input" rows={5} maxLength={4000} value={resume} onChange={(e) => setResume(e.target.value)} placeholder="프로젝트 · 맡은 일 · 결과 숫자" />
          </label>
          <label>
            질문 수
            <select className="wb-select" value={n} onChange={(e) => setN(Number(e.target.value))}>
              {[3, 4, 5, 6].map((k) => (
                <option key={k} value={k}>
                  {k}개(+꼬리질문)
                </option>
              ))}
            </select>
          </label>
          <label className="wb-iv-check">
            <input type="checkbox" checked={useMic} onChange={(e) => setUseMic(e.target.checked)} /> 말로 답하기(마이크 사용) — 끄면 질문만 소리로 듣고 글로 답해요
          </label>
          <button className="wb-btn" onClick={() => void start()}>
            🎙 면접 시작
          </button>
          <p className="wb-sub">이어폰을 쓰면 더 정확해요. 질문을 읽는 중에 말을 시작하면 읽기를 멈추고 들어요.</p>
        </div>
      )}

      {(running || phase === 'done') && (
        <div className="wb-iv-run">
          <div className="wb-iv-head">
            <b>면접 연습{company ? ` · ${company}` : ''}</b>
            {running && (
              <span className="wb-sub wb-voice-state">
                <span className={`wb-dot wb-dot-${phase === 'answering' ? 'listening' : phase === 'asking' ? 'speaking' : 'thinking'}`} /> {state}
                {aiQs !== null && <em> · {aiQs ? '공고 · 이력서 맞춤 질문' : '기본 질문'}</em>}
                {voice.engine !== '?' && <em> · 음성 {voice.engine === 'eleven' ? 'ElevenLabs' : '기기'}</em>}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {running && phase === 'answering' && (
              <button className="wb-btn" onClick={() => submit()}>
                답변 완료
              </button>
            )}
            {running && (
              <button className="wb-chip" onClick={() => ws.current?.send(JSON.stringify({ t: 'skip' }))}>
                건너뛰기
              </button>
            )}
            {running && (
              <button className="wb-chip" onClick={() => ws.current?.send(JSON.stringify({ t: 'end' }))}>
                여기서 끝내고 피드백
              </button>
            )}
            {running ? (
              <button className="wb-btn wb-btn-danger" onClick={stopAll}>
                ■ 종료
              </button>
            ) : (
              <button className="wb-btn" onClick={() => setPhase('idle')}>
                다시 하기
              </button>
            )}
          </div>

          <div className="wb-iv-body">
            {brief && (
              <details className="wb-iv-brief" open>
                <summary>
                  🔎 찾아온 공고 · 인재상{brief.company ? ` — ${brief.company}` : ''}
                  {brief.role ? ` · ${brief.role}` : ''} {brief.ai ? '' : '(AI 요약 없이 본문 일부)'}
                </summary>
                {brief.values && brief.values !== '없음' ? (
                  <div>
                    <b>인재상 · 핵심가치</b>
                    <div className="wb-msg-text">{brief.values}</div>
                  </div>
                ) : (
                  <div className="wb-sub">인재상 페이지를 찾지 못했어요(자바스크립트로만 그려지는 페이지일 수 있어요).</div>
                )}
                {brief.requirements && (
                  <div>
                    <b>자격 요건</b>
                    <div className="wb-msg-text">{brief.requirements}</div>
                  </div>
                )}
                <div className="wb-sub">
                  출처:{' '}
                  {brief.sources.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer">
                      {u.replace(/^https:\/\//, '').slice(0, 50)}{' '}
                    </a>
                  ))}
                </div>
              </details>
            )}
            {lines.map((l, i) =>
              l.who === 'q' ? (
                <div key={i} className="wb-msg wb-msg-ai">
                  <div className="wb-sub">{l.kind === 'follow' ? '꼬리질문' : `질문 ${l.no}/${l.total}`}</div>
                  <div className="wb-msg-text">{l.text}</div>
                </div>
              ) : l.who === 'a' ? (
                <div key={i} className="wb-msg wb-msg-user">
                  {l.text}
                  {l.m && (
                    <div className="wb-iv-m">
                      {l.m.seconds}초 · 분당 {l.m.perMin}자 · 말버릇 {l.m.fillers}번 · 숫자 {l.m.hasNumber ? '있음' : '없음'}
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className="wb-sub wb-iv-sys">
                  {l.text}
                </div>
              ),
            )}
            {heard && <div className="wb-msg wb-msg-user wb-iv-live">{[...buf.current, heard].join(' ')}</div>}

            {feedback && (
              <div className="wb-iv-fb">
                <h3>피드백</h3>
                {feedback.overall ? <div className="wb-msg-text">{feedback.overall}</div> : <div className="wb-sub">AI 서버가 꺼져 있어 숫자 지표와 규칙 피드백만 보여 드려요.</div>}
                {feedback.turns.map((t, i) => (
                  <div key={i} className="wb-iv-fbq">
                    <div className="wb-sub">{t.kind === 'follow' ? '꼬리질문' : '질문'} · {t.q}</div>
                    <div className="wb-iv-m">
                      {t.m.seconds}초 · 분당 {t.m.perMin}자 · 말버릇 {t.m.fillers}번 · 숫자 {t.m.hasNumber ? '있음' : '없음'}
                    </div>
                    <ul>
                      {t.m.hints.length ? t.m.hints.map((h, k) => <li key={k}>{h}</li>) : <li>길이 · 숫자 · 본인 역할이 잘 들어갔어요.</li>}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>

          {running && (
            <form
              className="wb-chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim()) submit(typed);
                setTyped('');
              }}
            >
              <textarea rows={2} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="말 대신 써서 답해도 돼요" />
              <button className="wb-btn" disabled={!typed.trim()}>
                보내기
              </button>
            </form>
          )}
          {voice.error && <div className="wb-warn">{voice.error}</div>}
        </div>
      )}
    </div>
  );
}
