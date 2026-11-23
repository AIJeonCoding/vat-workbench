import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/agent/llm';

process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:5433/vat_test';
process.env.LLM_SKIP_HEALTH = '1';

const preparer = { 'x-user-id': 'kim', 'x-role': 'preparer' };
const reviewer = { 'x-user-id': 'lee', 'x-role': 'reviewer' };
const samples = join(__dirname, '..', 'samples');

/**
 * 시나리오 LLM: Cline 형식(도구 하나씩)으로 답한다.
 * - 쿠팡: 처음엔 confidence를 빼먹은 제안 → 루프가 오류를 돌려주면 고쳐서 다시 제출
 * - 호텔: 예외(타임아웃 흉내) → 업무는 멈추지 않고 "검토 필요"
 */
async function scriptedChat(messages: ChatMessage[]): Promise<string> {
  // 파일 열 연결 추측 요청: 사전에 없는 "청구액"을 금액 열로 답한다
  if (messages[0]?.content.includes('자료 정리 보조')) return '{"date":"이용일","merchant":"가맹점","amount":"청구액"}';
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = users[users.length - 1];
  const txInfo = users.find((u) => u.startsWith('[get_transaction 결과]')) ?? '';
  const merchant = /"가맹점":"([^"]+)"/.exec(txInfo)?.[1] ?? '';

  if (!txInfo) return '<get_transaction></get_transaction>';
  if (merchant.includes('호텔')) throw Object.assign(new Error('timeout'), { name: 'AbortError' });
  if (!users.some((u) => u.startsWith('[find_prior_decisions 결과]'))) {
    return `<find_prior_decisions><counterparty>${merchant}</counterparty></find_prior_decisions>`;
  }
  const done = (d: string, code: string, conf?: number) =>
    `<attempt_completion><decision>${d}</decision><reason_code>${code}</reason_code><law_ref>부가가치세법 제39조</law_ref><explanation>${merchant} 시나리오 판단입니다.</explanation>${conf === undefined ? '' : `<confidence>${conf}</confidence>`}</attempt_completion>`;
  if (merchant.includes('쿠팡')) return last.startsWith('[ERROR]') ? done('DEDUCT', 'BUSINESS', 0.6) : done('DEDUCT', 'BUSINESS');
  if (/스시|백화점|골프|화원|꽃집/.test(merchant)) return done('NON_DEDUCT', 'ENTERTAINMENT', 0.8);
  if (/김밥|호프|편의점|GS25|다이소|오피스|스타벅스/.test(merchant)) return done('DEDUCT', 'BUSINESS', 0.75);
  return done('NON_DEDUCT', 'NOT_BUSINESS', 0.4);
}

let app: NestFastifyApplication;
let em: EntityManager;
let filingId: number;

const inject = (opts: Record<string, unknown>) => app.getHttpAdapter().getInstance().inject(opts as never);
const gql = async (query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = preparer) => {
  const r = await inject({ method: 'POST', url: '/graphql', headers: { ...headers, 'content-type': 'application/json' }, payload: { query, variables } });
  return r.json() as { data?: any; errors?: { message: string; extensions?: any }[] };
};
const upload = (name: string, buf?: Buffer, id = filingId, mapping?: unknown) =>
  inject({
    method: 'POST',
    url: `/api/filings/${id}/files`,
    headers: {
      ...preparer,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
      ...(mapping ? { 'x-mapping': encodeURIComponent(JSON.stringify(mapping)) } : {}),
    },
    payload: buf ?? readFileSync(join(samples, name)),
  });
const txns = async () => (await gql(`query($f:Int!){ txns(filingId:$f){ id counterparty counterpartyBrn status version rule ai final hint kind vat supplyAmount matchType linkedTxnId memo vatEstimated } }`, { f: filingId })).data.txns as any[];
const byName = (list: any[], name: string) => list.filter((t) => t.counterparty.includes(name));

beforeAll(async () => {
  const { createApp } = await import('../src/app.setup');
  const { seedDemo } = await import('../src/seed/seed');
  app = await createApp({ chat: scriptedChat });
  await app.get(MikroORM).schema.refreshDatabase();
  em = app.get(EntityManager);
  await seedDemo(em.fork());
  filingId = (await gql('{ filings { id clientName } }')).data.filings.find((f: any) => f.clientName.includes('베이커리')).id;
});

afterAll(async () => {
  await app?.close();
});

