import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { FileInput } from '@astryxdesign/core/FileInput';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useState } from 'react';
import { applyReviewDiff, uploadFile, type FilingDetail, type IngestResult, type NeedsMapping } from './api';
import { MappingForm } from './MappingForm';
import { KIND_LABEL } from './format';

/**
 * 고객이 보낸 파일을 한 번에 끌어다 놓는 곳. 종류는 서버가 헤더로 알아낸다.
 * 검토 결과 수정본을 올리면 바뀐 판정만 보여 주고, 확인 후 반영한다.
 */
export function UploadCard({ filingId, files, onDone }: { filingId: number; files: FilingDetail['files']; onDone: () => void }) {
  const [picked, setPicked] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<(IngestResult & { failed?: string })[]>([]);
  const [applied, setApplied] = useState<string | null>(null);
  const [toMap, setToMap] = useState<{ file: File; need: NeedsMapping }[]>([]);

  const run = async (list: File[]) => {
    if (!list.length) return;
    setBusy(true);
    setApplied(null);
    const out: (IngestResult & { failed?: string })[] = [];
    const maps: { file: File; need: NeedsMapping }[] = [];
    for (const f of list) {
      try {
        const r = await uploadFile(filingId, f);
        if (r.needsMapping) maps.push({ file: f, need: r.needsMapping });
        else out.push(r);
      } catch (e) {
        out.push({ filename: f.name, kind: '', kindLabel: '실패', added: 0, duplicate: false, skippedExisting: 0, errors: [], fileId: null, failed: (e as Error).message });
      }
      setResults([...out]);
    }
    setToMap((m) => [...m, ...maps]);
    setBusy(false);
    setPicked([]);
    onDone();
  };

  const describe = (r: IngestResult) => {
    if (r.duplicate) return `${r.filename} — 이미 올린 파일이라 건너뛰었습니다`;
    const parts = [`${r.filename} → ${r.kindLabel}`];
    if (r.template) parts[0] += `(${r.template.label}${r.template.reused ? '' : ' · 형식 저장함'})`;
    parts.push(`${r.added}건 추가`);
    if (r.skippedExisting) parts.push(`이미 있는 거래 ${r.skippedExisting}건 제외`);
    if (r.skippedDeposits) parts.push(`입금 ${r.skippedDeposits}건은 비용 검토에서 제외`);
    if (r.skippedCancels) parts.push(`취소 ${r.skippedCancels}건 제외`);
    if (r.matched) parts.push(`다른 자료와 맞춰 정리 ${r.matched}건`);
    if (r.errors.length) parts.push(r.kind === 'UNKNOWN' && !r.added ? '읽지 못함' : `확인할 줄 ${r.errors.length}개`);
    return parts.join(' · ');
  };

  const diff = results.find((r) => r.reviewDiff && r.reviewDiff.length > 0);

  return (
    <Card padding={3}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={0.5}>
            <Text weight="semibold">고객 자료</Text>
            <Text type="supporting">홈택스 카드·세금계산서, 은행 거래내역, 카드사 이용내역(엑셀·CSV·PDF)을 그대로 올리세요. 종류는 자동으로 알아냅니다.</Text>
          </VStack>
          {files.length > 0 && (
            <span className="wb-sub">받은 자료: {files.map((f) => `${KIND_LABEL[f.kind] ?? f.kind} ${f.rowCount}건`).join(' · ')}</span>
          )}
        </HStack>
        <FileInput
          label="고객 파일"
          isLabelHidden
          mode="dropzone"
          isMultiple
          accept=".xlsx,.csv,.pdf"
          placeholder="여기에 파일을 끌어다 놓거나 눌러서 고르세요 (xlsx, csv, pdf · 여러 개 가능)"
          value={picked}
          isLoading={busy}
          onChange={(v) => setPicked((v as File[] | null) ?? [])}
          changeAction={async (v) => run((v as File[] | null) ?? [])}
        />

        {toMap.map(({ file, need }) => (
          <MappingForm
            key={file.name}
            filename={file.name}
            need={need}
            onCancel={() => setToMap((m) => m.filter((x) => x.file !== file))}
            onSubmit={async (mapping) => {
              const r = await uploadFile(filingId, file, mapping);
              setResults((rs) => [...rs, r]);
              setToMap((m) => m.filter((x) => x.file !== file));
              onDone();
            }}
          />
        ))}

        {results.map((r, i) =>
          r.failed ? (
            <Banner key={i} status="error" title={`${r.filename}: ${r.failed}`} collapsible={false} />
          ) : r.kind === 'REVIEW_EXPORT' ? null : (
            <Banner
              key={i}
              status={r.errors.length ? 'warning' : r.duplicate ? 'info' : 'success'}
              title={describe(r)}
              collapsible={r.errors.length ? { defaultIsOpen: true } : false}
            >
              {r.errors.length > 0 && (
                <VStack gap={1}>
                  {r.errors.map((e) => (
                    <Text key={e.row} type="supporting">
                      {e.row ? `${e.row}행: ` : ''}{e.message}
                    </Text>
                  ))}
                </VStack>
              )}
            </Banner>
          ),
        )}

        {diff && !applied && (
          <Banner
            status="info"
            title={`수정본에서 바뀐 판정 ${diff.reviewDiff!.length}건 — 확인 후 반영하세요`}
            collapsible={false}
            endContent={
              <Button
                variant="primary"
                size="sm"
                label="반영하기"
                clickAction={async () => {
                  const r = await applyReviewDiff(filingId, diff.reviewDiff!);
                  setApplied(`${r.applied}건 반영${r.failed.length ? `, ${r.failed.length}건 실패` : ''}`);
                  onDone();
                }}
              />
            }
          >
            <VStack gap={1}>
              {diff.reviewDiff!.map((d) => (
                <Text key={d.txnId}>
                  #{d.txnId} {d.counterparty}: {d.before} → <b>{d.after}</b>
                  {d.reason ? ` (${d.reason})` : ''} {d.note ? `— ${d.note}` : ''}
                </Text>
              ))}
            </VStack>
          </Banner>
        )}
        {applied && <Banner status="success" title={`수정본 ${applied}`} collapsible={false} />}
        {results.some((r) => r.kind === 'REVIEW_EXPORT' && !r.reviewDiff?.length) && <Banner status="info" title="수정본에 바뀐 판정이 없습니다" collapsible={false} />}
      </VStack>
    </Card>
  );
}
