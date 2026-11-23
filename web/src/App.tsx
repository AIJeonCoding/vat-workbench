import { AppShell } from '@astryxdesign/core/AppShell';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { VStack } from '@astryxdesign/core/VStack';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { gql, setCurrentUser, USERS, type FilingCard, type User } from './api';
import { FilingWorkspace } from './FilingWorkspace';

export function App() {
  const [user, setUser] = useState<User>(USERS[0]);
  const [filingId, setFilingId] = useState<number | null>(null);

  const filings = useQuery({
    queryKey: ['filings'],
    queryFn: () => gql<{ filings: FilingCard[] }>('{ filings { id period status clientName industry total pending needsReview } }').then((d) => d.filings),
    refetchInterval: 5000,
  });
  const agent = useQuery({
    queryKey: ['agent'],
    queryFn: () => gql<{ agentStatus: { pending: number; model: string } }>('{ agentStatus { pending model } }').then((d) => d.agentStatus),
    refetchInterval: 2000,
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => fetch('/api/health').then((r) => r.json() as Promise<{ llm: { up: boolean; model: string } }>),
    refetchInterval: 10_000,
  });

  const selected = filingId ?? filings.data?.[0]?.id ?? null;
  const llmUp = health.data?.llm.up ?? false;
  const modelShort = (agent.data?.model ?? '').split('/').pop()?.replace('-MLX', '') ?? '';

  return (
    <AppShell
      variant="section"
      topNav={
        <TopNav
          heading={<TopNavHeading heading="부가세 신고 워크벤치" superheading="세무사 사무실" />}
          endContent={
            <HStack gap={4} vAlign="center">
              <span className="wb-sub" title={llmUp ? `로컬 LLM: ${health.data?.llm.model}` : 'AI 서버가 꺼져 있어도 규칙 판정과 사람 검토로 진행됩니다'}>
                {llmUp ? `AI 서버 연결됨 (${modelShort})` : 'AI 서버 꺼짐'}
                {agent.data?.pending ? ` · 대기 ${agent.data.pending}건` : ''}
              </span>
              <SegmentedControl
                label="사용자 전환"
                size="sm"
                value={user.userId}
                onChange={(v) => {
                  const u = USERS.find((x) => x.userId === v)!;
                  setCurrentUser(u);
                  setUser(u);
                }}
              >
                {USERS.map((u) => (
                  <SegmentedControlItem key={u.userId} value={u.userId} label={u.name} />
                ))}
              </SegmentedControl>
            </HStack>
          }
        />
      }
    >
      <Layout
        start={
          <LayoutPanel width={260} hasDivider padding={2} label="고객 신고 건">
            <VStack gap={0}>
              <div className="wb-sub" style={{ padding: '0 8px 6px' }}>고객 · 2026년 1기 부가세</div>
              {filings.data?.map((f) => (
                <button key={f.id} className="wb-filing" aria-current={f.id === selected} onClick={() => setFilingId(f.id)}>
                  <VStack gap={0.5}>
                    <Text weight="semibold">{f.clientName}</Text>
                    <Text type="supporting">{f.industry}</Text>
                    <span className="wb-sub">
                      {f.total === 0 ? (
                        '자료 대기'
                      ) : f.status === 'READY' ? (
                        '신고 준비 완료'
                      ) : (
                        <>
                          {f.pending ? `미확정 ${f.pending}건` : '모두 확정'}
                          {f.needsReview > 0 && <span className="wb-warn"> · 확인 필요 {f.needsReview}</span>}
                        </>
                      )}
                    </span>
                  </VStack>
                </button>
              ))}
            </VStack>
          </LayoutPanel>
        }
        content={
          selected ? (
            <FilingWorkspace key={`${selected}-${user.userId}`} filingId={selected} user={user} />
          ) : (
            <LayoutContent>
              <EmptyState title="고객을 선택하세요" />
            </LayoutContent>
          )
        }
      />
    </AppShell>
  );
}
