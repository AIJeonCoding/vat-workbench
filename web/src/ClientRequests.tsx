import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { useMemo, useState } from 'react';
import { gql, type Txn } from './api';
import { current, KIND_LABEL, num } from './format';

/**
 * 고객에게 물어볼 것 모음. 세무사가 실제로 제일 시간을 쓰는 "자료 요청 → 답 받기"를 한 화면에서.
 * - 증빙 요청: 계좌이체만 있고 세금계산서·카드전표가 없는 출금
 * - 사용 목적 확인: 접대인지 직원 복리후생인지, 어느 차량인지 등 사람이 판단해야 하는 건
 * 메시지는 카카오톡·문자에 그대로 붙여 넣을 수 있는 문장으로 만든다.
 */
type ReqStatus = 'todo' | 'sent' | 'answered';

export interface RequestItem {
  txn: Txn;
  type: 'evidence' | 'purpose';
  question: string;
}

export function requestItems(txns: Txn[]): RequestItem[] {
  const out: RequestItem[] = [];
  for (const t of txns) {
    if (t.status === 'MATCHED') continue;
    const j = current(t).j;
    if (t.kind === 'BANK_OUT') {
      if (j?.reasonCode === 'NO_EVIDENCE') out.push({ txn: t, type: 'evidence', question: '사업 관련이면 세금계산서(또는 카드전표)를 보내 주세요. 개인 지출이면 "개인"이라고 답해 주세요.' });
      else if (j?.reasonCode === 'NOT_BUSINESS' && t.status !== 'CONFIRMED') out.push({ txn: t, type: 'purpose', question: '사업과 관련된 지출인지 알려 주세요.' });
      continue;
    }
    if (t.status !== 'NEEDS_REVIEW') continue;
    const r = j?.reasonCode;
    const q =
      r === 'VEHICLE_PASSENGER' || r === 'VEHICLE_OK'
        ? '어느 차량에 쓴 비용인지 알려 주세요(경차·화물차면 공제, 승용차면 불공제).'
        : r === 'ENTERTAINMENT'
          ? '거래처 접대인지, 직원 식사·회식인지 알려 주세요.'
          : '어떤 용도로 쓴 비용인지 알려 주세요.';
    out.push({ txn: t, type: 'purpose', question: q });
  }
  return out.sort((a, b) => a.txn.date.localeCompare(b.txn.date));
}

