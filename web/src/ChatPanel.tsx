import { useEffect, useRef, useState } from 'react';
import { gql, subscribeFiling, type Txn } from './api';
import { num } from './format';

/**
 * 업무 대화 패널(오른쪽). 자율 루프가 켜져 있으면 AI가 정의된 조회 도구만 골라 여러 단계로 조사한다.
 * 확정은 AI가 하지 않는다 — 답에 붙은 '확정 카드'를 사람이 눌러야 실행된다.
 */
interface Row {
  id: number;
  date: string;
  counterparty: string;
  amount: number;
  status: string;
  judgement: string;
}
interface Card {
  kind: 'confirm';
  title: string;
  decision?: string;
  reasonCode?: string;
  txns: { id: number; version: number; date: string; counterparty: string; amount: number; current: string }[];
}
interface Reply {
  reply: string;
  route: string;
  rows?: Row[];
  action?: Card;
  suggestions?: string[];
  steps?: { tool: string; summary: string }[];
}
type Msg = { role: 'user'; text: string } | { role: 'assistant'; r: Reply; ms: number; done?: string };

const STARTERS = ['뭘 할 수 있어?', '이번 기 요약해줘', '확인 필요한 건 왜 그런지 정리해줘', '접대비로 보이는 건 근거와 같이 보여줘', '남은 건 제안대로 확정 카드 만들어줘'];

export function ChatPanel({ filingId, txns, onOpen, onChanged }: { filingId: number; txns: Txn[]; onOpen: (id: number) => void; onChanged: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);
  const [live, setLive] = useState<string[]>([]);
  const [started, setStarted] = useState(0);
  const [, tick] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribeFiling(filingId, (e) => {
      if (e.type === 'agentStep' && e.txnId === 0 && e.summary) setLive((l) => [...l, e.summary!]);
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [filingId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, live]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const send = async (text: string) => {
    const m = text.trim();
    if (!m || busy) return;
    setMsgs((x) => [...x, { role: 'user', text: m }]);
    setInput('');
    setBusy(true);
    setLive([]);
    const t0 = Date.now();
    setStarted(t0);
    try {
      const res = await fetch(`/api/filings/${filingId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: m, mode: auto ? 'auto' : 'quick' }),
      });
      const r = (await res.json()) as Reply & { message?: string };
      setMsgs((x) => [...x, { role: 'assistant', r: res.ok ? r : { route: 'error', reply: r.message ?? '요청을 처리하지 못했어요.' }, ms: Date.now() - t0 }]);
    } catch {
      setMsgs((x) => [...x, { role: 'assistant', r: { route: 'error', reply: '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.' }, ms: Date.now() - t0 }]);
    } finally {
      setBusy(false);
    }
  };

  const runCard = async (i: number, card: Card) => {
    let ok = 0;
    const fails: string[] = [];
    for (const c of card.txns) {
      const fresh = txns.find((t) => t.id === c.id);
      try {
        await gql(`mutation($i:ConfirmInput!){ confirm(input:$i){ id } }`, {
          i: { txnId: c.id, expectedVersion: fresh?.version ?? c.version, ...(card.decision ? { decision: card.decision, reasonCode: card.reasonCode } : {}), note: '대화 확정 카드' },
        });
        ok++;
      } catch (e) {
        fails.push(`${c.counterparty}: ${(e as Error).message}`);
      }
    }
    setMsgs((x) => x.map((m, k) => (k === i && m.role === 'assistant' ? { ...m, done: `${ok}건 확정${fails.length ? ` · 실패 ${fails.length}건(${fails[0]})` : ''}` } : m)));
    onChanged();
  };

  return (
    <div className="wb-chat">
      <div className="wb-chat-head">
        <b>업무 대화</b>
        <label className="wb-sub wb-chat-toggle" title="AI가 조회 도구를 골라 여러 단계로 조사합니다">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 자율 루프
        </label>
      </div>
      <div className="wb-chat-body">
        {!msgs.length && (
          <div className="wb-chat-intro">
            <div>이 고객의 부가세 자료만 다루는 보조예요. 정해진 조회 도구만 쓰고, 확정은 카드를 눌러야 실행돼요. 업무와 관계없는 질문에는 답하지 않아요.</div>
            <div className="wb-chat-chips">
              {STARTERS.map((s) => (
                <button key={s} className="wb-chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="wb-msg wb-msg-user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="wb-msg wb-msg-ai">
              {!!m.r.steps?.length && (
                <details className="wb-steps">
                  <summary>
                    자율 루프 {m.r.steps.length}단계 · {(m.ms / 1000).toFixed(1)}초
                  </summary>
                  <ol>
                    {m.r.steps.map((s, k) => (
                      <li key={k}>{s.summary}</li>
                    ))}
                  </ol>
                </details>
              )}
              <div className="wb-msg-text">{m.r.reply}</div>
              {!!m.r.rows?.length && (
                <div className="wb-chat-rows">
                  {m.r.rows.slice(0, 12).map((r) => (
                    <button key={r.id} className="wb-chat-row" onClick={() => onOpen(r.id)}>
                      <span>{r.date.slice(5)} {r.counterparty}</span>
                      <span className="wb-num">{num(r.amount)}</span>
                      <span className="wb-sub">{r.judgement}</span>
                    </button>
                  ))}
                </div>
              )}
              {m.r.action && (
                <div className="wb-card-action">
                  <b>확정 카드 · {m.r.action.title}</b>
                  <ul>
                    {m.r.action.txns.slice(0, 8).map((t) => (
                      <li key={t.id}>
                        <button className="wb-link" onClick={() => onOpen(t.id)}>
                          {t.date.slice(5)} {t.counterparty}
                        </button>{' '}
                        {num(t.amount)}원 <span className="wb-sub">· 지금 {t.current}</span>
                      </li>
                    ))}
                    {m.r.action.txns.length > 8 && <li className="wb-sub">외 {m.r.action.txns.length - 8}건</li>}
                  </ul>
                  {m.done ? (
                    <div className="wb-sub">{m.done}</div>
                  ) : (
                    <button className="wb-btn" onClick={() => void runCard(i, m.r.action!)}>
                      {m.r.action.txns.length}건 확정
                    </button>
                  )}
                </div>
              )}
              {!!m.r.suggestions?.length && (
                <div className="wb-chat-chips">
                  {m.r.suggestions.map((s) => (
                    <button key={s} className="wb-chip" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="wb-msg wb-msg-ai wb-sub">
            {auto ? '자율 루프로 조사 중' : '답을 찾는 중'} · {Math.round((Date.now() - started) / 1000)}초
            {!!live.length && (
              <ol className="wb-live">
                {live.map((s, k) => (
                  <li key={k}>{s}</li>
                ))}
              </ol>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form
        className="wb-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          value={input}
          maxLength={300}
          rows={2}
          placeholder="예: 모퉁이 커피 건 왜 불공제야?"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button className="wb-btn" disabled={busy || !input.trim()}>
          보내기
        </button>
      </form>
    </div>
  );
}
