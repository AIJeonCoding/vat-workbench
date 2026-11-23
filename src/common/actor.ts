import { UnauthorizedException } from '@nestjs/common';
import { actorSchema, type Actor } from '../domain/schemas';

/**
 * 데모용 인증: x-user-id, x-role 헤더. 실제 서비스라면 SSO 토큰에서 같은 Actor를 만든다.
 * REST와 GraphQL이 이 함수 하나로 사용자를 만든다 — 같은 권한 규칙을 따르게 하기 위해서.
 */
export function actorFromHeaders(headers: Record<string, string | string[] | undefined>): Actor {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const r = actorSchema.safeParse({ userId: h('x-user-id'), role: h('x-role') });
  if (!r.success || r.data.role === 'agent') throw new UnauthorizedException('x-user-id, x-role(preparer|reviewer) 헤더가 필요합니다');
  return r.data;
}
