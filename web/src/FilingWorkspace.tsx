import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from '@astryxdesign/core/Layout';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gql, GqlError, subscribeFiling, TXN_FIELDS, type FilingDetail, type Summary, type Txn, type User } from './api';
import { current, isSales, KIND_LABEL, MATCH_LABEL, num, REASON_LABEL, STATUS, TOOL_LABEL, weekday } from './format';
import { SummaryPanel } from './SummaryPanel';
import { TxnDrawer } from './TxnDrawer';
import { UploadCard } from './UploadCard';
import { ReturnForm } from './ReturnForm';
import { ClientRequests, requestItems } from './ClientRequests';
import { ChatPanel } from './ChatPanel';

/** 계좌 출금은 공제·불공제가 아니라 '무엇을 할지'로 보여 준다 */
const BANK_LABEL: Record<string, string> = { NO_EVIDENCE: '증빙 요청', NOT_VAT: '부가세 무관', NOT_BUSINESS: '개인 지출' };

type View = 'todo' | 'suggested' | 'ruled' | 'confirmed' | 'matched' | 'all';

const VIEW_FILTER: Record<View, (t: Txn) => boolean> = {
  todo: (t) => t.status === 'NEEDS_REVIEW',
  suggested: (t) => t.status === 'SUGGESTED' || t.status === 'NEEDS_AI',
  ruled: (t) => t.status === 'RULED',
  confirmed: (t) => t.status === 'CONFIRMED' && !isSales(t),
  matched: (t) => t.status === 'MATCHED',
  all: () => true,
};

