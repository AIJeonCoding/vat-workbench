import type { EntityManager } from '@mikro-orm/postgresql';
import { Client, Filing, FilingStatus } from '../domain/entities';

/** 가상 고객 두 곳(실제 회사·개인 아님). 비어 있을 때만 넣는다. */
export async function seedDemo(em: EntityManager) {
  if ((await em.count(Client, {})) > 0) return;
  const bakery = em.create(Client, {
    name: '동네 베이커리(가상)',
    brn: '1234567891',
    industry: '제과점업',
    businessKeywords: ['제과', '제빵', '밀가루', '버터', '설탕', '포장', '식자재', '베이킹', '주방', '유제품', '계란', '통신요금', '전기', '가스', '임대', '오븐'],
    registeredAt: '2026-01-10',
    vehicles: [
      { plate: '12가3456', model: '레이(경차, 배달용)', kind: 'LIGHT' },
      { plate: '34나5678', model: '쏘나타(승용)', kind: 'PASSENGER' },
    ],
  });
  const cafe = em.create(Client, {
    name: '모퉁이 커피(가상)',
    brn: '2208112341',
    industry: '커피전문점',
    businessKeywords: ['원두', '우유', '컵', '포장', '시럽', '통신요금', '전기'],
    registeredAt: '2023-05-02',
    vehicles: [],
  });
  await em.flush();
  em.create(Filing, { clientId: bakery.id, period: '2026-1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: FilingStatus.COLLECTING });
  em.create(Filing, { clientId: cafe.id, period: '2026-1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: FilingStatus.COLLECTING });
  await em.flush();
}