describe('1. 고객 파일 업로드', () => {
  it('파일 종류를 헤더로 알아내고, 잘못된 줄은 줄번호·이유로 알려 준다', async () => {
    const card = (await upload('01_사업용카드_매입내역_2026-1기.xlsx')).json();
    expect(card).toMatchObject({ kind: 'CARD_PURCHASE', duplicate: false, added: 32 });
    expect(card.errors).toHaveLength(1);
    expect(card.errors[0].row).toBe(34);
    expect(card.errors[0].message).toContain('합계');

    const kinds = await Promise.all(
      ['02_전자세금계산서_매입_2026-1기.xlsx', '03_전자세금계산서_매출_2026-1기.xlsx', '04_카드매출_월별합계_2026-1기.csv'].map(async (f) => (await upload(f)).json()),
    );
    expect(kinds.map((k) => [k.kind, k.added])).toEqual([
      ['PURCHASE_INVOICE', 8],
      ['SALES_INVOICE', 6],
      ['CARD_SALES', 6],
    ]);
  });

  it('같은 파일을 다시 올려도 거래가 늘지 않는다', async () => {
    const again = (await upload('01_사업용카드_매입내역_2026-1기.xlsx')).json();
    expect(again).toMatchObject({ duplicate: true, added: 0 });
    expect(await txns()).toHaveLength(52);
  });

  it('알 수 없는 양식은 헤더 목록과 함께 거절', async () => {
    const r = (await upload('memo.csv', Buffer.from('이름,전화,주소\n홍길동,010,서울'))).json();
    expect(r.added).toBe(0);
    expect(r.errors[0].message).toContain('알 수 없는 양식');
  });
});

describe('2. 규칙 판정', () => {
  it('확실한 건은 규칙이 근거와 함께 바로 판정한다', async () => {
    const list = await txns();
    const one = (n: string) => byName(list, n)[0];
    expect(one('한국제과기계')).toMatchObject({ status: 'RULED', rule: { decision: 'DEDUCT', lawRef: expect.stringContaining('제8호 단서') } });
    expect(one('하나로마트')).toMatchObject({ status: 'RULED', rule: { decision: 'NON_DEDUCT', reasonCode: 'EXEMPT_SUPPLIER' } });
    expect(one('동네철물')).toMatchObject({ status: 'RULED', rule: { reasonCode: 'SIMPLIFIED_SUPPLIER' } });
    expect(one('대한제분')).toMatchObject({ status: 'RULED', rule: { decision: 'DEDUCT', reasonCode: 'BUSINESS' } });
    // 경차와 승용차를 함께 보유 → 어느 차인지 사람이 확인
    expect(one('행복주유소')).toMatchObject({ status: 'NEEDS_REVIEW', rule: { reasonCode: 'VEHICLE_PASSENGER' } });
    expect(one('현대캐피탈').status).toBe('NEEDS_REVIEW');
    expect(one('모퉁이 커피').status).toBe('CONFIRMED'); // 매출은 판정 대상 아님
  });
});

describe('3. AI 제안 (Cline식 루프 + 시나리오 LLM)', () => {
  it('애매한 건은 AI가 근거·단계와 함께 제안하고, 사람 확정 전까지 확정되지 않는다', async () => {
    await app.get((await import('../src/agent/agent.queue')).AgentQueue).idle();
    const list = await txns();
    const sushi = byName(list, '스시하루')[0];
    expect(sushi.status).toBe('SUGGESTED');
    expect(sushi.ai).toMatchObject({ decision: 'NON_DEDUCT', reasonCode: 'ENTERTAINMENT', confidence: 0.8 });
    expect(sushi.ai.steps.map((s: any) => s.tool)).toEqual(['get_transaction', 'find_prior_decisions']);
    expect(sushi.final).toBeNull();
  });

  it('형식이 틀린 제안은 오류를 돌려줘 스스로 고치게 한다', async () => {
    const coupang = byName(await txns(), '쿠팡')[0];
    expect(coupang.status).toBe('SUGGESTED');
    expect(coupang.ai.steps.map((s: any) => s.tool)).toContain('format_error');
    expect(coupang.ai.confidence).toBe(0.6);
  });

  it('AI가 실패해도 업무는 계속되고 그 건만 "검토 필요"로 넘어간다', async () => {
    const hotel = byName(await txns(), '호텔')[0];
    expect(hotel.status).toBe('NEEDS_REVIEW');
    expect(hotel.hint).toContain('시간 초과');
  });

  it('확신이 낮은 제안은 "검토 필요"로 분류', async () => {
    const hanwoo = byName(await txns(), '한우명가')[0];
    expect(hanwoo.status).toBe('NEEDS_REVIEW');
    expect(hanwoo.ai.confidence).toBe(0.4);
  });
});