export function FilingWorkspace({ filingId, user }: { filingId: number; user: User }) {
  const qc = useQueryClient();
  const [page, setPage] = useState<'review' | 'return' | 'requests'>('review');
  const [view, setView] = useState<View>('todo');
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [side, setSide] = useState<'chat' | 'summary'>('chat');
  const [live, setLive] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<{ status: 'info' | 'warning' | 'error' | 'success'; title: string } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const filing = useQuery({
    queryKey: ['filing', filingId],
    queryFn: () =>
      gql<{ filing: FilingDetail }>(
        `query($id:Int!){ filing(id:$id){ id period periodStart periodEnd status client files { id kind filename rowCount uploadedBy uploadedAt } } }`,
        { id: filingId },
      ).then((d) => d.filing),
  });
  const txns = useQuery({
    queryKey: ['txns', filingId],
    queryFn: () => gql<{ txns: Txn[] }>(`query($f:Int!){ txns(filingId:$f){ ${TXN_FIELDS} } }`, { f: filingId }).then((d) => d.txns),
  });
  const summary = useQuery({
    queryKey: ['summary', filingId],
    queryFn: () => gql<{ summary: Summary }>(`query($f:Int!){ summary(filingId:$f) }`, { f: filingId }).then((d) => d.summary),
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['txns', filingId] });
    void qc.invalidateQueries({ queryKey: ['summary', filingId] });
    void qc.invalidateQueries({ queryKey: ['filing', filingId] });
    void qc.invalidateQueries({ queryKey: ['filings'] });
  }, [qc, filingId]);

  // 다른 사용자·AI가 바꾼 내용을 실시간으로 반영
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeFiling(filingId, (e) => {
      if (e.type === 'agentStep' && e.txnId) {
        setLive((m) => ({ ...m, [e.txnId!]: `${TOOL_LABEL[e.tool ?? ''] ?? e.tool}: ${e.summary}` }));
        return;
      }
      if (e.type === 'txn' && e.txnId) setLive((m) => {
        const { [e.txnId!]: _, ...rest } = m;
        return rest;
      });
      if (t) clearTimeout(t);
      t = setTimeout(refresh, 150);
    });
    return () => {
      unsub();
      if (t) clearTimeout(t);
    };
  }, [filingId, refresh]);

  const all = txns.data ?? [];
  const purchases = all.filter((t) => !isSales(t));
  const counts = useMemo(
    () => Object.fromEntries((Object.keys(VIEW_FILTER) as View[]).map((v) => [v, all.filter(VIEW_FILTER[v]).length])) as Record<View, number>,
    [all],
  );
  const rows = useMemo(() => all.filter(VIEW_FILTER[view]), [all, view]);
  const sel = rows[Math.min(cursor, rows.length - 1)];
  const openTxn = all.find((t) => t.id === openId) ?? null;

  const step = !filing.data?.files.length ? 0 : filing.data.status === 'READY' ? 4 : counts.suggested + counts.todo + counts.ruled > 0 ? 2 : 3;

  const confirm = useCallback(
    async (t: Txn, change?: { decision: string; reasonCode: string; note?: string }) => {
      try {
        await gql(`mutation($i:ConfirmInput!){ confirm(input:$i){ id } }`, { i: { txnId: t.id, expectedVersion: t.version, ...change } });
        setNotice(null);
      } catch (e) {
        const err = e as GqlError;
        setNotice({ status: err.code === 'CONFLICT' ? 'warning' : 'error', title: err.message });
      }
      refresh();
    },
    [refresh],
  );

  const approveAllRuled = async () => {
    const ids = all.filter((t) => t.status === 'RULED').map((t) => t.id);
    if (!ids.length) return;
    const r = await gql<{ bulkConfirm: { confirmed: number } }>(`mutation($f:Int!,$ids:[Int!]!){ bulkConfirm(filingId:$f, txnIds:$ids){ confirmed } }`, { f: filingId, ids });
    setNotice({ status: 'success', title: `규칙 판정 ${r.bulkConfirm.confirmed}건을 승인했습니다` });
    refresh();
  };

  // 키보드: ↑↓/J K 이동, Enter 상세, A 제안대로 승인
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (page !== 'review' || openId !== null || (e.target as HTMLElement)?.closest('input,textarea,select,[role=combobox]')) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        setCursor((c) => Math.min(c + 1, rows.length - 1));
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        setCursor((c) => Math.max(c - 1, 0));
        e.preventDefault();
      } else if (e.key === 'Enter' && sel) {
        setOpenId(sel.id);
      } else if ((e.key === 'a' || e.key === 'A') && sel && sel.status !== 'CONFIRMED' && sel.status !== 'MATCHED' && current(sel).j) {
        void confirm(sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, sel, openId, confirm, page]);

  useEffect(() => setCursor(0), [view]);

  return (
    <Layout
      header={
        <LayoutHeader hasDivider>
          <VStack gap={3} paddingBlock={2}>
            <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5}>
                <Heading level={2}>{filing.data?.client.name ?? ' '}</Heading>
                <Text type="supporting">
                  {filing.data && `${filing.data.period.replace('-', '년 제')}기 확정 (${filing.data.periodStart} ~ ${filing.data.periodEnd}) · ${filing.data.client.industry} · 등록 ${filing.data.client.registeredAt}`}
                </Text>
              </VStack>
              {!!filing.data?.client.vehicles.length && (
                <span className="wb-sub">
                  보유 차량: {filing.data.client.vehicles.map((v) => v.model).join(', ')}
                </span>
              )}
            </HStack>
            <TabList value={page} onChange={(v) => setPage(v as typeof page)} size="sm">
              <Tab value="review" label="자료·검토" />
              <Tab value="return" label="부가세 신고서" />
              <Tab value="requests" label={`고객 요청 ${requestItems(all).length}`} />
            </TabList>
            <div className="wb-steps" aria-label="신고 준비 단계">
              {['자료 받기', '자동 판정', '담당자 검토', '세무사 확인'].map((label, i) => (
                <span key={label}>
                  {i > 0 && '→ '}
                  {i === step || (step === 4 && i === 3) ? <b>{label}{step === 4 ? ' 완료' : ''}</b> : label}
                </span>
              ))}
            </div>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4} label="거래 검토">
          {page === 'return' && <ReturnForm txns={all} pendingCount={summary.data?.totals.pending ?? 0} />}
          {page === 'requests' && (
            <ClientRequests filingId={filingId} clientName={filing.data?.client.name ?? ''} period={filing.data?.period ?? ''} txns={all} onOpen={(id) => setOpenId(id)} onChanged={refresh} />
          )}
          <div hidden={page !== 'review'}>
          <VStack gap={4}>
            <UploadCard filingId={filingId} files={filing.data?.files ?? []} onDone={refresh} />

            {notice && <Banner status={notice.status} title={notice.title} isDismissable onDismiss={() => setNotice(null)} />}

            <Card padding={0}>
              <VStack gap={0}>
                <HStack hAlign="between" vAlign="center" padding={3} wrap="wrap" gap={2}>
                  <TabList value={view} onChange={(v) => setView(v as View)} size="sm">
                    <Tab value="todo" label={`확인 필요 ${counts.todo}`} />
                    <Tab value="suggested" label={`AI 제안 ${counts.suggested}`} />
                    <Tab value="ruled" label={`규칙 판정 ${counts.ruled}`} />
                    <Tab value="confirmed" label={`확정 ${counts.confirmed}`} />
                    <Tab value="matched" label={`중복·대금 정리 ${counts.matched}`} />
                    <Tab value="all" label={`전체 ${counts.all}`} />
                  </TabList>
                  {view === 'ruled' && counts.ruled > 0 && <Button size="sm" variant="primary" label={`규칙 판정 ${counts.ruled}건 모두 승인`} clickAction={approveAllRuled} />}
                </HStack>
                <div className="wb-keys" style={{ padding: '0 12px 8px' }}>
                  <span>
                    <kbd>↑</kbd> <kbd>↓</kbd> 이동
                  </span>
                  <span>
                    <kbd>Enter</kbd> 상세
                  </span>
                  <span>
                    <kbd>A</kbd> 제안대로 승인
                  </span>
                  <span>
                    매입 {purchases.filter((t) => t.kind !== 'BANK_OUT').length}건 · 계좌 출금 {purchases.filter((t) => t.kind === 'BANK_OUT').length}건 · 매출 {all.length - purchases.length}건
                  </span>
                </div>
                <div ref={tableRef} className="wb-table">
                  <Table density="compact" dividers="rows" hasHover>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>일자</TableHeaderCell>
                        <TableHeaderCell>거래처 · 업종</TableHeaderCell>
                        <TableHeaderCell>공급가액</TableHeaderCell>
                        <TableHeaderCell>세액</TableHeaderCell>
                        <TableHeaderCell>판정</TableHeaderCell>
                        <TableHeaderCell>근거</TableHeaderCell>
                        <TableHeaderCell>상태</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.length === 0 && (
                        <TableRow>
                          <TableCell>
                            <Text type="supporting">{all.length === 0 ? '고객 파일을 올리면 여기에 거래가 나타납니다.' : '이 목록은 비어 있습니다.'}</Text>
                          </TableCell>
                        </TableRow>
                      )}
                      {rows.map((t, i) => {
                        const c = current(t);
                        const st = STATUS[t.status];
                        const selected = sel?.id === t.id;
                        return (
                          <tr
                            key={t.id}
                            className={`astryx-table-row wb-row${selected ? ' wb-row-selected' : ''}${t.status === 'MATCHED' ? ' wb-matched' : ''}`}
                            onClick={() => {
                              setCursor(i);
                              setOpenId(t.id);
                            }}
                          >
                            <TableCell>
                              <Text hasTabularNumbers>
                                {t.date.slice(5)}({weekday(t.date)})
                              </Text>
                            </TableCell>
                            <TableCell>
                              <VStack gap={0}>
                                <Text weight="medium">{t.counterparty}</Text>
                                <Text type="supporting">
                                  {KIND_LABEL[t.kind]}
                                  {t.industry ? ` · ${t.industry}` : ''}
                                  {t.memo ? ` · ${t.memo}` : ''}
                                  {t.counterpartyTaxType === 'SIMPLIFIED' ? ' · 간이' : t.counterpartyTaxType === 'EXEMPT' ? ' · 면세' : ''}
                                </Text>
                              </VStack>
                            </TableCell>
                            <TableCell>
                              <div className="wb-num">{num(t.supplyAmount)}</div>
                            </TableCell>
                            <TableCell>
                              <div className="wb-num" title={t.vatEstimated ? '명세서에 세액이 없어 합계의 1/11로 추정' : undefined}>
                                {t.kind === 'BANK_OUT' ? '—' : `${t.vatEstimated ? '≈' : ''}${num(t.vat)}`}
                              </div>
                            </TableCell>
                            <TableCell>
                              {t.status === 'MATCHED' ? (
                                <span className="wb-sub">{MATCH_LABEL[t.matchType ?? ''] ?? '정리됨'}</span>
                              ) : isSales(t) ? (
                                <span className="wb-sub">매출</span>
                              ) : t.kind === 'BANK_OUT' && c.j ? (
                                <span className={c.j.reasonCode === 'NO_EVIDENCE' ? 'wb-warn' : 'wb-sub'}>{BANK_LABEL[c.j.reasonCode] ?? '불공제'}</span>
                              ) : c.j ? (
                                <span className={c.j.decision === 'DEDUCT' ? 'wb-ded' : 'wb-nonded'}>{c.j.decision === 'DEDUCT' ? '공제' : '불공제'}</span>
                              ) : (
                                <span className="wb-sub">미판정</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {live[t.id] ? (
                                <span className="wb-live">{live[t.id]}</span>
                              ) : t.status === 'MATCHED' ? (
                                <span className="wb-sub">{t.hint}</span>
                              ) : isSales(t) ? null : (
                                <VStack gap={0}>
                                  <Text>{c.j ? REASON_LABEL[c.j.reasonCode] : '—'}</Text>
                                  <Text type="supporting">
                                    {c.source}
                                    {t.hint && !c.j ? t.hint : ''}
                                  </Text>
                                </VStack>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className={t.status === 'NEEDS_REVIEW' ? 'wb-warn' : t.status === 'CONFIRMED' ? undefined : 'wb-sub'}>{live[t.id] ? '검토 중' : st.label}</span>
                            </TableCell>
                          </tr>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </VStack>
            </Card>
          </VStack>
          </div>
          <TxnDrawer
            txn={openTxn}
            user={user}
            liveStep={openTxn ? live[openTxn.id] : undefined}
            sourceName={filing.data?.files.find((f) => f.id === openTxn?.sourceFileId)?.filename}
            onOpenTxn={(id) => setOpenId(id)}
            onUnmatch={async (t) => {
              try {
                await gql(`mutation($t:Int!){ unmatch(txnId:$t){ id } }`, { t: t.id });
                setNotice({ status: 'info', title: `${t.counterparty} 건을 따로 검토하도록 풀었습니다` });
              } catch (e) {
                setNotice({ status: 'warning', title: (e as Error).message });
              }
              refresh();
            }}
            onClose={() => setOpenId(null)}
            onConfirm={async (t, change) => {
              await confirm(t, change);
            }}
            onApplySame={async (t) => {
              try {
                const r = await gql<{ applyToSameCounterparty: { applied: number } }>(`mutation($t:Int!){ applyToSameCounterparty(txnId:$t){ applied } }`, { t: t.id });
                setNotice({ status: 'success', title: `같은 가맹점 ${r.applyToSameCounterparty.applied}건에 같은 판단을 적용했습니다` });
              } catch (e) {
                setNotice({ status: 'warning', title: (e as Error).message });
              }
              refresh();
            }}
          />
        </LayoutContent>
      }
      end={
        <LayoutPanel width={420} hasDivider padding={4} label="대화 · 요약">
          <div className="wb-side-tabs">
            <button className={side === 'chat' ? 'on' : ''} onClick={() => setSide('chat')}>
              대화
            </button>
            <button className={side === 'summary' ? 'on' : ''} onClick={() => setSide('summary')}>
              신고서 요약
            </button>
          </div>
          <div style={{ display: side === 'chat' ? 'block' : 'none', height: 'calc(100% - 44px)' }}>
            <ChatPanel filingId={filingId} txns={all} onOpen={(id) => setOpenId(id)} onChanged={refresh} />
          </div>
          {side === 'summary' && <SummaryPanel filingId={filingId} summary={summary.data} user={user} status={filing.data?.status} onChanged={refresh} />}
        </LayoutPanel>
      }
    />
  );
}
