import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useMemo, useState } from 'react';
import type { MappingInput, NeedsMapping, StatementKind } from './api';

const NONE = '__none__';
const fmt = (v: string) => (/^-?\d{4,}$/.test(v) ? Number(v).toLocaleString('ko-KR') : v);

/**
 * 처음 보는 은행·카드사 파일의 열 연결 확인.
 * 추측한 연결을 미리 채워 두고, 아래에 "이렇게 읽힌다" 미리보기를 보여 준다.
 * 확인하면 이 형식(열 이름 묶음)을 저장해 다음부터는 묻지 않는다.
 */
export function MappingForm({ filename, need, onSubmit, onCancel }: { filename: string; need: NeedsMapping; onSubmit: (m: MappingInput) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<StatementKind>(need.kind);
  const [mapping, setMapping] = useState<Record<string, string>>(need.mapping);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const fields = need.fields[kind];

  const problems = useMemo(() => {
    const p: string[] = [];
    for (const f of fields) if (f.required && !mapping[f.key]) p.push(`${f.label} 열을 골라 주세요`);
    const used = fields.map((f) => mapping[f.key]).filter(Boolean);
    if (new Set(used).size !== used.length) p.push('같은 열을 두 번 고를 수 없습니다');
    if (!label.trim()) p.push('형식 이름을 적어 주세요(예: 국민은행 거래내역)');
    return p;
  }, [fields, mapping, label]);

  const col = (key: string) => (mapping[key] ? need.headers.indexOf(mapping[key]) : -1);

  return (
    <div className="wb-block">
      <VStack gap={3}>
        <div>
          <Text weight="semibold">{filename} — 처음 보는 형식입니다. 이렇게 읽을까요?</Text>
          <div className="wb-sub">
            {need.guessedBy === 'llm' ? '열 이름 사전으로 못 찾은 열은 로컬 AI가 추측했습니다. ' : '열 이름으로 추측했습니다. '}
            확인하면 이 형식을 저장해 다음 파일부터는 바로 읽습니다. 아직 아무것도 저장되지 않았습니다.
          </div>
        </div>

        <SegmentedControl
          label="자료 종류"
          size="sm"
          value={kind}
          onChange={(v) => {
            const k = v as StatementKind;
            setKind(k);
            const keys = new Set(need.fields[k].map((f) => f.key));
            setMapping((m) => Object.fromEntries(Object.entries(m).filter(([key]) => keys.has(key))));
          }}
        >
          <SegmentedControlItem value="BANK" label="은행 거래내역" />
          <SegmentedControlItem value="CARD_STATEMENT" label="카드사 이용내역" />
        </SegmentedControl>

        <div className="wb-map-grid">
          {fields.map((f) => (
            <Selector
              key={`${kind}-${f.key}`}
              label={`${f.label}${f.required ? '' : ' (선택)'}`}
              value={mapping[f.key] ?? NONE}
              onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v === NONE ? '' : v }))}
              options={[...(f.required ? [] : [{ value: NONE, label: '(없음)' }]), ...need.headers.map((h) => ({ value: h, label: h }))]}
            />
          ))}
        </div>

        <div>
          <div className="wb-block-title">미리보기 (앞 {need.samples.length}줄)</div>
          <table className="wb-preview">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.key}>{f.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {need.samples.map((r, i) => (
                <tr key={i}>
                  {fields.map((f) => (
                    <td key={f.key}>{col(f.key) >= 0 ? fmt(r[col(f.key)]) : ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {kind === 'BANK' && <div className="wb-sub">출금만 비용 검토 대상으로 들어가고, 입금은 건수만 셉니다.</div>}
          {kind === 'CARD_STATEMENT' && <div className="wb-sub">명세서에는 세액이 없어 합계의 1/11로 추정하고, 홈택스 카드 내역과 겹치는 줄은 한 번만 반영합니다.</div>}
        </div>

        <TextInput label="형식 이름" value={label} onChange={(v) => setLabel(v)} placeholder="예: 국민은행 거래내역, 신한카드 이용내역" />

        {err && <div className="wb-nonded">{err}</div>}
        <HStack gap={2} wrap="wrap" vAlign="center">
          <Button
            variant="primary"
            label="이렇게 읽고 형식 저장"
            isDisabled={problems.length > 0}
            tooltip={problems[0]}
            clickAction={async () => {
              try {
                setErr(null);
                await onSubmit({ kind, label: label.trim(), mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) });
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          />
          <Button label="취소" clickAction={async () => onCancel()} />
          {problems.length > 0 && <span className="wb-sub">{problems[0]}</span>}
        </HStack>
      </VStack>
    </div>
  );
}
