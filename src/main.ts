import 'reflect-metadata';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createApp } from './app.setup';
import { seedDemo } from './seed/seed';

async function bootstrap() {
  const app = await createApp({ serveWeb: true });
  const orm = app.get(MikroORM);
  // 데모 편의: 엔티티에 맞춰 테이블을 만들고, 비어 있으면 가상 고객을 넣는다(운영이라면 마이그레이션)
  await orm.schema.updateSchema();
  await seedDemo(app.get(EntityManager).fork());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`워크벤치: http://localhost:${port}  (GraphiQL: /graphiql)`);
}

void bootstrap();
