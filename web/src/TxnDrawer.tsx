import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Drawer, DrawerHeader } from '@astryxdesign/core/Drawer';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { gql, type Txn, type User } from './api';
import { current, isSales, KIND_LABEL, MATCH_LABEL, num, REASON_LABEL, STATUS, TOOL_LABEL, weekday } from './format';

const DEDUCT_REASONS = ['BUSINESS', 'VEHICLE_OK'];
const NON_DEDUCT_REASONS = ['ENTERTAINMENT', 'NOT_BUSINESS', 'VEHICLE_PASSENGER', 'EXEMPT_SUPPLIER', 'SIMPLIFIED_SUPPLIER', 'BEFORE_REGISTRATION', 'NO_VAT'];
/** 계좌 출금은 증빙이 아니라서 공제로 확정할 수 없다 */
const BANK_REASONS = ['NO_EVIDENCE', 'NOT_VAT', 'NOT_BUSINESS'];

/** 거래 상세: 근거(규칙·AI 단계·지난 판단)를 보고 승인하거나 고쳐서 확정한다. */
export function TxnDrawer({
  txn,
  user,
  liveStep,
  sourceName,
  onClose,
  onConfirm,
  onApplySame,
  onOpenTxn,
  onUnmatch,
}: {
  txn: Txn | null;
  user: User;
  liveStep?: string;
  sourceName?: string;
  onOpenTxn: (id: number) => void;
  onUnmatch: (t: Txn) => Promise<void>;
  onClose: () => void;
  onConfirm: (t: Txn, change?: { decision: string; reasonCode: string; note?: string }) => Promise<void>;
  onApplySame: (t: Txn) => Promise<void>;
}) {
  const c = txn ? current(txn) : null;
  const [decision, setDecision] = useState<'DEDUCT' | 'NON_DEDUCT'>('DEDUCT');
  const [reason, setReason] = useState('BUSINESS');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!txn) return;
    const j = current(txn).j;
    setDecision(j?.decision ?? 'NON_DEDUCT');
    setReason(j?.reasonCode ?? 'NOT_BUSINESS');
    setNote(txn.final?.note ?? '');
  }, [txn?.id, txn?.version]);

  const history = useQuery({
    enabled: !!txn,
    queryKey: ['history', txn?.id, txn?.version],
    queryFn: () => gql<{ txnHistory: { action: string; actor: string; at: string }[] }>(`query($t:Int!){ txnHistory(txnId:$t){ action actor at } }`, { t: txn!.id }).then((d) => d.txnHistory),
  });

  if (!txn || !c) return <Drawer isOpen={false} onOpenChange={onClose} label="거래 상세">{null}</Drawer>;
  const st = STATUS[txn.status];
  const changed = !!c.j && (decision !== c.j.decision || reason !== c.j.reasonCode);
  const isBank = txn.kind === 'BANK_OUT';
  const reasons = isBank ? BANK_REASONS : decision === 'DEDUCT' ? DEDUCT_REASONS : NON_DEDUCT_REASONS;
  const amountText = isBank
    ? `출금 ${num(txn.supplyAmount)}원`
    : `공급가액 ${num(txn.supplyAmount)}원 / 세액 ${num(txn.vat)}원${txn.vatEstimated ? '(추정)' : ''}`;

  return (
    <Drawer isOpen onOpenChange={(o) => !o && onClose()} label={`${txn.counterparty} 거래 상세`} width={520}>
      <VStack gap={4}>
        <DrawerHeader
          title={txn.counterparty}
          subtitle={`${txn.date}(${weekday(txn.date)}) · ${KIND_LABEL[txn.kind]} · ${amountText}`}
          onOpenChange={(o) => !o && onClose()}
          endContent={<span className={txn.status === 'NEEDS_REVIEW' ? 'wb-warn' : 'wb-sub'}>{st.label}</span>}
        />

        <MetadataList columns="multi">
          {isBank ? (
            <MetadataListItem label="적요">{txn.memo ?? '—'}</MetadataListItem>
          ) : (
            <>
              <MetadataListItem label="업종">{txn.industry ?? '—'}</MetadataListItem>
              <MetadataListItem label="가맹점 과세유형">
                {txn.counterpartyTaxType === 'SIMPLIFIED' ? '간이과세' : txn.counterpartyTaxType === 'EXEMPT' ? '면세' : txn.counterpartyTaxType === 'GENERAL' ? '일반과세' : '모름'}
              </MetadataListItem>
              <MetadataListItem label="사업자번호">{txn.counterpartyBrn ?? '—'}</MetadataListItem>
            </>
          )}
          {txn.kind === 'CARD_STATEMENT' && txn.memo && <MetadataListItem label="카드">{txn.memo}</MetadataListItem>}
          <MetadataListItem label="원본">{`${sourceName ?? '파일'}${txn.sourceRow ? ` ${txn.sourceRow}행` : ''}`}</MetadataListItem>
          <MetadataListItem label="현재 판단 출처">{c.source ?? '없음'}</MetadataListItem>
        </MetadataList>

        {txn.status === 'MATCHED' ? (
          <div className="wb-block">
            <div className="wb-block-title">다른 자료와 맞춤 · {MATCH_LABEL[txn.matchType ?? ''] ?? ''}</div>
            <Text>{txn.hint}</Text>
            <HStack gap={2} wrap="wrap" vAlign="center">
              {txn.linkedTxnId && <Button size="sm" label="맞춘 거래 보기" clickAction={async () => onOpenTxn(txn.linkedTxnId!)} />}
              <Button size="sm" label="같은 거래 아님 — 따로 검토" clickAction={async () => onUnmatch(txn)} />
            </HStack>
            <div className="wb-sub" style={{ marginTop: 6 }}>신고서 숫자에는 한 번만 들어갑니다.</div>
          </div>
        ) : (
          txn.hint && <Banner status="warning" title={txn.hint} collapsible={false} />
        )}
        {liveStep && <div className="wb-live">검토 중: {liveStep}</div>}

        {txn.rule && (
          <div className="wb-block">
            <div className="wb-block-title">규칙 판정</div>
            <Text>
              <span className={txn.rule.decision === 'DEDUCT' ? 'wb-ded' : 'wb-nonded'}>{txn.rule.decision === 'DEDUCT' ? '공제' : '불공제'}</span> — {txn.rule.explanation}
            </Text>
            <div className="wb-sub">근거: {txn.rule.lawRef}</div>
          </div>
        )}

        {txn.ai && (
          <div className="wb-block">
            <div className="wb-block-title">
              {txn.ai.model === 'memory' ? '지난 신고 때 판단' : 'AI 검토 의견'}
              {txn.ai.model !== 'memory' && ` · 확신도 ${Math.round(txn.ai.confidence * 100)}%`}
            </div>
            <Text>
              <span className={txn.ai.decision === 'DEDUCT' ? 'wb-ded' : 'wb-nonded'}>
                {txn.ai.decision === 'DEDUCT' ? '공제' : '불공제'}({REASON_LABEL[txn.ai.reasonCode]})
              </span>{' '}
              — {txn.ai.explanation}
            </Text>
            <div className="wb-sub">근거: {txn.ai.lawRef}</div>
            {txn.ai.steps.length > 0 && (
              <details open>
                <summary className="wb-sub" style={{ cursor: 'pointer', marginTop: 6 }}>
                  확인한 자료 {txn.ai.steps.length}개{txn.ai.ms ? ` · ${(txn.ai.ms / 1000).toFixed(1)}초` : ''}
                  {txn.ai.model !== 'memory' && ` · ${txn.ai.model.split('/').pop()}(로컬)`}
                </summary>
                <ol className="wb-steps-list">
                  {txn.ai.steps.map((s, i) => (
                    <li key={i}>
                      {TOOL_LABEL[s.tool] ?? s.tool}: {s.summary}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}

        {txn.final && (
          <div className="wb-block">
            <div className="wb-block-title">확정</div>
            <Text>
              {txn.final.decidedBy} — <span className={txn.final.decision === 'DEDUCT' ? 'wb-ded' : 'wb-nonded'}>{txn.final.decision === 'DEDUCT' ? '공제' : '불공제'}({REASON_LABEL[txn.final.reasonCode]})</span>
            </Text>
            {txn.final.note && <div className="wb-sub">메모: {txn.final.note}</div>}
          </div>
        )}

        {!isSales(txn) && txn.status !== 'MATCHED' && (
          <div className="wb-block">
            <VStack gap={3}>
              <Heading level={6}>{txn.status === 'CONFIRMED' ? '판정 바꾸기' : '확정하기'}</Heading>
              {isBank ? (
                <div className="wb-sub">계좌이체 기록만으로는 공제할 수 없습니다. 사업 관련이면 고객에게 세금계산서를 받아 그 파일을 올리세요.</div>
              ) : (
                <SegmentedControl
                label="공제 여부"
                layout="fill"
                value={decision}
                onChange={(v) => {
                  const d = v as 'DEDUCT' | 'NON_DEDUCT';
                  setDecision(d);
                  setReason(d === 'DEDUCT' ? 'BUSINESS' : 'NOT_BUSINESS');
                }}
              >
                <SegmentedControlItem value="DEDUCT" label="공제" />
                <SegmentedControlItem value="NON_DEDUCT" label="불공제" />
              </SegmentedControl>
              )}
              <Selector label="사유" value={reason} onChange={(v) => setReason(v)} options={reasons.map((r) => ({ value: r, label: REASON_LABEL[r] }))} />
              <TextArea label="메모 (고객 확인 내용 등)" value={note} onChange={(v) => setNote(v)} rows={2} placeholder="예: 직원 회식으로 고객 확인" />
              <HStack gap={2} wrap="wrap">
                {txn.status !== 'CONFIRMED' && c.j && !changed && (
                  <Button variant="primary" label="제안대로 승인" clickAction={async () => onConfirm(txn, note ? { decision, reasonCode: reason, note } : undefined)} />
                )}
                {(changed || txn.status === 'CONFIRMED' || !c.j) && (
                  <Button variant="primary" label={changed || !c.j ? '이렇게 확정' : '메모 저장'} clickAction={async () => onConfirm(txn, { decision, reasonCode: reason, note: note || undefined })} />
                )}
                {txn.status === 'CONFIRMED' && <Button label="같은 가맹점에 모두 적용" clickAction={async () => onApplySame(txn)} />}
              </HStack>
              <Text type="supporting">
                {user.name}으로 확정합니다. 확정한 판단은 이 고객의 다음 신고 때 같은 가맹점에 먼저 제안됩니다.
              </Text>
            </VStack>
          </div>
        )}

        {history.data && history.data.length > 0 && (
          <div>
            <div className="wb-block-title">변경 이력</div>
            <table className="wb-history">
              <tbody>
                {history.data.map((h, i) => (
                  <tr key={i}>
                    <td>{new Date(h.at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{h.actor.replace('system:reconcile', '시스템').replace('agent:', 'AI ').replace('preparer:', '담당자 ').replace('reviewer:', '세무사 ')}</td>
                    <td>{ACTION_LABEL[h.action] ?? h.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </VStack>
    </Drawer>
  );
}

const ACTION_LABEL: Record<string, string> = {
  SUGGESTED: '제안',
  AGENT_SKIPPED: 'AI 건너뜀(직접 판단 필요)',
  CONFIRMED: '제안대로 확정',
  OVERRIDDEN: '판정 수정 후 확정',
  CONFIRMED_BULK: '일괄 승인',
  MATCHED: '자동 대사(다른 자료와 맞춤)',
  UNMATCHED: '대사 풀기(같은 거래 아님)',
};
