/**
 * 데모용 조문·실무 메모 코퍼스. Agent의 search_law Tool이 여기서 찾는다.
 * 실제 세무 판단 근거로 쓰지 말 것 — 단순화한 요약이다(README 참고).
 */
export interface LawDoc {
  id: string;
  ref: string;
  title: string;
  text: string;
  keywords: string[];
}

export const LAW_DOCS: LawDoc[] = [
  {
    id: 'vat39-1-4',
    ref: '부가가치세법 제39조 제1항 제4호',
    title: '사업과 직접 관련 없는 지출',
    text: '사업과 직접 관련이 없는 지출에 대한 매입세액은 공제하지 않는다. 가사용·개인 소비(가족 식사, 개인 쇼핑, 취미 등)가 대표적이다. 사업 관련성은 업종, 사용 장소·시간, 금액, 반복성으로 판단한다.',
    keywords: ['사업무관', '가사', '개인', '사적', '취미', '가족', '쇼핑', '주말'],
  },
  {
    id: 'vat39-1-5',
    ref: '부가가치세법 제39조 제1항 제5호',
    title: '비영업용 소형승용차의 구입·임차·유지',
    text: '운수업·자동차판매업 등 차량을 영업에 직접 쓰는 경우가 아닌 소형승용차의 구입, 임차, 유지(주유, 정비, 주차 등)에 관한 매입세액은 공제하지 않는다. 경차(1,000cc 이하), 9인승 이상 승합차, 화물차는 소형승용차가 아니므로 공제 대상이다.',
    keywords: ['차량', '주유', '정비', '렌트', '리스', '승용차', '경차', '화물', '주차', '세차'],
  },
  {
    id: 'vat39-1-6',
    ref: '부가가치세법 제39조 제1항 제6호',
    title: '기업업무추진비(옛 접대비) 및 유사 비용',
    text: '거래처를 위한 식사·선물·골프·유흥 등 기업업무추진비와 이와 유사한 비용의 매입세액은 공제하지 않는다. 직원 회식·복리후생은 기업업무추진비가 아니므로 사업 관련 지출로 공제 가능하다. 거래처 접대인지 직원 복리후생인지는 사용 목적 확인이 필요하다.',
    keywords: ['접대', '기업업무추진비', '거래처', '선물', '골프', '유흥', '주점', '식사', '회식', '백화점'],
  },
  {
    id: 'vat39-1-7',
    ref: '부가가치세법 제39조 제1항 제7호',
    title: '면세사업 관련·토지 관련 매입세액',
    text: '면세사업과 관련된 매입세액, 토지의 조성 등 토지 관련 매입세액은 공제하지 않는다.',
    keywords: ['면세', '토지', '농산물', '미가공'],
  },
  {
    id: 'vat39-1-8',
    ref: '부가가치세법 제39조 제1항 제8호',
    title: '사업자등록 전 매입세액',
    text: '사업자등록을 신청하기 전의 매입세액은 공제하지 않는다. 다만 공급시기가 속하는 과세기간이 끝난 후 20일 이내에 등록을 신청한 경우 그 과세기간 기산일까지 역산한 기간의 매입세액은 공제한다.',
    keywords: ['등록 전', '창업', '개업', '사업자등록'],
  },
  {
    id: 'vat46-3',
    ref: '부가가치세법 제46조 제3항',
    title: '신용카드매출전표 수취분 공제 — 간이과세자 거래',
    text: '신용카드매출전표 등을 받은 매입세액은 공제할 수 있으나, 공급자가 영수증만 발급할 수 있는 간이과세자인 경우 등은 공제 대상에서 제외된다. 면세 가맹점은 부가가치세 자체가 없다.',
    keywords: ['간이', '간이과세자', '영수증', '면세 가맹점', '카드'],
  },
  {
    id: 'practice-hometax',
    ref: '실무 메모',
    title: '홈택스 사전분류는 참고용',
    text: '홈택스의 사업용 신용카드 공제·불공제 사전분류는 참고자료다. 사업 무관·접대·가사 비용·비영업용 승용차 비용, 간이·면세 가맹점 거래는 실제 용도에 맞게 거래별로 재확인해야 한다.',
    keywords: ['홈택스', '사전분류', '재확인', '카드'],
  },
];

/** 아주 단순한 키워드 점수 검색(데모용 RAG). */
export function searchLaw(query: string, limit = 3): LawDoc[] {
  const q = query.toLowerCase();
  return LAW_DOCS.map((d) => ({
    d,
    score:
      d.keywords.filter((k) => q.includes(k.toLowerCase())).length * 3 +
      (q.includes(d.title) ? 2 : 0) +
      q.split(/\s+/).filter((w) => w.length > 1 && d.text.includes(w)).length,
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}

export const LAW_REF: Record<string, string> = {
  BUSINESS: '부가가치세법 제38조(공제하는 매입세액)',
  VEHICLE_PASSENGER: '부가가치세법 제39조 제1항 제5호',
  VEHICLE_OK: '부가가치세법 제39조 제1항 제5호(소형승용차 아님)',
  ENTERTAINMENT: '부가가치세법 제39조 제1항 제6호',
  NOT_BUSINESS: '부가가치세법 제39조 제1항 제4호',
  EXEMPT_SUPPLIER: '면세 가맹점(매입세액 없음)',
  SIMPLIFIED_SUPPLIER: '부가가치세법 제46조 제3항',
  BEFORE_REGISTRATION: '부가가치세법 제39조 제1항 제8호',
  NO_VAT: '세액 없음',
  NO_EVIDENCE: '부가가치세법 제38조·제39조 제1항 제2호(세금계산서 미수취)',
  NOT_VAT: '부가세 과세 대상 아님',
};

export const REASON_LABEL: Record<string, string> = {
  BUSINESS: '일반 사업 매입',
  VEHICLE_PASSENGER: '비영업용 소형승용차',
  VEHICLE_OK: '공제 가능 차량',
  ENTERTAINMENT: '기업업무추진비(접대)',
  NOT_BUSINESS: '사업 무관·가사',
  EXEMPT_SUPPLIER: '면세 가맹점',
  SIMPLIFIED_SUPPLIER: '간이과세 가맹점',
  BEFORE_REGISTRATION: '사업자등록 전',
  NO_VAT: '세액 없음',
  NO_EVIDENCE: '증빙 없음(세금계산서 요청)',
  NOT_VAT: '세금·보험료·인건비',
};
