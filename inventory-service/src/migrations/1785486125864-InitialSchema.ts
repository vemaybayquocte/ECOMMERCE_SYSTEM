import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1785486125864 implements MigrationInterface {
  name = 'InitialSchema1785486125864';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "stock_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "productId" character varying NOT NULL, "availableQuantity" integer NOT NULL, "reservedQuantity" integer NOT NULL DEFAULT '0', CONSTRAINT "UQ_bbfb82762aee45829f290ef3381" UNIQUE ("productId"), CONSTRAINT "PK_52a266aa3e04b8ad1f01088f3f0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."reservations_status_enum" AS ENUM('RESERVED', 'CONFIRMED', 'RELEASED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "reservations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" character varying NOT NULL, "items" jsonb NOT NULL, "status" "public"."reservations_status_enum" NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_30ac98dc5f411b6847fb549a874" UNIQUE ("orderId"), CONSTRAINT "PK_da95cef71b617ac35dc5bcda243" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reservations"`);
    await queryRunner.query(`DROP TYPE "public"."reservations_status_enum"`);
    await queryRunner.query(`DROP TABLE "stock_items"`);
  }
}
