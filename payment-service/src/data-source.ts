import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Payment } from './payment/entities/payment.entity';

/**
 * CLI-only DataSource (migration:generate / migration:run / migration:revert).
 * The running app uses its own TypeOrmModule.forRootAsync in app.module.ts -
 * this file exists purely so the TypeORM CLI has a connection + entity list
 * to diff against, outside of Nest's DI container.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [Payment],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
});