describe('4. 사람 확정 · 동시 수정 · 판단 기억', () => {
  it('제안을 승인하면 확정, 오래된 버전으로 수정하면 CONFLICT', async () => {
    const [first] = byName(await txns(), '스시하루');
    const ok = await gql(`mutation($i:ConfirmInput!){ confirm(input:$i){ id status final version } }`, { i: { txnId: first.id, expectedVersion: first.version } });
    expect(ok.data.confirm).toMatchObject({ status: 'CONFIRMED', final: { decision: 'NON_DEDUCT', decidedBy: 'kim' } });

    const stale = await gql(`mutation($i:ConfirmInput!){ confirm(input:$i){ id } }`, {
      i: { txnId: first.id, expectedVersion: first.version, decision: 'DEDUCT', reasonCode: 'BUSINESS' },
    }, reviewer);
    expect(stale.errors?.[0].extensions.code).toBe('CONFLICT');
  });

  it('같은 가맹점 일괄 적용 + 다음 신고 때 사람 판단을 먼저 제안', async () => {
    const [first] = byName(await txns(), '스시하루');
    const r = await gql(`mutation($t:Int!){ applyToSameCounterparty(txnId:$t){ applied } }`, { t: first.id });
    expect(r.data.applyToSameCounterparty.applied).toBe(1);
    expect(byName(await txns(), '스시하루').every((t) => t.status === 'CONFIRMED')).toBe(true);

    // 다음 기(2026-2) 신고에 같은 가맹점이 나오면 AI를 부르지 않고 이전 사람 판단으로 제안
    const { Filing } = await import('../src/domain/entities');
    const f = em.fork();
    const bakeryFiling = await f.findOneOrFail(Filing, filingId);
    const next = f.create(Filing, { clientId: bakeryFiling.clientId, period: '2026-2', periodStart: '2026-07-01', periodEnd: '2026-12-31', status: bakeryFiling.status });
    await f.flush();
    const csv = '승인일자,승인번호,가맹점명,가맹점사업자번호,가맹점과세유형,업종,공급가액,부가세,합계\n' +
      `2026-07-03,N1,스시하루,${first.counterpartyBrn ?? ''},일반,일반음식점,300000,30000,330000`;
    const res = (await upload('next.csv', Buffer.from(csv), next.id)).json();
    expect(res.added).toBe(1);
    const nextTxn = (await gql(`query($f:Int!){ txns(filingId:$f){ status ai } }`, { f: next.id })).data.txns[0];
    expect(nextTxn).toMatchObject({ status: 'SUGGESTED', ai: { model: 'memory', decision: 'NON_DEDUCT' } });
  });

  it('Agent는 확정할 수 없고, 신고 준비 완료는 검토자만', async () => {
    const { ReviewService } = await import('../src/review/review.service');
    const t = byName(await txns(), '김밥천국')[0];
    await expect(app.get(ReviewService).confirm({ userId: 'qwen', role: 'agent' }, { txnId: t.id, expectedVersion: t.version })).rejects.toThrow('사람만');
    const byPreparer = await gql(`mutation($f:Int!){ markReady(filingId:$f){ status } }`, { f: filingId });
    expect(byPreparer.errors?.[0].extensions.code).toBe('FORBIDDEN');
    const pending = await gql(`mutation($f:Int!){ markReady(filingId:$f){ status } }`, { f: filingId }, reviewer);
    expect(pending.errors?.[0].extensions.code).toBe('CONFLICT');
  });
});

describe('5. 신고서 요약 조서', () => {
  it('매출세액 − 공제 매입세액 = 납부세액, 판정을 바꾸면 바로 다시 계산된다', async () => {
    const s1 = (await gql(`query($f:Int!){ summary(filingId:$f) }`, { f: filingId })).data.summary;
    expect(s1.salesInvoice.vat).toBe(755_000);
    expect(s1.outputVat).toBe(s1.salesInvoice.vat + s1.cardSales.vat);
    expect(s1.payable).toBe(s1.outputVat - s1.inputVat);

    const flour = byName(await txns(), '대한제분')[0];
    await gql(`mutation($i:ConfirmInput!){ confirm(input:$i){ id } }`, {
      i: { txnId: flour.id, expectedVersion: flour.version, decision: 'NON_DEDUCT', reasonCode: 'NOT_BUSINESS', note: '대표 개인 구매로 확인' },
    });
    const s2 = (await gql(`query($f:Int!){ summary(filingId:$f) }`, { f: filingId })).data.summary;
    expect(s2.inputVat).toBe(s1.inputVat - flour.vat);
    expect(s2.payable).toBe(s1.payable + flour.vat);
  });
});

