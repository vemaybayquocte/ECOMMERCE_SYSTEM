import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('products')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  findAll() {
    return this.catalogService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const product = await this.catalogService.findOne(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateProductDto) {
    return this.catalogService.create(dto);
  }
}