export function ClientRequests({ filingId, clientName, period, txns, onOpen, onChanged }: { filingId: number; clientName: string; period: string; txns: Txn[]; onOpen: (id: number) => void; onChanged: () => void }) {
  const items = useMemo(() => requestItems(txns), [txns]);
  const [filter, setFilter] = useState<'all' | 'evidence' | 'purpose'>('all');
  const [copied, setCopied] = useState(false);

  // 진행 상태는 서버에 저장(다른 담당자 화면에도 실시간 반영)
  const status: Record<number, ReqStatus> = Object.fromEntries(items.map((i) => [i.txn.id, i.txn.clientRequest?.status ?? 'todo']));
  const [err, setErr] = useState<string | null>(null);
  const update = async (ids: number[], s: ReqStatus) => {
    try {
      setErr(null);
      await gql(`mutation($f:Int!,$ids:[Int!]!,$s:String!){ setRequestStatus(filingId:$f, txnIds:$ids, status:$s){ applied } }`, { f: filingId, ids, s });
    } catch (e) {
      setErr((e as Error).message);
    }
    onChanged();
  };

  const shown = items.filter((i) => filter === 'all' || i.type === filter);
  const unsent = shown.filter((i) => (status[i.txn.id] ?? 'todo') === 'todo');
  const message = useMemo(() => {
    const target = unsent.length ? unsent : shown;
    const lines = target.map((i, n) => `${n + 1}. ${i.txn.date.slice(5).replace('-', '/')} ${i.txn.counterparty} ${num(i.txn.supplyAmount + (i.txn.kind === 'BANK_OUT' ? 0 : i.txn.vat))}원\n   → ${i.question}`);
    return `안녕하세요, ${clientName} 사장님.\n${period.replace('-', '년 제')}기 부가세 신고 준비 중인데 아래 ${target.length}건 확인 부탁드립니다.\n\n${lines.join('\n')}\n\n사진으로 보내 주셔도 됩니다. 감사합니다.`;
  }, [unsent, shown, clientName, period]);

  const counts = {
    todo: items.filter((i) => (status[i.txn.id] ?? 'todo') === 'todo').length,
    sent: items.filter((i) => status[i.txn.id] === 'sent').length,
    answered: items.filter((i) => status[i.txn.id] === 'answered').length,
  };

  return (
    <div className="wb-return">
      <div>
        <div className="wb-return-head">
          <b>고객에게 확인할 것 {items.length}건</b>
          <span className="wb-sub">
            {' '}
            · 요청 전 {counts.todo} · 요청함 {counts.sent} · 답 받음 {counts.answered}
          </span>
        </div>
        <SegmentedControl label="종류" size="sm" value={filter} onChange={(v) => setFilter(v as typeof filter)}>
          <SegmentedControlItem value="all" label={`전체 ${items.length}`} />
          <SegmentedControlItem value="evidence" label={`증빙 요청 ${items.filter((i) => i.type === 'evidence').length}`} />
          <SegmentedControlItem value="purpose" label={`용도 확인 ${items.filter((i) => i.type === 'purpose').length}`} />
        </SegmentedControl>
        <table className="wb-form" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>일자</th>
              <th>거래처 · 구분</th>
              <th className="wb-num">금액</th>
              <th>물어볼 것</th>
              <th style={{ width: 150 }}>진행</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="wb-sub">
                  고객에게 물어볼 것이 없습니다.
                </td>
              </tr>
            )}
            {shown.map((i) => {
              const s = status[i.txn.id] ?? 'todo';
              return (
                <tr key={i.txn.id}>
                  <td>{i.txn.date.slice(5)}</td>
                  <td>
                    <button className="wb-link" onClick={() => onOpen(i.txn.id)}>
                      {i.txn.counterparty}
                    </button>
                    <div className="wb-sub">
                      {KIND_LABEL[i.txn.kind]} · {i.type === 'evidence' ? '증빙 요청' : '용도 확인'}
                      {i.txn.clientRequest && i.txn.clientRequest.status !== 'todo' ? ` · ${i.txn.clientRequest.by} ${i.txn.clientRequest.at.slice(5, 10)}` : ''}
                    </div>
                  </td>
                  <td className="wb-num">{num(i.txn.supplyAmount + (i.txn.kind === 'BANK_OUT' ? 0 : i.txn.vat))}</td>
                  <td>{i.question}</td>
                  <td>
                    <select className="wb-select" value={s} onChange={(e) => void update([i.txn.id], e.target.value as ReqStatus)} aria-label="진행 상태">
                      <option value="todo">요청 전</option>
                      <option value="sent">요청함</option>
                      <option value="answered">답 받음</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="wb-return-side">
        {err && <div className="wb-nonded">{err}</div>}
        <div className="wb-block-title">보낼 메시지 ({unsent.length ? `요청 전 ${unsent.length}건` : `전체 ${shown.length}건`})</div>
        <textarea className="wb-message" readOnly value={message} rows={16} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            size="sm"
            label={copied ? '복사됨' : '메시지 복사'}
            clickAction={async () => {
              try {
                await navigator.clipboard.writeText(message);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                /* 권한 없음 */
              }
            }}
          />
          <Button
            size="sm"
            label="보낸 것으로 표시"
            isDisabled={!unsent.length}
            clickAction={async () => {
              await update(unsent.map((i) => i.txn.id), 'sent');
            }}
          />
        </div>
        <div className="wb-sub" style={{ marginTop: 8 }}>
          답을 받으면 거래를 눌러 판정·메모를 남기세요. 증빙 요청 목록은 Excel 내보내기의 "증빙요청" 시트에도 있습니다.
        </div>
      </div>
    </div>
  );
}