describe('6. Excel 왕복', () => {
  it('내보낸 파일에서 판정을 고쳐 다시 올리면 차이만 보여 주고, 확인 후 반영한다', async () => {
    const res = await inject({ method: 'GET', url: `/api/filings/${filingId}/export.xlsx` });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('검토결과')!;
    let target = 0;
    ws.eachRow((row, n) => {
      if (n > 1 && String(row.getCell(4).value).includes('스타벅스')) {
        target = Number(row.getCell(1).value);
        row.getCell(9).value = '불공제';
        row.getCell(10).value = '사업 무관·가사';
        row.getCell(15).value = '대표 개인 음료';
      }
    });
    const edited = Buffer.from(await wb.xlsx.writeBuffer());
    const diff = (await upload('검토결과_수정본.xlsx', edited)).json();
    expect(diff.kind).toBe('REVIEW_EXPORT');
    expect(diff.reviewDiff).toEqual([expect.objectContaining({ txnId: target, before: '공제', after: '불공제' })]);

    const applied = await inject({
      method: 'POST',
      url: `/api/filings/${filingId}/review-diff`,
      headers: { ...reviewer, 'content-type': 'application/json' },
      payload: { changes: diff.reviewDiff },
    });
    expect(applied.json()).toMatchObject({ applied: 1, failed: [] });
    const t = (await txns()).find((x) => x.id === target)!;
    expect(t.final).toMatchObject({ decision: 'NON_DEDUCT', reasonCode: 'NOT_BUSINESS', decidedBy: 'lee', note: '대표 개인 음료' });
    const hist = (await gql(`query($t:Int!){ txnHistory(txnId:$t){ action actor } }`, { t: target })).data.txnHistory;
    expect(hist.map((h: any) => h.actor)).toEqual(['agent:qwen', 'reviewer:lee']);
  });
});

