import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
