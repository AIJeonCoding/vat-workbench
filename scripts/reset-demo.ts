/** 시연 전 초기화: 테이블을 다시 만들고 가상 고객만 넣는다(실행 중인 서버는 그대로 둬도 됨). */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { ormConfig } from '../src/mikro-orm.config';
import { seedDemo } from '../src/seed/seed';

void (async () => {
  const orm = await MikroORM.init(ormConfig());
  await orm.schema.refreshDatabase();
  await seedDemo(orm.em.fork());
  await orm.close();
  console.log('시연 데이터 초기화 완료');
})();