describe('7. 은행 거래내역·카드사 명세서 + 대사', () => {
  const BANK = '06_은행_거래내역_2026-1기(가상).xlsx';
  const CARDST = '07_카드사_이용내역_2026-1기(가상).xlsx';
  const summary = async () => (await gql(`query($f:Int!){ summary(filingId:$f) }`, { f: filingId })).data.summary;
  let before: any;

  it('처음 보는 은행 형식은 바로 넣지 않고, 추측한 열 연결을 먼저 보여 준다', async () => {
    before = await summary();
    const count = (await txns()).length;
    const r = (await upload(BANK)).json();
    expect(r.added).toBe(0);
    expect(r.needsMapping).toMatchObject({
      kind: 'BANK',
      guessedBy: 'dictionary',
      missing: [],
      mapping: { date: '거래일시', counterparty: '기재내용', out: '찾으신금액', in: '맡기신금액', memo: '적요' },
    });
    expect(r.needsMapping.samples[0][0]).toContain('2026.01.10');
    expect(await txns()).toHaveLength(count);
  });

  it('담당자가 확인하면 출금만 거래로 넣고, 카드대금·세금계산서 대금은 자동으로 맞춰 정리한다', async () => {
    const guess = (await upload(BANK)).json().needsMapping;
    const r = (await upload(BANK, undefined, filingId, { kind: 'BANK', label: '테스트은행 거래내역', mapping: guess.mapping })).json();
    expect(r).toMatchObject({ kind: 'BANK', added: 19, skippedDeposits: 2, template: { label: '테스트은행 거래내역', reused: false }, matched: 10 });

    const bank = (await txns()).filter((t) => t.kind === 'BANK_OUT');
    const one = (n: string) => bank.find((t) => t.counterparty.includes(n))!;
    expect(bank.filter((t) => t.counterparty.includes('신한카드')).every((t) => t.status === 'MATCHED')).toBe(true);
    expect(one('한빛인테리어')).toMatchObject({ status: 'MATCHED', matchType: 'INVOICE_PAID' });
    expect(one('현대캐피탈')).toMatchObject({ status: 'MATCHED', matchType: 'INVOICE_PAID' });
    expect(one('국민연금')).toMatchObject({ status: 'RULED', rule: { reasonCode: 'NOT_VAT' } });
    expect(one('이동철')).toMatchObject({ status: 'NEEDS_REVIEW', rule: { reasonCode: 'NO_EVIDENCE' } });
    expect(one('생활비')).toMatchObject({ status: 'NEEDS_REVIEW', rule: { reasonCode: 'NOT_BUSINESS' } });
    // 임대료 5번 이체가 서로 다른 달 세금계산서 5장과 하나씩 묶인다
    const rent = bank.filter((t) => t.counterparty.includes('역삼상가'));
    expect(new Set(rent.map((t) => t.linkedTxnId)).size).toBe(5);

    const s = await summary();
    expect(s.bank).toMatchObject({ count: 19, cardPayment: 3, invoicePaid: 7, noEvidence: { count: 4 }, notVat: 4, other: 1 });
    expect(s.payable).toBe(before.payable); // 계좌 자료는 신고서 숫자를 바꾸지 않는다
  });

  it('같은 형식의 다음 파일은 저장된 열 연결로 바로 들어가고, 이미 있는 줄은 건너뛴다', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(samples, BANK));
    wb.worksheets[0].addRow(['2026.06.28 15:00', '타행이체', '동네수리', 150_000, '', 0, '인터넷']);
    const r = (await upload('06_은행_추가분.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))).json();
    expect(r).toMatchObject({ kind: 'BANK', added: 1, skippedExisting: 19, template: { reused: true } });
    expect(r.needsMapping).toBeUndefined();
  });

  it('계좌이체 기록만으로는 공제로 확정할 수 없다', async () => {
    const t = (await txns()).find((x) => x.counterparty === '이동철')!;
    const r = await gql(`mutation($i:ConfirmInput!){ confirm(input:$i){ id } }`, {
      i: { txnId: t.id, expectedVersion: t.version, decision: 'DEDUCT', reasonCode: 'BUSINESS' },
    });
    expect(r.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });

  it('카드사 명세서는 홈택스 사업용카드와 겹치는 줄을 한 번만 반영하고, 새 줄은 세액을 추정해 검토로 보낸다', async () => {
    const s0 = await summary();
    const guess = (await upload(CARDST)).json().needsMapping;
    expect(guess).toMatchObject({ kind: 'CARD_STATEMENT', mapping: { date: '이용일자', merchant: '이용하신곳', amount: '이용금액', industry: '업종' } });
    const r = (await upload(CARDST, undefined, filingId, { kind: 'CARD_STATEMENT', label: '테스트카드 이용내역', mapping: guess.mapping })).json();
    expect(r).toMatchObject({ added: 11, skippedCancels: 1, matched: 4 });
    await app.get((await import('../src/agent/agent.queue')).AgentQueue).idle();

    const st = (await txns()).filter((t) => t.kind === 'CARD_STATEMENT');
    expect(st.filter((t) => t.matchType === 'SAME_AS_HOMETAX_CARD')).toHaveLength(4);
    const mart = st.find((t) => t.counterparty.includes('이마트'))!;
    expect(mart).toMatchObject({ supplyAmount: 120_000, vat: 12_000 });
    expect(mart.hint).toContain('추정');

    const s1 = await summary();
    expect(s1.cardStatementDuplicates).toBe(4);
    const full = (await gql(`query($f:Int!){ txns(filingId:$f){ kind status vat rule ai final } }`, { f: filingId })).data.txns as any[];
    const newDeduct = full
      .filter((t) => t.kind === 'CARD_STATEMENT' && t.status !== 'MATCHED' && (t.final ?? t.ai ?? t.rule)?.decision === 'DEDUCT')
      .reduce((a, t) => a + t.vat, 0);
    expect(s1.inputVat - s0.inputVat).toBe(newDeduct); // 겹친 4건은 두 번 공제되지 않는다
  });

  it('잘못 묶였으면 "같은 거래 아님"으로 풀 수 있고, 다시 묶이지 않는다', async () => {
    const dup = (await txns()).find((t) => t.kind === 'CARD_STATEMENT' && t.status === 'MATCHED')!;
    const r = await gql(`mutation($t:Int!){ unmatch(txnId:$t){ status matchType } }`, { t: dup.id });
    expect(r.data.unmatch.status).not.toBe('MATCHED');
    expect(r.data.unmatch.matchType).toBe('UNMATCHED');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(samples, BANK));
    wb.worksheets[0].addRow(['2026.06.29 15:00', '타행이체', '동네수리2', 10_000, '', 0, '인터넷']);
    await upload('06_은행_추가분2.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect((await txns()).find((t) => t.id === dup.id)!.status).not.toBe('MATCHED');
  });

  it('사전에 없는 열 이름은 로컬 AI가 추측해 채우고, 담당자 확인을 기다린다', async () => {
    const r = (await upload('카드_이상한양식.csv', Buffer.from('이용일,가맹점,청구액\n2026-06-20,베이킹몰,11000'))).json();
    expect(r.needsMapping).toMatchObject({ kind: 'CARD_STATEMENT', guessedBy: 'llm', missing: [], mapping: { amount: '청구액' } });
  });

  it('내보내기에 고객에게 보낼 증빙 요청 목록과 대사 내역이 들어간다', async () => {
    const res = await inject({ method: 'GET', url: `/api/filings/${filingId}/export.xlsx` });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ask = wb.getWorksheet('증빙요청')!;
    expect(ask.rowCount - 1).toBe(6); // 4 + 동네수리 + 동네수리2
    const rec = wb.getWorksheet('대사')!;
    expect(rec.rowCount - 1).toBe(13); // 계좌 10 + 카드 중복 3(1건은 풀었음)
  });
});

describe('8. PDF 명세서', () => {
  const PDF = '08_은행_거래내역_PDF_2026-1기(가상).pdf';

  it('글자 있는 PDF는 좌표로 표를 만들어 엑셀과 같은 흐름(열 연결 확인 → 대사)을 탄다', async () => {
    const first = (await upload(PDF)).json();
    const guess = first.needsMapping;
    expect(guess).toMatchObject({ kind: 'BANK', mapping: { date: '거래일자', counterparty: '내용', out: '출금(원)', in: '입금(원)', memo: '적요' } });
    expect(guess.samples[0]).toEqual(['2026.01.15', '자동이체', '소상공인정책자금 이자', '84,000', '', '5,916,000']);

    const r = (await upload(PDF, undefined, filingId, { kind: 'BANK', label: '테스트 PDF 은행', mapping: guess.mapping })).json();
    // 14줄 중 입금 1줄 제외, 쪽 번호·반복 열 이름 줄은 오류 없이 건너뜀
    expect(r).toMatchObject({ added: 13, skippedDeposits: 1, matched: 3, errors: [] });
    const list = (await txns()).filter((t) => t.kind === 'BANK_OUT');
    expect(list.filter((t) => t.counterparty.includes('이자')).every((t) => t.rule.reasonCode === 'NOT_VAT')).toBe(true);
    expect(list.find((t) => t.counterparty.includes('화재보험료')).rule.reasonCode).toBe('NOT_VAT');
    expect(list.filter((t) => t.counterparty.includes('기장료')).every((t) => t.rule.reasonCode === 'NO_EVIDENCE')).toBe(true);
  });

  it('스캔 이미지 PDF는 이유와 함께 거절한다(아무것도 저장 안 함)', async () => {
    const before = (await txns()).length;
    const r = (await upload('09_스캔본_명세서(가상).pdf')).json();
    expect(r.added).toBe(0);
    expect(r.errors[0].message).toContain('스캔');
    expect(await txns()).toHaveLength(before);
  });
});

describe('9. 고객 요청 진행 상태', () => {
  it('요청함·답 받음을 서버에 남기고 감사이력에 기록한다', async () => {
    const ids = (await txns()).filter((t) => t.kind === 'BANK_OUT' && t.rule?.reasonCode === 'NO_EVIDENCE').map((t) => t.id).slice(0, 2);
    const r = await gql(`mutation($f:Int!,$ids:[Int!]!,$s:String!){ setRequestStatus(filingId:$f, txnIds:$ids, status:$s){ applied } }`, { f: filingId, ids, s: 'sent' });
    expect(r.data.setRequestStatus.applied).toBe(2);
    const t = (await gql(`query($f:Int!){ txns(filingId:$f){ id clientRequest } }`, { f: filingId })).data.txns.find((x: any) => x.id === ids[0]);
    expect(t.clientRequest).toMatchObject({ status: 'sent', by: 'kim' });
    const bad = await gql(`mutation($f:Int!,$ids:[Int!]!,$s:String!){ setRequestStatus(filingId:$f, txnIds:$ids, status:$s){ applied } }`, { f: filingId, ids, s: 'done' });
    expect(bad.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });
});
